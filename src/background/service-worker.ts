import type { AppSettings, CaptureStatus, RuntimeMessage, TranslationResult } from '../types';
import { addSegment, getSegments } from '../services/settings';
import { logger } from '../services/logger';
import { browserApi, hasOffscreen, hasTabCapture } from '../platform/browser';

let status: CaptureStatus = { state: 'idle', segments: 0 };
let activeSettings: AppSettings | null = null;
let offscreenReady = false;

// Lifecycle: an MV3 service worker idles after ~30s and Chrome can terminate
// the offscreen document. Session state is persisted to storage.session so a
// worker restart rehydrates status/tab/settings and re-arms the watchdogs
// instead of silently orphaning a capture the UI claims is running.
let keepAliveTimer: number | null = null;
let offscreenTimer: number | null = null;

const SESSION_KEY = 'swSession';
const sessionStorage = (browserApi.storage as unknown as {
  session?: { get: (keys: string[]) => Promise<Record<string, unknown>>; set: (items: Record<string, unknown>) => Promise<void> };
}).session;

// Bumped on every in-memory status transition; restoreSession only applies a
// persisted snapshot if no transition happened while it was reading, so it can
// never clobber a fresher in-memory state (N4).
let sessionVersion = 0;
// Watchdog for the transient 'starting' state: if the offscreen never reports
// 'active' (e.g. it died mid-handshake and no STATUS ever arrived), fail
// loudly instead of leaving the UI on "Starting..." forever (N12).
let startingTimer: number | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Rehydrate on every wake: top-level module scope runs whenever the worker
// starts (fresh or resumed).
void restoreSession();

browserApi.runtime.onStartup?.addListener(() => {
  void restoreSession();
});
browserApi.runtime.onInstalled?.addListener(() => {
  void restoreSession();
});

function disarmStartingTimer(): void {
  if (startingTimer) {
    clearTimeout(startingTimer);
    startingTimer = null;
  }
}

function armStartingTimer(): void {
  disarmStartingTimer();
  startingTimer = setTimeout(() => {
    startingTimer = null;
    if (status.state === 'starting') {
      logger.error('capture stuck in starting state; aborting');
      void stopCapture().finally(() => {
        status = { state: 'error', segments: 0, error: 'Capture did not start in time.' };
        sessionVersion++;
        void persistSession();
      });
    }
  }, 15000) as unknown as number;
}

async function persistSession(): Promise<void> {
  if (!sessionStorage) return;
  try {
    await sessionStorage.set({
      [SESSION_KEY]: {
        state: status.state,
        tabId: status.tabId ?? null,
        settings: activeSettings,
        version: sessionVersion,
      },
    });
  } catch (error) {
    logger.warn('could not persist session state:', error);
  }
}

async function restoreSession(): Promise<void> {
  if (!sessionStorage) return;
  const versionAtStart = sessionVersion;
  try {
    const stored = await sessionStorage.get([SESSION_KEY]);
    // A handler mutated state while we were reading; in-memory is fresher.
    if (sessionVersion !== versionAtStart) return;
    const s = stored?.[SESSION_KEY] as
      | { state?: string; tabId?: number | null; settings?: AppSettings | null; version?: number }
      | undefined;
    if (!s || !s.state) return;
    status.state = (s.state as CaptureStatus['state']) ?? 'idle';
    if (typeof s.tabId === 'number') status.tabId = s.tabId;
    activeSettings = s.settings ?? null;
    sessionVersion = Math.max(sessionVersion, s.version ?? 0);
    if (status.state === 'active' || status.state === 'starting') {
      armKeepAlive();
      armOffscreenWatchdog();
      if (status.state === 'starting') armStartingTimer();
      else disarmStartingTimer();
      logger.info('session restored from storage.session:', status.state);
    } else {
      disarmStartingTimer();
    }
  } catch (error) {
    logger.warn('could not restore session state:', error);
  }
}

browserApi.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  logger.debug('message:', message.type);
  handleMessage(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => {
      logger.error('message handler error:', error);
      sendResponse({ ok: false, error: String(error) });
    });
  return true;
});

