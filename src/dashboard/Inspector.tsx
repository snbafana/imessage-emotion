import { Progress } from '@base-ui/react/progress'
import { EMOTIONS, SELECTED_WINDOW } from './data'
import { BulbIcon } from './icons'

export default function Inspector() {
  const w = SELECTED_WINDOW
  const emotion = EMOTIONS[w.emotion]

  return (
    <section className="panel inspector">
      <div className="inspector-head">
        <span className="dot" style={{ background: emotion.color }} />
        <div className="titles">
          <span className="t1">{w.label}</span>
          <span className="t2">{w.sub}</span>
        </div>
        <div
          className="emotion-pill"
          style={{
            background: `color-mix(in oklch, ${emotion.color} 16%, #fff)`,
            color: emotion.ink,
          }}
        >
          <span>{emotion.label}</span>
          <span className="val">{w.score}</span>
        </div>
      </div>

      <div className="inspector-body">
        <div className="trace">
          <span className="label">Message trace</span>
          {w.messages.map((m, i) => (
            <div key={i} className={`msg ${m.from}`}>
              <div className="bubble">{m.text}</div>
              <span className="time">{m.time}</span>
            </div>
          ))}
        </div>

        <div className="reasoning">
          <div className="head">
            <BulbIcon />
            <span className="label">Why this shifted</span>
          </div>
          <p>{w.reasoning}</p>
          <div className="drivers">
            {w.drivers.map((d) => (
              <div key={d.label} className="driver">
                <span className="name">{d.label}</span>
                <Progress.Root className="driver-progress" value={d.value} max={100}>
                  <Progress.Track className="driver-track">
                    <Progress.Indicator
                      className="driver-indicator"
                      style={{ background: d.color }}
                    />
                  </Progress.Track>
                </Progress.Root>
                <span className="pct">{(d.value / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
