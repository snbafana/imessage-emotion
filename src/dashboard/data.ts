import type { ImessageEmotionApi, WindowMessageSlice } from '../lib/api/types'

type EmotionKey = 'warmth' | 'joy' | 'trust' | 'stress' | 'friction' | 'sadness'

export const EMOTIONS: Record<EmotionKey, { label: string; color: string; ink: string }> = {
  warmth: { label: 'Warmth', color: 'oklch(0.69 0.12 182)', ink: 'oklch(0.52 0.12 182)' },
  joy: { label: 'Joy', color: 'oklch(0.79 0.15 78)', ink: 'oklch(0.55 0.13 78)' },
  trust: { label: 'Trust', color: 'oklch(0.69 0.12 182)', ink: 'oklch(0.52 0.12 182)' },
  stress: { label: 'Stress', color: 'oklch(0.58 0.17 300)', ink: 'oklch(0.5 0.16 300)' },
  friction: { label: 'Friction', color: 'oklch(0.63 0.2 27)', ink: 'oklch(0.52 0.2 27)' },
  sadness: { label: 'Sadness', color: 'oklch(0.61 0.13 252)', ink: 'oklch(0.5 0.13 252)' },
}

export const SCORE_KEYS = ['warmth', 'joy', 'stress', 'friction', 'sadness'] as const

type ScoreKey = (typeof SCORE_KEYS)[number]
type Scores = Partial<Record<ScoreKey, number>>
type RunState = 'no-run' | 'pending' | 'scored' | 'failed' | 'unknown'
type MessageSlice = WindowMessageSlice

export type ConversationView = {
  id: string
  rawId: string | number
  title: string
  initial: string
  avatar: string
  participantSummary: string
  messageCount: number
  firstMessageAt: number | null
  lastMessageAt: number | null
  latestRun: RunView | null
}

export type RunView = {
  id: string
  rawId: string | number
  conversationId: string | number | null
  methodKey: string
  status: string
  state: RunState
  startedAt: number | null
  completedAt: number | null
  error: string | null
  summary: Record<string, unknown>
  windowCount: number | null
  scoredWindowCount: number | null
}

export type WindowView = {
  id: string
  rawId: string | number
  ordinal: number
  status: string
  state: RunState
  label: string
  sub: string
  startOrdinal: number
  endOrdinal: number
  contextStartOrdinal: number | null
  contextEndOrdinal: number | null
  focalStartOrdinal: number
  focalEndOrdinal: number
  messageCount: number
  contextMessageCount: number
  focalMessageCount: number
  result: Record<string, unknown>
  shift: Record<string, unknown>
  scores: Scores
  dominant: ScoreKey | null
  intensity: number
  summary: string
  error: string | null
}

export type MessageView = {
  id: string
  rawId: string | number
  from: 'me' | 'them'
  sender: string
  text: string
  sentAt: number | null
  time: string
  ordinal: number | null
}

type TimelineBlock = {
  window: WindowView
  composition: { emotion: EmotionKey; weight: number }[]
  intensity: number
}

type DashboardSmokeHtmlInput = {
  conversations: ConversationView[]
  run: RunView | null
  windows: WindowView[]
  selectedWindow: WindowView | null
  contextMessages: MessageView[]
  focalMessages: MessageView[]
}

type JsonRecord = Record<string, unknown>

export function getDashboardApi(): ImessageEmotionApi | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { ipcRenderer?: ImessageEmotionApi }).ipcRenderer ?? null
}

export function hasConversationApi(api: ImessageEmotionApi | null): api is ImessageEmotionApi & {
  listConversations: () => Promise<unknown>
} {
  return typeof api?.listConversations === 'function'
}

