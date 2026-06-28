import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AppDatabase } from '../src/lib/db/schema'
import { openAppDatabase } from '../src/lib/db/schema'
import { getConversation, listConversations } from '../src/lib/api/conversations'
import { getWindowMessages } from '../src/lib/api/messages'
import { getRunWindows, listRuns } from '../src/lib/api/runs'

const MIN_WINDOW_MESSAGES = 6

type ValidationResult = {
  importedMessages: number
  conversationCount: number
  selectedConversationId: number
  selectedRunId: number
  selectedWindowId: number
  fullCount: number
  contextCount: number
  focalCount: number
  elapsedMs: number
}

class ExplicitSkip extends Error {}

function appDbPath(): string {
  return path.join(
    homedir(),
    'Library',
    'Application Support',
    'imessage-emotion',
    'imessage-emotion.sqlite',
  )
}

function importedMessageCount(db: AppDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }
  return row.count
}

function validateImportedAppDb(db: AppDatabase): ValidationResult {
  const importedMessages = importedMessageCount(db)
  if (importedMessages === 0) {
    throw new ExplicitSkip('imported app DB has no imported messages')
  }

  const conversations = listConversations(db)
  for (const conversation of conversations) {
    if (conversation.messageCount < MIN_WINDOW_MESSAGES) continue

    const detail = getConversation(db, conversation.id)
    assert.ok(detail, 'conversation detail is returned')
    assert.equal(detail.id, conversation.id)
    assert.ok(detail.messageCount >= MIN_WINDOW_MESSAGES)

    const runs = listRuns(db, conversation.id)
    for (const run of runs) {
      const windows = getRunWindows(db, run.id)
      for (const window of windows) {
        const full = getWindowMessages(db, window.id, 'full')
        const context = getWindowMessages(db, window.id, 'context')
        const focal = getWindowMessages(db, window.id, 'focal')
        if (full.length === 0 || context.length === 0 || focal.length === 0) continue

        assert.ok(full.every((message) => message.conversationId === conversation.id))
        assert.ok(context.every((message) => message.conversationId === conversation.id))
        assert.ok(focal.every((message) => message.conversationId === conversation.id))

        return {
          importedMessages,
          conversationCount: conversations.length,
          selectedConversationId: conversation.id,
          selectedRunId: run.id,
          selectedWindowId: window.id,
          fullCount: full.length,
          contextCount: context.length,
          focalCount: focal.length,
          elapsedMs: 0,
        }
      }
    }
  }

  throw new ExplicitSkip(
    'imported app DB has no existing run/window with non-empty full/context/focal slices; Lane 2 baseline run creation is needed before this real smoke can pass on a fresh app DB',
  )
}

function main(): void {
  const started = Date.now()
  const dbPath = appDbPath()
  if (!existsSync(dbPath)) {
    throw new ExplicitSkip(`imported app DB not found at ${dbPath}`)
  }

  const db = openAppDatabase(dbPath)
  try {
    const result = validateImportedAppDb(db)
    result.elapsedMs = Date.now() - started

    console.log('real imported-app-db backend read API smoke passed')
    console.log(
      JSON.stringify({
        mode: 'imported-app-db-only',
        importedMessages: result.importedMessages,
        conversationCount: result.conversationCount,
        selectedConversationId: result.selectedConversationId,
        selectedRunId: result.selectedRunId,
        selectedWindowId: result.selectedWindowId,
        fullCount: result.fullCount,
        contextCount: result.contextCount,
        focalCount: result.focalCount,
        elapsedMs: result.elapsedMs,
      }),
    )
  } finally {
    db.close()
  }
}

try {
  main()
} catch (error) {
  if (error instanceof ExplicitSkip) {
    console.error(`real imported-app-db backend read API smoke skipped: ${error.message}`)
    process.exit(2)
  }
  throw error
}
