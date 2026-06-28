import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import type { IMessageBatch } from '../imessage/types'
import { importBatch } from './import-messages'

function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('message import', () => {
  it('assigns per-conversation ordinals by normalized chronological order', () => {
    const db = createMemoryDb()
    const batch: IMessageBatch = {
      cursor: 3,
      fetchedCount: 3,
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
      messages: [
        {
          id: 3,
          guid: 'guid-c',
          chatId: 10,
          text: 'synthetic later',
          timestamp: 30,
          isFromMe: false,
          isRead: false,
          readAt: null,
          status: 'delivered',
          errorCode: 0,
          hasAttachments: false,
          sender: { id: 1, identifier: '+14155550123', service: 'iMessage' },
        },
        {
          id: 1,
          guid: 'guid-a',
          chatId: 10,
          text: 'synthetic earlier',
          timestamp: 10,
          isFromMe: true,
          isRead: true,
          readAt: null,
          status: 'read',
          errorCode: 0,
          hasAttachments: false,
          sender: null,
        },
        {
          id: 2,
          guid: 'guid-b',
          chatId: 10,
          text: 'synthetic tie',
          timestamp: 10,
          isFromMe: false,
          isRead: false,
          readAt: null,
          status: 'delivered',
          errorCode: 0,
          hasAttachments: false,
          sender: { id: 1, identifier: '+14155550123', service: 'iMessage' },
        },
      ],
    }

    importBatch(db, batch)

    const rows = db
      .prepare(
        `
        SELECT guid, conversation_ordinal
        FROM messages
        ORDER BY conversation_ordinal
      `,
      )
      .all()
    expect(rows).toEqual([
      { guid: 'guid-a', conversation_ordinal: 1 },
      { guid: 'guid-b', conversation_ordinal: 2 },
      { guid: 'guid-c', conversation_ordinal: 3 },
    ])

    expect(() =>
      db
        .prepare(
          `
          INSERT INTO messages (
            conversation_id,
            conversation_ordinal,
            source_rowid,
            guid,
            sent_at,
            is_from_me,
            is_read,
            status
          )
          VALUES (1, 1, 99, 'duplicate-ordinal', 99, 0, 0, 'delivered')
        `,
        )
        .run(),
    ).toThrow()
  })
})
