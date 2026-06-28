import { ax } from '@ax-llm/ax'
import type { AppDatabase } from '../db/schema'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from './anchors'
import { clamp, dominantOf, scorerService } from './ax-shared'
import { triageRunWithRoberta, type TriageProgress, type TriagedWindow, type TriageResult } from './roberta-triage'

// Two-tier scoring:
//   Tier 1 (RoBERTa): score every window fast, rank by rolling-baseline shift.
//   Tier 2 (deep-read): the top-K highest-shift windows are re-scored in parallel
//   by a stronger model (gpt-5-mini) that sees the window plus its neighbors
//   across time, and saves a rationale. A deterministic host fan-out — reliable
//   and fast — rather than an RLM actor loop (see rlm-scorer.ts for that variant).

export type TwoTierProgress = {
  onTriage?: TriageProgress
  onExplore?: (e: {
    windowId: number
    ordinal: number
    dominant: Anchor
    confidence: number
    scores: AnchorScores
    rationale: string | null
  }) => void
}

export type TwoTierOptions = TwoTierProgress & {
  topK?: number
  subConcurrency?: number
  subModel?: string
  neighborSpan?: number
}

export type TwoTierResult = {
  runId: number
  triage: { method: string; loadMs: number; inferMs: number; total: number }
  hot: Array<{ ordinal: number; dominant: Anchor; shift: number }>
  explore: { explored: number; subQueries: number; wallMs: number; summary: string }
}

// Structured deep-read scorer: window + neighbors -> Ekman scores + reasoning.
const deepScore = ax(`
  taskContext:string "what to do",
  windowText:string "the focal window",
  neighborsText:string "surrounding windows across time",
  robertaJson:string "the fast RoBERTa scores to confirm or correct"
  ->
  anger:number "0..1", disgust:number "0..1", fear:number "0..1", joy:number "0..1",
  neutral:number "0..1", sadness:number "0..1", surprise:number "0..1",
  confidence:number "0..1",
  rationale:string "1-2 sentences: what shifted vs the surrounding windows and why; correct RoBERTa if it misread tone"
`)

const synthesize = ax(`
  shiftsJson:string "the sharpest scored windows with their dominant emotion, shift and rationale"
  ->
  summary:string "one-paragraph synthesis of the sharpest emotional shifts and what drove them"
`)

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (i < items.length) {
        const cur = i++
        out[cur] = await fn(items[cur], cur)
      }
    }),
  )
  return out
}

export async function scoreRunTwoTier(
  db: AppDatabase,
  runId: number,
  opts: TwoTierOptions = {},
): Promise<TwoTierResult> {
  const topK = opts.topK ?? 25
  const subModel = opts.subModel ?? 'gpt-5-mini'
  const span = opts.neighborSpan ?? 2

  // Tier 1 — fast triage over every window.
  const triage: TriageResult = await triageRunWithRoberta(db, runId, { onProgress: opts.onTriage })
  const byOrdinal = new Map<number, TriagedWindow>(triage.windows.map((w) => [w.ordinal, w]))
  const hot = [...triage.windows].sort((a, b) => b.shift - a.shift).slice(0, topK)

  // Tier 2 — parallel deep-read of the hottest windows, each with neighbor context.
  const service = scorerService(subModel, { maxTokens: 3000 })
  const taskContext = `Score this iMessage window on the 7 Ekman emotions (${EKMAN_ANCHORS.join(', ')}). Use the neighbors to read the shift in context; correct the RoBERTa scores when they misread tone.`

  const started = performance.now()
  const scored = await mapLimit(hot, opts.subConcurrency ?? 50, async (w) => {
    const neighbors: string[] = []
    for (let o = w.ordinal - span; o <= w.ordinal + span; o += 1) {
      if (o === w.ordinal) continue
      const n = byOrdinal.get(o)
      if (n) neighbors.push(`W${n.ordinal} (${n.dominant}): ${n.focalText.slice(0, 240)}`)
    }
    const out = (await deepScore.forward(service as never, {
      taskContext,
      windowText: w.focalText,
      neighborsText: neighbors.join('\n') || '(none)',
      robertaJson: JSON.stringify(w.scores),
    })) as Record<string, unknown>

    const scores = Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, clamp(out[a])])) as AnchorScores
    const dominant = dominantOf(scores)
    const confidence = clamp(out.confidence)
    const rationale = typeof out.rationale === 'string' ? out.rationale.slice(0, 400) : null

    db.prepare('UPDATE windows SET result_json = ?, status = ?, latency_ms = ? WHERE id = ?').run(
      JSON.stringify({ scores, dominant, confidence, summary: rationale ?? `${dominant} leading`, rationale, method: `two-tier-${subModel}` }),
      'completed',
      0,
      w.windowId,
    )
    opts.onExplore?.({ windowId: w.windowId, ordinal: w.ordinal, dominant, confidence, scores, rationale })
    return { ordinal: w.ordinal, dominant, shift: w.shift, rationale }
  })
  const wallMs = Math.round(performance.now() - started)

  // One synthesis pass over what we deep-read.
  let summary = ''
  try {
    const top = [...scored].sort((a, b) => b.shift - a.shift).slice(0, 12)
    const out = (await synthesize.forward(service as never, { shiftsJson: JSON.stringify(top) })) as { summary?: string }
    summary = typeof out?.summary === 'string' ? out.summary : ''
  } catch {
    summary = ''
  }

  return {
    runId,
    triage: { method: triage.method, loadMs: triage.loadMs, inferMs: triage.inferMs, total: triage.windows.length },
    hot: hot.map((w) => ({ ordinal: w.ordinal, dominant: w.dominant, shift: w.shift })),
    explore: { explored: scored.length, subQueries: scored.length + 1, wallMs, summary },
  }
}
