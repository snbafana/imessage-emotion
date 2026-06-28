import type { AppDatabase } from '../db/schema'
import { parseJsonRecord } from '../api/db'
import {
  createWindowsForRun,
  type RunWindowConfig,
  validateRunWindowConfig,
} from '../windows/windows'
import { EKMAN_ANCHORS, type AnchorScores } from './anchors'
import {
  scoreWindowWithAx,
  type AxScorerConfig,
  type AxWindowInput,
  type AxWindowMessage,
  type AxWindowResult,
} from './ax-scorer'
import { computeShift, type ScoredEmotionResult, type WindowShift } from './shifts'

export interface CreateAxRunOptions extends Partial<RunWindowConfig> {
  scorerConfig?: AxScorerConfig & Record<string, unknown>
  scorer?: AxWindowScorer
  // How many windows to score concurrently. Defaults to DEFAULT_SCORE_CONCURRENCY.
  concurrency?: number
}

export interface CreateAxRunResult {
  runId: number
  windowCount: number
}

export interface CreateAxAnalysisRunResult extends CreateAxRunResult {
  summary: AxRunSummary
}

export interface AxRunSummary {
  method: 'ax-llm-v1'
  windowCount: number
  averageScores: AxWindowResult['scores']
  dominantCounts: Record<string, number>
  strongestShiftWindowId: number | null
}

export type AxWindowScorer = (
  input: AxWindowInput,
  config: AxScorerConfig,
) => Promise<AxWindowResult>

type RunRow = {
  id: number
  conversation_id: number
  scorer_config_json: string
}

type WindowRow = {
  id: number
  ordinal: number
  start_ordinal: number
  end_ordinal: number
  focal_start_ordinal: number
  focal_end_ordinal: number
}

type MessageRow = {
  id: number
  conversation_ordinal: number
  text: string | null
  is_from_me: number
  sender_name: string | null
}

type ResultRow = {
  id: number
  result_json: string
}

export const AX_METHOD_KEY = 'ax-llm-v1'

// Default number of windows scored in parallel. Windows are independent LLM
// calls, so a small pool turns an N-deep serial chain into ~N/pool batches
// without overwhelming the provider's rate limits.
export const DEFAULT_SCORE_CONCURRENCY = 8

export const DEFAULT_AX_RUN_CONFIG: RunWindowConfig = {
  mode: 'comparative-message-count',
  contextMessages: 80,
  focalMessages: 40,
  stride: 30,
  minFocalMessages: 20,
}

export function createAxRun(
  db: AppDatabase,
  conversationId: number,
  options: CreateAxRunOptions = {},
): CreateAxRunResult {
  const { scorer, scorerConfig = {}, ...windowOptions } = options
  void scorer
  const windowConfig: RunWindowConfig = {
    ...DEFAULT_AX_RUN_CONFIG,
    ...definedWindowOptions(windowOptions),
  }
  validateRunWindowConfig(windowConfig)
  const runId = insertRun(db, conversationId, windowConfig, scorerConfig, Date.now())
  const windowIds = createWindowsForRun(db, runId, conversationId, windowConfig)
  return { runId, windowCount: windowIds.length }
}

export async function createAxAnalysisRun(
  db: AppDatabase,
  conversationId: number,
  options: CreateAxRunOptions = {},
): Promise<CreateAxAnalysisRunResult> {
  const { runId, windowCount } = createAxRun(db, conversationId, options)
  const summary = await finishAxRun(db, runId, options)
  return { runId, windowCount, summary }
}

// Score an already-created run to completion and mark it complete. Marks the run
// failed (and rethrows) only if scoring could not produce a single window — a
// single window error no longer sinks the whole run.
export async function finishAxRun(
  db: AppDatabase,
  runId: number,
  options: Pick<CreateAxRunOptions, 'scorer' | 'concurrency'> = {},
): Promise<AxRunSummary> {
  try {
    await scoreAxRun(db, runId, options)
    return completeAxRun(db, runId)
  } catch (error) {
    failRun(db, runId, error)
    throw error
  }
}

