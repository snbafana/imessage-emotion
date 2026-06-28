import { z } from 'zod'
import { publicProcedure, router } from './trpc'
import { getDb } from '@/lib/db/connection'
import { getConversation, listConversations } from '@/lib/api/conversations'
import { getRunWindows, listRuns } from '@/lib/api/runs'
import { getWindowMessages } from '@/lib/api/messages'
import { createBaselineRun } from '@/lib/emotion/run-baseline'
import { answerConversation } from '@/lib/chat/answer'
import { getLastImportedRowid, importBatch } from '@/lib/import/import-messages'
import { DEFAULT_CHAT_DB_PATH, LocalIMessageReader } from '@/lib/imessage/reader'
import type { SyncStatus } from '@/lib/api/types'

const sliceInput = z.enum(['all', 'full', 'context', 'focal'])

const baselineOptions = z
  .object({
    mode: z.enum(['absolute-message-count', 'comparative-message-count']),
    contextMessages: z.number(),
    focalMessages: z.number(),
    stride: z.number(),
    minFocalMessages: z.number(),
    scorerConfig: z.record(z.unknown()),
  })
  .partial()

const askInput = z.object({
  conversationId: z.number(),
  question: z.string(),
  runId: z.number(),
  windowId: z.number(),
})

function currentSyncStatus(): SyncStatus {
  return {
    messages: { state: 'idle', cursor: getLastImportedRowid(getDb()), importedMessages: 0 },
    contacts: { state: 'idle', scannedContacts: 0, resolvedHandles: 0 },
  }
}

export const appRouter = router({
  listConversations: publicProcedure.query(() => listConversations(getDb())),

  getConversation: publicProcedure
    .input(z.number())
    .query(({ input }) => getConversation(getDb(), input)),

  listRuns: publicProcedure.input(z.number()).query(({ input }) => listRuns(getDb(), input)),

  getRunWindows: publicProcedure.input(z.number()).query(({ input }) => getRunWindows(getDb(), input)),

  getWindowMessages: publicProcedure
    .input(z.object({ windowId: z.number(), slice: sliceInput.default('all') }))
    .query(({ input }) => getWindowMessages(getDb(), input.windowId, input.slice)),

  createBaselineRun: publicProcedure
    .input(z.object({ conversationId: z.number(), options: baselineOptions.optional() }))
    .mutation(({ input }) => {
      const db = getDb()
      const { runId } = createBaselineRun(db, input.conversationId, input.options ?? {})
      const run = listRuns(db, input.conversationId).find((item) => item.id === runId)
      if (!run) throw new Error(`Baseline run ${runId} was created but could not be read back`)
      return run
    }),

  askConversation: publicProcedure
    .input(askInput)
    .mutation(({ input }) => answerConversation(getDb(), input)),

  syncStatus: publicProcedure.query(() => currentSyncStatus()),

  syncMessages: publicProcedure.mutation((): SyncStatus => {
    const db = getDb()
    const cursor = getLastImportedRowid(db)
    const reader = new LocalIMessageReader(
      process.env.IMESSAGE_CHAT_DB_PATH ?? DEFAULT_CHAT_DB_PATH,
    )
    try {
      const batch = reader.buildBatch(cursor, 1_000)
      const result = importBatch(db, batch)
      return {
        messages: {
          state: 'idle',
          cursor: result.cursor,
          importedMessages: result.importedMessages,
          hasMore: batch.fetchedCount >= 1_000,
        },
        contacts: { state: 'idle', scannedContacts: 0, resolvedHandles: 0 },
      }
    } finally {
      reader.close()
    }
  }),
})

export type AppRouter = typeof appRouter
