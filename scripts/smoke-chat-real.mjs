import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { answerConversation } from '../src/lib/chat/answer.ts'
import { retrieveConversationContext } from '../src/lib/chat/retrieve.ts'

const appDbPath =
  process.env.IMESSAGE_EMOTION_DB ??
  path.join(
    process.env.HOME ?? '',
    'Library/Application Support/imessage-emotion/imessage-emotion.sqlite',
  )
const tempDir = mkdtempSync(path.join(tmpdir(), 'imessage-emotion-real-chat-'))
const tempAppDbPath = path.join(tempDir, 'app-db-copy.sqlite')

try {
  assert(
    existsSync(appDbPath),
    `app-owned imported DB not found at ${appDbPath}; run the app message sync first`,
  )
  copyFileSync(appDbPath, tempAppDbPath)

  const db = new Database(tempAppDbPath)
  try {
    db.pragma('foreign_keys = ON')
    assertImportedAppDb(db)

    const source = selectRealConversation(db)
    const selectedMessages = listMessages(db, source.conversationId, 24)
    assert.equal(selectedMessages.length >= 24, true, 'app DB conversation needs 24 messages')
    assert.equal(countUnrelatedMessages(db, source.conversationId) > 0, true)

    const seed = seedThrowawayAnalysis(db, source.conversationId, selectedMessages)
    const input = {
      conversationId: source.conversationId,
      runId: seed.runId,
      windowId: seed.selectedWindowId,
      question: 'Summarize the selected window without quoting private text.',
    }

    const started = performance.now()
    const packet = retrieveConversationContext(db, input)
    const response = answerConversation(db, input)
    const elapsedMs = Math.max(1, Math.round(performance.now() - started))

    assert.equal(packet.conversation.id, source.conversationId)
    assert.equal(packet.selectedWindow.id, seed.selectedWindowId)
    assert.deepEqual(
      packet.contextMessages.map((message) => message.ordinal),
      selectedMessages.slice(0, 8).map((message) => message.conversation_ordinal),
    )
    assert.deepEqual(
      packet.focalMessages.map((message) => message.ordinal),
      selectedMessages.slice(8, 16).map((message) => message.conversation_ordinal),
    )
    assert.equal(packet.contextMessages.every((message) => message.role === 'context'), true)
    assert.equal(packet.focalMessages.every((message) => message.role === 'focal'), true)
    assert.equal(
      [...packet.contextMessages, ...packet.focalMessages].every(
        (message) => message.conversationId === source.conversationId,
      ),
      true,
    )
    assert.deepEqual(
      packet.neighboringWindows.map((window) => window.id),
      [seed.previousWindowId, seed.nextWindowId],
    )
    assert.equal(
      response.citations.some((citation) => citation.type === 'run' && citation.id === seed.runId),
      true,
    )
    assert.equal(
      response.citations.some(
        (citation) => citation.type === 'window' && citation.id === seed.selectedWindowId,
      ),
      true,
    )
    assert.equal(response.citations.some((citation) => citation.type === 'message'), true)
    assert.equal(response.answer.length > 100, true)
    assert.equal('packet' in response, false)
    const chatTableCount = tableCount(db, "name LIKE 'chat%'")
    assert.equal(chatTableCount, 0)

    const citationCounts = response.citations.reduce(
      (counts, citation) => {
        counts[citation.type] += 1
        return counts
      },
      { message: 0, run: 0, window: 0 },
    )

    console.log(
      JSON.stringify(
        {
          status: 'passed',
          source: 'app-owned imported DB temp copy',
          selectedConversationId: source.conversationId,
          selectedRunId: seed.runId,
          selectedWindowId: seed.selectedWindowId,
          selectedMessageCount: selectedMessages.length,
          contextMessageCount: packet.contextMessages.length,
          focalMessageCount: packet.focalMessages.length,
          neighboringWindowCount: packet.neighboringWindows.length,
          citationCounts,
          answerLength: response.answer.length,
          elapsedMs,
          chatTableCount,
        },
        null,
        2,
      ),
    )
  } finally {
    db.close()
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

function assertImportedAppDb(db) {
  for (const table of ['conversations', 'messages']) {
    assert(tableExists(db, table), `app DB missing ${table}; run app import first`)
    assert.equal(tableCount(db, `name = '${table}'`) > 0, true)
  }
  const messageCount = db.prepare('SELECT COUNT(*) AS count FROM messages').get().count
  assert.equal(messageCount > 0, true, 'app DB has no imported messages')
}

function selectRealConversation(db) {
  const row = db
    .prepare(
      `
      SELECT conversation_id AS conversationId, COUNT(*) AS textCount
      FROM messages
      WHERE text IS NOT NULL AND length(trim(text)) > 0
      GROUP BY conversation_id
      HAVING textCount >= 24
      ORDER BY textCount DESC
      LIMIT 1
    `,
    )
    .get()
  assert(row, 'app DB needs an imported conversation with at least 24 text messages')
  return row
}

function listMessages(db, conversationId, limit) {
  return db
    .prepare(
      `
      SELECT id, conversation_id, conversation_ordinal, source_rowid, guid, text, sent_at,
        is_from_me, is_read, status
      FROM messages
      WHERE conversation_id = ?
        AND text IS NOT NULL
        AND length(trim(text)) > 0
      ORDER BY conversation_ordinal
      LIMIT ?
    `,
    )
    .all(conversationId, limit)
}

function countUnrelatedMessages(db, conversationId) {
  return db
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id != ?')
    .get(conversationId).count
}

function seedThrowawayAnalysis(db, conversationId, messages) {
  addRunOwnedCompatibilityColumns(db)

  const scorerConfigId = ensureScorerConfig(db)
  const windowConfigId = ensureWindowConfig(db)
  const runId = insertRun(db, conversationId, scorerConfigId, messages)
  const previousWindowId = insertWindow(db, {
    conversationId,
    runId,
    windowConfigId,
    ordinal: 1,
    start: messages[0],
    end: messages[7],
    contextStart: null,
    contextEnd: null,
    focalStart: messages[0],
    focalEnd: messages[7],
    contextCount: 0,
    focalCount: 8,
    metadata: '{"label":"previous app-db-only smoke window"}',
    result: '{"summary":"previous app-db-only smoke result","dominant":"baseline","method":"deterministic-smoke"}',
    shift: '{}',
  })
  const selectedWindowId = insertWindow(db, {
    conversationId,
    runId,
    windowConfigId,
    ordinal: 2,
    start: messages[0],
    end: messages[15],
    contextStart: messages[0],
    contextEnd: messages[7],
    focalStart: messages[8],
    focalEnd: messages[15],
    contextCount: 8,
    focalCount: 8,
    metadata: '{"label":"selected app-db-only smoke window"}',
    result: '{"summary":"selected app-db-only smoke result","dominant":"baseline","method":"deterministic-smoke"}',
    shift: '{"summary":"app-db-only smoke shift metadata"}',
  })
  const nextWindowId = insertWindow(db, {
    conversationId,
    runId,
    windowConfigId,
    ordinal: 3,
    start: messages[8],
    end: messages[23],
    contextStart: messages[8],
    contextEnd: messages[15],
    focalStart: messages[16],
    focalEnd: messages[23],
    contextCount: 8,
    focalCount: 8,
    metadata: '{"label":"next app-db-only smoke window"}',
    result: '{"summary":"next app-db-only smoke result","dominant":"baseline","method":"deterministic-smoke"}',
    shift: '{}',
  })

  return { runId, previousWindowId, selectedWindowId, nextWindowId }
}

function addRunOwnedCompatibilityColumns(db) {
  const runColumns = columnsFor(db, 'analysis_runs')
  addColumn(db, runColumns, 'analysis_runs', 'conversation_id', 'INTEGER')
  addColumn(db, runColumns, 'analysis_runs', 'method_key', 'TEXT')
  addColumn(db, runColumns, 'analysis_runs', 'window_config_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, runColumns, 'analysis_runs', 'context_config_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, runColumns, 'analysis_runs', 'scorer_config_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, runColumns, 'analysis_runs', 'summary_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, runColumns, 'analysis_runs', 'error', 'TEXT')

  const windowColumns = columnsFor(db, 'windows')
  addColumn(db, windowColumns, 'windows', 'run_id', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'ordinal', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'context_start_ordinal', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'context_end_ordinal', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'focal_start_ordinal', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'focal_end_ordinal', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'context_message_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, windowColumns, 'windows', 'focal_message_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, windowColumns, 'windows', 'window_metadata_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, windowColumns, 'windows', 'result_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, windowColumns, 'windows', 'shift_json', "TEXT NOT NULL DEFAULT '{}'")
  addColumn(db, windowColumns, 'windows', 'status', "TEXT NOT NULL DEFAULT 'pending'")
  addColumn(db, windowColumns, 'windows', 'latency_ms', 'INTEGER')
  addColumn(db, windowColumns, 'windows', 'error', 'TEXT')
}

function ensureScorerConfig(db) {
  db.prepare(
    `
    INSERT INTO scorer_configs (key, label, config_json)
    VALUES ('real-smoke', 'Real data smoke', '{"method":"deterministic-smoke"}')
    ON CONFLICT(key) DO UPDATE SET label = excluded.label
  `,
  ).run()
  return db.prepare("SELECT id FROM scorer_configs WHERE key = 'real-smoke'").get().id
}

function ensureWindowConfig(db) {
  db.prepare(
    `
    INSERT INTO window_configs (name, message_count, stride, min_tail_messages)
    VALUES ('real-smoke-16-by-8', 16, 8, 8)
    ON CONFLICT(name) DO UPDATE SET message_count = excluded.message_count
  `,
  ).run()
  return db.prepare("SELECT id FROM window_configs WHERE name = 'real-smoke-16-by-8'").get().id
}

function insertRun(db, conversationId, scorerConfigId, messages) {
  const result = db
    .prepare(
      `
      INSERT INTO analysis_runs (
        scorer_config_id, conversation_id, method_key, status, window_config_json,
        context_config_json, scorer_config_json, summary_json, started_at, completed_at, notes
      )
      VALUES (
        ?, ?, 'real-smoke-baseline', 'completed',
        '{"mode":"comparative-message-count","contextMessages":8,"focalMessages":8}',
        '{"split":"context-vs-focal"}',
        '{"method":"deterministic-smoke"}',
        '{"summary":"real-data app-db-only smoke run"}',
        ?, ?, 'temporary row in copied DB only'
      )
    `,
    )
    .run(scorerConfigId, conversationId, messages[0].sent_at, messages[15].sent_at)
  return Number(result.lastInsertRowid)
}

function insertWindow(db, input) {
  const result = db
    .prepare(
      `
      INSERT INTO windows (
        window_config_id, run_id, conversation_id, ordinal, start_ordinal, end_ordinal,
        context_start_ordinal, context_end_ordinal, focal_start_ordinal, focal_end_ordinal,
        start_message_id, end_message_id, start_at, end_at, message_count,
        context_message_count, focal_message_count, window_metadata_json, result_json, shift_json,
        status, deterministic_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
    `,
    )
    .run(
      input.windowConfigId,
      input.runId,
      input.conversationId,
      input.ordinal,
      input.start.conversation_ordinal,
      input.end.conversation_ordinal,
      input.contextStart?.conversation_ordinal ?? null,
      input.contextEnd?.conversation_ordinal ?? null,
      input.focalStart.conversation_ordinal,
      input.focalEnd.conversation_ordinal,
      input.start.id,
      input.end.id,
      input.start.sent_at,
      input.end.sent_at,
      input.end.conversation_ordinal - input.start.conversation_ordinal + 1,
      input.contextCount,
      input.focalCount,
      input.metadata,
      input.result,
      input.shift,
      `real-smoke:${input.runId}:${input.ordinal}:${Date.now()}`,
    )
  return Number(result.lastInsertRowid)
}

function addColumn(db, columns, table, name, definition) {
  if (columns.has(name)) return
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run()
  columns.add(name)
}

function columnsFor(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  )
}

function tableCount(db, where) {
  return db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND ${where}`).get()
    .count
}
