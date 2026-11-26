import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
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
  assert.equal(db.saveIncoming(incoming('provider-1', 2_001, 'duplicada')), false);
  assert.equal(db.getUnprocessedMessages(jid).length, 1);

  assert.equal(db.saveIncoming(incoming('provider-2', 1_000, 'anterior no timestamp')), true);
  assert.equal(db.isFirstContact(jid), true);
  assert.deepEqual(db.getUnprocessedMessages(jid).map((message) => message.key), ['provider-2', 'provider-1']);
  assert.equal(db.queueConversationStart(jid), false); // The inbound job is already queued.
  assert.ok(db.claimDueJob(Date.now() + 10_000));
  assert.equal(db.claimDueJob(Date.now() + 10_000), null);
});

test('uses WhatsApp labels as the only contact authorization source', async (context) => {
  const db = await makeDatabase(context);
  db.saveLabel('bot-label', 'Bot - atendimento');
  db.saveLabel('client-label', 'Clientes');
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.isAuthorizedForAutomation(jid), true);
  db.updateContactLabel(jid, 'client-label', 'Clientes', true);
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.updateContactLabel(jid, 'client-label', 'Clientes', false);
  assert.equal(db.isAuthorizedForAutomation(jid), true);
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', false);
  assert.equal(db.isAuthorizedForAutomation(jid), false);
});

test('label events are idempotent; Atendimento never authorizes Bot and Clientes blocks it', async (context) => {
  const db = await makeDatabase(context);
  db.saveLabel('bot-label', 'Bot - atendimento');
  db.saveLabel('human-label', 'Atendimento');
  db.saveLabel('client-label', 'Clientes');
  db.saveIncoming(incoming('label-test'));
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.isAuthorizedForAutomation(jid), true);
  assert.equal(db.queueConversationStart(jid), false); // Already has the inbound job.
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.isAuthorizedForAutomation(jid), true);

  db.updateContactLabel(jid, 'human-label', 'Atendimento', true);
  assert.equal(db.isAuthorizedForAutomation(jid), true); // Só a etiqueta Bot autoriza; Atendimento não substitui a remoção de Bot.
  db.updateContactLabel(jid, 'human-label', 'Atendimento', false);
  assert.equal(db.isAuthorizedForAutomation(jid), true);
  db.updateContactLabel(jid, 'client-label', 'Clientes', true);
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.updateContactLabel(jid, 'client-label', 'Clientes', false);
  assert.equal(db.isAuthorizedForAutomation(jid), true);
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', false);
  assert.equal(db.isAuthorizedForAutomation(jid), false);
  db.updateContactLabel(jid, 'human-label', 'Atendimento', true);
  assert.equal(db.isAuthorizedForAutomation(jid), false);
});

test('a Bot label alone sends nothing and pending inbound resumes only after the label is applied', async (context) => {
  const db = await makeDatabase(context);
  db.ensureContact(jid);
  db.saveLabel('bot-label', 'Bot - atendimento');
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.queueConversationStart(jid), false);

  db.saveIncoming(incoming('pending-inbound'));
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', false);
  const pausedJob = db.claimDueJob(Date.now() + 1_000);
  assert.equal(pausedJob?.jid, jid);
  assert.equal(db.getUnprocessedMessages(jid).length, 1);
  db.completeJob(pausedJob!.id);
  db.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
  assert.equal(db.queueConversationStart(jid), true);
  assert.equal(db.claimDueJob(Date.now() + 1_000)?.jid, jid);
});

test('label sync recovery releases pending initialization and conversation jobs', async (context) => {
  const db = await makeDatabase(context);
  db.saveIncoming(incoming('label-sync-retry'));
  db.markLabelInitializationPending(jid);
  const job = db.claimDueJob(Date.now() + 1_000);
  assert.ok(job);
  db.deferJob(job.id, 60_000, 'labels unavailable');
  assert.deepEqual(db.getContactsAwaitingLabelInitialization(), [jid]);
  assert.deepEqual(db.getContactsWithUnprocessedMessages(), [jid]);
  assert.equal(db.queueConversationStart(jid), false);
  assert.equal(db.claimDueJob()?.jid, jid); // The active deferred job becomes due now.
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
  first.saveLabel('bot-label', 'Bot - atendimento');
  first.updateContactLabel(jid, 'bot-label', 'Bot - atendimento', true);
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
  assert.equal(restarted.isAuthorizedForAutomation(jid), true); // Estado técnico da saída não substitui as listas do WhatsApp.
  assert.equal(restarted.getUnprocessedMessages(jid).length, 1);
  assert.equal(restarted.claimDueJob(Date.now() + 1_000)?.id, processingJob!.id);
  assert.equal(restarted.outboundLimitReason(jid, {
    perContactDay: 20, perContactMonth: 100, globalDay: 100, globalMonth: 1000, minSecondsBetweenContactMessages: 0,
  }, true), null);
});

test('migrates legacy eligibility columns without changing conversation state', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-qualification-migration-'));
  const path = join(directory, 'agent.sqlite');
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE contacts (
      jid TEXT PRIMARY KEY, display_name TEXT, assignment TEXT NOT NULL DEFAULT 'PAUSADO',
      eligibility TEXT NOT NULL DEFAULT 'unknown' CHECK (eligibility IN ('eligible','ineligible','unknown')),
      first_contact_observed INTEGER NOT NULL DEFAULT 0,
      manual_pause INTEGER NOT NULL DEFAULT 0, automation_blocked INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'inbound', updated_at INTEGER NOT NULL, last_activity_at INTEGER
    );
    CREATE TABLE conversations (jid TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  const stateJson = JSON.stringify({ profileId: 'laboral', fields: { assunto: 'teste sintético' }, skippedFields: [], attempts: {}, pendingFieldId: 'cidade', paused: false, completed: false, externalDisclosureAfterMessageId: null });
  legacy.prepare('INSERT INTO contacts (jid, display_name, assignment, eligibility, first_contact_observed, manual_pause, automation_blocked, source, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(jid, 'Contato sintético', 'PAUSADO', 'ineligible', 1, 0, 0, 'client-removed', 10, 20);
  legacy.prepare('INSERT INTO conversations (jid, state_json, updated_at) VALUES (?, ?, ?)').run(jid, stateJson, 30);
  legacy.close();

  const migrated = new AgentDatabase(path, 0);
  try {
    assert.deepEqual(migrated.getConversationState(jid), JSON.parse(stateJson));
    assert.equal(migrated.needsLabelInitialization(jid), true);
    migrated.clearLabelInitializationPending(jid);
    assert.equal(migrated.needsLabelInitialization(jid), false);
    const inspection = new Database(path);
    try {
      const columns = (inspection.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((column) => column.name);
      assert.ok(!columns.some((name) => ['eligibility', 'manual_pause', 'automation_blocked', 'assignment', 'source'].includes(name)));
      assert.equal((inspection.prepare('SELECT display_name AS name FROM contacts WHERE jid = ?').get(jid) as { name: string }).name, 'Contato sintético');
    } finally { inspection.close(); }
  } finally { migrated.close(); }
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
