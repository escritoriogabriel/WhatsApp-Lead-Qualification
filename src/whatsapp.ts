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
import { SendOutcomeUnknownError } from './provider-errors.js';

export interface WhatsAppLabel { id: string; name: string; color: number; deleted: boolean }
export interface WhatsAppLabelAssociation { type: string; chatId: string; labelId: string }
export type WhatsAppLabelTarget = 'BOT' | 'HUMANO';
export interface WhatsAppStatus {
  provider: 'baileys' | 'waha' | 'meta';
  state: string;
  connected: boolean;
  labelsReady?: boolean;
  session?: string;
  engine?: string;
  account?: string;
}
export interface WhatsAppCallbacks {
  onIncoming: (message: IncomingMessage) => Promise<void> | void;
  onLabelEdit: (label: WhatsAppLabel) => void;
  onLabelAssociation: (association: WhatsAppLabelAssociation, add: boolean) => void;
  getLabelId: (name: string) => string | undefined;
  getContactLabelNames?: (jid: string) => string[];
  onLabelsReady?: () => Promise<void> | void;
}

type MessageContent = NonNullable<WAMessage['message']>;
const listNames = ['Novo Lead', 'Bot - atendimento', 'Atendimento', 'Clientes'] as const;

export interface WhatsAppConnection {
  sendText(jid: string, text: string): Promise<void>;
  setTyping?(jid: string, typing: boolean): Promise<void>;
  setContactLabels(jid: string, target: WhatsAppLabelTarget): Promise<void>;
  renameContact(jid: string, name: string): Promise<void>;
  getContactLabelNames?(jid: string): Promise<string[]>;
  close(): Promise<void>;
  getStatus?(): Promise<WhatsAppStatus>;
  getQrPng?(): Promise<Buffer | null>;
  handleWebhook?(body: unknown): Promise<void>;
  restart?(): Promise<void>;
}

