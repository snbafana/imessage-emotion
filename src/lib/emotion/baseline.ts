import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from './anchors'

export type BaselineEmotion = Anchor

export interface BaselineMessage {
  id: number
  text: string | null
}

export interface BaselineResult {
  scores: AnchorScores
  dominant: Anchor
  confidence: number
  summary: string
  evidenceMessageIds: number[]
  method: 'baseline-v1'
}

// Deterministic lexical pass over the Ekman anchors (ported from
// experiments/emotion-methods harness_ax.ts FEATURE_LEXICON). Not the final
// model — the ax LLM scorer (agent/tools/score_window) is the production path.
const lexicon: Record<Anchor, string[]> = {
  anger: ['mad', 'angry', 'frustrated', 'annoyed', 'hurt', 'issue', 'dodging', 'dismissed', 'defensive', 'upset'],
  disgust: ['gross', 'disgusting', 'ugh', 'ew', 'nasty', 'hate'],
  fear: ['worried', 'anxious', 'stress', 'stressed', 'overwhelmed', 'panic', 'scared', 'nervous', 'please'],
  joy: ['love', 'loved', 'miss', 'missed', 'care', 'appreciate', 'thank', 'thanks', 'proud', 'sweet', 'kind', 'hug', 'lol', 'haha', 'fun', 'funny', 'excited', 'yay', 'great', 'amazing'],
  neutral: ['train', 'delayed', 'keys', 'desk', 'arrive', 'when', 'where', 'time', 'minutes', 'tomorrow', 'today', 'schedule'],
  sadness: ['sad', 'sorry', 'tired', 'distant', 'later', 'energy', 'alone'],
  surprise: ['wow', 'whoa', 'omg', 'surprised', 'unexpected', 'wait'],
}

const tokenPattern = /[a-z']+/g

export function scoreBaselineMessages(messages: BaselineMessage[]): BaselineResult {
  const counts = Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, 0])) as AnchorScores
  const evidenceScores = new Map<number, number>()

  for (const message of messages) {
    const text = message.text?.toLowerCase() ?? ''
    const tokens = text.match(tokenPattern) ?? []
    let messageHits = 0

    for (const anchor of EKMAN_ANCHORS) {
      const words = lexicon[anchor]
      for (const token of tokens) {
        if (words.includes(token)) {
          counts[anchor] += 1
          messageHits += 1
        }
      }
    }

    if (messageHits > 0) evidenceScores.set(message.id, messageHits)
  }

  const totalHits = EKMAN_ANCHORS.reduce((sum, a) => sum + counts[a], 0)
  // No lexical hits anywhere => treat the window as neutral.
  const scores = Object.fromEntries(
    EKMAN_ANCHORS.map((a) => [a, totalHits === 0 ? (a === 'neutral' ? 1 : 0) : roundScore(counts[a] / totalHits)]),
  ) as AnchorScores
  const dominant = EKMAN_ANCHORS.reduce((best, a) => (scores[a] > scores[best] ? a : best), 'neutral' as Anchor)
  const sorted = [...EKMAN_ANCHORS].sort((l, r) => scores[r] - scores[l])
  const confidence =
    totalHits === 0 ? 0 : roundScore(Math.min(1, scores[sorted[0]] - scores[sorted[1]] + totalHits / 30))

  return {
    scores,
    dominant,
    confidence,
    summary: 'Baseline lexical pass; not final model.',
    evidenceMessageIds: [...evidenceScores.entries()]
      .sort((l, r) => r[1] - l[1] || l[0] - r[0])
      .slice(0, 5)
      .map(([id]) => id),
    method: 'baseline-v1',
  }
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000
}
