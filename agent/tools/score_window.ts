import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'
import { scoreAxRunWindow } from '../../src/lib/emotion/run-analysis'

export default defineTool({
  description:
    'Score one analysis window with the Ax LLM scorer, persist the result, and return scores plus the shift from the previous scored window. Use during explicit recompute/rescore flows.',
  inputSchema: z.object({
    runId: z.number().int().positive().describe('Analysis run id'),
    windowId: z.number().int().positive().describe('Window id belonging to the run'),
  }),
  async execute({ runId, windowId }) {
    const db = getDb()
    const result = await scoreAxRunWindow(db, runId, windowId)
    const window = getRunWindows(db, runId).find((candidate) => candidate.id === windowId)
    return {
      windowId,
      runId,
      ordinal: window?.ordinal ?? null,
      range: window
        ? {
            all: `${window.startOrdinal}-${window.endOrdinal}`,
            focal: `${window.focalStartOrdinal}-${window.focalEndOrdinal}`,
          }
        : null,
      model: result.model,
      provider: result.provider,
      scores: result.scores,
      dominant: result.dominant,
      confidence: result.confidence,
      stateLabel: result.summary,
      evidenceMessageIds: result.evidenceMessageIds,
      shift: window?.shift ?? null,
      persisted: true,
      citations: [{ type: 'window' as const, id: windowId, label: window ? `W${window.ordinal}` : `window #${windowId}` }],
    }
  },
})
