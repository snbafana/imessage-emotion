import type { AppDatabase } from '../db/schema.ts'

export interface AskConversationInput {
  conversationId: number
  runId: number
  windowId: number
  question: string
}

export interface ChatConversation {
  id: number
  title: string
  messageCount: number
  firstMessageAt: number | null
  lastMessageAt: number | null
}

export interface ChatRunSummary {
  id: number
  conversationId: number | null
  methodKey: string | null
  status: string
  summary: Record<string, unknown>
  startedAt: number | null
  completedAt: number | null
}

export interface ChatWindow {
  id: number
  runId: number
  conversationId: number
  ordinal: number | null
  startOrdinal: number
  endOrdinal: number
  contextStartOrdinal: number | null
  contextEndOrdinal: number | null
  focalStartOrdinal: number
  focalEndOrdinal: number
  startMessageId: number | null
  endMessageId: number | null
  messageCount: number
  contextMessageCount: number
  focalMessageCount: number
  metadata: Record<string, unknown>
  result: Record<string, unknown>
  shift: Record<string, unknown>
  status: string | null
}

export interface ChatWindowMessage {
  id: number
  conversationId: number
  ordinal: number
  text: string
  sentAt: number
  isFromMe: boolean
  role: 'context' | 'focal'
}

export interface ConversationChatPacket {
  question: string
  conversation: ChatConversation
  run: ChatRunSummary
  selectedWindow: ChatWindow
  contextMessages: ChatWindowMessage[]
  focalMessages: ChatWindowMessage[]
  neighboringWindows: ChatWindow[]
}

type Row = Record<string, unknown>

