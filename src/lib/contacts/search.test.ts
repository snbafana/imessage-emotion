import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, type AppDatabase } from '../db/schema'
import { buildContactMatchQuery, searchContacts } from './search'

function memoryDb(): AppDatabase {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

interface SeedContact {
  id: number
  handle: string
  normalized?: string
  displayName?: string | null
  company?: string | null
}

function insertContact(db: AppDatabase, contact: SeedContact): void {
  db.prepare(
    `INSERT INTO contacts (id, handle_identifier, normalized_handle, service, display_name, company)
     VALUES (?, ?, ?, 'iMessage', ?, ?)`,
  ).run(
    contact.id,
    contact.handle,
    contact.normalized ?? contact.handle,
    contact.displayName ?? null,
    contact.company ?? null,
  )
}

function insertConversation(db: AppDatabase, id: number): void {
  db.prepare(
    `INSERT INTO conversations (id, source_chat_id, chat_identifier, is_group)
     VALUES (?, ?, ?, 0)`,
  ).run(id, id, `chat-${id}`)
}

function linkParticipant(db: AppDatabase, conversationId: number, contactId: number): void {
  db.prepare(
    `INSERT INTO conversation_participants (conversation_id, contact_id) VALUES (?, ?)`,
  ).run(conversationId, contactId)
}

describe('buildContactMatchQuery', () => {
  it('returns null when there is nothing to search', () => {
    expect(buildContactMatchQuery('')).toBeNull()
    expect(buildContactMatchQuery('   ')).toBeNull()
  })

  it('builds AND-ed prefix terms from each token', () => {
    expect(buildContactMatchQuery('jo do')).toBe('"jo"* "do"*')
  })

  it('strips FTS operator characters so user input cannot break the query', () => {
    expect(buildContactMatchQuery('jo*hn "doe"')).toBe('"john"* "doe"*')
  })
})

describe('searchContacts', () => {
  let db: AppDatabase

  beforeEach(() => {
    db = memoryDb()
    insertContact(db, { id: 1, handle: '+14155550123', displayName: 'John Doe', company: 'Acme' })
    insertContact(db, { id: 2, handle: 'jane@example.com', displayName: 'Jane Smith', company: 'Globex' })
    insertContact(db, { id: 3, handle: '+14155559999', displayName: null, company: null })
    insertConversation(db, 10)
    insertConversation(db, 11)
    linkParticipant(db, 10, 1)
    linkParticipant(db, 11, 1)
    linkParticipant(db, 11, 2)
  })

  it('returns nothing for an empty query', () => {
    expect(searchContacts(db, '   ')).toEqual([])
  })

  it('matches on a display-name prefix and returns the contact conversations', () => {
    const hits = searchContacts(db, 'jo')
    expect(hits).toHaveLength(1)
    expect(hits[0].contactId).toBe(1)
    expect(hits[0].displayName).toBe('John Doe')
    expect(hits[0].conversationIds.sort()).toEqual([10, 11])
  })

  it('matches on company and on handle', () => {
    expect(searchContacts(db, 'globex').map((hit) => hit.contactId)).toEqual([2])
    expect(searchContacts(db, 'jane@example').map((hit) => hit.contactId)).toEqual([2])
  })

  it('keeps the index in sync when a contact is updated', () => {
    expect(searchContacts(db, 'john')).toHaveLength(1)
    db.prepare(`UPDATE contacts SET display_name = ? WHERE id = 1`).run('Jonathan Roe')
    expect(searchContacts(db, 'john')).toHaveLength(0)
    expect(searchContacts(db, 'jonathan').map((hit) => hit.contactId)).toEqual([1])
  })

  it('drops a contact from the index when it is deleted', () => {
    expect(searchContacts(db, 'jane')).toHaveLength(1)
    db.prepare(`DELETE FROM contacts WHERE id = 2`).run()
    expect(searchContacts(db, 'jane')).toHaveLength(0)
  })

  it("backfills pre-existing contacts when the index is (re)created", () => {
    // Simulate the upgrade path: contacts exist but the FTS table does not yet.
    db.exec(`
      DROP TRIGGER contacts_fts_ai;
      DROP TRIGGER contacts_fts_au;
      DROP TRIGGER contacts_fts_ad;
      DROP TABLE contacts_fts;
    `)
    insertContact(db, { id: 4, handle: '+14155551111', displayName: 'Backfill Person' })
    // No FTS table/triggers, so the new row is not indexed yet.
    migrate(db) // recreates contacts_fts and runs 'rebuild'
    expect(searchContacts(db, 'backfill').map((hit) => hit.contactId)).toEqual([4])
  })
})
