import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GeminiProvider, GeminiQuotaError } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import type { AssistantConfig, IntakeProfile } from './config.js';
import type { StoredMessage } from './database.js';

const profile = {
  id: 'intake', label: 'Triagem', triggers: [], fields: [
    { id: 'topic', label: 'Assunto', question: 'Qual assunto?', type: 'open_text', options: [], structure: '', required: true, contactName: false },
  ],
} as IntakeProfile;
const assistant = { maxHistoryMessages: 8, officeMemory: '', materials: [] } as unknown as AssistantConfig;

test('Ollama receives a JSON schema and returns only the validated extraction fields', async (context) => {
  let requestBody: Record<string, unknown> = {};
  context.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { content: '{"capturedFields":{"topic":"Família"}}' } }), { status: 200 });
  });
  const provider = new OllamaProvider('http://127.0.0.1:11434', 'test-model');
  assert.deepEqual(await provider.extract(profile, [{ direction: 'inbound', body: 'Família' } as StoredMessage], {}, assistant), { capturedFields: { topic: 'Família' } });
  assert.deepEqual(requestBody.model, 'test-model');
  assert.equal(requestBody.stream, false);
  assert.equal(typeof requestBody.format, 'object');
});

test('Ollama timeout and malformed model JSON fail as errors, without a generated contact reply', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  const provider = new OllamaProvider('http://127.0.0.1:11434', 'test-model');
  await assert.rejects(provider.extract(profile, [], {}, assistant), { name: 'TimeoutError' });

  context.mock.reset();
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: { content: 'resposta livre' } }), { status: 200 }));
  await assert.rejects(provider.extract(profile, [], {}, assistant), /JSON inválido/);
});

test('Gemini quota honors Retry-After and defers subsequent API calls locally', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('quota', { status: 429, headers: { 'retry-after': '2' } });
  });
  const provider = new GeminiProvider('test-key', 'test-model');
  await assert.rejects(provider.extract(profile, [], {}, assistant), (error: unknown) => error instanceof GeminiQuotaError && error.retryAfterMs >= 1_000);
  await assert.rejects(provider.extract(profile, [], {}, assistant), (error: unknown) => error instanceof GeminiQuotaError && error.retryAfterMs > 0);
  assert.equal(calls, 1);
});

test('Gemini rejects malformed JSON and refuses audio above its configured byte limit before upload', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 }));
  const provider = new GeminiProvider('test-key', 'test-model');
  await assert.rejects(provider.extract(profile, [], {}, assistant), /JSON inválido/);

  const directory = await mkdtemp(join(tmpdir(), 'gemini-audio-test-'));
  const filePath = join(directory, 'voice.ogg');
  await writeFile(filePath, Buffer.alloc(32));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(provider.transcribe(filePath, 16, 10), /excede o limite/);
});
