import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { ProviderRetryAfterError, SendOutcomeUnknownError } from './provider-errors.js';
import type { RuntimeConfig } from './config.js';
import type { IncomingMessage } from './database.js';
import type {
  WhatsAppCallbacks,
  WhatsAppConnection,
  WhatsAppLabel,
  WhatsAppLabelTarget,
  WhatsAppStatus,
} from './whatsapp.js';

type JsonObject = Record<string, unknown>;
type RemoteLabel = { id: string; name: string };
type SessionInfo = { id: string; name?: string; status?: string; phone?: string };

const WEBHOOK_EVENTS = ['message.received', 'session.status'];
const MANAGED_LABELS = ['Novo Lead', 'Bot - atendimento', 'Atendimento', 'Clientes', 'BOT', 'HUMANO'];
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
const TEXT_TYPES = new Set(['text', 'masked', 'unknown']);
const AUDIO_TYPES = new Set(['audio', 'voice']);

export class OpenwaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly retryAfterMs = 60_000,
  ) {
    super(message);
    this.name = 'OpenwaApiError';
  }
}

export async function connectOpenwa(
  config: RuntimeConfig,
  logger: Logger,
  callbacks: WhatsAppCallbacks,
): Promise<WhatsAppConnection> {
  const adapter = new OpenwaAdapter(config, logger, callbacks);
  await adapter.initialize();
  return adapter.connection();
}

/** Splits an OpenWA `sha256=<hex>` signature header into its hex digest. */
export function openwaSignatureDigest(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  const trimmed = signature.trim();
  const value = trimmed.startsWith('sha256=') ? trimmed.slice(7) : trimmed;
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

/** Verifies `X-OpenWA-Signature`: HMAC-SHA256 over the exact raw body bytes. */
export function validOpenwaSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const digest = openwaSignatureDigest(signature);
  if (!digest) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(digest, 'hex');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function normalizeOpenwaJid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('@c.us')) return `${trimmed.slice(0, -5)}@s.whatsapp.net`;
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid') || trimmed.endsWith('@g.us')) return trimmed;
  if (/^\d{10,15}$/.test(trimmed)) return `${trimmed}@s.whatsapp.net`;
  return trimmed;
}

export function toOpenwaChatId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('@s.whatsapp.net')) return `${trimmed.slice(0, -15)}@c.us`;
  if (trimmed.endsWith('@c.us') || trimmed.endsWith('@lid') || trimmed.endsWith('@g.us')) return trimmed;
  if (/^\d{10,15}$/.test(trimmed)) return `${trimmed}@c.us`;
  return trimmed;
}

