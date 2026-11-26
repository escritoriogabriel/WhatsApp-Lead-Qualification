import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pino } from 'pino';
import type { IntakeAIProvider } from './ai.js';
import { validateAssistantConfig, type RuntimeConfig } from './config.js';
import { AgentDatabase, type IncomingMessage } from './database.js';
import { GeminiQuotaError } from './gemini.js';
import { QualificationWorker } from './qualification.js';

const jid = '15551234567@s.whatsapp.net';
const rawConfig = JSON.parse(await readFile(join(process.cwd(), 'config/qualification.example.json'), 'utf8')) as Record<string, unknown>;

function assistant(overrides: Record<string, unknown> = {}) {
  return validateAssistantConfig({
    ...rawConfig,
    aiProvider: 'ollama',
    simulateTyping: false,
    batchWindowSeconds: 0,
    sendPartDelaySeconds: 0,
    minSecondsBetweenContactMessages: 0,
    workerPollMs: 100,
    ...overrides,
  });
}

function message(key: string, kind: 'text' | 'audio' = 'text', mediaPath: string | null = null): IncomingMessage {
  return { key, jid, kind, body: kind === 'text' ? 'Olá' : null, mediaPath, createdAt: Date.now() };
}

async function createHarness(context: { after(callback: () => void | Promise<void>): void }, options: {
  config?: ReturnType<typeof assistant>;
  provider?: IntakeAIProvider;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-worker-test-'));
  const mediaDir = join(directory, 'media');
  await mkdir(mediaDir, { recursive: true });
  const db = new AgentDatabase(join(directory, 'agent.sqlite'), 0);
  context.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.saveLabel('bot-label', 'Bot - atendimento');
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  const currentAssistant = options.config ?? assistant();
  const sent: string[] = [];
  const labelChanges: string[] = [];
  const provider: IntakeAIProvider = options.provider ?? {
    extract: async () => ({ capturedFields: {} }),
    transcribe: async () => 'transcrição de teste',
  };
  const contacts = {
    setContactLabels: async (_jid: string, target: 'BOT' | 'HUMANO') => {
      labelChanges.push(target);
      if (target === 'BOT') db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
      else db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', false);
      if (target === 'HUMANO') {
        db.saveLabel('human-label', 'Atendimento');
        db.updateContactLabel(jid, 'human-label', 'Atendimento', true);
      }
    },
    renameContact: async () => undefined,
    getStatus: async () => ({ connected: true }),
    getContactLabelNames: async () => db.getContactLabelNames(jid),
  };
  const runtime = { humanNotifyJid: undefined } as unknown as RuntimeConfig;
  const worker = new QualificationWorker(db, provider, () => currentAssistant, runtime,
    async (_jid, text) => { sent.push(text); }, contacts, pino({ level: 'silent' }));
  return { db, worker, sent, labelChanges, provider, mediaDir, directory };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('A condição do worker não foi satisfeita no tempo esperado.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('keeps inbound messages pending after Bot is removed, then resumes when the label returns', async (context) => {
  const harness = await createHarness(context);
  harness.db.saveIncoming(message('paused-message'));
  harness.db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', false);
  const abort = new AbortController();
  const run = harness.worker.run(abort.signal);
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'aguardando-autorizacao'));
  assert.deepEqual(harness.sent, []);
  abort.abort();
  await run;

  harness.db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(harness.db.queueConversationStart(jid), true);
  const resumedAbort = new AbortController();
  const resumed = harness.worker.run(resumedAbort.signal);
  await waitFor(() => harness.sent.length >= 2);
  resumedAbort.abort();
  await resumed;
  assert.ok(harness.sent.join(' ').includes(harness.db.getRecentMessages(jid, 10)[0]?.body ?? 'Olá'));
});

