import type { AppDatabase } from '../db/schema'

export type WindowMode = 'absolute-message-count' | 'comparative-message-count'

export interface RunWindowConfig {
  mode: WindowMode
  contextMessages: number
  focalMessages: number
  stride: number
  minFocalMessages: number
}

export type ComparativeRunWindowConfig = RunWindowConfig & {
  mode: 'comparative-message-count'
}

export interface WindowRange {
  startOrdinal: number
  endOrdinal: number
}

export interface RunWindowRange extends WindowRange {
  ordinal: number
  contextStartOrdinal: number | null
  contextEndOrdinal: number | null
  focalStartOrdinal: number
  focalEndOrdinal: number
  contextMessageCount: number
  focalMessageCount: number
}

export interface CappedRunWindowOptions {
  maxWindows: number
  overlapPercent: number
}

export interface CappedRunWindowPlan {
  config: ComparativeRunWindowConfig
  windowCount: number
}

type MessageBoundary = {
  id: number
}

export function planWindowRanges(
  lastOrdinal: number,
  messageCount: number,
  stride: number,
  minTailMessages: number,
): WindowRange[] {
  validatePositiveInteger('lastOrdinal', lastOrdinal, true)
  validateWindowConfig(messageCount, stride, minTailMessages)
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

export function planRunWindowRanges(lastOrdinal: number, config: RunWindowConfig): RunWindowRange[] {
  validateRunWindowConfig(config)
  if (config.mode === 'absolute-message-count') {
    return planWindowRanges(
      lastOrdinal,
      config.focalMessages,
      config.stride,
      config.minFocalMessages,
    ).map((range, index) => ({
      ...range,
      ordinal: index + 1,
      contextStartOrdinal: null,
      contextEndOrdinal: null,
      focalStartOrdinal: range.startOrdinal,
      focalEndOrdinal: range.endOrdinal,
      contextMessageCount: 0,
      focalMessageCount: range.endOrdinal - range.startOrdinal + 1,
    }))
  }

  if (lastOrdinal < config.contextMessages + config.minFocalMessages) return []

  const ranges: RunWindowRange[] = []
  for (
    let focalStartOrdinal = config.contextMessages + 1;
    focalStartOrdinal <= lastOrdinal;
    focalStartOrdinal += config.stride
  ) {
    const fullFocalEndOrdinal = focalStartOrdinal + config.focalMessages - 1
    const focalEndOrdinal = Math.min(fullFocalEndOrdinal, lastOrdinal)
    const focalMessageCount = focalEndOrdinal - focalStartOrdinal + 1
    if (focalMessageCount < config.minFocalMessages) break

    const contextStartOrdinal = focalStartOrdinal - config.contextMessages
    const contextEndOrdinal = focalStartOrdinal - 1
    ranges.push({
      ordinal: ranges.length + 1,
      startOrdinal: contextStartOrdinal,
      endOrdinal: focalEndOrdinal,
      contextStartOrdinal,
      contextEndOrdinal,
      focalStartOrdinal,
      focalEndOrdinal,
      contextMessageCount: config.contextMessages,
      focalMessageCount,
    })

    if (fullFocalEndOrdinal >= lastOrdinal) break
  }
  return ranges
}

export function planCappedRunWindowConfig(
  lastOrdinal: number,
  options: CappedRunWindowOptions,
): CappedRunWindowPlan {
  validatePositiveInteger('lastOrdinal', lastOrdinal, true)
  validatePositiveInteger('maxWindows', options.maxWindows)
  if (!Number.isInteger(options.overlapPercent) || options.overlapPercent < 10 || options.overlapPercent > 40) {
    throw new RangeError('overlapPercent must be an integer between 10 and 40')
  }

  let focalMessages = Math.max(
    24,
    Math.ceil(lastOrdinal / Math.max(1, options.maxWindows * (1 - options.overlapPercent / 100))),
  )

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const config = buildCappedConfig(lastOrdinal, focalMessages, options.overlapPercent)
    const windowCount = planRunWindowRanges(lastOrdinal, config).length
    if (windowCount <= options.maxWindows || focalMessages >= lastOrdinal) {
      return { config, windowCount }
    }
    focalMessages = Math.ceil(focalMessages * 1.15)
  }

  const config = buildCappedConfig(lastOrdinal, focalMessages, options.overlapPercent)
  return { config, windowCount: planRunWindowRanges(lastOrdinal, config).length }
}

