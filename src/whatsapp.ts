import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import type { RuntimeConfig } from './config.js';
import type { IncomingMessage } from './database.js';

type MessageContent = NonNullable<WAMessage['message']>;

export interface WhatsAppConnection {
  sendText(jid: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export async function connectWhatsApp(
  config: RuntimeConfig,
  logger: Logger,
  onIncoming: (message: IncomingMessage) => void,
): Promise<WhatsAppConnection> {
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });

  let socket: WASocket | null = null;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let closing = false;
  let pairingRequired = false;

  const open = async (): Promise<void> => {
    if (closing || pairingRequired) return;
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const nextSocket = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      browser: ['Windows', 'Chrome', '10.0.0'],
    });
    socket = nextSocket;

    nextSocket.ev.on('creds.update', saveCreds);
    nextSocket.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        logger.info('Escaneie o QR abaixo com o WhatsApp do número de teste:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        logger.info('WhatsApp conectado');
      }
      if (connection === 'close') {
        socket = null;
        const statusCode = (
          lastDisconnect?.error as
            | { output?: { statusCode?: number } }
            | undefined
        )?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          pairingRequired = true;
          logger.error(
            'Sessão desconectada pelo WhatsApp. Remova as credenciais locais apenas se for parear novamente e reinicie o serviço.',
          );
          return;
        }
        if (!closing && !reconnectTimer) {
          logger.warn({ statusCode }, 'WhatsApp desconectado; tentando reconectar');
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            void open().catch((error: unknown) =>
              logger.error({ error: safeError(error) }, 'Reconexão falhou'),
            );
          }, 3_000);
        }
      }
    });

    nextSocket.ev.on('messages.upsert', async (event) => {
      const envelope = event as typeof event & { requestId?: string };
      if (envelope.requestId || event.type !== 'notify') return;

      for (const message of event.messages) {
        try {
          await receiveMessage(
            nextSocket,
            message,
            config,
            logger,
            onIncoming,
          );
        } catch (error) {
          logger.error(
            { error: safeError(error) },
            'Falha ao receber mensagem do WhatsApp',
          );
        }
      }
    });
  };

  await open();

  return {
    async sendText(jid, text) {
      if (!socket) throw new Error('WhatsApp socket is not connected');
      if (config.assistant.simulateTyping && config.assistant.typingMsPerCharacter > 0) {
        const typingDuration = Math.min(
          12_000,
          text.length * config.assistant.typingMsPerCharacter,
        );
        await socket.sendPresenceUpdate('composing', jid).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, typingDuration));
      }
      await socket.sendMessage(jid, { text });
      if (config.assistant.simulateTyping) {
        await socket.sendPresenceUpdate('paused', jid).catch(() => undefined);
      }
    },
    async close() {
      closing = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.end(undefined);
      socket = null;
    },
  };
}

async function receiveMessage(
  socket: WASocket,
  message: WAMessage,
  config: RuntimeConfig,
  logger: Logger,
  onIncoming: (message: IncomingMessage) => void,
): Promise<void> {
  const jid = message.key.remoteJid;
  const messageId = message.key.id;
  if (
    !jid ||
    !messageId ||
    message.key.fromMe ||
    jid.endsWith('@g.us') ||
    jid === 'status@broadcast' ||
    !message.message
  ) {
    return;
  }

  const content = unwrapContent(message.message);
  const text = extractText(content);
  if (text !== null) {
    onIncoming({
      key: jid + ':' + messageId,
      jid,
      kind: 'text',
      body: text,
      mediaPath: null,
      createdAt: Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    });
    return;
  }

  if (!hasAudio(content)) return;
  let mediaPath: string | null = null;
  try {
    const bytes = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: socket.updateMediaMessage,
      },
    );
    if (bytes.byteLength <= config.assistant.maxAudioBytes) {
      mediaPath = join(config.mediaDir, randomUUID() + '.ogg');
      await writeFile(mediaPath, bytes, { mode: 0o600 });
    } else {
      logger.warn({ jid }, 'Áudio excede o limite configurado');
    }
  } catch (error) {
    logger.warn(
      { jid, error: safeError(error) },
      'Não foi possível baixar o áudio recebido',
    );
  }

  onIncoming({
    key: jid + ':' + messageId,
    jid,
    kind: 'audio',
    body: null,
    mediaPath,
    createdAt: Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000,
  });
}

function unwrapContent(content: MessageContent): MessageContent {
  let current = content as unknown as Record<string, unknown>;
  const wrappers = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'documentWithCaptionMessage',
  ];
  for (let count = 0; count < 4; count += 1) {
    const wrapperName = wrappers.find((name) => current[name]);
    if (!wrapperName) break;
    const wrapper = asRecord(current[wrapperName]);
    const nested = wrapper ? asRecord(wrapper.message) : undefined;
    if (!nested) break;
    current = nested;
  }
  return current as MessageContent;
}

function extractText(content: MessageContent): string | null {
  const record = content as unknown as Record<string, unknown>;
  if (typeof record.conversation === 'string') return record.conversation;
  const extended = asRecord(record.extendedTextMessage);
  if (typeof extended?.text === 'string') return extended.text;
  return null;
}

function hasAudio(content: MessageContent): boolean {
  const record = content as unknown as Record<string, unknown>;
  return asRecord(record.audioMessage) !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown WhatsApp error';
}
