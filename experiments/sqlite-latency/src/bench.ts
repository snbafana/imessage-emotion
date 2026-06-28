import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

type Variant = "pk_only" | "message_ordinal" | "app_indexes";
type Operation =
  | "schema_bootstrap"
  | "bulk_insert_raw"
  | "assign_ordinals"
  | "create_windows"
  | "fetch_one_window"
  | "fetch_1k_windows"
  | "insert_analysis"
  | "query_latest_run";

type IterationResult = {
  runtime: "typescript-better-sqlite3";
  variant: Variant;
  iteration: number;
  dbPath: string;
  versions: Record<string, string>;
  timingsMs: Record<Operation, number>;
  counts: Record<string, number>;
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP_DIR = join(ROOT, "tmp", "typescript");
const RESULTS_DIR = join(ROOT, "results");
const MESSAGE_COUNT = 100_000;
const CONVERSATION_COUNT = 5;
const CONTACT_COUNT = 50;
const HISTORICAL_RUN_COUNT = 500;
const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;
const VARIANTS: Variant[] = ["pk_only", "message_ordinal", "app_indexes"];
const BASE_TIME_MS = Date.UTC(2026, 0, 1);
const require = createRequire(import.meta.url);
const betterSqlite3Package = require("better-sqlite3/package.json") as { version: string };

class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextInt(maxExclusive: number): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state % maxExclusive;
  }
}

function time<T>(timings: Record<string, number>, name: Operation, run: () => T): T {
  const start = performance.now();
  const result = run();
  timings[name] = performance.now() - start;
  return result;
}

function createDb(dbPath: string): Database.Database {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");
  return db;
}

