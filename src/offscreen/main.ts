import { transcribeAudio, type TranscriptionResult } from '../services/speech';
import { translateText } from '../services/translation';
import { getLanguageName } from '../services/languages';
import { encodeWav, toBase64, int16ToBase64 } from '../audio/wav';
import { logger, describeError } from '../services/logger';
import { RateLimiter, withRetry } from '../services/rateLimiter';
import { LiveTranslateSession } from '../services/liveTranslate';
import type { AppSettings, TranslationResult } from '../types';

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

function limiter(model: string, perMinute: number): RateLimiter {
  let lim = rateLimiters.get(model);
  if (!lim || lim.perMinute !== perMinute) {
    lim = new RateLimiter(perMinute);
    rateLimiters.set(model, lim);
  }
  return lim;
}

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

chrome.runtime.onMessage.addListener((message: any) => {
  if (message?.type === 'START_CAPTURE') {
    const streamId = (message.streamId as string | undefined) ?? '';
    startCapture(message.settings as AppSettings, streamId).catch((error) => reportError(error));
  } else if (message?.type === 'STOP_CAPTURE') {
    stopCapture();
  } else if (message?.type === 'UPDATE_SETTINGS') {
    const settings = message.settings as AppSettings;
    if (translatedGain) translatedGain.gain.value = settings.translatedVolume;
    if (originalGain) originalGain.gain.value = settings.muteOriginal ? 0 : settings.originalVolume;
  }
});

chrome.tabCapture?.onStatusChanged?.addListener((info) => {
  if (info.status === 'stopped' && running) {
    stopCapture();
    chrome.runtime.sendMessage({ type: 'STATUS', state: 'idle' }).catch(() => {});
  }
});

async function startCapture(settings: AppSettings, streamId: string): Promise<void> {
  if (running) await stopCapture();
  running = true;
  setStatus('starting');
  log('starting capture');

  if (!settings.geminiApiKey.trim()) {
    throw new Error('Missing Gemini API key. Add it in the extension Settings page.');
  }

  log(`capturing with streamId=${streamId ? 'present' : 'none'}`);
  mediaStream = await captureTabAudio(streamId);
  log(`got media stream, audio tracks: ${mediaStream.getAudioTracks().length}`);

  if (settings.liveTranslateEnabled) {
    await startLiveTranslate(settings);
  } else {
    await startRestPipeline(settings);
  }
}

// ---------------------------------------------------------------------------
// Live Translate pipeline (single WebSocket: STT + translation + voice)
// ---------------------------------------------------------------------------

async function startLiveTranslate(settings: AppSettings): Promise<void> {
  const ctx = new AudioContext();
  audioCtx = ctx;
  const source = ctx.createMediaStreamSource(mediaStream!);

  await ctx.audioWorklet.addModule(chrome.runtime.getURL('live-processors.js'));
  log('live-processors.js module loaded');

  const pcmNode = new AudioWorkletNode(ctx, 'pcm-stream', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  playbackNode = new AudioWorkletNode(ctx, 'playback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: ctx.sampleRate },
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

  liveSession = new LiveTranslateSession(
    settings.geminiApiKey,
    settings.liveTranslateModel,
    settings.targetLang,
    {
      onAudio: (pcm24k) => {
        playbackNode?.port.postMessage({ type: 'audio', data: pcm24k }, [pcm24k.buffer]);
      },
      onTurnComplete: () => {},
      onInterrupted: () => {
        playbackNode?.port.postMessage({ type: 'clear' });
      },
      onState: (s) => log(`live state: ${s}`),
      onError: (m) => reportError(m),
    },
    false,
    false,
  );

  await liveSession.start();
  log('live translate session ready');

  setStatus('active');
  log('capture active (live translate)');
  chrome.runtime.sendMessage({ type: 'STATUS', state: 'active' }).catch(() => {});
}

function sendLiveChunk(i16: Int16Array): void {
  if (!liveSession?.isReady) return;
  if (!liveSession.sendAudio(int16ToBase64(i16))) {
    log('live: audio chunk not sent (session not ready)', 'error');
  }
}

// ---------------------------------------------------------------------------
// REST pipeline (VAD segmentation -> generateContent STT -> translation)
// ---------------------------------------------------------------------------

async function startRestPipeline(settings: AppSettings): Promise<void> {
  const ctx = new AudioContext();
  audioCtx = ctx;
  const source = ctx.createMediaStreamSource(mediaStream!);

  await ctx.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));
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
  chrome.runtime.sendMessage({ type: 'STATUS', state: 'active' }).catch(() => {});
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
    log('falling back to chrome.tabCapture.capture()');
    return await captureTabStream();
  } catch (error) {
    log(`tabCapture.capture failed: ${String(error)}`, 'error');
    throw new Error(`Could not capture tab audio: ${String(error)}`);
  }
}

function captureTabStream(): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      const lastError = chrome.runtime.lastError;
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
  pipeline = pipeline.then(() =>
    handleSegment(data, settings).catch((error) => {
      const detail = describeError(error);
      log(`segment error: ${detail}`, 'error');
      logger.error('Segment processing failed. Full error:', error);
      reportError(error);
    }),
  );
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

  await chrome.runtime.sendMessage({ type: 'TRANSLATION_RESULT', result: segment }).catch(() => {});
  log(`segment #${segment.id} sent to background (interim=${segment.interim})`);
}

function reportError(error: unknown): void {
  running = false;
  const detail = describeError(error);
  setStatus(`error: ${detail}`);
  log(`error: ${detail}`, 'error');
  logger.error('Capture error. Full error:', error);
  chrome.runtime.sendMessage({ type: 'ERROR', message: detail }).catch(() => {});
}

async function stopCapture(): Promise<void> {
  running = false;
  setStatus('idle');
  log('stopped');
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
    await audioCtx?.close();
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
}
