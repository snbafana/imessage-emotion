import type {
  EmotionDelta,
  EmotionScores,
  ShiftThresholds,
  WindowShiftMetadata,
} from '../api/types'
import type { AppDatabase } from '../db/schema'

export interface ShiftDetectionOptions {
  thresholds?: Partial<ShiftThresholds>
}

interface RunWindowRow {
  id: number
  ordinal: number | null
  status: string
  result_json: string
  context_start_ordinal: number | null
  context_end_ordinal: number | null
  focal_start_ordinal: number | null
  focal_end_ordinal: number | null
}

interface ScoredWindow extends RunWindowRow {
  ordinal: number
  scores: EmotionScores | null
}

export const DEFAULT_SHIFT_THRESHOLDS: ShiftThresholds = {
  baselineWindowMin: 3,
  baselineWindowMax: 5,
  minorDelta: 0.12,
  majorDelta: 0.25,
}

const WARM_EMOTIONS = new Set(['warmth', 'joy', 'trust'])
const TENSE_EMOTIONS = new Set(['stress', 'friction', 'anger', 'sadness'])

export function computeRunShifts(
  db: AppDatabase,
  runId: number,
  options: ShiftDetectionOptions = {},
): WindowShiftMetadata[] {
  const thresholds = { ...DEFAULT_SHIFT_THRESHOLDS, ...options.thresholds }
  const windows = loadRunWindows(db, runId)
  const updates: WindowShiftMetadata[] = []
  const updateShift = db.prepare('UPDATE windows SET shift_json = ? WHERE id = ?')

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    const shift = describeWindowShift(window, windows.slice(0, index), thresholds)
    updateShift.run(JSON.stringify(shift), window.id)
    updates.push(shift)
  }

  return updates
}

export function describeWindowShift(
  window: ScoredWindow,
  previousWindows: ScoredWindow[],
  thresholds: ShiftThresholds = DEFAULT_SHIFT_THRESHOLDS,
): WindowShiftMetadata {
  const scores = window.scores
  if (!scores) {
    return emptyShift(window, 'missing_scores', thresholds)
  }

  const baselineWindows = previousWindows
    .filter((candidate) => candidate.scores)
    .slice(-thresholds.baselineWindowMax)

  if (baselineWindows.length < thresholds.baselineWindowMin) {
    return emptyShift(window, 'pending_baseline', thresholds, scores, baselineWindows)
  }

  const baselineScores = averageScores(baselineWindows.map((candidate) => candidate.scores ?? {}))
  const deltas = calculateDeltas(scores, baselineScores)
  const strongest = Object.entries(deltas)
    .map(([emotion, delta]) => describeDelta(emotion, scores[emotion] ?? 0, baselineScores[emotion] ?? 0, delta, thresholds))
    .filter((delta) => delta.severity !== 'none')
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3)
  const maxDelta = strongest[0]?.delta ?? 0
  const status = strongest.some((delta) => delta.severity === 'major')
    ? 'major_shift'
    : strongest.length > 0
      ? 'minor_shift'
      : 'stable'
  const trendScore = calculateTrendScore(deltas)

  return {
    method: 'rolling-shift-v1',
    status,
    windowId: window.id,
    ordinal: window.ordinal,
    baselineWindowIds: baselineWindows.map((candidate) => candidate.id),
    baselineWindowCount: baselineWindows.length,
    thresholds,
    scores,
    baselineScores,
    deltas,
    strongest,
    strongestLabel: strongest[0]?.label ?? null,
    trend: describeTrend(trendScore, maxDelta, thresholds),
    trendScore,
    contextLabel: describeContext(window),
  }
}

function loadRunWindows(db: AppDatabase, runId: number): ScoredWindow[] {
  const rows = db
    .prepare(
      `
      SELECT
        id,
        ordinal,
        status,
        result_json,
        context_start_ordinal,
        context_end_ordinal,
        focal_start_ordinal,
        focal_end_ordinal
      FROM windows
      WHERE run_id = ?
      ORDER BY ordinal, id
    `,
    )
    .all(runId) as RunWindowRow[]

  return rows.map((row, index) => ({
    ...row,
    ordinal: row.ordinal ?? index + 1,
    scores: parseScores(row.result_json),
  }))
}

