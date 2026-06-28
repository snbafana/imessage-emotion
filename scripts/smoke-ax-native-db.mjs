import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function appDbPath() {
  return (
    process.env.IMESSAGE_EMOTION_DB_PATH ??
    process.env.IMESSAGE_EMOTION_APP_DB ??
    join(homedir(), 'Library', 'Application Support', 'imessage-emotion', 'imessage-emotion.sqlite')
  )
}

const dbPath = appDbPath()
assert(existsSync(dbPath), `App DB not found at configured path; run app sync first or set IMESSAGE_EMOTION_DB_PATH`)

const started = performance.now()
const outPath = resolve('experiments/emotion-methods/out/native-db-smoke.json')
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(
  command,
  [
    '--dir',
    'experiments/emotion-methods',
    'exec',
    'tsx',
    'harness_ax.ts',
    '--config',
    'harness.ax.native-smoke.json',
    '--out',
    'out/native-db-smoke.json',
    '--no-provider',
  ],
  {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      IMESSAGE_EMOTION_DB_PATH: dbPath,
    },
    maxBuffer: 10 * 1024 * 1024,
  },
)

if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.stdout.write(result.stdout)
  process.exit(result.status ?? 1)
}

const output = JSON.parse(readFileSync(outPath, 'utf8'))
const source = output.dataset?.source?.nativeDb
const llm = output.llm?.[0]
const packetRows = llm?.rows ?? []

assert(output.noProvider === true, 'native DB smoke must run without provider calls')
assert(source?.counts && Number.isInteger(source.counts.messages), 'smoke output must include app DB counts')
assert(!JSON.stringify(output).includes('windowText'), 'smoke output must not persist private prompt text')
assert(packetRows.every((row) => row.dryRun === true), 'all smoke rows must be packet-only dry runs')
assert(
  packetRows.every((row) => row.messageCount >= 4 && row.messageCount <= 8),
  'smoke packets must use the requested native smoke window shape',
)

if (source.counts.messages > 0) {
  assert(packetRows.length > 0, 'app DB has messages but no Ax score packets were built')
}

console.log(
  JSON.stringify(
    {
      ok: true,
      source: 'real-app-db',
      counts: {
        conversations: source.counts.conversations,
        messages: source.counts.messages,
        contacts: source.counts.contacts,
      },
      selectedConversations: source.selectedConversationCount,
      existingRuns: source.existingRunCount,
      existingWindows: source.existingWindowCount,
      packetCount: packetRows.length,
      tokenEstimate: llm?.tokenEstimate ?? null,
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    },
    null,
    2,
  ),
)
