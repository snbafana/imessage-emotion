import type { AppDatabase } from '../db/schema'
import { normalizeHandleForStorage } from '../imessage/handle-normalization'
import type { IMessageBatch, IMessageChat, IMessageHandle, IMessageMessage } from '../imessage/types'

const IMPORT_SOURCE = 'imessage'
const TEMPORARY_ORDINAL_OFFSET = 1_000_000_000_000

interface ImportResult {
  fetchedCount: number
  importedMessages: number
  cursor: number
  affectedConversationIds: number[]
}

function now(): number {
  return Date.now()
}

function toMilliseconds(seconds: number): number {
  return seconds * 1000
}

function upsertContact(db: AppDatabase, handle: IMessageHandle): number {
  const identifier = handle.identifier.trim()
  const normalized = normalizeHandleForStorage(identifier)
  const service = handle.service || 'iMessage'
  db.prepare(
    `
    INSERT INTO contacts (handle_identifier, normalized_handle, service, display_name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(normalized_handle, service) DO UPDATE SET
      handle_identifier = excluded.handle_identifier,
      normalized_handle = excluded.normalized_handle,
      service = excluded.service,
      updated_at = excluded.updated_at
  `,
  ).run(identifier, normalized, service, identifier, now())

  const row = db
    .prepare('SELECT id FROM contacts WHERE normalized_handle = ? AND service = ?')
    .get(normalized, service) as { id: number } | undefined
  if (!row) throw new Error('contact upsert did not produce a row')
  return row.id
}

function upsertConversation(db: AppDatabase, chat: IMessageChat): number {
  db.prepare(
    `
    INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_chat_id) DO UPDATE SET
      chat_identifier = excluded.chat_identifier,
      display_name = excluded.display_name,
      is_group = excluded.is_group,
      updated_at = excluded.updated_at
  `,
  ).run(chat.id, chat.identifier, chat.displayName, chat.isGroup ? 1 : 0, now())

  const row = db
    .prepare('SELECT id FROM conversations WHERE source_chat_id = ?')
    .get(chat.id) as { id: number } | undefined
  if (!row) throw new Error('conversation upsert did not produce a row')
  const conversationId = row.id

  for (const participant of chat.participants) {
    const contactId = upsertContact(db, participant)
    db.prepare(
      `
      INSERT OR IGNORE INTO conversation_participants (conversation_id, contact_id)
      VALUES (?, ?)
    `,
    ).run(conversationId, contactId)
  }

  return conversationId
}

function contactIdForSender(db: AppDatabase, sender: IMessageHandle | null): number | null {
  if (!sender) return null
  return upsertContact(db, sender)
}

function insertMessage(db: AppDatabase, message: IMessageMessage, conversationId: number): boolean {
  const senderContactId = contactIdForSender(db, message.sender)
  const result = db
    .prepare(
      `
      INSERT INTO messages (
        conversation_id,
        conversation_ordinal,
        source_rowid,
        guid,
        sender_contact_id,
        text,
        sent_at,
        is_from_me,
        is_read,
        read_at,
        status,
        error_code,
        has_attachments,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guid) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        source_rowid = excluded.source_rowid,
        sender_contact_id = excluded.sender_contact_id,
        text = excluded.text,
        sent_at = excluded.sent_at,
        is_from_me = excluded.is_from_me,
        is_read = excluded.is_read,
        read_at = excluded.read_at,
        status = excluded.status,
        error_code = excluded.error_code,
        has_attachments = excluded.has_attachments,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      conversationId,
      -Math.abs(message.id),
      message.id,
      message.guid,
      senderContactId,
      message.text,
      toMilliseconds(message.timestamp),
      message.isFromMe ? 1 : 0,
      message.isRead ? 1 : 0,
      message.readAt != null ? toMilliseconds(message.readAt) : null,
      message.status,
      message.errorCode,
      message.hasAttachments ? 1 : 0,
      now(),
    )
  return result.changes > 0
}

export function recomputeConversationOrdinals(db: AppDatabase, conversationId: number): void {
  const rows = db
    .prepare(
      `
      SELECT id
      FROM messages
      WHERE conversation_id = ?
      ORDER BY sent_at ASC, source_rowid ASC, guid ASC
    `,
    )
    .all(conversationId) as Array<{ id: number }>

  const clearOrdinal = db.prepare(
    `
    UPDATE messages
    SET conversation_ordinal = -(id + ?), updated_at = ?
    WHERE conversation_id = ?
  `,
  )
  clearOrdinal.run(TEMPORARY_ORDINAL_OFFSET, now(), conversationId)

  const assign = db.prepare(
    `
    UPDATE messages
    SET conversation_ordinal = ?, updated_at = ?
    WHERE id = ?
  `,
  )
  for (const [index, row] of rows.entries()) {
    assign.run(index + 1, now(), row.id)
  }

  const summary = db
    .prepare(
      `
      SELECT COUNT(*) AS message_count, MIN(sent_at) AS first_message_at, MAX(sent_at) AS last_message_at
      FROM messages
      WHERE conversation_id = ?
    `,
    )
    .get(conversationId) as {
    message_count: number
    first_message_at: number | null
    last_message_at: number | null
  }

  db.prepare(
    `
    UPDATE conversations
    SET message_count = ?, first_message_at = ?, last_message_at = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(
    summary.message_count,
    summary.first_message_at,
    summary.last_message_at,
    now(),
    conversationId,
  )
}

export function importBatch(db: AppDatabase, batch: IMessageBatch): ImportResult {
  return db.transaction(() => {
    const conversationsBySourceId = new Map<number, number>()
    for (const chat of batch.chats) {
      conversationsBySourceId.set(chat.id, upsertConversation(db, chat))
    }

    for (const handle of batch.handles) {
      upsertContact(db, handle)
    }

    let importedMessages = 0
    const affectedConversationIds = new Set<number>()
    for (const message of batch.messages) {
      const conversationId =
        conversationsBySourceId.get(message.chatId) ??
        upsertConversation(db, {
          id: message.chatId,
          identifier: String(message.chatId),
          displayName: null,
          isGroup: false,
          participants: [],
        })
      if (insertMessage(db, message, conversationId)) importedMessages += 1
      affectedConversationIds.add(conversationId)
    }

    for (const conversationId of affectedConversationIds) {
      recomputeConversationOrdinals(db, conversationId)
    }

    db.prepare(
      `
      INSERT INTO import_state (source, last_rowid, last_imported_at, last_error, updated_at)
      VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_rowid = excluded.last_rowid,
        last_imported_at = excluded.last_imported_at,
        last_error = NULL,
        updated_at = excluded.updated_at
    `,
    ).run(IMPORT_SOURCE, batch.cursor, now(), now())

    return {
      fetchedCount: batch.fetchedCount,
      importedMessages,
      cursor: batch.cursor,
      affectedConversationIds: [...affectedConversationIds],
    }
  })()
}

export function getLastImportedRowid(db: AppDatabase): number {
  const row = db
    .prepare('SELECT last_rowid FROM import_state WHERE source = ?')
    .get(IMPORT_SOURCE) as { last_rowid: number } | undefined
  return row?.last_rowid ?? 0
}

export function recordImportError(db: AppDatabase, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  db.prepare(
    `
    INSERT INTO import_state (source, last_rowid, last_error, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `,
  ).run(IMPORT_SOURCE, getLastImportedRowid(db), message, now())
}
