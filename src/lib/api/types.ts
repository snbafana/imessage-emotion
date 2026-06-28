export const API_CHANNELS = {
  getSyncStatus: 'imessage-emotion:get-sync-status',
  syncMessagesNow: 'imessage-emotion:sync-messages-now',
  syncContactsNow: 'imessage-emotion:sync-contacts-now',
  listConversations: 'imessage-emotion:list-conversations',
  getConversation: 'imessage-emotion:get-conversation',
  createAnalysisRun: 'imessage-emotion:create-analysis-run',
  listRuns: 'imessage-emotion:list-runs',
  getRunWindows: 'imessage-emotion:get-run-windows',
  getWindowMessages: 'imessage-emotion:get-window-messages',
  askConversation: 'imessage-emotion:ask-conversation',
} as const

export type ApiMethodName = keyof typeof API_CHANNELS
export type JsonRecord = Record<string, unknown>
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
  sourceChatId: number
  chatIdentifier: string
  title: string
  isGroup: boolean
  participantSummary: string
  participantCount: number
  messageCount: number
  firstMessageAt: number | null
  lastMessageAt: number | null
  latestRun?: RunSummary | null
}

export interface ContactSearchHit {
  contactId: number
  displayName: string | null
  handleIdentifier: string
  company: string | null
  conversationIds: number[]
  score: number
}

export interface ConversationParticipant {
  id: number
  handle: string
  handleIdentifier: string
  normalizedHandle: string
  service: string
  displayName: string | null
}

export interface ConversationDetail extends ConversationSummary {
  participants: ConversationParticipant[]
  runs: RunSummary[]
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'error'

export interface RunWindowConfigMetadata {
  mode?: 'absolute-message-count' | 'comparative-message-count'
  contextMessages?: number
  focalMessages?: number
  stride?: number
  minFocalMessages?: number
  [key: string]: unknown
}

export interface RunSummary {
  id: number
  conversationId: number
  methodKey: string
  status: RunStatus
  windowCount: number
  scoredWindowCount?: number
  startedAt: number
  completedAt: number | null
  windowConfig?: RunWindowConfigMetadata | Record<string, unknown>
  scorerConfig?: Record<string, unknown>
  summary: RunSummaryMetadata | Record<string, unknown>
  summaryJson?: Record<string, unknown>
  error?: string | null
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
  metadata: JsonRecord
  status: RunStatus
  result: WindowResult
  resultJson?: WindowResult
  shift: WindowShiftMetadata | Record<string, unknown>
  shiftJson?: Record<string, unknown>
  latencyMs: number | null
  error?: string | null
  createdAt: number
}

export interface WindowMessage {
  id: number
  conversationId: number
  conversationOrdinal: number
  sourceRowid: number
  guid: string
  senderContactId: number | null
  senderName: string | null
  text: string | null
  sentAt: number
  isFromMe: boolean
  isRead: boolean
  hasAttachments: boolean
  status: string
  slice: WindowMessageSlice
}

export interface AnalysisRunOptions {
  contextMessages?: number
  focalMessages?: number
  stride?: number
  minFocalMessages?: number
  mode?: 'absolute-message-count' | 'comparative-message-count'
  scorerConfig?: Record<string, unknown>
}

export type WindowMessageSlice = 'all' | 'full' | 'context' | 'focal'

export interface WindowMessagesResult {
  window: AnalysisWindow
  slice: WindowMessageSlice
  messages: WindowMessage[]
}

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
  runId: number
  windowId: number
}

export type ConversationChatResponse = import('../chat/answer').ConversationChatResponse

export interface ImessageEmotionApi {
  getSyncStatus(): Promise<SyncStatus>
  syncMessagesNow(): Promise<SyncStatus>
  syncContactsNow(): Promise<SyncStatus>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: number): Promise<ConversationDetail | null>
  createAnalysisRun(conversationId: number, options?: AnalysisRunOptions): Promise<RunSummary>
  listRuns(conversationId: number): Promise<RunSummary[]>
  getRunWindows(runId: number): Promise<AnalysisWindow[]>
  getWindowMessages(windowId: number, slice?: WindowMessageSlice): Promise<WindowMessage[]>
  askConversation(input: AskConversationInput): Promise<ConversationChatResponse>
}
