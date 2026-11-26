import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type MessageKind = 'text' | 'audio';

export interface IncomingMessage {
  key: string;
  jid: string;
  kind: MessageKind;
  body: string | null;
  mediaPath: string | null;
  createdAt: number;
}

export interface StoredMessage extends IncomingMessage {
  id: number;
  direction: 'inbound' | 'outbound';
  processedAt: number | null;
}

export interface ConversationState {
  profileId: string | null;
  fields: Record<string, string>;
  skippedFields: string[];
  attempts: Record<string, number>;
  pendingFieldId: string | null;
  paused: boolean;
  completed: boolean;
  externalDisclosureAfterMessageId: number | null;
}

export interface QueueJob {
  id: number;
  jid: string;
  kind: string;
  attempts: number;
}

export type ContactAssignment = 'BOT' | 'HUMANO' | 'PAUSADO';
export type ContactEligibility = 'eligible' | 'ineligible' | 'unknown';

export interface ContactRecord {
  jid: string;
  phone: string;
  displayName: string | null;
  assignment: ContactAssignment;
  eligibility: ContactEligibility;
  firstContactObserved: boolean;
  manualPause: boolean;
  automationBlocked: boolean;
  source: string;
  updatedAt: number;
  lastActivityAt: number | null;
}

export interface DiagnosticRecord {
  id: number;
  jid: string;
  event: string;
  detail: string;
  createdAt: number;
}

export interface OutboundRateLimits {
  perContactDay: number;
  perContactMonth: number;
  globalDay: number;
  globalMonth: number;
  minSecondsBetweenContactMessages: number;
}

const EMPTY_STATE: ConversationState = {
  profileId: null,
  fields: {},
  skippedFields: [],
  attempts: {},
  pendingFieldId: null,
  paused: false,
  completed: false,
  externalDisclosureAfterMessageId: null,
};

