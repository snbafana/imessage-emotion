import { agent, AxJSRuntime, f, fn } from '@ax-llm/ax'
import type { AppDatabase } from '../db/schema'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from './anchors'
import { clamp, dominantOf, gatewayService, lenientParse } from './ax-shared'
import { triageRunWithRoberta, type TriagedWindow, type TriageResult } from './roberta-triage'

// Two-tier scoring:
//   Tier 1 (RoBERTa): score every window fast, rank by rolling-baseline shift.
//   Tier 2 (RLM): one ax agent deep-reads the hottest windows with reasoning,
//   pulling neighboring windows across time as it needs context, and overwrites
//   their fast scores with model scores + a saved rationale.

export type TwoTierProgress = {
  onTriage?: (e: { ordinal: number; dominant: Anchor; shift: number }) => void
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
  batchSize?: number
  subConcurrency?: number
  actorModel?: string
  subModel?: string
  maxTurns?: number
}

export type TwoTierResult = {
  runId: number
  triage: { method: string; loadMs: number; inferMs: number; total: number }
  hot: Array<{ ordinal: number; dominant: Anchor; shift: number }>
  explore: { explored: number; subQueries: number; wallMs: number; summary: string }
}

export async function scoreRunTwoTier(
  db: AppDatabase,
  runId: number,
  opts: TwoTierOptions = {},
): Promise<TwoTierResult> {
  const topK = opts.topK ?? 25
  const batchSize = opts.batchSize ?? 10
  const subModel = opts.subModel ?? 'openai/gpt-4o-mini'
  const actorModel = opts.actorModel ?? 'anthropic/claude-sonnet-4.6'

  // Tier 1 — fast triage over every window.
  const triage: TriageResult = await triageRunWithRoberta(db, runId, { onProgress: opts.onTriage })
  const byOrdinal = new Map<number, TriagedWindow>(triage.windows.map((w) => [w.ordinal, w]))
  const hot = [...triage.windows].sort((a, b) => b.shift - a.shift).slice(0, topK)

  // Tier 2 — RLM exploration over the hottest windows.
  let cursor = 0
  let explored = 0

  const nextHot = fn('nextHot')
    .description(
      'Hand out the next batch of high-shift windows to deep-read. Each item: { windowId, ordinal, focalText, robertaScores, robertaDominant, shift }. Returns { done, remaining, windows }.',
    )
    .namespace('explore')
    .arg('size', f.number('how many hot windows to take this turn (1-20)'))
    .returns(f.json('next batch of hot windows'))
    .handler(async ({ size }) => {
      const n = Math.max(1, Math.min(20, Number(size) || batchSize))
      if (cursor >= hot.length) return { done: true, remaining: 0, windows: [] }
      const batch = hot.slice(cursor, cursor + n).map((w) => ({
        windowId: w.windowId,
        ordinal: w.ordinal,
        focalText: w.focalText,
        robertaScores: w.scores,
        robertaDominant: w.dominant,
        shift: w.shift,
      }))
      cursor += batch.length
      return { done: false, remaining: hot.length - cursor, windows: batch }
    })
    .build()

  const getNeighbors = fn('getNeighbors')
    .description(
      'Read the windows surrounding an ordinal so you can interpret a shift in context across time. Returns windows with ordinal in [ordinal-span, ordinal+span] (excluding the center): { windowId, ordinal, focalText, robertaDominant }. You may also score any of these by including them in persistScored.',
    )
    .namespace('explore')
    .arg('ordinal', f.number('center window ordinal'))
    .arg('span', f.number('how many windows before and after to include (1-5)'))
    .returns(f.json('neighboring windows'))
    .handler(async ({ ordinal, span }) => {
      const reach = Math.max(1, Math.min(5, Number(span) || 2))
      const center = Number(ordinal)
      const out = []
      for (let o = center - reach; o <= center + reach; o += 1) {
        if (o === center) continue
        const w = byOrdinal.get(o)
        if (w) out.push({ windowId: w.windowId, ordinal: w.ordinal, focalText: w.focalText, robertaDominant: w.dominant })
      }
      return { center, windows: out }
    })
    .build()

  const persistScored = fn('persistScored')
    .description(
      'Persist deep-read scores. results: array of { windowId, raw } where raw is the JSON string from the analysis sub-query (anger, disgust, fear, joy, neutral, sadness, surprise, confidence, rationale). The rationale is required — it is the reasoning saved for that window.',
    )
    .namespace('explore')
    .arg('results', f.json('array of { windowId, raw }'))
    .returns(f.string('how many were persisted'))
    .handler(async ({ results }) => {
      const rows = Array.isArray(results) ? results : []
      let persisted = 0
      for (const row of rows as Array<{ windowId?: number; raw?: unknown }>) {
        if (typeof row?.windowId !== 'number') continue
        const parsed = lenientParse(row.raw)
        if (!parsed) continue
        const scores = Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, clamp(parsed[a])])) as AnchorScores
        const dominant = dominantOf(scores)
        const confidence = clamp(parsed.confidence)
        const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 400) : null
        const resultJson = JSON.stringify({
          scores,
          dominant,
          confidence,
          summary: rationale ?? `${dominant} leading`,
          rationale,
          method: `rlm-explore-${subModel}`,
        })
        db.prepare('UPDATE windows SET result_json = ?, status = ?, latency_ms = ? WHERE id = ?').run(
          resultJson,
          'completed',
          0,
          row.windowId,
        )
        explored += 1
        persisted += 1
        const tw = triage.windows.find((w) => w.windowId === row.windowId)
        opts.onExplore?.({
          windowId: row.windowId,
          ordinal: tw?.ordinal ?? 0,
          dominant,
          confidence,
          scores,
          rationale,
        })
      }
      return `persisted ${persisted} (explored ${explored})`
    })
    .build()

  const explorer = agent('task:string -> summary:string "one-paragraph synthesis of the sharpest emotional shifts and what drove them"', {
    contextFields: [],
    runtime: new AxJSRuntime(),
    functions: [nextHot, getNeighbors, persistScored],
    contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
    maxSubAgentCalls: 2000,
    maxBatchedLlmQueryConcurrency: opts.subConcurrency ?? 50,
    maxTurns: opts.maxTurns ?? 80,
    recursionOptions: { ai: gatewayService(subModel) as never },
    executorOptions: {
      description: [
        `RoBERTa already scored every window; you deep-read only the ${hot.length} highest-shift windows and replace their fast scores with reasoned ones.`,
        `Loop, one observable step per turn:`,
        `1) const batch = await explore.nextHot({ size: ${batchSize} })`,
        `2) For any window whose shift is hard to read from its focal text alone, call explore.getNeighbors({ ordinal, span: 2 }) to see what came before/after across time.`,
        `3) Score the batch with ONE batched llmQuery([...]) — one query per window, context { focalText, robertaScores, neighbors }, asking for STRICT JSON only: {"anger":0..1,"disgust":0..1,"fear":0..1,"joy":0..1,"neutral":0..1,"sadness":0..1,"surprise":0..1,"confidence":0..1,"rationale":"1-2 sentences: what shifted vs the surrounding windows and why; correct RoBERTa if it misread tone"}.`,
        `4) await explore.persistScored({ results: batch.map(w => ({ windowId: w.windowId, raw: <its llmQuery string> })) }). If a neighbor turns out to be pivotal, score and persist it too.`,
        `Repeat until explore.nextHot returns { done: true }. Then final(...) with a synthesis of the sharpest shifts.`,
      ].join('\n'),
    },
  })

  const started = performance.now()
  const out = (await explorer.forward(gatewayService(actorModel) as never, {
    task: `Deep-read the ${hot.length} highest-shift windows of run ${runId}, ${batchSize} at a time, pulling neighbors for context as needed, until every hot window has a reasoned score.`,
  })) as { summary?: string }
  const wallMs = Math.round(performance.now() - started)

  return {
    runId,
    triage: { method: triage.method, loadMs: triage.loadMs, inferMs: triage.inferMs, total: triage.windows.length },
    hot: hot.map((w) => ({ ordinal: w.ordinal, dominant: w.dominant, shift: w.shift })),
    explore: {
      explored,
      subQueries: explored,
      wallMs,
      summary: typeof out?.summary === 'string' ? out.summary : '',
    },
  }
}
