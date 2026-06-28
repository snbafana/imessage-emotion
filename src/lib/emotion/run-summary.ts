import type {
  DashboardShift,
  RunSummaryMetadata,
  ShiftThresholds,
  WindowShiftMetadata,
} from '../api/types'
import type { AppDatabase } from '../db/schema'
import {
  DEFAULT_SHIFT_THRESHOLDS,
  computeRunShifts,
  type ShiftDetectionOptions,
} from './shifts'

interface RunRow {
  id: number
  status: string
}

interface RunWindowStatusRow {
  status: string
  result_json: string
}

export function computeAndStoreRunSummary(
  db: AppDatabase,
  runId: number,
  options: ShiftDetectionOptions = {},
): RunSummaryMetadata {
  const run = db
    .prepare('SELECT id, status FROM analysis_runs WHERE id = ?')
    .get(runId) as RunRow | undefined
  if (!run) throw new Error(`Missing analysis run ${runId}`)

  const shifts = computeRunShifts(db, runId, options)
  const windowStatuses = loadWindowStatuses(db, runId)
  const thresholds = { ...DEFAULT_SHIFT_THRESHOLDS, ...options.thresholds }
  const summary = summarizeShifts(run, windowStatuses, shifts, thresholds)

  db.prepare('UPDATE analysis_runs SET summary_json = ? WHERE id = ?').run(
    JSON.stringify(summary),
    runId,
  )

  return summary
}

function loadWindowStatuses(db: AppDatabase, runId: number): RunWindowStatusRow[] {
  return db
    .prepare(
      `
      SELECT status, result_json
      FROM windows
      WHERE run_id = ?
      ORDER BY ordinal, id
    `,
    )
    .all(runId) as RunWindowStatusRow[]
}

function summarizeShifts(
  run: RunRow,
  windowStatuses: RunWindowStatusRow[],
  shifts: WindowShiftMetadata[],
  thresholds: ShiftThresholds,
): RunSummaryMetadata {
  const shifted = shifts.filter((shift) => shift.status === 'major_shift' || shift.status === 'minor_shift')
  const strongestShift = selectStrongestShift(shifted)
  const pendingWindowCount = windowStatuses.filter((window) => !isScored(window)).length
  const scoredWindowCount = windowStatuses.length - pendingWindowCount
  const isPending = run.status === 'pending' || pendingWindowCount > 0

  return {
    method: 'rolling-shift-summary-v1',
    runId: run.id,
    status: run.status,
    isPending,
    isIncomplete: isPending || run.status !== 'completed',
    windowCount: windowStatuses.length,
    scoredWindowCount,
    pendingWindowCount,
    shiftedWindowCount: shifted.length,
    majorShiftCount: shifts.filter((shift) => shift.status === 'major_shift').length,
    minorShiftCount: shifts.filter((shift) => shift.status === 'minor_shift').length,
    stableWindowCount: shifts.filter((shift) => shift.status === 'stable').length,
    strongestShift,
    strongestTrend: strongestShift?.trend ?? summarizeTrend(shifts),
    counts: {
      byTrend: countByTrend(shifts),
      byEmotion: countByEmotion(shifted),
    },
    thresholds,
    updatedAt: new Date().toISOString(),
  }
}

function selectStrongestShift(shifts: WindowShiftMetadata[]): DashboardShift | null {
  let strongest: DashboardShift | null = null

  for (const shift of shifts) {
    const driver = shift.strongest[0]
    if (!driver || driver.severity === 'none') continue
    const candidate: DashboardShift = {
      windowId: shift.windowId,
      ordinal: shift.ordinal,
      label: driver.label,
      emotion: driver.emotion,
      delta: driver.delta,
      severity: driver.severity,
      trend: shift.trend,
      contextLabel: shift.contextLabel,
    }
    if (!strongest || Math.abs(candidate.delta) > Math.abs(strongest.delta)) {
      strongest = candidate
    }
  }

  return strongest
}

function summarizeTrend(shifts: WindowShiftMetadata[]): WindowShiftMetadata['trend'] {
  const counts = countByTrend(shifts)
  const ranked = Object.entries(counts)
    .filter(([trend]) => trend !== 'stable')
    .sort((left, right) => right[1] - left[1])
  return (ranked[0]?.[0] as WindowShiftMetadata['trend'] | undefined) ?? 'stable'
}

function countByTrend(shifts: WindowShiftMetadata[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const shift of shifts) {
    counts[shift.trend] = (counts[shift.trend] ?? 0) + 1
  }
  return counts
}

function countByEmotion(shifts: WindowShiftMetadata[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const shift of shifts) {
    const emotion = shift.strongest[0]?.emotion
    if (emotion) counts[emotion] = (counts[emotion] ?? 0) + 1
  }
  return counts
}

function isScored(window: RunWindowStatusRow): boolean {
  if (window.status === 'pending') return false
  try {
    const result = JSON.parse(window.result_json) as { scores?: unknown }
    return Boolean(result.scores && typeof result.scores === 'object')
  } catch {
    return false
  }
}