export class AgentDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string, private batchWindowMs: number) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(String.raw` 
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT NOT NULL UNIQUE,
        jid TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        kind TEXT NOT NULL CHECK (kind IN ('text', 'audio')),
        body TEXT,
        media_path TEXT,
        created_at INTEGER NOT NULL,
        processed_at INTEGER,
        first_contact INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_jid_created
        ON messages (jid, created_at, id);
      CREATE TABLE IF NOT EXISTS conversations (
        jid TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'failed')),
        not_before INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_due
        ON jobs (status, not_before, id);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        jid TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'blocked')),
        authorization_required INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        not_before INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_pending
        ON outbox (status, id);
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        display_name TEXT,
        assignment TEXT NOT NULL DEFAULT 'PAUSADO'
          CHECK (assignment IN ('BOT', 'HUMANO', 'PAUSADO')),
        eligibility TEXT NOT NULL DEFAULT 'unknown'
          CHECK (eligibility IN ('eligible', 'ineligible', 'unknown')),
        first_contact_observed INTEGER NOT NULL DEFAULT 0,
        manual_pause INTEGER NOT NULL DEFAULT 0,
        automation_blocked INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'inbound',
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS wa_labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS contact_labels (
        jid TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY (jid, label_id),
        FOREIGN KEY (jid) REFERENCES contacts(jid) ON DELETE CASCADE,
        FOREIGN KEY (label_id) REFERENCES wa_labels(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diagnostics_created ON diagnostics (created_at DESC, id DESC);
    `);
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === 'first_contact')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN first_contact INTEGER NOT NULL DEFAULT 0');
    }
    const contactColumns = this.db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>;
    if (!contactColumns.some((column) => column.name === 'eligibility')) {
      this.db.exec("ALTER TABLE contacts ADD COLUMN eligibility TEXT NOT NULL DEFAULT 'unknown'");
      this.db.exec("UPDATE contacts SET eligibility = CASE WHEN assignment = 'BOT' THEN 'eligible' ELSE 'unknown' END");
    }
    if (!contactColumns.some((column) => column.name === 'first_contact_observed')) {
      this.db.exec('ALTER TABLE contacts ADD COLUMN first_contact_observed INTEGER NOT NULL DEFAULT 0');
      this.db.exec('UPDATE contacts SET first_contact_observed = 1 WHERE jid IN (SELECT DISTINCT jid FROM messages WHERE first_contact = 1)');
    }
    if (!contactColumns.some((column) => column.name === 'manual_pause')) {
      this.db.exec('ALTER TABLE contacts ADD COLUMN manual_pause INTEGER NOT NULL DEFAULT 0');
    }
    if (!contactColumns.some((column) => column.name === 'automation_blocked')) {
      this.db.exec('ALTER TABLE contacts ADD COLUMN automation_blocked INTEGER NOT NULL DEFAULT 0');
    }
    const outboxSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get() as { sql?: string } | undefined)?.sql ?? '';
    if (!outboxSql.includes("'unknown'")) {
      this.db.exec('ALTER TABLE outbox RENAME TO outbox_legacy');
      this.db.exec(`CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        jid TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'blocked')),
        authorization_required INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        not_before INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      )`);
      this.db.exec("INSERT INTO outbox (id, dedupe_key, jid, body, status, created_at, sent_at) SELECT id, dedupe_key, jid, body, status, created_at, sent_at FROM outbox_legacy");
      this.db.exec('DROP TABLE outbox_legacy');
      this.db.exec('CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, not_before, id)');
    } else {
      const outboxColumns = this.db.prepare('PRAGMA table_info(outbox)').all() as Array<{ name: string }>;
      if (!outboxColumns.some((column) => column.name === 'authorization_required')) this.db.exec('ALTER TABLE outbox ADD COLUMN authorization_required INTEGER NOT NULL DEFAULT 1');
      if (!outboxColumns.some((column) => column.name === 'attempts')) this.db.exec('ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      if (!outboxColumns.some((column) => column.name === 'not_before')) this.db.exec('ALTER TABLE outbox ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0');
      if (!outboxColumns.some((column) => column.name === 'last_error')) this.db.exec('ALTER TABLE outbox ADD COLUMN last_error TEXT');
    }
    this.db.exec('DROP INDEX IF EXISTS outbox_pending; CREATE INDEX outbox_pending ON outbox (status, not_before, id)');
    this.db.exec("UPDATE outbox SET status = 'unknown', last_error = 'Resultado do envio desconhecido após reinício.' WHERE status = 'sending'");
    this.db.exec("UPDATE contacts SET assignment = 'PAUSADO', automation_blocked = 1, source = 'system-unknown-send' WHERE jid IN (SELECT jid FROM outbox WHERE status = 'unknown' AND authorization_required = 1)");
    this.db.prepare(
      "INSERT INTO diagnostics (jid, event, detail, created_at) SELECT DISTINCT outbox.jid, 'envio-incerto', 'Resultado do envio desconhecido recuperado após reinício; revisar antes de reativar.', ? FROM outbox WHERE status = 'unknown' AND authorization_required = 1 AND NOT EXISTS (SELECT 1 FROM diagnostics WHERE diagnostics.jid = outbox.jid AND diagnostics.event = 'envio-incerto' AND diagnostics.detail = 'Resultado do envio desconhecido recuperado após reinício; revisar antes de reativar.')",
    ).run(Date.now());

    // A process restart must not strand a job in the transient processing state.
    this.db
      .prepare(
        'UPDATE jobs SET status = ?, updated_at = ? WHERE status = ?',
      )
      .run('pending', Date.now(), 'processing');
  }

  setBatchWindowMs(milliseconds: number): void {
    this.batchWindowMs = milliseconds;
  }

  hasContact(jid: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM contacts WHERE jid = ?').get(jid));
  }

  hasStoredMessages(jid: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE jid = ? LIMIT 1').get(jid));
  }

  ensureContact(jid: string, assignment: ContactAssignment = 'PAUSADO', source = 'inbound'): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT OR IGNORE INTO contacts (jid, assignment, source, updated_at) VALUES (?, ?, ?, ?)',
    ).run(jid, assignment, source, now);
  }

  setContactAssignment(jid: string, assignment: ContactAssignment, source: string): void {
    this.ensureContact(jid, assignment, source);
    const previous = this.getContactAssignment(jid);
    const manualPause = assignment === 'PAUSADO' && ['panel-pause', 'panel', 'csv-import', 'manual'].includes(source);
    this.db.prepare(
      'UPDATE contacts SET assignment = ?, ' +
      "eligibility = CASE WHEN ? = 'BOT' THEN 'eligible' WHEN ? IN ('new-lead', 'whatsapp-label', 'new-lead-list-failed') AND ? = 'PAUSADO' THEN 'ineligible' ELSE eligibility END, " +
      'manual_pause = CASE WHEN ? = 1 THEN 1 WHEN ? = 1 THEN 0 ELSE manual_pause END, ' +
      'automation_blocked = CASE WHEN ? = 1 THEN 0 ELSE automation_blocked END, source = ?, updated_at = ? WHERE jid = ?',
    ).run(assignment, assignment, source, assignment, manualPause ? 1 : 0, assignment === 'BOT' || assignment === 'HUMANO' ? 1 : 0,
      assignment === 'BOT' && ['panel', 'csv-import', 'manual'].includes(source) ? 1 : 0, source, Date.now(), jid);
    if (previous !== assignment || (assignment === 'BOT' && !manualPause && ['panel', 'csv-import', 'whatsapp-label', 'new-lead'].includes(source))) {
      this.applyAssignmentToConversation(jid, assignment);
    }
  }

  getContactAssignment(jid: string): ContactAssignment | null {
    const row = this.db.prepare('SELECT assignment FROM contacts WHERE jid = ?').get(jid) as { assignment: ContactAssignment } | undefined;
    return row?.assignment ?? null;
  }

  getContactEligibility(jid: string): ContactEligibility {
    const row = this.db.prepare('SELECT eligibility FROM contacts WHERE jid = ?').get(jid) as { eligibility: ContactEligibility } | undefined;
    return row?.eligibility ?? 'unknown';
  }

  isManualPause(jid: string): boolean {
    const row = this.db.prepare('SELECT manual_pause FROM contacts WHERE jid = ?').get(jid) as { manual_pause: number } | undefined;
    return row?.manual_pause === 1;
  }

  isAutomationBlocked(jid: string): boolean {
    const row = this.db.prepare('SELECT automation_blocked FROM contacts WHERE jid = ?').get(jid) as { automation_blocked: number } | undefined;
    return row?.automation_blocked === 1;
  }

  blockAutomation(jid: string, source: string, assignment: ContactAssignment = 'PAUSADO'): void {
    this.ensureContact(jid, 'PAUSADO', source);
    const previous = this.getContactAssignment(jid);
    this.db.prepare('UPDATE contacts SET assignment = ?, automation_blocked = 1, source = ?, updated_at = ? WHERE jid = ?')
      .run(assignment, source, Date.now(), jid);
    if (previous !== assignment) this.applyAssignmentToConversation(jid, assignment);
  }

  isAuthorizedForAutomation(jid: string): boolean {
    if (this.getContactAssignment(jid) !== 'BOT' || this.getContactEligibility(jid) !== 'eligible' || this.isManualPause(jid) || this.isAutomationBlocked(jid)) return false;
    const state = this.getConversationState(jid);
    return !state.paused && !state.completed;
  }

  syncRemoteAssignment(jid: string, remote: ContactAssignment): ContactAssignment {
    this.ensureContact(jid, 'PAUSADO', 'whatsapp-label');
    const manualPause = this.isManualPause(jid);
    const automationBlocked = this.isAutomationBlocked(jid);
    const previous = this.getContactAssignment(jid);
    const assignment: ContactAssignment = remote === 'HUMANO' ? 'HUMANO' : remote === 'BOT' && !manualPause && !automationBlocked ? 'BOT' : 'PAUSADO';
    this.db.prepare(
      "UPDATE contacts SET assignment = ?, eligibility = ?, source = 'whatsapp-label', updated_at = ? WHERE jid = ?",
    ).run(assignment, remote === 'BOT' ? 'eligible' : 'ineligible', Date.now(), jid);
    if (previous !== assignment) this.applyAssignmentToConversation(jid, assignment);
    return assignment;
  }

  hasExplicitBotAssignment(jid: string): boolean {
    const row = this.db.prepare('SELECT assignment, source FROM contacts WHERE jid = ?').get(jid) as { assignment: ContactAssignment; source: string } | undefined;
    return row?.assignment === 'BOT' && ['panel', 'csv-import', 'whatsapp-label', 'new-lead'].includes(row.source);
  }

  getLabelIdByName(name: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM wa_labels WHERE upper(name) = upper(?) AND deleted = 0 ORDER BY id LIMIT 1').get(name) as { id: string } | undefined;
    return row?.id;
  }

  saveLabel(id: string, name: string, color = 0, deleted = false): string[] {
    this.db.prepare(
      'INSERT INTO wa_labels (id, name, color, deleted) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, deleted = excluded.deleted',
    ).run(id, name, color, deleted ? 1 : 0);
    const affected = this.db.prepare('SELECT DISTINCT jid FROM contact_labels WHERE label_id = ?').all(id) as Array<{ jid: string }>;
    const newlyBotAssigned: string[] = [];
    for (const contact of affected) {
      const result = this.recalculateContactAssignment(contact.jid);
      if (result.assignment === 'BOT' && result.previous !== 'BOT') newlyBotAssigned.push(contact.jid);
    }
    return newlyBotAssigned;
  }

  getLabelName(id: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM wa_labels WHERE id = ? AND deleted = 0').get(id) as { name: string } | undefined;
    return row?.name;
  }

  updateContactLabel(jid: string, labelId: string, name: string, add: boolean): void {
    if (!this.getLabelName(labelId)) this.saveLabel(labelId, name);
    this.ensureContact(jid, 'PAUSADO', 'whatsapp-label');
    const transaction = this.db.transaction(() => {
      if (add) {
        this.db.prepare('INSERT OR IGNORE INTO contact_labels (jid, label_id) VALUES (?, ?)').run(jid, labelId);
      } else {
        this.db.prepare('DELETE FROM contact_labels WHERE jid = ? AND label_id = ?').run(jid, labelId);
      }
    });
    transaction.immediate();
    this.recalculateContactAssignment(jid);
    this.recordDiagnostic(jid, 'etiqueta', `${add ? 'Adicionada' : 'Removida'}: ${name}`);
  }

  private recalculateContactAssignment(jid: string): { previous: ContactAssignment | null; assignment: ContactAssignment } {
    const names = this.db.prepare(
      'SELECT upper(l.name) AS name FROM contact_labels cl JOIN wa_labels l ON l.id = cl.label_id ' +
      'WHERE cl.jid = ? AND l.deleted = 0',
    ).all(jid) as Array<{ name: string }>;
    const normalized = names.map((label) => label.name.trim().toLocaleLowerCase('pt-BR'));
    const remoteAssignment: ContactAssignment = normalized.some((name) => name === 'atendimento' || name === 'humano')
      ? 'HUMANO'
      : normalized.some((name) => name === 'bot - atendimento') ? 'BOT' : 'PAUSADO';
    const previous = this.getContactAssignment(jid);
    const assignment = this.syncRemoteAssignment(jid, remoteAssignment);
    return { previous, assignment };
  }

  private applyAssignmentToConversation(jid: string, assignment: ContactAssignment): void {
    const state = this.getConversationState(jid);
    if (assignment === 'BOT') {
      state.paused = false;
      state.completed = false;
    } else {
      state.paused = true;
    }
    this.saveConversationState(jid, state);
  }

  setContactName(jid: string, name: string): void {
    this.ensureContact(jid);
    this.db.prepare('UPDATE contacts SET display_name = ?, updated_at = ? WHERE jid = ?').run(name, Date.now(), jid);
  }

  listContacts(): ContactRecord[] {
    return this.db.prepare(
      'SELECT jid, replace(replace(jid, \'@s.whatsapp.net\', \'\'), \'@lid\', \'\') AS phone, ' +
      'display_name AS displayName, assignment, eligibility, first_contact_observed AS firstContactObserved, ' +
      'manual_pause AS manualPause, automation_blocked AS automationBlocked, source, updated_at AS updatedAt, last_activity_at AS lastActivityAt ' +
      'FROM contacts ORDER BY coalesce(last_activity_at, updated_at) DESC LIMIT 1000',
    ).all().map((row) => {
      const contact = row as Omit<ContactRecord, 'firstContactObserved' | 'manualPause' | 'automationBlocked'> & { firstContactObserved: number; manualPause: number; automationBlocked: number };
      return { ...contact, firstContactObserved: Boolean(contact.firstContactObserved), manualPause: Boolean(contact.manualPause), automationBlocked: Boolean(contact.automationBlocked) };
    }) as ContactRecord[];
  }

  setContactActivity(jid: string, at: number): void {
    this.db.prepare('UPDATE contacts SET last_activity_at = ?, updated_at = ? WHERE jid = ?').run(at, Date.now(), jid);
  }

  recordDiagnostic(jid: string, event: string, detail = ''): void {
    const result = this.db.prepare('INSERT INTO diagnostics (jid, event, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(jid, event, detail.slice(0, 1000), Date.now());
    if (Number(result.lastInsertRowid) % 100 === 0) {
      this.db.prepare('DELETE FROM diagnostics WHERE id <= ?').run(Number(result.lastInsertRowid) - 10_000);
    }
  }

  queueConversationStart(jid: string): boolean {
    if (!this.isAuthorizedForAutomation(jid) || this.getUnprocessedMessages(jid).length === 0) return false;
    const active = this.db.prepare(
      "SELECT 1 FROM jobs WHERE jid = ? AND kind = 'process_conversation' AND status IN ('pending', 'processing') LIMIT 1",
    ).get(jid);
    if (active) return false;
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO jobs (jid, kind, status, not_before, created_at, updated_at) VALUES (?, 'process_conversation', 'pending', ?, ?, ?)",
    ).run(jid, now, now, now);
    this.recordDiagnostic(jid, 'na-fila', 'Mensagem pendente liberada após autorização explícita; nenhuma mensagem é iniciada sem contato prévio.');
    return true;
  }

  listDiagnostics(limit = 200): DiagnosticRecord[] {
    return this.db.prepare(
      'SELECT id, jid, event, detail, created_at AS createdAt FROM diagnostics ORDER BY id DESC LIMIT ?',
    ).all(Math.max(1, Math.min(500, limit))) as DiagnosticRecord[];
  }

  expireData(retentionDays: number): string[] {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const media = this.db.prepare(
      'SELECT media_path AS mediaPath FROM messages WHERE created_at < ? AND processed_at IS NOT NULL AND media_path IS NOT NULL',
    ).all(cutoff) as Array<{ mediaPath: string }>;
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE created_at < ? AND processed_at IS NOT NULL').run(cutoff);
      this.db.prepare("DELETE FROM jobs WHERE created_at < ? AND status IN ('done', 'failed')").run(cutoff);
      this.db.prepare("DELETE FROM outbox WHERE created_at < ? AND status IN ('sent', 'unknown', 'blocked')").run(cutoff);
      this.db.prepare('DELETE FROM diagnostics WHERE created_at < ?').run(cutoff);
      this.db.prepare(
        'DELETE FROM contacts WHERE coalesce(last_activity_at, updated_at) < ? ' +
        'AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.jid = contacts.jid AND messages.processed_at IS NULL) ' +
        "AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.jid = contacts.jid AND outbox.status IN ('pending', 'sending'))",
      ).run(cutoff);
      this.db.prepare('DELETE FROM conversations WHERE jid NOT IN (SELECT jid FROM contacts)').run();
      this.db.prepare("DELETE FROM jobs WHERE status IN ('pending', 'processing') AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.jid = jobs.jid AND messages.processed_at IS NULL)").run();
    });
    transaction.immediate();
    return media.map((item) => item.mediaPath);
  }

  saveIncoming(message: IncomingMessage): boolean {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO messages ' +
            '(message_key, jid, direction, kind, body, media_path, created_at, first_contact) ' +
            "VALUES (?, ?, 'inbound', ?, ?, ?, ?, CASE WHEN NOT EXISTS (SELECT 1 FROM messages WHERE jid = ?) THEN 1 ELSE 0 END)",
        )
        .run(
          message.key,
          message.jid,
          message.kind,
          message.body,
          message.mediaPath,
          message.createdAt,
          message.jid,
        );

      // Duplicate socket events are harmless and do not reschedule a reply.
      if (inserted.changes === 0) return false;

      this.ensureContact(message.jid, 'PAUSADO', 'inbound');
      const firstContact = Boolean((this.db.prepare('SELECT first_contact FROM messages WHERE message_key = ?').get(message.key) as { first_contact: number } | undefined)?.first_contact);
      this.db.prepare(
        'UPDATE contacts SET first_contact_observed = CASE WHEN ? = 1 THEN 1 ELSE first_contact_observed END, last_activity_at = ?, updated_at = ? WHERE jid = ?',
      ).run(firstContact ? 1 : 0, message.createdAt, now, message.jid);
      this.recordDiagnostic(message.jid, 'recebida', message.kind + (firstContact ? '; primeiro contato observado pelo sistema' : ''));

      const pending = this.db
        .prepare(
          'SELECT id FROM jobs ' +
            'WHERE jid = ? AND kind = ? AND status = ? ' +
            'ORDER BY id DESC LIMIT 1',
        )
        .get(message.jid, 'process_conversation', 'pending') as
        | { id: number }
        | undefined;

      if (pending) {
        this.db
          .prepare('UPDATE jobs SET not_before = ?, updated_at = ? WHERE id = ?')
          .run(now + this.batchWindowMs, now, pending.id);
      } else {
        this.db
          .prepare(
            'INSERT INTO jobs (jid, kind, status, not_before, created_at, updated_at) ' +
              "VALUES (?, 'process_conversation', 'pending', ?, ?, ?)",
          )
          .run(message.jid, now + this.batchWindowMs, now, now);
      }
      this.recordDiagnostic(message.jid, 'na-fila', 'Aguardando processamento');
      return true;
    });
    return transaction.immediate();
  }

  isFirstContact(jid: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS found FROM messages WHERE jid = ? AND first_contact = 1 LIMIT 1')
      .get(jid) as { found: number } | undefined;
    return row !== undefined;
  }

  claimDueJob(now = Date.now()): QueueJob | null {
    const transaction = this.db.transaction(() => {
      const job = this.db
        .prepare(
          'SELECT id, jid, kind, attempts FROM jobs ' +
            'WHERE status = ? AND not_before <= ? ' +
            'ORDER BY not_before, id LIMIT 1',
        )
        .get('pending', now) as QueueJob | undefined;
      if (!job) return null;
      this.db
        .prepare(
          'UPDATE jobs SET status = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?',
        )
        .run('processing', now, job.id);
      return { ...job, attempts: job.attempts + 1 };
    });
    return transaction.immediate();
  }

  getUnprocessedMessages(jid: string): StoredMessage[] {
    return this.db
      .prepare(
        'SELECT id, message_key AS key, jid, direction, kind, body, ' +
          'media_path AS mediaPath, created_at AS createdAt, ' +
          'processed_at AS processedAt FROM messages ' +
          "WHERE jid = ? AND direction = 'inbound' AND processed_at IS NULL " +
          'ORDER BY created_at, id',
      )
      .all(jid) as StoredMessage[];
  }

  getRecentMessages(jid: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        'SELECT id, message_key AS key, jid, direction, kind, body, ' +
          'media_path AS mediaPath, created_at AS createdAt, ' +
          'processed_at AS processedAt FROM messages WHERE jid = ? ' +
          'ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(jid, limit) as StoredMessage[];
    return rows.reverse();
  }

  saveTranscript(messageId: number, transcript: string): void {
    this.db
      .prepare('UPDATE messages SET body = ?, media_path = NULL WHERE id = ?')
      .run(transcript, messageId);
  }

  clearMessageMedia(ids: number[]): string[] {
    if (ids.length === 0) return [];
    const select = this.db.prepare('SELECT media_path AS mediaPath FROM messages WHERE id = ? AND media_path IS NOT NULL');
    const clear = this.db.prepare('UPDATE messages SET media_path = NULL WHERE id = ?');
    const paths: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        const row = select.get(id) as { mediaPath: string } | undefined;
        if (row) paths.push(row.mediaPath);
        clear.run(id);
      }
    });
    transaction.immediate();
    return paths;
  }

  markMessagesProcessed(ids: number[]): void {
    if (ids.length === 0) return;
    const update = this.db.prepare(
      'UPDATE messages SET processed_at = ? WHERE id = ?',
    );
    const transaction = this.db.transaction(() => {
      for (const id of ids) update.run(Date.now(), id);
    });
    transaction.immediate();
  }

  getConversationState(jid: string): ConversationState {
    const row = this.db
      .prepare('SELECT state_json FROM conversations WHERE jid = ?')
      .get(jid) as { state_json: string } | undefined;
    if (!row) return structuredClone(EMPTY_STATE);
    try {
      return { ...EMPTY_STATE, ...JSON.parse(row.state_json) } as ConversationState;
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  saveConversationState(jid: string, state: ConversationState): void {
    this.db
      .prepare(
        'INSERT INTO conversations (jid, state_json, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(jid) DO UPDATE SET ' +
          'state_json = excluded.state_json, updated_at = excluded.updated_at',
      )
      .run(jid, JSON.stringify(state), Date.now());
  }

  queueOutbound(dedupeKey: string, jid: string, body: string, authorizationRequired = true): number {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox (dedupe_key, jid, body, status, authorization_required, created_at) " +
          "VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(dedupeKey, jid, body, authorizationRequired ? 1 : 0, Date.now());
    const row = this.db
      .prepare('SELECT id FROM outbox WHERE dedupe_key = ?')
      .get(dedupeKey) as { id: number };
    return row.id;
  }

  isOutboundSent(id: number): boolean {
    const row = this.db
      .prepare('SELECT status, not_before AS notBefore FROM outbox WHERE id = ?')
      .get(id) as { status: string; notBefore: number } | undefined;
    return !row || row.status !== 'pending' || row.notBefore > Date.now();
  }

  getOutboundStatus(dedupeKey: string): 'pending' | 'sending' | 'sent' | 'unknown' | 'blocked' | null {
    const row = this.db.prepare('SELECT status FROM outbox WHERE dedupe_key = ?').get(dedupeKey) as { status: 'pending' | 'sending' | 'sent' | 'unknown' | 'blocked' } | undefined;
    return row?.status ?? null;
  }

  markOutboundSending(id: number): void {
    this.db.prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1, last_error = NULL WHERE id = ? AND status = 'pending' AND not_before <= ?").run(id, Date.now());
  }

  markOutboundSent(id: number): void {
    this.db
      .prepare("UPDATE outbox SET status = ?, sent_at = ?, last_error = NULL WHERE id = ?")
      .run('sent', Date.now(), id);
  }

  markOutboundUnknown(id: number, reason: string): void {
    this.db.prepare("UPDATE outbox SET status = 'unknown', last_error = ? WHERE id = ?").run(reason.slice(0, 300), id);
  }

  markOutboundBlocked(id: number, reason: string): void {
    this.db.prepare("UPDATE outbox SET status = 'blocked', last_error = ? WHERE id = ?").run(reason.slice(0, 300), id);
  }

  retryOutbound(id: number, delayMs: number, reason: string): void {
    this.db.prepare("UPDATE outbox SET status = 'pending', not_before = ?, last_error = ? WHERE id = ?")
      .run(Date.now() + Math.max(1_000, Math.min(delayMs, 24 * 60 * 60 * 1000)), reason.slice(0, 300), id);
  }

  pendingOutbox(limit = 20): Array<{ id: number; jid: string; body: string; authorizationRequired: boolean; attempts: number }> {
    return this.db
      .prepare(
        "SELECT id, jid, body, authorization_required AS authorizationRequired, attempts FROM outbox WHERE status = 'pending' AND not_before <= ? ORDER BY id LIMIT ?",
      )
      .all(Date.now(), limit).map((row) => {
        const item = row as { id: number; jid: string; body: string; authorizationRequired: number; attempts: number };
        return { ...item, authorizationRequired: Boolean(item.authorizationRequired) };
      });
  }

  outboundLimitReason(jid: string, limits: OutboundRateLimits, authorizationRequired: boolean, excludeId?: number, checkInterval = true): string | null {
    const now = Date.now();
    const excludedId = excludeId ?? -1;
    const count = (sql: string, ...values: (string | number)[]) => {
      const row = this.db.prepare(sql).get(...values) as { count: number };
      return row.count;
    };
    const active = "status IN ('pending', 'sending', 'sent', 'unknown') AND id != ?";
    if (count(`SELECT count(*) AS count FROM outbox WHERE ${active} AND created_at >= ?`, excludedId, now - 30 * 24 * 60 * 60 * 1000) >= limits.globalMonth) return 'Limite mensal total de mensagens atingido.';
    if (count(`SELECT count(*) AS count FROM outbox WHERE ${active} AND created_at >= ?`, excludedId, now - 24 * 60 * 60 * 1000) >= limits.globalDay) return 'Limite diário total de mensagens atingido.';
    if (!authorizationRequired) return null;
    const contactCount = (windowMs: number) => count(
      `SELECT count(*) AS count FROM outbox WHERE ${active} AND authorization_required = 1 AND jid = ? AND created_at >= ?`,
      excludedId, jid, now - windowMs,
    );
    if (contactCount(30 * 24 * 60 * 60 * 1000) >= limits.perContactMonth) return 'Limite mensal de mensagens para o contato atingido.';
    if (contactCount(24 * 60 * 60 * 1000) >= limits.perContactDay) return 'Limite diário de mensagens para o contato atingido.';
    if (checkInterval && limits.minSecondsBetweenContactMessages > 0) {
      const latest = this.db.prepare(
        `SELECT max(coalesce(sent_at, created_at)) AS at FROM outbox WHERE ${active} AND authorization_required = 1 AND jid = ?`,
      ).get(excludedId, jid) as { at: number | null };
      if (latest.at !== null && latest.at + limits.minSecondsBetweenContactMessages * 1000 > now) return 'Intervalo mínimo entre mensagens do contato ainda não terminou.';
    }
    return null;
  }

  completeJob(id: number): void {
    this.db
      .prepare(
        'UPDATE jobs SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?',
      )
      .run('done', Date.now(), id);
  }

  retryJob(id: number, attempts: number, error: string, maxAttempts: number): boolean {
    const now = Date.now();
    const failed = attempts >= maxAttempts;
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
    this.db
      .prepare(
        'UPDATE jobs SET status = ?, not_before = ?, last_error = ?, updated_at = ? WHERE id = ?',
      )
      .run(failed ? 'failed' : 'pending', now + delayMs, error.slice(0, 300), now, id);
    return failed;
  }

  deferJob(id: number, delayMs: number, reason: string): void {
    const now = Date.now();
    const safeDelay = Math.max(60_000, Math.min(delayMs, 7 * 24 * 60 * 60 * 1000));
    this.db
      .prepare(
        "UPDATE jobs SET status = 'pending', attempts = 0, not_before = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(now + safeDelay, reason.slice(0, 300), now, id);
  }

  close(): void {
    this.db.close();
  }
}
