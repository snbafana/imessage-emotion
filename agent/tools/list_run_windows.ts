import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'

type Scores = Record<string, number>
type Shift = {
  comparedToWindowId?: number | null
  deltas?: Scores
  strongest?: { emotion?: string; delta?: number } | null
  severity?: string
  status?: string
  trend?: string
}

type WindowResult = {
  scores?: Scores
  dominant?: string
  confidence?: number
  summary?: string
  evidenceMessageIds?: number[]
}

export default defineTool({
  description:
    'Read the scored timeline for one analysis run: every window, emotion scores, shift deltas, strongest shifts, and recurrence hints. Use this before timeline-wide answers and before interpreting a specific window.',
  inputSchema: z.object({
    runId: z.number().int().positive().describe('Analysis run id from clientContext.runId'),
  }),
  async execute({ runId }) {
    const windows = getRunWindows(getDb(), runId)
    const seenDominants = new Map<string, Array<{ id: number; ordinal: number }>>()
    const dominantCounts: Record<string, number> = {}
    const mappedWindows = windows.map((w) => {
      const result = (w.result ?? {}) as WindowResult
      const shift = (w.shift ?? {}) as Shift
      const dominant = result.dominant ?? null
      const priorSameDominant = dominant ? seenDominants.get(dominant) ?? [] : []

      if (dominant) {
        dominantCounts[dominant] = (dominantCounts[dominant] ?? 0) + 1
        seenDominants.set(dominant, [...priorSameDominant, { id: w.id, ordinal: w.ordinal }])
      }

      return {
        id: w.id,
        ordinal: w.ordinal,
        status: w.status,
        range: {
          all: `${w.startOrdinal}-${w.endOrdinal}`,
          context:
            w.contextStartOrdinal !== null && w.contextEndOrdinal !== null
              ? `${w.contextStartOrdinal}-${w.contextEndOrdinal}`
              : null,
          focal: `${w.focalStartOrdinal}-${w.focalEndOrdinal}`,
        },
        messageCounts: {
          all: w.messageCount,
          context: w.contextMessageCount,
          focal: w.focalMessageCount,
        },
        dominant,
        confidence: round(result.confidence),
        scores: roundScores(result.scores),
        stateLabel: result.summary ?? null,
        evidenceMessageIds: result.evidenceMessageIds ?? [],
        shift: {
          comparedToWindowId: shift.comparedToWindowId ?? null,
          strongest: shift.strongest ?? null,
          severity: shift.severity ?? shift.status ?? null,
          trend: shift.trend ?? null,
          deltas: roundScores(shift.deltas),
        },
        recurrence: {
          priorSameDominantCount: priorSameDominant.length,
          recentPriorSameDominant: priorSameDominant.slice(-5),
        },
      }
    })
    const strongestShifts = mappedWindows
      .map((w) => ({
        id: w.id,
        ordinal: w.ordinal,
        dominant: w.dominant,
        strongest: w.shift.strongest,
        severity: w.shift.severity,
        magnitude: Math.abs(w.shift.strongest?.delta ?? 0),
      }))
      .filter((w) => w.magnitude > 0)
      .sort((a, b) => b.magnitude - a.magnitude)
      .slice(0, 8)

    return {
      runId,
      windowCount: windows.length,
      scoredWindowCount: mappedWindows.filter((w) => w.scores !== null).length,
      dominantCounts,
      strongestShifts,
      windows: mappedWindows,
      citations: windows.map((w) => ({
        type: 'window' as const,
        id: w.id,
        label: `W${w.ordinal}`,
      })),
    }
  },
})

function roundScores(scores: Scores | undefined): Scores | null {
  if (!scores) return null
  return Object.fromEntries(
    Object.entries(scores).map(([emotion, score]) => [emotion, round(score) ?? 0]),
  )
}

function round(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value * 1000) / 1000
}
