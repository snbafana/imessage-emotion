import { memo } from 'react'
import { Progress } from '@base-ui/react/progress'
import type { MessageView, RunView, WindowView } from './data'
import { EMOTIONS, SCORE_KEYS, runStateLabel } from './data'
import { BulbIcon } from './icons'

type InspectorProps = {
  run: RunView | null
  window: WindowView | null
  contextMessages: MessageView[]
  focalMessages: MessageView[]
  loading: boolean
  error: string | null
}

function Inspector({
  run,
  window,
  contextMessages,
  focalMessages,
  loading,
  error,
}: InspectorProps) {
  const dominant = window?.dominant ?? 'neutral'
  const emotion = EMOTIONS[dominant]
  const stateLabel = runStateLabel(run, window ? [window] : [])

  return (
    <section className="panel inspector">
      <div className="inspector-head">
        <span className="dot" style={{ background: emotion.color }} />
        <div className="titles">
          <span className="t1">{window?.label ?? stateLabel}</span>
          <span className="t2">
            {window
              ? `context ${window.contextStartOrdinal ?? '-'}-${window.contextEndOrdinal ?? '-'} · focal ${window.focalStartOrdinal}-${window.focalEndOrdinal}`
              : 'select a scored run window'}
          </span>
        </div>
        <div
          className="emotion-pill"
          style={{
            background: `color-mix(in oklch, ${emotion.color} 16%, #fff)`,
            color: emotion.ink,
          }}
        >
          <span>{window?.dominant ? emotion.label : run?.state ?? 'idle'}</span>
          {window && <span className="val">{window.intensity.toFixed(2)}</span>}
        </div>
      </div>

      <div className="inspector-body">
        {loading ? (
          <div className="empty-panel">Loading selected window messages...</div>
        ) : error ? (
          <div className="empty-panel error">{error}</div>
        ) : !window ? (
          <div className="empty-panel">{stateLabel}</div>
        ) : (
          <>
            <MessageGroup
              label="Old context"
              sub={`${window.contextMessageCount} messages`}
              messages={contextMessages}
              empty="No context messages for this window."
            />
            <MessageGroup
              label="New focal"
              sub={`${window.focalMessageCount} messages`}
              messages={focalMessages}
              empty="No focal messages for this window."
            />

            <div className="reasoning">
              <div className="head">
                <BulbIcon />
                <span className="label">Result JSON summary</span>
              </div>
              <p>{window.rationale ?? window.summary}</p>
              {window.error && <p className="error-text">{window.error}</p>}
              <div className="drivers">
                {SCORE_KEYS.map((key) => {
                  const value = window.scores[key] ?? 0
                  const emotionForScore = EMOTIONS[key]
                  return (
                    <div key={key} className="driver">
                      <span className="name">{emotionForScore.label}</span>
                      <Progress.Root className="driver-progress" value={value} max={1}>
                        <Progress.Track className="driver-track">
                          <Progress.Indicator
                            className="driver-indicator"
                            style={{ background: emotionForScore.color }}
                          />
                        </Progress.Track>
                      </Progress.Root>
                      <span className="pct">{value.toFixed(2)}</span>
                      {window.scoreRationales[key] && (
                        <span className="driver-reason">{window.scoreRationales[key]}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

export default memo(Inspector, sameInspectorProps)

const MessageGroup = memo(function MessageGroup({
  label,
  sub,
  messages,
  empty,
}: {
  label: string
  sub: string
  messages: MessageView[]
  empty: string
}) {
  return (
    <div className="trace">
      <div className="trace-head">
        <span className="label">{label}</span>
        <span>{sub}</span>
      </div>
      {messages.length === 0 ? (
        <div className="empty-trace">{empty}</div>
      ) : (
        messages.map((message) => (
          <div key={message.id} className={`msg ${message.from}`}>
            <div className="bubble">{message.text}</div>
            <span className="time">{message.time}</span>
          </div>
        ))
      )}
    </div>
  )
})

function sameInspectorProps(previous: InspectorProps, next: InspectorProps): boolean {
  return (
    previous.loading === next.loading &&
    previous.error === next.error &&
    previous.contextMessages === next.contextMessages &&
    previous.focalMessages === next.focalMessages &&
    sameRunView(previous.run, next.run) &&
    sameWindowView(previous.window, next.window)
  )
}

function sameRunView(previous: RunView | null, next: RunView | null): boolean {
  if (previous === next) return true
  if (!previous || !next) return previous === next
  return (
    previous.id === next.id &&
    previous.rawId === next.rawId &&
    previous.state === next.state &&
    previous.status === next.status &&
    previous.error === next.error
  )
}

function sameWindowView(previous: WindowView | null, next: WindowView | null): boolean {
  if (previous === next) return true
  if (!previous || !next) return previous === next
  return (
    previous.id === next.id &&
    previous.rawId === next.rawId &&
    previous.status === next.status &&
    previous.state === next.state &&
    previous.label === next.label &&
    previous.contextStartOrdinal === next.contextStartOrdinal &&
    previous.contextEndOrdinal === next.contextEndOrdinal &&
    previous.focalStartOrdinal === next.focalStartOrdinal &&
    previous.focalEndOrdinal === next.focalEndOrdinal &&
    previous.contextMessageCount === next.contextMessageCount &&
    previous.focalMessageCount === next.focalMessageCount &&
    previous.dominant === next.dominant &&
    previous.intensity === next.intensity &&
    previous.summary === next.summary &&
    previous.rationale === next.rationale &&
    previous.error === next.error &&
    SCORE_KEYS.every(
      (key) =>
        previous.scores[key] === next.scores[key] &&
        previous.scoreRationales[key] === next.scoreRationales[key],
    )
  )
}
