import type { AppSettings, CaptureStatus, RuntimeMessage, TranslationResult } from '../types';
import { addSegment, getSegments } from '../services/settings';
import { logger } from '../services/logger';
import { browserApi, hasOffscreen, hasTabCapture } from '../platform/browser';

let status: CaptureStatus = { state: 'idle', segments: 0 };
let activeSettings: AppSettings | null = null;
let offscreenReady = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      status.state = message.state;
      status.error = message.error;
      return { ok: true };
    case 'ERROR':
      status.state = 'error';
      status.error = message.message;
      logger.error('Capture error reported by offscreen engine. Debug info:', {
        message: message.message,
        state: status.state,
      });
      await stopCapture();
      status = { state: 'error', segments: (await getSegments()).length, error: message.message };
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

  try {
    await ensureOffscreen();
  } catch (error) {
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
    status = { state: 'error', tabId: tab.id, segments: (await getSegments()).length, error: String(error) };
    return { ok: false, error: String(error) };
  }
  // The offscreen engine is now running asynchronously. Mark the session active
  // here as well so the popup cannot remain stuck on "Starting…" if the worker
  // misses the follow-up STATUS message.
  status = { state: 'active', tabId: tab.id, segments: (await getSegments()).length };
  logger.info('capture started on tab', tab.id, 'mode:', settings.mode);

  return { ok: true };
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
  await browserApi.offscreen.createDocument({
    url: browserApi.runtime.getURL('offscreen/index.html'),
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio, detect and translate speech, and play dubbed audio in the browser.',
  });

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
  status = { state: 'idle', segments: (await getSegments()).length };

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
