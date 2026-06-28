import type { AppDatabase } from '../db/schema'
import { listRuns } from './runs'
import type { ConversationDetail, ConversationSummary } from './types'

type ConversationRow = {
  id: number
  source_chat_id: number
  chat_identifier: string
  display_name: string | null
  is_group: number
  participant_summary: string | null
  participant_count: number
  message_count: number
  first_message_at: number | null
  last_message_at: number | null
}

type ParticipantRow = {
  id: number
  handle_identifier: string
  normalized_handle: string
  service: string
  display_name: string | null
}

function mapConversation(db: AppDatabase, row: ConversationRow): ConversationSummary {
  const runs = listRuns(db, row.id)
  const participantSummary = row.participant_summary ?? ''
  return {
    id: row.id,
    sourceChatId: row.source_chat_id,
    chatIdentifier: row.chat_identifier,
    title: row.display_name || participantSummary || row.chat_identifier,
    isGroup: row.is_group === 1,
    participantSummary,
    participantCount: row.participant_count,
    messageCount: row.message_count,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    latestRun: runs[0] ?? null,
  }
}

function conversationRows(db: AppDatabase, whereSql = '', params: unknown[] = []): ConversationRow[] {
  return db
    .prepare(
      `
      SELECT
        c.id,
        c.source_chat_id,
        c.chat_identifier,
        c.display_name,
        c.is_group,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier)) AS participant_summary,
        COUNT(DISTINCT cp.contact_id) AS participant_count,
        COUNT(DISTINCT m.id) AS message_count,
        MIN(m.sent_at) AS first_message_at,
        MAX(m.sent_at) AS last_message_at
      FROM conversations c
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
      LEFT JOIN contacts ct ON ct.id = cp.contact_id
      LEFT JOIN messages m ON m.conversation_id = c.id
      ${whereSql}
      GROUP BY c.id
      ORDER BY last_message_at DESC, c.id DESC
    `,
    )
    .all(...params) as ConversationRow[]
}

export function listConversations(db: AppDatabase): ConversationSummary[] {
  return conversationRows(db).map((row) => mapConversation(db, row))
}

export function getConversation(db: AppDatabase, conversationId: number): ConversationDetail | null {
  const row = conversationRows(db, 'WHERE c.id = ?', [conversationId])[0]
  if (!row) return null

  const participants = db
    .prepare(
      `
      SELECT
        ct.id,
        ct.handle_identifier,
        ct.normalized_handle,
        ct.service,
        ct.display_name
      FROM conversation_participants cp
      JOIN contacts ct ON ct.id = cp.contact_id
      WHERE cp.conversation_id = ?
      ORDER BY COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier), ct.id
    `,
    )
    .all(conversationId) as ParticipantRow[]

  return {
    ...mapConversation(db, row),
    participants: participants.map((participant) => ({
      id: participant.id,
      handle: participant.handle_identifier,
      handleIdentifier: participant.handle_identifier,
      normalizedHandle: participant.normalized_handle,
      service: participant.service,
      displayName: participant.display_name,
    })),
    runs: listRuns(db, conversationId),
  }
}