export async function connectWhatsApp(
  config: RuntimeConfig,
  logger: Logger,
  onIncoming: (message: IncomingMessage) => Promise<void> | void,
  onLabelEdit: (label: WhatsAppLabel) => void,
  onLabelAssociation: (association: WhatsAppLabelAssociation, add: boolean) => void,
  getLabelId: (name: string) => string | undefined,
  getContactLabelNames?: (jid: string) => string[],
  onLabelsReady?: () => Promise<void> | void,
): Promise<WhatsAppConnection> {
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });

  let socket: WASocket | null = null;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let closing = false;
  let pairingRequired = false;
  let connected = false;
  let hasAppStateSyncKey = false;
  let labelSyncReady = false;
  let labelSyncAt = 0;
  let labelSyncInFlight: Promise<boolean> | undefined;
  let labelSyncToken: object | undefined;
  let labelSyncRetryTimer: NodeJS.Timeout | undefined;
  const labelIds = new Map<string, string>();
  const labelCreations = new Map<string, Promise<string>>();
  const localAssociationMutations = new Map<string, { count: number; timer: NodeJS.Timeout }>();
  const associationKey = (jid: string, labelId: string, operation: string) => `${jid}\u0000${labelId}\u0000${operation}`;
  const reserveLocalAssociation = (jid: string, labelId: string, operation: string): string => {
    const key = associationKey(jid, labelId, operation);
    const existing = localAssociationMutations.get(key);
    if (existing) clearTimeout(existing.timer);
    const entry = { count: (existing?.count ?? 0) + 1, timer: setTimeout(() => localAssociationMutations.delete(key), 10_000) };
    entry.timer.unref();
    localAssociationMutations.set(key, entry);
    return key;
  };
  const releaseLocalAssociation = (key: string) => {
    const entry = localAssociationMutations.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.count <= 1) localAssociationMutations.delete(key);
    else localAssociationMutations.set(key, { ...entry, count: entry.count - 1 });
  };
  const applyLocalAssociation = async (jid: string, labelId: string, operation: 'add' | 'remove', mutate: () => Promise<void>) => {
    const key = reserveLocalAssociation(jid, labelId, operation);
    try {
      await mutate();
      onLabelAssociation({ type: 'label_jid', chatId: jid, labelId }, operation === 'add');
    }
    catch (error) { releaseLocalAssociation(key); throw error; }
  };
  const syncNativeLabels = (activeSocket: WASocket, initialSync: boolean): Promise<boolean> => {
    if (labelSyncInFlight) return labelSyncInFlight;
    const wasReady = labelSyncReady;
    labelSyncReady = false;
    const token = {};
    labelSyncToken = token;
    const sync = (async (): Promise<boolean> => {
      try {
        // Account app-state contains native labels; this does not import message history.
        await activeSocket.resyncAppState(['regular'], initialSync);
        activeSocket.ev.flush();
        if (socket !== activeSocket || !connected || closing) return false;
        labelSyncReady = true;
        labelSyncAt = Date.now();
        logger.info('Listas nativas do WhatsApp sincronizadas');
        if (!wasReady) await onLabelsReady?.();
        return true;
      } catch (error) {
        labelSyncReady = false;
        logger.error({ error: safeError(error) }, 'Falha ao sincronizar as listas nativas; respostas bloqueadas');
        if (!closing && connected && socket === activeSocket && !labelSyncRetryTimer) {
          labelSyncRetryTimer = setTimeout(() => {
            labelSyncRetryTimer = undefined;
            void syncNativeLabels(activeSocket, true);
          }, 5_000);
        }
        return false;
      } finally {
        if (labelSyncToken === token) {
          labelSyncInFlight = undefined;
          labelSyncToken = undefined;
        }
      }
    })();
    labelSyncInFlight = sync;
    return sync;
  };
  const getFreshContactLabels = async (jid: string): Promise<string[]> => {
    const activeSocket = socket;
    if (!activeSocket || !connected) throw new Error('Sessão WhatsApp desconectada; listas indisponíveis.');
    if (!labelSyncReady) {
      if (!labelSyncInFlight || !(await labelSyncInFlight)) throw new Error('Sincronização das listas do WhatsApp ainda não foi confirmada.');
    } else if (Date.now() - labelSyncAt >= 1_500 && !(await syncNativeLabels(activeSocket, false))) {
      throw new Error('Não foi possível confirmar as listas atuais do WhatsApp.');
    }
    return getContactLabelNames?.(jid) ?? [];
  };
  const ensureLabel = async (jid: string, name: (typeof listNames)[number]): Promise<string> => {
    let id = labelIds.get(name) ?? getLabelId(name);
    if (id) return id;
    const pending = labelCreations.get(name);
    if (pending) return pending;
    const creation = (async () => {
      const createdId = randomUUID().replaceAll('-', '').slice(0, 12);
      const label = { id: createdId, name, color: name === 'Atendimento' ? 7 : name === 'Novo Lead' ? 4 : 2, deleted: false };
      const activeSocket = socket;
      if (!activeSocket) throw new Error('WhatsApp socket is not connected');
      await activeSocket.addLabel(jid, { id: createdId, name, color: label.color });
      labelIds.set(name, createdId);
      onLabelEdit(label);
      return createdId;
    })();
    labelCreations.set(name, creation);
    try { return await creation; }
    finally { labelCreations.delete(name); }
  };

  const open = async (): Promise<void> => {
    if (closing || pairingRequired) return;
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    hasAppStateSyncKey = Boolean(state.creds.myAppStateKeyId);
    const nextSocket = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false,
      browser: ['Windows', 'Chrome', '10.0.0'],
      // A inicialização do WhatsApp pode demorar durante resync; evite falsos timeouts
      // que deixam a sessão presa em init queries e force o reconector a assumir.
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 5_000,
      keepAliveIntervalMs: 25_000,
    });
    socket = nextSocket;

    nextSocket.ev.on('creds.update', () => {
      hasAppStateSyncKey = Boolean(state.creds.myAppStateKeyId);
      void saveCreds();
      if (connected && hasAppStateSyncKey && !labelSyncReady && !labelSyncInFlight) void syncNativeLabels(nextSocket, true);
    });
    nextSocket.ev.on('labels.edit', (label) => {
      if (label.name) {
        const normalized = normalizeListName(label.name);
        if (normalized) {
          if (!label.deleted) labelIds.set(normalized, label.id);
          else if (labelIds.get(normalized) === label.id) labelIds.delete(normalized);
        }
      }
      onLabelEdit(label);
    });
    nextSocket.ev.on('labels.association', ({ association, type }) => {
      if (association.type !== 'label_jid') return;
      const operation = type === 'add' ? 'add' : 'remove';
      const key = associationKey(association.chatId, association.labelId, operation);
      const local = localAssociationMutations.get(key);
      if (local) { releaseLocalAssociation(key); return; }
      onLabelAssociation(association, type === 'add');
    });
    nextSocket.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        logger.info('Escaneie o QR abaixo com o WhatsApp do número de teste:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        connected = true;
        labelSyncReady = false;
        logger.info('WhatsApp conectado');
        if (!hasAppStateSyncKey) logger.error('A sessão Baileys está sem myAppStateKeyId; respostas bloqueadas até parear novamente o dispositivo vinculado.');
        else void syncNativeLabels(nextSocket, true);
      }
      if (connection === 'close') {
        connected = false;
        labelSyncReady = false;
        labelSyncInFlight = undefined;
        labelSyncToken = undefined;
        if (labelSyncRetryTimer) clearTimeout(labelSyncRetryTimer);
        labelSyncRetryTimer = undefined;
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
      try {
        await socket.sendMessage(jid, { text });
      } catch {
        throw new SendOutcomeUnknownError();
      }
    },
    async setTyping(jid, typing) {
      if (!socket) throw new Error('WhatsApp socket is not connected');
      await socket.sendPresenceUpdate(typing ? 'composing' : 'paused', jid);
    },
    async setContactLabels(jid, target) {
      if (!socket) throw new Error('WhatsApp socket is not connected');
      if (!hasAppStateSyncKey) throw new Error('Sessão Baileys sem chave de sincronização de estado (myAppStateKeyId). Faça backup de data/auth e pareie novamente o dispositivo vinculado no WhatsApp.');
      const currentLabels = await getFreshContactLabels(jid);
      if (target === 'BOT' && currentLabels.some((name) => name.trim().toLocaleLowerCase('pt-BR') === 'clientes')) {
        throw new Error('Contato está na lista Clientes; remova essa etiqueta antes de ativar o bot.');
      }
      const targetName = target === 'BOT' ? 'Bot - atendimento' : 'Atendimento';
      const ids = await Promise.all(listNames.map((name) => ensureLabel(jid, name)));
      const targetId = ids[listNames.indexOf(targetName)];
      const newLeadId = ids[listNames.indexOf('Novo Lead')];
      for (const id of ids) {
        const clientId = ids[listNames.indexOf('Clientes')];
        if (id === targetId || id === clientId || (target === 'BOT' && id === newLeadId)) continue;
        await applyLocalAssociation(jid, id, 'remove', () => socket!.removeChatLabel(jid, id));
      }
      for (const legacyName of ['BOT', 'HUMANO']) {
        const legacyId = getLabelId(legacyName);
        if (legacyId) await applyLocalAssociation(jid, legacyId, 'remove', () => socket!.removeChatLabel(jid, legacyId));
      }
      await applyLocalAssociation(jid, targetId!, 'add', () => socket!.addChatLabel(jid, targetId!));
      if (target === 'BOT' && newLeadId !== targetId) await applyLocalAssociation(jid, newLeadId!, 'add', () => socket!.addChatLabel(jid, newLeadId!));
      labelSyncAt = Date.now();
    },
    async getContactLabelNames(jid) { return getFreshContactLabels(jid); },
    async renameContact(jid, name) {
      if (!socket) throw new Error('WhatsApp socket is not connected');
      const cleaned = name.trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!cleaned) return;
      await socket.addOrEditContact(jid, {
        fullName: cleaned,
        firstName: cleaned,
        saveOnPrimaryAddressbook: true,
      });
    },
    async getStatus() {
      return { provider: 'baileys', state: connected ? labelSyncReady ? 'WORKING' : 'SYNCING_LABELS' : pairingRequired ? 'FAILED' : 'DISCONNECTED', connected, labelsReady: labelSyncReady };
    },
    async close() {
      closing = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (labelSyncRetryTimer) clearTimeout(labelSyncRetryTimer);
      socket?.end(undefined);
      socket = null;
      labelSyncReady = false;
    },
  };
}

function normalizeListName(name: string): (typeof listNames)[number] | undefined {
  const normalized = name.trim().toLocaleLowerCase('pt-BR');
  if (normalized === 'novo lead') return 'Novo Lead';
  if (normalized === 'bot - atendimento') return 'Bot - atendimento';
  if (normalized === 'atendimento' || normalized === 'humano') return 'Atendimento';
  if (normalized === 'clientes') return 'Clientes';
  return undefined;
}

async function receiveMessage(
  socket: WASocket,
  message: WAMessage,
  config: RuntimeConfig,
  logger: Logger,
  onIncoming: (message: IncomingMessage) => Promise<void> | void,
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
    await onIncoming({
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
      logger.warn('Áudio excede o limite configurado');
    }
  } catch (error) {
    logger.warn(
      { error: safeError(error) },
      'Não foi possível baixar o áudio recebido',
    );
  }

  await onIncoming({
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
  return error instanceof Error ? error.name : 'UnknownError';
}
