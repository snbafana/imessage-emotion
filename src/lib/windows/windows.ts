import type { AppDatabase } from '../db/schema'

export interface WindowConfigInput {
  name: string
  messageCount: number
  stride: number
  minTailMessages: number
}

export interface WindowRange {
  startOrdinal: number
  endOrdinal: number
}

type MessageBoundary = {
  id: number
  sent_at: number
}

export function upsertWindowConfig(db: AppDatabase, input: WindowConfigInput): number {
  db.prepare(
    `
    INSERT INTO window_configs (name, message_count, stride, min_tail_messages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      message_count = excluded.message_count,
      stride = excluded.stride,
      min_tail_messages = excluded.min_tail_messages
  `,
  ).run(input.name, input.messageCount, input.stride, input.minTailMessages)

  const row = db
    .prepare('SELECT id FROM window_configs WHERE name = ?')
    .get(input.name) as { id: number }
  return row.id
}

export function planWindowRanges(
  lastOrdinal: number,
  messageCount: number,
  stride: number,
  minTailMessages: number,
): WindowRange[] {
  if (lastOrdinal < minTailMessages) return []

  const ranges: WindowRange[] = []
  for (let start = 1; start <= lastOrdinal; start += stride) {
    const fullEnd = start + messageCount - 1
    if (fullEnd <= lastOrdinal) {
      ranges.push({ startOrdinal: start, endOrdinal: fullEnd })
      continue
    }

    const tailCount = lastOrdinal - start + 1
    const previousRange = ranges[ranges.length - 1]
    if (tailCount >= minTailMessages && previousRange?.endOrdinal !== lastOrdinal) {
      ranges.push({ startOrdinal: start, endOrdinal: lastOrdinal })
    }
    break
  }
  return ranges
}

export function ensureWindowsForConversation(
  db: AppDatabase,
  conversationId: number,
  windowConfigId: number,
): number[] {
  return db.transaction(() => {
    const config = db
      .prepare(
        `
        SELECT message_count, stride, min_tail_messages
        FROM window_configs
        WHERE id = ?
      `,
      )
      .get(windowConfigId) as
      | { message_count: number; stride: number; min_tail_messages: number }
      | undefined
    if (!config) throw new Error(`Missing window config ${windowConfigId}`)

    const last = db
      .prepare(
        `
        SELECT MAX(conversation_ordinal) AS last_ordinal
        FROM messages
        WHERE conversation_id = ?
      `,
      )
      .get(conversationId) as { last_ordinal: number | null }
    const ranges = planWindowRanges(
      last.last_ordinal ?? 0,
      config.message_count,
      config.stride,
      config.min_tail_messages,
    )

    const boundaryStatement = db.prepare(
      `
      SELECT id, sent_at
      FROM messages
      WHERE conversation_id = ? AND conversation_ordinal = ?
    `,
    )
    const insertWindow = db.prepare(
      `
      INSERT INTO windows (
        window_config_id,
        conversation_id,
        start_ordinal,
        end_ordinal,
        start_message_id,
        end_message_id,
        start_at,
        end_at,
        message_count,
        deterministic_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(window_config_id, conversation_id, start_ordinal, end_ordinal) DO UPDATE SET
        start_message_id = excluded.start_message_id,
        end_message_id = excluded.end_message_id,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        message_count = excluded.message_count,
        deterministic_key = excluded.deterministic_key
    `,
    )
    const selectWindow = db.prepare(
      `
      SELECT id
      FROM windows
      WHERE window_config_id = ?
        AND conversation_id = ?
        AND start_ordinal = ?
        AND end_ordinal = ?
    `,
    )

    const windowIds: number[] = []
    for (const range of ranges) {
      const start = boundaryStatement.get(conversationId, range.startOrdinal) as MessageBoundary
      const end = boundaryStatement.get(conversationId, range.endOrdinal) as MessageBoundary
      const key = [
        'conversation',
        conversationId,
        'config',
        windowConfigId,
        'ordinals',
        range.startOrdinal,
        range.endOrdinal,
      ].join(':')
      insertWindow.run(
        windowConfigId,
        conversationId,
        range.startOrdinal,
        range.endOrdinal,
        start.id,
        end.id,
        start.sent_at,
        end.sent_at,
        range.endOrdinal - range.startOrdinal + 1,
        key,
      )
      const row = selectWindow.get(
        windowConfigId,
        conversationId,
        range.startOrdinal,
        range.endOrdinal,
      ) as { id: number }
      windowIds.push(row.id)
    }
    return windowIds
  })()
}

export function upsertScorerConfig(
  db: AppDatabase,
  key: string,
  label: string,
  config: unknown = {},
): number {
  db.prepare(
    `
    INSERT INTO scorer_configs (key, label, config_json)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      label = excluded.label,
      config_json = excluded.config_json
  `,
  ).run(key, label, JSON.stringify(config))

  const row = db.prepare('SELECT id FROM scorer_configs WHERE key = ?').get(key) as { id: number }
  return row.id
}

export function createAnalysisRunForWindows(
  db: AppDatabase,
  scorerConfigId: number,
  windowIds: number[],
): number {
  return db.transaction(() => {
    const run = db
      .prepare(
        `
        INSERT INTO analysis_runs (scorer_config_id, status, started_at)
        VALUES (?, 'pending', ?)
      `,
      )
      .run(scorerConfigId, Date.now())
    const runId = Number(run.lastInsertRowid)
    const insertRunWindow = db.prepare(
      `
      INSERT OR IGNORE INTO run_windows (run_id, window_id, status)
      VALUES (?, ?, 'pending')
    `,
    )
    for (const windowId of windowIds) {
      insertRunWindow.run(runId, windowId)
    }
    return runId
  })()
}
