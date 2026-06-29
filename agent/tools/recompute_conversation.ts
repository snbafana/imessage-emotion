import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getRunWindows } from '../../src/lib/api/runs'
import { createAxRun } from '../../src/lib/emotion/run-analysis'
import { planCappedRunWindowConfig } from '../../src/lib/windows/windows'

export default defineTool({
  description:
    'Create a fresh capped Ax analysis run for a conversation and return its ordered window plan. This only creates windows; call score_window on each returned window to persist scores.',
  inputSchema: z.object({
    conversationId: z.number().int().positive().describe('Conversation id to analyze'),
    messageCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Conversation message count when the client already has it'),
    maxWindows: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(200)
      .describe('Maximum windows to create for this run'),
    overlapPercent: z
      .number()
      .int()
      .min(10)
      .max(40)
      .default(25)
      .describe('Window overlap percentage; larger values preserve more context'),
    model: z.string().min(1).default('google/gemini-2.5-flash').describe('Scoring model id'),
    effort: z.enum(['low', 'medium', 'high']).default('medium').describe('Scoring effort level'),
  }),
  async execute({ conversationId, messageCount, maxWindows, overlapPercent, model, effort }) {
    const db = getDb()
    const lastOrdinal =
      messageCount ??
      ((db
        .prepare('SELECT MAX(conversation_ordinal) AS last_ordinal FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { last_ordinal: number | null }).last_ordinal ??
        0)
    const plan = planCappedRunWindowConfig(lastOrdinal, { maxWindows, overlapPercent })
    const { runId, windowCount } = createAxRun(db, conversationId, {
      ...plan.config,
      scorerConfig: {
        promptKey: 'eve-capped-overlap-ax-v1',
        label: `Ax capped ${overlapPercent}% overlap`,
        provider: 'openrouter',
        effort,
        model,
        maxWindows,
        overlapPercent,
        estimatedWindowCount: plan.windowCount,
      },
    })
    const windows = getRunWindows(db, runId)
    return {
      conversationId,
      runId,
      windowCount,
      windowConfig: plan.config,
      maxWindows,
      overlapPercent,
      model,
      windows: windows.map((w) => ({
        id: w.id,
        ordinal: w.ordinal,
        range: {
          all: `${w.startOrdinal}-${w.endOrdinal}`,
          focal: `${w.focalStartOrdinal}-${w.focalEndOrdinal}`,
        },
      })),
      next: 'Call score_window(runId, windowId) for each window in order, then summarize.',
      citations: windows.map((w) => ({ type: 'window' as const, id: w.id, label: `W${w.ordinal}` })),
    }
  },
})
