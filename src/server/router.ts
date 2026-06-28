import { z } from 'zod'
import { publicProcedure, router } from './trpc'
import { getDb } from '@/lib/db/connection'
import { getConversation, listConversations } from '@/lib/api/conversations'
import { searchContacts } from '@/lib/contacts/search'
import { getRunWindows, listRuns } from '@/lib/api/runs'
import { getWindowMessages } from '@/lib/api/messages'
import { getLabelingWindow, listLabelingWindows, saveWindowLabel } from '@/lib/api/labels'
import { createBaselineRun } from '@/lib/emotion/run-baseline'
import { EKMAN_ANCHORS } from '@/lib/emotion/anchors'
import { answerConversation } from '@/lib/chat/answer'
import { getServerSyncEngine } from '@/lib/sync/server-sync'

const sliceInput = z.enum(['all', 'full', 'context', 'focal'])
const emotionAnchorInput = z.enum(EKMAN_ANCHORS)
const ambiguityInput = z.enum(['low', 'medium', 'high'])

const baselineOptions = z
  .object({
    mode: z.enum(['absolute-message-count', 'comparative-message-count']),
    contextMessages: z.number(),
    focalMessages: z.number(),
    stride: z.number(),
    minFocalMessages: z.number(),
    scorerConfig: z.record(z.string(), z.unknown()),
  })
  .partial()

const askInput = z.object({
  conversationId: z.number(),
  question: z.string(),
  runId: z.number(),
  windowId: z.number(),
})

const listLabelingWindowsInput = z
  .object({
    conversationId: z.number().optional(),
    runId: z.number().optional(),
    labeler: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .optional()

const saveWindowLabelInput = z.object({
  windowId: z.number(),
  labeler: z.string().optional(),
  dominant: emotionAnchorInput.nullable().optional(),
  acceptableDominants: z.array(emotionAnchorInput).optional(),
  scores: z.partialRecord(emotionAnchorInput, z.number().min(0).max(1)).optional(),
  requiresContext: z.boolean().nullable().optional(),
  sarcasmOrSubtext: z.boolean().nullable().optional(),
  ambiguity: ambiguityInput.nullable().optional(),
  stateLabel: z.string().nullable().optional(),
  evidenceMessageRefs: z.array(z.number()).optional(),
  pivotalMessageRefs: z.array(z.number()).optional(),
  notes: z.string().nullable().optional(),
})

export const appRouter = router({
  listConversations: publicProcedure.query(() => listConversations(getDb())),

  getConversation: publicProcedure
    .input(z.number())
    .query(({ input }) => getConversation(getDb(), input)),

  searchContacts: publicProcedure
    .input(z.string())
    .query(({ input }) => searchContacts(getDb(), input)),

  listRuns: publicProcedure.input(z.number()).query(({ input }) => listRuns(getDb(), input)),

  getRunWindows: publicProcedure.input(z.number()).query(({ input }) => getRunWindows(getDb(), input)),

  getWindowMessages: publicProcedure
    .input(z.object({ windowId: z.number(), slice: sliceInput.default('all') }))
    .query(({ input }) => getWindowMessages(getDb(), input.windowId, input.slice)),

  listLabelingWindows: publicProcedure
    .input(listLabelingWindowsInput)
    .query(({ input }) => listLabelingWindows(getDb(), input ?? {})),

  getLabelingWindow: publicProcedure
    .input(z.object({ windowId: z.number(), labeler: z.string().optional() }))
    .query(({ input }) => getLabelingWindow(getDb(), input.windowId, input.labeler)),

  saveWindowLabel: publicProcedure
    .input(saveWindowLabelInput)
    .mutation(({ input }) => saveWindowLabel(getDb(), input)),

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

  syncStatus: publicProcedure.query(() => getServerSyncEngine(getDb()).getStatus()),

  syncMessages: publicProcedure.mutation(() => getServerSyncEngine(getDb()).syncMessages()),

  syncContacts: publicProcedure.mutation(() => getServerSyncEngine(getDb()).syncContacts()),
})

export type AppRouter = typeof appRouter
