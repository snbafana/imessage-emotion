import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import { importBatch } from '../import/import-messages'
import type { IMessageBatch } from '../imessage/types'
import { syncContactRecords } from '../contacts/sync-contacts'
import { createBaselineRun } from '../emotion/run-baseline'

function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function syntheticBatch(messageCount: number): IMessageBatch {
  return {
    cursor: messageCount,
    fetchedCount: messageCount,
    handles: [{ id: 1, identifier: '+14155550123', service: 'iMessage' }],
    chats: [
      {
        id: 10,
        identifier: 'chat-10',
        displayName: null,
        isGroup: false,
        participants: [{ id: 1, identifier: '+14155550123', service: 'iMessage' }],
      },
    ],
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: index + 1,
      guid: `guid-${index + 1}`,
      chatId: 10,
      text: `synthetic ${index + 1}`,
      timestamp: index + 1,
      isFromMe: index % 2 === 0,
      isRead: false,
      readAt: null,
      status: 'delivered',
      errorCode: 0,
      hasAttachments: false,
      sender:
        index % 2 === 0 ? null : { id: 1, identifier: '+14155550123', service: 'iMessage' },
    })),
  }
}

describe('data foundation integration', () => {
  it('imports messages, resolves contacts, builds run-owned windows, and scores a baseline run', () => {
    const db = createMemoryDb()

    const importResult = importBatch(db, syntheticBatch(150))
    expect(importResult.importedMessages).toBe(150)

    const contactResult = syncContactRecords(db, [
      {
        sourceId: 'card-1',
        displayName: 'Synthetic Contact',
        company: 'Synthetic Co',
        avatarUrl: null,
        phoneNumbers: ['(415) 555-0123'],
        emails: [],
      },
    ])
    expect(contactResult).toEqual({ scannedContacts: 1, resolvedHandles: 1 })

    const conversation = db.prepare('SELECT id, message_count FROM conversations').get() as {
      id: number
      message_count: number
    }
    expect(conversation.message_count).toBe(150)

    const contact = db
      .prepare('SELECT display_name, source_contact_id FROM contacts WHERE normalized_handle = ?')
      .get('+14155550123')
    expect(contact).toEqual({ display_name: 'Synthetic Contact', source_contact_id: 'card-1' })

    const run = createBaselineRun(db, conversation.id)
    expect(run.windowCount).toBe(1)

    const windows = db
      .prepare(
        `
        SELECT
          run_id,
          start_ordinal,
          end_ordinal,
          context_start_ordinal,
          context_end_ordinal,
          focal_start_ordinal,
          focal_end_ordinal,
          result_json
        FROM windows
        ORDER BY ordinal
      `,
      )
      .all()
    expect(windows).toEqual([
      {
        run_id: run.runId,
        start_ordinal: 1,
        end_ordinal: 150,
        context_start_ordinal: 1,
        context_end_ordinal: 100,
        focal_start_ordinal: 101,
        focal_end_ordinal: 150,
        result_json: expect.stringContaining('"scores"'),
      },
    ])

    const analysisRun = db
      .prepare('SELECT status, summary_json FROM analysis_runs WHERE id = ?')
      .get(run.runId) as { status: string; summary_json: string }
    expect(analysisRun.status).toBe('completed')
    expect(JSON.parse(analysisRun.summary_json).windowCount).toBe(1)
  })
})
