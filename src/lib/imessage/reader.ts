import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { extractTextFromAttributedBody } from './attributed-body'
import { buildHandleCandidates, normalizeChatDbHandleIdentifier } from './handle-normalization'
import type { IMessageBatch, IMessageChat, IMessageHandle, IMessageMessage } from './types'

export const DEFAULT_CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db')
const APPLE_EPOCH_OFFSET = 978_307_200

type MessageStatus = IMessageMessage['status']

type MessageRow = {
  rowid: number
  guid: string
  chat_id: number
  sender_id: number | null
  sender_identifier: string | null
  sender_service: string | null
  text: string | null
  attributedBody: Buffer | null
  unix_date: number | null
  is_from_me: number
  is_sent: number
  is_delivered: number
  is_read: number
  unix_date_read: number | null
  error: number
  cache_has_attachments: number
  associated_message_type: number
}

function getMessageStatus(
  isFromMe: boolean,
  isSent: boolean,
  isDelivered: boolean,
  isRead: boolean,
  error: number,
): MessageStatus {
  if (error !== 0) return 'failed'
  if (!isFromMe) return isRead ? 'read' : 'delivered'
  if (isRead) return 'read'
  if (isDelivered) return 'delivered'
  if (isSent) return 'sent'
  return 'sending'
}

function isTapbackType(type: number): boolean {
  return type >= 2000 && type <= 3007
}

function getMessageText(text: string | null, attributedBody: Buffer | null): string | null {
  if (text && text.trim() !== '') return text
  const extracted = extractTextFromAttributedBody(attributedBody)
  if (extracted && extracted.trim() !== '') return extracted
  return text
}

export class LocalIMessageReader {
  private readonly db: Database.Database

  constructor(path = DEFAULT_CHAT_DB_PATH) {
    this.db = new Database(path, { readonly: true, fileMustExist: true })
  }

  close(): void {
    this.db.close()
  }

  getMaxMessageRowid(): number {
    const row = this.db.prepare('SELECT MAX(ROWID) AS max_rowid FROM message').get() as
      | { max_rowid: number | null }
      | undefined
    return row?.max_rowid ?? 0
  }

  findDirectChatIdByHandleIdentifier(identifier: string): number | null {
    const candidates = buildHandleCandidates(identifier)
    if (candidates.length === 0) return null

    const row = this.db
      .prepare(
        `
        WITH requested_handles AS (
          SELECT LOWER(value) AS candidate
          FROM json_each(?)
        ),
        candidate_chats AS (
          SELECT
            c.ROWID AS chat_id,
            MAX(m.date) AS last_message_date,
            MAX(m.ROWID) AS last_message_rowid
          FROM chat c
          JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
          JOIN handle h ON h.ROWID = chj.handle_id
          LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
          LEFT JOIN message m ON m.ROWID = cmj.message_id
          WHERE LOWER(h.id) IN (SELECT candidate FROM requested_handles)
            AND NOT EXISTS (
              SELECT 1
              FROM chat_handle_join other
              WHERE other.chat_id = c.ROWID
                AND other.handle_id <> h.ROWID
            )
          GROUP BY c.ROWID
        )
        SELECT chat_id
        FROM candidate_chats
        ORDER BY
          COALESCE(last_message_date, 0) DESC,
          COALESCE(last_message_rowid, 0) DESC,
          chat_id DESC
        LIMIT 1
      `,
      )
      .get(JSON.stringify(candidates)) as { chat_id: number | null } | undefined

    return row?.chat_id ?? null
  }

