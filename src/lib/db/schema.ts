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

    CREATE TABLE IF NOT EXISTS window_configs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      message_count INTEGER NOT NULL,
      stride INTEGER NOT NULL,
      min_tail_messages INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      CHECK (message_count > 0),
      CHECK (stride > 0),
      CHECK (min_tail_messages > 0),
      CHECK (stride <= message_count),
      CHECK (min_tail_messages <= message_count)
    );

    CREATE TABLE IF NOT EXISTS windows (
      id INTEGER PRIMARY KEY,
      run_id INTEGER REFERENCES analysis_runs(id) ON DELETE CASCADE,
      window_config_id INTEGER NOT NULL REFERENCES window_configs(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal INTEGER,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      context_start_ordinal INTEGER,
      context_end_ordinal INTEGER,
      focal_start_ordinal INTEGER,
      focal_end_ordinal INTEGER,
      start_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      end_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      context_message_count INTEGER NOT NULL DEFAULT 0,
      focal_message_count INTEGER,
      window_metadata_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      shift_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      error TEXT,
      deterministic_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      CHECK (start_ordinal <= end_ordinal)
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
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      method_key TEXT NOT NULL DEFAULT 'legacy',
      window_config_json TEXT NOT NULL DEFAULT '{}',
      context_config_json TEXT NOT NULL DEFAULT '{}',
      scorer_config_json TEXT NOT NULL DEFAULT '{}',
      summary_json TEXT NOT NULL DEFAULT '{}',
      scorer_config_id INTEGER REFERENCES scorer_configs(id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      notes TEXT,
      error TEXT
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
  addRunOwnedAnalysisColumns(db)
}

function addRunOwnedAnalysisColumns(db: AppDatabase): void {
  const columns = (table: string) =>
    new Set(
      (
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    )

  const analysisRunColumns = columns('analysis_runs')
  addColumnIfMissing(
    db,
    analysisRunColumns,
    'analysis_runs',
    'conversation_id',
    'INTEGER REFERENCES conversations(id) ON DELETE CASCADE',
  )
  addColumnIfMissing(db, analysisRunColumns, 'analysis_runs', 'method_key', "TEXT NOT NULL DEFAULT 'legacy'")
  addColumnIfMissing(
    db,
    analysisRunColumns,
    'analysis_runs',
    'window_config_json',
    "TEXT NOT NULL DEFAULT '{}'",
  )
  addColumnIfMissing(
    db,
    analysisRunColumns,
    'analysis_runs',
    'context_config_json',
    "TEXT NOT NULL DEFAULT '{}'",
  )
  addColumnIfMissing(
    db,
    analysisRunColumns,
    'analysis_runs',
    'scorer_config_json',
    "TEXT NOT NULL DEFAULT '{}'",
  )
  addColumnIfMissing(
    db,
    analysisRunColumns,
    'analysis_runs',
    'summary_json',
    "TEXT NOT NULL DEFAULT '{}'",
  )
  addColumnIfMissing(db, analysisRunColumns, 'analysis_runs', 'error', 'TEXT')

  const windowColumns = columns('windows')
  addColumnIfMissing(db, windowColumns, 'windows', 'run_id', 'INTEGER REFERENCES analysis_runs(id) ON DELETE CASCADE')
  addColumnIfMissing(db, windowColumns, 'windows', 'ordinal', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'context_start_ordinal', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'context_end_ordinal', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'focal_start_ordinal', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'focal_end_ordinal', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'context_message_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, windowColumns, 'windows', 'focal_message_count', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'window_metadata_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumnIfMissing(db, windowColumns, 'windows', 'result_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumnIfMissing(db, windowColumns, 'windows', 'shift_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumnIfMissing(db, windowColumns, 'windows', 'status', "TEXT NOT NULL DEFAULT 'pending'")
  addColumnIfMissing(db, windowColumns, 'windows', 'latency_ms', 'INTEGER')
  addColumnIfMissing(db, windowColumns, 'windows', 'error', 'TEXT')
}

function addColumnIfMissing(
  db: AppDatabase,
  columns: Set<string>,
  table: string,
  column: string,
  definition: string,
): void {
  if (columns.has(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  columns.add(column)
}
