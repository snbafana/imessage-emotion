import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import { syncContactRecords } from './sync-contacts'

function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('contact resolution', () => {
  it('resolves normalized iMessage handles with local contact card fields', () => {
    const db = createMemoryDb()
    db.prepare(
      `
      INSERT INTO contacts (handle_identifier, normalized_handle, service, display_name)
      VALUES ('+14155550123', '+14155550123', 'iMessage', '+14155550123')
    `,
    ).run()

    const result = syncContactRecords(db, [
      {
        sourceId: 'card-1',
        displayName: 'Ava Chen',
        company: 'Example Co',
        avatarUrl: 'file:///avatar.png',
        phoneNumbers: ['(415) 555-0123'],
        emails: ['ava@example.com'],
      },
    ])

    expect(result).toEqual({ scannedContacts: 1, resolvedHandles: 2 })
    const rows = db
      .prepare(
        `
        SELECT normalized_handle, display_name, company, avatar_url, source_contact_id
        FROM contacts
        ORDER BY normalized_handle
      `,
      )
      .all()
    expect(rows).toEqual([
      {
        normalized_handle: '+14155550123',
        display_name: 'Ava Chen',
        company: 'Example Co',
        avatar_url: 'file:///avatar.png',
        source_contact_id: 'card-1',
      },
      {
        normalized_handle: 'ava@example.com',
        display_name: 'Ava Chen',
        company: 'Example Co',
        avatar_url: 'file:///avatar.png',
        source_contact_id: 'card-1',
      },
    ])
  })
})
