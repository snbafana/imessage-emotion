import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'

type Scores = Record<string, number>

export default defineTool({
  description:
    'List every window in a run with its dominant emotion, scores, and shift status. Use this for whole-timeline questions (the overall arc, sharpest shifts).',
  inputSchema: z.object({
    runId: z.number().describe('analysis run id'),
  }),
  async execute({ runId }) {
    const windows = getRunWindows(getDb(), runId)
    return {
      runId,
      windowCount: windows.length,
      windows: windows.map((w) => {
        const result = (w.result ?? {}) as { scores?: Scores; dominant?: string }
        const shift = (w.shift ?? {}) as { status?: string; trend?: string }
        return {
          id: w.id,
          ordinal: w.ordinal,
          focal: `${w.focalStartOrdinal}-${w.focalEndOrdinal}`,
          dominant: result.dominant ?? null,
          scores: result.scores ?? null,
          shift: shift.status ?? null,
          trend: shift.trend ?? null,
        }
      }),
      citations: windows.map((w) => ({
        type: 'window' as const,
        id: w.id,
        label: `W${w.ordinal}`,
      })),
    }
  },
})
