import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { scoreAxRunWindow } from '../../src/lib/emotion/run-analysis'

export default defineTool({
  description:
    'Score one analysis window for the 7 Ekman emotions (anger, disgust, fear, joy, neutral, sadness, surprise) with the shared Ax LLM scorer. Requires real model credentials and persists the result.',
  inputSchema: z.object({
    runId: z.number(),
    windowId: z.number(),
  }),
  async execute({ runId, windowId }) {
    const result = await scoreAxRunWindow(getDb(), runId, windowId)
    return {
      windowId,
      runId,
      model: result.model,
      provider: result.provider,
      scores: result.scores,
      dominant: result.dominant,
      confidence: result.confidence,
      stateLabel: result.summary,
      evidenceMessageIds: result.evidenceMessageIds,
      persisted: true,
      citations: [{ type: 'window' as const, id: windowId, label: `window #${windowId}` }],
    }
  },
})
