import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { RuntimeConfig } from './config.js';
import type { ContactAssignment, IncomingMessage } from './database.js';
import type {
  WhatsAppCallbacks,
  WhatsAppConnection,
  WhatsAppLabel,
  WhatsAppStatus,
} from './whatsapp.js';

type JsonObject = Record<string, unknown>;
type RemoteLabel = { id: string; name: string; color: number };

const WEBHOOK_EVENTS = [
  'message',
  'session.status',
  'label.upsert',
  'label.deleted',
  'label.chat.added',
  'label.chat.deleted',
];
const APP_LABELS = ['Novo Lead', 'Bot - atendimento', 'Atendimento'];
const LEGACY_LABELS = [...APP_LABELS, 'BOT', 'HUMANO'];
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
};

class WahaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WahaApiError';
  }
}

export async function connectWaha(
  config: RuntimeConfig,
  logger: Logger,
  callbacks: WhatsAppCallbacks,
): Promise<WhatsAppConnection> {
  const adapter = new WahaAdapter(config, logger, callbacks);
  await adapter.initialize();
  return adapter.connection();
}

export function normalizeWahaJid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('@c.us')) return `${trimmed.slice(0, -5)}@s.whatsapp.net`;
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid') || trimmed.endsWith('@g.us')) return trimmed;
  if (/^\d{10,15}$/.test(trimmed)) return `${trimmed}@s.whatsapp.net`;
  return trimmed;
}

export function toWahaChatId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('@s.whatsapp.net')) return `${trimmed.slice(0, -15)}@c.us`;
  if (trimmed.endsWith('@c.us') || trimmed.endsWith('@lid') || trimmed.endsWith('@g.us')) return trimmed;
  if (/^\d{10,15}$/.test(trimmed)) return `${trimmed}@c.us`;
  return trimmed;
}

