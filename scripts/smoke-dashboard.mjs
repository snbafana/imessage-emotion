import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = process.cwd()
const tempDir = path.join(root, '.smoke-dashboard')
const sourcePath = path.join(root, 'src/dashboard/data.ts')
const modulePath = path.join(tempDir, 'data.mjs')

await rm(tempDir, { recursive: true, force: true })
await mkdir(tempDir, { recursive: true })

const source = await readFile(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText

await writeFile(modulePath, compiled)

const dashboard = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`)
const now = Date.UTC(2026, 5, 28, 12, 0, 0)
const messageRequests = []

const mockApi = {
  async listConversations() {
    return [
      {
        id: 101,
        title: 'Avery API',
        participantSummary: 'Avery',
        messageCount: 4,
        firstMessageAt: now - 86_400_000,
        lastMessageAt: now,
        latestRun: {
          id: 9001,
          conversationId: 101,
          methodKey: 'baseline-v1',
          status: 'completed',
          windowCount: 1,
          scoredWindowCount: 1,
          startedAt: now,
          completedAt: now + 1_000,
          summary: { strongestShift: 'stress' },
        },
      },
      {
        id: 202,
        title: 'No Run Person',
        participantSummary: 'No Run Person',
        messageCount: 1,
        firstMessageAt: now,
        lastMessageAt: now,
        latestRun: null,
      },
    ]
  },
  async listRuns(conversationId) {
    if (conversationId === 202) return []
    return [
      {
        id: 9001,
        conversationId,
        methodKey: 'baseline-v1',
        status: 'completed',
        windowCount: 1,
        scoredWindowCount: 1,
        startedAt: now,
        completedAt: now + 1_000,
        summary: { strongestShift: 'stress' },
      },
    ]
  },
  async getRunWindows(runId) {
    assert(runId === 9001, 'dashboard requests run-owned windows by selected run id')
    return [
      {
        id: 501,
        runId,
        conversationId: 101,
        ordinal: 1,
        status: 'completed',
        startOrdinal: 1,
        endOrdinal: 4,
        contextStartOrdinal: 1,
        contextEndOrdinal: 2,
        focalStartOrdinal: 3,
        focalEndOrdinal: 4,
        messageCount: 4,
        contextMessageCount: 2,
        focalMessageCount: 2,
        result: {
          scores: { warmth: 0.22, joy: 0.11, stress: 0.71, friction: 0.64, sadness: 0.08 },
          dominant: 'stress',
          summary: 'API-provided baseline stress increase.',
          method: 'baseline-v1',
        },
        shift: { direction: 'stress-up' },
        latencyMs: 12,
      },
    ]
  },
  async getWindowMessages(windowId, slice) {
    messageRequests.push(`${windowId}:${slice}`)
    assert(windowId === 501, 'dashboard requests selected run-owned window messages by window id')
    if (slice === 'context') {
      return [
        {
          id: 1,
          conversationId: 101,
          conversationOrdinal: 1,
          senderContactId: null,
          senderName: 'Avery',
          text: 'context message from API',
          sentAt: now - 60_000,
          isFromMe: false,
          isRead: true,
          hasAttachments: false,
        },
      ]
    }
    return [
      {
        id: 3,
        conversationId: 101,
        conversationOrdinal: 3,
        senderContactId: null,
        senderName: 'You',
        text: 'focal message from API',
        sentAt: now,
        isFromMe: true,
        isRead: true,
        hasAttachments: false,
      },
    ]
  },
}

globalThis.window = { ipcRenderer: mockApi }

const api = dashboard.getDashboardApi()
assert(api === mockApi, 'dashboard reads typed window.ipcRenderer app API')

const conversations = dashboard.normalizeConversations(await api.listConversations())
assert(conversations.some((conversation) => conversation.title === 'Avery API'), 'sidebar has API conversation')
assert(
  !conversations.some((conversation) => conversation.title === 'Maya Chen'),
  'sidebar is not using PEOPLE mock data',
)

const runs = dashboard.normalizeRuns(await api.listRuns(conversations[0].rawId))
const run = dashboard.latestRun(runs)
const windows = dashboard.normalizeWindows(await api.getRunWindows(run.rawId))
const contextMessages = await dashboard.getWindowMessages(api, windows[0].rawId, 'context')
const focalMessages = await dashboard.getWindowMessages(api, windows[0].rawId, 'focal')
assert(
  messageRequests.join(',') === '501:context,501:focal',
  'dashboard requests separate context and focal message slices',
)
const html = dashboard.renderDashboardSmokeHtml({
  conversations,
  run,
  windows,
  selectedWindow: windows[0],
  contextMessages,
  focalMessages,
})

assert(html.includes('Avery API'), 'rendered sidebar includes API conversation')
assert(html.includes('Baseline scored'), 'timeline shows scored run status')
assert(html.includes('Window 1'), 'timeline renders API-provided window')
assert(html.includes('Old context'), 'inspector labels context section')
assert(html.includes('New focal'), 'inspector labels focal section')
assert(html.includes('context message from API'), 'inspector renders context message')
assert(html.includes('focal message from API'), 'inspector renders focal message')
assert(html.includes('API-provided baseline stress increase.'), 'inspector renders result summary')
assert(!html.includes('Maya Chen'), 'rendered dashboard does not contain PEOPLE mock data')

const noRunHtml = dashboard.renderDashboardSmokeHtml({
  conversations,
  run: null,
  windows: [],
  selectedWindow: null,
  contextMessages: [],
  focalMessages: [],
})
assert(noRunHtml.includes('No baseline run yet'), 'empty/no-run state is visible')

await rm(tempDir, { recursive: true, force: true })
console.log('dashboard smoke passed')

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Smoke assertion failed: ${message}`)
  }
}