export function normalizeConversations(input: unknown): ConversationView[] {
  return unwrapList(input, ['conversations', 'items', 'rows']).map((item) => {
    const row = asRecord(item)
    const rawId = getId(row, ['id', 'conversationId', 'conversation_id'])
    const title =
      getString(row, ['title', 'displayName', 'display_name', 'name', 'chat_identifier']) ??
      `Conversation ${rawId}`
    const participantSummary =
      getString(row, ['participantSummary', 'participant_summary', 'participants']) ?? title
    const latestRunValue = getValue(row, ['latestRun', 'latest_run'])
    const latestRun = latestRunValue == null ? null : normalizeRuns([latestRunValue])[0] ?? null

    return {
      id: String(rawId),
      rawId,
      title,
      initial: title.trim().charAt(0).toUpperCase() || '?',
      avatar: colorForId(String(rawId)),
      participantSummary,
      messageCount: getNumber(row, ['messageCount', 'message_count']) ?? 0,
      firstMessageAt: getTime(row, ['firstMessageAt', 'first_message_at']),
      lastMessageAt: getTime(row, ['lastMessageAt', 'last_message_at']),
      latestRun,
    }
  })
}

export function normalizeRuns(input: unknown): RunView[] {
  return unwrapList(input, ['runs', 'items', 'rows']).map((item) => {
    const row = asRecord(item)
    const rawId = getId(row, ['id', 'runId', 'run_id'])
    const status = getString(row, ['status']) ?? 'unknown'
    const summary = parseObject(getValue(row, ['summaryJson', 'summary_json', 'summary']))

    return {
      id: String(rawId),
      rawId,
      conversationId: getOptionalId(row, ['conversationId', 'conversation_id']),
      methodKey: getString(row, ['methodKey', 'method_key']) ?? 'baseline-v1',
      status,
      state: normalizeRunState(status),
      startedAt: getTime(row, ['startedAt', 'started_at']),
      completedAt: getTime(row, ['completedAt', 'completed_at']),
      error: getString(row, ['error']) ?? null,
      summary,
      windowCount: getNumber(row, ['windowCount', 'window_count']),
      scoredWindowCount: getNumber(row, ['scoredWindowCount', 'scored_window_count']),
    }
  })
}

export function normalizeWindows(input: unknown): WindowView[] {
  return unwrapList(input, ['windows', 'items', 'rows']).map((item, index) => {
    const row = asRecord(item)
    const rawId = getId(row, ['id', 'windowId', 'window_id'])
    const ordinal = getNumber(row, ['ordinal']) ?? index + 1
    const status = getString(row, ['status']) ?? 'unknown'
    const startOrdinal = getNumber(row, ['startOrdinal', 'start_ordinal']) ?? 0
    const endOrdinal = getNumber(row, ['endOrdinal', 'end_ordinal']) ?? startOrdinal
    const contextStartOrdinal = getNumber(row, ['contextStartOrdinal', 'context_start_ordinal'])
    const contextEndOrdinal = getNumber(row, ['contextEndOrdinal', 'context_end_ordinal'])
    const focalStartOrdinal =
      getNumber(row, ['focalStartOrdinal', 'focal_start_ordinal']) ?? startOrdinal
    const focalEndOrdinal = getNumber(row, ['focalEndOrdinal', 'focal_end_ordinal']) ?? endOrdinal
    const result = parseObject(getValue(row, ['resultJson', 'result_json', 'result']))
    const shift = parseObject(getValue(row, ['shiftJson', 'shift_json', 'shift']))
    const scores = extractScores(result)
    const dominant = getDominantScore(result, scores)
    const intensity = Object.values(scores).length
      ? Math.max(0.06, ...Object.values(scores).map((score) => clamp01(score)))
      : 0
    const messageCount = getNumber(row, ['messageCount', 'message_count']) ?? 0
    const contextMessageCount =
      getNumber(row, ['contextMessageCount', 'context_message_count']) ??
      ordinalCount(contextStartOrdinal, contextEndOrdinal)
    const focalMessageCount =
      getNumber(row, ['focalMessageCount', 'focal_message_count']) ??
      ordinalCount(focalStartOrdinal, focalEndOrdinal)

    return {
      id: String(rawId),
      rawId,
      ordinal,
      status,
      state: normalizeRunState(status),
      label: `Window ${ordinal}`,
      sub: `ordinals ${startOrdinal}-${endOrdinal} · ${messageCount} messages`,
      startOrdinal,
      endOrdinal,
      contextStartOrdinal,
      contextEndOrdinal,
      focalStartOrdinal,
      focalEndOrdinal,
      messageCount,
      contextMessageCount,
      focalMessageCount,
      result,
      shift,
      scores,
      dominant,
      intensity,
      summary: getString(result, ['summary']) ?? getString(shift, ['summary']) ?? 'No result summary yet.',
      error: getString(row, ['error']) ?? null,
    }
  })
}

