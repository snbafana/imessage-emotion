import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import { createBaselineRun } from '../emotion/run-baseline'
import { createWindowsForRun, planRunWindowRanges, planWindowRanges } from './windows'

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
      ordinal % 3 === 0 ? 'thanks happy' : 'synthetic neutral',
      ordinal * 1000,
    )
  }
  return conversationId
}

describe('window planning', () => {
  it('uses overlapping absolute ordinal ranges and includes a tail when it has enough messages', () => {
    expect(planWindowRanges(225, 100, 50, 50)).toEqual([
      { startOrdinal: 1, endOrdinal: 100 },
      { startOrdinal: 51, endOrdinal: 150 },
      { startOrdinal: 101, endOrdinal: 200 },
      { startOrdinal: 151, endOrdinal: 225 },
    ])
  })

  it('plans comparative windows with context before focal messages', () => {
    expect(
      planRunWindowRanges(225, {
        mode: 'comparative-message-count',
        contextMessages: 100,
        focalMessages: 50,
        stride: 50,
        minFocalMessages: 25,
      }),
    ).toEqual([
      {
        ordinal: 1,
        startOrdinal: 1,
        endOrdinal: 150,
        contextStartOrdinal: 1,
        contextEndOrdinal: 100,
        focalStartOrdinal: 101,
        focalEndOrdinal: 150,
        contextMessageCount: 100,
        focalMessageCount: 50,
      },
      {
        ordinal: 2,
        startOrdinal: 51,
        endOrdinal: 200,
        contextStartOrdinal: 51,
        contextEndOrdinal: 150,
        focalStartOrdinal: 151,
        focalEndOrdinal: 200,
        contextMessageCount: 100,
        focalMessageCount: 50,
      },
      {
        ordinal: 3,
        startOrdinal: 101,
        endOrdinal: 225,
        contextStartOrdinal: 101,
        contextEndOrdinal: 200,
        focalStartOrdinal: 201,
        focalEndOrdinal: 225,
        contextMessageCount: 100,
        focalMessageCount: 25,
      },
    ])
  })

  it('rejects configs that would create gaps or impossible tails', () => {
    expect(() => planWindowRanges(200, 100, 101, 50)).toThrow(RangeError)
    expect(() => planWindowRanges(200, 100, 50, 101)).toThrow(RangeError)
  })
})

describe('run-owned window persistence', () => {
  it('creates separate rows for identical ordinal ranges in separate runs', () => {
    const db = createMemoryDb()
    const conversationId = seedConversation(db, 150)

    const firstRun = createBaselineRun(db, conversationId)
    const secondRun = createBaselineRun(db, conversationId)

    const rows = db
      .prepare(
        `
        SELECT run_id, ordinal, start_ordinal, end_ordinal, result_json
        FROM windows
        ORDER BY run_id, ordinal
      `,
      )
      .all() as Array<{
      run_id: number
      ordinal: number
      start_ordinal: number
      end_ordinal: number
      result_json: string
    }>

    expect(firstRun.windowCount).toBe(1)
    expect(secondRun.windowCount).toBe(1)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => [row.run_id, row.start_ordinal, row.end_ordinal])).toEqual([
      [firstRun.runId, 1, 150],
      [secondRun.runId, 1, 150],
    ])
    expect(JSON.parse(rows[0].result_json).scores.warmth).toBeGreaterThan(0)
  })

  it('stores context and focal boundaries on the run-owned window', () => {
    const db = createMemoryDb()
    const conversationId = seedConversation(db, 225)
    const run = db
      .prepare(
        `
        INSERT INTO analysis_runs (
          conversation_id,
          method_key,
          status,
          window_config_json,
          context_config_json,
          scorer_config_json,
          started_at
        )
        VALUES (?, 'baseline-v1', 'running', '{}', '{}', '{}', ?)
      `,
      )
      .run(conversationId, Date.now())

    const windowIds = createWindowsForRun(db, Number(run.lastInsertRowid), conversationId, {
      mode: 'comparative-message-count',
      contextMessages: 100,
      focalMessages: 50,
      stride: 50,
      minFocalMessages: 25,
    })

    expect(windowIds).toHaveLength(3)
    expect(
      db
        .prepare(
          `
          SELECT
            ordinal,
            start_ordinal,
            end_ordinal,
            context_start_ordinal,
            context_end_ordinal,
            focal_start_ordinal,
            focal_end_ordinal,
            context_message_count,
            focal_message_count
          FROM windows
          ORDER BY ordinal
        `,
        )
        .all(),
    ).toEqual([
      {
        ordinal: 1,
        start_ordinal: 1,
        end_ordinal: 150,
        context_start_ordinal: 1,
        context_end_ordinal: 100,
        focal_start_ordinal: 101,
        focal_end_ordinal: 150,
        context_message_count: 100,
        focal_message_count: 50,
      },
      {
        ordinal: 2,
        start_ordinal: 51,
        end_ordinal: 200,
        context_start_ordinal: 51,
        context_end_ordinal: 150,
        focal_start_ordinal: 151,
        focal_end_ordinal: 200,
        context_message_count: 100,
        focal_message_count: 50,
      },
      {
        ordinal: 3,
        start_ordinal: 101,
        end_ordinal: 225,
        context_start_ordinal: 101,
        context_end_ordinal: 200,
        focal_start_ordinal: 201,
        focal_end_ordinal: 225,
        context_message_count: 100,
        focal_message_count: 25,
      },
    ])
  })
})
