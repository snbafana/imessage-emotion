import type { PrivacySafeCounts } from '../db/schema'

export type { PrivacySafeCounts }

export type JsonRecord = Record<string, unknown>
export type SyncPhase = 'idle' | 'syncing' | 'error' | 'stopped'

export type SetupReadinessState =
  | 'authorized'
  | 'missing'
  | 'needs_full_disk_access'
  | 'blocked'
  | 'not_determined'
  | 'denied'
  | 'restricted'
  | 'limited'
  | 'unknown'
  | 'check_failed'

export interface SetupPermissionStatus {
  key: 'messages_full_disk_access' | 'contacts'
  label: string
  state: SetupReadinessState
  canSync: boolean
  summary: string
  actionLabel: string
  settingsTarget: 'full_disk_access' | 'contacts'
  error?: string
}

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

export interface OnboardingStatus {
  permissions: SetupPermissionStatus[]
  sync: SyncStatus
  counts: PrivacySafeCounts
  ready: boolean
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
  summary: Record<string, unknown>
  error?: string | null
}

export type EmotionScores = Record<string, number>
export type EmotionAnchor = import('../emotion/anchors').Anchor
export type LabelAmbiguity = 'low' | 'medium' | 'high'

export interface WindowResult {
  scores?: EmotionScores
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
  startSentAt?: number | null
  endSentAt?: number | null
  metadata: JsonRecord
  status: RunStatus
  result: WindowResult
  shift: Record<string, unknown>
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
  slice: LabelingMessageSlice
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
export type LabelingMessageSlice = WindowMessageSlice | 'before' | 'after'

export interface WindowLabel {
  id: number
  windowId: number
  labeler: string
  dominant: EmotionAnchor | null
  acceptableDominants: EmotionAnchor[]
  scores: Partial<Record<EmotionAnchor, number>>
  requiresContext: boolean | null
  sarcasmOrSubtext: boolean | null
  ambiguity: LabelAmbiguity | null
  stateLabel: string | null
  evidenceMessageRefs: number[]
  pivotalMessageRefs: number[]
  notes: string | null
  createdAt: number
  updatedAt: number
}

export interface WindowPrediction {
  dominant: string | null
  confidence: number | null
  scores: EmotionScores
  summary: string | null
  evidenceMessageIds: number[]
}

export interface LabelingWindowSummary {
  window: AnalysisWindow
  conversation: Pick<
    ConversationSummary,
    'id' | 'title' | 'participantSummary' | 'messageCount' | 'firstMessageAt' | 'lastMessageAt'
  >
  run: Pick<RunSummary, 'id' | 'methodKey' | 'status' | 'startedAt' | 'windowConfig'>
  prediction: WindowPrediction
  label: WindowLabel | null
}

export interface LabelingWindowDetail extends LabelingWindowSummary {
  beforeMessages: WindowMessage[]
  contextMessages: WindowMessage[]
  focalMessages: WindowMessage[]
  allMessages: WindowMessage[]
  afterMessages: WindowMessage[]
}

export interface ListLabelingWindowsInput {
  conversationId?: number
  runId?: number
  labeler?: string
  limit?: number
}

export interface SaveWindowLabelInput {
  windowId: number
  labeler?: string
  dominant?: EmotionAnchor | null
  acceptableDominants?: EmotionAnchor[]
  scores?: Partial<Record<EmotionAnchor, number>>
  requiresContext?: boolean | null
  sarcasmOrSubtext?: boolean | null
  ambiguity?: LabelAmbiguity | null
  stateLabel?: string | null
  evidenceMessageRefs?: number[]
  pivotalMessageRefs?: number[]
  notes?: string | null
}
