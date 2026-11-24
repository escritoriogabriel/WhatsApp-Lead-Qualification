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

  constructor(databasePath: string, private readonly batchWindowMs: number) {
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
        processed_at INTEGER
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
    `);

    // A process restart must not strand a job in the transient processing state.
    this.db
      .prepare(
        'UPDATE jobs SET status = ?, updated_at = ? WHERE status = ?',
      )
      .run('pending', Date.now(), 'processing');
  }

  saveIncoming(message: IncomingMessage): void {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO messages ' +
            '(message_key, jid, direction, kind, body, media_path, created_at) ' +
            "VALUES (?, ?, 'inbound', ?, ?, ?, ?)",
        )
        .run(
          message.key,
          message.jid,
          message.kind,
          message.body,
          message.mediaPath,
          message.createdAt,
        );

      // Duplicate socket events are harmless and do not reschedule a reply.
      if (inserted.changes === 0) return;

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
    });
    transaction.immediate();
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
