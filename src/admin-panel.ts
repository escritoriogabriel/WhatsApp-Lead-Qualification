import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import busboy from 'busboy';
import yauzl from 'yauzl';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ConfigValidationError, validateAssistantConfig, type AssistantConfig } from './config.js';
import { AgentDatabase } from './database.js';
import type { WhatsAppStatus } from './whatsapp.js';
import { validMetaSignature } from './meta.js';
import { validOpenwaSignature } from './openwa.js';

interface PanelOptions {
  configPath: string;
  revisionsDir?: string;
  host: string;
  port: number;
  password: string;
  getConfig: () => AssistantConfig;
  getAiModels?: () => { ollama: string; gemini: string };
  setConfig: (config: AssistantConfig) => Promise<void> | void;
  database: AgentDatabase;
  getWhatsAppStatus: () => Promise<WhatsAppStatus>;
  getWhatsAppQr: () => Promise<Buffer | null>;
  restartWhatsApp: () => Promise<void>;
  handleWahaWebhook?: (body: unknown) => Promise<void>;
  wahaWebhookSecret?: string;
  handleOpenwaWebhook?: (body: unknown) => Promise<void>;
  openwaWebhookSecret?: string;
  handleMetaWebhook?: (body: unknown) => Promise<void>;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  logger: Logger;
}

const MAX_BODY_BYTES = 300_000;
const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 25 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

class PayloadTooLargeError extends Error {}
class InvalidRequestError extends Error {}

