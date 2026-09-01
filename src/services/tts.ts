import { getTtsLang } from './languages';

interface TtsItem {
  text: string;
  lang: string;
}

let voices: SpeechSynthesisVoice[] = [];

function loadVoices(): void {
  voices = speechSynthesis.getVoices();
}

if (typeof speechSynthesis !== 'undefined') {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

export function hasTtsSupport(): boolean {
  return typeof speechSynthesis !== 'undefined';
}

export function hasVoiceForLanguage(lang: string): boolean {
  if (!hasTtsSupport()) return false;
  const base = lang.split('-')[0].toLowerCase();
  const normalized = lang.toLowerCase().replace('_', '-');
  return voices.some(
    (v) =>
      v.lang.toLowerCase().replace('_', '-').startsWith(normalized) ||
      v.lang.toLowerCase().split('-')[0] === base,
  );
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  if (!voices.length) loadVoices();
  const normalized = lang.toLowerCase().replace('_', '-');
  const base = lang.split('-')[0].toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase().replace('_', '-').startsWith(normalized)) ??
    voices.find((v) => v.lang.toLowerCase().split('-')[0] === base)
  );
}

const queue: TtsItem[] = [];
let speaking = false;

export function speakTranslated(text: string, langCode: string): void {
  if (!hasTtsSupport() || !text.trim()) return;
  queue.push({ text, lang: getTtsLang(langCode) });
  if (queue.length > 2) queue.shift();
  pump();
}

export function cancelTts(): void {
  queue.length = 0;
  speaking = false;
  if (hasTtsSupport()) speechSynthesis.cancel();
}

function pump(): void {
  if (speaking || queue.length === 0 || !hasTtsSupport()) return;
  const item = queue.shift()!;
  speaking = true;
  const utterance = new SpeechSynthesisUtterance(item.text);
  const voice = pickVoice(item.lang);
  utterance.lang = voice?.lang ?? item.lang;
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onend = () => {
    speaking = false;
    pump();
  };
  utterance.onerror = () => {
    speaking = false;
    pump();
  };
  speechSynthesis.speak(utterance);
}