function createSchema(db: Database.Database, variant: Variant) {
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      display_name TEXT NOT NULL,
      handle TEXT NOT NULL UNIQUE
    );

    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL
    );

    CREATE TABLE conversation_participants (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      PRIMARY KEY (conversation_id, contact_id)
    );

    CREATE TABLE raw_messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      sent_at_ms INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      ordinal INTEGER NOT NULL,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      sent_at_ms INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE import_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_raw_message_id INTEGER NOT NULL,
      imported_at_ms INTEGER NOT NULL
    );

    CREATE TABLE window_configs (
      id INTEGER PRIMARY KEY,
      size INTEGER NOT NULL,
      stride INTEGER NOT NULL,
      label TEXT NOT NULL UNIQUE
    );

    CREATE TABLE windows (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      window_config_id INTEGER NOT NULL REFERENCES window_configs(id),
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL
    );

    CREATE TABLE analysis_runs (
      id INTEGER PRIMARY KEY,
      started_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      model TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE run_windows (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
      window_id INTEGER NOT NULL REFERENCES windows(id),
      status TEXT NOT NULL
    );

    CREATE TABLE window_results (
      id INTEGER PRIMARY KEY,
      run_window_id INTEGER NOT NULL REFERENCES run_windows(id),
      score REAL NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL
    );

    CREATE TABLE shifts (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
      from_window_id INTEGER NOT NULL REFERENCES windows(id),
      to_window_id INTEGER NOT NULL REFERENCES windows(id),
      magnitude REAL NOT NULL,
      direction TEXT NOT NULL
    );
  `);

  if (variant === "message_ordinal" || variant === "app_indexes") {
    db.exec("CREATE UNIQUE INDEX messages_conversation_ordinal ON messages(conversation_id, ordinal);");
  }

  if (variant === "app_indexes") {
    db.exec(`
      CREATE INDEX windows_conversation_config_range
        ON windows(conversation_id, window_config_id, start_ordinal, end_ordinal);
      CREATE INDEX run_windows_run_window ON run_windows(run_id, window_id);
      CREATE INDEX window_results_run_window ON window_results(run_window_id);
      CREATE INDEX shifts_conversation_run ON shifts(conversation_id, run_id);
      CREATE INDEX analysis_runs_latest ON analysis_runs(status, completed_at_ms DESC, id DESC);
    `);
  }
}

function textForMessage(i: number): string {
  const base = `message ${i} checking in about dinner, timing, and weekend plans`;
  if (i % 100 === 0) {
    return `${base}. ${"longer context with emotional nuance and a few details ".repeat(10)}`;
  }
  if (i % 10 === 0) {
    return `${base}. ${"extra detail ".repeat(8)}`;
  }
  return base;
}

function bulkInsertRaw(db: Database.Database) {
  const insertContact = db.prepare("INSERT INTO contacts (id, display_name, handle) VALUES (?, ?, ?)");
  const insertConversation = db.prepare("INSERT INTO conversations (id, external_id, title) VALUES (?, ?, ?)");
  const insertParticipant = db.prepare(
    "INSERT INTO conversation_participants (conversation_id, contact_id) VALUES (?, ?)",
  );
  const insertRaw = db.prepare(
    "INSERT INTO raw_messages (id, conversation_id, contact_id, sent_at_ms, text) VALUES (?, ?, ?, ?, ?)",
  );
  const insertState = db.prepare(
    "INSERT INTO import_state (id, last_raw_message_id, imported_at_ms) VALUES (1, ?, ?)",
  );

  db.transaction(() => {
    for (let contactId = 1; contactId <= CONTACT_COUNT; contactId += 1) {
      insertContact.run(contactId, `Contact ${contactId}`, `+1555000${contactId.toString().padStart(4, "0")}`);
    }
    for (let conversationId = 1; conversationId <= CONVERSATION_COUNT; conversationId += 1) {
      insertConversation.run(conversationId, `chat-${conversationId}`, `Conversation ${conversationId}`);
      for (let offset = 0; offset < 10; offset += 1) {
        const contactId = ((conversationId - 1) * 10 + offset) % CONTACT_COUNT + 1;
        insertParticipant.run(conversationId, contactId);
      }
    }
    for (let i = 1; i <= MESSAGE_COUNT; i += 1) {
      const conversationId = ((i - 1) % CONVERSATION_COUNT) + 1;
      const ordinalSeed = Math.floor((i - 1) / CONVERSATION_COUNT);
      const contactId = ((conversationId - 1) * 10 + (i % 10)) % CONTACT_COUNT + 1;
      insertRaw.run(
        i,
        conversationId,
        contactId,
        BASE_TIME_MS + conversationId * 1_000 + ordinalSeed * 60_000,
        textForMessage(i),
      );
    }
    insertState.run(MESSAGE_COUNT, BASE_TIME_MS + MESSAGE_COUNT * 60_000);
  })();
}

function assignOrdinals(db: Database.Database) {
  db.exec(`
    INSERT INTO messages (conversation_id, ordinal, contact_id, sent_at_ms, text)
    SELECT
      conversation_id,
      ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY sent_at_ms, id) AS ordinal,
      contact_id,
      sent_at_ms,
      text
    FROM raw_messages
    ORDER BY id;
  `);
}

function createWindows(db: Database.Database) {
  const insertConfig = db.prepare("INSERT INTO window_configs (id, size, stride, label) VALUES (?, ?, ?, ?)");
  const insertWindow = db.prepare(
    "INSERT INTO windows (conversation_id, window_config_id, start_ordinal, end_ordinal) VALUES (?, ?, ?, ?)",
  );
  const counts = db
    .prepare("SELECT conversation_id, MAX(ordinal) AS message_count FROM messages GROUP BY conversation_id")
    .all() as Array<{ conversation_id: number; message_count: number }>;

  db.transaction(() => {
    insertConfig.run(1, 100, 50, "100/50");
    insertConfig.run(2, 250, 125, "250/125");
    for (const row of counts) {
      for (const config of [
        { id: 1, size: 100, stride: 50 },
        { id: 2, size: 250, stride: 125 },
      ]) {
        for (let start = 1; start + config.size - 1 <= row.message_count; start += config.stride) {
          insertWindow.run(row.conversation_id, config.id, start, start + config.size - 1);
        }
      }
    }
  })();
}

function fetchOneWindow(db: Database.Database): number {
  const query = db.prepare(`
    SELECT m.ordinal, m.sent_at_ms, m.text, c.display_name
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.conversation_id = ? AND m.ordinal BETWEEN ? AND ?
    ORDER BY m.ordinal
  `);
  return query.all(1, 5_001, 5_250).length;
}

function fetchRandomWindows(db: Database.Database): number {
  const windows = db
    .prepare("SELECT conversation_id, start_ordinal, end_ordinal FROM windows ORDER BY id")
    .all() as Array<{ conversation_id: number; start_ordinal: number; end_ordinal: number }>;
  const query = db.prepare(`
    SELECT m.ordinal, m.sent_at_ms, m.text, c.display_name
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE m.conversation_id = ? AND m.ordinal BETWEEN ? AND ?
    ORDER BY m.ordinal
  `);
  const rng = new Lcg(0x5eed);
  let rows = 0;
  for (let i = 0; i < 1_000; i += 1) {
    const window = windows[rng.nextInt(windows.length)];
    rows += query.all(window.conversation_id, window.start_ordinal, window.end_ordinal).length;
  }
  return rows;
}

function insertAnalysis(db: Database.Database): number {
  const windows = db
    .prepare("SELECT id, conversation_id, window_config_id FROM windows ORDER BY id")
    .all() as Array<{ id: number; conversation_id: number; window_config_id: number }>;
  const insertHistoricalRun = db.prepare(
    "INSERT INTO analysis_runs (started_at_ms, completed_at_ms, model, status) VALUES (?, ?, ?, ?)",
  );
  const insertRun = db.prepare(
    "INSERT INTO analysis_runs (started_at_ms, completed_at_ms, model, status) VALUES (?, NULL, ?, ?)",
  );
  const finishRun = db.prepare("UPDATE analysis_runs SET completed_at_ms = ?, status = ? WHERE id = ?");
  const insertRunWindow = db.prepare("INSERT INTO run_windows (run_id, window_id, status) VALUES (?, ?, ?)");
  const updateRunWindow = db.prepare("UPDATE run_windows SET status = ? WHERE id = ?");
  const insertResult = db.prepare(
    "INSERT INTO window_results (run_window_id, score, label, summary) VALUES (?, ?, ?, ?)",
  );
  const insertShift = db.prepare(
    `INSERT INTO shifts
      (conversation_id, run_id, from_window_id, to_window_id, magnitude, direction)
      VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return db.transaction(() => {
    for (let i = 0; i < HISTORICAL_RUN_COUNT; i += 1) {
      insertHistoricalRun.run(
        BASE_TIME_MS - HISTORICAL_RUN_COUNT + i,
        BASE_TIME_MS - HISTORICAL_RUN_COUNT + i,
        "synthetic-v0",
        "complete",
      );
    }

    const run = insertRun.run(BASE_TIME_MS + 1, "synthetic-v1", "running");
    const runId = Number(run.lastInsertRowid);
    for (const window of windows) {
      const runWindow = insertRunWindow.run(runId, window.id, "queued");
      const runWindowId = Number(runWindow.lastInsertRowid);
      const score = ((window.id * 37) % 1_000) / 1_000;
      insertResult.run(runWindowId, score, score > 0.5 ? "warm" : "cool", `summary for window ${window.id}`);
      updateRunWindow.run("done", runWindowId);
    }

    const size100Windows = windows.filter((window) => window.window_config_id === 1);
    for (let conversationId = 1; conversationId <= CONVERSATION_COUNT; conversationId += 1) {
      const conversationWindows = size100Windows.filter((window) => window.conversation_id === conversationId);
      for (let i = 1; i < conversationWindows.length; i += 1) {
        const from = conversationWindows[i - 1];
        const to = conversationWindows[i];
        const magnitude = ((to.id - from.id) % 100) / 100;
        insertShift.run(conversationId, runId, from.id, to.id, magnitude, magnitude > 0.5 ? "up" : "down");
      }
    }
    finishRun.run(BASE_TIME_MS + 2, "complete", runId);
    return windows.length;
  })();
}

