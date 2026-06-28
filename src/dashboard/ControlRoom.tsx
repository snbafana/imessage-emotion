'use client'

import { useEffect, useRef, useState } from 'react'
import type { EveMessageData, UseEveAgentHelpers } from 'eve/react'
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

// Derive the live grid from the eve session stream: recompute_conversation gives
// the window plan; each score_window tool-call's lifecycle gives a window's state.
function deriveCards(agent: UseEveAgentHelpers<EveMessageData>): Card[] {
  // Only the most recent recompute_conversation defines the current plan — a
  // durable session can hold earlier recomputes whose windows we must not show.
  let plan = new Map<number, { ordinal: number; focal?: string }>()
  const score = new Map<number, { state: string; output?: Record<string, unknown> }>()

  for (const message of agent.data.messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.type !== 'dynamic-tool') continue
      const input = (part as { input?: unknown }).input as Record<string, unknown> | undefined
      const output = (part as { output?: unknown }).output as Record<string, unknown> | undefined
      if (part.toolName === 'recompute_conversation') {
        const windows = (output?.windows as Array<Record<string, unknown>>) ?? []
        if (windows.length === 0) continue
        plan = new Map()
        for (const w of windows) {
          if (typeof w.id === 'number') plan.set(w.id, { ordinal: Number(w.ordinal), focal: String(w.focal ?? '') })
        }
      }
      if (part.toolName === 'score_window' && typeof input?.windowId === 'number') {
        score.set(input.windowId, { state: part.state, output })
      }
    }
  }

  return [...plan.entries()]
    .map(([id, pl]) => {
      const s = score.get(id)
      let state: CardState = 'queued'
      let scores: Record<string, number> | undefined
      let dominant: string | undefined
      let confidence: number | undefined
      let rationale: string | undefined
      if (s) {
        if (s.state === 'output-available') {
          state = 'scored'
          scores = s.output?.scores as Record<string, number> | undefined
          dominant = s.output?.dominant as string | undefined
          confidence = s.output?.confidence as number | undefined
          rationale = (s.output?.rationale as string | undefined) ?? undefined
        } else if (s.state === 'output-error' || s.state === 'output-denied') {
          state = 'error'
        } else {
          state = 'reading'
        }
      }
      return { id, ordinal: pl.ordinal, focal: pl.focal, state, scores, dominant, confidence, rationale }
    })
    .sort((a, b) => a.ordinal - b.ordinal)
}

// Fallback when there's no live recompute in the session: render the current
// run's already-scored windows so the control room is a view you can open anytime.
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
  agent,
  api,
  windows = [],
  title,
  onClose,
}: {
  agent: UseEveAgentHelpers<EveMessageData>
  api: DashboardApi | null
  windows?: WindowView[]
  title?: string
  onClose: () => void
}) {
  const liveCards = deriveCards(agent)
  // Live recompute stream wins; otherwise show the current run's windows.
  const cards = liveCards.length > 0 ? liveCards : cardsFromWindows(windows)
  const scored = cards.filter((c) => c.state === 'scored').length
  const reading = cards.filter((c) => c.state === 'reading').length
  const busy = agent.status === 'submitted' || agent.status === 'streaming'

  // Esc closes the control room.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Pull each planned window's focal messages so every card can show "what folks
  // are saying" as soon as the window appears — independent of the scorer.
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
            <span className="cr-meta">ax · eve · {cards.length || '…'} windows · Esc to close</span>
          </div>
          <div className="cr-progress-row">
            <div className="cr-track">
              <div className="cr-fill" style={{ width: `${cards.length ? (scored / cards.length) * 100 : 4}%` }} />
            </div>
            <span className="cr-meta">
              {scored} / {cards.length} scored · {reading} reading
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
