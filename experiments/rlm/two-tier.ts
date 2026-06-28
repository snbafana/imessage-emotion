import { getDb } from '../../src/lib/db/connection'
import { createAxRun } from '../../src/lib/emotion/run-analysis'
import { getRunWindows } from '../../src/lib/api/runs'
import { scoreRunTwoTier } from '../../src/lib/emotion/two-tier-scorer'

// Two-tier stress: RoBERTa triages every window fast, then the RLM explorer
// deep-reads the top-K hottest with reasoning + neighbor exploration.
// Usage: pnpm tsx experiments/rlm/two-tier.ts [conversationId] [focal] [stride] [topK] [batchSize]
async function main() {
  const conversationId = Number(process.argv[2] ?? 1)
  const focal = Number(process.argv[3] ?? 4)
  const stride = Number(process.argv[4] ?? 1)
  const topK = Number(process.argv[5] ?? 25)
  const batchSize = Number(process.argv[6] ?? 10)

  const db = getDb()
  const { runId, windowCount } = createAxRun(db, conversationId, {
    mode: 'comparative-message-count',
    contextMessages: focal * 2,
    focalMessages: focal,
    stride,
    minFocalMessages: 1,
  })
  console.log(`[setup] conversation ${conversationId} -> run ${runId} with ${windowCount} windows (topK=${topK}, batch=${batchSize})`)

  let triaged = 0
  const result = await scoreRunTwoTier(db, runId, {
    topK,
    batchSize,
    subConcurrency: 50,
    onTriage: () => {
      triaged += 1
      if (triaged % 50 === 0 || triaged === windowCount) console.log(`[tier1] roberta triaged ${triaged}/${windowCount}`)
    },
    onExplore: (e) => {
      console.log(`[tier2] explored W${e.ordinal} -> ${e.dominant} ${e.confidence.toFixed(2)} :: ${(e.rationale ?? '').slice(0, 90)}`)
    },
  })

  console.log('\n[result]', JSON.stringify(result, null, 2))

  const ws = getRunWindows(db, runId)
  const counts = ws.reduce<Record<string, number>>((acc, w) => {
    const m = String((w.result as { method?: string })?.method ?? 'none')
    const key = m.startsWith('rlm-explore') ? 'rlm-explore' : m
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  console.log('[verify] methods across windows:', JSON.stringify(counts))
}

main().catch((error) => {
  console.error('TWO-TIER ERR:', error?.stack ?? error?.message ?? error)
  process.exit(1)
})