test('provider synchronization failure blocks output and leaves inbound messages pending', async (context) => {
  const harness = await createHarness(context);
  harness.db.saveIncoming(message('provider-offline'));
  const config = assistant();
  const provider: IntakeAIProvider = { extract: async () => ({ capturedFields: {} }), transcribe: async () => '' };
  let providerAvailable = false;
  const worker = new QualificationWorker(harness.db, provider, () => config, { humanNotifyJid: undefined } as unknown as RuntimeConfig,
    async (_jid, text) => { harness.sent.push(text); }, {
      setContactLabels: async () => undefined,
      renameContact: async () => undefined,
      getStatus: async () => { if (!providerAvailable) throw new Error('private provider detail'); return { connected: true }; },
      getContactLabelNames: async () => ['Bot - atendimento'],
    }, pino({ level: 'silent' }));
  const abort = new AbortController();
  const run = worker.run(abort.signal);
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'aguardando-listas'));
  abort.abort();
  await run;
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.db.getUnprocessedMessages(jid).length, 1);

  providerAvailable = true;
  assert.equal(harness.db.queueConversationStart(jid), false);
  const resumedAbort = new AbortController();
  const resumed = worker.run(resumedAbort.signal);
  await waitFor(() => harness.sent.length >= 2);
  resumedAbort.abort();
  await resumed;
  assert.ok(harness.sent.length > 0);
});

test('builds the first turn from fixed disclosure and configured question text, never a generated reply', async (context) => {
  const config = assistant();
  const provider: IntakeAIProvider = {
    extract: async () => ({ capturedFields: {} }),
    transcribe: async () => 'not used',
  };
  const harness = await createHarness(context, { config, provider });
  harness.db.saveIncoming(message('first-turn'));
  const abort = new AbortController();
  const run = harness.worker.run(abort.signal);
  await waitFor(() => harness.sent.length >= 2);
  abort.abort();
  await run;
  assert.equal(harness.sent.length, 2);
  assert.ok(harness.sent[0]?.includes(config.greeting));
  assert.ok(harness.sent[0]?.includes(config.assistantNotice));
  assert.ok(harness.sent[0]?.includes(config.privacyNotice));
  assert.equal(harness.sent[1], config.areaQuestion);
  assert.equal(harness.sent.some((text) => text.includes('not used')), false);
});

test('does not transcribe audio when disabled, removes the temporary file, and uses the fixed handoff message', async (context) => {
  let transcribeCalls = 0;
  const provider: IntakeAIProvider = {
    extract: async () => ({ capturedFields: {} }),
    transcribe: async () => { transcribeCalls += 1; return 'unexpected'; },
  };
  const config = assistant({ audioTranscriptionProvider: 'disabled' });
  const harness = await createHarness(context, { provider, config });
  const mediaPath = join(harness.mediaDir, 'voice.ogg');
  await writeFile(mediaPath, Buffer.from('test audio'));
  harness.db.saveIncoming(message('audio-disabled', 'audio', mediaPath));
  const abort = new AbortController();
  const run = harness.worker.run(abort.signal);
  await waitFor(() => harness.sent.length > 0);
  abort.abort();
  await run;
  assert.equal(transcribeCalls, 0);
  assert.equal(harness.sent[0], config.audioRetryMessage);
  assert.equal(harness.db.isAuthorizedForAutomation(jid), false);
  await assert.rejects(readFile(mediaPath));
});

test('routes transcription failure to the team with a fixed message', async (context) => {
  const config = assistant({ audioTranscriptionProvider: 'gemini' });
  const provider: IntakeAIProvider = {
    extract: async () => ({ capturedFields: {} }),
    transcribe: async () => { throw new Error('provider detail must not reach the contact'); },
  };
  const harness = await createHarness(context, { provider, config });
  harness.db.saveIncoming(message('audio-disclosure-primer'));
  const abort = new AbortController();
  const run = harness.worker.run(abort.signal);
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'aviso-provedor-externo'));
  const mediaPath = join(harness.mediaDir, 'voice-failure.ogg');
  await writeFile(mediaPath, Buffer.from('test audio'));
  harness.db.saveIncoming(message('audio-failure', 'audio', mediaPath));
  await waitFor(() => harness.sent.includes(config.audioRetryMessage));
  abort.abort();
  await run;
  assert.ok(harness.sent.includes(config.externalProviderNotice));
  assert.equal(harness.sent.at(-1), config.audioRetryMessage);
  assert.equal(harness.sent.join(' ').includes('provider detail'), false);
  await assert.rejects(readFile(mediaPath));
});