async function handleMessage(message: RuntimeMessage): Promise<unknown> {
  switch (message.type) {
    case 'START':
      return startCapture(message.settings);
    case 'STOP':
      return stopCapture();
    case 'UPDATE_SETTINGS':
      activeSettings = message.settings;
      await browserApi.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: message.settings }).catch(() => {});
      return { ok: true };
    case 'GET_STATUS':
      status.segments = (await getSegments()).length;
      return status;
    case 'OFFSCREEN_READY':
      offscreenReady = true;
      logger.info('offscreen document ready');
      return { ok: true };
    case 'STATUS':
      sessionVersion++;
      status.state = message.state;
      status.error = message.error;
      if (typeof message.tabId === 'number') status.tabId = message.tabId;
      if (message.state === 'starting') armStartingTimer();
      else disarmStartingTimer();
      if (message.state === 'idle' || message.state === 'error') {
        // Every path that reports idle/error must disarm the timers; otherwise
        // both intervals would keep the worker alive (and poll) forever.
        disarmKeepAlive();
        disarmOffscreenWatchdog();
      } else {
        // Re-arm on every active STATUS: a worker that just woke up has lost
        // its timers and needs them back to keep self-healing working.
        armKeepAlive();
        armOffscreenWatchdog();
      }
      void persistSession();
      return { ok: true };
    case 'ERROR':
      sessionVersion++;
      status.state = 'error';
      status.error = message.message;
      logger.error('Capture error reported by offscreen engine. Debug info:', {
        message: message.message,
        state: status.state,
      });
      await stopCapture();
      sessionVersion++;
      status = { state: 'error', segments: (await getSegments()).length, error: message.message };
      void persistSession();
      return { ok: true };
    case 'TRANSLATION_RESULT':
      if (!message.result.interim) {
        await addSegment(message.result);
      }
      await relaySegment(message.result);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${(message as { type: string }).type}` };
  }
}

async function startCapture(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
  if (!settings.geminiApiKey.trim()) {
    return { ok: false, error: 'Add your Gemini API key in the Settings page first.' };
  }

  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: 'No active tab found.' };
  }
  if (
    tab.url?.startsWith('chrome://') ||
    tab.url?.startsWith('chrome-extension://') ||
    tab.url?.startsWith('https://chrome.google.com/webstore')
  ) {
    return { ok: false, error: 'This browser page cannot be captured.' };
  }

  if (status.state === 'active' || status.state === 'starting') {
    await stopCapture();
  }

  activeSettings = settings;
  status = { state: 'starting', tabId: tab.id, segments: (await getSegments()).length };
  armStartingTimer();

  try {
    await ensureOffscreen();
  } catch (error) {
      sessionVersion++;
    status = { state: 'error', tabId: tab.id, segments: (await getSegments()).length, error: String(error) };
    activeSettings = null;
    return { ok: false, error: String(error) };
  }

  try {
    if (browserApi.scripting?.executeScript) {
      await browserApi.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } else {
      await browserApi.tabs.executeScript(tab.id, { file: 'content.js' });
    }
  } catch (error) {
    status.state = 'idle';
    activeSettings = null;
    logger.error('translation audio script injection failed:', error);
    return { ok: false, error: `Could not prepare translation audio: ${String(error)}` };
  }

  let streamId: string | undefined;
  try {
    if (hasTabCapture) streamId = await browserApi.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    logger.warn('could not acquire tab media stream id, offscreen may retry:', error);
  }

  try {
    await browserApi.runtime.sendMessage({ type: 'START_CAPTURE', settings, tabId: tab.id, streamId } satisfies RuntimeMessage);
  } catch (error) {
    activeSettings = null;
      sessionVersion++;
    status = { state: 'error', tabId: tab.id, segments: (await getSegments()).length, error: String(error) };
    return { ok: false, error: String(error) };
  }
  // The offscreen engine is now running asynchronously. Mark the session active
  // here as well so the popup cannot remain stuck on "Starting…" if the worker
  // misses the follow-up STATUS message.
  status = { state: 'active', tabId: tab.id, segments: (await getSegments()).length };
  sessionVersion++;
  logger.info('capture started on tab', tab.id, 'mode:', settings.mode);
  armKeepAlive();
  armOffscreenWatchdog();
  void persistSession();

  return { ok: true };
}

let rearming = false;

function armKeepAlive(): void {
  if (keepAliveTimer) return;
  // Each Chrome API call resets the service worker's idle timer, keeping it
  // alive so the popup status stays fresh and STOP always works.
  keepAliveTimer = setInterval(() => {
    void browserApi.runtime.getPlatformInfo?.().catch(() => {});
  }, 20_000) as unknown as number;
}

function disarmKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function armOffscreenWatchdog(): void {
  disarmOffscreenWatchdog();
  // Chrome can terminate the offscreen document mid-session (e.g. during
  // silence between turns). Recreate it and restart capture automatically.
  offscreenTimer = setInterval(() => {
    void checkOffscreen();
  }, 5000) as unknown as number;
}

function disarmOffscreenWatchdog(): void {
  if (offscreenTimer) {
    clearInterval(offscreenTimer);
    offscreenTimer = null;
  }
}

async function checkOffscreen(): Promise<void> {
  if (status.state !== 'active' && status.state !== 'starting') return;
  if (!hasOffscreen || rearming) return;
  rearming = true;
  try {
    const off = browserApi.offscreen as unknown as { hasDocument?: () => Promise<boolean> };
    let alive = true;
    try {
      alive = off.hasDocument ? await off.hasDocument() : true;
    } catch {
      alive = false;
    }
    if (!alive) {
      // A thrown hasDocument() is not proof of death: round-trip ping the
      // document before deciding to destructively rearm (M5).
      try {
        const pong = await browserApi.runtime.sendMessage({ type: 'PING' } satisfies RuntimeMessage);
        alive = pong?.ok === true;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      logger.warn('offscreen document was terminated; recreating capture');
      await rearmCapture();
    }
  } finally {
    rearming = false;
  }
}

async function rearmCapture(): Promise<void> {
  const tabId = status.tabId;
  const settings = activeSettings;
  if (!tabId || !settings) return;
  try {
    await ensureOffscreen();
    let streamId: string | undefined;
    try {
      if (hasTabCapture) streamId = await browserApi.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (error) {
      logger.warn('could not re-acquire tab stream id:', error);
    }
    await browserApi.runtime.sendMessage({ type: 'START_CAPTURE', settings, tabId, streamId } satisfies RuntimeMessage);
    logger.info('capture restarted after offscreen termination');
    void persistSession();
  } catch (error) {
    logger.error('could not restart capture after offscreen termination:', error);
      sessionVersion++;
    status = { state: 'error', segments: (await getSegments()).length, error: String(error) };
    activeSettings = null;
    disarmKeepAlive();
    disarmOffscreenWatchdog();
    void persistSession();
  }
}

async function ensureOffscreen(): Promise<void> {
  if (!hasOffscreen) {
    // Firefox runs the audio engine alongside this background page.
    return;
  }
  const runtime = browserApi.runtime as unknown as {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<Array<{ contextType: string }>>;
  };

  if (runtime.getContexts) {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
  }

  offscreenReady = false;
  try {
    await browserApi.offscreen.createDocument({
      url: browserApi.runtime.getURL('offscreen/index.html'),
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio, detect and translate speech, and play dubbed audio in the browser.',
    });
  } catch (error) {
    // Chrome only allows one offscreen document per extension. A racing call
    // (or a rearm that landed after the doc was recreated) throws here; if a
    // document now exists the session is still fine, so keep going.
    const hasDocPromise = (browserApi.offscreen as unknown as { hasDocument?: () => Promise<boolean> }).hasDocument?.();
    let hasDoc = false;
    if (hasDocPromise) {
      try {
        hasDoc = await hasDocPromise;
      } catch {
        /* fall through */
      }
    }
    const hasContexts =
      typeof runtime.getContexts === 'function' &&
      (await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
    if (!hasDoc && !hasContexts) throw error;
    logger.warn('offscreen document already exists; continuing');
  }

  const deadline = Date.now() + 5000;
  while (!offscreenReady && Date.now() < deadline) {
    await sleep(100);
  }
  if (!offscreenReady) {
    throw new Error('The audio engine did not start in time.');
  }
}

async function relaySegment(result: TranslationResult): Promise<void> {
  if (!status.tabId) {
    logger.warn('relaySegment: no active tab to relay to');
    return;
  }
  try {
    await browserApi.tabs.sendMessage(status.tabId, { type: 'PLAY_TRANSLATION', result, volume: activeSettings?.translatedVolume ?? 1 } satisfies RuntimeMessage);
    logger.debug(`relayed translation #${result.id} (interim=${result.interim}) to tab ${status.tabId}`);
  } catch (error) {
    logger.error(
      `relaySegment: could not send translation audio to tab ${status.tabId}:`,
      error,
    );
  }
}

