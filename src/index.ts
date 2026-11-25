import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { pino } from 'pino';
import { startAdminPanel } from './admin-panel.js';
import { loadRuntimeConfig } from './config.js';
import { AgentDatabase } from './database.js';
import { GeminiProvider } from './gemini.js';
import { QualificationWorker } from './qualification.js';
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

  if (!runtime.geminiApiKey) {
    logger.warn('GEMINI_API_KEY está vazio. O worker não conseguirá transcrever áudios nem qualificar mensagens.');
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
  const leadPromotions = new Set<string>();

  const onIncoming: WhatsAppCallbacks['onIncoming'] = async (message) => {
    if (!db.hasContact(message.jid)) {
      db.ensureContact(message.jid, 'PAUSADO', 'new-lead');
    }
    let assignment = db.getContactAssignment(message.jid);
    if (assignment !== 'HUMANO' && assignment !== 'BOT') {
      try {
        if (!whatsapp) throw new Error('WhatsApp ainda está inicializando.');
        // Every unassigned inbound conversation is first catalogued in Novo Lead,
        // then moved to the only list eligible for automated qualification.
        await whatsapp.setContactAssignment(message.jid, 'PAUSADO');
        db.setContactAssignment(message.jid, 'PAUSADO', 'new-lead');
        await whatsapp.setContactAssignment(message.jid, 'BOT');
        db.setContactAssignment(message.jid, 'BOT', 'new-lead');
        assignment = 'BOT';
      } catch (error) {
        db.setContactAssignment(message.jid, 'PAUSADO', 'new-lead-list-failed');
        const detail = error instanceof Error ? error.message : String(error);
        db.recordDiagnostic(message.jid, 'falha-lista', `O lead ficou em Novo Lead/Pausado; não entrou em Bot - atendimento: ${detail}`);
        logger.error({ jid: message.jid, error: detail }, 'Falha ao mover novo lead para a lista Bot - atendimento');
      }
    }
    db.saveIncoming(message);
    logger.info(
      { jid: message.jid, kind: message.kind },
      'Mensagem recebida e colocada na fila',
    );
  };

  const onLabelEdit: WhatsAppCallbacks['onLabelEdit'] = (label) => {
    const newlyAssigned = db.saveLabel(label.id, label.name, label.color, label.deleted);
    for (const jid of newlyAssigned) {
      const queued = db.queueConversationStart(jid);
      if (queued) logger.info({ jid, list: 'Bot - atendimento' }, 'Início automático colocado na fila após sincronizar a lista');
    }
  };

  const onLabelAssociation: WhatsAppCallbacks['onLabelAssociation'] = (association: WhatsAppLabelAssociation, add) => {
    if (association.chatId.endsWith('@g.us')) return;
    const name = db.getLabelName(association.labelId) ?? association.labelId;
    const previousAssignment = db.getContactAssignment(association.chatId);
    db.updateContactLabel(association.chatId, association.labelId, name, add);
    const currentAssignment = db.getContactAssignment(association.chatId);
    if (currentAssignment === 'BOT' && (previousAssignment !== 'BOT' || db.getConversationState(association.chatId).profileId === null)) {
      const queued = db.queueConversationStart(association.chatId);
      if (queued) logger.info({ jid: association.chatId, list: 'Bot - atendimento' }, 'Início da conversa colocado na fila após mudança de lista');
    }
    if (add && name.trim().toLocaleLowerCase('pt-BR') === 'novo lead' && currentAssignment !== 'HUMANO' && !leadPromotions.has(association.chatId)) {
      const activeWhatsApp = whatsapp;
      if (!activeWhatsApp) {
        db.recordDiagnostic(association.chatId, 'falha-lista', 'Lead está em Novo Lead, mas o WhatsApp ainda não terminou de conectar. Mova novamente para a lista quando a conexão estiver pronta.');
        return;
      }
      leadPromotions.add(association.chatId);
      void (async () => {
        try {
          await activeWhatsApp.setContactAssignment(association.chatId, 'BOT');
          db.setContactAssignment(association.chatId, 'BOT', 'new-lead');
          db.recordDiagnostic(association.chatId, 'lista', 'Movido automaticamente de Novo Lead para Bot - atendimento');
          const queued = db.queueConversationStart(association.chatId);
          if (queued) logger.info({ jid: association.chatId }, 'Novo lead promovido e início da conversa colocado na fila');
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          db.setContactAssignment(association.chatId, 'PAUSADO', 'new-lead-list-failed');
          db.recordDiagnostic(association.chatId, 'falha-lista', `Não foi possível mover de Novo Lead para Bot - atendimento: ${detail}`);
          logger.error({ jid: association.chatId, error: detail }, 'Falha ao promover lead da lista Novo Lead');
        } finally {
          leadPromotions.delete(association.chatId);
        }
      })();
    }
  };

  const callbacks: WhatsAppCallbacks = {
    onIncoming,
    onLabelEdit,
    onLabelAssociation,
    getLabelId: (name) => db.getLabelIdByName(name),
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
    setConfig: (assistant) => {
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
      if (runtime.whatsappProvider !== 'waha' || !whatsapp?.handleWebhook) throw new Error('Provedor WAHA não está ativo.');
      await whatsapp.handleWebhook(body);
    },
    ...(runtime.whatsappProvider === 'waha' ? { wahaWebhookSecret: runtime.wahaWebhookSecret } : {}),
    logger,
  });

  const provider = new GeminiProvider(runtime.geminiApiKey, runtime.geminiModel);
  whatsapp = runtime.whatsappProvider === 'waha'
    ? await connectWaha(runtime, logger, callbacks)
    : await connectWhatsApp(runtime, logger, callbacks.onIncoming, callbacks.onLabelEdit, callbacks.onLabelAssociation, callbacks.getLabelId);
  logger.info({ whatsappProvider: runtime.whatsappProvider }, 'Provedor WhatsApp pronto');

  const abort = new AbortController();
  const worker = new QualificationWorker(
    db,
    provider,
    () => runtime.assistant,
    runtime,
    whatsapp.sendText,
    whatsapp,
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
