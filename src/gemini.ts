import { readFile, stat } from 'node:fs/promises';
import type { AssistantConfig, IntakeProfile } from './config.js';
import type { StoredMessage } from './database.js';
import { extractionInput, extractionJsonSchema, extractionSystemPrompt, parseExtraction, type ExtractionResult, type IntakeAIProvider } from './ai.js';

export class GeminiQuotaError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('A cota temporária do Gemini foi atingida; a mensagem ficará na fila até a próxima tentativa permitida.');
    this.name = 'GeminiQuotaError';
  }
}

interface GeminiResponse {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiProvider implements IntakeAIProvider {
  private retryAfterAt = 0;

  constructor(private readonly apiKey: string, private readonly model: string) {}

  private ensureConfigured(): void {
    if (!this.apiKey) throw new Error('O provedor Gemini está selecionado, mas GEMINI_API_KEY não está configurada.');
  }

  private async generate(body: Record<string, unknown>, operation: string, timeoutMs = 30_000): Promise<GeminiResponse> {
    this.ensureConfigured();
    if (this.retryAfterAt > Date.now()) throw new GeminiQuotaError(this.retryAfterAt - Date.now());
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      const detail = response.status === 429 ? await response.text().catch(() => '') : '';
      if (response.status === 429) {
        const retryAfterMs = resolveRetryAfterMs(response.headers.get('retry-after'), detail);
        this.retryAfterAt = Date.now() + retryAfterMs;
        throw new GeminiQuotaError(retryAfterMs);
      }
      throw new Error(`Gemini ${operation} falhou (HTTP ${response.status}).`);
    }
    return await response.json() as GeminiResponse;
  }

  async transcribe(filePath: string, maxBytes: number, timeoutSeconds: number): Promise<string> {
    this.ensureConfigured();
    const fileInfo = await stat(filePath);
    if (fileInfo.size > maxBytes) throw new Error('O áudio excede o limite configurado.');
    const audio = await readFile(filePath);
    const result = await this.generate({
      contents: [{ role: 'user', parts: [
        { text: 'Transcreva fielmente este áudio em português. Retorne somente as palavras faladas, sem comentários.' },
        { inline_data: { mime_type: 'audio/ogg', data: audio.toString('base64') } },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 4000 },
    }, 'transcrição', Math.min(Number.MAX_SAFE_INTEGER, timeoutSeconds * 1000));
    const text = result.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => typeof part.text === 'string' ? part.text : '').join('').trim();
    if (!text) throw new Error('Gemini não retornou uma transcrição utilizável.');
    return text;
  }

  async extract(profile: IntakeProfile, history: StoredMessage[], existingFields: Record<string, string>, assistant: AssistantConfig): Promise<ExtractionResult> {
    const result = await this.generate({
      systemInstruction: { parts: [{ text: extractionSystemPrompt(assistant) }] },
      contents: [{ role: 'user', parts: [{ text: extractionInput(profile, history, existingFields, assistant) }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseJsonSchema: extractionJsonSchema(profile),
      },
    }, 'extração de triagem');
    const candidate = result.candidates?.[0];
    const content = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => typeof part.text === 'string' ? part.text : '').join('').trim();
    if (!content) throw new Error('Gemini não retornou uma extração estruturada utilizável.');
    return parseExtraction(content, profile);
  }
}

function resolveRetryAfterMs(retryAfterHeader: string | null, detail: string): number {
  const headerSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return Math.ceil(headerSeconds * 1000);
  const match = detail.match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (!match) return 60_000;
  const milliseconds = (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
  return Math.max(60_000, Math.ceil(milliseconds));
}
