export const API_CHANNELS = {
  getSyncStatus: 'imessage-emotion:get-sync-status',
  syncMessagesNow: 'imessage-emotion:sync-messages-now',
  syncContactsNow: 'imessage-emotion:sync-contacts-now',
  listConversations: 'imessage-emotion:list-conversations',
  getConversation: 'imessage-emotion:get-conversation',
  createBaselineRun: 'imessage-emotion:create-baseline-run',
  listRuns: 'imessage-emotion:list-runs',
  getRunWindows: 'imessage-emotion:get-run-windows',
  getWindowMessages: 'imessage-emotion:get-window-messages',
  askConversation: 'imessage-emotion:ask-conversation',
} as const

export type ApiMethodName = keyof typeof API_CHANNELS

export type SyncPhase = 'idle' | 'syncing' | 'error' | 'stopped'

export interface SyncStatus {
  messages: {
    state: SyncPhase
    cursor: number
    importedMessages: number
    hasMore?: boolean
    error?: string
  }
  contacts: {
    state: SyncPhase
    scannedContacts: number
    resolvedHandles: number
    error?: string
  }
}

export interface ConversationSummary {
  id: number
  title: string
  participantSummary: string
  messageCount: number
  firstMessageAt: number | null
  lastMessageAt: number | null
  latestRun?: RunSummary
}

export interface ConversationDetail extends ConversationSummary {
  participants: Array<{
    id: number
    displayName: string | null
    handle: string
  }>
  runs: RunSummary[]
}

export interface RunSummary {
  id: number
  conversationId: number
  methodKey: string
  status: 'pending' | 'running' | 'completed' | 'error'
  windowCount: number
  startedAt: number
  completedAt: number | null
  summary: RunSummaryMetadata | Record<string, unknown>
  error?: string
}

export type EmotionScores = Record<string, number>

export interface WindowResult {
  scores?: EmotionScores
  dominant?: string
  confidence?: number
  summary?: string
  evidenceMessageIds?: number[]
  method?: string
  [key: string]: unknown
}

export interface ShiftThresholds {
  baselineWindowMin: number
  baselineWindowMax: number
  minorDelta: number
  majorDelta: number
}

export type ShiftSeverity = 'major' | 'minor' | 'none'
export type ShiftTrend = 'warmer' | 'tenser' | 'mixed' | 'stable'

export interface EmotionDelta {
  emotion: string
  baseline: number
  current: number
  delta: number
  direction: 'increase' | 'decrease' | 'flat'
  severity: ShiftSeverity
  label: string
}

export interface WindowShiftMetadata {
  method: 'rolling-shift-v1'
  status: 'pending_baseline' | 'stable' | 'minor_shift' | 'major_shift' | 'missing_scores'
  windowId: number
  ordinal: number
  baselineWindowIds: number[]
  baselineWindowCount: number
  thresholds: ShiftThresholds
  scores: EmotionScores
  baselineScores: EmotionScores
  deltas: Record<string, number>
  strongest: EmotionDelta[]
  strongestLabel: string | null
  trend: ShiftTrend
  trendScore: number
  contextLabel: string | null
}

export interface DashboardShift {
  windowId: number
  ordinal: number
  label: string
  emotion: string
  delta: number
  severity: Exclude<ShiftSeverity, 'none'>
  trend: ShiftTrend
  contextLabel: string | null
}

export interface RunSummaryMetadata {
  method: 'rolling-shift-summary-v1'
  runId: number
  status: string
  isPending: boolean
  isIncomplete: boolean
  windowCount: number
  scoredWindowCount: number
  pendingWindowCount: number
  shiftedWindowCount: number
  majorShiftCount: number
  minorShiftCount: number
  stableWindowCount: number
  strongestShift: DashboardShift | null
  strongestTrend: ShiftTrend
  counts: {
    byTrend: Record<string, number>
    byEmotion: Record<string, number>
  }
  thresholds: ShiftThresholds
  updatedAt: string
}

export interface AnalysisWindow {
  id: number
  runId: number
  conversationId: number
  ordinal: number
  startOrdinal: number
  endOrdinal: number
  contextStartOrdinal: number | null
  contextEndOrdinal: number | null
  focalStartOrdinal: number
  focalEndOrdinal: number
  messageCount: number
  contextMessageCount: number
  focalMessageCount: number
  status: 'pending' | 'running' | 'completed' | 'error'
  result: WindowResult
  shift: WindowShiftMetadata | Record<string, unknown>
  latencyMs: number | null
  error?: string
}

export interface WindowMessage {
  id: number
  conversationId: number
  conversationOrdinal: number
  senderContactId: number | null
  senderName: string | null
  text: string | null
  sentAt: number
  isFromMe: boolean
  isRead: boolean
  hasAttachments: boolean
}

export interface BaselineRunOptions {
  methodKey?: string
  windowSize?: number
  stride?: number
  mode?: 'absolute-message-count' | 'comparative-message-count'
}

export type WindowMessageSlice = 'all' | 'context' | 'focal'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  citations?: Array<{
    messageId?: number
    windowId?: number
    label: string
  }>
}

export interface AskConversationInput {
  conversationId: number
  question: string
  runId?: number
  windowId?: number
  history?: ChatTurn[]
}

export interface ImessageEmotionApi {
  getSyncStatus(): Promise<SyncStatus>
  syncMessagesNow(): Promise<SyncStatus>
  syncContactsNow(): Promise<SyncStatus>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: number): Promise<ConversationDetail>
  createBaselineRun(conversationId: number, options?: BaselineRunOptions): Promise<RunSummary>
  listRuns(conversationId: number): Promise<RunSummary[]>
  getRunWindows(runId: number): Promise<AnalysisWindow[]>
  getWindowMessages(windowId: number, slice?: WindowMessageSlice): Promise<WindowMessage[]>
  askConversation(input: AskConversationInput): Promise<ChatTurn>
}