test('holds messages on temporary Gemini quota and does not emit a guessed reply', async (context) => {
  const provider: IntakeAIProvider = {
    extract: async () => { throw new GeminiQuotaError(60_000); },
    transcribe: async () => 'not used',
  };
  const harness = await createHarness(context, { provider, config: assistant({ aiProvider: 'gemini' }) });
  const config = assistant({ aiProvider: 'gemini' });
  harness.db.saveIncoming(message('quota-disclosure-primer'));
  const abort = new AbortController();
  const run = harness.worker.run(abort.signal);
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'aviso-provedor-externo'));
  harness.db.saveIncoming(message('quota-inbound'));
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'aguardando-cota'));
  abort.abort();
  await run;
  assert.equal(harness.sent[0], config.externalProviderNotice);
  assert.ok(harness.sent.includes(config.areaQuestion));
  assert.equal(harness.sent.some((text) => text.includes('not used')), false);
  assert.equal(harness.db.getUnprocessedMessages(jid).length, 1);
});

test('discloses external processing before starting fixed intake and deletes the first audio without transcription', async (context) => {
  const config = assistant({ aiProvider: 'gemini', audioTranscriptionProvider: 'gemini' });
  let transcribeCalls = 0;
  const provider: IntakeAIProvider = {
    extract: async () => ({ capturedFields: {} }),
    transcribe: async () => { transcribeCalls += 1; return 'must not be sent'; },
  };
  const harness = await createHarness(context, { provider, config });
  const mediaPath = join(harness.mediaDir, 'first-audio.ogg');
  await writeFile(mediaPath, Buffer.from('private audio'));
  harness.db.saveIncoming(message('first-audio-disclosure', 'audio', mediaPath));
  const abort = new AbortController();
  const run = harness.worker.run(abort.signal);
  await waitFor(() => harness.sent.includes(config.areaQuestion));
  abort.abort();
  await run;

  assert.equal(harness.sent[0], config.externalProviderNotice);
  assert.ok(harness.sent.some((text) => text.includes(config.greeting)));
  assert.equal(transcribeCalls, 0);
  assert.equal(harness.db.getRecentMessages(jid, 10)[0]?.mediaPath, null);
  await assert.rejects(readFile(mediaPath));
});

test('stops before send if authorization changes during the typing indicator', async (context) => {
  const harness = await createHarness(context, { config: assistant({ simulateTyping: true, typingSecondsPerCharacter: 0 }) });
  const contacts = harness.worker;
  assert.ok(contacts);
  harness.db.saveIncoming(message('typing-pause'));
  // Install a sender-side pause on the contact manager through the exposed worker dependency mock.
  const config = assistant({ simulateTyping: true, typingSecondsPerCharacter: 0 });
  const provider: IntakeAIProvider = { extract: async () => ({ capturedFields: {} }), transcribe: async () => '' };
  const secondWorker = new QualificationWorker(harness.db, provider, () => config, { humanNotifyJid: undefined } as unknown as RuntimeConfig,
    async (_jid, text) => { harness.sent.push(text); }, {
      setContactLabels: async () => undefined,
      renameContact: async () => undefined,
      getStatus: async () => ({ connected: true }),
      getContactLabelNames: async () => harness.db.getContactLabelNames(jid),
      setTyping: async (_jid, typing) => { if (typing) harness.db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', false); },
    }, pino({ level: 'silent' }));
  const abort = new AbortController();
  const run = secondWorker.run(abort.signal);
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'envio-bloqueado'));
  abort.abort();
  await run;
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.db.isAuthorizedForAutomation(jid), false);
});

test('Meta handoff does not send a proactive internal WhatsApp summary', async (context) => {
  const harness = await createHarness(context);
  harness.db.saveIncoming({ ...message('human-meta'), body: 'HUMANO' });
  const config = assistant();
  const provider: IntakeAIProvider = { extract: async () => ({ capturedFields: {} }), transcribe: async () => '' };
  const runtime = { humanNotifyJid: '15557654321@s.whatsapp.net', whatsappProvider: 'meta' } as unknown as RuntimeConfig;
  const worker = new QualificationWorker(harness.db, provider, () => config, runtime,
    async (_jid, text) => { harness.sent.push(text); }, {
      setContactLabels: async () => undefined,
      renameContact: async () => undefined,
      getStatus: async () => ({ connected: true }),
      getContactLabelNames: async () => ['Bot - atendimento'],
    }, pino({ level: 'silent' }));
  const abort = new AbortController();
  const run = worker.run(abort.signal);
  await waitFor(() => harness.db.listDiagnostics().some((item) => item.event === 'encaminhamento-interno'));
  abort.abort();
  await run;
  assert.deepEqual(harness.sent, [config.handoffMessage]);
});
