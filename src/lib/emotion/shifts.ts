// Per-window shift for sequential Ax-scored windows.
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