export async function startAdminPanel(options: PanelOptions): Promise<() => Promise<void>> {
  const password = await resolvePanelPassword(options.password);
  const sessions = new Map<string, number>();
  const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
  const publicDir = resolve(process.cwd(), 'public');
  const revisionsDir = options.revisionsDir ?? resolve(process.cwd(), 'data', 'config-revisions');

  const server = createServer(async (request, response) => {
    addSecurityHeaders(response);
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/contacts' || url.pathname.startsWith('/api/contacts/')) {
        sendJson(response, 410, { error: 'A autorização e a classificação são controladas pelas listas do WhatsApp.' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/waha/webhook') {
        const suppliedSecret = request.headers['x-waha-webhook-secret'];
        if (!options.wahaWebhookSecret || !options.handleWahaWebhook || !safeEqual(Array.isArray(suppliedSecret) ? suppliedSecret[0] ?? '' : suppliedSecret ?? '', options.wahaWebhookSecret)) {
          sendJson(response, 401, { error: 'Webhook não autorizado.' });
          return;
        }
        const webhookBody = await readJson(request);
        try {
          await options.handleWahaWebhook(webhookBody);
        } catch (error) {
          options.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Falha ao processar webhook WAHA');
          sendJson(response, 500, { error: 'Falha ao processar evento WAHA; a entrega pode ser repetida.' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/openwa/webhook') {
        if (!options.handleOpenwaWebhook || !options.openwaWebhookSecret) {
          sendJson(response, 404, { error: 'Webhook OpenWA não está ativo.' });
          return;
        }
        // The HMAC is computed over the exact bytes received, before any parsing.
        const rawBody = await readRaw(request, 1_000_000);
        const signatureHeader = request.headers['x-openwa-signature'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (!validOpenwaSignature(rawBody, signature, options.openwaWebhookSecret)) {
          sendJson(response, 401, { error: 'Assinatura do webhook inválida.' });
          return;
        }
        let webhookBody: unknown;
        try { webhookBody = JSON.parse(rawBody.toString('utf8')) as unknown; }
        catch {
          sendJson(response, 400, { error: 'JSON de webhook inválido.' });
          return;
        }
        try {
          await options.handleOpenwaWebhook(webhookBody);
        } catch {
          options.logger.error('Falha ao processar evento do webhook OpenWA.');
          sendJson(response, 500, { error: 'Falha ao processar evento OpenWA; a entrega pode ser repetida.' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/meta/webhook' && request.method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token') ?? '';
        const challenge = url.searchParams.get('hub.challenge');
        if (mode !== 'subscribe' || !challenge || !options.metaWebhookVerifyToken ||
          !safeEqual(token, options.metaWebhookVerifyToken)) {
          response.statusCode = 403;
          response.end('Webhook verification failed.');
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(challenge);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/meta/webhook') {
        if (!options.handleMetaWebhook || !options.metaAppSecret) {
          sendJson(response, 404, { error: 'Webhook Meta não está ativo.' });
          return;
        }
        const rawBody = await readRaw(request, 1_000_000);
        const signatureHeader = request.headers['x-hub-signature-256'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (!validMetaSignature(rawBody, signature, options.metaAppSecret)) {
          sendJson(response, 401, { error: 'Assinatura do webhook inválida.' });
          return;
        }
        let webhookBody: unknown;
        try { webhookBody = JSON.parse(rawBody.toString('utf8')) as unknown; }
        catch {
          sendJson(response, 400, { error: 'JSON de webhook inválido.' });
          return;
        }
        try {
          await options.handleMetaWebhook(webhookBody);
        } catch {
          options.logger.error('Falha ao persistir evento do webhook Meta.');
          sendJson(response, 500, { error: 'Falha ao persistir evento Meta; a entrega pode ser repetida.' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        const forwardedHeader = request.headers['x-forwarded-for'];
        const forwardedAddress = (Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader)
          ?.split(',')[0]
          ?.trim();
        const address = forwardedAddress || request.socket.remoteAddress || 'unknown';
        const storedAttempts = loginAttempts.get(address);
        const attempts = storedAttempts && storedAttempts.lockedUntil > Date.now() ? storedAttempts : undefined;
        if (attempts && attempts.lockedUntil > Date.now()) {
          sendJson(response, 429, { error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
          return;
        }
        const body = await readJson(request);
        if (!safeEqual(String(body.password ?? ''), password)) {
          const count = (attempts?.count ?? 0) + 1;
          loginAttempts.set(address, { count, lockedUntil: count >= 6 ? Date.now() + 10 * 60 * 1000 : 0 });
          sendJson(response, 401, { error: 'Senha incorreta.' });
          return;
        }
        loginAttempts.delete(address);
        for (const [token, expiresAt] of sessions) if (expiresAt < Date.now()) sessions.delete(token);
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        const secure = request.headers['x-forwarded-proto'] === 'https';
        response.setHeader('Set-Cookie', `agent_panel=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/session') {
        sendJson(response, 200, { authenticated: sessionToken(request, sessions) !== null });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/logout') {
        const token = sessionToken(request, sessions);
        if (token) sessions.delete(token);
        response.setHeader('Set-Cookie', 'agent_panel=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!sessionToken(request, sessions)) {
          sendJson(response, 401, { error: 'Sessão encerrada. Entre novamente.' });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/whatsapp/status') {
          sendJson(response, 200, await options.getWhatsAppStatus());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/whatsapp/qr') {
          const qr = await options.getWhatsAppQr();
          if (!qr) {
            sendJson(response, 409, { error: 'QR não disponível. Atualize o estado da sessão e tente novamente.' });
            return;
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'image/png');
          response.setHeader('Cache-Control', 'no-store');
          response.end(qr);
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/whatsapp/restart') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Origem da requisição inválida.' });
            return;
          }
          await options.restartWhatsApp();
          sendJson(response, 200, { ok: true });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/config') {
          sendJson(response, 200, options.getConfig());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/ai/models') {
          sendJson(response, 200, options.getAiModels?.() ?? { ollama: 'configurado no ambiente', gemini: 'configurado no ambiente' });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/conversations/import') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Origem da requisição inválida.' });
            return;
          }
          const uploads = await readUploads(request);
          const samples = [...options.getConfig().conversationStyleSamples];
          const results: Array<{ file: string; ok: boolean; detail: string }> = [];
          let totalCharacters = samples.reduce((sum, item) => sum + item.content.length, 0);
          for (const upload of uploads) {
            try {
              if (upload.tooLarge) throw new Error('Arquivo maior que o limite de 15 MB.');
              if (!['.txt', '.md', '.markdown'].includes(extname(upload.filename).toLowerCase())) throw new Error('Envie um arquivo TXT ou Markdown exportado da conversa.');
              const content = new TextDecoder('utf-8').decode(upload.buffer).replaceAll('\u0000', '').trim();
              if (!content) throw new Error('Nenhum texto legível foi encontrado.');
              if (samples.length >= 10) throw new Error('Limite de 10 exemplos de conversa atingido. Remova um exemplo antes de importar outro.');
              if (content.length > 12_000 || totalCharacters + content.length > 30_000) throw new Error('Os exemplos aceitam até 12.000 caracteres por arquivo e 30.000 no conjunto.');
              samples.push({ title: basenameSafe(upload.filename).slice(0, 160), content });
              totalCharacters += content.length;
              results.push({ file: upload.filename, ok: true, detail: 'Exemplo de estilo importado; nomes e fatos continuam sendo tratados como dados não confiáveis.' });
            } catch (error) { results.push({ file: upload.filename, ok: false, detail: error instanceof Error ? error.message : 'Falha ao importar exemplo.' }); }
          }
          if (samples.length !== options.getConfig().conversationStyleSamples.length) {
            const candidate = validateAssistantConfig({ ...options.getConfig(), conversationStyleSamples: samples });
            await saveRevision(options.configPath, revisionsDir);
            await atomicWrite(options.configPath, JSON.stringify(candidate, null, 2) + '\n');
            await options.setConfig(candidate);
          }
          sendJson(response, 200, { imported: results.filter((item) => item.ok).length, results });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/materials/import') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Origem da requisição inválida.' });
            return;
          }
          const uploads = await readUploads(request);
          const materials = [...options.getConfig().materials];
          const results: Array<{ file: string; ok: boolean; detail: string }> = [];
          let totalCharacters = materials.reduce((sum, item) => sum + item.content.length, 0);
          for (const upload of uploads) {
            try {
              const documents = upload.tooLarge
                ? []
                : extname(upload.filename).toLowerCase() === '.zip'
                  ? await extractZipDocuments(upload.buffer)
                  : [{ filename: upload.filename, buffer: upload.buffer }];
              if (upload.tooLarge) throw new Error('Arquivo maior que o limite de 15 MB.');
              if (documents.length === 0) throw new Error('O arquivo não contém documentos em formatos compatíveis.');
              let imported = 0;
              const problems: string[] = [];
              for (const document of documents) {
                try {
                  if (document.problem) throw new Error(document.problem);
                  if (materials.length >= 20) throw new Error('Limite de 20 materiais atingido.');
                  const content = await extractDocumentText(document.filename, document.buffer);
                  const remaining = 20_000 - totalCharacters;
                  if (content.length > remaining) throw new Error('O limite conjunto de 20.000 caracteres seria excedido. Remova materiais antigos ou reduza os arquivos.');
                  if (!content.trim()) throw new Error('Nenhum texto legível foi encontrado. PDFs digitalizados precisam de OCR.');
                  materials.push({ title: basenameSafe(document.filename).slice(0, 160), content });
                  totalCharacters += content.length;
                  imported += 1;
                } catch (error) {
                  problems.push(`${document.filename}: ${error instanceof Error ? error.message : 'falha ao ler'}`);
                }
              }
              results.push({ file: upload.filename, ok: imported > 0, detail: `${imported} material(is) importado(s)${problems.length ? `; ${problems.join('; ')}` : ''}` });
            } catch (error) {
              results.push({ file: upload.filename, ok: false, detail: error instanceof Error ? error.message : 'Falha ao importar arquivo.' });
            }
          }
          if (materials.length !== options.getConfig().materials.length) {
            const candidate = validateAssistantConfig({ ...options.getConfig(), materials });
            await saveRevision(options.configPath, revisionsDir);
            await atomicWrite(options.configPath, JSON.stringify(candidate, null, 2) + '\n');
            await options.setConfig(candidate);
          }
          sendJson(response, 200, { imported: results.filter((item) => item.ok).length, results });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
          sendJson(response, 200, options.database.listDiagnostics());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/revisions') {
          await mkdir(revisionsDir, { recursive: true, mode: 0o700 });
          const files = (await readdir(revisionsDir)).filter((file) => file.endsWith('.json')).sort().reverse();
          sendJson(response, 200, files.slice(0, 20));
          return;
        }
        if (request.method === 'PUT' && url.pathname === '/api/config') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Origem da requisição inválida.' });
            return;
          }
          const candidate = validateAssistantConfig(await readJson(request));
          const previous = options.getConfig();
          await options.setConfig(candidate);
          try {
            await saveRevision(options.configPath, revisionsDir);
            await atomicWrite(options.configPath, JSON.stringify(candidate, null, 2) + '\n');
          } catch (error) {
            await options.setConfig(previous);
            throw error;
          }
          sendJson(response, 200, { ok: true, savedAt: new Date().toISOString() });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/restore-last') {
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Origem da requisição inválida.' });
            return;
          }
          const files = (await readdir(revisionsDir).catch(() => [])).filter((file) => file.endsWith('.json')).sort().reverse();
          const latest = files[0];
          if (!latest) {
            sendJson(response, 404, { error: 'Ainda não há versão anterior salva.' });
            return;
          }
          const restored = validateAssistantConfig(JSON.parse(await readFile(join(revisionsDir, latest), 'utf8')));
          const previous = options.getConfig();
          await options.setConfig(restored);
          try {
            await saveRevision(options.configPath, revisionsDir);
            await atomicWrite(options.configPath, JSON.stringify(restored, null, 2) + '\n');
          } catch (error) {
            await options.setConfig(previous);
            throw error;
          }
          sendJson(response, 200, { ok: true, revision: latest });
          return;
        }
        sendJson(response, 404, { error: 'Rota não encontrada.' });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'Método não permitido.' });
        return;
      }
      const relativePath = url.pathname === '/'
        ? 'index.html'
        : url.pathname === '/favicon.ico'
          ? 'favicon.svg'
          : decodeURIComponent(url.pathname.slice(1));
      const filePath = resolve(publicDir, relativePath);
      if (!filePath.startsWith(publicDir + '\\') && !filePath.startsWith(publicDir + '/')) {
        sendJson(response, 403, { error: 'Acesso negado.' });
        return;
      }
      const content = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader('Content-Type', mimeType(extname(filePath)));
      response.setHeader('Cache-Control', 'no-store');
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: 'Corpo da requisição excede o limite permitido.' });
        return;
      }
      if (error instanceof InvalidRequestError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : 'Erro interno';
      options.logger.error({ error: message }, 'Admin panel request failed');
      const details = error instanceof z.ZodError
        ? error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message, fix: validationFix(issue.message) }))
        : error instanceof ConfigValidationError ? [{ path: error.path, message: error.message, fix: error.fix }] : [];
      if (!response.headersSent) sendJson(response, 400, { error: message, details });
      else response.destroy();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  options.logger.info({ host: options.host, port: options.port }, 'Painel de configuração disponível');
  return () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

interface UploadFile { filename: string; buffer: Buffer; tooLarge: boolean }
interface ZipDocument { filename: string; buffer: Buffer; problem?: string }

function readUploads(request: IncomingMessage): Promise<UploadFile[]> {
  return new Promise((resolvePromise, reject) => {
    let totalBytes = 0;
    let totalLimitReached = false;
    const uploads: Promise<UploadFile>[] = [];
    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({ headers: request.headers, limits: { files: 20, fileSize: MAX_UPLOAD_FILE_BYTES, fields: 0, parts: 20 } });
    } catch (error) { reject(error); return; }
    parser.on('file', (_field, stream, info) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        totalBytes += chunk.length;
        if (size > MAX_UPLOAD_FILE_BYTES || totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          tooLarge = true;
          if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) totalLimitReached = true;
        } else if (!totalLimitReached) chunks.push(chunk);
      });
      stream.on('limit', () => { tooLarge = true; });
      uploads.push(new Promise((resolveFile, rejectFile) => {
        stream.on('error', rejectFile);
        stream.on('end', () => resolveFile({ filename: basename(info.filename || 'arquivo'), buffer: Buffer.concat(chunks), tooLarge: tooLarge || totalLimitReached }));
      }));
    });
    parser.once('error', reject);
    parser.once('close', () => {
      void Promise.all(uploads).then(resolvePromise, reject);
    });
    request.once('error', reject);
    request.pipe(parser);
  });
}

async function extractZipDocuments(buffer: Buffer): Promise<ZipDocument[]> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('Arquivo ZIP inválido.')); return; }
      const documents: ZipDocument[] = [];
      let count = 0;
      let expandedBytes = 0;
      let settled = false;
      const fail = (reason: Error) => { if (!settled) { settled = true; zip.close(); reject(reason); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolvePromise(documents); } });
      zip.on('entry', (entry) => {
        count += 1;
        if (count > 40) { fail(new Error('O ZIP contém mais de 40 arquivos.')); return; }
        const extension = extname(entry.fileName).toLowerCase();
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        const filename = entry.fileName.replaceAll('\\', '/').split('/').at(-1) || entry.fileName;
        if (!isSupportedMaterialExtension(extension)) {
          documents.push({ filename, buffer: Buffer.alloc(0), problem: 'Formato interno não compatível.' });
          zip.readEntry(); return;
        }
        if ((entry.generalPurposeBitFlag & 1) !== 0) {
          documents.push({ filename, buffer: Buffer.alloc(0), problem: 'Arquivo ZIP protegido por senha não pode ser lido.' });
          zip.readEntry(); return;
        }
        if (entry.uncompressedSize > 10 * 1024 * 1024 || expandedBytes + entry.uncompressedSize > 25 * 1024 * 1024) {
          documents.push({ filename, buffer: Buffer.alloc(0), problem: 'Arquivo descompactado excede o limite permitido.' });
          zip.readEntry(); return;
        }
        expandedBytes += entry.uncompressedSize;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError ?? new Error('Não foi possível abrir um arquivo do ZIP.')); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 10 * 1024 * 1024) { stream.destroy(new Error('Arquivo descompactado excedeu o limite.')); return; }
            chunks.push(chunk);
          });
          stream.once('error', fail);
          stream.once('end', () => {
            documents.push({ filename, buffer: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function isSupportedMaterialExtension(extension: string): boolean {
  return ['.pdf', '.txt', '.md', '.markdown', '.csv', '.json', '.docx'].includes(extension);
}

async function extractDocumentText(filename: string, buffer: Buffer): Promise<string> {
  const extension = extname(filename).toLowerCase();
  if (extension === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const text = await page.getTextContent();
        pages.push(text.items.map((item) => 'str' in item ? item.str : '').join(' '));
      }
      return pages.join('\n\n').trim();
    } finally { await document.destroy(); }
  }
  if (extension === '.docx') {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer })).value.trim();
  }
  if (!isSupportedMaterialExtension(extension)) throw new Error('Formato não aceito. Use PDF, TXT, MD, CSV, JSON ou DOCX.');
  const text = new TextDecoder('utf-8').decode(buffer).replaceAll('\u0000', '').trim();
  return text;
}

function basenameSafe(value: string): string {
  return basename(value.replaceAll('\\', '/'));
}

function validationFix(message: string): string {
  if (message.includes('Too small') || message.includes('too_small')) return 'Preencha este campo antes de salvar.';
  if (message.includes('Invalid input')) return 'Escolha um valor válido para este campo.';
  return 'Revise o valor informado.';
}

async function resolvePanelPassword(configuredPassword: string): Promise<string> {
  if (configuredPassword.trim()) {
    if (configuredPassword.length < 12) throw new Error('PANEL_PASSWORD precisa ter pelo menos 12 caracteres.');
    return configuredPassword;
  }
  const passwordFile = resolve(process.cwd(), 'data', 'panel-password');
  await mkdir(dirname(passwordFile), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(passwordFile, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // Generate a first-run password below.
  }
  const generated = randomBytes(24).toString('base64url');
  await writeFile(passwordFile, generated + '\n', { mode: 0o600, flag: 'wx' }).catch(async () => {
    await writeFile(passwordFile, generated + '\n', { mode: 0o600 });
  });
  return generated;
}

function sessionToken(request: IncomingMessage, sessions: Map<string, number>): string | null {
  const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith('agent_panel='));
  const token = cookie?.slice('agent_panel='.length);
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const expectedProtocol = request.headers['x-forwarded-proto'] ?? 'http';
    return parsed.host === request.headers.host && parsed.protocol === expectedProtocol + ':';
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse((await readRaw(request, MAX_BODY_BYTES)).toString('utf8')); }
  catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    throw new InvalidRequestError('JSON inválido.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidRequestError('JSON inválido.');
  return value as Record<string, unknown>;
}

async function readRaw(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new PayloadTooLargeError('Corpo da requisição excede o limite.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function saveRevision(configPath: string, revisionsDir: string): Promise<void> {
  await mkdir(revisionsDir, { recursive: true, mode: 0o700 });
  const current = await readFile(configPath, 'utf8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  await writeFile(join(revisionsDir, stamp + '.json'), current, { mode: 0o600 });
  const files = (await readdir(revisionsDir)).filter((file) => file.endsWith('.json')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 20))) await unlink(join(revisionsDir, old));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function addSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function mimeType(extension: string): string {
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
