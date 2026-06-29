'use client'

import { useEffect, useRef, useState } from 'react'
import { useEscapeKey } from '../shared/useEscapeKey'
import { dominantInk, EmotionBars, RoomShell, ROOM_IDLE_COLOR, ROOM_SCORED_COLOR } from './RoomShell'

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

  useEscapeKey(onClose)

  const list = [...cards.values()].sort((a, b) => a.ordinal - b.ordinal)
  const triaged = list.length
  const reasoned = list.filter((c) => c.tier === 'reasoned').length
  const busy = phase === 'triage' || phase === 'explore'

  return (
    <RoomShell
      title={`RoBERTa → RLM · ${title ?? 'conversation'}`}
      meta={`two-tier · ${total || '…'} windows`}
      progressPercent={total ? (triaged / total) * 100 : 4}
      progressLabel={`${triaged} / ${total} triaged · ${reasoned} deep-read${phase === 'triage' ? ' · scanning…' : ''}`}
      live={busy}
      liveLabel={phase === 'error' ? 'error' : busy ? 'live' : 'done'}
      closeLabel={busy ? 'Hide' : 'Close'}
      onClose={onClose}
    >

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
    </RoomShell>
  )
}

function WindowCard({ card }: { card: Card }) {
  const reasoned = card.tier === 'reasoned'
  return (
    <div className={`cr-card ${reasoned ? 'reading' : ''}`}>
      <div className="cr-card-head">
        <span className="cr-w">W{card.ordinal}</span>
        <span className="cr-focal">{card.focal}</span>
        <span
          className="cr-dot"
          style={{ background: reasoned ? ROOM_SCORED_COLOR : ROOM_IDLE_COLOR }}
        />
        <span className="cr-state">{reasoned ? 'rlm' : 'roberta'}</span>
      </div>
      <EmotionBars scores={card.scores} />
      <div className="cr-card-foot">
        <span className="cr-dom" style={{ color: dominantInk(card.dominant) }}>
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
