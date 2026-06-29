import type { ReactNode } from 'react'
import { ANCHOR_DISPLAY, EKMAN_ANCHORS, type Anchor } from '../../lib/emotion/anchors'

export const ROOM_ACTIVE_COLOR = '#2EE6A6'
export const ROOM_IDLE_COLOR = '#C9C9CE'
export const ROOM_SCORED_COLOR = 'oklch(0.69 0.12 182)'
export const ROOM_ERROR_COLOR = '#D6453B'

export function dominantInk(dominant: string | null | undefined): string {
  return dominant ? ANCHOR_DISPLAY[dominant as Anchor]?.ink ?? '#6B6B70' : '#9A9AA0'
}

export function EmotionBars({ scores }: { scores?: Record<string, number> }) {
  return (
    <div className="cr-bars">
      {EKMAN_ANCHORS.map((anchor) => {
        const value = scores?.[anchor] ?? 0
        return (
          <div
            key={anchor}
            className="cr-bar"
            title={`${ANCHOR_DISPLAY[anchor].label} ${value.toFixed(2)}`}
            style={{
              height: `${Math.max(3, Math.round(value * 38))}px`,
              background: scores ? ANCHOR_DISPLAY[anchor].color : '#ECECEE',
            }}
          />
        )
      })}
    </div>
  )
}

export function RoomShell({
  title,
  meta,
  progressPercent,
  progressLabel,
  live,
  liveLabel,
  closeLabel,
  onClose,
  children,
}: {
  title: ReactNode
  meta: ReactNode
  progressPercent: number
  progressLabel: ReactNode
  live: boolean
  liveLabel: ReactNode
  closeLabel: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const width = `${Math.max(0, Math.min(100, progressPercent))}%`
  return (
    <div className="control-room">
      <div className="cr-topbar">
        <div className="cr-head">
          <div className="cr-title-row">
            <span className="cr-title">{title}</span>
            <span className="cr-meta">{meta}</span>
          </div>
          <div className="cr-progress-row">
            <div className="cr-track">
              <div className="cr-fill" style={{ width }} />
            </div>
            <span className="cr-meta">{progressLabel}</span>
          </div>
        </div>
        <span className="cr-live">
          <span className="cr-dot" style={{ background: live ? ROOM_ACTIVE_COLOR : ROOM_IDLE_COLOR }} />
          {liveLabel}
        </span>
        <button type="button" className="cr-close" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      {children}
    </div>
  )
}
