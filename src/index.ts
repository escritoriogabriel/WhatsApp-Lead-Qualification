import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { pino } from 'pino';
import { startAdminPanel } from './admin-panel.js';
import { loadRuntimeConfig } from './config.js';
import { AgentDatabase } from './database.js';
import { GroqProvider } from './groq.js';
import { QualificationWorker } from './qualification.js';
import { connectWhatsApp, type WhatsAppConnection } from './whatsapp.js';

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const logger = pino({ level: runtime.logLevel });
  await mkdir(runtime.mediaDir, { recursive: true, mode: 0o700 });

  if (!runtime.apiKey) {
    logger.warn(
      'GROQ_API_KEY está vazio. O worker não conseguirá transcrever áudios nem qualificar mensagens.',
    );
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
    logger,
  });
  const provider = new GroqProvider(
    runtime.apiKey,
    runtime.chatModel,
    runtime.transcriptionModel,
  );
  whatsapp = await connectWhatsApp(runtime, logger, async (message) => {
    const isNew = !db.hasStoredMessages(message.jid) && !db.hasContact(message.jid);
    if (!db.hasContact(message.jid)) {
      db.ensureContact(message.jid, isNew ? 'BOT' : 'PAUSADO', isNew ? 'new-lead' : 'legacy-contact');
    }
    if (isNew) {
      try {
        if (!whatsapp) throw new Error('WhatsApp ainda está inicializando.');
        await whatsapp.setContactAssignment(message.jid, 'BOT');
        db.setContactAssignment(message.jid, 'BOT', 'new-lead');
      } catch (error) {
        db.setContactAssignment(message.jid, 'BOT', 'new-lead-local-fallback');
        db.recordDiagnostic(message.jid, 'falha-etiqueta', error instanceof Error ? error.message : 'Não foi possível aplicar etiqueta BOT');
        logger.error({ jid: message.jid, error: error instanceof Error ? error.message : String(error) }, 'Falha ao aplicar etiqueta BOT ao novo lead');
      }
    }
    db.saveIncoming(message);
    logger.info(
      { jid: message.jid, kind: message.kind },
      'Mensagem recebida e colocada na fila',
    );
  },
  (label) => db.saveLabel(label.id, label.name, label.color, label.deleted),
  (association, add) => {
    const name = db.getLabelName(association.labelId) ?? association.labelId;
    db.updateContactLabel(association.chatId, association.labelId, name, add);
  },
  (name) => db.getLabelIdByName(name));

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
