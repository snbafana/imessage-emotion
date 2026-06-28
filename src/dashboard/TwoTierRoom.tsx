'use client'

import { useEffect, useRef, useState } from 'react'
import { ANCHOR_DISPLAY, EKMAN_ANCHORS, type Anchor } from '../lib/emotion/anchors'

type Tier = 'fast' | 'reasoned'
type Card = {
  id: number
  ordinal: number
  focal: string
  scores?: Record<string, number>
  dominant?: string
  confidence?: number
  rationale?: string
  shift?: number
  tier: Tier
}

export default function TwoTierRoom({
  conversationId,
  title,
  focal = 4,
  stride = 1,
  topK = 25,
  onClose,
  onDone,
}: {
  conversationId: number
  title?: string
  focal?: number
  stride?: number
  topK?: number
  onClose: () => void
  onDone: (runId: number) => void
}) {
  const [cards, setCards] = useState<Map<number, Card>>(new Map())
  const [total, setTotal] = useState(0)
  const [phase, setPhase] = useState<'triage' | 'explore' | 'done' | 'error'>('triage')
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const params = new URLSearchParams({
      conversationId: String(conversationId),
      focal: String(focal),
      stride: String(stride),
      topK: String(topK),
    })
    const es = new EventSource(`/api/two-tier?${params}`)

    es.onmessage = (event) => {
      const msg = JSON.parse(event.data) as Record<string, unknown>
      const type = msg.type as string
      if (type === 'setup') {
        setTotal(Number(msg.total))
      } else if (type === 'triage') {
        setCards((prev) => {
          const next = new Map(prev)
          next.set(Number(msg.windowId), {
            id: Number(msg.windowId),
            ordinal: Number(msg.ordinal),
            focal: String(msg.focal ?? ''),
            scores: msg.scores as Record<string, number>,
            dominant: msg.dominant as string,
            shift: Number(msg.shift),
            tier: 'fast',
          })
          return next
        })
      } else if (type === 'explore') {
        setPhase('explore')
        setCards((prev) => {
          const next = new Map(prev)
          const id = Number(msg.windowId)
          const existing = next.get(id)
          next.set(id, {
            id,
            ordinal: Number(msg.ordinal),
            focal: existing?.focal ?? '',
            scores: msg.scores as Record<string, number>,
            dominant: msg.dominant as string,
            confidence: Number(msg.confidence),
            rationale: (msg.rationale as string) ?? undefined,
            shift: existing?.shift,
            tier: 'reasoned',
          })
          return next
        })
      } else if (type === 'done') {
        setPhase('done')
        setSummary(String(msg.summary ?? ''))
        onDoneRef.current(Number(msg.runId))
        es.close()
      } else if (type === 'error') {
        setPhase('error')
        setError(String(msg.message ?? 'analysis failed'))
        es.close()
      }
    }
    es.onerror = () => {
      setPhase((p) => (p === 'done' ? p : 'error'))
      es.close()
    }
    return () => es.close()
  }, [conversationId, focal, stride, topK])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const list = [...cards.values()].sort((a, b) => a.ordinal - b.ordinal)
  const triaged = list.length
  const reasoned = list.filter((c) => c.tier === 'reasoned').length
  const busy = phase === 'triage' || phase === 'explore'

  return (
    <div className="control-room">
      <div className="cr-topbar">
        <div className="cr-head">
          <div className="cr-title-row">
            <span className="cr-title">RoBERTa → RLM · {title ?? 'conversation'}</span>
            <span className="cr-meta">two-tier · {total || '…'} windows · Esc to close</span>
          </div>
          <div className="cr-progress-row">
            <div className="cr-track">
              <div className="cr-fill" style={{ width: `${total ? (triaged / total) * 100 : 4}%` }} />
            </div>
            <span className="cr-meta">
              {triaged} / {total} triaged · {reasoned} deep-read{phase === 'triage' ? ' · scanning…' : ''}
            </span>
          </div>
        </div>
        <span className="cr-live">
          <span className="cr-dot" style={{ background: busy ? '#2EE6A6' : '#C9C9CE' }} />
          {phase === 'error' ? 'error' : busy ? 'live' : 'done'}
        </span>
        <button className="cr-close" onClick={onClose}>
          {busy ? 'Hide' : 'Close'}
        </button>
      </div>

      {error && <div className="cr-empty">{error}</div>}
      {summary && (
        <div className="cr-summary">
          <strong>Synthesis:</strong> {summary}
        </div>
      )}

      <div className="cr-grid">
        {list.length === 0 && <div className="cr-empty">Loading RoBERTa…</div>}
        {list.map((card) => (
          <WindowCard key={card.id} card={card} />
        ))}
      </div>
    </div>
  )
}

function WindowCard({ card }: { card: Card }) {
  const reasoned = card.tier === 'reasoned'
  const domInk = card.dominant ? ANCHOR_DISPLAY[card.dominant as Anchor]?.ink ?? '#6B6B70' : '#9A9AA0'
  return (
    <div className={`cr-card ${reasoned ? 'reading' : ''}`}>
      <div className="cr-card-head">
        <span className="cr-w">W{card.ordinal}</span>
        <span className="cr-focal">{card.focal}</span>
        <span
          className="cr-dot"
          style={{ background: reasoned ? 'oklch(0.69 0.12 182)' : '#C9C9CE' }}
        />
        <span className="cr-state">{reasoned ? 'rlm' : 'roberta'}</span>
      </div>
      <div className="cr-bars">
        {EKMAN_ANCHORS.map((a) => {
          const v = card.scores?.[a] ?? 0
          return (
            <div
              key={a}
              className="cr-bar"
              title={`${ANCHOR_DISPLAY[a].label} ${v.toFixed(2)}`}
              style={{ height: `${Math.max(3, Math.round(v * 38))}px`, background: card.scores ? ANCHOR_DISPLAY[a].color : '#ECECEE' }}
            />
          )
        })}
      </div>
      <div className="cr-card-foot">
        <span className="cr-dom" style={{ color: domInk }}>
          {card.dominant ?? '—'}
        </span>
        <span className="cr-conf">
          {reasoned && card.confidence != null ? `conf ${card.confidence.toFixed(2)}` : card.shift != null ? `shift ${card.shift.toFixed(2)}` : ''}
        </span>
      </div>
      {reasoned && card.rationale && <div className="cr-why">{card.rationale}</div>}
    </div>
  )
}
