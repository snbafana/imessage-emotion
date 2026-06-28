import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/lib/db/schema.ts'
import { computeAndStoreRunSummary } from '../src/lib/emotion/run-summary.ts'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-emotion-shifts-'))
const dbPath = path.join(tempDir, 'smoke.sqlite')
const db = new Database(dbPath)

try {
  migrate(db)
  const conversationId = seedConversation(db, 90)
  const runId = seedRun(db, conversationId)

  const shifts = computeAndStoreRunSummary(db, runId)
  const windows = db
    .prepare(
      `
      SELECT ordinal, shift_json
      FROM windows
      WHERE run_id = ?
      ORDER BY ordinal
    `,
    )
    .all(runId)
    .map((row) => ({ ...row, shift: JSON.parse(row.shift_json) }))
  const summary = JSON.parse(
    db.prepare('SELECT summary_json FROM analysis_runs WHERE id = ?').get(runId).summary_json,
  )

  const stable = windows.find((window) => window.ordinal === 4).shift
  assert.equal(stable.status, 'stable')
  assert.equal(stable.strongest.length, 0)

  const tenseBoundary = windows.find((window) => window.ordinal === 5).shift
  assert.equal(tenseBoundary.status, 'major_shift')
  assert.equal(tenseBoundary.trend, 'tenser')
  assert(
    tenseBoundary.strongest.some(
      (driver) => driver.emotion === 'stress' && driver.delta >= 0.25,
    ),
    'expected stress increase near the tense boundary',
  )
  assert(
    tenseBoundary.strongest.some(
      (driver) => driver.emotion === 'friction' && driver.delta >= 0.25,
    ),
    'expected friction increase near the tense boundary',
  )

  const repair = windows.find((window) => window.ordinal === 8).shift
  assert.equal(repair.status, 'major_shift')
  assert.equal(repair.trend, 'warmer')
  assert(
    repair.strongest.some((driver) => driver.emotion === 'warmth' && driver.delta >= 0.25),
    'expected warmth recovery in repair',
  )
  assert(
    repair.strongest.some((driver) => driver.emotion === 'joy' && driver.delta >= 0.25),
    'expected joy recovery in repair',
  )

  assert(windows.every((window) => window.shift.method === 'rolling-shift-v1'))
  assert.equal(summary.method, 'rolling-shift-summary-v1')
  assert.equal(summary.windowCount, 9)
  assert.equal(summary.isIncomplete, false)
  assert(summary.majorShiftCount >= 2)
  assert(summary.strongestShift)
  assert(summary.counts.byTrend.tenser >= 1)
  assert(summary.counts.byTrend.warmer >= 1)
  assert(summary.counts.byEmotion.stress >= 1)
  assert(summary.counts.byEmotion.warmth >= 1)
  assert.equal(summary.thresholds.baselineWindowMin, 3)
  assert.equal(shifts.windowCount, 9)

  console.log(
    [
      'shift summary smoke passed',
      `db=${dbPath}`,
      'seed=synthetic warm->tense->repair run-owned windows',
      `stable_window_4=${stable.status}`,
      `tense_window_5=${formatDrivers(tenseBoundary)}`,
      `repair_window_8=${formatDrivers(repair)}`,
      `stored_shift_json=${windows.length}/9`,
      `summary_json=major:${summary.majorShiftCount},minor:${summary.minorShiftCount},stable:${summary.stableWindowCount},strongest:${summary.strongestShift.label}`,
    ].join(' | '),
  )
} finally {
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
}

function seedConversation(db, messageCount) {
  const conversationId = Number(
    db
      .prepare(
        `
        INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group)
        VALUES (9001, 'synthetic-shifts', 'Synthetic shifts', 0)
      `,
      )
      .run().lastInsertRowid,
  )

  const insert = db.prepare(
    `
    INSERT INTO messages (
      conversation_id,
      conversation_ordinal,
      source_rowid,
      guid,
      text,
      sent_at,
      is_from_me,
      is_read,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'delivered')
  `,
  )

  for (let ordinal = 1; ordinal <= messageCount; ordinal += 1) {
    insert.run(
      conversationId,
      ordinal,
      ordinal,
      `synthetic-${ordinal}`,
      `synthetic message ${ordinal}`,
      1_700_000_000_000 + ordinal,
    )
  }

  return conversationId
}

function seedRun(db, conversationId) {
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
          started_at,
          completed_at
        )
        VALUES (?, 'baseline-v1', 'completed', ?, ?, ?, ?, ?)
      `,
      )
      .run(
        conversationId,
        JSON.stringify({ mode: 'comparative-message-count', contextMessages: 10, focalMessages: 10 }),
        JSON.stringify({ previousWindows: 3 }),
        JSON.stringify({ method: 'baseline-v1', fixture: 'synthetic-smoke' }),
        1_700_000_000_000,
        1_700_000_001_000,
      ).lastInsertRowid,
  )

  const scores = [
    warmScores(),
    warmScores(),
    warmScores(),
    warmScores(),
    { warmth: 0.35, joy: 0.2, stress: 0.62, friction: 0.55, sadness: 0.2 },
    { warmth: 0.3, joy: 0.18, stress: 0.7, friction: 0.62, sadness: 0.22 },
    { warmth: 0.32, joy: 0.2, stress: 0.66, friction: 0.58, sadness: 0.18 },
    { warmth: 0.78, joy: 0.64, stress: 0.22, friction: 0.18, sadness: 0.12 },
    { warmth: 0.76, joy: 0.62, stress: 0.2, friction: 0.16, sadness: 0.1 },
  ]
  const insertWindow = db.prepare(
    `
    INSERT INTO windows (
      run_id,
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
      message_count,
      context_message_count,
      focal_message_count,
      window_metadata_json,
      result_json,
      shift_json,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 0, 10, ?, ?, '{}', 'completed')
  `,
  )

  scores.forEach((score, index) => {
    const ordinal = index + 1
    const startOrdinal = index * 10 + 1
    const endOrdinal = startOrdinal + 9
    insertWindow.run(
      runId,
      conversationId,
      ordinal,
      startOrdinal,
      endOrdinal,
      ordinal === 1 ? null : Math.max(1, startOrdinal - 10),
      ordinal === 1 ? null : startOrdinal - 1,
      startOrdinal,
      endOrdinal,
      startOrdinal,
      endOrdinal,
      JSON.stringify({ fixtureArc: ordinal < 5 ? 'warm' : ordinal < 8 ? 'tense' : 'repair' }),
      JSON.stringify({
        scores: score,
        dominant: dominantEmotion(score),
        confidence: 0.8,
        summary: 'Synthetic lexical score for shift smoke.',
        evidenceMessageIds: [startOrdinal, endOrdinal],
        method: 'baseline-v1',
      }),
    )
  })

  return runId
}

function warmScores() {
  return { warmth: 0.7, joy: 0.55, stress: 0.1, friction: 0.08, sadness: 0.1 }
}

function dominantEmotion(scores) {
  return Object.entries(scores).sort((left, right) => right[1] - left[1])[0][0]
}

function formatDrivers(shift) {
  return shift.strongest
    .slice(0, 2)
    .map((driver) => `${driver.emotion}:${driver.delta}`)
    .join(',')
}
