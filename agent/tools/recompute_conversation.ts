import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'
import { createBaselineRun } from '../../src/lib/emotion/run-baseline'

export default defineTool({
  description:
    'Start a full recomputation of a conversation: builds a fresh analysis run and its windows from the conversation messages (works for a brand-new conversation or to rescore an existing one), then returns the ordered window plan. Follow up by calling score_window for each window in order — that streams the window-by-window rescore to the user — then summarize the arc.',
  inputSchema: z.object({
    conversationId: z.number(),
    windowSize: z.number().default(16).describe('focal messages per window'),
    stride: z.number().default(8).describe('messages advanced between windows'),
  }),
  async execute({ conversationId, windowSize, stride }) {
    const db = getDb()
    // Creates analysis_runs + windows from the conversation's messages. Keep the
    // window config internally consistent (minFocalMessages <= focalMessages).
    const { runId, windowCount } = createBaselineRun(db, conversationId, {
      mode: 'comparative-message-count',
      contextMessages: windowSize * 2,
      focalMessages: windowSize,
      stride,
      minFocalMessages: Math.max(1, Math.min(windowSize, 8)),
    })
    const windows = getRunWindows(db, runId)
    return {
      conversationId,
      runId,
      windowCount,
      windowSize,
      stride,
      // The agent should call score_window for each of these, in order.
      windows: windows.map((w) => ({ id: w.id, ordinal: w.ordinal, focal: `${w.focalStartOrdinal}-${w.focalEndOrdinal}` })),
      next: 'Call score_window(runId, windowId) for each window in order, then summarize.',
      citations: windows.map((w) => ({ type: 'window' as const, id: w.id, label: `W${w.ordinal}` })),
    }
  },
})
