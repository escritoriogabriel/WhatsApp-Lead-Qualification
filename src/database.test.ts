import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentDatabase, type IncomingMessage } from './database.js';

const jid = '15551234567@s.whatsapp.net';
const incoming = (key: string, createdAt = Date.now(), body = key): IncomingMessage => ({
  key, jid, kind: 'text', body, mediaPath: null, createdAt,
});

async function makeDatabase(context: { after(callback: () => void | Promise<void>): void }, batchWindowMs = 0): Promise<AgentDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'lead-qualification-db-'));
  let db = new AgentDatabase(join(directory, 'agent.sqlite'), batchWindowMs);
  context.after(async () => {
    try { db.close(); } catch { /* closed in a restart test */ }
    await rm(directory, { recursive: true, force: true });
  });
  return db;
}

test('records first observed contact separately and deduplicates provider message IDs', async (context) => {
  const db = await makeDatabase(context, 5_000);
  assert.equal(db.saveIncoming(incoming('provider-1', 2_000, 'primeira')), true);
  assert.equal(db.isFirstContact(jid), true);
  assert.equal(db.listContacts()[0]?.firstContactObserved, true);
  assert.equal(db.saveIncoming(incoming('provider-1', 2_001, 'duplicada')), false);
  assert.equal(db.getUnprocessedMessages(jid).length, 1);

  assert.equal(db.saveIncoming(incoming('provider-2', 1_000, 'anterior no timestamp')), true);
  assert.equal(db.isFirstContact(jid), true);
  assert.deepEqual(db.getUnprocessedMessages(jid).map((message) => message.key), ['provider-2', 'provider-1']);
  db.setContactAssignment(jid, 'BOT', 'panel');
  assert.equal(db.queueConversationStart(jid), false); // The inbound job is already queued.
  assert.ok(db.claimDueJob(Date.now() + 10_000));
  assert.equal(db.claimDueJob(Date.now() + 10_000), null);
});

test('fails closed for ineligible, paused, human, and automatically blocked contacts', async (context) => {
  const db = await makeDatabase(context);
  db.ensureContact(jid);
  assert.equal(db.getContactEligibility(jid), 'unknown');
  assert.equal(db.isAuthorizedForAutomation(jid), false);

  db.setContactAssignment(jid, 'BOT', 'panel');
  assert.equal(db.isAuthorizedForAutomation(jid), true);
  db.setContactAssignment(jid, 'PAUSADO', 'panel-pause');
  assert.equal(db.isManualPause(jid), true);
  assert.equal(db.syncRemoteAssignment(jid, 'BOT'), 'PAUSADO');
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.setContactAssignment(jid, 'BOT', 'panel');
  assert.equal(db.isManualPause(jid), false);
  assert.equal(db.isAuthorizedForAutomation(jid), true);

  db.setContactAssignment(jid, 'HUMANO', 'panel');
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.setContactAssignment(jid, 'BOT', 'panel');
  db.blockAutomation(jid, 'system-unknown-send');
  assert.equal(db.isAutomationBlocked(jid), true);
  assert.equal(db.syncRemoteAssignment(jid, 'BOT'), 'PAUSADO');
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.setContactAssignment(jid, 'BOT', 'panel');
  assert.equal(db.isAutomationBlocked(jid), false);
  assert.equal(db.isAuthorizedForAutomation(jid), true);
});

test('repeated and competing label events stay idempotent and human takes priority over bot', async (context) => {
  const db = await makeDatabase(context);
  db.saveLabel('bot-label', 'Bot - atendimento');
  db.saveLabel('human-label', 'Atendimento');
  db.saveIncoming(incoming('label-test'));
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.getContactAssignment(jid), 'BOT');
  assert.equal(db.queueConversationStart(jid), false); // Already has the inbound job.
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.getContactAssignment(jid), 'BOT');

  db.updateContactLabel(jid, 'human-label', 'Atendimento', true);
  assert.equal(db.getContactAssignment(jid), 'HUMANO');
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.updateContactLabel(jid, 'human-label', 'Atendimento', false);
  assert.equal(db.getContactAssignment(jid), 'BOT');
  assert.equal(db.isAuthorizedForAutomation(jid), true);
});

test('does not invent an outbound message from an assignment and preserves pending inbound while paused', async (context) => {
  const db = await makeDatabase(context);
  db.ensureContact(jid);
  db.setContactAssignment(jid, 'BOT', 'panel');
  assert.equal(db.queueConversationStart(jid), false);

  db.saveIncoming(incoming('pending-inbound'));
  db.setContactAssignment(jid, 'PAUSADO', 'panel-pause');
  const pausedJob = db.claimDueJob(Date.now() + 1_000);
  assert.equal(pausedJob?.jid, jid);
  assert.equal(db.getUnprocessedMessages(jid).length, 1);
  db.completeJob(pausedJob!.id);
  db.setContactAssignment(jid, 'BOT', 'panel');
  assert.equal(db.queueConversationStart(jid), true);
  assert.equal(db.claimDueJob(Date.now() + 1_000)?.jid, jid);
});

test('marks an in-flight send unknown after restart and does not retry it', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-qualification-restart-'));
  const path = join(directory, 'agent.sqlite');
  let activeDatabase: AgentDatabase | null = null;
  context.after(async () => {
    try { activeDatabase?.close(); } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true });
  });
  const first = new AgentDatabase(path, 0);
  activeDatabase = first;
  first.setContactAssignment(jid, 'BOT', 'panel');
  first.saveIncoming(incoming('restart-pending'));
  const processingJob = first.claimDueJob(Date.now() + 1_000);
  assert.ok(processingJob);
  const id = first.queueOutbound('dedupe-1', jid, 'text');
  first.markOutboundSending(id);
  first.close();

  const restarted = new AgentDatabase(path, 0);
  activeDatabase = restarted;
  assert.deepEqual(restarted.pendingOutbox(), []);
  assert.equal(restarted.queueOutbound('dedupe-1', jid, 'text'), id);
  assert.equal(restarted.isAuthorizedForAutomation(jid), false);
  assert.equal(restarted.getUnprocessedMessages(jid).length, 1);
  assert.equal(restarted.claimDueJob(Date.now() + 1_000)?.id, processingJob!.id);
  assert.equal(restarted.outboundLimitReason(jid, {
    perContactDay: 20, perContactMonth: 100, globalDay: 100, globalMonth: 1000, minSecondsBetweenContactMessages: 0,
  }, true), null);
});

test('expires processed messages and returns temporary media paths for deletion', async (context) => {
  const db = await makeDatabase(context);
  const oldAt = Date.now() - 100 * 24 * 60 * 60 * 1000;
  const audio: IncomingMessage = { ...incoming('old-audio', oldAt), kind: 'audio', body: null, mediaPath: join(tmpdir(), 'old-audio.ogg') };
  db.saveIncoming(audio);
  const [message] = db.getUnprocessedMessages(jid);
  assert.ok(message);
  db.markMessagesProcessed([message.id]);
  db.setContactActivity(jid, oldAt);
  assert.deepEqual(db.expireData(90), [audio.mediaPath]);
  assert.equal(db.getRecentMessages(jid, 10).length, 0);
  assert.equal(db.claimDueJob(Date.now() + 1_000), null);
});
