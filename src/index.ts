import 'dotenv/config';
import { mkdir, unlink } from 'node:fs/promises';
import { pino } from 'pino';
import { startAdminPanel } from './admin-panel.js';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';
import { AgentDatabase } from './database.js';
import { RoutedAIProvider } from './ai-router.js';
import { connectMetaCloudApi } from './meta.js';
import { QualificationWorker, type ContactManager } from './qualification.js';
import { connectWaha } from './waha.js';
import {
  connectWhatsApp,
  type WhatsAppCallbacks,
  type WhatsAppConnection,
  type WhatsAppLabelAssociation,
  type WhatsAppStatus,
} from './whatsapp.js';

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const logger = pino({ level: runtime.logLevel });
  await mkdir(runtime.mediaDir, { recursive: true, mode: 0o700 });

  if (runtime.assistant.aiProvider === 'gemini' && !runtime.geminiApiKey) {
    logger.warn('Gemini está selecionado sem GEMINI_API_KEY; a triagem não poderá usar IA.');
  }
  if (runtime.assistant.audioTranscriptionProvider === 'gemini' && !runtime.geminiApiKey) {
    logger.warn('Transcrição Gemini selecionada sem GEMINI_API_KEY; áudios serão encaminhados à equipe.');
  }
  if (runtime.assistant.aiProvider === 'gemini' || runtime.assistant.audioTranscriptionProvider === 'gemini') {
    logger.warn('A configuração envia somente o conteúdo necessário à extração ou transcrição ao provedor externo Gemini.');
  }
  if (!runtime.humanNotifyJid) {
    logger.warn(
      'HUMAN_NOTIFY_JID está vazio. Encaminhamentos serão registrados no banco, mas a equipe não receberá resumo automático.',
    );
  }

  const db = new AgentDatabase(
    runtime.databasePath,
    runtime.assistant.batchWindowSeconds * 1000,
  );
  let whatsapp: WhatsAppConnection | null = null;
  const onIncoming: WhatsAppCallbacks['onIncoming'] = async (message) => {
    const firstContactObserved = !db.hasStoredMessages(message.jid);
    // Persist before any provider synchronization; webhook retries are deduplicated by provider id.
    let inserted: boolean;
    try {
      inserted = db.saveIncoming(message);
    } catch (error) {
      if (message.mediaPath) await unlink(message.mediaPath).catch(() => undefined);
      throw error;
    }
    if (!inserted) {
      if (message.mediaPath) await unlink(message.mediaPath).catch(() => undefined);
      return;
    }
    if (firstContactObserved && runtime.assistant.firstMessagePolicy === 'auto' &&
      db.getContactAssignment(message.jid) === 'PAUSADO' && !db.isManualPause(message.jid)) {
      try {
        if (!whatsapp) throw new Error('WhatsApp ainda está inicializando.');
        await whatsapp.setContactAssignment(message.jid, 'BOT');
        db.setContactAssignment(message.jid, 'BOT', 'new-lead');
        db.recordDiagnostic(message.jid, 'autorizacao', 'Primeira mensagem observada; triagem iniciada pela política configurada.');
        db.queueConversationStart(message.jid);
      } catch (error) {
        db.setContactAssignment(message.jid, 'PAUSADO', 'new-lead-list-failed');
        db.recordDiagnostic(message.jid, 'falha-lista', 'Não foi possível confirmar a elegibilidade no provedor; a mensagem permanece pendente.');
        logger.error('Falha ao confirmar elegibilidade para primeira resposta; mensagem mantida pendente.');
      }
    }
    if (firstContactObserved) db.recordDiagnostic(message.jid, 'primeiro-contato-observado', 'Primeiro contato observado pelo sistema; isso não indica histórico anterior com o escritório.');
    logger.info({ kind: message.kind }, 'Mensagem recebida e colocada na fila');
  };

  const onLabelEdit: WhatsAppCallbacks['onLabelEdit'] = (label) => {
    const newlyAssigned = db.saveLabel(label.id, label.name, label.color, label.deleted);
    for (const jid of newlyAssigned) db.queueConversationStart(jid);
  };

  const onLabelAssociation: WhatsAppCallbacks['onLabelAssociation'] = (association: WhatsAppLabelAssociation, add) => {
    if (association.chatId.endsWith('@g.us')) return;
    const name = db.getLabelName(association.labelId) ?? association.labelId;
    db.updateContactLabel(association.chatId, association.labelId, name, add);
    const currentAssignment = db.getContactAssignment(association.chatId);
    if (currentAssignment === 'BOT') db.queueConversationStart(association.chatId);
  };

  const callbacks: WhatsAppCallbacks = {
    onIncoming,
    onLabelEdit,
    onLabelAssociation,
    getLabelId: (name) => db.getLabelIdByName(name),
  };
  const openWhatsAppProvider = async (provider: RuntimeConfig['whatsappProvider']): Promise<WhatsAppConnection> => {
    if (provider === 'waha') return connectWaha(runtime, logger, callbacks);
    if (provider === 'meta') return connectMetaCloudApi(runtime, logger, callbacks);
    return connectWhatsApp(runtime, logger, callbacks.onIncoming, callbacks.onLabelEdit, callbacks.onLabelAssociation, callbacks.getLabelId);
  };
  const ensureProviderCredentials = (provider: RuntimeConfig['whatsappProvider']): void => {
    if (provider === 'waha' && (!runtime.wahaApiKey || !runtime.wahaWebhookSecret)) {
      throw new Error('WAHA_API_KEY e WAHA_WEBHOOK_SECRET são obrigatórios para usar WAHA.');
    }
    if (provider === 'meta' && (!runtime.metaAccessToken || !runtime.metaPhoneNumberId || !runtime.metaAppSecret || !runtime.metaWebhookVerifyToken)) {
      throw new Error('Configure as quatro credenciais META_* necessárias antes de selecionar a Meta Cloud API.');
    }
  };
  const changeWhatsAppProvider = async (provider: RuntimeConfig['whatsappProvider']): Promise<void> => {
    ensureProviderCredentials(provider);
    if (provider === runtime.whatsappProvider) return;
    if (!whatsapp) {
      runtime.whatsappProvider = provider;
      return;
    }
    const previousProvider = runtime.whatsappProvider;
    const previousConnection = whatsapp;
    whatsapp = null;
    await previousConnection.close();
    runtime.whatsappProvider = provider;
    try {
      whatsapp = await openWhatsAppProvider(provider);
      logger.info({ whatsappProvider: provider }, 'Provedor WhatsApp alterado pelo painel');
    } catch (error) {
      runtime.whatsappProvider = previousProvider;
      try {
        whatsapp = await openWhatsAppProvider(previousProvider);
      } catch {
        whatsapp = null;
        logger.error({ previousProvider }, 'Falha ao restaurar o provedor WhatsApp anterior');
      }
      throw error;
    }
  };
  const getWhatsAppStatus = async (): Promise<WhatsAppStatus> => {
    if (whatsapp?.getStatus) return whatsapp.getStatus();
    return { provider: runtime.whatsappProvider, state: 'INITIALIZING', connected: false };
  };

  const closePanel = await startAdminPanel({
    configPath: runtime.qualificationPath,
    host: process.env.PANEL_HOST ?? '127.0.0.1',
    port: Number(process.env.PANEL_PORT ?? 3000),
    password: process.env.PANEL_PASSWORD ?? '',
    getConfig: () => runtime.assistant,
    setConfig: async (assistant) => {
      await changeWhatsAppProvider(assistant.whatsappProvider);
      runtime.assistant = assistant;
      db.setBatchWindowMs(assistant.batchWindowSeconds * 1000);
    },
    database: db,
    setContactAssignment: async (jid, assignment) => {
      if (!whatsapp) throw new Error('WhatsApp ainda está conectando. Tente novamente em instantes.');
      await whatsapp.setContactAssignment(jid, assignment);
    },
    getWhatsAppStatus,
    getWhatsAppQr: async () => whatsapp?.getQrPng ? whatsapp.getQrPng() : null,
    restartWhatsApp: async () => {
      if (!whatsapp?.restart) throw new Error('Reinício da sessão não está disponível para este provedor.');
      await whatsapp.restart();
    },
    handleWahaWebhook: async (body) => {
      if (runtime.whatsappProvider !== 'waha' || !whatsapp?.handleWebhook) return;
      await whatsapp.handleWebhook(body);
    },
    handleMetaWebhook: async (body) => {
      if (runtime.whatsappProvider !== 'meta' || !whatsapp?.handleWebhook) return;
      await whatsapp.handleWebhook(body);
    },
    wahaWebhookSecret: runtime.wahaWebhookSecret,
    metaAppSecret: runtime.metaAppSecret,
    metaWebhookVerifyToken: runtime.metaWebhookVerifyToken,
    logger,
  });

  const provider = new RoutedAIProvider(() => runtime.assistant, runtime);
  ensureProviderCredentials(runtime.whatsappProvider);
  whatsapp = await openWhatsAppProvider(runtime.whatsappProvider);
  logger.info({ whatsappProvider: runtime.whatsappProvider }, 'Provedor WhatsApp pronto');

  const abort = new AbortController();
  const worker = new QualificationWorker(
    db,
    provider,
    () => runtime.assistant,
    runtime,
    async (jid, text) => {
      if (!whatsapp) throw new Error('Provedor WhatsApp está sendo alterado.');
      await whatsapp.sendText(jid, text);
    },
    {
      setContactAssignment: async (jid, assignment) => {
        if (!whatsapp) throw new Error('Provedor WhatsApp está sendo alterado.');
        await whatsapp.setContactAssignment(jid, assignment);
      },
      renameContact: async (jid, name) => {
        if (!whatsapp) throw new Error('Provedor WhatsApp está sendo alterado.');
        await whatsapp.renameContact(jid, name);
      },
      getStatus: async () => {
        if (!whatsapp) return { connected: false };
        return { connected: (await whatsapp.getStatus?.())?.connected ?? false };
      },
      get getContactAssignment(): ContactManager['getContactAssignment'] {
        if (!whatsapp?.getContactAssignment) return undefined;
        return (jid: string) => whatsapp!.getContactAssignment!(jid);
      },
      get setTyping(): ContactManager['setTyping'] {
        if (!whatsapp?.setTyping) return undefined;
        return (jid: string, typing: boolean) => whatsapp!.setTyping!(jid, typing);
      },
    } satisfies ContactManager,
    logger,
  );
  void worker.run(abort.signal);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Encerrando agente');
    abort.abort();
    await closePanel();
    await whatsapp?.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error: unknown) => {
  console.error('Falha ao iniciar o agente:', error);
  process.exitCode = 1;
});
