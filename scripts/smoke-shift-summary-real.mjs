import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { openAppDatabase } from '../src/lib/db/schema.ts'
import { computeAndStoreRunSummary } from '../src/lib/emotion/run-summary.ts'
import { DEFAULT_SHIFT_THRESHOLDS } from '../src/lib/emotion/shifts.ts'

const DEFAULT_APP_DB_PATH = path.join(
  homedir(),
  'Library',
  'Application Support',
  'imessage-emotion',
  'imessage-emotion.sqlite',
)
const appDbPath = process.env.IMESSAGE_EMOTION_DB_PATH ?? DEFAULT_APP_DB_PATH
const minMessages = numberFromEnv('REAL_SHIFT_MIN_MESSAGES', 80)
const windowSize = numberFromEnv('REAL_SHIFT_WINDOW_SIZE', 20)
const stride = numberFromEnv('REAL_SHIFT_STRIDE', 10)
const started = performance.now()
const LEXICON = {
  warmth: new Set([
    'thanks',
    'thank',
    'appreciate',
    'love',
    'glad',
    'happy',
    'nice',
    'great',
    'sweet',
    'kind',
    'excited',
    'good',
  ]),
  joy: new Set([
    'haha',
    'lol',
    'lmao',
    'fun',
    'funny',
    'yay',
    'yes',
    'awesome',
    'amazing',
    'perfect',
    'cool',
    'wonderful',
  ]),
  stress: new Set([
    'busy',
    'stressed',
    'stress',
    'worried',
    'anxious',
    'sorry',
    'late',
    'urgent',
    'hard',
    'tired',
    'overwhelmed',
    'problem',
  ]),
  friction: new Set([
    'no',
    'not',
    'never',
    'why',
    'wrong',
    'bad',
    'annoying',
    'frustrated',
    'confused',
    'issue',
    'cancel',
    'missed',
  ]),
  sadness: new Set([
    'sad',
    'miss',
    'hurt',
    'sorry',
    'alone',
    'lost',
    'upset',
    'cry',
    'tough',
    'rough',
    'unfortunately',
    'pain',
  ]),
}

if (!existsSync(appDbPath)) {
  console.log(
    [
      'real shift smoke skipped',
      'dependency=missing-app-db',
      'setup=run-app-sync-import-first',
    ].join(' | '),
  )
  process.exit(0)
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'imessage-emotion-real-shifts-'))
const tempDbPath = path.join(tempDir, 'app-copy.sqlite')
const sourceDb = new Database(appDbPath, { readonly: true, fileMustExist: true })
await sourceDb.backup(tempDbPath)
sourceDb.close()

const db = openAppDatabase(tempDbPath)

try {
  const appMessages = countMessages(db)
  const conversation = selectConversation(db, minMessages)
  if (!conversation) {
    console.log(
      [
        'real shift smoke skipped',
        'dependency=insufficient-imported-app-data',
        'setup=run-app-sync-import-first',
        `app_messages=${appMessages}`,
        `min_messages=${minMessages}`,
      ].join(' | '),
    )
    process.exit(0)
  }

  const runId = createRealDataRun(db, conversation.id)
  const summary = computeAndStoreRunSummary(db, runId)
  const populatedShiftRows = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM windows
      WHERE run_id = ?
        AND shift_json IS NOT NULL
        AND shift_json <> '{}'
    `,
    )
    .get(runId).count
  const summaryRow = db
    .prepare('SELECT summary_json FROM analysis_runs WHERE id = ?')
    .get(runId)
  const storedSummary = JSON.parse(summaryRow.summary_json)

  assert(summary.windowCount >= DEFAULT_SHIFT_THRESHOLDS.baselineWindowMin + 1)
  assert.equal(populatedShiftRows, summary.windowCount)
  assert.equal(storedSummary.method, 'rolling-shift-summary-v1')
  assert.equal(storedSummary.windowCount, summary.windowCount)
  assert(typeof storedSummary.isIncomplete === 'boolean')
  assert(storedSummary.counts && typeof storedSummary.counts === 'object')

  const elapsedMs = Math.round(performance.now() - started)
  const strongest = summary.strongestShift
    ? `${summary.strongestShift.label}:${summary.strongestShift.delta}`
    : 'none'
  console.log(
    [
      'real shift smoke passed',
      `conversation_id=${conversation.id}`,
      `run_id=${runId}`,
      'source=app-db-temp-copy',
      `app_messages=${appMessages}`,
      `window_count=${summary.windowCount}`,
      `shift_json=${populatedShiftRows}/${summary.windowCount}`,
      `summary_json=populated`,
      `major=${summary.majorShiftCount}`,
      `minor=${summary.minorShiftCount}`,
      `stable=${summary.stableWindowCount}`,
      `strongest=${strongest}`,
      `trends=${formatCounts(summary.counts.byTrend)}`,
      `emotions=${formatCounts(summary.counts.byEmotion)}`,
      `elapsed_ms=${elapsedMs}`,
    ].join(' | '),
  )
} finally {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
}
function selectConversation(db, minimumMessages) {
  return db
    .prepare(
      `
      SELECT conversation_id AS id, COUNT(*) AS text_message_count
      FROM messages
      WHERE text IS NOT NULL AND TRIM(text) <> ''
      GROUP BY conversation_id
      HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC, conversation_id ASC
      LIMIT 1
    `,
    )
    .get(minimumMessages)
}

function createRealDataRun(db, conversationId) {
  return db.transaction(() => {
    const scorerConfigId = upsertScorerConfig(db)
    const windowConfigId = upsertWindowConfig(db)
    const runId = Number(
      db
        .prepare(
          `
          INSERT INTO analysis_runs (
            conversation_id,
            method_key,
            status,
            window_config_json,
            context_config_json,
            scorer_config_json,
            scorer_config_id,
            started_at,
            completed_at
          )
          VALUES (?, 'real-smoke-lexical-v1', 'completed', ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          conversationId,
          JSON.stringify({ mode: 'real-smoke-message-count', windowSize, stride }),
          JSON.stringify({ baselineWindowMin: DEFAULT_SHIFT_THRESHOLDS.baselineWindowMin }),
          JSON.stringify({ method: 'real-smoke-lexical-v1', privateEvidence: false }),
          scorerConfigId,
          Date.now(),
          Date.now(),
        ).lastInsertRowid,
    )

    const messages = db
      .prepare(
        `
        SELECT id, conversation_ordinal, sent_at, text
        FROM messages
        WHERE conversation_id = ?
          AND text IS NOT NULL
          AND TRIM(text) <> ''
        ORDER BY conversation_ordinal ASC
      `,
      )
      .all(conversationId)
    const windows = planWindows(messages)
    if (windows.length < DEFAULT_SHIFT_THRESHOLDS.baselineWindowMin + 1) {
      throw new Error('real shift smoke needs more real messages to create enough windows')
    }

    const insertWindow = db.prepare(
      `
      INSERT INTO windows (
        run_id,
        window_config_id,
        conversation_id,
        ordinal,
        start_ordinal,
        end_ordinal,
        context_start_ordinal,
        context_end_ordinal,
        focal_start_ordinal,
        focal_end_ordinal,
        start_message_id,
        end_message_id,
        start_at,
        end_at,
        message_count,
        context_message_count,
        focal_message_count,
        window_metadata_json,
        result_json,
        shift_json,
        status,
        deterministic_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'completed', ?)
    `,
    )

    for (const window of windows) {
      const score = scoreMessages(window.messages)
      insertWindow.run(
        runId,
        windowConfigId,
        conversationId,
        window.ordinal,
        window.start.conversation_ordinal,
        window.end.conversation_ordinal,
        window.contextStart?.conversation_ordinal ?? null,
        window.contextEnd?.conversation_ordinal ?? null,
        window.start.conversation_ordinal,
        window.end.conversation_ordinal,
        window.start.id,
        window.end.id,
        window.start.sent_at,
        window.end.sent_at,
        window.messages.length,
        window.contextCount,
        window.messages.length,
        JSON.stringify({
          source: 'real-device-smoke',
          privateEvidence: false,
          windowSize,
          stride,
        }),
        JSON.stringify({
          scores: score.scores,
          dominant: score.dominant,
          confidence: score.confidence,
          summary: 'Local real-data lexical smoke; no text evidence stored.',
          evidenceMessageIds: [],
          method: 'real-smoke-lexical-v1',
        }),
        `real-smoke:${runId}:${window.ordinal}:${window.start.id}:${window.end.id}`,
      )
    }

    return runId
  })()
}

