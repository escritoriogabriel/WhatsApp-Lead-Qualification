import { readFileSync } from 'node:fs';
import { z } from 'zod';

const QuestionTypeSchema = z.enum([
  'open_text',
  'yes_no',
  'single_choice',
  'multiple_choice',
  'date',
  'number',
]);

const FieldSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  question: z.string().min(1).max(500),
  type: QuestionTypeSchema.default('open_text'),
  options: z.array(z.string().min(1).max(120)).max(20).default([]),
  structure: z.string().max(500).default(''),
  askWhen: z.object({ fieldId: z.string().min(1), value: z.string().min(1) }).optional(),
  required: z.boolean().default(true),
});

const ProfileSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  triggers: z.array(z.string().min(1)).default([]),
  fields: z.array(FieldSchema).min(1),
});

const AssistantConfigSchema = z.object({
  officeName: z.string().min(1),
  assistantName: z.string().min(1),
  writingStyle: z.string().min(1),
  officeMemory: z.string().max(5000).default(''),
  forbiddenTopics: z.array(z.string().min(1).max(200)).max(50).default([]),
  materials: z.array(z.object({ title: z.string().min(1).max(160), content: z.string().min(1).max(6000) })).max(20).default([]),
  greeting: z.string().min(1),
  areaQuestion: z.string().min(1).max(500).default('Qual área do Direito ou assunto melhor descreve o seu caso?'),
  areaFieldId: z.string().min(1).max(64).default('assunto'),
  handoffMessage: z.string().min(1),
  audioRetryMessage: z.string().min(1),
  completionMessage: z.string().min(1),
  urgencyMessage: z.string().min(1),
  batchWindowMs: z.number().int().min(0).max(60_000),
  sendPartDelayMs: z.number().int().min(0).max(10_000),
  simulateTyping: z.boolean().default(true),
  typingMsPerCharacter: z.number().int().min(0).max(100).default(25),
  maxCharsPerMessage: z.number().int().min(80).max(4000).default(500),
  maxMessagesPerTurn: z.number().int().min(1).max(4),
  newContactsOnly: z.boolean().default(true),
  maxFieldAttempts: z.number().int().min(1).max(5),
  maxAudioBytes: z.number().int().min(1024).max(25_000_000),
  maxHistoryMessages: z.number().int().min(1).max(50),
  workerPollMs: z.number().int().min(100).max(10_000),
  handoffKeywords: z.array(z.string().min(1)),
  humanCommand: z.string().min(1).max(40),
  defaultProfileId: z.string().min(1),
  profiles: z.array(ProfileSchema).min(1).max(20),
});

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
export type IntakeProfile = AssistantConfig['profiles'][number];
export type IntakeField = IntakeProfile['fields'][number];

export interface RuntimeConfig {
  apiKey: string;
  chatModel: string;
  transcriptionModel: string;
  databasePath: string;
  authDir: string;
  mediaDir: string;
  qualificationPath: string;
  humanNotifyJid: string | undefined;
  logLevel: string;
  assistant: AssistantConfig;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const qualificationPath =
    process.env.CONFIG_PATH ?? 'config/qualification.json';
  const parsed = validateAssistantConfig(JSON.parse(readFileSync(qualificationPath, 'utf8')));

  return {
    apiKey: process.env.GROQ_API_KEY ?? '',
    chatModel: process.env.GROQ_CHAT_MODEL ?? 'openai/gpt-oss-20b',
    transcriptionModel:
      process.env.GROQ_TRANSCRIPTION_MODEL ?? 'whisper-large-v3-turbo',
    databasePath: process.env.DATABASE_PATH ?? 'data/agent.sqlite',
    authDir: process.env.AUTH_DIR ?? 'data/auth',
    mediaDir: process.env.MEDIA_DIR ?? 'data/tmp',
    qualificationPath,
    humanNotifyJid: process.env.HUMAN_NOTIFY_JID || undefined,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    assistant: parsed,
  };
}

export function validateAssistantConfig(value: unknown): AssistantConfig {
  const parsed = AssistantConfigSchema.parse(value);

  if (!parsed.profiles.some((profile) => profile.id === parsed.defaultProfileId)) {
    throw new Error('defaultProfileId must match a profile id in the config');
  }

  for (const profile of parsed.profiles) {
    const ids = profile.fields.map((field) => field.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Field ids must be unique within each profile');
    }
  }

  if (!parsed.profiles.every((profile) => profile.fields.some((field) => field.id === parsed.areaFieldId && field.required))) {
    throw new Error('areaFieldId must match a required field in every qualification profile');
  }
  const materialCharacters = parsed.materials.reduce((total, material) => total + material.content.length, 0);
  if (materialCharacters > 20_000) {
    throw new Error('Materials exceed the combined 20,000 character limit');
  }
  for (const profile of parsed.profiles) {
    for (const field of profile.fields) {
      if (field.askWhen && !profile.fields.some((candidate) => candidate.id === field.askWhen?.fieldId)) {
        throw new Error(`Conditional field ${field.id} refers to a missing field`);
      }
      if (['single_choice', 'multiple_choice'].includes(field.type) && field.options.length === 0) {
        throw new Error(`Field ${field.id} needs at least one option`);
      }
    }
  }
  return parsed;
}
