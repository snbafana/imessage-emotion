export type BaselineEmotion = 'warmth' | 'joy' | 'stress' | 'friction' | 'sadness'

export interface BaselineMessage {
  id: number
  text: string | null
}

export interface BaselineResult {
  scores: Record<BaselineEmotion, number>
  dominant: BaselineEmotion | 'neutral'
  confidence: number
  summary: string
  evidenceMessageIds: number[]
  method: 'baseline-v1'
}

const lexicon: Record<BaselineEmotion, string[]> = {
  warmth: [
    'appreciate',
    'care',
    'caring',
    'glad',
    'grateful',
    'heart',
    'helpful',
    'hug',
    'kind',
    'love',
    'miss',
    'proud',
    'support',
    'sweet',
    'thanks',
    'thank',
  ],
  joy: [
    'amazing',
    'awesome',
    'celebrate',
    'excited',
    'fun',
    'haha',
    'happy',
    'hilarious',
    'joy',
    'lol',
    'nice',
    'perfect',
    'yay',
    'yes',
  ],
  stress: [
    'anxious',
    'busy',
    'deadline',
    'exhausted',
    'late',
    'overwhelmed',
    'pressure',
    'stressed',
    'stress',
    'swamped',
    'tense',
    'tired',
    'urgent',
    'worried',
  ],
  friction: [
    'angry',
    'annoyed',
    'argue',
    'blame',
    'conflict',
    'fight',
    'frustrated',
    'mad',
    'no',
    'problem',
    'rude',
    'upset',
    'wrong',
  ],
  sadness: [
    'alone',
    'cry',
    'disappointed',
    'grief',
    'hurt',
    'lonely',
    'sad',
    'sorry',
    'tears',
    'unhappy',
  ],
}

const emotionOrder: BaselineEmotion[] = ['warmth', 'joy', 'stress', 'friction', 'sadness']
const tokenPattern = /[a-z']+/g

export function scoreBaselineMessages(messages: BaselineMessage[]): BaselineResult {
  const counts = Object.fromEntries(emotionOrder.map((emotion) => [emotion, 0])) as Record<
    BaselineEmotion,
    number
  >
  const evidenceScores = new Map<number, number>()

  for (const message of messages) {
    const text = message.text?.toLowerCase() ?? ''
    const tokens = text.match(tokenPattern) ?? []
    let messageHits = 0

    for (const emotion of emotionOrder) {
      const words = lexicon[emotion]
      for (const token of tokens) {
        if (words.includes(token)) {
          counts[emotion] += 1
          messageHits += 1
        }
      }
    }

    if (messageHits > 0) evidenceScores.set(message.id, messageHits)
  }

  const totalHits = emotionOrder.reduce((sum, emotion) => sum + counts[emotion], 0)
  const scores = Object.fromEntries(
    emotionOrder.map((emotion) => [emotion, normalizeScore(counts[emotion], totalHits)]),
  ) as Record<BaselineEmotion, number>
  const dominant =
    totalHits === 0
      ? 'neutral'
      : emotionOrder.reduce((best, emotion) => (scores[emotion] > scores[best] ? emotion : best))
  const sortedScores = [...emotionOrder].sort((left, right) => scores[right] - scores[left])
  const confidence =
    totalHits === 0
      ? 0
      : roundScore(Math.min(1, scores[sortedScores[0]] - scores[sortedScores[1]] + totalHits / 30))

  return {
    scores,
    dominant,
    confidence,
    summary: 'Baseline lexical pass; not final model.',
    evidenceMessageIds: [...evidenceScores.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 5)
      .map(([id]) => id),
    method: 'baseline-v1',
  }
}

function normalizeScore(count: number, totalHits: number): number {
  if (totalHits === 0) return 0
  return roundScore(count / totalHits)
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000
}
