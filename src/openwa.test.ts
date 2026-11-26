import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
import {
  connectOpenwa,
  normalizeOpenwaJid,
  openwaSignatureDigest,
  toOpenwaChatId,
  validOpenwaSignature,
} from './openwa.js';

test('OpenWA session resolves by name, registers its webhook, and drives the WhatsApp connection', async (context) => {
  let session: Record<string, unknown> | null = null;
  const registeredWebhooks: Array<Record<string, unknown>> = [];
  let labels = [
    { id: '1', name: 'Novo Lead', hexColor: '#FF9485' },
    { id: '2', name: 'Bot - atendimento', hexColor: '#25D366' },
    { id: '3', name: 'Atendimento', hexColor: '#FFD279' },
    { id: '4', name: 'Clientes', hexColor: '#00A5FF' },
    { id: '9', name: 'VIP', hexColor: '#000000' },
  ];
  let chatLabels = [{ id: '9', name: 'VIP', hexColor: '#000000' }];
  let sentMessage: Record<string, unknown> | null = null;
  let contactUpdate: Record<string, unknown> | null = null;
  let sendFailure: { status: number; retryAfter?: string } | null = null;
  const typingEvents: Array<Record<string, unknown>> = [];
  const incoming: Array<Record<string, unknown>> = [];
  const requests: Array<{ method: string; path: string; apiKey: string | string[] | undefined }> = [];

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);
    requests.push({ method: request.method ?? '', path, apiKey: request.headers['x-api-key'] });
    if (request.headers['x-api-key'] !== 'test-api-key') {
      response.statusCode = 401;
      response.end(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};

    if (request.method === 'GET' && path === '/api/sessions') {
      response.end(JSON.stringify(session ? [session] : []));
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions') {
      session = { id: 'session-uuid', name: body.name, status: 'disconnected', phone: null };
      response.statusCode = 201;
      response.end(JSON.stringify(session));
      return;
    }
    if (request.method === 'GET' && path === '/api/sessions/session-uuid') {
      response.end(JSON.stringify(session));
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions/session-uuid/start') {
      session = { ...session, status: 'qr_ready' };
      response.end(JSON.stringify(session));
      return;
    }
    if (request.method === 'GET' && path === '/api/sessions/session-uuid/qr') {
      response.end(JSON.stringify({ qrCode: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`, status: 'qr_ready' }));
      return;
    }
    if (request.method === 'GET' && path === '/api/sessions/session-uuid/webhooks') {
      response.end(JSON.stringify(registeredWebhooks));
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions/session-uuid/webhooks') {
      registeredWebhooks.push({ id: 'webhook-1', ...body });
      response.statusCode = 201;
      response.end(JSON.stringify({ id: 'webhook-1', url: body.url, events: body.events, active: true }));
      return;
    }
    if (request.method === 'GET' && path === '/api/sessions/session-uuid/labels') {
      response.end(JSON.stringify(labels));
      return;
    }
    if (path === '/api/sessions/session-uuid/labels/chat/15551234567@c.us') {
      if (request.method === 'GET') {
        response.end(JSON.stringify(chatLabels));
        return;
      }
      if (request.method === 'POST') {
        const label = labels.find((item) => item.id === body.labelId);
        if (label) chatLabels = [...chatLabels, label];
        response.end(JSON.stringify({ success: true }));
        return;
      }
    }
    if (request.method === 'DELETE' && path.startsWith('/api/sessions/session-uuid/labels/chat/15551234567@c.us/')) {
      const id = path.split('/').at(-1);
      chatLabels = chatLabels.filter((label) => label.id !== id);
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (request.method === 'PUT' && path.startsWith('/api/sessions/session-uuid/contacts/')) {
      contactUpdate = body;
      response.end(JSON.stringify({ success: true, message: 'Contact saved' }));
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions/session-uuid/messages/send-text') {
      if (sendFailure) {
        response.statusCode = sendFailure.status;
        if (sendFailure.retryAfter) response.setHeader('Retry-After', sendFailure.retryAfter);
        response.end(JSON.stringify({ statusCode: sendFailure.status, message: 'failure' }));
        return;
      }
      sentMessage = body;
      response.statusCode = 201;
      response.end(JSON.stringify({ messageId: 'outgoing-1', timestamp: 1_750_000_000 }));
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions/session-uuid/chats/typing') {
      typingEvents.push(body);
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (request.method === 'GET' && path === '/api/sessions/session-uuid/messages/15551234567@c.us/voice-1/media') {
      response.setHeader('Content-Type', 'audio/ogg');
      response.end(Buffer.from([0x4f, 0x67, 0x67, 0x53]));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ statusCode: 404, message: `unexpected ${request.method} ${path}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const mediaDir = await mkdtemp(join(tmpdir(), 'openwa-test-'));
  context.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(mediaDir, { recursive: true, force: true });
  });
  const address = server.address() as AddressInfo;
  const runtime = {
    openwaBaseUrl: `http://127.0.0.1:${address.port}`,
    openwaApiKey: 'test-api-key',
    openwaSessionId: '',
    openwaSessionName: 'triagem',
    openwaWebhookUrl: 'https://example.com/api/openwa/webhook',
    openwaWebhookSecret: 'test-webhook-secret',
    mediaDir,
    assistant: { maxAudioBytes: 2_000_000 },
  } as unknown as RuntimeConfig;
  const callbacks: WhatsAppCallbacks = {
    onIncoming: (message) => { incoming.push(message as unknown as Record<string, unknown>); },
    onLabelEdit: () => undefined,
    onLabelAssociation: () => undefined,
    getLabelId: () => undefined,
  };

  const whatsapp = await connectOpenwa(runtime, pino({ level: 'silent' }), callbacks);

  // Session was created, started, and its webhook registered with a secret.
  const webhook = registeredWebhooks[0];
  assert.equal(webhook?.url, 'https://example.com/api/openwa/webhook');
  assert.deepEqual(webhook?.events, ['message.received', 'session.status']);
  assert.equal(webhook?.secret, 'test-webhook-secret');
  assert.ok(requests.every((entry) => entry.path.startsWith('/api/')));
  const status = await whatsapp.getStatus?.();
  assert.equal(status?.provider, 'openwa');
  assert.equal(status?.state, 'SCAN_QR_CODE');
  assert.equal(status?.connected, false);
  assert.deepEqual(await whatsapp.getQrPng?.(), Buffer.from([1, 2, 3]));

  await whatsapp.setTyping?.('15551234567@s.whatsapp.net', true);
  await whatsapp.setTyping?.('15551234567@s.whatsapp.net', false);
  assert.deepEqual(typingEvents.map((item) => item.state), ['typing', 'paused']);

  await whatsapp.sendText('15551234567@s.whatsapp.net', 'Olá');
  assert.deepEqual(sentMessage, { chatId: '15551234567@c.us', text: 'Olá' });
  sendFailure = { status: 429, retryAfter: '3' };
  await assert.rejects(
    whatsapp.sendText('15551234567@s.whatsapp.net', 'limite'),
    (error: unknown) => error instanceof ProviderRetryAfterError && error.retryAfterMs === 3_000,
  );
  sendFailure = { status: 503 };
  await assert.rejects(whatsapp.sendText('15551234567@s.whatsapp.net', 'incerto'), SendOutcomeUnknownError);
  sendFailure = null;

  await whatsapp.setContactLabels('15551234567@s.whatsapp.net', 'BOT');
  assert.deepEqual(chatLabels.map((label) => label.name).sort(), ['Bot - atendimento', 'Novo Lead', 'VIP']);
  assert.deepEqual((await whatsapp.getContactLabelNames?.('15551234567@s.whatsapp.net'))?.sort(), ['Bot - atendimento', 'Novo Lead', 'VIP']);
  chatLabels = [...chatLabels, labels.find((label) => label.name === 'Clientes')!];
  await assert.rejects(whatsapp.setContactLabels('15551234567@s.whatsapp.net', 'BOT'), /lista Clientes/);
  await whatsapp.setContactLabels('15551234567@s.whatsapp.net', 'HUMANO');
  assert.deepEqual(chatLabels.map((label) => label.name).sort(), ['Atendimento', 'Clientes', 'VIP']);

  await whatsapp.renameContact('15551234567@s.whatsapp.net', 'Ana Maria Silva');
  assert.deepEqual(contactUpdate, { firstName: 'Ana', lastName: 'Maria Silva' });

  await whatsapp.handleWebhook?.({
    event: 'message.received',
    sessionId: 'session-uuid',
    data: { id: 'message-1', chatId: '15551234567@c.us', fromMe: false, body: 'Bom dia', type: 'text', timestamp: 1_750_000_000, kind: 'individual' },
  });
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0]?.jid, '15551234567@s.whatsapp.net');
  assert.equal(incoming[0]?.key, '15551234567@s.whatsapp.net:message-1');
  assert.equal(incoming[0]?.createdAt, 1_750_000_000_000);

  // Own messages, groups, status broadcasts and other sessions are ignored.
  await whatsapp.handleWebhook?.({
    event: 'message.received',
    sessionId: 'session-uuid',
    data: { id: 'own-1', chatId: '15551234567@c.us', fromMe: true, body: 'eco', type: 'text', timestamp: 1_750_000_001 },
  });
  await whatsapp.handleWebhook?.({
    event: 'message.received',
    sessionId: 'session-uuid',
    data: { id: 'group-1', chatId: '120363021234567890@g.us', fromMe: false, body: 'grupo', type: 'text', isGroup: true, kind: 'group', timestamp: 1_750_000_002 },
  });
  await whatsapp.handleWebhook?.({
    event: 'message.received',
    sessionId: 'other-session',
    data: { id: 'other-1', chatId: '15551234567@c.us', body: 'outra', type: 'text', timestamp: 1_750_000_003 },
  });
  assert.equal(incoming.length, 1);

  // Inline audio in the signed payload is stored, and omitted media is fetched.
  await whatsapp.handleWebhook?.({
    event: 'message.received',
    sessionId: 'session-uuid',
    data: {
      id: 'inline-voice', chatId: '15551234567@c.us', type: 'voice', timestamp: 1_750_000_004,
      media: { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from([0x4f, 0x67, 0x67, 0x53]).toString('base64') },
    },
  });
  assert.equal(incoming[1]?.kind, 'audio');
  assert.deepEqual(await readFile(String(incoming[1]?.mediaPath)), Buffer.from([0x4f, 0x67, 0x67, 0x53]));

  await whatsapp.handleWebhook?.({
    event: 'message.received',
    sessionId: 'session-uuid',
    data: {
      id: 'voice-1', chatId: '15551234567@c.us', type: 'voice', timestamp: 1_750_000_005,
      media: { mimetype: 'audio/ogg', omitted: true, sizeBytes: 4 },
    },
  });
  assert.equal(incoming[2]?.kind, 'audio');
  assert.deepEqual(await readFile(String(incoming[2]?.mediaPath)), Buffer.from([0x4f, 0x67, 0x67, 0x53]));

  assert.equal(normalizeOpenwaJid('15551234567@c.us'), '15551234567@s.whatsapp.net');
  assert.equal(toOpenwaChatId('15551234567@s.whatsapp.net'), '15551234567@c.us');
  assert.equal(normalizeOpenwaJid('123456789012345@lid'), '123456789012345@lid');
  await whatsapp.close();
});