export function retrieveConversationContext(
  db: AppDatabase,
  input: AskConversationInput,
): ConversationChatPacket {
  const conversationId = positiveInteger(input.conversationId, 'conversationId')
  const runId = positiveInteger(input.runId, 'runId')
  const windowId = positiveInteger(input.windowId, 'windowId')
  const question = input.question.trim()
  if (!question) throw new Error('Question is required')

  const conversation = getConversation(db, conversationId)
  const run = getRunSummary(db, runId)
  if (run.conversationId !== null && run.conversationId !== conversationId) {
    throw new Error(`Run ${runId} does not belong to conversation ${conversationId}`)
  }

  const windows = listRunWindows(db, runId, conversationId)
  if (windows.length === 0) {
    throw new Error(`Run ${runId} has no windows for conversation ${conversationId}`)
  }

  const selectedIndex = windows.findIndex((window) => window.id === windowId)
  if (selectedIndex < 0) {
    throw new Error(`Window ${windowId} does not belong to run ${runId} and conversation ${conversationId}`)
  }

  const selectedWindow = windows[selectedIndex]
  const contextMessages =
    selectedWindow.contextStartOrdinal === null || selectedWindow.contextEndOrdinal === null
      ? []
      : getMessages(
          db,
          conversationId,
          selectedWindow.contextStartOrdinal,
          selectedWindow.contextEndOrdinal,
          'context',
        )
  const focalMessages = getMessages(
    db,
    conversationId,
    selectedWindow.focalStartOrdinal,
    selectedWindow.focalEndOrdinal,
    'focal',
  )

  return {
    question,
    conversation,
    run,
    selectedWindow,
    contextMessages,
    focalMessages,
    neighboringWindows: [windows[selectedIndex - 1], windows[selectedIndex + 1]].filter(
      (window): window is ChatWindow => Boolean(window),
    ),
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function getConversation(db: AppDatabase, conversationId: number): ChatConversation {
  const row = db
    .prepare(
      `
      SELECT id, display_name, chat_identifier, message_count, first_message_at, last_message_at
      FROM conversations
      WHERE id = ?
    `,
    )
    .get(conversationId) as Row | undefined
  if (!row) throw new Error(`Conversation ${conversationId} was not found`)

  return {
    id: numberValue(row.id),
    title: stringValue(row.display_name) ?? stringValue(row.chat_identifier) ?? `Conversation ${row.id}`,
    messageCount: numberValue(row.message_count, 0),
    firstMessageAt: numberOrNull(row.first_message_at),
    lastMessageAt: numberOrNull(row.last_message_at),
  }
}

function getRunSummary(db: AppDatabase, runId: number): ChatRunSummary {
  const row = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId) as Row | undefined
  if (!row) throw new Error(`Analysis run ${runId} was not found`)

  const scorer = getLegacyScorer(db, numberOrNull(row.scorer_config_id))
  return {
    id: numberValue(row.id),
    conversationId: numberOrNull(row.conversation_id),
    methodKey: stringValue(row.method_key) ?? scorer?.key ?? null,
    status: stringValue(row.status) ?? 'unknown',
    summary: jsonObject(row.summary_json) ?? {},
    startedAt: numberOrNull(row.started_at),
    completedAt: numberOrNull(row.completed_at),
  }
}

function listRunWindows(db: AppDatabase, runId: number, conversationId: number): ChatWindow[] {
  const windowColumns = columnsFor(db, 'windows')
  const hasRunOwnedWindows = windowColumns.has('run_id')
  if (hasRunOwnedWindows) {
    const order = windowColumns.has('ordinal') ? 'ordinal, id' : 'start_ordinal, id'
    const rows = db
      .prepare(
        `
        SELECT *
        FROM windows
        WHERE run_id = ? AND conversation_id = ?
        ORDER BY ${order}
      `,
      )
      .all(runId, conversationId) as Row[]
    return rows.map((row) => windowFromRow(db, row, runId, conversationId))
  }

  const hasWindowResults = tableExists(db, 'window_results')
  const resultJoin = hasWindowResults
    ? 'LEFT JOIN window_results wr ON wr.run_id = rw.run_id AND wr.window_id = w.id'
    : ''
  const resultSelect = hasWindowResults ? ', wr.result_json AS joined_result_json' : ''
  const rows = db
    .prepare(
      `
      SELECT w.*, rw.status AS run_window_status${resultSelect}
      FROM run_windows rw
      JOIN windows w ON w.id = rw.window_id
      ${resultJoin}
      WHERE rw.run_id = ? AND w.conversation_id = ?
      ORDER BY w.start_ordinal, w.id
    `,
    )
    .all(runId, conversationId) as Row[]
  return rows.map((row, index) => windowFromRow(db, row, runId, conversationId, index + 1))
}

function windowFromRow(
  db: AppDatabase,
  row: Row,
  runId: number,
  conversationId: number,
  fallbackOrdinal: number | null = null,
): ChatWindow {
  const startOrdinal = numberValue(row.start_ordinal)
  const endOrdinal = numberValue(row.end_ordinal)
  const contextStartOrdinal = numberOrNull(row.context_start_ordinal)
  const contextEndOrdinal = numberOrNull(row.context_end_ordinal)
  const focalStartOrdinal = numberOrNull(row.focal_start_ordinal) ?? startOrdinal
  const focalEndOrdinal = numberOrNull(row.focal_end_ordinal) ?? endOrdinal
  const result = jsonObject(row.result_json) ?? jsonObject(row.joined_result_json) ?? {}
  const shift =
    jsonObject(row.shift_json) ??
    getLegacyShift(db, runId, conversationId, numberValue(row.id)) ??
    {}

  return {
    id: numberValue(row.id),
    runId: numberOrNull(row.run_id) ?? runId,
    conversationId: numberOrNull(row.conversation_id) ?? conversationId,
    ordinal: numberOrNull(row.ordinal) ?? fallbackOrdinal,
    startOrdinal,
    endOrdinal,
    contextStartOrdinal,
    contextEndOrdinal,
    focalStartOrdinal,
    focalEndOrdinal,
    startMessageId: numberOrNull(row.start_message_id),
    endMessageId: numberOrNull(row.end_message_id),
    messageCount: numberValue(row.message_count, endOrdinal - startOrdinal + 1),
    contextMessageCount:
      numberOrNull(row.context_message_count) ?? rangeCount(contextStartOrdinal, contextEndOrdinal),
    focalMessageCount:
      numberOrNull(row.focal_message_count) ?? rangeCount(focalStartOrdinal, focalEndOrdinal),
    metadata: jsonObject(row.window_metadata_json) ?? legacyWindowMetadata(row),
    result,
    shift,
    status: stringValue(row.status) ?? stringValue(row.run_window_status),
  }
}

function getMessages(
  db: AppDatabase,
  conversationId: number,
  startOrdinal: number,
  endOrdinal: number,
  role: 'context' | 'focal',
): ChatWindowMessage[] {
  return db
    .prepare(
      `
      SELECT id, conversation_id, conversation_ordinal, text, sent_at, is_from_me
      FROM messages
      WHERE conversation_id = ?
        AND conversation_ordinal BETWEEN ? AND ?
      ORDER BY conversation_ordinal
    `,
    )
    .all(conversationId, startOrdinal, endOrdinal)
    .map((row) => {
      const message = row as Row
      return {
        id: numberValue(message.id),
        conversationId: numberValue(message.conversation_id),
        ordinal: numberValue(message.conversation_ordinal),
        text: stringValue(message.text) ?? '',
        sentAt: numberValue(message.sent_at),
        isFromMe: numberValue(message.is_from_me, 0) === 1,
        role,
      }
    })
}

function getLegacyScorer(
  db: AppDatabase,
  scorerConfigId: number | null,
): { key: string; label: string } | null {
  if (scorerConfigId === null || !tableExists(db, 'scorer_configs')) return null
  const row = db
    .prepare('SELECT key, label FROM scorer_configs WHERE id = ?')
    .get(scorerConfigId) as Row | undefined
  if (!row) return null
  return {
    key: stringValue(row.key) ?? '',
    label: stringValue(row.label) ?? '',
  }
}

function getLegacyShift(
  db: AppDatabase,
  runId: number,
  conversationId: number,
  windowId: number,
): Record<string, unknown> | null {
  if (!tableExists(db, 'shifts')) return null
  const row = db
    .prepare(
      `
      SELECT result_json
      FROM shifts
      WHERE run_id = ? AND conversation_id = ? AND to_window_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get(runId, conversationId, windowId) as Row | undefined
  return jsonObject(row?.result_json)
}

function legacyWindowMetadata(row: Row): Record<string, unknown> {
  return {
    deterministicKey: stringValue(row.deterministic_key) ?? null,
    windowConfigId: numberOrNull(row.window_config_id),
    startAt: numberOrNull(row.start_at),
    endAt: numberOrNull(row.end_at),
  }
}

function columnsFor(db: AppDatabase, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${checkedIdentifier(table)})`)
      .all()
      .map((row) => stringValue((row as Row).name))
      .filter((name): name is string => name !== null),
  )
}

function tableExists(db: AppDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return Boolean(row)
}

function checkedIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`)
  }
  return identifier
}

function rangeCount(start: number | null, end: number | null): number {
  if (start === null || end === null || end < start) return 0
  return end - start + 1
}

function numberValue(value: unknown, fallback?: number): number {
  const number = numberOrNull(value)
  if (number !== null) return number
  if (fallback !== undefined) return fallback
  throw new Error(`Expected number, received ${String(value)}`)
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return { raw: value }
  }
}
