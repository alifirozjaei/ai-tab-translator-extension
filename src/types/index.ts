export type TranslationMode = 'subtitles' | 'voice' | 'both';
export type SubtitlePosition = 'top' | 'bottom';
export type CaptureState = 'idle' | 'starting' | 'active' | 'error';

export interface SubtitlePrefs {
  fontSize: number;
  position: SubtitlePosition;
  bgOpacity: number;
  showOriginal: boolean;
  originalFirst: boolean;
}

export interface AppSettings {
  geminiApiKey: string;
  targetLang: string;
  mode: TranslationMode;
  sttModel: string;
  translationModel: string;
  liveTranslateEnabled: boolean;
  liveTranslateModel: string;
  liveSubtitles: boolean;
  interimIntervalMs: number;
  silenceThresholdMs: number;
  maxSegmentMs: number;
  muteOriginal: boolean;
  originalVolume: number;
  interimEnabled: boolean;
  sttRateLimitPerMinute: number;
  maxSttRetries: number;
  subtitles: SubtitlePrefs;
}

export interface SubtitleSegment {
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
  | { type: 'GET_STATUS' }
  | { type: 'OFFSCREEN_READY' }
  | { type: 'START_CAPTURE'; settings: AppSettings; tabId: number; streamId?: string }
  | { type: 'STOP_CAPTURE' }
  | { type: 'STATUS'; state: CaptureState; error?: string }
  | { type: 'ERROR'; message: string }
  | { type: 'SEGMENT'; segment: SubtitleSegment }
  | { type: 'OVERLAY_CONFIG'; prefs: SubtitlePrefs; mode: TranslationMode }
  | { type: 'SHOW_SUBTITLE'; segment: SubtitleSegment; mode: TranslationMode }
  | { type: 'CLEAR_SUBTITLE' };
