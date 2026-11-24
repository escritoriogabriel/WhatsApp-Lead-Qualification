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
}

export interface QueueJob {
  id: number;
  jid: string;
  attempts: number;
}

export type ContactAssignment = 'BOT' | 'HUMANO' | 'PAUSADO';

export interface ContactRecord {
  jid: string;
  phone: string;
  displayName: string | null;
  assignment: ContactAssignment;
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

const EMPTY_STATE: ConversationState = {
  profileId: null,
  fields: {},
  skippedFields: [],
  attempts: {},
  pendingFieldId: null,
  paused: false,
  completed: false,
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_pending
        ON outbox (status, id);
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        display_name TEXT,
        assignment TEXT NOT NULL DEFAULT 'PAUSADO'
          CHECK (assignment IN ('BOT', 'HUMANO', 'PAUSADO')),
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
    this.db.prepare('UPDATE contacts SET assignment = ?, source = ?, updated_at = ? WHERE jid = ?')
      .run(assignment, source, Date.now(), jid);
    if (previous !== assignment || (assignment === 'BOT' && ['panel', 'csv-import'].includes(source))) {
      this.applyAssignmentToConversation(jid, assignment);
    }
  }

  getContactAssignment(jid: string): ContactAssignment | null {
    const row = this.db.prepare('SELECT assignment FROM contacts WHERE jid = ?').get(jid) as { assignment: ContactAssignment } | undefined;
    return row?.assignment ?? null;
  }

  hasExplicitBotAssignment(jid: string): boolean {
    const row = this.db.prepare('SELECT assignment, source FROM contacts WHERE jid = ?').get(jid) as { assignment: ContactAssignment; source: string } | undefined;
    return row?.assignment === 'BOT' && ['panel', 'csv-import', 'whatsapp-label', 'new-lead'].includes(row.source);
  }

  getLabelIdByName(name: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM wa_labels WHERE upper(name) = upper(?) AND deleted = 0 ORDER BY id LIMIT 1').get(name) as { id: string } | undefined;
    return row?.id;
  }

  saveLabel(id: string, name: string, color = 0, deleted = false): void {
    this.db.prepare(
      'INSERT INTO wa_labels (id, name, color, deleted) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, deleted = excluded.deleted',
    ).run(id, name, color, deleted ? 1 : 0);
    const affected = this.db.prepare('SELECT DISTINCT jid FROM contact_labels WHERE label_id = ?').all(id) as Array<{ jid: string }>;
    for (const contact of affected) this.recalculateContactAssignment(contact.jid);
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

  private recalculateContactAssignment(jid: string): void {
    const names = this.db.prepare(
      'SELECT upper(l.name) AS name FROM contact_labels cl JOIN wa_labels l ON l.id = cl.label_id ' +
      'WHERE cl.jid = ? AND l.deleted = 0',
    ).all(jid) as Array<{ name: string }>;
    const normalized = names.map((label) => label.name.trim().toLocaleLowerCase('pt-BR'));
    const assignment: ContactAssignment = normalized.some((name) => name === 'atendimento' || name === 'humano')
      ? 'HUMANO'
      : normalized.some((name) => name === 'bot - atendimento') ? 'BOT' : 'PAUSADO';
    const previous = this.getContactAssignment(jid);
    this.db.prepare('UPDATE contacts SET assignment = ?, source = ?, updated_at = ? WHERE jid = ?')
      .run(assignment, 'whatsapp-label', Date.now(), jid);
    if (previous !== assignment) this.applyAssignmentToConversation(jid, assignment);
  }

  private applyAssignmentToConversation(jid: string, assignment: ContactAssignment): void {
    const state = this.getConversationState(jid);
    if (assignment === 'BOT') {
      state.paused = false;
      state.completed = false;
      state.pendingFieldId = null;
      state.skippedFields = [];
      state.attempts = {};
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
      'display_name AS displayName, assignment, source, updated_at AS updatedAt, last_activity_at AS lastActivityAt ' +
      'FROM contacts ORDER BY coalesce(last_activity_at, updated_at) DESC LIMIT 1000',
    ).all() as ContactRecord[];
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

  listDiagnostics(limit = 200): DiagnosticRecord[] {
    return this.db.prepare(
      'SELECT id, jid, event, detail, created_at AS createdAt FROM diagnostics ORDER BY id DESC LIMIT ?',
    ).all(Math.max(1, Math.min(500, limit))) as DiagnosticRecord[];
  }

  saveIncoming(message: IncomingMessage): void {
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
      if (inserted.changes === 0) return;

      this.db.prepare(
        'UPDATE contacts SET last_activity_at = ?, updated_at = ? WHERE jid = ?',
      ).run(message.createdAt, now, message.jid);
      this.db.prepare(
        'INSERT OR IGNORE INTO contacts (jid, assignment, source, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?)',
      ).run(message.jid, 'PAUSADO', 'inbound', now, message.createdAt);
      this.recordDiagnostic(message.jid, 'recebida', message.kind);

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
    });
    transaction.immediate();
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
          'SELECT id, jid, attempts FROM jobs ' +
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

  queueOutbound(dedupeKey: string, jid: string, body: string): number {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox (dedupe_key, jid, body, status, created_at) " +
          "VALUES (?, ?, ?, 'pending', ?)",
      )
      .run(dedupeKey, jid, body, Date.now());
    const row = this.db
      .prepare('SELECT id FROM outbox WHERE dedupe_key = ?')
      .get(dedupeKey) as { id: number };
    return row.id;
  }

  isOutboundSent(id: number): boolean {
    const row = this.db
      .prepare('SELECT status FROM outbox WHERE id = ?')
      .get(id) as { status: string } | undefined;
    return row?.status === 'sent';
  }

  markOutboundSent(id: number): void {
    this.db
      .prepare('UPDATE outbox SET status = ?, sent_at = ? WHERE id = ?')
      .run('sent', Date.now(), id);
  }

  pendingOutbox(limit = 20): Array<{ id: number; jid: string; body: string }> {
    return this.db
      .prepare(
        "SELECT id, jid, body FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ?",
      )
      .all(limit) as Array<{ id: number; jid: string; body: string }>;
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

  close(): void {
    this.db.close();
  }
}
