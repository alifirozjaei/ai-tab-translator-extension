import { transcribeAudio, type TranscriptionResult } from '../services/speech';
import { translateText } from '../services/translation';
import { getLanguageName } from '../services/languages';
import { encodeWav, toBase64, int16ToBase64 } from '../audio/wav';
import { logger, describeError } from '../services/logger';
import { RateLimiter, withRetry } from '../services/rateLimiter';
import { LiveTranslateSession } from '../services/liveTranslate';
import type { AppSettings, TranslationResult } from '../types';
import { browserApi, hasTabCapture } from '../platform/browser';

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const rateLimiters = new Map<string, RateLimiter>();

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function log(line: string, level: 'info' | 'error' = 'info'): void {
  if (logEl) logEl.textContent = `${new Date().toLocaleTimeString()} ${line}\n${logEl.textContent ?? ''}`.slice(0, 4000);
  if (level === 'error') logger.error(line);
  else logger.info(line);
}

let audioCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let playbackNode: AudioWorkletNode | null = null;
let mediaStream: MediaStream | null = null;
let running = false;
let segId = 0;
let pipeline: Promise<void> = Promise.resolve();

let liveSession: LiveTranslateSession | null = null;
let originalGain: GainNode | null = null;
let translatedGain: GainNode | null = null;

// Lifecycle: keep enough state to auto-heal when Chrome suspends the audio
// context or drops the live WebSocket while the session is still active.
let currentSettings: AppSettings | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;
let lastSendErrLog = 0;
let lastLiveErrorAt = 0;
// Every session is stamped with a generation. Stale sessions (superseded by a
// reconnect, or closed by Stop) have their callbacks ignored, so a leaked or
// old socket can never corrupt the live one.
let sessionGeneration = 0;
// Serializes start/stop transitions so Stop during Start cannot corrupt state.
let lifecycleLock: Promise<void> = Promise.resolve();
// Set synchronously by the STOP handler (before the serialized stop runs) so a
// Start that is still awaiting media/worklet setup can abort early (M3).
let stopRequested = false;
let pipelineMode: 'live' | 'rest' = 'live';
let reconnectAttempts = 0;
let nextRetryAt = 0;
let queuedSegments = 0;
let captureTabId: number | null = null;

function sendStatus(state: 'active' | 'idle' | 'starting' | 'error', error?: string): void {
  browserApi.runtime
    .sendMessage({ type: 'STATUS', state, error, tabId: captureTabId ?? undefined })
    .catch(() => {});
}

// Transient failures (network drops, rate limiting, 5xx) must NOT kill the
// capture. Only auth/validation errors are fatal. Matching is structural: never
// match bare status digits inside free text (e.g. "1500ms", "samples=51200").
// A bare "quota" is NOT transient: a terminal 403 billing/quota failure would
// otherwise be swallowed forever (only 429/rate-limit/retry-in is retryable).
function isTransientError(error: unknown): boolean {
  const m = describeError(error).toLowerCase();
  return (
    /(^|[^0-9])http 5\d\d([^0-9]|$)/.test(m) ||
    /(^|[^0-9])http 429([^0-9]|$)/.test(m) ||
    /rate limit|retry in|resource_exhausted|network|failed to fetch|socket|websocket|timeout|timed out|abort|unavailable|overloaded|econn|eai_again/i.test(m)
  );
}

function isFatalLiveError(message: string, status?: string, code?: number): boolean {
  // gRPC-style codes arrive on the BidiGenerateContent socket (3=INVALID_ARGUMENT,
  // 5=NOT_FOUND, 7=PERMISSION_DENIED, 16=UNAUTHENTICATED); REST uses HTTP codes.
  if (code && [3, 5, 7, 16, 400, 401, 403, 404].includes(code)) return true;
  if (status && /INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND|FAILED_PRECONDITION|OUT_OF_RANGE|UNIMPLEMENTED/.test(status)) return true;
  return /api key|permission denied|unauthorized|forbidden|billing|enable billing|invalid argument|not found/i.test(message);
}

function limiter(model: string, perMinute: number): RateLimiter {
  let lim = rateLimiters.get(model);
  if (!lim || lim.perMinute !== perMinute) {
    lim = new RateLimiter(perMinute);
    rateLimiters.set(model, lim);
  }
  return lim;
}

browserApi.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

