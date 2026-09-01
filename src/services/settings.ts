import type { AppSettings, SubtitleSegment } from '../types';

const SETTINGS_KEY = 'settings';
const SEGMENTS_KEY = 'segments';

export const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: '',
  targetLang: 'fa',
  mode: 'both',
  sttModel: 'gemini-3.5-transcribe',
  translationModel: 'gemini-2.5-flash',
  liveTranslateEnabled: true,
  liveTranslateModel: 'gemini-3.5-live-translate-preview',
  liveSubtitles: false,
  interimIntervalMs: 3500,
  silenceThresholdMs: 700,
  maxSegmentMs: 15000,
  muteOriginal: true,
  originalVolume: 0.2,
  interimEnabled: false,
  sttRateLimitPerMinute: 3,
  maxSttRetries: 3,
  subtitles: {
    fontSize: 28,
    position: 'bottom',
    bgOpacity: 0.7,
    showOriginal: true,
    originalFirst: false,
  },
};

const MAX_SEGMENTS = 500;

export async function getSettings(): Promise<AppSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = (stored[SETTINGS_KEY] ?? {}) as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    subtitles: { ...DEFAULT_SETTINGS.subtitles, ...(saved.subtitles ?? {}) },
  };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    ...current,
    ...patch,
    subtitles: { ...current.subtitles, ...(patch.subtitles ?? {}) },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function hasApiKey(settings: AppSettings): boolean {
  return settings.geminiApiKey.trim().length > 0;
}

export async function getSegments(): Promise<SubtitleSegment[]> {
  const stored = await chrome.storage.local.get(SEGMENTS_KEY);
  return (stored[SEGMENTS_KEY] ?? []) as SubtitleSegment[];
}

export async function addSegment(segment: SubtitleSegment): Promise<void> {
  const segments = await getSegments();
  segments.push(segment);
  await chrome.storage.local.set({ [SEGMENTS_KEY]: segments.slice(-MAX_SEGMENTS) });
}

export async function clearSegments(): Promise<void> {
  await chrome.storage.local.set({ [SEGMENTS_KEY]: [] });
}
