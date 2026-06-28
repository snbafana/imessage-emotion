import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { ai, ax } from '@ax-llm/ax'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'
import { getWindowMessages } from '../../src/lib/api/messages'

// Canonical Ekman/RoBERTa anchors — must match experiments/emotion-methods.
const ANCHORS = ['anger', 'disgust', 'fear', 'joy', 'neutral', 'sadness', 'surprise'] as const
type Anchor = (typeof ANCHORS)[number]
type Scores = Record<Anchor, number>

// Same Ax structured signature as the experiments harness (harness_ax.ts).
const scoreWindowWithAx = ax(`
  taskContext:string "Instructions and JSON contract",
  baselineJson:string "Prior conversation baseline scores as JSON",
  windowRef:string "Stable local window reference",
  windowText:string "Bounded iMessage window with local message refs"
  ->
  anger:number "anger score 0..1",
  disgust:number "disgust score 0..1",
  fear:number "fear score 0..1",
  joy:number "joy score 0..1",
  neutral:number "neutral score 0..1",
  sadness:number "sadness score 0..1",
  surprise:number "surprise score 0..1",
  confidence:number "confidence 0..1",
  stateLabel:string "short non-identifying state label",
  rationale:string "one or two sentences: why this dominant emotion, citing what shifted vs the baseline (no names, no verbatim quotes)"
`)

// Effort tier -> model + token budget (latency/quality trade-off).
const EFFORT = {
  low: { model: 'gpt-4.1-nano', maxTokens: 250 },
  medium: { model: 'gpt-4o-mini', maxTokens: 350 },
  high: { model: 'gpt-5-mini', maxTokens: 600 },
} as const

function service(model: string, maxTokens: number) {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Set OPENAI_API_KEY or OPENROUTER_API_KEY to run the ax scorer')
  const apiURL = process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined
  return ai({
    name: 'openai',
    apiKey,
    apiURL,
    models: [{ key: 'default', description: model, model: model as never }],
    config: { model: 'default' as never, temperature: 0, maxTokens },
  } as never)
}

const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0))
const dominant = (s: Scores) => ANCHORS.reduce((a, b) => (s[b] > s[a] ? b : a), 'neutral' as Anchor)

export default defineTool({
  description:
    'Score one analysis window for the 7 Ekman emotions (anger, disgust, fear, joy, neutral, sadness, surprise) with the Ax LLM scorer. Recompute on demand; pick effort (low/medium/high) to trade latency for quality and contextMessages to widen the baseline. Returns normalized scores + the dominant emotion + citations.',
  inputSchema: z.object({
    runId: z.number(),
    windowId: z.number(),
    effort: z.enum(['low', 'medium', 'high']).default('medium').describe('latency/quality tier'),
    contextMessages: z.number().default(0).describe('how many context messages to include before the focal slice'),
  }),
  async execute({ runId, windowId, effort, contextMessages }) {
    const db = getDb()
    const windows = getRunWindows(db, runId)
    const index = windows.findIndex((w) => w.id === windowId)
    if (index === -1) return { error: `window ${windowId} not in run ${runId}` }
    const target = windows[index]

    // Baseline = average of prior windows' Ekman scores (0 where unscored).
    const priors = windows.slice(Math.max(0, index - 3), index)
    const baseline = Object.fromEntries(
      ANCHORS.map((a) => {
        const vals = priors.map((w) => ((w.result ?? {}) as { scores?: Partial<Scores> }).scores?.[a] ?? 0)
        return [a, vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0]
      }),
    ) as Scores

    const focal = getWindowMessages(db, windowId, 'focal')
    const context = contextMessages > 0 ? getWindowMessages(db, windowId, 'context').slice(-contextMessages) : []
    const windowText = [...context, ...focal]
      .map((m, i) => `m${String(i).padStart(4, '0')} [${m.isFromMe ? 'me' : 'them'}]: ${m.text ?? ''}`)
      .join('\n')

    const tier = EFFORT[effort]
    const taskContext = [
      'Score an iMessage conversation window for temporal emotion analysis.',
      `Use these RoBERTa/Ekman emotion dimensions only: ${ANCHORS.join(', ')}.`,
      'Compare the current window against baselineJson when choosing stateLabel and confidence.',
    ].join('\n')

    const out = await scoreWindowWithAx.forward(service(tier.model, tier.maxTokens), {
      taskContext,
      baselineJson: JSON.stringify(baseline),
      windowRef: `W${target.ordinal}`,
      windowText,
    })

    const scores = Object.fromEntries(ANCHORS.map((a) => [a, clamp(out[a])])) as Scores
    const dom = dominant(scores)
    const confidence = clamp(out.confidence)
    const stateLabel = typeof out.stateLabel === 'string' ? out.stateLabel.slice(0, 80) : null
    const rationale = typeof out.rationale === 'string' ? out.rationale.slice(0, 280) : null

    // Persist so the recompute takes effect on the timeline.
    const resultJson = JSON.stringify({
      scores,
      dominant: dom,
      confidence,
      summary: rationale ?? stateLabel ?? `${dom} leading`,
      rationale,
      method: `ax-${tier.model}`,
    })
    db.prepare('UPDATE windows SET result_json = ?, status = ?, latency_ms = ? WHERE id = ?').run(
      resultJson,
      'completed',
      0,
      windowId,
    )

    return {
      windowId,
      ordinal: target.ordinal,
      effort,
      model: tier.model,
      scores,
      dominant: dom,
      confidence,
      stateLabel,
      rationale,
      persisted: true,
      citations: [{ type: 'window' as const, id: windowId, label: `W${target.ordinal}` }],
    }
  },
})
