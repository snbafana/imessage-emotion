import type { AppDatabase } from '../db/schema'
import { parseJsonRecord } from './db'
import type { AnalysisWindow, RunStatus, RunSummary } from './types'

type RunRow = {
  id: number
  conversation_id: number | null
  method_key: string | null
  status: string
  started_at: number
  completed_at: number | null
  window_config_json: string | null
  scorer_config_json: string | null
  summary_json: string | null
  window_count: number
  scored_window_count: number
  error: string | null
}

type WindowRow = {
  id: number
  run_id: number
  conversation_id: number
  ordinal: number
  start_ordinal: number
  end_ordinal: number
  context_start_ordinal: number | null
  context_end_ordinal: number | null
  focal_start_ordinal: number
  focal_end_ordinal: number
  message_count: number
  context_message_count: number
  focal_message_count: number
  window_metadata_json: string | null
  result_json: string | null
  shift_json: string | null
  status: string
  latency_ms: number | null
  error: string | null
  created_at: number
}

function mapRun(row: RunRow): RunSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? 0,
    methodKey: row.method_key ?? 'unknown',
    status: mapStatus(row.status),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    windowConfig: parseJsonRecord(row.window_config_json),
    scorerConfig: parseJsonRecord(row.scorer_config_json),
    summary: parseJsonRecord(row.summary_json),
    windowCount: row.window_count,
    scoredWindowCount: row.scored_window_count,
    error: row.error,
  }
}

function mapWindow(row: WindowRow): AnalysisWindow {
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    startOrdinal: row.start_ordinal,
    endOrdinal: row.end_ordinal,
    contextStartOrdinal: row.context_start_ordinal,
    contextEndOrdinal: row.context_end_ordinal,
    focalStartOrdinal: row.focal_start_ordinal,
    focalEndOrdinal: row.focal_end_ordinal,
    messageCount: row.message_count,
    contextMessageCount: row.context_message_count,
    focalMessageCount: row.focal_message_count,
    metadata: parseJsonRecord(row.window_metadata_json),
    result: parseJsonRecord(row.result_json),
    shift: parseJsonRecord(row.shift_json),
    status: mapStatus(row.status),
    latencyMs: row.latency_ms,
    error: row.error,
    createdAt: row.created_at,
  }
}

function mapStatus(status: string): RunStatus {
  if (status === 'complete') return 'completed'
  if (status === 'running' || status === 'completed' || status === 'error') return status
  return 'pending'
}

export function listRuns(db: AppDatabase, conversationId: number): RunSummary[] {
  const rows = db
    .prepare(
      `
      SELECT
        ar.id,
        ar.conversation_id,
        ar.method_key,
        ar.status,
        ar.started_at,
        ar.completed_at,
        ar.window_config_json,
        ar.scorer_config_json,
        ar.summary_json,
        COUNT(w.id) AS window_count,
        COALESCE(SUM(CASE WHEN w.status = 'completed' THEN 1 ELSE 0 END), 0) AS scored_window_count,
        ar.error
      FROM analysis_runs ar
      LEFT JOIN windows w ON w.run_id = ar.id
      WHERE ar.conversation_id = ?
      GROUP BY ar.id
      ORDER BY ar.started_at DESC, ar.id DESC
    `,
    )
    .all(conversationId) as RunRow[]
  return rows.map(mapRun)
}

export function getRunWindows(db: AppDatabase, runId: number): AnalysisWindow[] {
  const rows = db
    .prepare(
      `
      SELECT
        w.id,
        w.run_id,
        w.conversation_id,
        w.ordinal,
        w.start_ordinal,
        w.end_ordinal,
        w.context_start_ordinal,
        w.context_end_ordinal,
        w.focal_start_ordinal,
        w.focal_end_ordinal,
        w.message_count,
        w.context_message_count,
        w.focal_message_count,
        w.window_metadata_json,
        w.result_json,
        w.shift_json,
        w.status,
        w.latency_ms,
        w.error,
        w.created_at
      FROM windows w
      WHERE w.run_id = ?
      ORDER BY w.ordinal, w.id
    `,
    )
    .all(runId) as WindowRow[]
  return rows.map(mapWindow)
}
