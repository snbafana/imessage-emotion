import type { AppDatabase } from '../db/schema'
import {
  createWindowsForRun,
  type RunWindowConfig,
  validateRunWindowConfig,
} from '../windows/windows'
import { scoreBaselineMessages, type BaselineMessage, type BaselineResult } from './baseline'
import { computeShift, type WindowShift } from './shifts'

export interface CreateBaselineRunOptions extends Partial<RunWindowConfig> {
  scorerConfig?: Record<string, unknown>
}

export interface CreateBaselineRunResult {
  runId: number
  windowCount: number
  summary: BaselineRunSummary
}

export interface BaselineRunSummary {
  method: 'baseline-v1'
  windowCount: number
  averageScores: BaselineResult['scores']
  dominantCounts: Record<BaselineResult['dominant'], number>
  strongestShiftWindowId: number | null
}

export const DEFAULT_BASELINE_RUN_CONFIG: RunWindowConfig = {
  mode: 'comparative-message-count',
  contextMessages: 100,
  focalMessages: 50,
  stride: 50,
  minFocalMessages: 25,
}

type WindowRow = {
  id: number
  focal_start_ordinal: number
  focal_end_ordinal: number
}

export function createBaselineRun(
  db: AppDatabase,
  conversationId: number,
  options: CreateBaselineRunOptions = {},
): CreateBaselineRunResult {
  const { scorerConfig = {}, ...windowOptions } = options
  const windowConfig: RunWindowConfig = {
    ...DEFAULT_BASELINE_RUN_CONFIG,
    ...definedWindowOptions(windowOptions),
  }
  validateRunWindowConfig(windowConfig)
  const startedAt = Date.now()
  const runId = insertRun(db, conversationId, windowConfig, scorerConfig, startedAt)

  try {
    const summary = db.transaction(() => {
      createWindowsForRun(db, runId, conversationId, windowConfig)
      const windows = selectRunWindows(db, runId)
      const results = scoreRunWindows(db, conversationId, windows)
      const summary = summarizeRun(results)
      db.prepare(
        `
        UPDATE analysis_runs
        SET status = 'completed',
          completed_at = ?,
          summary_json = ?
        WHERE id = ?
      `,
      ).run(Date.now(), JSON.stringify(summary), runId)
      return summary
    })()

    return {
      runId,
      windowCount: summary.windowCount,
      summary,
    }
  } catch (error) {
    db.prepare(
      `
      UPDATE analysis_runs
      SET status = 'failed',
        completed_at = ?,
        error = ?
      WHERE id = ?
    `,
    ).run(Date.now(), error instanceof Error ? error.message : String(error), runId)
    throw error
  }
}

function definedWindowOptions(options: Partial<RunWindowConfig>): Partial<RunWindowConfig> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<RunWindowConfig>
}

function insertRun(
  db: AppDatabase,
  conversationId: number,
  windowConfig: RunWindowConfig,
  scorerConfig: Record<string, unknown>,
  startedAt: number,
): number {
  const result = db
    .prepare(
      `
      INSERT INTO analysis_runs (
        conversation_id,
        method_key,
        status,
        window_config_json,
        context_config_json,
        scorer_config_json,
        summary_json,
        started_at
      )
      VALUES (?, 'baseline-v1', 'running', ?, ?, ?, '{}', ?)
    `,
    )
    .run(
      conversationId,
      JSON.stringify(windowConfig),
      JSON.stringify({
        mode: windowConfig.mode,
        contextMessages: windowConfig.contextMessages,
        focalMessages: windowConfig.focalMessages,
      }),
      JSON.stringify({
        method: 'baseline-v1',
        scorer: 'local-lexicon-rules',
        ...scorerConfig,
      }),
      startedAt,
    )
  return Number(result.lastInsertRowid)
}

function selectRunWindows(db: AppDatabase, runId: number): WindowRow[] {
  return db
    .prepare(
      `
      SELECT id, focal_start_ordinal, focal_end_ordinal
      FROM windows
      WHERE run_id = ?
      ORDER BY ordinal
    `,
    )
    .all(runId) as WindowRow[]
}

function scoreRunWindows(
  db: AppDatabase,
  conversationId: number,
  windows: WindowRow[],
): Array<{ windowId: number; result: BaselineResult; shift: WindowShift }> {
  const updateWindow = db.prepare(
    `
    UPDATE windows
    SET result_json = ?,
      shift_json = ?,
      status = 'completed',
      latency_ms = ?
    WHERE id = ?
  `,
  )
  const results: Array<{ windowId: number; result: BaselineResult; shift: WindowShift }> = []
  let previousWindowId: number | null = null
  let previousResult: BaselineResult | null = null

  for (const window of windows) {
    const startedAt = Date.now()
    const messages = selectFocalMessages(
      db,
      conversationId,
      window.focal_start_ordinal,
      window.focal_end_ordinal,
    )
    const result = scoreBaselineMessages(messages)
    const shift = computeShift(previousWindowId, previousResult, result)
    updateWindow.run(
      JSON.stringify(result),
      JSON.stringify(shift),
      Date.now() - startedAt,
      window.id,
    )
    results.push({ windowId: window.id, result, shift })
    previousWindowId = window.id
    previousResult = result
  }

  return results
}

function selectFocalMessages(
  db: AppDatabase,
  conversationId: number,
  focalStartOrdinal: number,
  focalEndOrdinal: number,
): BaselineMessage[] {
  return db
    .prepare(
      `
      SELECT id, text
      FROM messages
      WHERE conversation_id = ?
        AND conversation_ordinal BETWEEN ? AND ?
      ORDER BY conversation_ordinal
    `,
    )
    .all(conversationId, focalStartOrdinal, focalEndOrdinal) as BaselineMessage[]
}

function summarizeRun(
  results: Array<{ windowId: number; result: BaselineResult; shift: WindowShift }>,
): BaselineRunSummary {
  const emotions = ['warmth', 'joy', 'stress', 'friction', 'sadness'] as const
  const totals = Object.fromEntries(emotions.map((emotion) => [emotion, 0])) as BaselineResult['scores']
  const dominantLabels = [...emotions, 'neutral'] as const
  const dominantCounts = Object.fromEntries(dominantLabels.map((emotion) => [emotion, 0])) as Record<
    BaselineResult['dominant'],
    number
  >

  for (const { result } of results) {
    dominantCounts[result.dominant] += 1
    for (const emotion of emotions) {
      totals[emotion] += result.scores[emotion]
    }
  }

  const averageScores = Object.fromEntries(
    emotions.map((emotion) => [
      emotion,
      results.length === 0 ? 0 : Math.round((totals[emotion] / results.length) * 1000) / 1000,
    ]),
  ) as BaselineResult['scores']

  return {
    method: 'baseline-v1',
    windowCount: results.length,
    averageScores,
    dominantCounts,
    strongestShiftWindowId: findStrongestShiftWindow(results),
  }
}

function findStrongestShiftWindow(
  results: Array<{ windowId: number; result: BaselineResult; shift: WindowShift }>,
): number | null {
  let strongestWindowId: number | null = null
  let strongestMagnitude = 0
  for (const { windowId, shift } of results) {
    const magnitude = Math.abs(shift.strongest?.delta ?? 0)
    if (magnitude > strongestMagnitude) {
      strongestWindowId = windowId
      strongestMagnitude = magnitude
    }
  }
  return strongestWindowId
}
