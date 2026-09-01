import type { SubtitleSegment } from '../types';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function tsSrt(t: number): string {
  const ms = Math.floor((t % 1) * 1000);
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}

function tsVtt(t: number): string {
  const ms = Math.floor((t % 1) * 1000);
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, '0')}`;
}

function entryText(seg: SubtitleSegment): string {
  const lines = [seg.translatedText];
  if (seg.sourceText && seg.sourceText !== seg.translatedText) {
    lines.push(`[${seg.sourceLang || 'src'}] ${seg.sourceText}`);
  }
  return lines.join('\n');
}

export function buildSrt(segments: SubtitleSegment[]): string {
  return segments
    .filter((s) => !s.interim)
    .map((s, i) => `${i + 1}\n${tsSrt(s.startTime)} --> ${tsSrt(s.endTime)}\n${entryText(s)}\n`)
    .join('\n');
}

export function buildVtt(segments: SubtitleSegment[]): string {
  const body = segments
    .filter((s) => !s.interim)
    .map((s) => `${tsVtt(s.startTime)} --> ${tsVtt(s.endTime)}\n${entryText(s)}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
