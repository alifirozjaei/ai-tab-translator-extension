import { createRoot, type Root } from 'react-dom/client';
import SubtitleOverlay from './subtitle-overlay';
import { setSegment, setPrefs, setMode } from './store';
import { speakTranslated, cancelTts, hasTtsSupport } from '../services/tts';
import { logger } from '../services/logger';
import type { RuntimeMessage, TranslationMode } from '../types';

let root: Root | null = null;
let host: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let mode: TranslationMode = 'both';

function ensureOverlay(): void {
  if (host) return;
  host = document.createElement('div');
  host.id = 'ai-tab-translator-overlay';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  shadowRoot = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);
  root = createRoot(shadowRoot);
  root.render(<SubtitleOverlay />);
  logger.info('subtitle overlay mounted');
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  logger.debug('content script received message:', message.type);
  switch (message.type) {
    case 'OVERLAY_CONFIG':
      setPrefs(message.prefs);
      setMode(message.mode);
      mode = message.mode;
      ensureOverlay();
      logger.info('overlay config applied, mode =', mode);
      break;
    case 'SHOW_SUBTITLE':
      ensureOverlay();
      mode = message.mode ?? mode;
      setMode(mode);
      setSegment(message.segment);
      logger.info(
        `subtitle #${message.segment.id} (interim=${message.segment.interim}) ` +
          `target=${message.segment.targetLang} text="${message.segment.translatedText.slice(0, 80)}"`,
      );
      if (!message.segment.interim && (mode === 'voice' || mode === 'both')) {
        if (!hasTtsSupport()) {
          logger.warn('speechSynthesis is unavailable; skipping voice dubbing.');
        } else {
          logger.info(`speaking: "${message.segment.translatedText.slice(0, 80)}"`);
        }
        speakTranslated(message.segment.translatedText, message.segment.targetLang);
      }
      break;
    case 'CLEAR_SUBTITLE':
      setSegment(null);
      cancelTts();
      logger.info('subtitles cleared');
      break;
    default:
      break;
  }
});
