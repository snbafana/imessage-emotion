import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'

import { EKMAN_ANCHORS as EMOTIONS } from '../../src/lib/emotion/anchors'

type Scores = Record<string, number>

export default defineTool({
  description:
    'Compare a window to the baseline of the windows immediately before it, returning the per-emotion deltas. Use to quantify what moved at a shift.',
  inputSchema: z.object({
    runId: z.number(),
    windowId: z.number(),
    baselineWindows: z.number().default(3).describe('how many prior windows to average'),
  }),
  async execute({ runId, windowId, baselineWindows }) {
    const windows = getRunWindows(getDb(), runId)
    const index = windows.findIndex((w) => w.id === windowId)
    if (index === -1) return { error: `window ${windowId} not in run ${runId}` }

    const target = windows[index]
    const priors = windows.slice(Math.max(0, index - baselineWindows), index)
    const scoresOf = (w: (typeof windows)[number]) =>
      ((w.result ?? {}) as { scores?: Scores }).scores ?? {}
    const targetScores = scoresOf(target)

    const baseline: Scores = {}
    for (const e of EMOTIONS) {
      const vals = priors.map((w) => scoresOf(w)[e] ?? 0)
      baseline[e] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    }

    const deltas = EMOTIONS.map((e) => ({
      emotion: e,
      current: Number((targetScores[e] ?? 0).toFixed(3)),
      baseline: Number(baseline[e].toFixed(3)),
      delta: Number(((targetScores[e] ?? 0) - baseline[e]).toFixed(3)),
    })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

    return {
      windowId,
      ordinal: target.ordinal,
      baselineWindowIds: priors.map((w) => w.id),
      deltas,
      strongest: deltas[0],
      citations: [{ type: 'window' as const, id: windowId, label: `W${target.ordinal}` }],
    }
  },
})
