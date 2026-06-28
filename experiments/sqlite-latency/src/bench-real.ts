import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

type AppDbSummary = {
  contacts: number;
  conversations: number;
  messages: number;
  window_configs: number;
  windows: number;
  scorer_configs: number;
  analysis_runs: number;
  run_windows: number;
  window_results: number;
  shifts: number;
  import_state: number;
};

type Conversation = {
  id: number;
  message_count: number;
};

type WindowRow = {
  id: number;
  conversation_id: number;
  window_config_id: number;
  start_ordinal: number;
  end_ordinal: number;
};

type PlanRow = {
  detail: string;
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP_DIR = join(ROOT, "tmp", "real");
const RESULTS_DIR = join(ROOT, "results");
const DEFAULT_APP_DB_PATH = join(homedir(), "Library", "Application Support", "imessage-emotion", "imessage-emotion.sqlite");
const APP_DB_PATH = process.env.IMESSAGE_APP_DB ?? DEFAULT_APP_DB_PATH;
const MESSAGE_LIMIT = Number(process.env.REAL_MESSAGE_LIMIT ?? 100_000);
const CONVERSATION_LIMIT = Number(process.env.REAL_CONVERSATION_LIMIT ?? 5);
const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;
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

function time<T>(run: () => T): { elapsedMs: number; result: T } {
  const start = performance.now();
  const result = run();
  return { elapsedMs: performance.now() - start, result };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p50Index = Math.ceil(0.5 * sorted.length) - 1;
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;
  return {
    p50_ms: sorted[Math.max(0, p50Index)],
    p95_ms: sorted[Math.max(0, p95Index)],
    mean_ms: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function measureRepeated<T>(run: () => T) {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    run();
  }
  const values: number[] = [];
  let result: T | undefined;
  for (let i = 0; i < MEASURED_ITERATIONS; i += 1) {
    const measured = time(run);
    values.push(measured.elapsedMs);
    result = measured.result;
  }
  return { ...summarize(values), iterations: MEASURED_ITERATIONS, result };
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function summarizeAppDb(db: Database.Database): AppDbSummary {
  return {
    contacts: countRows(db, "contacts"),
    conversations: countRows(db, "conversations"),
    messages: countRows(db, "messages"),
    window_configs: countRows(db, "window_configs"),
    windows: countRows(db, "windows"),
    scorer_configs: countRows(db, "scorer_configs"),
    analysis_runs: countRows(db, "analysis_runs"),
    run_windows: countRows(db, "run_windows"),
    window_results: countRows(db, "window_results"),
    shifts: countRows(db, "shifts"),
    import_state: countRows(db, "import_state"),
  };
}

function assertUsableAppDb(db: Database.Database, summary: AppDbSummary) {
  const requiredTables = ["contacts", "conversations", "messages", "window_configs", "windows", "analysis_runs"];
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const table of requiredTables) {
    if (!tables.has(table)) {
      throw new Error(`App DB is missing table '${table}'. Run the app once so migrations create the local DB.`);
    }
  }
  if (summary.messages === 0 || summary.conversations === 0) {
    throw new Error(
      `App DB has no imported messages/conversations at ${APP_DB_PATH}. Run the app sync/import first, then rerun npm run bench:real.`,
    );
  }
}

async function copyAppDb(source: Database.Database, targetPath: string): Promise<number> {
  rmSync(targetPath, { force: true });
  rmSync(`${targetPath}-wal`, { force: true });
  rmSync(`${targetPath}-shm`, { force: true });
  const measured = time(() => source.backup(targetPath));
  await measured.result;
  return measured.elapsedMs;
}

function selectConversations(db: Database.Database): Conversation[] {
  return db
    .prepare(
      `
      SELECT conversation_id AS id, COUNT(*) AS message_count
      FROM messages
      GROUP BY conversation_id
      HAVING COUNT(*) >= 250
      ORDER BY message_count DESC, conversation_id
      LIMIT ?
    `,
    )
    .all(CONVERSATION_LIMIT) as Conversation[];
}

function ensureWindowConfig(db: Database.Database, name: string, messageCount: number, stride: number): number {
  db.prepare(
    `
    INSERT INTO window_configs (name, message_count, stride, min_tail_messages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      message_count = excluded.message_count,
      stride = excluded.stride,
      min_tail_messages = excluded.min_tail_messages
  `,
  ).run(name, messageCount, stride, Math.min(stride, messageCount));
  return (db.prepare("SELECT id FROM window_configs WHERE name = ?").get(name) as { id: number }).id;
}

function ensureWindows(db: Database.Database): number {
  const conversations = selectConversations(db);
  if (conversations.length === 0) {
    throw new Error("App DB has imported messages, but no conversation has enough messages for 250-message windows.");
  }

  const configs = [
    { id: ensureWindowConfig(db, "bench-real-100-50", 100, 50), messageCount: 100, stride: 50 },
    { id: ensureWindowConfig(db, "bench-real-250-125", 250, 125), messageCount: 250, stride: 125 },
  ];
  const boundary = db.prepare(`
    SELECT id, sent_at
    FROM messages
    WHERE conversation_id = ? AND conversation_ordinal = ?
  `);
  const insertWindow = db.prepare(`
    INSERT INTO windows (
      window_config_id,
      conversation_id,
      start_ordinal,
      end_ordinal,
      start_message_id,
      end_message_id,
      start_at,
      end_at,
      message_count,
      deterministic_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deterministic_key) DO UPDATE SET
      start_message_id = excluded.start_message_id,
      end_message_id = excluded.end_message_id,
      start_at = excluded.start_at,
      end_at = excluded.end_at,
      message_count = excluded.message_count
  `);

  return db.transaction(() => {
    let createdOrUpdated = 0;
    for (const conversation of conversations) {
      const limit = Math.min(conversation.message_count, MESSAGE_LIMIT);
      for (const config of configs) {
        for (let start = 1; start + config.messageCount - 1 <= limit; start += config.stride) {
          const end = start + config.messageCount - 1;
          const startMessage = boundary.get(conversation.id, start) as { id: number; sent_at: number } | undefined;
          const endMessage = boundary.get(conversation.id, end) as { id: number; sent_at: number } | undefined;
          if (!startMessage || !endMessage) {
            continue;
          }
          insertWindow.run(
            config.id,
            conversation.id,
            start,
            end,
            startMessage.id,
            endMessage.id,
            startMessage.sent_at,
            endMessage.sent_at,
            config.messageCount,
            `bench-real:conversation:${conversation.id}:config:${config.id}:ordinals:${start}:${end}`,
          );
          createdOrUpdated += 1;
        }
      }
    }
    return createdOrUpdated;
  })();
}

function fetchOneWindow(db: Database.Database): number {
  const window = db
    .prepare("SELECT conversation_id, start_ordinal, end_ordinal FROM windows ORDER BY id DESC LIMIT 1")
    .get() as WindowRow | undefined;
  if (!window) {
    return 0;
  }
  const query = db.prepare(`
    SELECT id, conversation_ordinal, sent_at, is_from_me, has_attachments
    FROM messages
    WHERE conversation_id = ? AND conversation_ordinal BETWEEN ? AND ?
    ORDER BY conversation_ordinal
  `);
  return query.all(window.conversation_id, window.start_ordinal, window.end_ordinal).length;
}

function fetchRandomWindows(db: Database.Database): number {
  const windows = db
    .prepare("SELECT conversation_id, start_ordinal, end_ordinal FROM windows ORDER BY id")
    .all() as WindowRow[];
  if (windows.length === 0) {
    return 0;
  }
  const query = db.prepare(`
    SELECT id, conversation_ordinal, sent_at, is_from_me, has_attachments
    FROM messages
    WHERE conversation_id = ? AND conversation_ordinal BETWEEN ? AND ?
    ORDER BY conversation_ordinal
  `);
  const rng = new Lcg(0x7ea1);
  let rows = 0;
  for (let i = 0; i < 1_000; i += 1) {
    const window = windows[rng.nextInt(windows.length)];
    rows += query.all(window.conversation_id, window.start_ordinal, window.end_ordinal).length;
  }
  return rows;
}

function ensureScorerConfig(db: Database.Database): number {
  db.prepare(
    `
    INSERT INTO scorer_configs (key, label, config_json)
    VALUES ('bench-real', 'Benchmark real-data scorer', '{}')
    ON CONFLICT(key) DO UPDATE SET
      label = excluded.label,
      config_json = excluded.config_json
  `,
  ).run();
  return (db.prepare("SELECT id FROM scorer_configs WHERE key = 'bench-real'").get() as { id: number }).id;
}

function insertAnalysis(db: Database.Database): number {
  const scorerConfigId = ensureScorerConfig(db);
  const windows = db.prepare("SELECT id, conversation_id, window_config_id FROM windows ORDER BY id").all() as Array<{
    id: number;
    conversation_id: number;
    window_config_id: number;
  }>;
  const insertRun = db.prepare(`
    INSERT INTO analysis_runs (scorer_config_id, status, started_at, completed_at, notes)
    VALUES (?, 'complete', ?, ?, 'bench-real temp-copy run')
  `);
  const insertRunWindow = db.prepare("INSERT OR IGNORE INTO run_windows (run_id, window_id, status) VALUES (?, ?, 'done')");
  const insertResult = db.prepare(`
    INSERT INTO window_results (run_id, window_id, scorer_config_id, result_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id, window_id) DO UPDATE SET
      result_json = excluded.result_json
  `);
  const insertShift = db.prepare(`
    INSERT INTO shifts (run_id, conversation_id, from_window_id, to_window_id, result_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  return db.transaction(() => {
    const run = insertRun.run(scorerConfigId, BASE_TIME_MS + 1, BASE_TIME_MS + 2);
    const runId = Number(run.lastInsertRowid);
    for (const window of windows) {
      insertRunWindow.run(runId, window.id);
      insertResult.run(runId, window.id, scorerConfigId, JSON.stringify({ score_bucket: window.id % 10 }));
    }

    const byConversation = new Map<number, number[]>();
    for (const window of windows.filter((row) => row.window_config_id === windows[0]?.window_config_id)) {
      byConversation.set(window.conversation_id, [...(byConversation.get(window.conversation_id) ?? []), window.id]);
    }
    for (const [conversationId, windowIds] of byConversation) {
      for (let i = 1; i < windowIds.length; i += 1) {
        insertShift.run(
          runId,
          conversationId,
          windowIds[i - 1],
          windowIds[i],
          JSON.stringify({ magnitude_bucket: (windowIds[i] - windowIds[i - 1]) % 10 }),
        );
      }
    }
    return windows.length;
  })();
}

function queryLatestRun(db: Database.Database): number {
  const conversation = db
    .prepare("SELECT conversation_id AS id, COUNT(*) AS message_count FROM messages GROUP BY conversation_id ORDER BY message_count DESC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!conversation) {
    return 0;
  }
  const query = db.prepare(`
    WITH latest_run AS (
      SELECT id
      FROM analysis_runs
      WHERE status = 'complete'
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    )
    SELECT w.id, w.window_config_id, w.start_ordinal, w.end_ordinal, wr.result_json
    FROM latest_run lr
    JOIN run_windows rw ON rw.run_id = lr.id
    JOIN windows w ON w.id = rw.window_id
    JOIN window_results wr ON wr.run_id = lr.id AND wr.window_id = w.id
    WHERE w.conversation_id = ?
    ORDER BY w.window_config_id, w.start_ordinal
  `);
  return query.all(conversation.id).length;
}

function listIndexes(db: Database.Database) {
  return db
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; tbl_name: string }>;
}

function queryPlans(db: Database.Database) {
  const fetchPlan = db
    .prepare(
      `
      EXPLAIN QUERY PLAN
      SELECT id, conversation_ordinal, sent_at, is_from_me, has_attachments
      FROM messages
      WHERE conversation_id = ? AND conversation_ordinal BETWEEN ? AND ?
      ORDER BY conversation_ordinal
    `,
    )
    .all(1, 1, 250) as PlanRow[];
  const latestRunPlan = db
    .prepare(
      `
      EXPLAIN QUERY PLAN
      WITH latest_run AS (
        SELECT id FROM analysis_runs WHERE status = 'complete' ORDER BY completed_at DESC, id DESC LIMIT 1
      )
      SELECT w.id, wr.result_json
      FROM latest_run lr
      JOIN run_windows rw ON rw.run_id = lr.id
      JOIN windows w ON w.id = rw.window_id
      JOIN window_results wr ON wr.run_id = lr.id AND wr.window_id = w.id
      WHERE w.conversation_id = ?
      ORDER BY w.window_config_id, w.start_ordinal
    `,
    )
    .all(1) as PlanRow[];

  return {
    fetchWindow: fetchPlan.map((row) => row.detail),
    latestRun: latestRunPlan.map((row) => row.detail),
  };
}

async function main() {
  if (!existsSync(APP_DB_PATH)) {
    throw new Error(
      `App DB not found at ${APP_DB_PATH}. Run the Electron app and sync/import messages first, or set IMESSAGE_APP_DB to an app-owned imported DB path.`,
    );
  }

  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const source = new Database(APP_DB_PATH, { readonly: true, fileMustExist: true });
  const sourceSummary = summarizeAppDb(source);
  assertUsableAppDb(source, sourceSummary);

  const copyPath = join(TMP_DIR, "app-db-copy.sqlite");
  const backupMs = await copyAppDb(source, copyPath);
  source.close();

  const db = new Database(copyPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");

  try {
    const sqliteVersion = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
    const ensureWindowsTiming = time(() => ensureWindows(db));
    const fetchOne = measureRepeated(() => fetchOneWindow(db));
    const fetchMany = measureRepeated(() => fetchRandomWindows(db));
    const insertAnalysisTiming = time(() => insertAnalysis(db));
    const latestRun = measureRepeated(() => queryLatestRun(db));
    const copySummary = summarizeAppDb(db);

    const result = {
      runtime: "typescript-better-sqlite3-real-app-db",
      source: {
        kind: "app-owned-imported-db",
        path: APP_DB_PATH === DEFAULT_APP_DB_PATH ? "~/Library/Application Support/imessage-emotion/imessage-emotion.sqlite" : "IMESSAGE_APP_DB",
        sourceCounts: sourceSummary,
      },
      tempCopy: {
        path: "experiments/sqlite-latency/tmp/real/app-db-copy.sqlite",
        backup_ms: backupMs,
      },
      limits: {
        messageLimit: MESSAGE_LIMIT,
        conversationLimit: CONVERSATION_LIMIT,
      },
      versions: {
        node: process.version,
        betterSqlite3: betterSqlite3Package.version,
        sqlite: sqliteVersion,
      },
      setupTimingsMs: {
        ensure_windows: ensureWindowsTiming.elapsedMs,
        insert_analysis: insertAnalysisTiming.elapsedMs,
      },
      timingPercentilesMs: {
        fetch_one_window: fetchOne,
        fetch_1k_windows: fetchMany,
        query_latest_run: latestRun,
      },
      resultRows: {
        ensured_windows: ensureWindowsTiming.result,
        analysis_windows: insertAnalysisTiming.result,
        fetch_one_window_rows: fetchOne.result,
        fetch_1k_window_rows: fetchMany.result,
        latest_run_rows: latestRun.result,
      },
      finalCounts: copySummary,
      indexes: listIndexes(db),
      queryPlans: queryPlans(db),
    };

    writeFileSync(join(RESULTS_DIR, "real-app-db.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

await main();
