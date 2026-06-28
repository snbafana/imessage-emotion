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

export interface RunSummary {
  id: number
  conversationId: number
  methodKey: string
  status: RunStatus
  windowCount: number
  startedAt: number
  completedAt: number | null
  summary: JsonRecord
  error?: string | null
}

export interface WindowResult {
  scores?: Record<string, number>
  dominant?: string
  confidence?: number
  summary?: string
  evidenceMessageIds?: number[]
  method?: string
  [key: string]: unknown
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
  shift: JsonRecord
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

export interface BaselineRunOptions {
  methodKey?: string
  windowSize?: number
  stride?: number
  mode?: 'absolute-message-count' | 'comparative-message-count'
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
  runId?: number
  windowId?: number
  history?: ChatTurn[]
}

export interface ImessageEmotionApi {
  getSyncStatus(): Promise<SyncStatus>
  syncMessagesNow(): Promise<SyncStatus>
  syncContactsNow(): Promise<SyncStatus>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(conversationId: number): Promise<ConversationDetail | null>
  createBaselineRun(conversationId: number, options?: BaselineRunOptions): Promise<RunSummary>
  listRuns(conversationId: number): Promise<RunSummary[]>
  getRunWindows(runId: number): Promise<AnalysisWindow[]>
  getWindowMessages(windowId: number, slice?: WindowMessageSlice): Promise<WindowMessage[]>
  askConversation(input: AskConversationInput): Promise<ChatTurn>
}