function parseScores(resultJson: string): EmotionScores | null {
  const parsed = parseJson(resultJson)
  if (!parsed || typeof parsed !== 'object' || !('scores' in parsed)) return null
  const scores = (parsed as { scores: unknown }).scores
  if (!scores || typeof scores !== 'object') return null

  const normalized: EmotionScores = {}
  for (const [emotion, value] of Object.entries(scores)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[emotion] = value
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function emptyShift(
  window: ScoredWindow,
  status: WindowShiftMetadata['status'],
  thresholds: ShiftThresholds,
  scores: EmotionScores = {},
  baselineWindows: ScoredWindow[] = [],
): WindowShiftMetadata {
  return {
    method: 'rolling-shift-v1',
    status,
    windowId: window.id,
    ordinal: window.ordinal,
    baselineWindowIds: baselineWindows.map((candidate) => candidate.id),
    baselineWindowCount: baselineWindows.length,
    thresholds,
    scores,
    baselineScores: {},
    deltas: {},
    strongest: [],
    strongestLabel: null,
    trend: 'stable',
    trendScore: 0,
    contextLabel: describeContext(window),
  }
}

function averageScores(scoreRows: EmotionScores[]): EmotionScores {
  const totals: EmotionScores = {}
  const counts: Record<string, number> = {}

  for (const scores of scoreRows) {
    for (const [emotion, value] of Object.entries(scores)) {
      totals[emotion] = (totals[emotion] ?? 0) + value
      counts[emotion] = (counts[emotion] ?? 0) + 1
    }
  }

  const averages: EmotionScores = {}
  for (const [emotion, total] of Object.entries(totals)) {
    averages[emotion] = round(total / counts[emotion])
  }
  return averages
}

function calculateDeltas(scores: EmotionScores, baselineScores: EmotionScores): Record<string, number> {
  const emotions = new Set([...Object.keys(scores), ...Object.keys(baselineScores)])
  const deltas: Record<string, number> = {}
  for (const emotion of emotions) {
    deltas[emotion] = round((scores[emotion] ?? 0) - (baselineScores[emotion] ?? 0))
  }
  return deltas
}

function describeDelta(
  emotion: string,
  current: number,
  baseline: number,
  delta: number,
  thresholds: ShiftThresholds,
): EmotionDelta {
  const absoluteDelta = Math.abs(delta)
  const severity =
    absoluteDelta >= thresholds.majorDelta
      ? 'major'
      : absoluteDelta >= thresholds.minorDelta
        ? 'minor'
        : 'none'

  return {
    emotion,
    baseline: round(baseline),
    current: round(current),
    delta,
    direction: delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'flat',
    severity,
    label: describeDeltaLabel(emotion, delta),
  }
}

function describeDeltaLabel(emotion: string, delta: number): string {
  if (delta === 0) return `${emotion} stable`
  if (WARM_EMOTIONS.has(emotion)) return delta > 0 ? `${emotion} recovery` : `${emotion} drop`
  if (TENSE_EMOTIONS.has(emotion)) return delta > 0 ? `${emotion} increase` : `${emotion} easing`
  return delta > 0 ? `${emotion} increase` : `${emotion} decrease`
}

function calculateTrendScore(deltas: Record<string, number>): number {
  let trendScore = 0
  for (const [emotion, delta] of Object.entries(deltas)) {
    if (WARM_EMOTIONS.has(emotion)) trendScore += delta
    else if (TENSE_EMOTIONS.has(emotion)) trendScore -= delta
  }
  return round(trendScore)
}

function describeTrend(
  trendScore: number,
  strongestDelta: number,
  thresholds: ShiftThresholds,
): WindowShiftMetadata['trend'] {
  if (Math.abs(strongestDelta) < thresholds.minorDelta) return 'stable'
  if (Math.abs(trendScore) < thresholds.minorDelta) return 'mixed'
  return trendScore > 0 ? 'warmer' : 'tenser'
}

function describeContext(window: RunWindowRow): string | null {
  if (
    window.context_start_ordinal == null ||
    window.context_end_ordinal == null ||
    window.focal_start_ordinal == null ||
    window.focal_end_ordinal == null
  ) {
    return null
  }

  return `context ${window.context_start_ordinal}-${window.context_end_ordinal}; focal ${window.focal_start_ordinal}-${window.focal_end_ordinal}`
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// --- Per-window shift for sequential Ax-scored windows ---
import { EKMAN_ANCHORS, type AnchorScores } from './anchors'

export interface ScoredEmotionResult {
  scores: AnchorScores
  dominant: string
  confidence: number
  summary: string
  method: string
}

export interface WindowShift {
  comparedToWindowId: number | null
  deltas: Record<string, number>
  strongest: {
    emotion: string
    delta: number
  } | null
  severity: 'none' | 'low' | 'medium' | 'high'
}

const emotions = EKMAN_ANCHORS

export function computeShift(
  previousWindowId: number | null,
  previous: ScoredEmotionResult | null,
  current: ScoredEmotionResult,
): WindowShift {
  const deltas = Object.fromEntries(
    emotions.map((emotion) => [
      emotion,
      previous ? roundDelta(current.scores[emotion] - previous.scores[emotion]) : 0,
    ]),
  ) as Record<string, number>
  const strongestEmotion = emotions.reduce((best, emotion) =>
    Math.abs(deltas[emotion]) > Math.abs(deltas[best]) ? emotion : best,
  )
  const strongestDelta = deltas[strongestEmotion]

  return {
    comparedToWindowId: previousWindowId,
    deltas,
    strongest:
      previous && Math.abs(strongestDelta) > 0
        ? { emotion: strongestEmotion, delta: strongestDelta }
        : null,
    severity: classifySeverity(Math.abs(strongestDelta)),
  }
}

function classifySeverity(delta: number): WindowShift['severity'] {
  if (delta >= 0.5) return 'high'
  if (delta >= 0.25) return 'medium'
  if (delta > 0) return 'low'
  return 'none'
}

function roundDelta(value: number): number {
  return Math.round(value * 1000) / 1000
}
