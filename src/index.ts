import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { pino } from 'pino';
import { startAdminPanel } from './admin-panel.js';
import { loadRuntimeConfig } from './config.js';
import { AgentDatabase } from './database.js';
import { GroqProvider } from './groq.js';
import { QualificationWorker } from './qualification.js';
import { connectWhatsApp } from './whatsapp.js';

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
    runtime.assistant.batchWindowMs,
  );
  const closePanel = await startAdminPanel({
    configPath: runtime.qualificationPath,
    host: process.env.PANEL_HOST ?? '127.0.0.1',
    port: Number(process.env.PANEL_PORT ?? 3000),
    password: process.env.PANEL_PASSWORD ?? '',
    getConfig: () => runtime.assistant,
    setConfig: (assistant) => {
      runtime.assistant = assistant;
      db.setBatchWindowMs(assistant.batchWindowMs);
    },
    logger,
  });
  const provider = new GroqProvider(
    runtime.apiKey,
    runtime.chatModel,
    runtime.transcriptionModel,
  );
  const whatsapp = await connectWhatsApp(runtime, logger, (message) => {
    db.saveIncoming(message);
    logger.info(
      { jid: message.jid, kind: message.kind },
      'Mensagem recebida e colocada na fila',
    );
  });

  const abort = new AbortController();
  const worker = new QualificationWorker(
    db,
    provider,
    () => runtime.assistant,
    runtime,
    whatsapp.sendText,
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
    await whatsapp.close();
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