function queryLatestRun(db: Database.Database): number {
  const query = db.prepare(`
    WITH latest_run AS (
      SELECT id
      FROM analysis_runs
      WHERE status = 'complete'
      ORDER BY completed_at_ms DESC, id DESC
      LIMIT 1
    )
    SELECT
      w.id,
      w.window_config_id,
      w.start_ordinal,
      w.end_ordinal,
      wr.score,
      wr.label
    FROM latest_run lr
    JOIN run_windows rw ON rw.run_id = lr.id
    JOIN windows w ON w.id = rw.window_id
    JOIN window_results wr ON wr.run_window_id = rw.id
    WHERE w.conversation_id = ?
    ORDER BY w.window_config_id, w.start_ordinal
  `);
  return query.all(1).length;
}

function countRows(db: Database.Database) {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

  return {
    contacts: count("contacts"),
    conversations: count("conversations"),
    raw_messages: count("raw_messages"),
    messages: count("messages"),
    analysis_runs: count("analysis_runs"),
    windows: count("windows"),
    run_windows: count("run_windows"),
    window_results: count("window_results"),
    shifts: count("shifts"),
  };
}

function runIteration(variant: Variant, iteration: number): IterationResult {
  mkdirSync(TMP_DIR, { recursive: true });
  const dbPath = join(TMP_DIR, `${variant}-${iteration}.db`);
  const db = createDb(dbPath);
  const timings = {} as Record<Operation, number>;
  const counts: Record<string, number> = {};
  let sqliteVersion = "";

  try {
    sqliteVersion = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
    time(timings, "schema_bootstrap", () => createSchema(db, variant));
    time(timings, "bulk_insert_raw", () => bulkInsertRaw(db));
    time(timings, "assign_ordinals", () => assignOrdinals(db));
    time(timings, "create_windows", () => createWindows(db));
    counts.fetch_one_window_rows = time(timings, "fetch_one_window", () => fetchOneWindow(db));
    counts.fetch_1k_window_rows = time(timings, "fetch_1k_windows", () => fetchRandomWindows(db));
    counts.analysis_windows = time(timings, "insert_analysis", () => insertAnalysis(db));
    counts.latest_run_rows = time(timings, "query_latest_run", () => queryLatestRun(db));
    Object.assign(counts, countRows(db));
  } finally {
    db.close();
  }

  return {
    runtime: "typescript-better-sqlite3",
    variant,
    iteration,
    dbPath,
    versions: {
      node: process.version,
      betterSqlite3: betterSqlite3Package.version,
      sqlite: sqliteVersion,
    },
    timingsMs: timings,
    counts,
  };
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function summarize(results: IterationResult[]) {
  const operations: Operation[] = [
    "schema_bootstrap",
    "bulk_insert_raw",
    "assign_ordinals",
    "create_windows",
    "fetch_one_window",
    "fetch_1k_windows",
    "insert_analysis",
    "query_latest_run",
  ];

  for (const variant of VARIANTS) {
    console.log(`\n${variant}`);
    console.log("operation,p50_ms,p95_ms,mean_ms");
    const rows = results.filter((result) => result.variant === variant && result.iteration >= 0);
    for (const operation of operations) {
      const values = rows.map((row) => row.timingsMs[operation]);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      console.log(
        `${operation},${percentile(values, 50).toFixed(2)},${percentile(values, 95).toFixed(2)},${mean.toFixed(2)}`,
      );
    }
  }
}

mkdirSync(RESULTS_DIR, { recursive: true });

const measuredResults: IterationResult[] = [];
const allResults: IterationResult[] = [];
for (const variant of VARIANTS) {
  for (let iteration = -WARMUP_ITERATIONS; iteration < MEASURED_ITERATIONS; iteration += 1) {
    const result = runIteration(variant, iteration);
    allResults.push(result);
    if (iteration >= 0) {
      measuredResults.push(result);
    }
    console.log(
      `${result.runtime} ${variant} iteration ${iteration}: ${Object.values(result.timingsMs)
        .reduce((sum, value) => sum + value, 0)
        .toFixed(2)}ms`,
    );
  }
}

writeFileSync(join(RESULTS_DIR, "typescript-better-sqlite3.json"), `${JSON.stringify(allResults, null, 2)}\n`);
summarize(measuredResults);
