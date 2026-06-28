import { ai } from '@ax-llm/ax'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from './anchors'

export const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0))

export const dominantOf = (s: AnchorScores): Anchor =>
  EKMAN_ANCHORS.reduce((a, b) => (s[b] > s[a] ? b : a), 'neutral' as Anchor)

export const zeroScores = (): AnchorScores =>
  Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, 0])) as AnchorScores

// The scoring sub-query returns a string; tolerate prose around the JSON object.
export function lenientParse(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0]) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

// Route ax through the Vercel AI Gateway (OpenAI-compatible) so one key reaches
// any provider/model.
export function gatewayService(model: string) {
  const apiKey = process.env.AI_GATEWAY_API_KEY
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY not set')
  return ai({
    name: 'openai',
    apiKey,
    apiURL: 'https://ai-gateway.vercel.sh/v1',
    models: [{ key: 'default', description: model, model: model as never }],
    config: { model: 'default' as never, temperature: 0 },
  } as never)
}