browserApi.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    // Quick liveness probe from the SW watchdog (M5): a response proves this
    // document is alive, so the SW must not destructively rearm it.
    sendResponse?.({ ok: true });
    return;
  }
  if (message?.type === 'START_CAPTURE') {
    const streamId = (message.streamId as string | undefined) ?? '';
    captureTabId = (message.tabId as number | undefined) ?? null;
    stopRequested = false;
    runLifecycle(() => startCapture(message.settings as AppSettings, streamId).catch((error) => reportError(error)));
  } else if (message?.type === 'STOP_CAPTURE') {
    stopRequested = true;
    runLifecycle(stopCapture);
  } else if (message?.type === 'UPDATE_SETTINGS') {
    const settings = message.settings as AppSettings;
    if (translatedGain) translatedGain.gain.value = settings.translatedVolume;
    if (originalGain) originalGain.gain.value = settings.muteOriginal ? 0 : settings.originalVolume;
    if (playbackNode) playbackNode.port.postMessage({ type: 'delay', ms: settings.playbackDelayMs });
  }
});

// Equivalent of a mutex: start/stop transitions run one after another, so a
// STOP_CAPTURE arriving mid-Start can no longer race the setup awaits.
function runLifecycle(fn: () => Promise<void>): Promise<void> {
  lifecycleLock = lifecycleLock.then(fn).catch(() => {});
  return lifecycleLock;
}

browserApi.tabCapture?.onStatusChanged?.addListener((info) => {
  if (info.status === 'stopped' && running) {
    runLifecycle(stopCapture);
    sendStatus('idle');
  }
});

async function startCapture(settings: AppSettings, streamId: string): Promise<void> {
  if (running) await stopCapture();
  stopRequested = false;
  running = true;
  setStatus('starting');
  log('starting capture');

  if (!settings.geminiApiKey.trim()) {
    throw new Error('Missing Gemini API key. Add it in the extension Settings page.');
  }

  log(`capturing with streamId=${streamId ? 'present' : 'none'}`);
  mediaStream = await captureTabAudio(streamId);
  log(`got media stream, audio tracks: ${mediaStream.getAudioTracks().length}`);
  if (stopRequested) {
    await stopCapture();
    throw new Error('Capture stopped while starting.');
  }

  if (settings.liveTranslateEnabled) {
    pipelineMode = 'live';
    await startLiveTranslate(settings);
  } else {
    pipelineMode = 'rest';
    await startRestPipeline(settings);
  }
  if (stopRequested) {
    await stopCapture();
    throw new Error('Capture stopped while starting.');
  }
}

// ---------------------------------------------------------------------------
// Live Translate pipeline (single WebSocket: STT + translation + voice)
// ---------------------------------------------------------------------------

async function startLiveTranslate(settings: AppSettings): Promise<void> {
  const ctx = new AudioContext();
  audioCtx = ctx;
  const source = ctx.createMediaStreamSource(mediaStream!);

  await ctx.audioWorklet.addModule(browserApi.runtime.getURL('live-processors.js'));
  log('live-processors.js module loaded');

  const pcmNode = new AudioWorkletNode(ctx, 'pcm-stream', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  playbackNode = new AudioWorkletNode(ctx, 'playback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: ctx.sampleRate, delayMs: settings.playbackDelayMs },
  });

  const dubGain = ctx.createGain();
  const duckGain = ctx.createGain();
  translatedGain = dubGain;
  originalGain = duckGain;
  dubGain.gain.value = settings.translatedVolume;
  duckGain.gain.value = settings.muteOriginal ? 0 : settings.originalVolume;

  pcmNode.port.onmessage = (e) => {
    if (e.data?.type === 'chunk' && e.data.data instanceof Int16Array) {
      sendLiveChunk(e.data.data);
    }
  };

  source.connect(pcmNode);
  source.connect(duckGain);
  duckGain.connect(ctx.destination);
  playbackNode.connect(dubGain);
  dubGain.connect(ctx.destination);
  await ctx.resume();
  log(`audio context resumed (state=${ctx.state})`);

  log(`audio mix: translated=${Math.round(settings.translatedVolume * 100)}%, original=${settings.muteOriginal ? 'muted' : `${Math.round(settings.originalVolume * 100)}%`}`);

  liveSession = buildLiveSession(settings, ++sessionGeneration);
  currentSettings = settings;
  try {
    await liveSession.start();
    log('live: session ready');
  } catch (error) {
    // A transient setup failure (network blip, handshake 503, slow TLS) must
    // not kill the session: leave liveSession null and let the watchdog retry.
    liveSession?.close();
    liveSession = null;
    if (!isTransientError(error)) {
      reportError(error);
      return;
    }
    reconnectAttempts++;
    nextRetryAt = Date.now() + 4000;
    log(`live: initial connect failed (${describeError(error)}); will retry in the background`, 'error');
  }
  armWatchdog();

  setStatus('active');
  log('capture active (live translate)');
  sendStatus('active');
}

