import { getDb } from '../../src/lib/db/connection'
import { createAxRun } from '../../src/lib/emotion/run-analysis'
import { getRunWindows } from '../../src/lib/api/runs'
import { scoreRunWithRlm } from './rlm-scorer'

// Stress the RLM scorer: manufacture a many-window run, score it with one ax RLM
// agent fanning out llmQuery, and verify coverage.
// Usage: pnpm tsx experiments/rlm/stress.ts [conversationId] [focal] [stride] [batchSize]
async function main() {
  const conversationId = Number(process.argv[2] ?? 1)
  const focal = Number(process.argv[3] ?? 4)
  const stride = Number(process.argv[4] ?? 1)
  const batchSize = Number(process.argv[5] ?? 12)

  const db = getDb()
  const { runId, windowCount } = createAxRun(db, conversationId, {
    mode: 'comparative-message-count',
    contextMessages: focal * 2,
    focalMessages: focal,
    stride,
    minFocalMessages: 1,
  })
  console.log(`[setup] conversation ${conversationId} -> run ${runId} with ${windowCount} windows (focal=${focal}, stride=${stride}, batch=${batchSize})`)

  let progress = 0
  const t0 = performance.now()
  const result = await scoreRunWithRlm(db, runId, {
    batchSize,
    subConcurrency: 12,
    onProgress: (e) => {
      progress += 1
      if (progress % 10 === 0 || progress === windowCount) {
        const secs = ((performance.now() - t0) / 1000).toFixed(1)
        console.log(`[progress] ${progress}/${windowCount} scored (${secs}s) — W${e.ordinal} ${e.dominant} ${e.confidence.toFixed(2)}`)
      }
    },
  })

  const ws = getRunWindows(db, runId)
  const rlmScored = ws.filter((w) => String((w.result as { method?: string })?.method ?? '').startsWith('rlm')).length
  console.log('\n[result]', JSON.stringify(result, null, 2))
  console.log(`[verify] ${rlmScored}/${ws.length} windows have rlm scores in the DB`)
  console.log(`[rate] ${(result.scored / (result.wallMs / 1000)).toFixed(2)} windows/sec over ${(result.wallMs / 1000).toFixed(1)}s`)
}

main().catch((error) => {
  console.error('STRESS ERR:', error?.stack ?? error?.message ?? error)
  process.exit(1)
})
