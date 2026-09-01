import { geminiGenerate, parseJson } from './gemini';

export async function translateText(
  apiKey: string,
  model: string,
  text: string,
  targetCode: string,
  targetName: string,
  sourceLang?: string,
): Promise<string> {
  const sourceClause = sourceLang && sourceLang !== 'auto'
    ? `The source language is ${sourceLang}. `
    : 'Detect the source language automatically. ';

  const prompt = `You are a professional translator.
${sourceClause}Translate the given text into ${targetName} (${targetCode}).
Respond with JSON only: {"translation": "..."}
Keep numbers, names and formatting unchanged. Do not add any commentary.`;

  const body = {
    contents: [
      {
        parts: [{ text: `${prompt}\n\nText:\n${text}` }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  const raw = await geminiGenerate(apiKey, model, body);
  const parsed = parseJson<{ translation?: string }>(raw);
  return (parsed?.translation ?? '').trim();
}
