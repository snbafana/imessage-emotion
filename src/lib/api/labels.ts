import { EKMAN_ANCHORS, type Anchor } from '../emotion/anchors'
import {
  getConversationMessagesAfter,
  getConversationMessagesBefore,
  getWindowMessages,
} from './messages'
import {
  mapAnalysisWindow,
  mapRunStatus,
  type AnalysisWindowRow,
} from './runs'
import { parseJsonRecord } from './db'
import type { AppDatabase } from '../db/schema'
import type {
  EmotionScores,
  LabelAmbiguity,
  LabelingWindowDetail,
  LabelingWindowSummary,
  ListLabelingWindowsInput,
  SaveWindowLabelInput,
  WindowLabel,
  WindowPrediction,
  WindowResult,
} from './types'

type LabelRow = {
  label_id: number | null
  label_window_id: number | null
  label_labeler: string | null
  label_dominant: string | null
  label_acceptable_dominants_json: string | null
  label_scores_json: string | null
  label_requires_context: number | null
  label_sarcasm_or_subtext: number | null
  label_ambiguity: string | null
  label_state_label: string | null
  label_evidence_message_refs_json: string | null
  label_pivotal_message_refs_json: string | null
  label_notes: string | null
  label_created_at: number | null
  label_updated_at: number | null
}

type LabelingWindowRow = AnalysisWindowRow &
  LabelRow & {
    conversation_title: string | null
    participant_summary: string | null
    conversation_message_count: number
    conversation_first_message_at: number | null
    conversation_last_message_at: number | null
    run_method_key: string
    run_status: string
    run_started_at: number
    run_window_config_json: string | null
  }

const DEFAULT_LABELER = 'human'
const SURROUNDING_MESSAGE_COUNT = 24

export function listLabelingWindows(
  db: AppDatabase,
  input: ListLabelingWindowsInput = {},
): LabelingWindowSummary[] {
  const labeler = normalizeLabeler(input.labeler)
  const limit = Math.min(Math.max(input.limit ?? 120, 1), 500)
  const rows = db
    .prepare(
      `
      SELECT
        ${windowColumns()},
        COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) AS conversation_title,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier))
          AS participant_summary,
        c.message_count AS conversation_message_count,
        c.first_message_at AS conversation_first_message_at,
        c.last_message_at AS conversation_last_message_at,
        ar.method_key AS run_method_key,
        ar.status AS run_status,
        ar.started_at AS run_started_at,
        ar.window_config_json AS run_window_config_json,
        ${labelColumns()}
      FROM windows w
      JOIN analysis_runs ar ON ar.id = w.run_id
      JOIN conversations c ON c.id = w.conversation_id
      LEFT JOIN messages sm ON sm.id = w.start_message_id
      LEFT JOIN messages em ON em.id = w.end_message_id
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
      LEFT JOIN contacts ct ON ct.id = cp.contact_id
      LEFT JOIN window_labels wl ON wl.window_id = w.id AND wl.labeler = ?
      WHERE (? IS NULL OR w.conversation_id = ?)
        AND (? IS NULL OR w.run_id = ?)
      GROUP BY w.id
      ORDER BY
        CASE WHEN wl.id IS NULL THEN 0 ELSE 1 END,
        ar.started_at DESC,
        w.ordinal,
        w.id
      LIMIT ?
    `,
    )
    .all(
      labeler,
      input.conversationId ?? null,
      input.conversationId ?? null,
      input.runId ?? null,
      input.runId ?? null,
      limit,
    ) as LabelingWindowRow[]

  return rows.map(mapLabelingWindowSummary)
}