class OpenwaAdapter {
  private readonly apiBase: string;
  private sessionId = '';
  private sessionName: string;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly logger: Logger,
    private readonly callbacks: WhatsAppCallbacks,
  ) {
    const base = new URL(config.openwaBaseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error('OPENWA_BASE_URL deve usar HTTP ou HTTPS.');
    }
    this.apiBase = `${base.origin}${base.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
    this.sessionName = config.openwaSessionName;
    if (!/^[a-zA-Z0-9-]{3,50}$/.test(this.sessionName)) {
      throw new Error('OPENWA_SESSION_NAME deve ter de 3 a 50 caracteres, usando apenas letras, números e hífen.');
    }
  }

  async initialize(): Promise<void> {
    this.sessionId = this.config.openwaSessionId || (await this.resolveSession());
    await this.ensureWebhook();
    let session = await this.getSession();
    if (['created', 'disconnected'].includes(session.status ?? '')) {
      this.logger.info({ session: session.name }, 'Sessão OpenWA parada; iniciando');
      await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/start`, { method: 'POST' }).catch((error: unknown) => {
        this.logger.warn({ error: safeError(error) }, 'Não foi possível iniciar a sessão OpenWA automaticamente');
      });
      session = await this.getSession();
    }
    this.logger.info(
      { provider: 'openwa', session: session.name ?? this.sessionId, state: session.status },
      'Sessão OpenWA inicializada; aguardando pareamento se necessário',
    );
  }

  connection(): WhatsAppConnection {
    return {
      sendText: (jid, text) => this.sendText(jid, text),
      setTyping: (jid, typing) => this.setTyping(jid, typing),
      setContactLabels: (jid, target) => this.setContactLabels(jid, target),
      getContactLabelNames: (jid) => this.getContactLabelNames(jid),
      renameContact: (jid, name) => this.renameContact(jid, name),
      getStatus: () => this.getStatus(),
      getQrPng: () => this.getQrPng(),
      handleWebhook: (body) => this.handleWebhook(body),
      restart: () => this.restart(),
      // OpenWA owns the persistent WhatsApp session, so stopping this app must not stop it.
      close: async () => undefined,
    };
  }

  private async resolveSession(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const sessions = await this.requestJson('/sessions');
        const list = Array.isArray(sessions) ? sessions.map(asObject).filter((item): item is JsonObject => item !== null) : [];
        const match = list.find((item) => getText(item.name) === this.sessionName);
        if (match && getText(match.id)) return getText(match.id);
        const created = asObject(await this.requestJson('/sessions', {
          method: 'POST',
          body: JSON.stringify({ name: this.sessionName }),
        }));
        const id = getText(created?.id);
        if (id) {
          this.logger.info({ session: this.sessionName }, 'Sessão OpenWA criada; pareie o número de teste');
          return id;
        }
        throw new Error('OpenWA não retornou o identificador da sessão criada.');
      } catch (error) {
        const retryable = !(error instanceof OpenwaApiError) || error.status >= 500 || error.status === 409;
        if (attempt === 11 || !retryable) throw error;
        await delay(1500);
      }
    }
    throw new Error(`Não foi possível obter a sessão OpenWA "${this.sessionName}".`);
  }

  private async getSession(): Promise<SessionInfo> {
    const session = asObject(await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}`));
    if (!session) throw new Error('OpenWA retornou uma sessão inválida.');
    return {
      id: getText(session.id) || this.sessionId,
      ...(getText(session.name) ? { name: getText(session.name) } : {}),
      ...(getText(session.status) ? { status: getText(session.status).toLowerCase() } : {}),
      ...(getText(session.phone) ? { phone: getText(session.phone) } : {}),
    };
  }

  private async ensureWebhook(): Promise<void> {
    const base = `/sessions/${encodeURIComponent(this.sessionId)}/webhooks`;
    const desired = {
      url: this.config.openwaWebhookUrl,
      events: WEBHOOK_EVENTS,
      secret: this.config.openwaWebhookSecret,
      retryCount: 3,
      active: true,
    };
    try {
      const current = await this.requestJson(base);
      const list = Array.isArray(current) ? current.map(asObject).filter((item): item is JsonObject => item !== null) : [];
      const existing = list.find((item) => getText(item.url) === desired.url);
      if (!existing) {
        await this.requestJson(base, { method: 'POST', body: JSON.stringify(desired) });
        this.logger.info('Webhook OpenWA registrado');
        return;
      }
      const id = getText(existing.id);
      const events = Array.isArray(existing.events) ? existing.events.map(String).sort().join('|') : '';
      if (id && (events !== [...WEBHOOK_EVENTS].sort().join('|') || existing.active === false)) {
        // The secret is write-only, so it is always re-sent with the update.
        await this.requestJson(`${base}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(desired) });
        this.logger.info('Webhook OpenWA atualizado');
      }
    } catch (error) {
      this.logger.error(
        { error: safeError(error) },
        'Não foi possível registrar o webhook OpenWA; mensagens recebidas não chegarão até corrigir OPENWA_WEBHOOK_URL (o OpenWA recusa URLs internas sem WEBHOOK_SSRF_PROTECT=false)',
      );
    }
  }

  private async getStatus(): Promise<WhatsAppStatus> {
    const session = await this.getSession();
    const state = (session.status ?? 'unknown').toLowerCase();
    const connected = state === 'ready';
    return {
      provider: 'openwa',
      state: mapState(state),
      connected,
      labelsReady: connected,
      ...(session.name ? { session: session.name } : {}),
      ...(session.phone ? { account: session.phone } : {}),
    };
  }

  private async getQrPng(): Promise<Buffer | null> {
    const session = await this.getSession();
    if ((session.status ?? '').toLowerCase() !== 'qr_ready') return null;
    const payload = asObject(await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/qr`));
    const dataUrl = getText(payload?.qrCode);
    const marker = 'base64,';
    const index = dataUrl.indexOf(marker);
    if (index === -1) return null;
    try {
      return Buffer.from(dataUrl.slice(index + marker.length), 'base64');
    } catch {
      return null;
    }
  }

  private async restart(): Promise<void> {
    await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/stop`, { method: 'POST' }).catch(() => undefined);
    await delay(2000);
    await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/start`, { method: 'POST' });
  }

  private async sendText(jid: string, text: string): Promise<void> {
    try {
      await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/messages/send-text`, {
        method: 'POST',
        body: JSON.stringify({ chatId: toOpenwaChatId(jid), text }),
      });
    } catch (error) {
      if (error instanceof OpenwaApiError && error.status === 429) throw new ProviderRetryAfterError(error.retryAfterMs);
      if (error instanceof OpenwaApiError && error.status >= 500) throw new SendOutcomeUnknownError();
      if (!(error instanceof OpenwaApiError)) throw new SendOutcomeUnknownError();
      throw error;
    }
  }

  private async setTyping(jid: string, typing: boolean): Promise<void> {
    await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/chats/typing`, {
      method: 'POST',
      body: JSON.stringify({ chatId: toOpenwaChatId(jid), state: typing ? 'typing' : 'paused' }),
    });
  }

  private async setContactLabels(jid: string, target: WhatsAppLabelTarget): Promise<void> {
    const chatId = toOpenwaChatId(jid);
    const labels = await this.getLabels();
    const findLabel = (name: string) =>
      labels.find((label) => label.name.trim().toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
    const required = target === 'BOT' ? ['Novo Lead', 'Bot - atendimento'] : ['Atendimento'];
    const missing = required.filter((name) => !findLabel(name));
    if (missing.length) {
      throw new Error(
        `A etiqueta "${missing.join('", "')}" não existe nesta conta do WhatsApp. Crie as etiquetas Novo Lead, Bot - atendimento, Atendimento e Clientes no aplicativo WhatsApp Business antes de ativar o bot; o OpenWA não cria etiquetas no mecanismo whatsapp-web.js.`,
      );
    }
    const current = await this.getChatLabels(chatId, labels);
    const currentNames = current.map((label) => label.name.trim().toLocaleLowerCase('pt-BR'));
    if (target === 'BOT' && currentNames.includes('clientes')) {
      throw new Error('Contato está na lista Clientes; remova essa etiqueta antes de ativar o bot.');
    }
    const managedIds = new Set(
      labels.filter((label) => MANAGED_LABELS.some((name) => name.toLocaleLowerCase('pt-BR') === label.name.trim().toLocaleLowerCase('pt-BR'))).map((label) => label.id),
    );
    const desired = new Set(required.map((name) => findLabel(name)!.id));
    for (const label of current) {
      if (!managedIds.has(label.id) || label.id === findLabel('Clientes')?.id) continue;
      if (desired.has(label.id)) continue;
      await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/labels/chat/${encodeURIComponent(chatId)}/${encodeURIComponent(label.id)}`, { method: 'DELETE' });
    }
    const currentIds = new Set(current.map((label) => label.id));
    for (const labelId of desired) {
      if (currentIds.has(labelId)) continue;
      await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/labels/chat/${encodeURIComponent(chatId)}`, {
        method: 'POST',
        body: JSON.stringify({ labelId }),
      });
    }
  }

  private async getContactLabelNames(jid: string): Promise<string[]> {
    const labels = await this.getLabels();
    const current = await this.getChatLabels(toOpenwaChatId(jid), labels);
    return current.map((label) => label.name).filter(Boolean);
  }

  private async getLabels(): Promise<RemoteLabel[]> {
    const value = await this.requestJson(`/sessions/${encodeURIComponent(this.sessionId)}/labels`);
    return extractLabels(value);
  }

  private async getChatLabels(chatId: string, labels: RemoteLabel[]): Promise<RemoteLabel[]> {
    const value = await this.requestJson(
      `/sessions/${encodeURIComponent(this.sessionId)}/labels/chat/${encodeURIComponent(chatId)}`,
    );
    return extractLabels(value).map((label) => ({
      id: label.id,
      name: label.name || labels.find((candidate) => candidate.id === label.id)?.name || '',
    }));
  }

  private async renameContact(jid: string, name: string): Promise<void> {
    const cleaned = name.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!cleaned) return;
    const parts = cleaned.split(' ');
    const firstName = parts.shift() ?? cleaned;
    await this.requestJson(
      `/sessions/${encodeURIComponent(this.sessionId)}/contacts/${encodeURIComponent(toOpenwaChatId(jid))}`,
      { method: 'PUT', body: JSON.stringify({ firstName, lastName: parts.join(' ') }) },
    );
  }

  private async handleWebhook(value: unknown): Promise<void> {
    const envelope = asObject(value);
    if (!envelope) throw new Error('Evento OpenWA inválido: envelope ausente.');
    const sessionId = getText(envelope.sessionId);
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
    if (getText(envelope.event) !== 'message.received') return;
    const data = asObject(envelope.data);
    if (!data) return;
    await this.receiveMessage(data);
  }

  private async receiveMessage(data: JsonObject): Promise<void> {
    if (data.fromMe === true || data.fromMe === 'true') return;
    const rawChatId = getText(data.chatId ?? data.from);
    const jid = normalizeOpenwaJid(rawChatId);
    const messageId = getText(data.id);
    const kind = getText(data.kind).toLowerCase();
    if (!jid || !messageId) return;
    if (data.isGroup === true || kind === 'group' || jid.endsWith('@g.us')) return;
    if (jid === 'status@broadcast' || kind === 'status' || kind === 'broadcast') return;

    const type = getText(data.type).toLowerCase();
    const media = asObject(data.media);
    const mimeType = getText(media?.mimetype ?? media?.mimeType).split(';')[0]!.trim().toLowerCase();
    const isAudio = AUDIO_TYPES.has(type) || mimeType.startsWith('audio/');
    const createdAt = toEpochMs(getNumber(data.timestamp, Date.now() / 1000));

    if (isAudio) {
      let mediaPath: string | null = null;
      try {
        mediaPath = await this.storeAudio(data, media, mimeType, rawChatId, messageId);
      } catch (error) {
        this.logger.warn({ error: safeError(error) }, 'Não foi possível obter um áudio recebido pelo OpenWA');
      }
      await this.callbacks.onIncoming({
        key: `${jid}:${messageId}`,
        jid,
        kind: 'audio',
        body: null,
        mediaPath,
        createdAt,
      });
      return;
    }

    if (!TEXT_TYPES.has(type || 'text') && type) return;
    const body = getText(data.body);
    if (!body) return;
    await this.callbacks.onIncoming({
      key: `${jid}:${messageId}`,
      jid,
      kind: 'text',
      body,
      mediaPath: null,
      createdAt,
    });
  }

  private async storeAudio(
    data: JsonObject,
    media: JsonObject | null,
    mimeType: string,
    chatId: string,
    messageId: string,
  ): Promise<string | null> {
    const extension = AUDIO_EXTENSIONS[mimeType] ?? '.ogg';
    const inline = getText(media?.data);
    if (inline) {
      const bytes = Buffer.from(inline, 'base64');
      if (bytes.byteLength > this.config.assistant.maxAudioBytes) {
        this.logger.warn({ bytes: bytes.byteLength }, 'Áudio excede o limite configurado');
        return null;
      }
      const mediaPath = join(this.config.mediaDir, `${randomUUID()}${extension}`);
      await writeFile(mediaPath, bytes, { mode: 0o600, flag: 'wx' });
      return mediaPath;
    }
    if (media?.omitted !== true && !getText(media?.data)) {
      this.logger.warn({ mimeType }, 'Áudio recebido sem conteúdo disponível no webhook');
      return null;
    }
    const path = `/sessions/${encodeURIComponent(this.sessionId)}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`;
    const response = await this.request(path, { headers: { Accept: 'audio/*' } });
    if (!response.ok) throw new OpenwaApiError(`OpenWA respondeu HTTP ${response.status} ao baixar áudio.`, response.status, undefined, 60_000);
    const announced = Number(response.headers.get('content-length') ?? 0);
    if (announced > this.config.assistant.maxAudioBytes) {
      this.logger.warn({ bytes: announced }, 'Áudio excede o limite configurado');
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
    const mediaPath = join(this.config.mediaDir, `${randomUUID()}${extension}`);
    await writeFile(mediaPath, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), { mode: 0o600, flag: 'wx' });
    return mediaPath;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(`${this.apiBase}${path}`);
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', this.config.openwaApiKey);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    headers.set('Accept', headers.get('Accept') ?? 'application/json');
    return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let code: string | undefined;
      try {
        const parsed = asObject(JSON.parse(body) as unknown);
        code = getText(parsed?.code) || undefined;
      } catch {
        code = undefined;
      }
      throw new OpenwaApiError(
        `OpenWA respondeu HTTP ${response.status}.`,
        response.status,
        code,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`OpenWA retornou uma resposta inválida (HTTP ${response.status}).`);
    }
  }
}

function extractLabels(value: unknown): RemoteLabel[] {
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((item) => {
    const label = asObject(item);
    const id = getText(label?.id);
    if (!id) return [];
    return [{ id, name: getText(label?.name) }];
  });
}

function mapState(state: string): string {
  switch (state) {
    case 'ready': return 'WORKING';
    case 'qr_ready': return 'SCAN_QR_CODE';
    case 'initializing':
    case 'authenticating': return 'STARTING';
    case 'failed':
    case 'action_required': return 'FAILED';
    case 'disconnected': return 'DISCONNECTED';
    default: return 'STOPPED';
  }
}

function toEpochMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}
function getText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function getNumber(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}
function parseRetryAfter(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(24 * 60 * 60 * 1000, Math.ceil(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1_000, Math.min(24 * 60 * 60 * 1000, date - Date.now())) : 60_000;
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function safeError(error: unknown): string {
  if (error instanceof OpenwaApiError) return `OpenWA HTTP ${error.status}`;
  return error instanceof Error ? error.name : 'Falha desconhecida';
}