function buildLiveSession(settings: AppSettings, generation: number): LiveTranslateSession {
  return new LiveTranslateSession(
    settings.geminiApiKey,
    settings.liveTranslateModel,
    settings.targetLang,
    {
      onAudio: (pcm24k) => {
        if (generation !== sessionGeneration || !running) return;
        playbackNode?.port.postMessage({ type: 'audio', data: pcm24k }, [pcm24k.buffer]);
      },
      onTurnComplete: () => {},
      onInterrupted: () => {
        if (generation !== sessionGeneration || !running) return;
        playbackNode?.port.postMessage({ type: 'clear' });
      },
      onState: (s) => {
        if (generation !== sessionGeneration) return;
        log(`live state: ${s}`);
      },
      onError: (m, info) => {
        if (generation !== sessionGeneration || !running) return;
        log(`live error: ${m}`, 'error');
        if (isFatalLiveError(m, info?.status, info?.code)) {
          reportError(new Error(m));
          return;
        }
        // Transient server error (quota/5xx): drop the socket (throttled) and
        // let the watchdog reconnect. Never permanently stop the session.
        const now = Date.now();
        if (now - lastLiveErrorAt > 8000) {
          lastLiveErrorAt = now;
          try {
            liveSession?.close();
          } catch {
            /* ignore */
          }
        }
      },
    },
    false,
    false,
  );
}

// Chrome suspends AudioContexts in backgrounded documents and can drop the
// live WebSocket. This watchdog revives both while the session is running.
function armWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!running || stopRequested) return;
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    // Reconnect both when the socket died AND when there is no session at all
    // (e.g. a previous reconnect attempt failed); otherwise a single network
    // blip would wedge the pipeline forever. Only in live mode: in REST mode
    // there is no live socket to reconnect (and building one would be a paid
    // session nobody feeds).
    if (pipelineMode === 'live' && (!liveSession || !liveSession.isReady) && !reconnecting) {
      void restartLiveSession();
    }
  }, 4000);
}

function disarmWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function restartLiveSession(): Promise<void> {
  const settings = currentSettings;
  if (!settings || !running || reconnecting || pipelineMode !== 'live' || stopRequested) return;
  // Exponential backoff with jitter so a dead server doesn't trigger a hot loop.
  if (Date.now() < nextRetryAt) return;
  const generation = ++sessionGeneration;
  reconnecting = true;
  log('live: connection lost, reconnecting...');
  try {
    liveSession?.close();
    liveSession = null;
    const session = buildLiveSession(settings, generation);
    await session.start();
    // If Stop or another reconnect superseded us while start() was pending,
    // toss the new session instead of installing a leaked second socket.
    if (generation !== sessionGeneration || !running || stopRequested) {
      session.close();
      return;
    }
    liveSession = session;
    reconnectAttempts = 0;
    nextRetryAt = 0;
    log('live: reconnected');
  } catch (error) {
    reconnectAttempts++;
    const backoff = Math.min(30000, 4000 * 2 ** Math.min(reconnectAttempts - 1, 3));
    nextRetryAt = Date.now() + backoff + Math.floor(Math.random() * 1000);
    log(`live: reconnect failed (attempt ${reconnectAttempts}, next in ${Math.round(backoff / 1000)}s): ${describeError(error)}`, 'error');
  } finally {
    reconnecting = false;
  }
}

function sendLiveChunk(i16: Int16Array): void {
  const throttledLog = (line: string) => {
    const now = Date.now();
    if (now - lastSendErrLog > 1000) {
      lastSendErrLog = now;
      log(line, 'error');
    }
  };
  if (!liveSession?.isReady) {
    throttledLog('live: audio chunk not sent (session not ready)');
    return;
  }
  if (!liveSession.sendAudio(int16ToBase64(i16))) {
    throttledLog('live: audio chunk not sent');
  }
}

