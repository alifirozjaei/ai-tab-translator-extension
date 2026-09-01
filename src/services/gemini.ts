import { describeError } from './logger';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {}

interface GeminiPart {
  text?: string;
  audioTranscription?: { text?: string };
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

interface InteractionResponse {
  status?: string;
  output_text?: string;
  steps?: Array<{ content?: { text?: string } }>;
}

function parseErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? parsed?.error?.status ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

async function postJson<T>(
  label: string,
  url: string,
  apiKey: string,
  body: unknown,
): Promise<T> {
  const started = performance.now();
  console.debug(`[AI Tab Translator] ${label} -> POST ${url} (${JSON.stringify(body).length} bytes)`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - started);

    if (!res.ok) {
      const detail = parseErrorDetail(text);
      const message = `${label} -> HTTP ${res.status} ${res.statusText}; url=${url}; detail="${detail}"; ${latencyMs}ms`;
      console.error(`[AI Tab Translator] ${label} FAILED. Debug info:`, {
        operation: label,
        url,
        modelHint: extractModelHint(body),
        status: res.status,
        statusText: res.statusText,
        responseBody: text.slice(0, 1000),
        latencyMs,
        message,
      });
      throw new GeminiError(message);
    }

    console.debug(`[AI Tab Translator] ${label} ok -> HTTP ${res.status} in ${latencyMs}ms (${text.length} bytes)`);
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    const latencyMs = Math.round(performance.now() - started);
    console.error(`[AI Tab Translator] ${label} NETWORK FAILURE. Debug info:`, {
      operation: label,
      url,
      error,
      message: describeError(error),
      latencyMs,
    });
    throw new GeminiError(`${label} network failure: ${describeError(error)}; url=${url}`);
  }
}

function extractModelHint(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'model' in body) {
    return String((body as { model: unknown }).model);
  }
  return undefined;
}

export async function geminiGenerate(apiKey: string, model: string, body: unknown): Promise<string> {
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJson<GenerateResponse>(`generateContent(${model})`, url, apiKey, body);

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const texts: string[] = [];
  for (const p of parts) {
    if (p.text) texts.push(p.text);
    else if (p.audioTranscription?.text) texts.push(p.audioTranscription.text);
  }
  return texts.join('');
}

export async function geminiInteraction(apiKey: string, model: string, body: unknown): Promise<string> {
  const url = `${API_BASE}/interactions`;
  const data = await postJson<InteractionResponse>(
    `interaction(${model})`,
    url,
    apiKey,
    { model, ...(body as object) },
  );

  if (data.status && data.status !== 'completed') {
    console.warn(`[AI Tab Translator] interaction(${model}) status = ${data.status}`);
  }

  const direct = (data.output_text ?? '').trim();
  if (direct) return direct;

  if (Array.isArray(data.steps)) {
    return data.steps.map((s) => s?.content?.text ?? '').join('').trim();
  }
  return '';
}

export function parseJson<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* fall through */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
    }
  }
  return null;
}