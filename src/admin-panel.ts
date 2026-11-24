import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { validateAssistantConfig, type AssistantConfig } from './config.js';

interface PanelOptions {
  configPath: string;
  revisionsDir?: string;
  host: string;
  port: number;
  password: string;
  getConfig: () => AssistantConfig;
  setConfig: (config: AssistantConfig) => void;
  logger: Logger;
}

const MAX_BODY_BYTES = 300_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

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
        if (request.method === 'GET' && url.pathname === '/api/config') {
          sendJson(response, 200, options.getConfig());
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
          await saveRevision(options.configPath, revisionsDir);
          await atomicWrite(options.configPath, JSON.stringify(candidate, null, 2) + '\n');
          options.setConfig(candidate);
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
          await saveRevision(options.configPath, revisionsDir);
          await atomicWrite(options.configPath, JSON.stringify(restored, null, 2) + '\n');
          options.setConfig(restored);
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
      const relativePath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
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
      const message = error instanceof Error ? error.message : 'Erro interno';
      options.logger.error({ error: message }, 'Admin panel request failed');
      if (!response.headersSent) sendJson(response, 400, { error: message });
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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('Corpo da requisição excede o limite.');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON inválido.');
  return value as Record<string, unknown>;
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