export function createWindowsForRun(
  db: AppDatabase,
  runId: number,
  conversationId: number,
  config: RunWindowConfig,
): number[] {
  return db.transaction(() => {
    const lastOrdinal = getLastConversationOrdinal(db, conversationId)
    const ranges = planRunWindowRanges(lastOrdinal, config)
    const boundaryStatement = db.prepare(
      `
      SELECT id
      FROM messages
      WHERE conversation_id = ? AND conversation_ordinal = ?
    `,
    )
    const insertWindow = db.prepare(
      `
      INSERT INTO windows (
        run_id,
        conversation_id,
        ordinal,
        start_ordinal,
        end_ordinal,
        context_start_ordinal,
        context_end_ordinal,
        focal_start_ordinal,
        focal_end_ordinal,
        start_message_id,
        end_message_id,
        message_count,
        context_message_count,
        focal_message_count,
        window_metadata_json,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `,
    )

    const windowIds: number[] = []
    for (const range of ranges) {
      const start = boundaryStatement.get(conversationId, range.startOrdinal) as
        | MessageBoundary
        | undefined
      const end = boundaryStatement.get(conversationId, range.endOrdinal) as
        | MessageBoundary
        | undefined
      if (!start || !end) {
        throw new Error(
          `Missing boundary message for conversation ${conversationId} window ${range.ordinal}`,
        )
      }

      const metadata = {
        mode: config.mode,
        contextMessages: config.contextMessages,
        focalMessages: config.focalMessages,
        stride: config.stride,
        minFocalMessages: config.minFocalMessages,
      }
      const inserted = insertWindow.run(
        runId,
        conversationId,
        range.ordinal,
        range.startOrdinal,
        range.endOrdinal,
        range.contextStartOrdinal,
        range.contextEndOrdinal,
        range.focalStartOrdinal,
        range.focalEndOrdinal,
        start.id,
        end.id,
        range.endOrdinal - range.startOrdinal + 1,
        range.contextMessageCount,
        range.focalMessageCount,
        JSON.stringify(metadata),
      )
      windowIds.push(Number(inserted.lastInsertRowid))
    }
    return windowIds
  })()
}

export function validateRunWindowConfig(config: RunWindowConfig): void {
  if (config.mode !== 'absolute-message-count' && config.mode !== 'comparative-message-count') {
    throw new RangeError(`Unsupported window mode: ${config.mode}`)
  }
  validatePositiveInteger('contextMessages', config.contextMessages, config.mode === 'absolute-message-count')
  validateWindowConfig(config.focalMessages, config.stride, config.minFocalMessages)
  if (config.mode === 'comparative-message-count' && config.contextMessages <= 0) {
    throw new RangeError('contextMessages must be positive for comparative-message-count')
  }
}

function getLastConversationOrdinal(db: AppDatabase, conversationId: number): number {
  const row = db
    .prepare(
      `
      SELECT MAX(conversation_ordinal) AS last_ordinal
      FROM messages
      WHERE conversation_id = ?
    `,
    )
    .get(conversationId) as { last_ordinal: number | null }
  return row.last_ordinal ?? 0
}

function buildCappedConfig(
  lastOrdinal: number,
  focalMessages: number,
  overlapPercent: number,
): ComparativeRunWindowConfig {
  const minFocalMessages = Math.max(8, Math.ceil(focalMessages / 2))
  const contextMessages = Math.min(
    Math.max(focalMessages * 2, 32),
    Math.max(1, lastOrdinal - minFocalMessages),
  )
  return {
    mode: 'comparative-message-count',
    contextMessages,
    focalMessages,
    stride: Math.max(1, Math.round(focalMessages * (1 - overlapPercent / 100))),
    minFocalMessages,
  }
}

function validateWindowConfig(
  messageCount: number,
  stride: number,
  minTailMessages: number,
): void {
  validatePositiveInteger('messageCount', messageCount)
  if (!Number.isInteger(stride) || stride <= 0 || stride > messageCount) {
    throw new RangeError('stride must be a positive integer no larger than messageCount')
  }
  if (!Number.isInteger(minTailMessages) || minTailMessages <= 0 || minTailMessages > messageCount) {
    throw new RangeError('minTailMessages must be a positive integer no larger than messageCount')
  }
}

function validatePositiveInteger(name: string, value: number, allowZero = false): void {
  const valid = Number.isInteger(value) && (allowZero ? value >= 0 : value > 0)
  if (!valid) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
}
