import type { AppDatabase } from '../db/schema'
import { normalizeHandleForStorage } from '../imessage/handle-normalization'
import { loadLocalContacts, type ContactRecord } from './reader'

export interface ContactsSyncResult {
  scannedContacts: number
  resolvedHandles: number
}

type ContactHandle = {
  value: string
  service: string
}

function now(): number {
  return Date.now()
}

function handlesForContact(contact: ContactRecord): ContactHandle[] {
  return [
    ...contact.phoneNumbers.map((value) => ({ value, service: 'iMessage' })),
    ...contact.emails.map((value) => ({ value, service: 'iMessage' })),
  ]
}

export function syncContactRecords(db: AppDatabase, records: ContactRecord[]): ContactsSyncResult {
  return db.transaction(() => {
    const upsert = db.prepare(
      `
      INSERT INTO contacts (
        handle_identifier,
        normalized_handle,
        service,
        display_name,
        company,
        avatar_url,
        source_contact_id,
        resolved_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_handle, service) DO UPDATE SET
        display_name = excluded.display_name,
        company = excluded.company,
        avatar_url = excluded.avatar_url,
        source_contact_id = excluded.source_contact_id,
        resolved_at = excluded.resolved_at,
        updated_at = excluded.updated_at
    `,
    )

    let resolvedHandles = 0
    for (const record of records) {
      for (const handle of handlesForContact(record)) {
        const identifier = handle.value.trim()
        if (!identifier) continue
        upsert.run(
          identifier,
          normalizeHandleForStorage(identifier),
          handle.service,
          record.displayName,
          record.company,
          record.avatarUrl,
          record.sourceId,
          now(),
          now(),
        )
        resolvedHandles += 1
      }
    }

    return {
      scannedContacts: records.length,
      resolvedHandles,
    }
  })()
}

export function syncLocalContacts(db: AppDatabase): ContactsSyncResult {
  return syncContactRecords(db, loadLocalContacts())
}
