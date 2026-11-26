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
  whatsappProvider: z.enum(['meta', 'waha', 'baileys']).default('waha'),
  aiProvider: z.enum(['ollama', 'gemini']).default('gemini'),
  audioTranscriptionProvider: z.enum(['disabled', 'gemini']).default('disabled'),
  officeName: z.string().min(1),
  assistantName: z.string().min(1),
  writingStyle: z.string().min(1),
  officeMemory: z.string().max(5000).default(''),
  forbiddenTopics: z.array(z.string().min(1).max(200)).max(50).default([]),
  materials: z.array(z.object({ title: z.string().min(1).max(160), content: z.string().min(1).max(20_000) })).max(20).default([]),
  conversationStyleSamples: z.array(z.object({ title: z.string().min(1).max(160), content: z.string().min(1).max(12_000) })).max(5).default([]),
  conversationInstructions: z.string().max(4000).default('Use os exemplos somente para aprender o tom, a forma de acolher e a organização das respostas. Nunca copie nomes, telefones, processos ou fatos de clientes.'),
  responseTemplates: z.object({
    greeting: z.string().min(1).max(1000),
    directQuestion: z.string().min(1).max(1000),
    acknowledgement: z.string().min(1).max(500),
    humanHandoff: z.string().min(1).max(1000),
    completion: z.string().min(1).max(1000),
  }).default({
    greeting: 'Olá! Vou fazer algumas perguntas iniciais para encaminhar seu atendimento.',
    directQuestion: 'Para orientar o encaminhamento, preciso primeiro concluir algumas perguntas objetivas.',
    acknowledgement: 'Obrigado. Vou seguir com a próxima pergunta.',
    humanHandoff: 'Vou encaminhar seu atendimento para a equipe do escritório.',
    completion: 'Obrigado pelas informações. Vou encaminhar o resumo para a equipe do escritório.',
  }),
  conditionalEvents: z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    trigger: z.enum(['keyword', 'first_message', 'audio']),
    keywords: z.array(z.string().min(1).max(120)).max(30).default([]),
    action: z.enum(['notify_human', 'send_message', 'pause']),
    message: z.string().max(1000).default(''),
    enabled: z.boolean().default(true),
  })).max(20).default([]),
  greeting: z.string().min(1),
  assistantNotice: z.string().min(1).max(500).default('Sou um assistente virtual e faço somente a triagem inicial. Não sou advogado.'),
  privacyNotice: z.string().max(1000).default('Compartilhe apenas as informações necessárias para esta triagem. Não envie documentos ou dados sensíveis nesta conversa.'),
  externalProviderNotice: z.string().min(1).max(1000).default('Para continuar, o conteúdo que você enviar após este aviso poderá ser enviado ao Google Gemini para processamento da triagem. Se preferir, peça atendimento humano ou não continue.'),
  areaQuestion: z.string().min(1).max(500).default('Qual área do Direito ou assunto melhor descreve o seu caso?'),
  areaFieldId: z.string().min(1).max(64).default('assunto'),
  handoffMessage: z.string().min(1),
  audioRetryMessage: z.string().min(1),
  clarificationMessage: z.string().min(1).max(1000).default('Não consegui identificar essa informação com segurança. Você pode responder de outra forma ou pedir atendimento humano?'),
  aiFallbackMessage: z.string().min(1).max(1000).default('Não consegui continuar a triagem com segurança. Vou encaminhar seu atendimento para a equipe.'),
  acknowledgementMessage: z.string().min(1).max(300).default('Obrigado. Vou seguir com a próxima pergunta.'),
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
  minSecondsBetweenContactMessages: z.number().finite().nonnegative().default(0.5),
  maxMessagesPerContactPerDay: z.number().int().min(1).max(100_000).default(30),
  maxMessagesPerContactPerMonth: z.number().int().min(1).max(1_000_000).default(300),
  maxMessagesSentPerDay: z.number().int().min(1).max(1_000_000).default(2_000),
  maxMessagesSentPerMonth: z.number().int().min(1).max(10_000_000).default(20_000),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  maxFieldAttempts: z.number().int().min(1).max(5),
  maxAudioBytes: z.number().int().min(1024).max(25_000_000),
  maxHistoryMessages: z.number().int().min(1).max(50),
  workerPollMs: z.number().int().min(100).max(10_000),
  handoffKeywords: z.array(z.string().min(1)),
  legalQuestionKeywords: z.array(z.string().min(1)).max(100).default([
    'tenho direito', 'posso processar', 'qual o prazo', 'o que devo fazer', 'quanto vou receber',
    'posso ser demitido', 'posso pedir', 'vale a pena entrar', 'quais são meus direitos',
  ]),
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
  ollamaApiUrl: string;
  ollamaModel: string;
  geminiApiKey: string;
  geminiModel: string;
  whatsappProvider: 'baileys' | 'waha' | 'meta';
  wahaApiUrl: string;
  wahaApiKey: string;
  wahaSession: string;
  wahaWebhookUrl: string;
  wahaWebhookSecret: string;
  metaAccessToken: string;
  metaPhoneNumberId: string;
  metaGraphApiVersion: string;
  metaAppSecret: string;
  metaWebhookVerifyToken: string;
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
  const stored = JSON.parse(readFileSync(qualificationPath, 'utf8')) as Record<string, unknown>;
  const selectedProvider = stored.whatsappProvider ?? process.env.WHATSAPP_PROVIDER ?? 'baileys';
  const configuredProvider = String(selectedProvider).trim().toLowerCase();
  if (configuredProvider !== 'baileys' && configuredProvider !== 'waha' && configuredProvider !== 'meta') {
    throw new Error('WHATSAPP_PROVIDER deve ser "meta", "waha" ou "baileys".');
  }
  const parsed = validateAssistantConfig({ ...stored, whatsappProvider: configuredProvider });
  const wahaApiKey = process.env.WAHA_API_KEY ?? '';
  const wahaWebhookSecret = process.env.WAHA_WEBHOOK_SECRET ?? '';
  if (configuredProvider === 'waha' && (!wahaApiKey || !wahaWebhookSecret)) {
    throw new Error('WAHA_API_KEY e WAHA_WEBHOOK_SECRET são obrigatórios quando WHATSAPP_PROVIDER=waha.');
  }
  const metaAccessToken = process.env.META_ACCESS_TOKEN ?? '';
  const metaPhoneNumberId = process.env.META_PHONE_NUMBER_ID ?? '';
  const metaAppSecret = process.env.META_APP_SECRET ?? '';
  const metaWebhookVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
  if (configuredProvider === 'meta' && (!metaAccessToken || !metaPhoneNumberId || !metaAppSecret || !metaWebhookVerifyToken)) {
    throw new Error('META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_APP_SECRET e META_WEBHOOK_VERIFY_TOKEN são obrigatórios quando WHATSAPP_PROVIDER=meta.');
  }

  return {
    ollamaApiUrl: (process.env.OLLAMA_API_URL ?? 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:0.6b',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    whatsappProvider: configuredProvider,
    wahaApiUrl: (process.env.WAHA_API_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
    wahaApiKey,
    wahaSession: process.env.WAHA_SESSION ?? 'triagem',
    wahaWebhookUrl: process.env.WAHA_WEBHOOK_URL ?? 'http://localhost:3000/api/waha/webhook',
    wahaWebhookSecret,
    metaAccessToken,
    metaPhoneNumberId,
    metaGraphApiVersion: (process.env.META_GRAPH_API_VERSION ?? 'v27.0').replace(/^v?/, 'v'),
    metaAppSecret,
    metaWebhookVerifyToken,
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
  if (parsed.whatsappProvider === 'meta') {
    throw new ConfigValidationError('whatsappProvider', 'Este fluxo depende das listas nativas do WhatsApp, indisponíveis na Meta Cloud API.', 'Selecione WAHA ou Baileys.');
  }

  for (const [path, seconds] of [
    ['batchWindowSeconds', parsed.batchWindowSeconds],
    ['sendPartDelaySeconds', parsed.sendPartDelaySeconds],
    ['audioResponseDelaySeconds', parsed.audioResponseDelaySeconds],
    ['audioTranscriptionTimeoutSeconds', parsed.audioTranscriptionTimeoutSeconds],
    ['typingSecondsPerCharacter', parsed.typingSecondsPerCharacter],
    ['minSecondsBetweenContactMessages', parsed.minSecondsBetweenContactMessages],
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
  if ((parsed.aiProvider === 'gemini' || parsed.audioTranscriptionProvider === 'gemini') && parsed.externalProviderNotice.length > parsed.maxCharsPerMessage) {
    throw new ConfigValidationError('externalProviderNotice', 'O aviso de uso do provedor externo precisa caber em um balão.', 'Reduza o texto do aviso ou aumente o limite de caracteres por balão.');
  }
  const materialCharacters = parsed.materials.reduce((total, material) => total + material.content.length, 0);
  const sampleCharacters = parsed.conversationStyleSamples.reduce((total, sample) => total + sample.content.length, 0);
  if (sampleCharacters > 30_000) {
    throw new ConfigValidationError('conversationStyleSamples', 'Os exemplos de conversa ultrapassam o total permitido.', 'Reduza os exemplos para até 30.000 caracteres no conjunto.');
  }
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
