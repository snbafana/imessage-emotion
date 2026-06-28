import type { AppDatabase } from '../db/schema'
import type { ContactSearchHit } from '../api/types'

const DEFAULT_LIMIT = 50

// Turn free-text from the search box into an FTS5 prefix-match query: each
// whitespace-separated token becomes a quoted prefix term (`"jo"*`), AND-ed
// together so "jo do" matches "John Doe". Quoting neutralizes FTS5 operator
// characters in user input. Returns null when there is nothing to search for.
export function buildContactMatchQuery(rawQuery: string): string | null {
  const tokens = rawQuery
    .split(/\s+/)
    .map((token) => token.replace(/["*]/g, '').trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token}"*`).join(' ')
}

interface ContactHitRow {
  contact_id: number
  display_name: string | null
  handle_identifier: string
  company: string | null
  conversation_ids: string | null
  score: number
}

// Rank contacts against the query with FTS5 (bm25, lower is better) and attach
// the conversation ids each matched contact participates in, so callers can
// filter the conversation list down to the matching people.
export function searchContacts(
  db: AppDatabase,
  rawQuery: string,
  limit = DEFAULT_LIMIT,
): ContactSearchHit[] {
  const match = buildContactMatchQuery(rawQuery)
  if (!match) return []

  const rows = db
    .prepare(
      `
      SELECT
        c.id AS contact_id,
        c.display_name,
        c.handle_identifier,
        c.company,
        (
          SELECT GROUP_CONCAT(cp.conversation_id)
          FROM conversation_participants cp
          WHERE cp.contact_id = c.id
        ) AS conversation_ids,
        bm25(contacts_fts) AS score
      FROM contacts_fts
      JOIN contacts c ON c.id = contacts_fts.rowid
      WHERE contacts_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `,
    )
    .all(match, limit) as ContactHitRow[]

  return rows.map((row) => ({
    contactId: row.contact_id,
    displayName: row.display_name,
    handleIdentifier: row.handle_identifier,
    company: row.company,
    conversationIds: parseIdList(row.conversation_ids),
    score: row.score,
  }))
}

function parseIdList(value: string | null): number[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => Number(part))
    .filter((id) => Number.isFinite(id))
}
