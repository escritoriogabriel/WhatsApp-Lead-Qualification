import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pino } from 'pino';
import type { RuntimeConfig } from './config.js';
import { connectMetaCloudApi, validMetaSignature } from './meta.js';
import { ProviderRetryAfterError, SendOutcomeUnknownError } from './provider-errors.js';
import type { WhatsAppCallbacks } from './whatsapp.js';

test('validates Meta webhook HMAC and rejects missing, malformed, or wrong signatures', () => {
  const raw = Buffer.from('{"entry":[]}');
  const secret = 'test-only-app-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(validMetaSignature(raw, signature, secret), true);
  assert.equal(validMetaSignature(raw, undefined, secret), false);
  assert.equal(validMetaSignature(raw, 'sha256=bad', secret), false);
  assert.equal(validMetaSignature(raw, signature, 'wrong'), false);
});

test('Meta webhook passes inbound message to persistence callback before returning', async (context) => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'meta-webhook-test-'));
  context.after(async () => rm(mediaDir, { recursive: true, force: true }));
  const runtime = {
    metaPhoneNumberId: '123456789012345', metaGraphApiVersion: 'v27.0', metaAccessToken: 'test-token',
    mediaDir, assistant: { audioTranscriptionProvider: 'disabled', maxAudioBytes: 1024 },
  } as unknown as RuntimeConfig;
  const persisted: Array<Record<string, unknown>> = [];
  const callbacks: WhatsAppCallbacks = {
    onIncoming: (message) => { persisted.push(message as unknown as Record<string, unknown>); },
    onLabelEdit: () => undefined,
    onLabelAssociation: () => undefined,
    getLabelId: () => undefined,
  };
  const connection = await connectMetaCloudApi(runtime, pino({ level: 'silent' }), callbacks);
  assert.deepEqual(await connection.getStatus?.(), { provider: 'meta', state: 'CONFIGURED', connected: true });
  await connection.handleWebhook?.({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.test-1', from: '15551234567', timestamp: '1764000000', type: 'text', text: { body: 'Olá' } }] } }] }],
  });
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    key: '15551234567@s.whatsapp.net:wamid.test-1', jid: '15551234567@s.whatsapp.net', kind: 'text',
    body: 'Olá', mediaPath: null, createdAt: 1_764_000_000_000,
  });
});

test('Meta Cloud API sends only through a mocked fetch and requires provider message ID confirmation', async (context) => {
  const runtime = {
    metaPhoneNumberId: '123456789012345', metaGraphApiVersion: 'v27.0', metaAccessToken: 'test-token',
    mediaDir: tmpdir(), assistant: { audioTranscriptionProvider: 'disabled', maxAudioBytes: 1024 },
  } as unknown as RuntimeConfig;
  const callbacks: WhatsAppCallbacks = { onIncoming: () => undefined, onLabelEdit: () => undefined, onLabelAssociation: () => undefined, getLabelId: () => undefined };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ? { url: String(input), init } : { url: String(input) });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.accepted' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const connection = await connectMetaCloudApi(runtime, pino({ level: 'silent' }), callbacks);
  await connection.sendText('15551234567@s.whatsapp.net', 'Olá');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /graph\.facebook\.com\/v27\.0\/123456789012345\/messages$/);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '15551234567', type: 'text', text: { body: 'Olá' },
  });
  assert.match(new Headers(calls[0]!.init?.headers).get('authorization') ?? '', /^Bearer test-token$/);
});

test('Meta rate limits honor Retry-After and server/network ambiguity is not retried automatically', async (context) => {
  const runtime = {
    metaPhoneNumberId: '123456789012345', metaGraphApiVersion: 'v27.0', metaAccessToken: 'test-token',
    mediaDir: tmpdir(), assistant: { audioTranscriptionProvider: 'disabled', maxAudioBytes: 1024 },
  } as unknown as RuntimeConfig;
  const callbacks: WhatsAppCallbacks = { onIncoming: () => undefined, onLabelEdit: () => undefined, onLabelAssociation: () => undefined, getLabelId: () => undefined };
  context.mock.method(globalThis, 'fetch', async () => new Response('limited', { status: 429, headers: { 'retry-after': '4' } }));
  const connection = await connectMetaCloudApi(runtime, pino({ level: 'silent' }), callbacks);
  await assert.rejects(connection.sendText('15551234567@s.whatsapp.net', 'teste'), (error: unknown) => error instanceof ProviderRetryAfterError && error.retryAfterMs === 4_000);

  context.mock.reset();
  context.mock.method(globalThis, 'fetch', async () => new Response('temporary server failure', { status: 503 }));
  await assert.rejects(connection.sendText('15551234567@s.whatsapp.net', 'teste'), SendOutcomeUnknownError);

  context.mock.reset();
  context.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network error'); });
  await assert.rejects(connection.sendText('15551234567@s.whatsapp.net', 'teste'), SendOutcomeUnknownError);
});

test('rejects malformed Meta webhook envelopes before persisting anything', async () => {
  const runtime = {
    metaPhoneNumberId: '123456789012345', metaGraphApiVersion: 'v27.0', metaAccessToken: 'test-token',
    mediaDir: tmpdir(), assistant: { audioTranscriptionProvider: 'disabled', maxAudioBytes: 1024 },
  } as unknown as RuntimeConfig;
  let persisted = false;
  const callbacks: WhatsAppCallbacks = { onIncoming: () => { persisted = true; }, onLabelEdit: () => undefined, onLabelAssociation: () => undefined, getLabelId: () => undefined };
  const connection = await connectMetaCloudApi(runtime, pino({ level: 'silent' }), callbacks);
  await assert.rejects(connection.handleWebhook!({ object: 'invalid', entry: [] }), /Webhook Meta inválido/);
  assert.equal(persisted, false);
});
