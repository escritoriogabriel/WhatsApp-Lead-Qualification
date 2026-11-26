import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pino } from 'pino';
import { ProviderRetryAfterError, SendOutcomeUnknownError } from './provider-errors.js';
import type { RuntimeConfig } from './config.js';
import type { WhatsAppCallbacks } from './whatsapp.js';
import { connectWaha, normalizeWahaJid, toWahaChatId } from './waha.js';

test('WAHA session supports the bot queue, labels, contact updates, and WhatsApp chat IDs', async (context) => {
  let session: Record<string, unknown> | null = null;
  let labels = [
    { id: '1', name: 'Novo Lead', color: 7 },
    { id: '10', name: 'VIP', color: 3 },
  ];
  let chatLabels = [{ id: '1', name: 'Novo Lead', color: 7 }, { id: '10', name: 'VIP', color: 3 }];
  let contactUpdate: Record<string, unknown> | null = null;
  let sentMessage: Record<string, unknown> | null = null;
  let sendFailure: { status: number; retryAfter?: string } | null = null;
  const typingEvents: Array<{ path: string; body: Record<string, unknown> }> = [];
  const incoming: Array<Record<string, unknown>> = [];
  const labelEvents: Array<Record<string, unknown>> = [];
  const associationEvents: Array<Record<string, unknown>> = [];

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers['x-api-key'] !== 'test-api-key') {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};

    if (request.method === 'GET' && path === '/api/sessions/triagem') {
      if (!session) { response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' })); return; }
      response.end(JSON.stringify(session));
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions') {
      session = { name: body.name, status: 'WORKING', engine: 'GOWS', config: body.config };
      response.statusCode = 201;
      response.end(JSON.stringify(session));
      return;
    }
    if (request.method === 'PUT' && path === '/api/sessions/triagem') {
      session = { ...session, config: body.config };
      response.end(JSON.stringify(session));
      return;
    }
    if (request.method === 'GET' && path === '/api/triagem/labels') {
      response.end(JSON.stringify(labels));
      return;
    }
    if (request.method === 'POST' && path === '/api/triagem/labels') {
      const created = { id: '12', name: String(body.name), color: Number(body.color) };
      labels = [...labels, created];
      response.statusCode = 201;
      response.end(JSON.stringify(created));
      return;
    }
    if (path.startsWith('/api/triagem/labels/chats/')) {
      if (request.method === 'GET') { response.end(JSON.stringify(chatLabels)); return; }
      if (request.method === 'PUT') {
        const ids = Array.isArray(body.labels) ? body.labels.map((item) => String((item as Record<string, unknown>).id)) : [];
        chatLabels = labels.filter((label) => ids.includes(label.id));
        response.end(JSON.stringify(chatLabels));
        return;
      }
    }
    if (request.method === 'PUT' && path.startsWith('/api/triagem/contacts/')) {
      contactUpdate = body;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === 'POST' && path === '/api/sendText') {
      if (sendFailure) {
        response.statusCode = sendFailure.status;
        if (sendFailure.retryAfter) response.setHeader('Retry-After', sendFailure.retryAfter);
        response.end(JSON.stringify({ error: 'test failure' }));
        return;
      }
      sentMessage = body;
      response.end(JSON.stringify({ id: 'outgoing-1' }));
      return;
    }
    if (request.method === 'POST' && ['/api/startTyping', '/api/stopTyping'].includes(path)) {
      typingEvents.push({ path, body });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === 'GET' && path === '/api/files/voice-1') {
      response.setHeader('Content-Type', 'audio/ogg');
      response.end(Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x01]));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: `unexpected ${request.method} ${path}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const mediaDir = await mkdtemp(join(tmpdir(), 'waha-test-'));
  context.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(mediaDir, { recursive: true, force: true });
  });
  const address = server.address() as AddressInfo;
  const runtime = {
    wahaApiUrl: `http://127.0.0.1:${address.port}`,
    wahaApiKey: 'test-api-key',
    wahaSession: 'triagem',
    wahaWebhookUrl: 'http://127.0.0.1:3000/api/waha/webhook',
    wahaWebhookSecret: 'test-webhook-secret',
    mediaDir,
    assistant: { simulateTyping: false, typingSecondsPerCharacter: 0, maxAudioBytes: 2_000_000 },
  } as unknown as RuntimeConfig;
  const callbacks: WhatsAppCallbacks = {
    onIncoming: (message) => { incoming.push(message as unknown as Record<string, unknown>); },
    onLabelEdit: (label) => { labelEvents.push({ ...label }); },
    onLabelAssociation: (association, add) => { associationEvents.push({ ...association, add }); },
    getLabelId: () => undefined,
  };

  const whatsapp = await connectWaha(runtime, pino({ level: 'silent' }), callbacks);
  assert.equal((await whatsapp.getStatus?.())?.connected, true);
  assert.equal((await whatsapp.getStatus?.())?.engine, 'GOWS');

  await whatsapp.setContactAssignment('15551234567@s.whatsapp.net', 'BOT');
  assert.deepEqual(chatLabels.map((label) => label.name).sort(), ['Bot - atendimento', 'VIP']);
  assert.equal(await whatsapp.getContactAssignment?.('15551234567@s.whatsapp.net'), 'BOT');
  await whatsapp.renameContact('15551234567@s.whatsapp.net', 'Ana Maria Silva');
  assert.deepEqual(contactUpdate, { firstName: 'Ana', lastName: 'Maria Silva' });
  await whatsapp.sendText('15551234567@s.whatsapp.net', 'Olá');
  assert.deepEqual(sentMessage, { session: 'triagem', chatId: '15551234567@c.us', text: 'Olá' });
  await whatsapp.setTyping?.('15551234567@s.whatsapp.net', true);
  await whatsapp.setTyping?.('15551234567@s.whatsapp.net', false);
  assert.deepEqual(typingEvents.map((item) => item.path), ['/api/startTyping', '/api/stopTyping']);
  sendFailure = { status: 429, retryAfter: '3' };
  await assert.rejects(whatsapp.sendText('15551234567@s.whatsapp.net', 'limite'), (error: unknown) => error instanceof ProviderRetryAfterError && error.retryAfterMs === 3_000);
  sendFailure = { status: 503 };
  await assert.rejects(whatsapp.sendText('15551234567@s.whatsapp.net', 'resultado incerto'), SendOutcomeUnknownError);
  sendFailure = null;

  await whatsapp.handleWebhook?.({
    event: 'message',
    session: 'triagem',
    payload: { id: 'message-1', from: '15551234567@c.us', fromMe: false, body: 'Bom dia', timestamp: 1_750_000_000 },
  });
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]?.jid, '15551234567@s.whatsapp.net');
  assert.equal(incoming[0]?.key, '15551234567@s.whatsapp.net:message-1');
  assert.equal(incoming[0]?.createdAt, 1_750_000_000_000);
  await whatsapp.handleWebhook?.({
    event: 'message',
    session: 'triagem',
    payload: {
      id: 'voice-1', from: '15551234567@c.us', fromMe: false, timestamp: 1_750_000_001,
      media: { mimetype: 'audio/ogg; codecs=opus', url: `http://127.0.0.1:${address.port}/api/files/voice-1` },
    },
  });
  assert.equal(incoming[1]?.kind, 'audio');
  assert.ok(typeof incoming[1]?.mediaPath === 'string');
  assert.deepEqual(await readFile(String(incoming[1]?.mediaPath)), Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x01]));

  await whatsapp.handleWebhook?.({
    event: 'label.chat.added',
    session: 'triagem',
    payload: { chatId: '15551234567@c.us', labelId: '10' },
  });
  assert.equal(associationEvents.at(-1)?.chatId, '15551234567@s.whatsapp.net');
  assert.equal(associationEvents.at(-1)?.add, true);
  assert.ok(labelEvents.some((label) => label.name === 'VIP'));

  assert.equal(normalizeWahaJid('15551234567@c.us'), '15551234567@s.whatsapp.net');
  assert.equal(toWahaChatId('15551234567@s.whatsapp.net'), '15551234567@c.us');
  await whatsapp.close();
});