function upsertScorerConfig(db) {
  db.prepare(
    `
    INSERT INTO scorer_configs (key, label, config_json)
    VALUES ('real-smoke-lexical-v1', 'Real smoke lexical scorer', ?)
    ON CONFLICT(key) DO UPDATE SET
      label = excluded.label,
      config_json = excluded.config_json
  `,
  ).run(JSON.stringify({ privateEvidence: false }))
  return db.prepare('SELECT id FROM scorer_configs WHERE key = ?').get('real-smoke-lexical-v1').id
}

function upsertWindowConfig(db) {
  const name = `real-smoke-${windowSize}-by-${stride}`
  db.prepare(
    `
    INSERT INTO window_configs (name, message_count, stride, min_tail_messages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      message_count = excluded.message_count,
      stride = excluded.stride,
      min_tail_messages = excluded.min_tail_messages
  `,
  ).run(name, windowSize, stride, windowSize)
  return db.prepare('SELECT id FROM window_configs WHERE name = ?').get(name).id
}

function planWindows(messages) {
  const windows = []
  for (let startIndex = 0; startIndex + windowSize <= messages.length; startIndex += stride) {
    const chunk = messages.slice(startIndex, startIndex + windowSize)
    windows.push({
      ordinal: windows.length + 1,
      messages: chunk,
      start: chunk[0],
      end: chunk[chunk.length - 1],
      contextStart: messages[Math.max(0, startIndex - windowSize)] ?? null,
      contextEnd: startIndex > 0 ? messages[startIndex - 1] : null,
      contextCount: startIndex > 0 ? Math.min(windowSize, startIndex) : 0,
    })
  }
  return windows.slice(0, 24)
}

function scoreMessages(messages) {
  const counts = { warmth: 0, joy: 0, stress: 0, friction: 0, sadness: 0 }
  let tokenCount = 0
  for (const message of messages) {
    const tokens = String(message.text ?? '').toLowerCase().match(/[a-z']+/g) ?? []
    tokenCount += tokens.length
    for (const token of tokens) {
      for (const [emotion, words] of Object.entries(LEXICON)) {
        if (words.has(token)) counts[emotion] += 1
      }
    }
  }

  const denominator = Math.max(8, Math.sqrt(Math.max(1, tokenCount)))
  const scores = Object.fromEntries(
    Object.entries(counts).map(([emotion, count]) => [emotion, round(Math.min(1, count / denominator))]),
  )
  const dominant = Object.entries(scores).sort((left, right) => right[1] - left[1])[0][0]
  return {
    scores,
    dominant,
    confidence: round(Math.min(0.9, 0.25 + Object.values(counts).reduce((sum, count) => sum + count, 0) / 20)),
  }
}

function countMessages(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM messages').get().count
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}:${value}`)
    .join(',')
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
