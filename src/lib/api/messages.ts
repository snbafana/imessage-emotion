import type { AppDatabase } from '../db/schema'
import type { WindowMessage, WindowMessageSlice } from './types'

type MessageRow = {
  id: number
  conversation_id: number
  conversation_ordinal: number
  source_rowid: number
  guid: string
  sender_contact_id: number | null
  sender_name: string | null
  text: string | null
  sent_at: number
  is_from_me: number
  is_read: number
  has_attachments: number
  status: string
}

type WindowBoundary = {
  id: number
  conversation_id: number
  start_ordinal: number
  end_ordinal: number
  context_start_ordinal: number | null
  context_end_ordinal: number | null
  focal_start_ordinal: number
  focal_end_ordinal: number
}

function getWindowBoundary(db: AppDatabase, windowId: number): WindowBoundary | null {
  return (
    (db
      .prepare(
        `
        SELECT
          id,
          conversation_id,
          start_ordinal,
          end_ordinal,
          context_start_ordinal,
          context_end_ordinal,
          focal_start_ordinal,
          focal_end_ordinal
        FROM windows
        WHERE id = ?
      `,
      )
      .get(windowId) as WindowBoundary | undefined) ?? null
  )
}

function ordinalRange(
  slice: WindowMessageSlice,
  window: WindowBoundary,
): { start: number; end: number } | null {
  if (slice === 'all' || slice === 'full') {
    return { start: window.start_ordinal, end: window.end_ordinal }
  }
  if (slice === 'context') {
    if (window.context_start_ordinal === null || window.context_end_ordinal === null) return null
    return { start: window.context_start_ordinal, end: window.context_end_ordinal }
  }
  return { start: window.focal_start_ordinal, end: window.focal_end_ordinal }
}

export function getWindowMessages(
  db: AppDatabase,
  windowId: number,
  slice: WindowMessageSlice = 'all',
): WindowMessage[] {
  const window = getWindowBoundary(db, windowId)
  if (!window) throw new Error(`Missing window ${windowId}`)

  const range = ordinalRange(slice, window)
  if (!range) return []

  const rows = db
    .prepare(
      `
      SELECT
        m.id,
        m.conversation_id,
        m.conversation_ordinal,
        m.source_rowid,
        m.guid,
        m.sender_contact_id,
        COALESCE(NULLIF(c.display_name, ''), c.handle_identifier) AS sender_name,
        m.text,
        m.sent_at,
        m.is_from_me,
        m.is_read,
        m.has_attachments,
        m.status
      FROM messages m
      LEFT JOIN contacts c ON c.id = m.sender_contact_id
      WHERE
        m.conversation_id = ?
        AND m.conversation_ordinal BETWEEN ? AND ?
      ORDER BY m.conversation_ordinal, m.sent_at, m.source_rowid, m.guid
    `,
    )
    .all(window.conversation_id, range.start, range.end) as MessageRow[]

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    conversationOrdinal: row.conversation_ordinal,
    sourceRowid: row.source_rowid,
    guid: row.guid,
    senderContactId: row.sender_contact_id,
    senderName: row.sender_name,
    text: row.text,
    sentAt: row.sent_at,
    isFromMe: row.is_from_me === 1,
    isRead: row.is_read === 1,
    hasAttachments: row.has_attachments === 1,
    status: row.status,
    slice,
  }))
}
