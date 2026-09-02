import { speakTranslated, cancelTts, hasTtsSupport } from '../services/tts';
import { logger } from '../services/logger';
import type { RuntimeMessage } from '../types';
import { browserApi } from '../platform/browser';

browserApi.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === 'PLAY_TRANSLATION') {
    if (!hasTtsSupport()) { logger.error('Speech synthesis is unavailable.'); return; }
    speakTranslated(message.result.translatedText, message.result.targetLang, message.volume);
  } else if (message.type === 'CLEAR_TRANSLATION') {
    cancelTts();
  }
});