class WahaAdapter {
  private readonly sessionPath: string;
  private readonly sessionName: string;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly logger: Logger,
    private readonly callbacks: WhatsAppCallbacks,
  ) {
    this.sessionName = config.wahaSession;
    this.sessionPath = `/api/sessions/${encodeURIComponent(this.sessionName)}`;
    const apiUrl = new URL(config.wahaApiUrl);
    if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
      throw new Error('WAHA_API_URL deve usar HTTP ou HTTPS.');
    }
    if (!/^[-a-zA-Z0-9_.]{1,64}$/.test(this.sessionName)) {
      throw new Error('WAHA_SESSION só pode conter letras, números, ponto, hífen e sublinhado.');
    }
  }

  async initialize(): Promise<void> {
    let session: JsonObject | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        session = asObject(await this.requestJson(this.sessionPath));
        break;
      } catch (error) {
        if (error instanceof WahaApiError && error.status === 404) {
          try {
            await this.requestJson('/api/sessions', {
              method: 'POST',
              body: JSON.stringify({ name: this.sessionName, config: { webhooks: [this.webhookConfig()] } }),
            });
            session = asObject(await this.requestJson(this.sessionPath));
            break;
          } catch (createError) {
            if (createError instanceof WahaApiError && createError.status === 409) {
              session = asObject(await this.requestJson(this.sessionPath));
              break;
            }
            if (attempt === 11 || createError instanceof WahaApiError && createError.status < 500) throw createError;
            await delay(1500);
          }
        } else {
          if (attempt === 11 || error instanceof WahaApiError && error.status < 500) throw error;
          await delay(1500);
        }
      }
    }
    if (!session) throw new Error(`Não foi possível obter a sessão WAHA "${this.sessionName}".`);

    await this.ensureWebhookConfig(session);
    let current = asObject(await this.requestJson(this.sessionPath));
    if (!current) throw new Error('WAHA retornou uma sessão inválida após configurar o webhook.');
    if (String(current.status ?? '').toUpperCase() === 'STOPPED') {
      await this.requestJson(`${this.sessionPath}/start`, { method: 'POST' });
      current = asObject(await this.requestJson(this.sessionPath));
      if (!current) throw new Error('WAHA retornou uma sessão inválida ao iniciar.');
    }
    this.logger.info(
      { provider: 'waha', session: this.sessionName, engine: getText(current.engine) },
      'Sessão WAHA inicializada; aguardando pareamento se necessário',
    );
  }

  connection(): WhatsAppConnection {
    return {
      sendText: (jid, text) => this.sendText(jid, text),
      setContactAssignment: (jid, assignment) => this.setContactAssignment(jid, assignment),
      renameContact: (jid, name) => this.renameContact(jid, name),
      getStatus: () => this.getStatus(),
      getQrPng: () => this.getQrPng(),
      handleWebhook: (body) => this.handleWebhook(body),
      restart: () => this.restart(),
      // WAHA owns the persistent WhatsApp socket, so stopping this app must not stop the session.
      close: async () => undefined,
    };
  }

  private async ensureWebhookConfig(session: JsonObject): Promise<void> {
    const sessionConfig = asObject(session.config) ?? {};
    const webhooks = Array.isArray(sessionConfig.webhooks)
      ? sessionConfig.webhooks.map(asObject).filter((item): item is JsonObject => item !== null)
      : [];
    const desired = this.webhookConfig();
    const matching = webhooks.filter((item) => !this.isOurWebhook(item));
    const own = webhooks.find((item) => this.isOurWebhook(item));
    if (own && sameWebhook(own, desired) && matching.length + 1 === webhooks.length) return;

    await this.requestJson(this.sessionPath, {
      method: 'PUT',
      body: JSON.stringify({
        name: this.sessionName,
        config: { ...sessionConfig, webhooks: [...matching, desired] },
      }),
    });
  }

  private webhookConfig(): JsonObject {
    return {
      url: this.config.wahaWebhookUrl,
      events: WEBHOOK_EVENTS,
      customHeaders: [{ name: 'X-Waha-Webhook-Secret', value: this.config.wahaWebhookSecret }],
      retries: { policy: 'linear', delaySeconds: 2, attempts: 5 },
    };
  }

  private isOurWebhook(webhook: JsonObject): boolean {
    return webhook.url === this.config.wahaWebhookUrl;
  }

  private async getStatus(): Promise<WhatsAppStatus> {
    const session = asObject(await this.requestJson(this.sessionPath));
    if (!session) throw new Error('WAHA retornou uma sessão inválida ao consultar o estado.');
    const state = getText(session.status) || 'UNKNOWN';
    const me = asObject(session.me);
    const engineValue = session.engine;
    const engine = typeof engineValue === 'string'
      ? engineValue
      : getText(asObject(engineValue)?.engine ?? asObject(engineValue)?.name);
    const account = getText(me?.id ?? me?.number ?? session.phone);
    return {
      provider: 'waha',
      state,
      connected: state.toUpperCase() === 'WORKING',
      session: this.sessionName,
      ...(engine ? { engine } : {}),
      ...(account ? { account } : {}),
    };
  }

  private async getQrPng(): Promise<Buffer | null> {
    const current = await this.getStatus();
    if (current.state.toUpperCase() !== 'SCAN_QR_CODE') return null;
    const response = await this.request(`/api/${encodeURIComponent(this.sessionName)}/auth/qr`, {
      headers: { Accept: 'image/png' },
    });
    if (response.status === 404 || response.status === 409 || response.status === 422) return null;
    if (!response.ok) throw await this.apiError(response);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('image')) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  private async restart(): Promise<void> {
    await this.requestJson(`${this.sessionPath}/restart`, { method: 'POST' });
  }

  private async sendText(jid: string, text: string): Promise<void> {
    const chatId = toWahaChatId(jid);
    if (this.config.assistant.simulateTyping) {
      await this.requestJson(`/api/startTyping`, {
        method: 'POST',
        body: JSON.stringify({ session: this.sessionName, chatId }),
      }).catch(() => undefined);
      if (this.config.assistant.typingSecondsPerCharacter > 0) {
        await delaySeconds(text.length * this.config.assistant.typingSecondsPerCharacter);
      }
    }
    try {
      await this.requestJson('/api/sendText', {
        method: 'POST',
        body: JSON.stringify({ session: this.sessionName, chatId, text }),
      });
    } finally {
      if (this.config.assistant.simulateTyping) {
        await this.requestJson('/api/stopTyping', {
          method: 'POST',
          body: JSON.stringify({ session: this.sessionName, chatId }),
        }).catch(() => undefined);
      }
    }
  }

  private async setContactAssignment(jid: string, assignment: ContactAssignment): Promise<void> {
    const targetName = assignment === 'BOT' ? 'Bot - atendimento' : assignment === 'HUMANO' ? 'Atendimento' : 'Novo Lead';
    let labels = await this.getLabels();
    let target = labels.find((label) => label.name.trim().toLocaleLowerCase('pt-BR') === targetName.toLocaleLowerCase('pt-BR'));
    if (!target) {
      const color = targetName === 'Novo Lead' ? 7 : targetName === 'Bot - atendimento' ? 4 : 2;
      await this.requestJson(`/api/${encodeURIComponent(this.sessionName)}/labels`, {
        method: 'POST',
        body: JSON.stringify({ name: targetName, color }),
      });
      labels = await this.getLabels();
      target = labels.find((label) => label.name.trim().toLocaleLowerCase('pt-BR') === targetName.toLocaleLowerCase('pt-BR'));
    }
    if (!target) throw new Error(`Não foi possível criar ou localizar a etiqueta "${targetName}" no WAHA.`);

    const chatId = toWahaChatId(jid);
    const chatPath = `/api/${encodeURIComponent(this.sessionName)}/labels/chats/${encodeURIComponent(chatId)}/`;
    const existingChatLabels = await this.requestJson(chatPath);
    const current = extractLabels(existingChatLabels);
    const managedIds = new Set(
      labels.filter((label) => LEGACY_LABELS.some((name) => name.toLocaleLowerCase('pt-BR') === label.name.trim().toLocaleLowerCase('pt-BR'))).map((label) => label.id),
    );
    const preserved = current.filter((label) => !managedIds.has(label.id)).map((label) => label.id);
    const nextIds = [...new Set([...preserved, target.id])];
    await this.requestJson(chatPath, {
      method: 'PUT',
      body: JSON.stringify({ labels: nextIds.map((id) => ({ id })) }),
    });
  }

  private async getLabels(): Promise<RemoteLabel[]> {
    const response = await this.requestJson(`/api/${encodeURIComponent(this.sessionName)}/labels`);
    return extractLabels(response);
  }

  private async renameContact(jid: string, name: string): Promise<void> {
    const cleaned = name.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!cleaned) return;
    const parts = cleaned.split(' ');
    const firstName = parts.shift() ?? cleaned;
    await this.requestJson(`/api/${encodeURIComponent(this.sessionName)}/contacts/${encodeURIComponent(toWahaChatId(jid))}`, {
      method: 'PUT',
      body: JSON.stringify({ firstName, lastName: parts.join(' ') }),
    });
  }

  private async handleWebhook(value: unknown): Promise<void> {
    const envelope = asObject(value);
    if (!envelope) throw new Error('Evento WAHA inválido: envelope ausente.');
    if (envelope.session && envelope.session !== this.sessionName) return;
    const event = getText(envelope.event);
    const payload = asObject(envelope.payload);
    if (!payload) return;

    if (event === 'message') {
      await this.receiveMessage(payload);
      return;
    }
    if (event === 'label.upsert' || event === 'label.deleted') {
      const labelValue = asObject(payload.label) ?? payload;
      const id = getText(labelValue.id ?? payload.labelId);
      const name = getText(labelValue.name);
      if (!id || (!name && event !== 'label.deleted')) return;
      const label: WhatsAppLabel = {
        id,
        name,
        color: getNumber(labelValue.color, 0),
        deleted: event === 'label.deleted',
      };
      this.callbacks.onLabelEdit(label);
      return;
    }
    if (event === 'label.chat.added' || event === 'label.chat.deleted') {
      const labelValue = asObject(payload.label);
      const labelId = getText(payload.labelId ?? labelValue?.id);
      const chatId = normalizeWahaJid(getText(payload.chatId ?? payload.chat));
      if (!labelId || !chatId) return;
      const inlineLabel = labelValue && getText(labelValue.name)
        ? { id: getText(labelValue.id), name: getText(labelValue.name), color: getNumber(labelValue.color, 0) }
        : undefined;
      const remoteLabel = inlineLabel ?? (await this.getLabels()).find((item) => item.id === labelId);
      if (remoteLabel?.name) {
        this.callbacks.onLabelEdit({ ...remoteLabel, deleted: false });
      }
      this.callbacks.onLabelAssociation({ type: 'label', chatId, labelId }, event === 'label.chat.added');
    }
  }

  private async receiveMessage(payload: JsonObject): Promise<void> {
    if (payload.fromMe === true || payload.fromMe === 'true') return;
    const rawChatId = getText(payload.from ?? payload.chatId);
    const jid = normalizeWahaJid(rawChatId);
    const messageId = getText(asObject(payload.id)?.id ?? payload.id);
    if (!jid || !messageId || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const media = asObject(payload.media);
    const body = getText(payload.body);
    const mimeType = getText(media?.mimetype ?? media?.mimeType ?? media?.mime).split(';')[0]!.trim().toLowerCase();
    const audioUrl = getText(media?.url);
    const isAudio = mimeType.startsWith('audio/') || Boolean(audioUrl && getText(media?.filename).toLowerCase().match(/\.(ogg|opus|mp3|m4a|aac|wav|webm)$/));
    let mediaPath: string | null = null;

    if (isAudio) {
      if (audioUrl && AUDIO_EXTENSIONS[mimeType]) {
        try {
          mediaPath = await this.downloadAudio(audioUrl, mimeType);
        } catch (error) {
          this.logger.warn({ jid, error: safeError(error) }, 'Não foi possível baixar o áudio recebido pelo WAHA');
        }
      } else if (audioUrl) {
        this.logger.warn({ jid, mimeType }, 'Formato de áudio não reconhecido para transcrição');
      }
      const timestamp = getNumber(payload.timestamp, Date.now());
      await this.callbacks.onIncoming({
        key: `${jid}:${messageId}`,
        jid,
        kind: 'audio',
        body: null,
        mediaPath,
        createdAt: timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp,
      });
      return;
    }

    if (!body) return;
    const timestamp = getNumber(payload.timestamp, Date.now());
    const message: IncomingMessage = {
      key: `${jid}:${messageId}`,
      jid,
      kind: 'text',
      body,
      mediaPath: null,
      createdAt: timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp,
    };
    await this.callbacks.onIncoming(message);
  }

  private async downloadAudio(rawUrl: string, mimeType: string): Promise<string | null> {
    const parsed = new URL(rawUrl, `${this.config.wahaApiUrl}/`);
    if (!parsed.pathname.startsWith('/api/files/')) {
      throw new Error('WAHA retornou um caminho de mídia inesperado.');
    }
    const url = new URL(`${parsed.pathname}${parsed.search}`, `${this.config.wahaApiUrl}/`);
    const response = await fetch(url, {
      headers: { 'X-Api-Key': this.config.wahaApiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Falha ao baixar mídia WAHA (HTTP ${response.status}).`);
    const announcedSize = Number(response.headers.get('content-length') ?? 0);
    if (announcedSize > this.config.assistant.maxAudioBytes) {
      this.logger.warn({ bytes: announcedSize }, 'Áudio excede o limite configurado');
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.config.assistant.maxAudioBytes) {
          await reader.cancel();
          this.logger.warn({ bytes: size }, 'Áudio excede o limite configurado');
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) return null;
    const mediaPath = join(this.config.mediaDir, `${randomUUID()}${AUDIO_EXTENSIONS[mimeType]}`);
    await writeFile(mediaPath, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), { mode: 0o600, flag: 'wx' });
    return mediaPath;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, `${this.config.wahaApiUrl}/`);
    const headers = new Headers(init.headers);
    headers.set('X-Api-Key', this.config.wahaApiKey);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('Accept', headers.get('Accept') ?? 'application/json');
    return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    if (!response.ok) throw await this.apiError(response);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error(`WAHA retornou uma resposta inválida (HTTP ${response.status}).`); }
  }

  private async apiError(response: Response): Promise<WahaApiError> {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    return new WahaApiError(`WAHA respondeu HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
  }
}

function extractLabels(value: unknown): RemoteLabel[] {
  const object = asObject(value);
  const list = Array.isArray(value) ? value : Array.isArray(object?.labels) ? object.labels : [];
  return list.flatMap((item) => {
    const label = asObject(item);
    const id = getText(label?.id);
    const name = getText(label?.name);
    if (!id) return [];
    return [{ id, name, color: getNumber(label?.color, 0) }];
  });
}

function sameWebhook(current: JsonObject, desired: JsonObject): boolean {
  if (current.url !== desired.url) return false;
  const events = (value: unknown) => Array.isArray(value) ? value.map(String).sort().join('|') : '';
  if (events(current.events) !== events(desired.events)) return false;
  const readHeader = (value: unknown): string => {
    if (!Array.isArray(value)) return '';
    const header = value.map(asObject).find((item) => getText(item?.name).toLowerCase() === 'x-waha-webhook-secret');
    return getText(header?.value);
  };
  return readHeader(current.customHeaders) === readHeader(desired.customHeaders);
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function getText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function getNumber(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function delaySeconds(seconds: number): Promise<void> {
  let remaining = Math.max(0, seconds * 1000);
  return new Promise((resolve) => {
    const wait = () => {
      const step = Math.min(remaining, 60_000);
      remaining -= step;
      setTimeout(remaining > 0 ? wait : resolve, step);
    };
    wait();
  });
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
