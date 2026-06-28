import { agent, AxJSRuntime, f, fn } from '@ax-llm/ax'
import type { AppDatabase } from '../../src/lib/db/schema'
import { getRunWindows } from '../../src/lib/api/runs'
import { getWindowMessages } from '../../src/lib/api/messages'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from '../../src/lib/emotion/anchors'
import { clamp, dominantOf, lenientParse, scorerService } from '../../src/lib/emotion/ax-shared'

// RLM scorer: instead of the host orchestrating one tool call per window (which
// caps out when the model has to emit hundreds of calls in a turn), a single ax
// RLM agent pages through the run's windows via a host tool and fans out
// `llmQuery` sub-LLM calls to score each batch. The actor's prompt and memory
// stay bounded (checkpointed context + one batch in flight), so it scales to
// hundreds of windows where the host-orchestrated loop cannot.

export type RlmProgress = (event: {
  windowId: number
  ordinal: number
  dominant: Anchor
  confidence: number
  scores: AnchorScores
  rationale: string | null
}) => void

export type RlmResult = {
  runId: number
  total: number
  scored: number
  batches: number
  subQueries: number
  wallMs: number
  summary: string
}

export type RlmOptions = {
  actorModel?: string
  subModel?: string
  batchSize?: number
  subConcurrency?: number
  maxSubAgentCalls?: number
  maxTurns?: number
  onProgress?: RlmProgress
}

export async function scoreRunWithRlm(
  db: AppDatabase,
  runId: number,
  opts: RlmOptions = {},
): Promise<RlmResult> {
  const actorModel = opts.actorModel ?? 'gpt-4.1'
  const subModel = opts.subModel ?? 'gpt-5-mini'
  const batchSize = opts.batchSize ?? 10

  // Worklist: focal text + a rolling baseline from the prior windows' scores.
  const windows = getRunWindows(db, runId)
  const worklist = windows.map((w, index) => {
    const focal = getWindowMessages(db, w.id, 'focal')
    const focalText = focal
      .map((m, j) => `m${String(j).padStart(3, '0')} [${m.isFromMe ? 'me' : 'them'}]: ${m.text ?? ''}`)
      .join('\n')
      .slice(0, 1200)
    const priors = windows.slice(Math.max(0, index - 3), index)
    const baseline = Object.fromEntries(
      EKMAN_ANCHORS.map((a) => {
        const vals = priors.map((p) => ((p.result ?? {}) as { scores?: Partial<AnchorScores> }).scores?.[a] ?? 0)
        return [a, vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0]
      }),
    ) as AnchorScores
    return { windowId: w.id, ordinal: w.ordinal, focalText, baselineJson: JSON.stringify(baseline) }
  })

  const total = worklist.length
  let cursor = 0
  let scoredCount = 0
  let batches = 0

  const nextBatch = fn('nextBatch')
    .description(
      'Hand out the next batch of windows to score. Returns { done, remaining, windows }, where each window is { windowId, ordinal, focalText, baselineJson }. When done is true, every window has been handed out.',
    )
    .namespace('run')
    .arg('size', f.number('how many windows to fetch this turn (1-20)'))
    .returns(f.json('next batch'))
    .handler(async ({ size }) => {
      const n = Math.max(1, Math.min(20, Number(size) || batchSize))
      if (cursor >= total) return { done: true, remaining: 0, windows: [] }
      const batch = worklist.slice(cursor, cursor + n)
      cursor += batch.length
      batches += 1
      return { done: false, remaining: total - cursor, windows: batch }
    })
    .build()

  const persistScores = fn('persistScores')
    .description(
      'Persist Ekman scores for scored windows. Pass results: an array of { windowId, raw } where raw is the JSON string from the scoring sub-query (anger, disgust, fear, joy, neutral, sadness, surprise, confidence, rationale).',
    )
    .namespace('run')
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
        const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 280) : null
        const resultJson = JSON.stringify({
          scores,
          dominant,
          confidence,
          summary: rationale ?? `${dominant} leading`,
          rationale,
          method: `rlm-${subModel}`,
        })
        db.prepare('UPDATE windows SET result_json = ?, status = ?, latency_ms = ? WHERE id = ?').run(
          resultJson,
          'completed',
          0,
          row.windowId,
        )
        scoredCount += 1
        persisted += 1
        const wl = worklist.find((w) => w.windowId === row.windowId)
        opts.onProgress?.({
          windowId: row.windowId,
          ordinal: wl?.ordinal ?? 0,
          dominant,
          confidence,
          scores,
          rationale,
        })
      }
      return `persisted ${persisted} (total ${scoredCount}/${total})`
    })
    .build()

  const scorer = agent('task:string -> summary:string "one-paragraph emotional arc across all windows"', {
    contextFields: [],
    runtime: new AxJSRuntime(),
    functions: [nextBatch, persistScores],
    contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
    maxSubAgentCalls: opts.maxSubAgentCalls ?? 2000,
    maxBatchedLlmQueryConcurrency: opts.subConcurrency ?? 50,
    // Top-level cap on actor turns before the responder is forced (default 8/10).
    // A many-window run needs one turn per batch, so give it generous headroom.
    maxTurns: opts.maxTurns ?? 80,
    recursionOptions: { ai: scorerService(subModel) as never },
    executorOptions: {
      description: [
        `Score EVERY window of this run on the 7 Ekman emotions (${EKMAN_ANCHORS.join(', ')}).`,
        `Loop, one observable step per turn:`,
        `1) const batch = await run.nextBatch({ size: ${batchSize} }); console.log(batch.remaining, batch.windows.length)`,
        `2) Score the batch with ONE batched llmQuery([...]) call — one query per window, passing context { focalText, baselineJson } and asking for STRICT JSON only: {"anger":0..1,"disgust":0..1,"fear":0..1,"joy":0..1,"neutral":0..1,"sadness":0..1,"surprise":0..1,"confidence":0..1,"rationale":"one sentence on what shifted vs baseline"}.`,
        `3) await run.persistScores({ results: batch.windows.map((w, i) => ({ windowId: w.windowId, raw: <the llmQuery string for w> })) })`,
        `Repeat until run.nextBatch returns { done: true }. Do NOT stop or summarize until done is true. Then call final(...) with a short arc summary.`,
      ].join('\n'),
    },
  })

  const started = performance.now()
  const out = (await scorer.forward(scorerService(actorModel) as never, {
    task: `Score all ${total} windows of run ${runId}, ${batchSize} at a time, until every window is persisted.`,
  })) as { summary?: string }
  const wallMs = Math.round(performance.now() - started)

  return {
    runId,
    total,
    scored: scoredCount,
    batches,
    subQueries: scoredCount,
    wallMs,
    summary: typeof out?.summary === 'string' ? out.summary : '',
  }
}