export async function scoreAxRun(
  db: AppDatabase,
  runId: number,
  options: Pick<CreateAxRunOptions, 'scorer' | 'concurrency'> = {},
): Promise<void> {
  const run = getRun(db, runId)
  const config = parseJsonRecord(run.scorer_config_json) as AxScorerConfig
  const windows = selectRunWindows(db, runId)
  const scorer = options.scorer ?? scoreWindowWithAx
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_SCORE_CONCURRENCY)

  // Each window is scored independently and in parallel: it already carries its
  // own context messages, so we no longer thread prior-window scores through a
  // serial loop. Cross-window shift deltas are recomputed deterministically in a
  // second ordered pass below.
  let scored = 0
  let lastError: unknown = null
  await runWithConcurrency(windows, concurrency, async (window) => {
    try {
      await scoreWindowStandalone(db, run.conversation_id, runId, window, config, scorer)
      scored += 1
    } catch (error) {
      lastError = error
    }
  })

  if (scored === 0 && windows.length > 0) {
    throw lastError instanceof Error ? lastError : new Error('No analysis windows could be scored')
  }

  recomputeRunShifts(db, runId)
}

// Score a single window with no dependency on any other window, persisting the
// result. Shift deltas are intentionally left for recomputeRunShifts.
async function scoreWindowStandalone(
  db: AppDatabase,
  conversationId: number,
  runId: number,
  window: WindowRow,
  config: AxScorerConfig,
  scorer: AxWindowScorer,
): Promise<void> {
  const startedAt = Date.now()
  try {
    const result = await scorer(
      {
        runId,
        windowId: window.id,
        ordinal: window.ordinal,
        messages: selectWindowMessages(db, conversationId, window),
      },
      config,
    )
    db.prepare(
      `
      UPDATE windows
      SET result_json = ?,
        status = 'completed',
        latency_ms = ?,
        error = NULL
      WHERE id = ?
    `,
    ).run(JSON.stringify(result), Date.now() - startedAt, window.id)
  } catch (error) {
    db.prepare(
      `
      UPDATE windows
      SET status = 'error',
        latency_ms = ?,
        error = ?
      WHERE id = ?
    `,
    ).run(Date.now() - startedAt, error instanceof Error ? error.message : String(error), window.id)
    throw error
  }
}

// Recompute each completed window's shift relative to the previous completed
// window in ordinal order. Pure DB work, wrapped in one transaction.
function recomputeRunShifts(db: AppDatabase, runId: number): void {
  const rows = db
    .prepare(
      `
      SELECT id, result_json
      FROM windows
      WHERE run_id = ?
        AND status = 'completed'
      ORDER BY ordinal
    `,
    )
    .all(runId) as ResultRow[]
  const update = db.prepare(`UPDATE windows SET shift_json = ? WHERE id = ?`)
  let previousWindowId: number | null = null
  let previousResult: ScoredEmotionResult | null = null
  const apply = db.transaction(() => {
    for (const row of rows) {
      const result = parseResult(row.result_json)
      if (!result) continue
      const shift = computeShift(previousWindowId, previousResult, result)
      update.run(JSON.stringify(shift), row.id)
      previousWindowId = row.id
      previousResult = result
    }
  })
  apply()
}

// Run worker over items with at most `limit` in flight at once.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

