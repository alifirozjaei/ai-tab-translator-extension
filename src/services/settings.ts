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
  interimEnabled: false,
  sttRateLimitPerMinute: 3,
  maxSttRetries: 3,
};

const MAX_SEGMENTS = 500;

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
