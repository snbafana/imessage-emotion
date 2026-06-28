import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import {
  createAnalysisRunForWindows,
  ensureWindowsForConversation,
  planWindowRanges,
  upsertScorerConfig,
  upsertWindowConfig,
} from './windows'

function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function seedConversation(db: AppDatabase, messageCount: number): number {
  const conversation = db
    .prepare(
      `
      INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group)
      VALUES (1, 'chat-1', NULL, 0)
    `,
    )
    .run()
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
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'delivered')
  `,
  )
  for (let ordinal = 1; ordinal <= messageCount; ordinal += 1) {
    insert.run(
      conversationId,
      ordinal,
      ordinal,
      `message-${ordinal}`,
      `synthetic ${ordinal}`,
      ordinal * 1000,
    )
  }
  return conversationId
}

describe('window planning', () => {
  it('uses overlapping ordinal ranges and includes a tail when it has enough messages', () => {
    expect(planWindowRanges(225, 100, 50, 50)).toEqual([
      { startOrdinal: 1, endOrdinal: 100 },
      { startOrdinal: 51, endOrdinal: 150 },
      { startOrdinal: 101, endOrdinal: 200 },
      { startOrdinal: 151, endOrdinal: 225 },
    ])
  })

  it('does not create duplicate tail windows when the last full window reaches the end', () => {
    expect(planWindowRanges(200, 100, 50, 50)).toEqual([
      { startOrdinal: 1, endOrdinal: 100 },
      { startOrdinal: 51, endOrdinal: 150 },
      { startOrdinal: 101, endOrdinal: 200 },
    ])
  })

  it('skips tails below the configured minimum', () => {
    expect(planWindowRanges(225, 100, 50, 80)).toEqual([
      { startOrdinal: 1, endOrdinal: 100 },
      { startOrdinal: 51, endOrdinal: 150 },
      { startOrdinal: 101, endOrdinal: 200 },
    ])
  })
})

describe('window persistence', () => {
  it('stores ordinal boundaries and message evidence ids', () => {
    const db = createMemoryDb()
    const conversationId = seedConversation(db, 225)
    const configId = upsertWindowConfig(db, {
      name: '100-by-50',
      messageCount: 100,
      stride: 50,
      minTailMessages: 50,
    })

    const windowIds = ensureWindowsForConversation(db, conversationId, configId)
    expect(windowIds).toHaveLength(4)

    const rows = db
      .prepare(
        `
        SELECT start_ordinal, end_ordinal, message_count, start_message_id, end_message_id
        FROM windows
        ORDER BY start_ordinal
      `,
      )
      .all() as Array<{
      start_ordinal: number
      end_ordinal: number
      message_count: number
      start_message_id: number
      end_message_id: number
    }>

    expect(rows.map((row) => [row.start_ordinal, row.end_ordinal, row.message_count])).toEqual([
      [1, 100, 100],
      [51, 150, 100],
      [101, 200, 100],
      [151, 225, 75],
    ])
    expect(rows[0].start_message_id).toBe(1)
    expect(rows[0].end_message_id).toBe(100)
  })

  it('links analysis runs to reusable windows', () => {
    const db = createMemoryDb()
    const conversationId = seedConversation(db, 150)
    const configId = upsertWindowConfig(db, {
      name: '100-by-50',
      messageCount: 100,
      stride: 50,
      minTailMessages: 50,
    })
    const windowIds = ensureWindowsForConversation(db, conversationId, configId)
    const scorerConfigId = upsertScorerConfig(db, 'stub-v1', 'Stub scorer')

    const firstRunId = createAnalysisRunForWindows(db, scorerConfigId, windowIds)
    const secondRunId = createAnalysisRunForWindows(db, scorerConfigId, windowIds)

    const links = db
      .prepare('SELECT run_id, window_id FROM run_windows ORDER BY run_id, window_id')
      .all()
    expect(links).toEqual([
      { run_id: firstRunId, window_id: windowIds[0] },
      { run_id: firstRunId, window_id: windowIds[1] },
      { run_id: secondRunId, window_id: windowIds[0] },
      { run_id: secondRunId, window_id: windowIds[1] },
    ])
  })
})
