import type {
  AppSettings,
  CaptureStatus,
  RuntimeMessage,
  SubtitleSegment,
  TranslationMode,
} from '../types';
import { addSegment, getSegments } from '../services/settings';
import { logger } from '../services/logger';

let status: CaptureStatus = { state: 'idle', segments: 0 };
let activeSettings: AppSettings | null = null;
let offscreenReady = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
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
    case 'GET_STATUS':
      status.segments = (await getSegments()).length;
      return status;
    case 'OFFSCREEN_READY':
      offscreenReady = true;
      logger.info('offscreen document ready');
      return { ok: true };
    case 'STATUS':
      status.state = message.state;
      if (message.error) status.error = message.error;
      return { ok: true };
    case 'ERROR':
      status.state = 'error';
      status.error = message.message;
      logger.error('Capture error reported by offscreen engine. Debug info:', {
        message: message.message,
        state: status.state,
      });
      return { ok: true };
    case 'SEGMENT':
      if (!message.segment.interim) {
        await addSegment(message.segment);
      }
      await relaySegment(message.segment, activeSettings?.mode ?? 'both');
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${(message as { type: string }).type}` };
  }
}

async function startCapture(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
  if (!settings.geminiApiKey.trim()) {
    return { ok: false, error: 'Add your Gemini API key in the Settings page first.' };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

  await ensureOffscreen();

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs
      .sendMessage(tab.id, {
        type: 'OVERLAY_CONFIG',
        prefs: settings.subtitles,
        mode: settings.mode,
      } satisfies RuntimeMessage)
      .catch(() => {});
  } catch (error) {
    status.state = 'idle';
    activeSettings = null;
    logger.error('overlay injection failed:', error);
    return { ok: false, error: `Could not inject the subtitle overlay: ${String(error)}` };
  }

  const shouldMute = settings.mode !== 'subtitles' && (settings.liveTranslateEnabled || settings.muteOriginal);
  if (shouldMute) {
    try {
      await chrome.tabs.update(tab.id, { muted: true });
    } catch {
      logger.warn('could not mute original tab audio (best-effort)');
    }
  }

  let streamId: string | undefined;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    logger.warn('could not acquire tab media stream id, offscreen may retry:', error);
  }

  await chrome.runtime.sendMessage({
    type: 'START_CAPTURE',
    settings,
    tabId: tab.id,
    streamId,
  } satisfies RuntimeMessage);
  logger.info('capture started on tab', tab.id, 'mode:', settings.mode);

  return { ok: true };
}

async function ensureOffscreen(): Promise<void> {
  const runtime = chrome.runtime as unknown as {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<Array<{ contextType: string }>>;
  };

  if (runtime.getContexts) {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
  }

  offscreenReady = false;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen/index.html'),
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

async function relaySegment(segment: SubtitleSegment, mode: TranslationMode): Promise<void> {
  if (!status.tabId) {
    logger.warn('relaySegment: no active tab to relay to');
    return;
  }
  try {
    await chrome.tabs.sendMessage(status.tabId, { type: 'SHOW_SUBTITLE', segment, mode } satisfies RuntimeMessage);
    logger.debug(`relayed segment #${segment.id} (interim=${segment.interim}) to tab ${status.tabId}`);
  } catch (error) {
    logger.error(
      `relaySegment: could not send to tab ${status.tabId} — content script not injected or tab navigated:`,
      error,
    );
  }
}

async function stopCapture(): Promise<{ ok: boolean }> {
  const tabId = status.tabId;
  const wasRunning = status.state === 'active' || status.state === 'starting';
  status = { state: 'idle', segments: (await getSegments()).length };

  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' } satisfies RuntimeMessage).catch(() => {});

  if (wasRunning && tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'CLEAR_SUBTITLE' } satisfies RuntimeMessage).catch(() => {});
    try {
      await chrome.tabs.update(tabId, { muted: false });
    } catch {
      /* best-effort */
    }
  }

  activeSettings = null;
  return { ok: true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (status.tabId === tabId) {
    stopCapture().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (status.tabId === tabId && (changeInfo.status === 'loading' || changeInfo.discarded)) {
    stopCapture().catch(() => {});
  }
});

chrome.tabCapture?.onStatusChanged?.addListener((info) => {
  if (info.status === 'stopped' && (status.state === 'active' || status.state === 'starting')) {
    stopCapture().catch(() => {});
  }
});
