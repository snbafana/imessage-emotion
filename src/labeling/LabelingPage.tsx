'use client'

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Select } from '@base-ui/react/select'
import { trpc } from '@/lib/trpc/client'
import { ANCHOR_DISPLAY, EKMAN_ANCHORS } from '@/lib/emotion/anchors'
import type {
  EmotionAnchor,
  LabelingWindowDetail,
  LabelingWindowSummary,
  WindowLabel,
  WindowMessage,
} from '@/lib/api/types'
import './labeling.css'

type Draft = {
  dominant: EmotionAnchor | ''
  acceptableDominants: EmotionAnchor[]
  requiresContext: boolean
  sarcasmOrSubtext: boolean
  ambiguous: boolean
  notes: string
}

const EMPTY_DRAFT: Draft = {
  dominant: '',
  acceptableDominants: [],
  requiresContext: false,
  sarcasmOrSubtext: false,
  ambiguous: false,
  notes: '',
}

export default function LabelingPage() {
  const [windows, setWindows] = useState<LabelingWindowSummary[]>([])
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null)
  const [detail, setDetail] = useState<LabelingWindowDetail | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [queueLoading, setQueueLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)

  const selectedIndex = useMemo(
    () => windows.findIndex((item) => item.window.id === selectedWindowId),
    [selectedWindowId, windows],
  )
  const selectedSummary = selectedIndex >= 0 ? windows[selectedIndex] : null
  const labeledCount = windows.filter((item) => item.label != null).length
  const unlabeledCount = windows.length - labeledCount
  const contextIds = useMemo(
    () => new Set((detail?.contextMessages ?? []).map((message) => message.id)),
    [detail],
  )
  const focalIds = useMemo(
    () => new Set((detail?.focalMessages ?? []).map((message) => message.id)),
    [detail],
  )

  const reloadQueue = useCallback(async () => {
    setQueueLoading(true)
    setQueueError(null)
    try {
      const next = await trpc.listLabelingWindows.query({ limit: 200 })
      setWindows(next)
      setSelectedWindowId((current) =>
        current && next.some((item) => item.window.id === current)
          ? current
          : next.find((item) => item.label == null)?.window.id ?? next[0]?.window.id ?? null,
      )
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not load label windows.')
    } finally {
      setQueueLoading(false)
    }
  }, [])

  useEffect(() => {
    void reloadQueue()
  }, [reloadQueue])

  useEffect(() => {
    let cancelled = false
    async function loadDetail() {
      setDetail(null)
      setDetailError(null)
      setSaveStatus(null)
      if (selectedWindowId == null) return
      setDetailLoading(true)
      try {
        const next = await trpc.getLabelingWindow.query({ windowId: selectedWindowId })
        if (!cancelled) {
          setDetail(next)
          setDraft(draftFromLabel(next?.label ?? null))
        }
      } catch (error) {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : 'Could not load window detail.')
        }
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }

    void loadDetail()
    return () => {
      cancelled = true
    }
  }, [selectedWindowId])

  async function saveLabel() {
    if (!detail || saving) return
    const existingLabel = detail.label
    setSaving(true)
    setSaveStatus(null)
    try {
      const saved = await trpc.saveWindowLabel.mutate({
        windowId: detail.window.id,
        dominant: draft.dominant || null,
        acceptableDominants: draft.acceptableDominants,
        scores: existingLabel?.scores ?? {},
        requiresContext: draft.requiresContext,
        sarcasmOrSubtext: draft.sarcasmOrSubtext,
        ambiguity: draft.ambiguous ? 'high' : null,
        stateLabel: existingLabel?.stateLabel ?? null,
        evidenceMessageRefs: existingLabel?.evidenceMessageRefs ?? [],
        pivotalMessageRefs: existingLabel?.pivotalMessageRefs ?? [],
        notes: draft.notes,
      })
      setDetail((current) =>
        current?.window.id === saved.windowId ? { ...current, label: saved } : current,
      )
      setWindows((current) =>
        current.map((item) =>
          item.window.id === saved.windowId ? { ...item, label: saved } : item,
        ),
      )
      setSaveStatus(`Saved ${formatTime(saved.updatedAt)}`)
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function exportTask() {
    if (!detail?.label || exporting) return
    setExporting(true)
    setExportStatus(null)
    try {
      const result = await trpc.exportHarborTask.mutate({ windowId: detail.window.id })
      setExportStatus(`Exported ${result.taskId} → ${result.dir}`)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  async function exportAll() {
    if (exporting || labeledCount === 0) return
    setExporting(true)
    setExportStatus(null)
    try {
      const result = await trpc.exportAllHarborTasks.mutate({})
      setExportStatus(`Exported ${result.count} task${result.count === 1 ? '' : 's'} → ${result.dir}`)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  function selectOffset(offset: number) {
    if (selectedIndex < 0) return
    const next = windows[selectedIndex + offset]
    if (next) setSelectedWindowId(next.window.id)
  }

  function selectNextUnlabeled() {
    const next =
      windows.slice(Math.max(selectedIndex + 1, 0)).find((item) => item.label == null) ??
      windows.find((item) => item.label == null)
    if (next) setSelectedWindowId(next.window.id)
  }

  return (
    <main className="labeling">
      <aside className="labeling-queue">
        <div className="labeling-brand">
          <a href="/" className="nav-link">
            Timeline
          </a>
          <div>
            <span className="label">Eval set</span>
            <h1>Window labeling</h1>
          </div>
        </div>

        <div className="queue-stats">
          <span>{windows.length} windows</span>
          <span>{unlabeledCount} open</span>
          <span>{labeledCount} labeled</span>
        </div>

        <button
          type="button"
          className="export-all-button"
          onClick={() => void exportAll()}
          disabled={exporting || labeledCount === 0}
          title="Write every labeled window as a Harbor eval task"
        >
          {exporting ? 'Exporting...' : `Export ${labeledCount} labeled → Harbor`}
        </button>
        {exportStatus && (
          <div className={`labeling-state${exportStatus.includes('failed') ? ' error' : ''}`}>
            {exportStatus}
          </div>
        )}

        {queueError && <div className="labeling-state error">{queueError}</div>}
        {queueLoading && <div className="labeling-state">Loading windows...</div>}
        {!queueLoading && windows.length === 0 && (
          <div className="labeling-state">No analyzed windows found.</div>
        )}

        <div className="window-queue">
          {windows.map((item) => (
            <button
              key={item.window.id}
              className="queue-item"
              data-selected={item.window.id === selectedWindowId || undefined}
              data-labeled={item.label != null || undefined}
              disabled={saving}
              onClick={() => setSelectedWindowId(item.window.id)}
            >
              <span className="queue-title">{item.conversation.title}</span>
              <span className="queue-meta">
                W{item.window.ordinal} · {item.window.focalMessageCount} focal ·{' '}
                {item.prediction.dominant ?? 'unknown'}
              </span>
              <span className="queue-status">{item.label ? item.label.dominant ?? 'labeled' : 'open'}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="labeling-workspace">
        <header className="labeling-header">
          <div className="header-copy">
            <span className="label">Selected window</span>
            <h2>{selectedSummary?.conversation.title ?? 'No window selected'}</h2>
            <p>
              {selectedSummary
                ? `Run ${selectedSummary.run.id} · window ${selectedSummary.window.ordinal} · ordinals ${selectedSummary.window.startOrdinal}-${selectedSummary.window.endOrdinal}`
                : 'Create a baseline run from the dashboard first.'}
            </p>
          </div>
          <div className="labeling-actions">
            <button
              type="button"
              onClick={() => selectOffset(-1)}
              disabled={saving || selectedIndex <= 0}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => selectOffset(1)}
              disabled={saving || selectedIndex < 0 || selectedIndex >= windows.length - 1}
            >
              Next
            </button>
            <button
              type="button"
              onClick={selectNextUnlabeled}
              disabled={saving || unlabeledCount === 0}
            >
              Next open
            </button>
            <button
              type="button"
              onClick={() => void exportTask()}
              disabled={exporting || !detail?.label}
              title="Write this labeled window as a Harbor eval task"
            >
              {exporting ? 'Exporting...' : 'Export Harbor task'}
            </button>
          </div>
        </header>

        <div className="labeling-grid">
          <section className="message-panel">
            <div className="panel-head compact">
              <div>
                <span className="label">Messages</span>
                <h3>Conversation context</h3>
              </div>
              {detail && (
                <span className="window-counts">
                  {detail.beforeMessages.length} before · {detail.allMessages.length} window ·{' '}
                  {detail.afterMessages.length} after
                </span>
              )}
            </div>

            {detailError && <div className="labeling-state error">{detailError}</div>}
            {detailLoading && <div className="labeling-state">Loading messages...</div>}
            {!detailLoading && detail && (
              <div className="message-list">
                <MessageGroup
                  title="Previous conversation"
                  empty="No earlier messages in the loaded context."
                  messages={detail.beforeMessages}
                  contextIds={contextIds}
                  focalIds={focalIds}
                />
                <MessageGroup
                  title="Window to label"
                  empty="No messages found for this window."
                  messages={detail.allMessages}
                  contextIds={contextIds}
                  focalIds={focalIds}
                />
                <MessageGroup
                  title="Following conversation"
                  empty="No later messages in the loaded context."
                  messages={detail.afterMessages}
                  contextIds={contextIds}
                  focalIds={focalIds}
                />
              </div>
            )}
          </section>

          <aside className="label-panel">
            <section className="annotation-section">
              <div className="panel-head compact">
                <div>
                  <span className="label">Human label</span>
                  <h3>Emotion state</h3>
                </div>
                {saveStatus && <span className={saveStatus.includes('failed') ? 'save error' : 'save'}>{saveStatus}</span>}
              </div>

              <DominantSelect
                value={draft.dominant}
                onChange={(dominant) => setDraft((current) => ({ ...current, dominant }))}
              />

              <div className="control-label">Also plausible</div>
              <div className="anchor-grid">
                {EKMAN_ANCHORS.map((anchor) => (
                  <label key={anchor} className="anchor-check">
                    <input
                      type="checkbox"
                      checked={draft.acceptableDominants.includes(anchor)}
                      onChange={() => toggleAnchor(anchor, setDraft)}
                    />
                    <span
                      className="anchor-swatch"
                      style={{ background: ANCHOR_DISPLAY[anchor].color }}
                    />
                    {ANCHOR_DISPLAY[anchor].label}
                  </label>
                ))}
              </div>

              <div className="binary-row">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.requiresContext}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        requiresContext: event.target.checked,
                      }))
                    }
                  />
                  Needs conversation context
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.sarcasmOrSubtext}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        sarcasmOrSubtext: event.target.checked,
                      }))
                    }
                  />
                  Sarcasm/subtext
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.ambiguous}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        ambiguous: event.target.checked,
                      }))
                    }
                  />
                  Ambiguous or mixed
                </label>
              </div>

              <label className="field">
                <span>Labeling notes</span>
                <textarea
                  value={draft.notes}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="What should another LLM infer from this window? Mention tone, context dependency, sarcasm, or why multiple emotions fit."
                  rows={5}
                />
              </label>

              <button
                type="button"
                className="save-button"
                disabled={!detail || saving}
                onClick={() => void saveLabel()}
              >
                {saving ? 'Saving...' : 'Save label'}
              </button>
            </section>

            <section className="prediction-section">
              <div className="panel-head compact">
                <div>
                  <span className="label">Model guess</span>
                  <h3>{detail?.prediction.dominant ?? 'No prediction'}</h3>
                </div>
                {detail?.prediction.confidence != null && (
                  <span className="confidence">{formatScore(detail.prediction.confidence)}</span>
                )}
              </div>
              <div className="prediction-bars">
                {EKMAN_ANCHORS.map((anchor) => {
                  const value = detail?.prediction.scores[anchor] ?? 0
                  return (
                    <div key={anchor} className="prediction-row">
                      <span>{ANCHOR_DISPLAY[anchor].label}</span>
                      <div className="prediction-track">
                        <span
                          style={{
                            width: `${Math.round(value * 100)}%`,
                            background: ANCHOR_DISPLAY[anchor].color,
                          }}
                        />
                      </div>
                      <output>{formatScore(value)}</output>
                    </div>
                  )
                })}
              </div>
              {detail?.prediction.summary && <p>{detail.prediction.summary}</p>}
            </section>
          </aside>
        </div>
      </section>
    </main>
  )
}