export function getLabelingWindow(
  db: AppDatabase,
  windowId: number,
  labeler = DEFAULT_LABELER,
): LabelingWindowDetail | null {
  const row = db
    .prepare(
      `
      SELECT
        ${windowColumns()},
        COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) AS conversation_title,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ct.display_name, ''), ct.handle_identifier))
          AS participant_summary,
        c.message_count AS conversation_message_count,
        c.first_message_at AS conversation_first_message_at,
        c.last_message_at AS conversation_last_message_at,
        ar.method_key AS run_method_key,
        ar.status AS run_status,
        ar.started_at AS run_started_at,
        ar.window_config_json AS run_window_config_json,
        ${labelColumns()}
      FROM windows w
      JOIN analysis_runs ar ON ar.id = w.run_id
      JOIN conversations c ON c.id = w.conversation_id
      LEFT JOIN messages sm ON sm.id = w.start_message_id
      LEFT JOIN messages em ON em.id = w.end_message_id
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
      LEFT JOIN contacts ct ON ct.id = cp.contact_id
      LEFT JOIN window_labels wl ON wl.window_id = w.id AND wl.labeler = ?
      WHERE w.id = ?
      GROUP BY w.id
    `,
    )
    .get(normalizeLabeler(labeler), windowId) as LabelingWindowRow | undefined

  if (!row) return null
  return {
    ...mapLabelingWindowSummary(row),
    beforeMessages: getConversationMessagesBefore(
      db,
      row.conversation_id,
      row.start_ordinal,
      SURROUNDING_MESSAGE_COUNT,
    ),
    contextMessages: getWindowMessages(db, windowId, 'context'),
    focalMessages: getWindowMessages(db, windowId, 'focal'),
    allMessages: getWindowMessages(db, windowId, 'all'),
    afterMessages: getConversationMessagesAfter(
      db,
      row.conversation_id,
      row.end_ordinal,
      SURROUNDING_MESSAGE_COUNT,
    ),
  }
}

export function saveWindowLabel(db: AppDatabase, input: SaveWindowLabelInput): WindowLabel {
  const existingWindow = db
    .prepare('SELECT id FROM windows WHERE id = ?')
    .get(input.windowId) as { id: number } | undefined
  if (!existingWindow) throw new Error(`Missing window ${input.windowId}`)

  const labeler = normalizeLabeler(input.labeler)
  const now = Date.now()
  db.prepare(
    `
    INSERT INTO window_labels (
      window_id,
      labeler,
      dominant,
      acceptable_dominants_json,
      scores_json,
      requires_context,
      sarcasm_or_subtext,
      ambiguity,
      state_label,
      evidence_message_refs_json,
      pivotal_message_refs_json,
      notes,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(window_id, labeler) DO UPDATE SET
      dominant = excluded.dominant,
      acceptable_dominants_json = excluded.acceptable_dominants_json,
      scores_json = excluded.scores_json,
      requires_context = excluded.requires_context,
      sarcasm_or_subtext = excluded.sarcasm_or_subtext,
      ambiguity = excluded.ambiguity,
      state_label = excluded.state_label,
      evidence_message_refs_json = excluded.evidence_message_refs_json,
      pivotal_message_refs_json = excluded.pivotal_message_refs_json,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `,
  ).run(
    input.windowId,
    labeler,
    input.dominant ?? null,
    JSON.stringify(normalizeAnchors(input.acceptableDominants ?? [])),
    JSON.stringify(normalizeScores(input.scores ?? {})),
    toNullableInteger(input.requiresContext),
    toNullableInteger(input.sarcasmOrSubtext),
    input.ambiguity ?? null,
    blankToNull(input.stateLabel),
    JSON.stringify(normalizeIds(input.evidenceMessageRefs ?? [])),
    JSON.stringify(normalizeIds(input.pivotalMessageRefs ?? [])),
    blankToNull(input.notes),
    now,
  )

  const detail = getLabelingWindow(db, input.windowId, labeler)
  if (!detail?.label) throw new Error(`Window label ${input.windowId} could not be read back`)
  return detail.label
}

function mapLabelingWindowSummary(row: LabelingWindowRow): LabelingWindowSummary {
  const window = mapAnalysisWindow(row)
  const result = window.result as WindowResult
  return {
    window,
    conversation: {
      id: row.conversation_id,
      title: row.conversation_title ?? `Conversation ${row.conversation_id}`,
      participantSummary: row.participant_summary ?? '',
      messageCount: row.conversation_message_count,
      firstMessageAt: row.conversation_first_message_at,
      lastMessageAt: row.conversation_last_message_at,
    },
    run: {
      id: row.run_id,
      methodKey: row.run_method_key,
      status: mapRunStatus(row.run_status),
      startedAt: row.run_started_at,
      windowConfig: parseJsonRecord(row.run_window_config_json),
    },
    prediction: mapPrediction(result),
    label: mapLabel(row),
  }
}

