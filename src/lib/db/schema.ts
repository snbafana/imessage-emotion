import Database from 'better-sqlite3'

export type AppDatabase = Database.Database

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
      handle_identifier TEXT NOT NULL UNIQUE,
      normalized_handle TEXT NOT NULL,
      service TEXT,
      display_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
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

    CREATE TABLE IF NOT EXISTS window_configs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      message_count INTEGER NOT NULL,
      stride INTEGER NOT NULL,
      min_tail_messages INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      CHECK (message_count > 0),
      CHECK (stride > 0),
      CHECK (min_tail_messages > 0)
    );

    CREATE TABLE IF NOT EXISTS windows (
      id INTEGER PRIMARY KEY,
      window_config_id INTEGER NOT NULL REFERENCES window_configs(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      start_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      end_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      deterministic_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      CHECK (start_ordinal <= end_ordinal),
      UNIQUE (window_config_id, conversation_id, start_ordinal, end_ordinal)
    );

    CREATE INDEX IF NOT EXISTS windows_conversation_order_idx
      ON windows(conversation_id, start_ordinal, end_ordinal);

    CREATE TABLE IF NOT EXISTS scorer_configs (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id INTEGER PRIMARY KEY,
      scorer_config_id INTEGER NOT NULL REFERENCES scorer_configs(id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS run_windows (
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (run_id, window_id)
    );

    CREATE TABLE IF NOT EXISTS window_results (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
      scorer_config_id INTEGER NOT NULL REFERENCES scorer_configs(id) ON DELETE RESTRICT,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (run_id, window_id)
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      from_window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
      to_window_id INTEGER NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `)
}
