import type { SubtitlePrefs, SubtitleSegment, TranslationMode } from '../types';

export interface OverlayState {
  segment: SubtitleSegment | null;
  prefs: SubtitlePrefs;
  mode: TranslationMode;
}

export const DEFAULT_PREFS: SubtitlePrefs = {
  fontSize: 28,
  position: 'bottom',
  bgOpacity: 0.7,
  showOriginal: true,
  originalFirst: false,
};

const state: OverlayState = {
  segment: null,
  prefs: { ...DEFAULT_PREFS },
  mode: 'both',
};

const subscribers = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getOverlayState(): OverlayState {
  return state;
}

export function setSegment(segment: SubtitleSegment | null): void {
  state.segment = segment;
  emit();
}

export function setPrefs(prefs: Partial<SubtitlePrefs>): void {
  state.prefs = { ...state.prefs, ...prefs };
  emit();
}

export function setMode(mode: TranslationMode): void {
  state.mode = mode;
  emit();
}

function emit(): void {
  subscribers.forEach((fn) => fn());
}
