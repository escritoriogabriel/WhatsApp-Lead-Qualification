import { readFileSync } from 'node:fs';
import { z } from 'zod';

const FieldSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  question: z.string().min(1).max(500),
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
  greeting: z.string().min(1),
  handoffMessage: z.string().min(1),
  audioRetryMessage: z.string().min(1),
  completionMessage: z.string().min(1),
  urgencyMessage: z.string().min(1),
  batchWindowMs: z.number().int().min(0).max(60_000),
  sendPartDelayMs: z.number().int().min(0).max(10_000),
  maxMessagesPerTurn: z.number().int().min(1).max(4),
  maxFieldAttempts: z.number().int().min(1).max(5),
  maxAudioBytes: z.number().int().min(1024).max(25_000_000),
  maxHistoryMessages: z.number().int().min(1).max(50),
  workerPollMs: z.number().int().min(100).max(10_000),
  handoffKeywords: z.array(z.string().min(1)),
  humanCommand: z.string().min(1).max(40),
  defaultProfileId: z.string().min(1),
  profiles: z.array(ProfileSchema).min(1),
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
  const parsed = AssistantConfigSchema.parse(
    JSON.parse(readFileSync(qualificationPath, 'utf8')),
  );

  if (!parsed.profiles.some((profile) => profile.id === parsed.defaultProfileId)) {
    throw new Error('defaultProfileId must match a profile id in the config');
  }

  for (const profile of parsed.profiles) {
    const ids = profile.fields.map((field) => field.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Field ids must be unique within each profile');
    }
  }

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