  buildBatch(lastRowid: number, limit = 500): IMessageBatch {
    const rows = this.db
      .prepare(
        `
        SELECT
          m.ROWID AS rowid,
          m.guid,
          cmj.chat_id,
          CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END AS sender_id,
          h.id AS sender_identifier,
          h.service AS sender_service,
          m.text,
          m.attributedBody,
          CAST(m.date / 1000000000 AS INTEGER) + ${APPLE_EPOCH_OFFSET} AS unix_date,
          m.is_from_me,
          m.is_sent,
          m.is_delivered,
          m.is_read,
          CASE
            WHEN m.date_read IS NULL OR m.date_read = 0 THEN NULL
            ELSE CAST(m.date_read / 1000000000 AS INTEGER) + ${APPLE_EPOCH_OFFSET}
          END AS unix_date_read,
          m.error,
          m.cache_has_attachments,
          m.associated_message_type
        FROM message m
        INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ? AND m.item_type IN (0, 1, 2)
        ORDER BY m.ROWID
        LIMIT ?
      `,
      )
      .all(lastRowid, limit) as MessageRow[]

    if (rows.length === 0) {
      return { cursor: lastRowid, fetchedCount: 0, chats: [], messages: [], handles: [] }
    }

    const messages = this.transformMessages(rows)
    const chatIds = [...new Set(messages.map((message) => message.chatId))]
    const chats = this.getChats(chatIds)
    const handlesMap = new Map<number, IMessageHandle>()
    for (const chat of chats) {
      for (const handle of chat.participants) handlesMap.set(handle.id, handle)
    }
    for (const message of messages) {
      if (message.sender) handlesMap.set(message.sender.id, message.sender)
    }

    return {
      cursor: rows[rows.length - 1]?.rowid ?? lastRowid,
      fetchedCount: rows.length,
      chats,
      messages,
      handles: [...handlesMap.values()],
    }
  }

  private transformMessages(rows: MessageRow[]): IMessageMessage[] {
    return rows
      .filter((row) => !isTapbackType(row.associated_message_type))
      .map((row) => {
        const isFromMe = row.is_from_me === 1
        const isRead = row.is_read === 1
        const sender =
          row.sender_id !== null
            ? {
                id: row.sender_id,
                identifier: normalizeChatDbHandleIdentifier(row.sender_identifier ?? ''),
                service: row.sender_service ?? 'iMessage',
              }
            : null

        return {
          id: row.rowid,
          guid: row.guid,
          chatId: row.chat_id,
          text: getMessageText(row.text, row.attributedBody),
          timestamp: row.unix_date ?? 0,
          isFromMe,
          isRead,
          readAt: row.unix_date_read,
          status: getMessageStatus(
            isFromMe,
            row.is_sent === 1,
            row.is_delivered === 1,
            isRead,
            row.error,
          ),
          errorCode: row.error,
          hasAttachments: row.cache_has_attachments === 1,
          sender,
        }
      })
  }

  private getChats(chatIds: number[]): IMessageChat[] {
    if (chatIds.length === 0) return []

    const jsonChatIds = JSON.stringify(chatIds)
    const chatRows = this.db
      .prepare(
        `
        WITH requested_chats AS (
          SELECT CAST(value AS INTEGER) AS chat_id
          FROM json_each(?)
        ),
        participant_counts AS (
          SELECT chj.chat_id, COUNT(*) AS cnt
          FROM chat_handle_join chj
          WHERE chj.chat_id IN (SELECT chat_id FROM requested_chats)
          GROUP BY chj.chat_id
        )
        SELECT
          c.ROWID AS id,
          c.chat_identifier AS identifier,
          c.display_name AS name,
          COALESCE(pc.cnt, 0) > 1 AS is_group
        FROM chat c
        LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
        WHERE c.ROWID IN (SELECT chat_id FROM requested_chats)
      `,
      )
      .all(jsonChatIds) as Array<{
      id: number
      identifier: string
      name: string | null
      is_group: number
    }>

    const participantRows = this.db
      .prepare(
        `
        SELECT
          chj.chat_id AS chat_id,
          h.ROWID AS id,
          h.id AS identifier,
          h.service AS service
        FROM chat_handle_join chj
        INNER JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id IN (
          SELECT CAST(value AS INTEGER)
          FROM json_each(?)
        )
      `,
      )
      .all(jsonChatIds) as Array<{
      chat_id: number
      id: number
      identifier: string
      service: string
    }>

    const participantsByChatId = new Map<number, IMessageHandle[]>()
    for (const participant of participantRows) {
      const existing = participantsByChatId.get(participant.chat_id) ?? []
      existing.push({
        id: participant.id,
        identifier: normalizeChatDbHandleIdentifier(participant.identifier),
        service: participant.service,
      })
      participantsByChatId.set(participant.chat_id, existing)
    }

    const chatsById = new Map<number, IMessageChat>()
    for (const row of chatRows) {
      chatsById.set(row.id, {
        id: row.id,
        identifier: row.identifier,
        displayName: row.name ?? null,
        isGroup: row.is_group === 1,
        participants: participantsByChatId.get(row.id) ?? [],
      })
    }

    return chatIds
      .map((chatId) => chatsById.get(chatId) ?? null)
      .filter((chat): chat is IMessageChat => Boolean(chat))
  }
}
