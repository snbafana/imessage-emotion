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

  resetLegacyAnalysisTables(db)

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
  `)
}

function resetLegacyAnalysisTables(db: AppDatabase): void {
  if (!tableExists(db, 'windows')) return
  const hasRunOwnedShape =
    tableHasColumn(db, 'windows', 'run_id') &&
    tableHasColumn(db, 'windows', 'focal_start_ordinal') &&
    !tableHasColumn(db, 'windows', 'window_config_id') &&
    !tableHasColumn(db, 'windows', 'deterministic_key')
  if (hasRunOwnedShape) return

  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS shifts;
    DROP TABLE IF EXISTS window_results;
    DROP TABLE IF EXISTS run_windows;
    DROP TABLE IF EXISTS analysis_runs;
    DROP TABLE IF EXISTS windows;
    DROP TABLE IF EXISTS scorer_configs;
    DROP TABLE IF EXISTS window_configs;
    PRAGMA foreign_keys = ON;
  `)
}

function tableExists(db: AppDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found: number } | undefined
  return row !== undefined
}

function tableHasColumn(db: AppDatabase, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}
