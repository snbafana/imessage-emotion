import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { openAppDatabase, type AppDatabase } from '../src/lib/db/schema'
import { getConversation, listConversations } from '../src/lib/api/conversations'
import { getWindowMessages } from '../src/lib/api/messages'
import { getRunWindows, listRuns } from '../src/lib/api/runs'
import { answerConversation } from '../src/lib/chat/answer'
import type { AskConversationInput, ConversationChatResponse } from '../src/lib/api/types'
import type { WindowMessageSlice } from '../src/lib/api/types'
import {
  API_CHANNELS,
  type BaselineRunOptions,
  type RunSummary,
  type SyncStatus,
} from '../src/lib/api/types'
import {
  createBaselineRun,
  type CreateBaselineRunOptions,
} from '../src/lib/emotion/run-baseline'
import {
  startContactsSync,
  type ContactsSyncController,
  type ContactsSyncStatus,
} from '../src/lib/sync/contacts-sync'
import {
  startIMessageSync,
  type IMessageSyncController,
  type IMessageSyncStatus,
} from '../src/lib/sync/imessage-sync'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let db: AppDatabase | null = null
let imessageSync: IMessageSyncController | null = null
let contactsSync: ContactsSyncController | null = null
let lastSyncStatus: IMessageSyncStatus = {
  state: 'idle',
  cursor: 0,
  importedMessages: 0,
}
let lastContactsStatus: ContactsSyncStatus = {
  state: 'idle',
  scannedContacts: 0,
  resolvedHandles: 0,
}

const IMESSAGE_SYNC_INTERVAL_MS = 30_000
const CONTACTS_SYNC_INTERVAL_MS = 10 * 60 * 1000

function getSyncStatus(): SyncStatus {
  return {
    messages: lastSyncStatus,
    contacts: lastContactsStatus,
  }
}

function createBaselineRunSummary(
  conversationId: number,
  options: BaselineRunOptions = {},
): RunSummary {
  if (options.methodKey && options.methodKey !== 'baseline-v1') {
    throw new Error(`Unsupported baseline method: ${options.methodKey}`)
  }

  const runOptions: CreateBaselineRunOptions = {
    mode: options.mode,
    contextMessages: options.contextMessages,
    focalMessages: options.focalMessages ?? options.windowSize,
    stride: options.stride,
    minFocalMessages: options.minFocalMessages,
    scorerConfig: options.scorerConfig,
  }
  const result = createBaselineRun(requireDatabase(), conversationId, runOptions)
  const row = requireDatabase()
    .prepare(
      `
      SELECT
        id,
        conversation_id,
        method_key,
        status,
        started_at,
        completed_at,
        summary_json,
        error
      FROM analysis_runs
      WHERE id = ?
    `,
    )
    .get(result.runId) as
    | {
        id: number
        conversation_id: number
        method_key: string
        status: RunSummary['status']
        started_at: number
        completed_at: number | null
        summary_json: string
        error: string | null
      }
    | undefined

  if (!row) throw new Error(`Missing baseline run ${result.runId}`)

  return {
    id: row.id,
    conversationId: row.conversation_id,
    methodKey: row.method_key,
    status: row.status,
    windowCount: result.windowCount,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: JSON.parse(row.summary_json) as Record<string, unknown>,
    error: row.error ?? undefined,
  }
}

function startAppServices() {
  const dbPath = path.join(app.getPath('userData'), 'imessage-emotion.sqlite')
  db = openAppDatabase(dbPath)
  imessageSync = startIMessageSync(db, {
    pollIntervalMs: IMESSAGE_SYNC_INTERVAL_MS,
    onStatus(status) {
      lastSyncStatus = status
      win?.webContents.send('imessage-sync-status', status)
    },
  })
  contactsSync = startContactsSync(db, {
    pollIntervalMs: CONTACTS_SYNC_INTERVAL_MS,
    onStatus(status) {
      lastContactsStatus = status
      win?.webContents.send('contacts-sync-status', status)
    },
  })
}

function requireDatabase(): AppDatabase {
  if (!db) throw new Error('Database is not ready')
  return db
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

ipcMain.handle(API_CHANNELS.syncMessagesNow, async () => {
  lastSyncStatus = await (imessageSync?.syncNow() ?? Promise.resolve(lastSyncStatus))
  return getSyncStatus()
})
ipcMain.handle(API_CHANNELS.listConversations, () => listConversations(requireDatabase()))
ipcMain.handle(API_CHANNELS.getConversation, (_event, conversationId: number) =>
  getConversation(requireDatabase(), conversationId),
)
ipcMain.handle(
  API_CHANNELS.analyzeConversation,
  (_event, conversationId: number, options?: BaselineRunOptions) =>
    createBaselineRunSummary(conversationId, options),
)
ipcMain.handle(API_CHANNELS.listRuns, (_event, conversationId: number) =>
  listRuns(requireDatabase(), conversationId),
)
ipcMain.handle(API_CHANNELS.getRunWindows, (_event, runId: number) =>
  getRunWindows(requireDatabase(), runId),
)
ipcMain.handle(
  API_CHANNELS.getWindowMessages,
  (_event, windowId: number, slice: WindowMessageSlice = 'all') =>
    getWindowMessages(requireDatabase(), windowId, slice),
)
ipcMain.handle(
  API_CHANNELS.askConversation,
  (_event, input: AskConversationInput): ConversationChatResponse =>
    answerConversation(requireDatabase(), {
      conversationId: input.conversationId,
      runId: input.runId,
      windowId: input.windowId,
      question: input.question,
    }),
)

app.whenReady().then(() => {
  startAppServices()
  createWindow()
})

app.on('before-quit', () => {
  imessageSync?.stop()
  contactsSync?.stop()
  db?.close()
})
