export interface LanguageOption {
  code: string;
  name: string;
  tts: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', tts: 'en-US' },
  { code: 'fa', name: 'Persian (Farsi)', tts: 'fa-IR' },
  { code: 'de', name: 'German', tts: 'de-DE' },
  { code: 'fr', name: 'French', tts: 'fr-FR' },
  { code: 'es', name: 'Spanish', tts: 'es-ES' },
  { code: 'ar', name: 'Arabic', tts: 'ar-SA' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', tts: 'zh-CN' },
  { code: 'ru', name: 'Russian', tts: 'ru-RU' },
  { code: 'it', name: 'Italian', tts: 'it-IT' },
  { code: 'pt', name: 'Portuguese', tts: 'pt-PT' },
  { code: 'hi', name: 'Hindi', tts: 'hi-IN' },
  { code: 'ja', name: 'Japanese', tts: 'ja-JP' },
  { code: 'ko', name: 'Korean', tts: 'ko-KR' },
  { code: 'tr', name: 'Turkish', tts: 'tr-TR' },
  { code: 'ur', name: 'Urdu', tts: 'ur-PK' },
  { code: 'id', name: 'Indonesian', tts: 'id-ID' },
];

export function getLanguageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export function getTtsLang(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.tts ?? code;
}
