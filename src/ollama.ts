import type { AssistantConfig, IntakeProfile } from './config.js';
import type { StoredMessage } from './database.js';
import { extractionInput, extractionJsonSchema, extractionSystemPrompt, parseExtraction, type ExtractionResult, type IntakeAIProvider } from './ai.js';

interface OllamaResponse {
  message?: { content?: unknown };
}

export class OllamaProvider implements IntakeAIProvider {
  private readonly endpoint: string;

  constructor(apiUrl: string, private readonly model: string) {
    const parsed = new URL(apiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OLLAMA_API_URL deve usar HTTP ou HTTPS.');
    this.endpoint = `${apiUrl.replace(/\/+$/, '')}/api/chat`;
    if (!model.trim()) throw new Error('OLLAMA_MODEL não pode ficar vazio.');
  }

  async extract(profile: IntakeProfile, history: StoredMessage[], existingFields: Record<string, string>, assistant: AssistantConfig): Promise<ExtractionResult> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: extractionJsonSchema(profile),
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: extractionSystemPrompt(assistant) },
          { role: 'user', content: extractionInput(profile, history, existingFields, assistant) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Ollama não está disponível ou recusou a extração (HTTP ${response.status}).`);
    const result = await response.json() as OllamaResponse;
    if (typeof result.message?.content !== 'string' || !result.message.content.trim()) {
      throw new Error('Ollama não retornou uma extração estruturada utilizável.');
    }
    return parseExtraction(result.message.content, profile, history);
  }

  async transcribe(): Promise<string> {
    throw new Error('A transcrição local de áudio não está configurada.');
  }
}
