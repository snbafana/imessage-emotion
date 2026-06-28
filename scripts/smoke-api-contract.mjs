import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const methods = [
  'syncMessagesNow',
  'listConversations',
  'getConversation',
  'analyzeConversation',
  'listRuns',
  'getRunWindows',
  'getWindowMessages',
  'askConversation',
]

const types = [
  'ConversationSummary',
  'ConversationDetail',
  'RunSummary',
  'AnalysisWindow',
  'WindowMessage',
  'WindowResult',
  'WindowShiftMetadata',
  'RunSummaryMetadata',
  'SyncStatus',
  'ChatTurn',
]

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const typePath = 'src/lib/api/types.ts'
assert(existsSync(join(root, typePath)), `${typePath} must exist`)

const typeSource = read(typePath)
const preloadSource = read('electron/preload.ts')
const envSource = read('electron/electron-env.d.ts')
const mainSource = read('electron/main.ts')

for (const typeName of types) {
  assert(
    new RegExp(`export\\s+(interface|type)\\s+${typeName}\\b`).test(typeSource),
    `${typePath} must export ${typeName}`,
  )
}

for (const methodName of methods) {
  assert(typeSource.includes(`${methodName}:`), `API_CHANNELS must include ${methodName}`)
  assert(
    new RegExp(`${methodName}\\s*\\(`).test(typeSource),
    `ImessageEmotionApi must define ${methodName}()`,
  )
  assert(preloadSource.includes(`${methodName}:`), `preload must expose ${methodName}`)
  assert(mainSource.includes(`API_CHANNELS.${methodName}`), `main must register ${methodName}`)
}

assert(
  preloadSource.includes("contextBridge.exposeInMainWorld('ipcRenderer'"),
  'preload must expose window.ipcRenderer',
)
assert(
  !preloadSource.includes("exposeInMainWorld('imessageEmotion'") &&
    !preloadSource.includes('exposeInMainWorld("imessageEmotion"'),
  'preload must not expose window.imessageEmotion',
)
assert(!/\bsend\s*\(\s*\.\.\.args/.test(preloadSource), 'preload must not forward generic send')
assert(
  !/\binvoke\s*\(\s*\.\.\.args/.test(preloadSource),
  'preload must not forward generic invoke',
)
assert(envSource.includes('ipcRenderer'), 'Window type must include ipcRenderer')
assert(
  !envSource.includes("import('electron').IpcRenderer"),
  'Window type must not expose Electron IpcRenderer',
)
assert(
  typeSource.includes('summary: RunSummaryMetadata | Record<string, unknown>'),
  'RunSummary must expose parsed analysis_runs.summary_json metadata',
)
assert(
  typeSource.includes('shift: WindowShiftMetadata | Record<string, unknown>'),
  'AnalysisWindow must expose parsed windows.shift_json metadata',
)

console.log(`API contract smoke passed: ${methods.length} methods, ${types.length} shared types`)