export async function scoreAxRunWindow(
  db: AppDatabase,
  runId: number,
  windowId: number,
  options: Pick<CreateAxRunOptions, 'scorer'> = {},
): Promise<AxWindowResult> {
  const run = getRun(db, runId)
  const window = selectRunWindows(db, runId).find((candidate) => candidate.id === windowId)
  if (!window) throw new Error(`window ${windowId} not in run ${runId}`)

  const config = parseJsonRecord(run.scorer_config_json) as AxScorerConfig
  const startedAt = Date.now()
  try {
    const previous = previousResults(db, runId, window.ordinal)
    const result = await (options.scorer ?? scoreWindowWithAx)(
      {
        runId,
        windowId,
        ordinal: window.ordinal,
        messages: selectWindowMessages(db, run.conversation_id, window),
      },
      config,
    )
    const shift = computeShift(previous.at(-1)?.windowId ?? null, previous.at(-1)?.result ?? null, result)
    db.prepare(
      `
      UPDATE windows
      SET result_json = ?,
        shift_json = ?,
        status = 'completed',
        latency_ms = ?,
        error = NULL
      WHERE id = ?
    `,
    ).run(JSON.stringify(result), JSON.stringify(shift), Date.now() - startedAt, windowId)
    return result
  } catch (error) {
    db.prepare(
      `
      UPDATE windows
      SET status = 'error',
        latency_ms = ?,
        error = ?
      WHERE id = ?
    `,
    ).run(Date.now() - startedAt, error instanceof Error ? error.message : String(error), windowId)
    throw error
  }
}

export function completeAxRun(db: AppDatabase, runId: number): AxRunSummary {
  const results = allResults(db, runId)
  const summary = summarizeRun(results)
  db.prepare(
    `
    UPDATE analysis_runs
    SET status = 'completed',
      completed_at = ?,
      summary_json = ?,
      error = NULL
    WHERE id = ?
  `,
  ).run(Date.now(), JSON.stringify(summary), runId)
  return summary
}