async function stopCapture(): Promise<{ ok: boolean }> {
  const tabId = status.tabId;
  const wasRunning = status.state === 'active' || status.state === 'starting';
  disarmKeepAlive();
  disarmOffscreenWatchdog();
  disarmStartingTimer();
  // Null activeSettings BEFORE persisting so storage.session never keeps a
  // stale settings object for an idle session (N5).
  activeSettings = null;
  sessionVersion++;
  status = { state: 'idle', segments: (await getSegments()).length };
  void persistSession();

  await browserApi.runtime.sendMessage({ type: 'STOP_CAPTURE' } satisfies RuntimeMessage).catch(() => {});

  if (wasRunning && tabId) {
    await browserApi.tabs.sendMessage(tabId, { type: 'CLEAR_TRANSLATION' } satisfies RuntimeMessage).catch(() => {});
  }

  activeSettings = null;
  return { ok: true };
}

browserApi.tabs.onRemoved.addListener((tabId) => {
  if (status.tabId === tabId) {
    stopCapture().catch(() => {});
  }
});

browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (status.tabId === tabId && (changeInfo.status === 'loading' || changeInfo.discarded)) {
    stopCapture().catch(() => {});
  }
});

browserApi.tabCapture?.onStatusChanged?.addListener((info) => {
  if (info.status === 'stopped' && (status.state === 'active' || status.state === 'starting')) {
    stopCapture().catch(() => {});
  }
});
