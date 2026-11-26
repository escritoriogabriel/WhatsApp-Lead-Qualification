import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { RuntimeConfig } from './config.js';
import type { IncomingMessage } from './database.js';
import { ProviderRetryAfterError, SendOutcomeUnknownError } from './provider-errors.js';
import type { WhatsAppCallbacks, WhatsAppConnection } from './whatsapp.js';

interface JsonObject { [key: string]: unknown }

export async function connectMetaCloudApi(
  config: RuntimeConfig,
  logger: Logger,
  callbacks: WhatsAppCallbacks,
): Promise<WhatsAppConnection> {
  const adapter = new MetaCloudApiAdapter(config, logger, callbacks);
  return adapter.connection();
}

export function validMetaSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !appSecret) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const supplied = Buffer.from(signature.slice('sha256='.length), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

class MetaCloudApiAdapter {
  private readonly graphRoot: string;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly logger: Logger,
    private readonly callbacks: WhatsAppCallbacks,
  ) {
    if (!/^\d{5,30}$/.test(config.metaPhoneNumberId)) throw new Error('META_PHONE_NUMBER_ID precisa conter somente dígitos.');
    if (!/^v\d+\.\d+$/.test(config.metaGraphApiVersion)) throw new Error('META_GRAPH_API_VERSION deve ter o formato vN.N.');
    this.graphRoot = `https://graph.facebook.com/${config.metaGraphApiVersion}`;
  }

  connection(): WhatsAppConnection {
    return {
      sendText: (jid, text) => this.sendText(jid, text),
      setContactAssignment: async () => undefined,
      renameContact: async () => undefined,
      handleWebhook: (body) => this.handleWebhook(body),
      getStatus: async () => ({ provider: 'meta', state: 'CONFIGURED', connected: true }),
      // The Cloud API has no paired device to stop from this application.
      close: async () => undefined,
    };
  }

  private async sendText(jid: string, text: string): Promise<void> {
    const to = jid.replace(/@(?:s\.whatsapp\.net|c\.us|lid)$/i, '').replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(to)) throw new Error('O identificador do contato não é um telefone válido para a Cloud API.');
    let response: Response;
    try {
      response = await fetch(`${this.graphRoot}/${encodeURIComponent(this.config.metaPhoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.metaAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new SendOutcomeUnknownError();
    }
    if (response.status === 429) throw new ProviderRetryAfterError(parseRetryAfter(response.headers.get('retry-after')));
    if (response.status >= 500) throw new SendOutcomeUnknownError();
    if (!response.ok) throw new Error(`Meta Cloud API recusou o envio (HTTP ${response.status}).`);
    let body: JsonObject;
    try { body = await response.json() as JsonObject; }
    catch { throw new SendOutcomeUnknownError(); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length || typeof (messages[0] as JsonObject | undefined)?.id !== 'string') throw new SendOutcomeUnknownError();
  }

  private async handleWebhook(value: unknown): Promise<void> {
    const envelope = asObject(value);
    if (!envelope || envelope.object !== 'whatsapp_business_account' || !Array.isArray(envelope.entry)) {
      throw new Error('Webhook Meta inválido.');
    }
    for (const rawEntry of envelope.entry) {
      const entry = asObject(rawEntry);
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const rawChange of changes) {
        const change = asObject(rawChange);
        const valueObject = asObject(change?.value);
        const messages = Array.isArray(valueObject?.messages) ? valueObject.messages : [];
        for (const rawMessage of messages) {
          const message = asObject(rawMessage);
          const id = getText(message?.id);
          const from = getText(message?.from).replace(/\D/g, '');
          if (!id || !/^\d{10,15}$/.test(from)) continue;
          const jid = `${from}@s.whatsapp.net`;
          const type = getText(message?.type);
          const text = asObject(message?.text);
          let incoming: IncomingMessage;
          if (type === 'text' && typeof text?.body === 'string' && text.body.trim()) {
            incoming = { key: `${jid}:${id}`, jid, kind: 'text', body: text.body, mediaPath: null, createdAt: timestampMillis(message?.timestamp) };
          } else if (type === 'audio') {
            const media = asObject(message?.audio);
            let mediaPath: string | null = null;
            if (this.config.assistant.audioTranscriptionProvider === 'gemini') {
              try { mediaPath = await this.downloadAudio(getText(media?.id)); }
              catch { this.logger.warn('Falha ao baixar áudio do webhook Meta; a equipe deverá revisar a conversa.'); }
            }
            incoming = { key: `${jid}:${id}`, jid, kind: 'audio', body: null, mediaPath, createdAt: timestampMillis(message?.timestamp) };
          } else {
            this.logger.info({ messageType: type || 'unknown' }, 'Tipo de mensagem Meta não incluído na triagem');
            continue;
          }
          // The callback must persist and enqueue before the webhook is acknowledged.
          await this.callbacks.onIncoming(incoming);
        }
      }
    }
  }

  private async downloadAudio(mediaId: string): Promise<string | null> {
    if (!mediaId) return null;
    const metadata = await this.graphRequest(`${this.graphRoot}/${encodeURIComponent(mediaId)}`);
    const url = getText(metadata.url);
    if (!url) return null;
    const mediaUrl = new URL(url);
    if (mediaUrl.protocol !== 'https:' || !['graph.facebook.com', 'lookaside.fbsbx.com'].includes(mediaUrl.hostname) && !mediaUrl.hostname.endsWith('.fbcdn.net') && !mediaUrl.hostname.endsWith('.fbsbx.com')) return null;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.metaAccessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body) return null;
    const announcedSize = Number(response.headers.get('content-length') ?? 0);
    if (announcedSize > this.config.assistant.maxAudioBytes) return null;
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
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (size === 0) return null;
    const path = join(this.config.mediaDir, `${randomUUID()}.ogg`);
    await writeFile(path, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), { mode: 0o600, flag: 'wx' });
    return path;
  }

  private async graphRequest(url: string): Promise<JsonObject> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.metaAccessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Meta Cloud API falhou ao obter metadados de mídia (HTTP ${response.status}).`);
    return asObject(await response.json()) ?? {};
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function getText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function timestampMillis(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}
function parseRetryAfter(value: string | null): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 60_000;
}
