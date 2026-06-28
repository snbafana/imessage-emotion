import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getWindowMessages } from '../../src/lib/api/messages'

export default defineTool({
  description:
    "Read the messages inside an analysis window. slice 'focal' = the new messages being scored, 'context' = the older baseline messages, 'all' = both. Use this to ground claims in the actual texts.",
  inputSchema: z.object({
    windowId: z.number().describe('AnalysisWindow id'),
    slice: z.enum(['all', 'context', 'focal']).default('focal'),
  }),
  async execute({ windowId, slice }) {
    const messages = getWindowMessages(getDb(), windowId, slice)
    return {
      windowId,
      slice,
      messages: messages.map((m) => ({
        id: m.id,
        ordinal: m.conversationOrdinal,
        from: m.isFromMe ? 'me' : m.senderName ?? 'them',
        text: m.text,
        sentAt: m.sentAt,
      })),
      citations: messages.map((m) => ({
        type: 'message' as const,
        id: m.id,
        label: `msg #${m.conversationOrdinal}`,
      })),
    }
  },
})