function mapLabel(row: LabelRow): WindowLabel | null {
  if (row.label_id == null || row.label_window_id == null) return null
  return {
    id: row.label_id,
    windowId: row.label_window_id,
    labeler: row.label_labeler ?? DEFAULT_LABELER,
    dominant: isAnchor(row.label_dominant) ? row.label_dominant : null,
    acceptableDominants: normalizeAnchors(
      parseJsonArray(row.label_acceptable_dominants_json),
    ),
    scores: normalizeScores(parseJsonRecord(row.label_scores_json)),
    requiresContext: fromNullableInteger(row.label_requires_context),
    sarcasmOrSubtext: fromNullableInteger(row.label_sarcasm_or_subtext),
    ambiguity: isAmbiguity(row.label_ambiguity) ? row.label_ambiguity : null,
    stateLabel: row.label_state_label,
    evidenceMessageRefs: normalizeIds(parseJsonArray(row.label_evidence_message_refs_json)),
    pivotalMessageRefs: normalizeIds(parseJsonArray(row.label_pivotal_message_refs_json)),
    notes: row.label_notes,
    createdAt: row.label_created_at ?? 0,
    updatedAt: row.label_updated_at ?? 0,
  }
}

function mapPrediction(result: WindowResult): WindowPrediction {
  return {
    dominant: typeof result.dominant === 'string' ? result.dominant : null,
    confidence: finiteNumber(result.confidence),
    scores: normalizeEmotionScores(result.scores ?? {}),
    summary: typeof result.summary === 'string' ? result.summary : null,
    evidenceMessageIds: normalizeIds(
      Array.isArray(result.evidenceMessageIds) ? result.evidenceMessageIds : [],
    ),
  }
}

function windowColumns(): string {
  return `
    w.id,
    w.run_id,
    w.conversation_id,
    w.ordinal,
    w.start_ordinal,
    w.end_ordinal,
    w.context_start_ordinal,
    w.context_end_ordinal,
    w.focal_start_ordinal,
    w.focal_end_ordinal,
    w.message_count,
    w.context_message_count,
    w.focal_message_count,
    sm.sent_at AS start_sent_at,
    em.sent_at AS end_sent_at,
    w.window_metadata_json,
    w.result_json,
    w.shift_json,
    w.status,
    w.latency_ms,
    w.error,
    w.created_at
  `
}

function labelColumns(): string {
  return `
    wl.id AS label_id,
    wl.window_id AS label_window_id,
    wl.labeler AS label_labeler,
    wl.dominant AS label_dominant,
    wl.acceptable_dominants_json AS label_acceptable_dominants_json,
    wl.scores_json AS label_scores_json,
    wl.requires_context AS label_requires_context,
    wl.sarcasm_or_subtext AS label_sarcasm_or_subtext,
    wl.ambiguity AS label_ambiguity,
    wl.state_label AS label_state_label,
    wl.evidence_message_refs_json AS label_evidence_message_refs_json,
    wl.pivotal_message_refs_json AS label_pivotal_message_refs_json,
    wl.notes AS label_notes,
    wl.created_at AS label_created_at,
    wl.updated_at AS label_updated_at
  `
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeLabeler(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 80) : DEFAULT_LABELER
}

function normalizeAnchors(values: unknown[]): Anchor[] {
  const anchors = new Set<Anchor>()
  for (const value of values) {
    if (isAnchor(value)) anchors.add(value)
  }
  return [...anchors]
}

function normalizeScores(value: Record<string, unknown>): Partial<Record<Anchor, number>> {
  const scores: Partial<Record<Anchor, number>> = {}
  for (const anchor of EKMAN_ANCHORS) {
    const score = finiteNumber(value[anchor])
    if (score != null) scores[anchor] = clamp01(score)
  }
  return scores
}

function normalizeEmotionScores(value: EmotionScores): EmotionScores {
  const scores: EmotionScores = {}
  for (const [key, raw] of Object.entries(value)) {
    const score = finiteNumber(raw)
    if (score != null) scores[key] = clamp01(score)
  }
  return scores
}

function normalizeIds(values: unknown[]): number[] {
  return [...new Set(values.map((value) => finiteNumber(value)).filter(isNumber))]
    .map((value) => Math.trunc(value))
    .filter((value) => value > 0)
}

function isAnchor(value: unknown): value is Anchor {
  return typeof value === 'string' && EKMAN_ANCHORS.includes(value as Anchor)
}

function isAmbiguity(value: unknown): value is LabelAmbiguity {
  return value === 'low' || value === 'medium' || value === 'high'
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isNumber(value: number | null): value is number {
  return value != null
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function toNullableInteger(value: boolean | null | undefined): number | null {
  if (value == null) return null
  return value ? 1 : 0
}

function fromNullableInteger(value: number | null): boolean | null {
  if (value == null) return null
  return value === 1
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
