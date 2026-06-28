'use client'

import { useEffect, useRef, useState } from 'react'
import { ANCHOR_DISPLAY, EKMAN_ANCHORS, type Anchor } from '../lib/emotion/anchors'
import { getWindowMessages, type DashboardApi, type MessageView, type WindowView } from './data'

type CardState = 'queued' | 'reading' | 'scored' | 'error'
type Card = {
  id: number
  ordinal: number
  focal?: string
  state: CardState
  scores?: Record<string, number>
  dominant?: string
  confidence?: number
  rationale?: string
}

// Build the live grid from the current run's windows. The dashboard polls the
// scoring run window-by-window (see startAxRun), so this lights up in real time
// as each window flips from queued → scored during a recompute.
function cardsFromWindows(windows: WindowView[]): Card[] {
  return windows
    .map((w) => {
      const result = w.result as { confidence?: unknown; rationale?: unknown }
      const scored = w.dominant != null && Object.keys(w.scores ?? {}).length > 0
      const rationale =
        (typeof result?.rationale === 'string' ? result.rationale : undefined) ??
        (w.summary && w.summary !== 'No result summary yet.' ? w.summary : undefined)
      return {
        id: Number(w.rawId),
        ordinal: w.ordinal,
        focal: `${w.focalStartOrdinal}-${w.focalEndOrdinal}`,
        state: (w.error ? 'error' : scored ? 'scored' : 'queued') as CardState,
        scores: scored ? (w.scores as Record<string, number>) : undefined,
        dominant: w.dominant ?? undefined,
        confidence: typeof result?.confidence === 'number' ? result.confidence : undefined,
        rationale,
      }
    })
    .sort((a, b) => a.ordinal - b.ordinal)
}

const DOT: Record<CardState, string> = {
  scored: 'oklch(0.69 0.12 182)',
  reading: '#2EE6A6',
  error: '#D6453B',
  queued: '#C9C9CE',
}

function WindowCard({ card, focal }: { card: Card; focal: MessageView[] | undefined }) {
  const domInk = card.dominant
    ? ANCHOR_DISPLAY[card.dominant as Anchor]?.ink ?? '#6B6B70'
    : '#9A9AA0'
  // Show the tail of the focal slice — the messages most likely to drive the shift.
  const excerpt = (focal ?? []).filter((m) => m.text.trim().length > 0).slice(-3)
  return (
    <div className={`cr-card ${card.state}`}>
      <div className="cr-card-head">
        <span className="cr-w">W{card.ordinal}</span>
        <span className="cr-focal">{card.focal}</span>
        <span className="cr-dot" style={{ background: DOT[card.state] }} />
        <span className="cr-state">{card.state}</span>
      </div>

      <div className="cr-excerpt">
        {excerpt.length === 0 ? (
          <span className="cr-excerpt-empty">{focal ? 'no text in focal slice' : 'loading messages…'}</span>
        ) : (
          excerpt.map((m) => (
            <div key={m.id} className={`cr-line ${m.from}`}>
              <span className="cr-line-who">{m.from === 'me' ? 'you' : 'them'}</span>
              <span className="cr-line-text">{m.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="cr-bars">
        {EKMAN_ANCHORS.map((a) => {
          const v = card.scores?.[a] ?? 0
          return (
            <div
              key={a}
              className="cr-bar"
              title={`${ANCHOR_DISPLAY[a].label} ${v.toFixed(2)}`}
              style={{
                height: `${Math.max(3, Math.round(v * 38))}px`,
                background: card.scores ? ANCHOR_DISPLAY[a].color : '#ECECEE',
              }}
            />
          )
        })}
      </div>

      <div className="cr-card-foot">
        <span className="cr-dom" style={{ color: domInk }}>
          {card.dominant ?? (card.state === 'reading' ? 'scoring…' : card.state === 'queued' ? 'queued' : '—')}
        </span>
        <span className="cr-conf">{card.confidence != null ? `conf ${card.confidence.toFixed(2)}` : ''}</span>
      </div>

      {(card.rationale || card.state === 'reading') && (
        <div className="cr-why">
          {card.rationale ?? <span className="cr-why-pending">reading the window…</span>}
        </div>
      )}
    </div>
  )
}

export default function ControlRoom({
  api,
  windows = [],
  title,
  busy = false,
  onClose,
}: {
  api: DashboardApi | null
  windows?: WindowView[]
  title?: string
  busy?: boolean
  onClose: () => void
}) {
  const cards = cardsFromWindows(windows)
  // While a run is scoring, windows that haven't flipped to scored yet are the
  // ones still being read — surface that as the "reading" count.
  const scored = cards.filter((c) => c.state === 'scored').length
  const reading = busy ? cards.filter((c) => c.state === 'queued').length : 0

  // Esc closes the control room.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Pull each window's focal messages so every card can show "what folks are
  // saying" as soon as the window appears — independent of the scorer.
  const [focals, setFocals] = useState<Record<number, MessageView[]>>({})
  const fetched = useRef<Set<number>>(new Set())
  useEffect(() => {
    for (const card of cards) {
      if (fetched.current.has(card.id) || !api?.getWindowMessages) continue
      fetched.current.add(card.id)
      void getWindowMessages(api, card.id, 'focal')
        .then((messages) => setFocals((prev) => ({ ...prev, [card.id]: messages })))
        .catch(() => fetched.current.delete(card.id))
    }
  }, [api, cards])

  return (
    <div className="control-room">
      <div className="cr-topbar">
        <div className="cr-head">
          <div className="cr-title-row">
            <span className="cr-title">
              {busy ? 'Recomputing ' : ''}
              {title ?? 'conversation'}
            </span>
            <span className="cr-meta">ax · {cards.length || '…'} windows · Esc to close</span>
          </div>
          <div className="cr-progress-row">
            <div className="cr-track">
              <div className="cr-fill" style={{ width: `${cards.length ? (scored / cards.length) * 100 : 4}%` }} />
            </div>
            <span className="cr-meta">
              {scored} / {cards.length} scored{busy ? ` · ${reading} reading` : ''}
            </span>
          </div>
        </div>
        <span className="cr-live">
          <span className="cr-dot" style={{ background: busy ? '#2EE6A6' : '#C9C9CE' }} />
          {busy ? 'live' : 'done'}
        </span>
        <button className="cr-close" onClick={onClose}>
          {busy ? 'Hide' : 'Close'}
        </button>
      </div>
      <div className="cr-grid">
        {cards.length === 0 && <div className="cr-empty">Spinning up window readers…</div>}
        {cards.map((card) => (
          <WindowCard key={card.id} card={card} focal={focals[card.id]} />
        ))}
      </div>
    </div>
  )
}
