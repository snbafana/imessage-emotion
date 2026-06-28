import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'

export default defineTool({
  description:
    'Find earlier windows in the run that share a given window\'s dominant emotion — i.e. whether this tension/warmth has recurred before. Use to spot recurring patterns.',
  inputSchema: z.object({
    runId: z.number(),
    windowId: z.number(),
  }),
  async execute({ runId, windowId }) {
    const windows = getRunWindows(getDb(), runId)
    const index = windows.findIndex((w) => w.id === windowId)
    if (index === -1) return { error: `window ${windowId} not in run ${runId}` }

    const dominantOf = (w: (typeof windows)[number]) =>
      ((w.result ?? {}) as { dominant?: string }).dominant ?? null
    const target = dominantOf(windows[index])

    const priorMatches = windows
      .slice(0, index)
      .filter((w) => dominantOf(w) === target)

    return {
      windowId,
      dominant: target,
      recurrenceCount: priorMatches.length,
      priorOccurrences: priorMatches.map((w) => ({ id: w.id, ordinal: w.ordinal })),
      citations: priorMatches.map((w) => ({
        type: 'window' as const,
        id: w.id,
        label: `W${w.ordinal}`,
      })),
    }
  },
})
