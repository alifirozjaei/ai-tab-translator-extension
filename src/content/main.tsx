import { speakTranslated, cancelTts, hasTtsSupport } from '../services/tts';
import { logger } from '../services/logger';
import type { RuntimeMessage } from '../types';
import { browserApi } from '../platform/browser';

declare global {
  interface Window {
    __aitabAudioInstalled?: boolean;
  }
}

// The SW injects content.js on every Start. Guard so each start/stop cycle does
// not stack another PLAY_TRANSLATION listener (which would speak each result N
// times).
if (!window.__aitabAudioInstalled) {
  window.__aitabAudioInstalled = true;

  browserApi.runtime.onMessage.addListener((message: RuntimeMessage) => {
    if (message.type === 'PLAY_TRANSLATION') {
      if (!hasTtsSupport()) { logger.error('Speech synthesis is unavailable.'); return; }
      speakTranslated(message.result.translatedText, message.result.targetLang, message.volume);
    } else if (message.type === 'CLEAR_TRANSLATION') {
      cancelTts();
    }
  });
}