export function normalizeMessages(input: unknown): MessageView[] {
  return unwrapList(input, ['messages', 'items', 'rows']).map((item) => {
    const row = asRecord(item)
    const rawId = getId(row, ['id', 'messageId', 'message_id'])
    const isFromMe = getBoolean(row, ['isFromMe', 'is_from_me'])
    const sentAt = getTime(row, ['sentAt', 'sent_at'])
    const ordinal = getNumber(row, ['conversationOrdinal', 'conversation_ordinal'])
    const sender =
      getString(row, ['senderName', 'sender_name', 'displayName', 'display_name']) ??
      (isFromMe ? 'You' : 'Them')

    return {
      id: String(rawId),
      rawId,
      from: isFromMe ? 'me' : 'them',
      sender,
      text: getString(row, ['text']) ?? '',
      sentAt,
      time: sentAt == null ? sender : `${sender} · ${formatShortDate(sentAt)}`,
      ordinal,
    }
  })
}

export async function getWindowMessages(
  api: ImessageEmotionApi,
  windowId: string | number,
  slice: MessageSlice,
): Promise<MessageView[]> {
  return normalizeMessages(await api.getWindowMessages(Number(windowId), slice))
}

export function latestRun(runs: RunView[]): RunView | null {
  return [...runs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null
}

export function timelineBlocks(windows: WindowView[]): TimelineBlock[] {
  return windows.map((window) => ({
    window,
    composition: compositionForScores(window.scores, window.dominant),
    intensity: window.intensity,
  }))
}

export function runStateLabel(run: RunView | null, windows: WindowView[]): string {
  if (!run) return 'No baseline run yet'
  if (run.state === 'failed') return 'Run failed'
  if (run.state === 'pending') return 'Run pending'
  if (windows.some((window) => window.state === 'scored') || run.state === 'scored') {
    return 'Baseline scored'
  }
  return 'Run status unknown'
}

export function gradientFor(composition: { emotion: EmotionKey; weight: number }[]): string {
  const colors = composition.map((item) => EMOTIONS[item.emotion].color)
  if (composition.length === 0) return '#d8d8dc'
  if (composition.length === 1) return colors[0]
  const stops = [`${colors[0]} 0%`]
  let cum = 0
  composition.forEach((item, index) => {
    const mid = cum + item.weight / 2
    stops.push(`${colors[index]} ${Math.round(mid * 100)}%`)
    cum += item.weight
  })
  stops.push(`${colors[colors.length - 1]} 100%`)
  return `linear-gradient(to top, ${stops.join(', ')})`
}

export function formatMessageCount(count: number): string {
  return new Intl.NumberFormat('en-US').format(count)
}

export function formatDateRange(first: number | null, last: number | null): string {
  if (first == null && last == null) return 'No dated messages'
  if (first == null) return `through ${formatMonthYear(last)}`
  if (last == null) return `from ${formatMonthYear(first)}`
  return `${formatMonthYear(first)} - ${formatMonthYear(last)}`
}

export function renderDashboardSmokeHtml(input: DashboardSmokeHtmlInput): string {
  const selected = input.selectedWindow
  const status = runStateLabel(input.run, input.windows)
  const context = input.contextMessages.map((message) => escapeHtml(message.text)).join('')
  const focal = input.focalMessages.map((message) => escapeHtml(message.text)).join('')
  const windows = input.windows
    .map((window) => `<button class="block">${escapeHtml(window.label)} ${escapeHtml(window.status)}</button>`)
    .join('')
  const conversations = input.conversations
    .map((conversation) => `<button class="person">${escapeHtml(conversation.title)}</button>`)
    .join('')

  return [
    '<main class="dashboard-smoke">',
    `<aside>${conversations}</aside>`,
    `<section class="timeline"><h1>${escapeHtml(status)}</h1>${windows || escapeHtml(status)}</section>`,
    '<section class="inspector">',
    `<h2>${escapeHtml(selected?.label ?? status)}</h2>`,
    `<h3>Old context</h3><div>${context}</div>`,
    `<h3>New focal</h3><div>${focal}</div>`,
    `<p>${escapeHtml(selected?.summary ?? status)}</p>`,
    '</section>',
    '</main>',
  ].join('')
}

function normalizeRunState(status: string | null | undefined): RunState {
  const value = String(status ?? '').toLowerCase()
  if (value.includes('fail') || value.includes('error')) return 'failed'
  if (value.includes('pending') || value.includes('queued') || value.includes('running')) {
    return 'pending'
  }
  if (
    value.includes('scored') ||
    value.includes('complete') ||
    value.includes('succeeded') ||
    value === 'done'
  ) {
    return 'scored'
  }
  return 'unknown'
}

function compositionForScores(
  scores: Scores,
  dominant: ScoreKey | null,
): { emotion: EmotionKey; weight: number }[] {
  const ranked = SCORE_KEYS.map((key) => ({ emotion: key, value: clamp01(scores[key] ?? 0) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)

  if (dominant && !ranked.some((item) => item.emotion === dominant)) {
    ranked.unshift({ emotion: dominant, value: clamp01(scores[dominant] ?? 0.5) })
  }
  if (ranked.length === 0) return []

  const total = ranked.reduce((sum, item) => sum + item.value, 0) || 1
  return ranked.map((item) => ({ emotion: item.emotion, weight: item.value / total }))
}

function extractScores(result: JsonRecord): Scores {
  const source = asRecord(result.scores)
  return SCORE_KEYS.reduce<Scores>((scores, key) => {
    const value = getNumber(source, [key])
    if (value != null) scores[key] = clamp01(value)
    return scores
  }, {})
}

function getDominantScore(result: JsonRecord, scores: Scores): ScoreKey | null {
  const dominant = getString(result, ['dominant'])
  if (isScoreKey(dominant)) return dominant
  return SCORE_KEYS.reduce<ScoreKey | null>((best, key) => {
    if (scores[key] == null) return best
    if (best == null || (scores[key] ?? 0) > (scores[best] ?? 0)) return key
    return best
  }, null)
}

function isScoreKey(value: string | null): value is ScoreKey {
  return SCORE_KEYS.includes(value as ScoreKey)
}

function unwrapList(input: unknown, keys: string[]): unknown[] {
  if (Array.isArray(input)) return input
  const row = asRecord(input)
  for (const key of keys) {
    const value = row[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function asRecord(value: unknown): JsonRecord {
  return value != null && typeof value === 'object' ? (value as JsonRecord) : {}
}

function parseObject(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return asRecord(value)
}

function getValue(row: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key]
  }
  return undefined
}

function getString(row: JsonRecord, keys: string[]): string | null {
  const value = getValue(row, keys)
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getNumber(row: JsonRecord, keys: string[]): number | null {
  const value = getValue(row, keys)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function getBoolean(row: JsonRecord, keys: string[]): boolean {
  const value = getValue(row, keys)
  return value === true || value === 1
}

function getId(row: JsonRecord, keys: string[]): string | number {
  const value = getValue(row, keys)
  if (typeof value === 'number' || typeof value === 'string') return value
  return 'unknown'
}

function getOptionalId(row: JsonRecord, keys: string[]): string | number | null {
  const value = getValue(row, keys)
  if (typeof value === 'number' || typeof value === 'string') return value
  return null
}

function getTime(row: JsonRecord, keys: string[]): number | null {
  const value = getValue(row, keys)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return asNumber
    const asDate = Date.parse(value)
    if (Number.isFinite(asDate)) return asDate
  }
  return null
}

function ordinalCount(start: number | null, end: number | null): number {
  if (start == null || end == null) return 0
  return Math.max(0, end - start + 1)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function formatMonthYear(value: number | null): string {
  if (value == null) return 'unknown'
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(value)
}

function formatShortDate(value: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function colorForId(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const palette = [
    '#1f44ff',
    'oklch(0.69 0.12 182)',
    'oklch(0.61 0.13 252)',
    'oklch(0.58 0.17 300)',
    'oklch(0.63 0.2 27)',
  ]
  return palette[hash % palette.length]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}