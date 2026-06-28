import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { publicProcedure, router } from './trpc'
import { getDb } from '@/lib/db/connection'
import { getConversation, listConversations } from '@/lib/api/conversations'
import { searchContacts } from '@/lib/contacts/search'
import { getRunWindows, listRuns } from '@/lib/api/runs'
import { getWindowMessages } from '@/lib/api/messages'
import { getLabelingWindow, listLabelingWindows, saveWindowLabel } from '@/lib/api/labels'
import { createAxRun, finishAxRun } from '@/lib/emotion/run-analysis'
import { EKMAN_ANCHORS } from '@/lib/emotion/anchors'
import { getServerSyncEngine } from '@/lib/sync/server-sync'
import { DEFAULT_CHAT_DB_PATH } from '@/lib/imessage/reader'
import { buildOnboardingStatus } from '@/lib/onboarding/status'

const sliceInput = z.enum(['all', 'full', 'context', 'focal'])
const execFileAsync = promisify(execFile)
const FULL_DISK_ACCESS_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
const CONTACTS_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts'
const emotionAnchorInput = z.enum(EKMAN_ANCHORS)
const ambiguityInput = z.enum(['low', 'medium', 'high'])

const analysisOptions = z
  .object({
    mode: z.enum(['absolute-message-count', 'comparative-message-count']),
    contextMessages: z.number(),
    focalMessages: z.number(),
    stride: z.number(),
    minFocalMessages: z.number(),
    scorerConfig: z.record(z.string(), z.unknown()),
  })
  .partial()

async function openSettings(target: string): Promise<{ opened: boolean }> {
  if (process.platform !== 'darwin') return { opened: false }
  await execFileAsync('open', [target])
  return { opened: true }
}

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
  onboardingStatus: publicProcedure.query(() =>
    buildOnboardingStatus(
      getDb(),
      getServerSyncEngine(getDb()).getStatus(),
      { chatDbPath: process.env.IMESSAGE_CHAT_DB_PATH ?? DEFAULT_CHAT_DB_PATH },
    ),
  ),

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

  createAnalysisRun: publicProcedure
    .input(z.object({ conversationId: z.number(), options: analysisOptions.optional() }))
    .mutation(({ input }) => {
      const db = getDb()
      // Create the run and its (unscored) windows synchronously so the client gets
      // a runId and rows to poll immediately, then score in the background. The
      // client polls listRuns/getRunWindows to fill the timeline window-by-window.
      const { runId } = createAxRun(db, input.conversationId, input.options ?? {})
      // Scorer/window config is already persisted on the run row; finishAxRun
      // reads it back, so it needs no options here.
      void finishAxRun(db, runId).catch((error) => {
        console.error(`Ax analysis run ${runId} failed:`, error)
      })
      const run = listRuns(db, input.conversationId).find((item) => item.id === runId)
      if (!run) throw new Error(`Analysis run ${runId} was created but could not be read back`)
      return run
    }),

  syncStatus: publicProcedure.query(() => getServerSyncEngine(getDb()).getStatus()),

  syncMessages: publicProcedure.mutation(() => getServerSyncEngine(getDb()).syncMessages()),

  syncContacts: publicProcedure.mutation(() => getServerSyncEngine(getDb()).syncContacts()),

  syncLocalData: publicProcedure.mutation(async () => {
    const db = getDb()
    const engine = getServerSyncEngine(db)
    await engine.syncMessages()
    await engine.syncContacts()
    return buildOnboardingStatus(
      db,
      engine.getStatus(),
      { chatDbPath: process.env.IMESSAGE_CHAT_DB_PATH ?? DEFAULT_CHAT_DB_PATH },
    )
  }),

  openFullDiskAccessSettings: publicProcedure.mutation(() => openSettings(FULL_DISK_ACCESS_SETTINGS)),

  openContactsSettings: publicProcedure.mutation(() => openSettings(CONTACTS_SETTINGS)),
})

export type AppRouter = typeof appRouter
