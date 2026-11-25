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
  contactName: z.boolean().default(false),
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
  materials: z.array(z.object({ title: z.string().min(1).max(160), content: z.string().min(1).max(20_000) })).max(20).default([]),
  greeting: z.string().min(1),
  areaQuestion: z.string().min(1).max(500).default('Qual área do Direito ou assunto melhor descreve o seu caso?'),
  areaFieldId: z.string().min(1).max(64).default('assunto'),
  handoffMessage: z.string().min(1),
  audioRetryMessage: z.string().min(1),
  completionMessage: z.string().min(1),
  urgencyMessage: z.string().min(1),
  batchWindowSeconds: z.number().finite().nonnegative(),
  sendPartDelaySeconds: z.number().finite().nonnegative(),
  audioResponseDelaySeconds: z.number().finite().nonnegative().default(0),
  audioTranscriptionTimeoutSeconds: z.number().finite().positive().default(60),
  simulateTyping: z.boolean().default(true),
  typingSecondsPerCharacter: z.number().finite().nonnegative().default(0.025),
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

export class ConfigValidationError extends Error {
  constructor(readonly path: string, message: string, readonly fix: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export interface RuntimeConfig {
  geminiApiKey: string;
  geminiModel: string;
  whatsappProvider: 'baileys' | 'waha';
  wahaApiUrl: string;
  wahaApiKey: string;
  wahaSession: string;
  wahaWebhookUrl: string;
  wahaWebhookSecret: string;
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
  const configuredProvider = (process.env.WHATSAPP_PROVIDER ?? 'baileys').trim().toLowerCase();
  if (configuredProvider !== 'baileys' && configuredProvider !== 'waha') {
    throw new Error('WHATSAPP_PROVIDER deve ser "baileys" ou "waha".');
  }
  const wahaApiKey = process.env.WAHA_API_KEY ?? '';
  const wahaWebhookSecret = process.env.WAHA_WEBHOOK_SECRET ?? '';
  if (configuredProvider === 'waha' && (!wahaApiKey || !wahaWebhookSecret)) {
    throw new Error('WAHA_API_KEY e WAHA_WEBHOOK_SECRET são obrigatórios quando WHATSAPP_PROVIDER=waha.');
  }

  return {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
    whatsappProvider: configuredProvider,
    wahaApiUrl: (process.env.WAHA_API_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
    wahaApiKey,
    wahaSession: process.env.WAHA_SESSION ?? 'triagem',
    wahaWebhookUrl: process.env.WAHA_WEBHOOK_URL ?? 'http://localhost:3000/api/waha/webhook',
    wahaWebhookSecret,
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
  const migrated = migrateLegacyTimes(value);
  const parsed = AssistantConfigSchema.parse(migrated);

  for (const [path, seconds] of [
    ['batchWindowSeconds', parsed.batchWindowSeconds],
    ['sendPartDelaySeconds', parsed.sendPartDelaySeconds],
    ['audioResponseDelaySeconds', parsed.audioResponseDelaySeconds],
    ['audioTranscriptionTimeoutSeconds', parsed.audioTranscriptionTimeoutSeconds],
    ['typingSecondsPerCharacter', parsed.typingSecondsPerCharacter],
  ] as const) {
    if (!Number.isFinite(seconds * 1000) || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
      throw new ConfigValidationError(path, 'Esta duração não pode ser representada com segurança.', 'Use uma duração menor; não há limite de interface, mas o sistema precisa conseguir medir o tempo.');
    }
  }

  if (!parsed.profiles.some((profile) => profile.id === parsed.defaultProfileId)) {
    throw new ConfigValidationError('defaultProfileId', 'A área padrão não corresponde a um fluxo existente.', 'Escolha uma área existente como padrão.');
  }

  for (const profile of parsed.profiles) {
    const ids = profile.fields.map((field) => field.id);
    if (new Set(ids).size !== ids.length) {
      const duplicateIndex = ids.findIndex((id, index) => ids.indexOf(id) !== index);
      throw new ConfigValidationError(`profiles.${parsed.profiles.indexOf(profile)}.fields.${duplicateIndex}.id`, 'Identificador repetido neste fluxo.', 'Use um identificador único para cada pergunta.');
    }
    if (profile.fields.filter((field) => field.contactName).length > 1) {
      throw new ConfigValidationError(`profiles.${parsed.profiles.indexOf(profile)}.fields`, 'Há mais de um campo marcado para renomear o contato.', 'Marque apenas um campo como nome do contato.');
    }
  }

  if (!parsed.profiles.every((profile) => profile.fields.some((field) => field.id === parsed.areaFieldId && field.required))) {
    throw new ConfigValidationError('areaFieldId', 'O campo de área precisa existir e ser obrigatório em todos os fluxos.', 'Escolha um campo obrigatório que exista em cada fluxo.');
  }
  const materialCharacters = parsed.materials.reduce((total, material) => total + material.content.length, 0);
  if (materialCharacters > 20_000) {
    throw new ConfigValidationError('materials', 'O conteúdo dos materiais ultrapassa o total permitido.', 'Reduza o material para até 20.000 caracteres no conjunto.');
  }
  for (const [profileIndex, profile] of parsed.profiles.entries()) {
    for (const [fieldIndex, field] of profile.fields.entries()) {
      if (field.askWhen && !profile.fields.some((candidate) => candidate.id === field.askWhen?.fieldId)) {
        throw new ConfigValidationError(`profiles.${profileIndex}.fields.${fieldIndex}.askWhen.fieldId`, 'A condição aponta para uma pergunta inexistente.', 'Escolha uma pergunta deste fluxo ou remova a condição.');
      }
      if (['single_choice', 'multiple_choice'].includes(field.type) && field.options.length === 0) {
        throw new ConfigValidationError(`profiles.${profileIndex}.fields.${fieldIndex}.options`, 'Esta pergunta precisa de opções de resposta.', 'Adicione pelo menos uma opção.');
      }
    }
  }
  return parsed;
}

function migrateLegacyTimes(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = { ...(value as Record<string, unknown>) };
  if (config.batchWindowSeconds === undefined && typeof config.batchWindowMs === 'number') {
    config.batchWindowSeconds = config.batchWindowMs / 1000;
  }
  if (config.sendPartDelaySeconds === undefined && typeof config.sendPartDelayMs === 'number') {
    config.sendPartDelaySeconds = config.sendPartDelayMs / 1000;
  }
  if (config.typingSecondsPerCharacter === undefined && typeof config.typingMsPerCharacter === 'number') {
    config.typingSecondsPerCharacter = config.typingMsPerCharacter / 1000;
  }
  if (Array.isArray(config.profiles)) {
    const fields = config.profiles.flatMap((profile) => {
      const value = profile as { fields?: unknown };
      return Array.isArray(value.fields) ? value.fields as Array<Record<string, unknown>> : [];
    });
    if (!fields.some((field) => Object.prototype.hasOwnProperty.call(field, 'contactName'))) {
      const nameField = fields.find((field) => field.id === 'nome' || String(field.label ?? '').trim().toLocaleLowerCase('pt-BR') === 'nome');
      if (nameField) nameField.contactName = true;
    }
  }
  delete config.batchWindowMs;
  delete config.sendPartDelayMs;
  delete config.typingMsPerCharacter;
  return config;
}