// ---------------------------------------------------------------------------
// REST pipeline (VAD segmentation -> generateContent STT -> translation)
// ---------------------------------------------------------------------------

async function startRestPipeline(settings: AppSettings): Promise<void> {
  const ctx = new AudioContext();
  audioCtx = ctx;
  const source = ctx.createMediaStreamSource(mediaStream!);

  await ctx.audioWorklet.addModule(browserApi.runtime.getURL('audio-processor.js'));
  log('audio-processor.js module loaded');

  const node = new AudioWorkletNode(ctx, 'vad-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      silenceThresholdMs: settings.silenceThresholdMs,
      maxSegmentMs: settings.maxSegmentMs,
      interimIntervalMs: settings.interimIntervalMs,
      passThrough: true,
    },
  });
  workletNode = node;
  node.port.onmessage = (e) => {
    if (e.data?.type === 'segment') {
      log(
        `VAD segment: interim=${e.data.interim} ${e.data.samples?.length ?? 0} samples ` +
          `[${e.data.startTime?.toFixed(2)}-${e.data.endTime?.toFixed(2)}s]`,
      );
      enqueueSegment(e.data, settings);
    }
  };
  currentSettings = settings;
  armWatchdog();

  const restOriginalGain = ctx.createGain();
  restOriginalGain.gain.value = settings.muteOriginal ? 0 : settings.originalVolume;
  source.connect(node);
  node.connect(restOriginalGain);
  restOriginalGain.connect(ctx.destination);
  originalGain = restOriginalGain;
  await ctx.resume();
  log(`audio context resumed (state=${ctx.state})`);

  setStatus('active');
  log('capture active (rest pipeline)');
  sendStatus('active');
}

async function captureTabAudio(streamId: string): Promise<MediaStream> {
  if (streamId) {
    try {
      log('capturing via tab media stream id');
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
        },
      } as unknown as MediaStreamConstraints);
    } catch (error) {
      log(`getUserMedia with stream id failed: ${String(error)}`, 'error');
    }
  }

  try {
    log('falling back to browser display/audio capture');
    if (!hasTabCapture) return await captureDisplayAudio();
    return await captureTabStream();
  } catch (error) {
    log(`tabCapture.capture failed: ${String(error)}`, 'error');
    throw new Error(`Could not capture tab audio: ${String(error)}`);
  }
}

async function captureDisplayAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('This Firefox version does not provide display audio capture.');
  }
  log('requesting Firefox tab audio capture permission');
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
}

function captureTabStream(): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    browserApi.tabCapture.capture({ audio: true, video: false }, (stream) => {
      const lastError = browserApi.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message ?? 'tabCapture failed.'));
        return;
      }
      if (!stream) {
        reject(new Error('tabCapture returned an empty stream.'));
        return;
      }
      resolve(stream);
    });
  });
}

function enqueueSegment(data: any, settings: AppSettings): void {
  // Bound the serial queue: each link can take tens of seconds (rate limiter +
  // retries) while the VAD keeps posting segments; without a cap memory and
  // audio-freshness degrade without limit.
  if (queuedSegments >= 4) {
    log(`segment dropped (backlog=${queuedSegments})`, 'error');
    return;
  }
  queuedSegments++;
  pipeline = pipeline
    .then(() =>
      handleSegment(data, settings).catch((error) => {
        const detail = describeError(error);
        log(`segment error: ${detail}`, 'error');
        logger.error('Segment processing failed. Full error:', error);
        // Network hiccups must not stop the session; drop this segment and
        // keep listening. Only hard failures stop the capture.
        if (isTransientError(error)) return;
        reportError(error);
      }),
    )
    .finally(() => {
      queuedSegments--;
    });
}

