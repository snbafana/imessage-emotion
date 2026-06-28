import { ax } from '@ax-llm/ax'
import { getDb } from '../../src/lib/db/connection'
import { createAxRun } from '../../src/lib/emotion/run-analysis'
import { getRunWindows } from '../../src/lib/api/runs'
import { getWindowMessages } from '../../src/lib/api/messages'
import { EKMAN_ANCHORS, type AnchorScores } from '../../src/lib/emotion/anchors'
import { clamp, dominantOf, gatewayService } from '../../src/lib/emotion/ax-shared'
import { triageRunWithRoberta } from '../../src/lib/emotion/roberta-triage'
import { scoreRunWithRlm } from '../../src/lib/emotion/rlm-scorer'
import { scoreRunTwoTier } from '../../src/lib/emotion/two-tier-scorer'

// Head-to-head speed test of every scoring path on identically-sized runs.
// Usage: pnpm tsx experiments/rlm/bench.ts [conversationId] [focal] [stride] [topK]

const SUB_MODEL = 'openai/gpt-4o-mini'
const CONCURRENCY = 50

type Row = { method: string; scored: number; total: number; wallMs: number; rate: string; notes: string }

function freshRun(db: ReturnType<typeof getDb>, conversationId: number, focal: number, stride: number) {
  return createAxRun(db, conversationId, {
    mode: 'comparative-message-count',
    contextMessages: focal * 2,
    focalMessages: focal,
    stride,
    minFocalMessages: 1,
  })
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const cur = i++
        await fn(items[cur])
      }
    }),
  )
}

// Deterministic host-side parallel fan-out: the host loops the ax scorer over
// every window with a fixed concurrency. No actor, no runtime — the baseline.
const scoreSig = ax(`
  taskContext:string, baselineJson:string, windowText:string
  -> anger:number, disgust:number, fear:number, joy:number, neutral:number, sadness:number, surprise:number, confidence:number
`)

async function hostFanout(db: ReturnType<typeof getDb>, runId: number) {
  const service = gatewayService(SUB_MODEL)
  const windows = getRunWindows(db, runId)
  const items = windows.map((w, i) => {
    const focal = getWindowMessages(db, w.id, 'focal')
    const windowText = focal.map((m) => `${m.isFromMe ? 'me' : 'them'}: ${m.text ?? ''}`).join('\n').slice(0, 1200)
    const priors = windows.slice(Math.max(0, i - 3), i)
    const baseline = Object.fromEntries(
      EKMAN_ANCHORS.map((a) => {
        const vals = priors.map((p) => ((p.result ?? {}) as { scores?: Partial<AnchorScores> }).scores?.[a] ?? 0)
        return [a, vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0]
      }),
    )
    return { id: w.id, windowText, baselineJson: JSON.stringify(baseline) }
  })
  let scored = 0
  await mapLimit(items, CONCURRENCY, async (item) => {
    const out = (await scoreSig.forward(service as never, {
      taskContext: `Score this iMessage window on the 7 Ekman emotions (${EKMAN_ANCHORS.join(', ')}).`,
      baselineJson: item.baselineJson,
      windowText: item.windowText,
    })) as Record<string, unknown>
    const scores = Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, clamp(out[a])])) as AnchorScores
    const dominant = dominantOf(scores)
    db.prepare('UPDATE windows SET result_json = ?, status = ? WHERE id = ?').run(
      JSON.stringify({ scores, dominant, confidence: clamp(out.confidence), method: 'host-fanout' }),
      'completed',
      item.id,
    )
    scored += 1
  })
  return scored
}

async function main() {
  const conversationId = Number(process.argv[2] ?? 1)
  const focal = Number(process.argv[3] ?? 4)
  const stride = Number(process.argv[4] ?? 2)
  const topK = Number(process.argv[5] ?? 25)
  const db = getDb()
  const rows: Row[] = []

  const probe = freshRun(db, conversationId, focal, stride)
  const total = probe.windowCount
  console.log(`[bench] conversation ${conversationId}: ${total} windows per run (focal=${focal}, stride=${stride}), concurrency=${CONCURRENCY}\n`)

  // 1. RoBERTa triage (scores only, no reasoning)
  {
    const t = await triageRunWithRoberta(db, probe.runId)
    rows.push({
      method: 'RoBERTa triage',
      scored: t.windows.length,
      total,
      wallMs: t.loadMs + t.inferMs,
      rate: `${(t.windows.length / ((t.loadMs + t.inferMs) / 1000)).toFixed(1)}/s`,
      notes: `${t.loadMs}ms load + ${t.inferMs}ms infer, no reasoning`,
    })
  }

  // 2. Host fan-out (deterministic parallel ax, LLM scores all, no reasoning)
  {
    const run = freshRun(db, conversationId, focal, stride)
    const t0 = performance.now()
    const scored = await hostFanout(db, run.runId)
    const wallMs = Math.round(performance.now() - t0)
    rows.push({ method: `Host fan-out (c=${CONCURRENCY})`, scored, total, wallMs, rate: `${(scored / (wallMs / 1000)).toFixed(1)}/s`, notes: 'parallel ax, no actor, no reasoning' })
  }

  // 3. Single-tier RLM (actor fans out llmQuery over all, reasoning each)
  {
    const run = freshRun(db, conversationId, focal, stride)
    const r = await scoreRunWithRlm(db, run.runId, { subConcurrency: CONCURRENCY, batchSize: 20 })
    rows.push({ method: 'RLM single-tier', scored: r.scored, total, wallMs: r.wallMs, rate: `${(r.scored / (r.wallMs / 1000)).toFixed(1)}/s`, notes: `${r.batches} batches, reasoning each` })
  }

  // 4. Two-tier (RoBERTa all + RLM explore top-K with reasoning)
  {
    const run = freshRun(db, conversationId, focal, stride)
    const t0 = performance.now()
    const r = await scoreRunTwoTier(db, run.runId, { topK, batchSize: 10, subConcurrency: CONCURRENCY })
    const wallMs = Math.round(performance.now() - t0)
    rows.push({
      method: `Two-tier (top-${topK})`,
      scored: total,
      total,
      wallMs,
      rate: `${(total / (wallMs / 1000)).toFixed(1)}/s`,
      notes: `${r.triage.loadMs}ms load; ${total - r.explore.explored} fast + ${r.explore.explored} reasoned`,
    })
  }

  console.log('\n=== RESULTS ===')
  console.log(['method', 'scored', 'wallMs', 'rate', 'notes'].join('\t'))
  for (const r of rows) {
    console.log([r.method, `${r.scored}/${r.total}`, `${r.wallMs}ms`, r.rate, r.notes].join('\t'))
  }
}

main().catch((error) => {
  console.error('BENCH ERR:', error?.stack ?? error?.message ?? error)
  process.exit(1)
})
