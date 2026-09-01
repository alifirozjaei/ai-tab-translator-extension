import { geminiGenerate, geminiInteraction, parseJson, GeminiError } from './gemini';

export interface TranscriptionResult {
  text: string;
  language: string;
  languageCode: string;
}

const TRANSCRIBE_PROMPT = `You are a high-accuracy automatic speech recognition engine.
Transcribe the audio exactly as it is spoken. Detect and report the spoken language.
Respond with JSON only, no markdown:
{"text": "...", "language": "English", "languageCode": "en"}
Rules:
- Transcribe verbatim, keep numbers, abbreviations and proper nouns.
- Use natural punctuation and capitalization.
- If the audio contains no clear speech, return {"text": ""}.`;

function isTranscribeModel(model: string): boolean {
  return /transcribe/i.test(model);
}

export async function transcribeAudio(
  apiKey: string,
  model: string,
  wavBase64: string,
): Promise<TranscriptionResult> {
  if (isTranscribeModel(model)) {
    return transcribeWithTranscribeModel(apiKey, model, wavBase64);
  }
  return transcribeWithGenericModel(apiKey, model, wavBase64);
}

async function transcribeWithTranscribeModel(
  apiKey: string,
  model: string,
  wavBase64: string,
): Promise<TranscriptionResult> {
  // gemini-3.5-transcribe (unary) is served via the Interactions API, not
  // :generateContent. Inline base64 audio is accepted.
  const body = {
    input: [{ type: 'audio', data: wavBase64, mime_type: 'audio/wav' }],
  };

  const raw = await geminiInteraction(apiKey, model, body);
  const text = (raw ?? '').trim();
  return {
    text,
    language: '',
    languageCode: 'auto',
  };
}

async function transcribeWithGenericModel(
  apiKey: string,
  model: string,
  wavBase64: string,
): Promise<TranscriptionResult> {
  const body = {
    contents: [
      {
        parts: [
          { text: TRANSCRIBE_PROMPT },
          { inline_data: { mime_type: 'audio/wav', data: wavBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
    },
  };

  const raw = await geminiGenerate(apiKey, model, body);
  const parsed = parseJson<TranscriptionResult>(raw);
  return {
    text: (parsed?.text ?? '').trim(),
    language: parsed?.language ?? '',
    languageCode: parsed?.languageCode ?? 'auto',
  };
}

export { GeminiError };