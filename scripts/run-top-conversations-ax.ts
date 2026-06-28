import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDb } from '../src/lib/db/connection'
import {
  createAxAnalysisRun,
  deleteAllAnalysisRuns,
  type CreateAxRunOptions,
} from '../src/lib/emotion/run-analysis'
import {
  planCappedRunWindowConfig,
  planRunWindowRanges,
  type RunWindowConfig,
} from '../src/lib/windows/windows'

type ConversationRow = {
  id: number
  title: string
  message_count: number
}

loadDotEnv(resolve(process.cwd(), '.env'))

const limit = numberArg('--limit') ?? 5
const deleteExisting = process.argv.includes('--delete-existing')
const effort = stringArg('--effort') ?? 'medium'
const model = stringArg('--model') ?? process.env.IMESSAGE_EMOTION_AX_MODEL?.trim()
const maxWindows = numberArg('--max-windows') ?? 200
const overlapPercent = numberArg('--overlap') ?? 25
const explicitContextMessages = numberArg('--context')
const explicitFocalMessages = numberArg('--focal')
const explicitStride = numberArg('--stride')
const explicitMinFocalMessages = numberArg('--min-focal')

if (overlapPercent < 10 || overlapPercent > 40) {
  throw new RangeError('--overlap must be between 10 and 40 percent')
}

void main()

async function main(): Promise<void> {
  const db = getDb()
  if (deleteExisting) {
    const deleted = deleteAllAnalysisRuns(db)
    console.log(JSON.stringify({ event: 'deleted_analysis_runs', deleted }))
  }

  const conversations = topOneOnOneConversations(db, limit)
  console.log(JSON.stringify({ event: 'selected_conversations', conversations }))

  for (const conversation of conversations) {
    const startedAt = Date.now()
    const windowConfig = windowConfigFor(conversation.message_count)
    const estimatedWindowCount = planRunWindowRanges(conversation.message_count, windowConfig).length
    const options: CreateAxRunOptions = {
      ...windowConfig,
      scorerConfig: {
        effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'medium',
        provider: 'openrouter',
        model,
        promptKey: 'top5-capped-overlap-v1',
        label: `Ax capped ${overlapPercent}% overlap`,
        overlapPercent,
        maxWindows,
        estimatedWindowCount,
      },
    }
    console.log(
      JSON.stringify({
        event: 'run_started',
        conversation,
        windowConfig,
        estimatedWindowCount,
        maxWindows,
        overlapPercent,
        model: model ?? 'default-for-effort',
      }),
    )
    const run = await createAxAnalysisRun(db, conversation.id, options)
    console.log(
      JSON.stringify({
        event: 'run_completed',
        conversationId: conversation.id,
        title: conversation.title,
        messageCount: conversation.message_count,
        runId: run.runId,
        windowCount: run.windowCount,
        elapsedMs: Date.now() - startedAt,
      }),
    )
  }
}

function windowConfigFor(messageCount: number): RunWindowConfig {
  if (explicitContextMessages || explicitFocalMessages || explicitStride || explicitMinFocalMessages) {
    const focalMessages = explicitFocalMessages ?? 64
    const stride = explicitStride ?? strideFromOverlap(focalMessages)
    return {
      mode: 'comparative-message-count',
      contextMessages: explicitContextMessages ?? Math.min(messageCount, focalMessages * 2),
      focalMessages,
      stride,
      minFocalMessages: explicitMinFocalMessages ?? Math.max(8, Math.ceil(focalMessages / 2)),
    }
  }

  return planCappedRunWindowConfig(messageCount, { maxWindows, overlapPercent }).config
}

function strideFromOverlap(focalMessages: number): number {
  return Math.max(1, Math.round(focalMessages * (1 - overlapPercent / 100)))
}

function topOneOnOneConversations(db: ReturnType<typeof getDb>, count: number): ConversationRow[] {
  return db
    .prepare(
      `
      SELECT
        c.id,
        c.message_count,
        COALESCE(
          NULLIF(c.display_name, ''),
          GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier)),
          c.chat_identifier
        ) AS title
      FROM conversations c
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
      LEFT JOIN contacts ct ON ct.id = cp.contact_id
      WHERE c.is_group = 0
      GROUP BY c.id
      ORDER BY c.message_count DESC, c.id DESC
      LIMIT ?
    `,
    )
    .all(count) as ConversationRow[]
}

function numberArg(name: string): number | null {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = Number(process.argv[index + 1])
  return Number.isInteger(value) && value > 0 ? value : null
}

function stringArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]?.trim()
  return value || null
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = unquote(match[2])
  }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