test('OpenWA webhook signatures are checked on the exact raw bytes', () => {
  const secret = 'a-long-random-webhook-secret';
  const body = Buffer.from(JSON.stringify({ event: 'message.received', sessionId: 's1', data: { id: 'm1' } }));
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  assert.equal(validOpenwaSignature(body, signature, secret), true);
  assert.equal(validOpenwaSignature(body, signature, 'wrong-secret'), false);
  assert.equal(validOpenwaSignature(Buffer.from(`${body.toString('utf8')} `), signature, secret), false);
  assert.equal(validOpenwaSignature(body, 'sha256=deadbeef', secret), false);
  assert.equal(validOpenwaSignature(body, undefined, secret), false);
  assert.equal(validOpenwaSignature(body, signature, ''), false);
  assert.equal(openwaSignatureDigest(signature)?.length, 64);
  assert.equal(openwaSignatureDigest('sha256=not-hex'), undefined);
});

test('OpenWA requests fail closed when the gateway is unauthorized', async (context) => {
  const server = createServer((_request, response) => {
    response.statusCode = 401;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    server.close();
    await once(server, 'close');
  });
  const address = server.address() as AddressInfo;
  const runtime = {
    openwaBaseUrl: `http://127.0.0.1:${address.port}`,
    openwaApiKey: 'wrong-key',
    openwaSessionId: 'session-uuid',
    openwaSessionName: 'triagem',
    openwaWebhookUrl: 'https://example.com/api/openwa/webhook',
    openwaWebhookSecret: 'test-webhook-secret',
    mediaDir: tmpdir(),
    assistant: { maxAudioBytes: 1_000 },
  } as unknown as RuntimeConfig;
  await assert.rejects(
    connectOpenwa(runtime, pino({ level: 'silent' }), {
      onIncoming: () => undefined,
      onLabelEdit: () => undefined,
      onLabelAssociation: () => undefined,
      getLabelId: () => undefined,
    }),
    /HTTP 401/,
  );
});
