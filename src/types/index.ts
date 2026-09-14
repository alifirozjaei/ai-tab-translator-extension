export type TranslationMode = 'voice';
export type CaptureState = 'idle' | 'starting' | 'active' | 'error';

export interface AppSettings {
  geminiApiKey: string;
  targetLang: string;
  mode: TranslationMode;
  sttModel: string;
  translationModel: string;
  liveTranslateEnabled: boolean;
  liveTranslateModel: string;
  interimIntervalMs: number;
  silenceThresholdMs: number;
  maxSegmentMs: number;
  muteOriginal: boolean;
  originalVolume: number;
  translatedVolume: number;
  /** ms to wait after the original audio before playing the dub (0 = off). */
  playbackDelayMs: number;
  /** Send 8kHz audio upstream instead of 16kHz to halve bandwidth on weak networks. */
  lowQualityAudio: boolean;
  interimEnabled: boolean;
  sttRateLimitPerMinute: number;
  maxSttRetries: number;
}

export interface TranslationResult {
  id: number;
  interim: boolean;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  startTime: number;
  endTime: number;
}

export interface CaptureStatus {
  state: CaptureState;
  tabId?: number;
  segments: number;
  error?: string;
}

export type RuntimeMessage =
  | { type: 'START'; settings: AppSettings }
  | { type: 'STOP' }
  | { type: 'UPDATE_SETTINGS'; settings: AppSettings }
  | { type: 'GET_STATUS' }
  | { type: 'PING' }
  | { type: 'STREAM_STOPPED' }
  | { type: 'OFFSCREEN_READY' }
  | { type: 'START_CAPTURE'; settings: AppSettings; tabId: number; streamId?: string }
  | { type: 'STOP_CAPTURE' }
  | { type: 'STATUS'; state: CaptureState; error?: string; tabId?: number }
  | { type: 'ERROR'; message: string }
  | { type: 'TRANSLATION_RESULT'; result: TranslationResult }
  | { type: 'PLAY_TRANSLATION'; result: TranslationResult; volume: number }
  | { type: 'CLEAR_TRANSLATION' };