export function deleteAllAnalysisRuns(db: AppDatabase): number {
  const result = db.prepare('DELETE FROM analysis_runs').run()
  return result.changes
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
      VALUES (?, ?, 'running', ?, ?, ?, '{}', ?)
    `,
    )
    .run(
      conversationId,
      AX_METHOD_KEY,
      JSON.stringify(windowConfig),
      JSON.stringify({
        mode: windowConfig.mode,
        contextMessages: windowConfig.contextMessages,
        focalMessages: windowConfig.focalMessages,
      }),
      JSON.stringify({
        method: AX_METHOD_KEY,
        scorer: 'ax-llm',
        promptKey: 'ax-ekman-window-v1',
        ...scorerConfig,
      }),
      startedAt,
    )
  return Number(result.lastInsertRowid)
}

function getRun(db: AppDatabase, runId: number): RunRow {
  const row = db
    .prepare(
      `
      SELECT id, conversation_id, scorer_config_json
      FROM analysis_runs
      WHERE id = ?
    `,
    )
    .get(runId) as RunRow | undefined
  if (!row) throw new Error(`Missing analysis run ${runId}`)
  return row
}

function selectRunWindows(db: AppDatabase, runId: number): WindowRow[] {
  return db
    .prepare(
      `
      SELECT
        id,
        ordinal,
        start_ordinal,
        end_ordinal,
        focal_start_ordinal,
        focal_end_ordinal
      FROM windows
      WHERE run_id = ?
      ORDER BY ordinal
    `,
    )
    .all(runId) as WindowRow[]
}

function selectWindowMessages(
  db: AppDatabase,
  conversationId: number,
  window: WindowRow,
): AxWindowMessage[] {
  const rows = db
    .prepare(
      `
      SELECT
        m.id,
        m.conversation_ordinal,
        m.text,
        m.is_from_me,
        COALESCE(NULLIF(c.display_name, ''), c.handle_identifier) AS sender_name
      FROM messages m
      LEFT JOIN contacts c ON c.id = m.sender_contact_id
      WHERE m.conversation_id = ?
        AND m.conversation_ordinal BETWEEN ? AND ?
      ORDER BY m.conversation_ordinal, m.sent_at, m.source_rowid, m.guid
    `,
    )
    .all(conversationId, window.start_ordinal, window.end_ordinal) as MessageRow[]

  return rows.map((row) => ({
    id: row.id,
    ordinal: row.conversation_ordinal,
    text: row.text,
    isFromMe: row.is_from_me === 1,
    senderName: row.sender_name,
    role:
      row.conversation_ordinal >= window.focal_start_ordinal &&
      row.conversation_ordinal <= window.focal_end_ordinal
        ? 'focal'
        : 'context',
  }))
}

function previousResults(
  db: AppDatabase,
  runId: number,
  ordinal: number,
): Array<{ windowId: number; result: ScoredEmotionResult }> {
  const rows = db
    .prepare(
      `
      SELECT id, result_json
      FROM windows
      WHERE run_id = ?
        AND ordinal < ?
        AND status = 'completed'
      ORDER BY ordinal
    `,
    )
    .all(runId, ordinal) as ResultRow[]
  return rows
    .map((row) => ({ windowId: row.id, result: parseResult(row.result_json) }))
    .filter((row): row is { windowId: number; result: ScoredEmotionResult } => row.result !== null)
}

function allResults(db: AppDatabase, runId: number): Array<{ windowId: number; result: ScoredEmotionResult; shift: WindowShift }> {
  const rows = db
    .prepare(
      `
      SELECT id, result_json, shift_json
      FROM windows
      WHERE run_id = ?
        AND status = 'completed'
      ORDER BY ordinal
    `,
    )
    .all(runId) as Array<ResultRow & { shift_json: string }>
  return rows
    .map((row) => {
      const result = parseResult(row.result_json)
      const shift = parseJsonRecord(row.shift_json) as unknown as WindowShift
      return result ? { windowId: row.id, result, shift } : null
    })
    .filter((row): row is { windowId: number; result: ScoredEmotionResult; shift: WindowShift } => row !== null)
}

function parseResult(value: string): ScoredEmotionResult | null {
  const parsed = parseJsonRecord(value)
  const scores = parsed.scores
  if (!scores || typeof scores !== 'object') return null
  const normalized = Object.fromEntries(
    EKMAN_ANCHORS.map((anchor) => {
      const value = (scores as Record<string, unknown>)[anchor]
      return [anchor, typeof value === 'number' && Number.isFinite(value) ? value : 0]
    }),
  ) as AnchorScores
  return {
    scores: normalized,
    dominant: typeof parsed.dominant === 'string' ? parsed.dominant : 'neutral',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    method: typeof parsed.method === 'string' ? parsed.method : AX_METHOD_KEY,
  }
}

function averageScores(rows: Array<{ result: ScoredEmotionResult }>): AnchorScores {
  if (rows.length === 0) return Object.fromEntries(EKMAN_ANCHORS.map((anchor) => [anchor, 0])) as AnchorScores
  const totals = Object.fromEntries(EKMAN_ANCHORS.map((anchor) => [anchor, 0])) as AnchorScores
  for (const { result } of rows) {
    for (const anchor of EKMAN_ANCHORS) totals[anchor] += result.scores[anchor] ?? 0
  }
  return Object.fromEntries(
    EKMAN_ANCHORS.map((anchor) => [anchor, Math.round((totals[anchor] / rows.length) * 1000) / 1000]),
  ) as AnchorScores
}

function summarizeRun(
  results: Array<{ windowId: number; result: ScoredEmotionResult; shift: WindowShift }>,
): AxRunSummary {
  const average = averageScores(results)
  const dominantCounts: Record<string, number> = Object.fromEntries(EKMAN_ANCHORS.map((anchor) => [anchor, 0]))
  for (const { result } of results) dominantCounts[result.dominant] = (dominantCounts[result.dominant] ?? 0) + 1

  return {
    method: AX_METHOD_KEY,
    windowCount: results.length,
    averageScores: average,
    dominantCounts,
    strongestShiftWindowId: findStrongestShiftWindow(results),
  }
}

function findStrongestShiftWindow(
  results: Array<{ windowId: number; result: ScoredEmotionResult; shift: WindowShift }>,
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

function failRun(db: AppDatabase, runId: number, error: unknown): void {
  db.prepare(
    `
    UPDATE analysis_runs
    SET status = 'error',
      completed_at = ?,
      error = ?
    WHERE id = ?
  `,
  ).run(Date.now(), error instanceof Error ? error.message : String(error), runId)
}