function DominantSelect({
  value,
  onChange,
}: {
  value: EmotionAnchor | ''
  onChange(value: EmotionAnchor | ''): void
}) {
  return (
    <div className="field select-field">
      <span>Dominant</span>
      <Select.Root<EmotionAnchor | null>
        value={value || null}
        onValueChange={(nextValue) => onChange(nextValue ?? '')}
      >
        <Select.Trigger className="select-trigger">
          <Select.Value placeholder="Unlabeled">
            {(selected: EmotionAnchor | null) =>
              selected ? ANCHOR_DISPLAY[selected].label : 'Unlabeled'
            }
          </Select.Value>
          <Select.Icon className="select-icon">v</Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className="select-positioner" sideOffset={4}>
            <Select.Popup className="select-popup">
              <Select.Item className="select-item" value={null}>
                <Select.ItemText>Unlabeled</Select.ItemText>
                <Select.ItemIndicator className="select-indicator" />
              </Select.Item>
              {EKMAN_ANCHORS.map((anchor) => (
                <Select.Item key={anchor} className="select-item" value={anchor}>
                  <span
                    className="anchor-swatch"
                    style={{ background: ANCHOR_DISPLAY[anchor].color }}
                  />
                  <Select.ItemText>{ANCHOR_DISPLAY[anchor].label}</Select.ItemText>
                  <Select.ItemIndicator className="select-indicator" />
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  )
}

function MessageGroup({
  title,
  empty,
  messages,
  contextIds,
  focalIds,
}: {
  title: string
  empty: string
  messages: WindowMessage[]
  contextIds: Set<number>
  focalIds: Set<number>
}) {
  return (
    <section className="message-group">
      <div className="message-group-title">
        <span>{title}</span>
        <span>{messages.length} messages</span>
      </div>
      {messages.length === 0 ? (
        <div className="message-empty">{empty}</div>
      ) : (
        messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            inContext={contextIds.has(message.id)}
            inFocal={focalIds.has(message.id)}
          />
        ))
      )}
    </section>
  )
}

function MessageRow({
  message,
  inContext,
  inFocal,
}: {
  message: WindowMessage
  inContext: boolean
  inFocal: boolean
}) {
  const sliceLabel =
    message.slice === 'before' || message.slice === 'after'
      ? message.slice
      : inFocal
        ? 'focal'
        : inContext
          ? 'context'
          : 'window'

  return (
    <article className="label-message" data-from-me={message.isFromMe || undefined}>
      <div className="message-meta">
        <span>#{message.conversationOrdinal}</span>
        <span>{message.isFromMe ? 'Me' : message.senderName ?? 'Them'}</span>
        <span>{formatDateTime(message.sentAt)}</span>
        <span className={inFocal ? 'slice focal' : 'slice'}>{sliceLabel}</span>
      </div>
      <p>{message.text || '[attachment or empty message]'}</p>
    </article>
  )
}

function draftFromLabel(label: WindowLabel | null): Draft {
  if (!label) return { ...EMPTY_DRAFT }
  return {
    dominant: label.dominant ?? '',
    acceptableDominants: label.acceptableDominants,
    requiresContext: label.requiresContext ?? false,
    sarcasmOrSubtext: label.sarcasmOrSubtext ?? false,
    ambiguous: label.ambiguity === 'medium' || label.ambiguity === 'high',
    notes: label.notes ?? '',
  }
}

function toggleAnchor(anchor: EmotionAnchor, setDraft: Dispatch<SetStateAction<Draft>>) {
  setDraft((current) => ({
    ...current,
    acceptableDominants: current.acceptableDominants.includes(anchor)
      ? current.acceptableDominants.filter((item) => item !== anchor)
      : [...current.acceptableDominants, anchor],
  }))
}

function formatScore(value: number): string {
  return value.toFixed(2)
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}
