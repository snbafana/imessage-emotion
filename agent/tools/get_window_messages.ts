import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { getDb } from '../../src/lib/db/connection'
import { getWindowMessages } from '../../src/lib/api/messages'

export default defineTool({
  description:
    "Read message text for one analysis window. Use slice 'focal' for the messages being scored, 'context' for the prior conversation context, or 'all' when the contrast matters.",
  inputSchema: z.object({
    windowId: z.number().int().positive().describe('Window id from clientContext.windowId or list_run_windows'),
    slice: z
      .enum(['focal', 'context', 'all'])
      .default('focal')
      .describe('Which part of the window to read; focal is the scored slice'),
  }),
  async execute({ windowId, slice }) {
    const messages = getWindowMessages(getDb(), windowId, slice)
    return {
      windowId,
      slice,
      messageCount: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        ordinal: m.conversationOrdinal,
        from: m.isFromMe ? 'me' : m.senderName ?? 'them',
        text: m.text,
        sentAt: m.sentAt,
        hasAttachments: m.hasAttachments,
        status: m.status,
      })),
      citations: messages.map((m) => ({
        type: 'message' as const,
        id: m.id,
        label: `msg #${m.conversationOrdinal}`,
      })),
    }
  },
})
