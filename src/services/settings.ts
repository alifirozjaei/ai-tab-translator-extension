import type { AppSettings, TranslationResult } from '../types';
import { browserApi } from '../platform/browser';

const SETTINGS_KEY = 'settings';
const SEGMENTS_KEY = 'segments';
export const LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';

export const DEFAULT_SETTINGS: AppSettings = {
  geminiApiKey: '',
  targetLang: 'fa',
  mode: 'voice',
  sttModel: 'gemini-3.5-transcribe',
  translationModel: 'gemini-2.5-flash',
  liveTranslateEnabled: true,
  liveTranslateModel: LIVE_TRANSLATE_MODEL,
  interimIntervalMs: 3500,
  silenceThresholdMs: 700,
  maxSegmentMs: 15000,
  muteOriginal: true,
  originalVolume: 0.2,
  translatedVolume: 1,
  playbackDelayMs: 5000,
  interimEnabled: false,
  sttRateLimitPerMinute: 3,
  maxSttRetries: 3,
};

const MAX_SEGMENTS = 500;

export const MAX_PLAYBACK_DELAY_MS = 10_000;

function clampDelay(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(MAX_PLAYBACK_DELAY_MS, Math.round(numeric)));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

// Keep all numeric settings inside their valid ranges. A 0 maxSegmentMs would
// otherwise make the VAD worklet emit a segment on every sample (audio-rate
// postMessage storm) and a negative interim interval would spam interims.
function clampSettings(s: AppSettings): void {
  s.playbackDelayMs = clampDelay(s.playbackDelayMs, DEFAULT_SETTINGS.playbackDelayMs);
  s.interimIntervalMs = clampInt(s.interimIntervalMs, 500, 5000, DEFAULT_SETTINGS.interimIntervalMs);
  s.silenceThresholdMs = clampInt(s.silenceThresholdMs, 200, 5000, DEFAULT_SETTINGS.silenceThresholdMs);
  s.maxSegmentMs = clampInt(s.maxSegmentMs, 5000, 60000, DEFAULT_SETTINGS.maxSegmentMs);
  s.sttRateLimitPerMinute = clampInt(s.sttRateLimitPerMinute, 1, 100, DEFAULT_SETTINGS.sttRateLimitPerMinute);
  s.maxSttRetries = clampInt(s.maxSttRetries, 0, 10, DEFAULT_SETTINGS.maxSttRetries);
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await browserApi.storage.local.get(SETTINGS_KEY);
  const saved = (stored[SETTINGS_KEY] ?? {}) as Partial<AppSettings>;
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    mode: 'voice',
    // Keep the model field for future multi-model support, but use the
    // currently supported live translation model exclusively for now.
    liveTranslateModel: LIVE_TRANSLATE_MODEL,
  } as AppSettings;
  // Older builds stored volume as a percentage (or an invalid slider value).
  merged.originalVolume = normalizeVolume(merged.originalVolume, DEFAULT_SETTINGS.originalVolume);
  merged.translatedVolume = normalizeVolume(merged.translatedVolume, DEFAULT_SETTINGS.translatedVolume);
  clampSettings(merged);
  return merged;
}

function normalizeVolume(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  // Repair legacy percentage values such as 20 or 100.
  const normalized = numeric > 1 ? numeric / 100 : numeric;
  return Math.max(0, Math.min(1, normalized));
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    ...current,
    ...patch,
    liveTranslateModel: LIVE_TRANSLATE_MODEL,
  };
  clampSettings(next);
  await browserApi.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function hasApiKey(settings: AppSettings): boolean {
  return settings.geminiApiKey.trim().length > 0;
}

export async function getSegments(): Promise<TranslationResult[]> {
  const stored = await browserApi.storage.local.get(SEGMENTS_KEY);
  return (stored[SEGMENTS_KEY] ?? []) as TranslationResult[];
}

export async function addSegment(segment: TranslationResult): Promise<void> {
  const segments = await getSegments();
  segments.push(segment);
  await browserApi.storage.local.set({ [SEGMENTS_KEY]: segments.slice(-MAX_SEGMENTS) });
}

export async function clearSegments(): Promise<void> {
  await browserApi.storage.local.set({ [SEGMENTS_KEY]: [] });
}
