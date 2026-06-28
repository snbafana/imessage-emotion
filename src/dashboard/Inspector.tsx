import { Progress } from '@base-ui/react/progress'
import type { MessageView, RunView, WindowView } from './data'
import { EMOTIONS, SCORE_KEYS, runStateLabel } from './data'

export default function Inspector({
  run,
  window,
  contextMessages,
  focalMessages,
  loading,
  error,
}: {
  run: RunView | null
  window: WindowView | null
  contextMessages: MessageView[]
  focalMessages: MessageView[]
  loading: boolean
  error: string | null
}) {
  const dominant = window?.dominant ?? 'neutral'
  const emotion = EMOTIONS[dominant]
  const stateLabel = runStateLabel(run, window ? [window] : [])
  const explanation = window ? explainWindow(window, focalMessages) : stateLabel

  return (
    <section className="panel inspector">
      <div className="inspector-head">
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
                <span className="label">
                  {window?.dominant ? `Why this reads ${emotion.label.toLowerCase()}` : 'Window explanation'}
                </span>
              </div>
              <p>{explanation}</p>
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

function explainWindow(window: WindowView, focalMessages: MessageView[]): string {
  const summary = window.summary.trim()
  const baselineOnly = summary.toLowerCase().includes('baseline lexical pass')
  if (!baselineOnly) return summary

  const dominant = window.dominant ?? 'neutral'
  const score = window.scores[dominant] ?? window.intensity
  const label = EMOTIONS[dominant].label.toLowerCase()
  const sample = focalMessages
    .map((message) => message.text.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' / ')

  if (dominant === 'neutral') {
    return sample
      ? `Reads as neutral because the focal messages are mostly logistical or low-affect replies (${sample}) and the other emotion scores stay near zero.`
      : 'Reads as neutral because this window has no strong emotional signals in the current scored messages and the non-neutral scores stay near zero.'
  }

  return `Reads as ${label} because that emotion is the strongest signal in this window (${score.toFixed(
    2,
  )}), with weaker competing emotion scores.`
}

function MessageGroup({
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
}
