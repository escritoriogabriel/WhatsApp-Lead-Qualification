import type { AssistantConfig, IntakeProfile, RuntimeConfig } from './config.js';
import type { StoredMessage } from './database.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import type { ExtractionResult, IntakeAIProvider } from './ai.js';

export class RoutedAIProvider implements IntakeAIProvider {
  private readonly ollama: OllamaProvider;
  private readonly gemini: GeminiProvider;

  constructor(private readonly getAssistant: () => AssistantConfig, runtime: RuntimeConfig) {
    this.ollama = new OllamaProvider(runtime.ollamaApiUrl, runtime.ollamaModel);
    this.gemini = new GeminiProvider(runtime.geminiApiKey, runtime.geminiModel);
  }

  extract(profile: IntakeProfile, history: StoredMessage[], existingFields: Record<string, string>, assistant: AssistantConfig): Promise<ExtractionResult> {
    return (assistant.aiProvider === 'gemini' ? this.gemini : this.ollama)
      .extract(profile, history, existingFields, assistant);
  }

  transcribe(filePath: string, maxBytes: number, timeoutSeconds: number): Promise<string> {
    const assistant = this.getAssistant();
    if (assistant.audioTranscriptionProvider !== 'gemini') {
      throw new Error('A transcrição de áudio está desativada.');
    }
    return this.gemini.transcribe(filePath, maxBytes, timeoutSeconds);
  }
}
