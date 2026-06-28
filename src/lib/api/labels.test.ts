import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import { createBaselineRun } from '../emotion/run-baseline'
import { getLabelingWindow, listLabelingWindows, saveWindowLabel } from './labels'

function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function seedConversation(db: AppDatabase, messageCount: number): number {
  const conversation = db
    .prepare(
      `
      INSERT INTO conversations (
        source_chat_id,
        chat_identifier,
        display_name,
        is_group,
        message_count,
        first_message_at,
        last_message_at
      )
      VALUES (1, 'chat-1', 'Synthetic Labeling Chat', 0, ?, 1000, ?)
    `,
    )
    .run(messageCount, messageCount * 1000)
  const conversationId = Number(conversation.lastInsertRowid)
  const insert = db.prepare(
    `
    INSERT INTO messages (
      conversation_id,
      conversation_ordinal,
      source_rowid,
      guid,
      text,
      sent_at,
      is_from_me,
      is_read,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'delivered')
  `,
  )

  for (let ordinal = 1; ordinal <= messageCount; ordinal += 1) {
    insert.run(
      conversationId,
      ordinal,
      ordinal,
      `message-${ordinal}`,
      ordinal > 120 ? 'sorry this feels distant' : 'thanks happy logistics',
      ordinal * 1000,
      ordinal % 2,
    )
  }
  return conversationId
}

describe('window labels api', () => {
  it('lists labelable windows and persists human labels with message evidence', () => {
    const db = createMemoryDb()
    const conversationId = seedConversation(db, 180)
    const run = createBaselineRun(db, conversationId)
    const [summary] = listLabelingWindows(db, { limit: 10 })

    expect(run.windowCount).toBe(2)
    expect(summary.conversation.title).toBe('Synthetic Labeling Chat')
    expect(summary.label).toBeNull()
    expect(summary.window.contextMessageCount).toBe(100)
    expect(summary.window.focalMessageCount).toBe(50)

    const detail = getLabelingWindow(db, summary.window.id)
    expect(detail?.beforeMessages).toHaveLength(0)
    expect(detail?.contextMessages).toHaveLength(100)
    expect(detail?.focalMessages).toHaveLength(50)
    expect(detail?.allMessages).toHaveLength(150)
    expect(detail?.afterMessages).toHaveLength(24)

    const evidenceId = detail?.focalMessages[0]?.id
    const pivotalId = detail?.contextMessages.at(-1)?.id
    expect(evidenceId).toBeTypeOf('number')
    expect(pivotalId).toBeTypeOf('number')

    const saved = saveWindowLabel(db, {
      windowId: summary.window.id,
      dominant: 'sadness',
      acceptableDominants: ['sadness', 'neutral'],
      scores: { sadness: 0.85, neutral: 0.25 },
      requiresContext: true,
      sarcasmOrSubtext: true,
      ambiguity: 'high',
      stateLabel: 'distant but not hostile',
      evidenceMessageRefs: [evidenceId as number],
      pivotalMessageRefs: [pivotalId as number],
      notes: 'Needs the prior logistics context to read correctly.',
    })

    expect(saved.dominant).toBe('sadness')
    expect(saved.acceptableDominants).toEqual(['sadness', 'neutral'])
    expect(saved.requiresContext).toBe(true)
    expect(saved.sarcasmOrSubtext).toBe(true)
    expect(saved.evidenceMessageRefs).toEqual([evidenceId])
    expect(saved.pivotalMessageRefs).toEqual([pivotalId])

    const labeledSummary = listLabelingWindows(db, { limit: 10 }).find(
      (item) => item.window.id === summary.window.id,
    )
    expect(labeledSummary).toBeDefined()
    expect(labeledSummary?.label?.dominant).toBe('sadness')
    expect(getLabelingWindow(db, summary.window.id)?.label?.stateLabel).toBe(
      'distant but not hostile',
    )
  })
})