async function handleSegment(data: any, settings: AppSettings): Promise<void> {
  if (!running) {
    log('segment ignored (not running)', 'error');
    return;
  }
  const { samples, startTime, endTime, interim } = data as {
    samples: Float32Array;
    startTime: number;
    endTime: number;
    interim: boolean;
  };

  if (interim && !settings.interimEnabled) {
    return;
  }

  if (!samples || samples.length < 800) {
    log(`segment skipped: too short (${samples?.length ?? 0} samples)`, 'error');
    return;
  }

  const wav = encodeWav(samples, 16000);
  const b64 = toBase64(wav);
  log(`STT request: ${samples.length} samples (${(samples.length / 16000).toFixed(1)}s), ${Math.round(b64.length / 1024)} KB base64`);

  let stt: TranscriptionResult;
  try {
    await limiter(settings.sttModel, settings.sttRateLimitPerMinute).waitForSlot();
    stt = await withRetry(
      () => transcribeAudio(settings.geminiApiKey, settings.sttModel, b64),
      'speech-to-text',
      settings.maxSttRetries,
      (message, delayMs, attempt, max) => {
        log(`STT quota hit; retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${max}): ${message}`, 'error');
        logger.warn('STT quota exceeded, will retry.', { attempt, max, delayMs, message });
      },
    );
  } catch (error) {
    throw new Error(
      `Speech-to-text stage failed (model=${settings.sttModel}, samples=${samples.length}): ${describeError(error)}`,
    );
  }
  const text = (stt?.text ?? '').trim();
  if (!text) {
    log(`STT returned empty text (lang=${stt?.languageCode ?? '?'})`, 'error');
    return;
  }
  log(`STT: [${stt.languageCode}] ${text.slice(0, 120)}`);

  let translation: string;
  try {
    await limiter(settings.translationModel, settings.sttRateLimitPerMinute).waitForSlot();
    translation = await withRetry(
      () =>
        translateText(
          settings.geminiApiKey,
          settings.translationModel,
          text,
          settings.targetLang,
          getLanguageName(settings.targetLang),
          stt.languageCode,
        ),
      'translation',
      settings.maxSttRetries,
      (message, delayMs, attempt, max) => {
        log(`Translation quota hit; retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${max}): ${message}`, 'error');
        logger.warn('Translation quota exceeded, will retry.', { attempt, max, delayMs, message });
      },
    );
  } catch (error) {
    throw new Error(
      `Translation stage failed (model=${settings.translationModel}, target=${settings.targetLang}): ${describeError(error)}`,
    );
  }
  log(`translation: ${translation.slice(0, 120)}`);

  const segment: TranslationResult = {
    id: ++segId,
    interim: Boolean(interim),
    sourceText: text,
    translatedText: translation || text,
    sourceLang: stt.languageCode || 'auto',
    targetLang: settings.targetLang,
    startTime,
    endTime,
  };

  if (!segment.interim) {
    log(`final[${segment.targetLang}] ${segment.translatedText}`);
  }

  await browserApi.runtime.sendMessage({ type: 'TRANSLATION_RESULT', result: segment }).catch(() => {});
  log(`segment #${segment.id} sent to background (interim=${segment.interim})`);
}

function reportError(error: unknown): void {
  running = false;
  sessionGeneration++;
  disarmWatchdog();
  currentSettings = null;
  teardownGraph();
  const detail = describeError(error);
  setStatus(`error: ${detail}`);
  log(`error: ${detail}`, 'error');
  logger.error('Capture error. Full error:', error);
  sendStatus('error', detail);
  browserApi.runtime.sendMessage({ type: 'ERROR', message: detail }).catch(() => {});
}

async function stopCapture(): Promise<void> {
  running = false;
  sessionGeneration++;
  disarmWatchdog();
  currentSettings = null;
  stopRequested = false;
  setStatus('idle');
  log('stopped');
  teardownGraph();
}

function teardownGraph(): void {
  try {
    liveSession?.close();
  } catch {
    /* ignore */
  }
  liveSession = null;
  try {
    workletNode?.port.postMessage({ type: 'reset' });
  } catch {
    /* ignore */
  }
  try {
    playbackNode?.port.postMessage({ type: 'clear' });
  } catch {
    /* ignore */
  }
  try {
    void audioCtx?.close();
  } catch {
    /* ignore */
  }
  audioCtx = null;
  originalGain = null;
  translatedGain = null;
  workletNode = null;
  playbackNode = null;
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  // Reset reconnect/session bookkeeping so a later Start begins clean.
  reconnectAttempts = 0;
  nextRetryAt = 0;
  lastLiveErrorAt = 0;
  lastSendErrLog = 0;
  pipeline = Promise.resolve();
  queuedSegments = 0;
}
