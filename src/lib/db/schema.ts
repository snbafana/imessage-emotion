import Database from 'better-sqlite3'

export type AppDatabase = Database.Database

export interface PrivacySafeCounts {
  conversations: number
  messages: number
  contacts: number
  resolvedContacts: number
  lastMessageAt: number | null
  lastImportedAt: number | null
}

export function openAppDatabase(path: string): AppDatabase {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db: AppDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      handle_identifier TEXT NOT NULL,
      normalized_handle TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT 'iMessage',
      display_name TEXT,
      company TEXT,
      avatar_url TEXT,
      source_contact_id TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (normalized_handle, service)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      source_chat_id INTEGER NOT NULL UNIQUE,
      chat_identifier TEXT NOT NULL,
      display_name TEXT,
      is_group INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_message_at INTEGER,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      conversation_ordinal INTEGER NOT NULL,
      source_rowid INTEGER NOT NULL,
      guid TEXT NOT NULL UNIQUE,
      sender_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      text TEXT,
      sent_at INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL,
      is_read INTEGER NOT NULL,
      read_at INTEGER,
      status TEXT NOT NULL,
      error_code INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (conversation_id, conversation_ordinal),
      UNIQUE (conversation_id, source_rowid)
    );

    CREATE INDEX IF NOT EXISTS messages_conversation_order_idx
      ON messages(conversation_id, conversation_ordinal);
    CREATE INDEX IF NOT EXISTS messages_conversation_time_idx
      ON messages(conversation_id, sent_at, source_rowid, guid);

    CREATE TABLE IF NOT EXISTS import_state (
      source TEXT PRIMARY KEY,
      last_rowid INTEGER NOT NULL DEFAULT 0,
      last_imported_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `)

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS windows (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      context_start_ordinal INTEGER,
      context_end_ordinal INTEGER,
      focal_start_ordinal INTEGER NOT NULL,
      focal_end_ordinal INTEGER NOT NULL,
      start_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      end_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      message_count INTEGER NOT NULL,
      context_message_count INTEGER NOT NULL DEFAULT 0,
      focal_message_count INTEGER NOT NULL,
      window_metadata_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      shift_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      CHECK (start_ordinal <= end_ordinal),
      CHECK (focal_start_ordinal <= focal_end_ordinal),
      UNIQUE (run_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS windows_conversation_order_idx
      ON windows(conversation_id, start_ordinal, end_ordinal);
    CREATE INDEX IF NOT EXISTS windows_run_order_idx
      ON windows(run_id, ordinal);

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      method_key TEXT NOT NULL,
      status TEXT NOT NULL,
      window_config_json TEXT NOT NULL,
      context_config_json TEXT NOT NULL,
      scorer_config_json TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx
      ON analysis_runs(conversation_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS window_labels (
      id INTEGER PRIMARY KEY,
      window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
      labeler TEXT NOT NULL DEFAULT 'human',
      dominant TEXT,
      acceptable_dominants_json TEXT NOT NULL DEFAULT '[]',
      scores_json TEXT NOT NULL DEFAULT '{}',
      requires_context INTEGER,
      sarcasm_or_subtext INTEGER,
      ambiguity TEXT,
      state_label TEXT,
      evidence_message_refs_json TEXT NOT NULL DEFAULT '[]',
      pivotal_message_refs_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (window_id, labeler)
    );
    CREATE INDEX IF NOT EXISTS window_labels_window_idx
      ON window_labels(window_id);
  `)

  ensureContactsFts(db)
}

// Full-text search index over contacts, used by the sidebar "Search people"
// box. It is an FTS5 external-content table (content='contacts') so the rows
// are not duplicated — the index just points back at contacts by rowid — and
// triggers keep it in lockstep with INSERT/UPDATE/DELETE on contacts.
function ensureContactsFts(db: AppDatabase): void {
  const created = !tableExists(db, 'contacts_fts')

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
      display_name,
      handle_identifier,
      normalized_handle,
      company,
      content='contacts',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS contacts_fts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO contacts_fts(rowid, display_name, handle_identifier, normalized_handle, company)
      VALUES (new.id, new.display_name, new.handle_identifier, new.normalized_handle, new.company);
    END;

    CREATE TRIGGER IF NOT EXISTS contacts_fts_ad AFTER DELETE ON contacts BEGIN
      INSERT INTO contacts_fts(contacts_fts, rowid, display_name, handle_identifier, normalized_handle, company)
      VALUES ('delete', old.id, old.display_name, old.handle_identifier, old.normalized_handle, old.company);
    END;

    CREATE TRIGGER IF NOT EXISTS contacts_fts_au AFTER UPDATE ON contacts BEGIN
      INSERT INTO contacts_fts(contacts_fts, rowid, display_name, handle_identifier, normalized_handle, company)
      VALUES ('delete', old.id, old.display_name, old.handle_identifier, old.normalized_handle, old.company);
      INSERT INTO contacts_fts(rowid, display_name, handle_identifier, normalized_handle, company)
      VALUES (new.id, new.display_name, new.handle_identifier, new.normalized_handle, new.company);
    END;
  `)

  // When the index is created on a DB that already holds contacts (the upgrade
  // path), backfill it from the content table. 'rebuild' re-reads all of
  // contacts; on a brand-new DB it is a cheap no-op.
  if (created) {
    db.exec(`INSERT INTO contacts_fts(contacts_fts) VALUES('rebuild');`)
  }
}

function tableExists(db: AppDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found: number } | undefined
  return row !== undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function getPrivacySafeCounts(db: AppDatabase): PrivacySafeCounts {
  const row = db
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM conversations) AS conversations,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM contacts) AS contacts,
        (SELECT COUNT(*) FROM contacts WHERE resolved_at IS NOT NULL) AS resolved_contacts,
        (SELECT MAX(sent_at) FROM messages) AS last_message_at,
        (SELECT MAX(last_imported_at) FROM import_state) AS last_imported_at
    `,
    )
    .get() as {
    conversations: number
    messages: number
    contacts: number
    resolved_contacts: number
    last_message_at: number | null
    last_imported_at: number | null
  }

  return {
    conversations: numberValue(row.conversations),
    messages: numberValue(row.messages),
    contacts: numberValue(row.contacts),
    resolvedContacts: numberValue(row.resolved_contacts),
    lastMessageAt: row.last_message_at,
    lastImportedAt: row.last_imported_at,
  }
}
