import { Tabs } from '@base-ui/react/tabs'
import { AXIS_YEARS, EMOTIONS, TIMELINE, VALENCE_PATH, gradientFor } from './data'

const WINDOWS = ['Week', 'Month', 'Quarter']

export default function EmotionTimeline({
  selected,
  onSelectBlock,
}: {
  selected: number
  onSelectBlock: (i: number) => void
}) {
  return (
    <section className="timeline-panel">
      <div className="panel-head">
        <div className="heading">
          <span className="label">Emotional timeline</span>
          <div className="title-row">
            <h1>Warming</h1>
            <span className="trend-note">▲ trust &amp; joy rising</span>
          </div>
        </div>

        <Tabs.Root className="window-toggle" defaultValue="Week">
          <Tabs.List className="toggle-list" aria-label="Window size">
            {WINDOWS.map((w) => (
              <Tabs.Tab key={w} className="tab" value={w}>
                {w}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.Root>
      </div>

      <div className="chart">
        <div className="plot">
          {[0, 70, 140].map((top) => (
            <div key={top} className="gridline" style={{ top }} />
          ))}

          {TIMELINE.map((b, i) => (
            <div
              key={i}
              className={`block${i === selected ? ' selected' : ''}`}
              style={{ height: `${20 + b.intensity * 170}px`, background: gradientFor(b.composition) }}
              onClick={() => onSelectBlock(i)}
              title={EMOTIONS[b.composition[0].emotion].label}
            />
          ))}

          <div className="line-overlay">
            <svg
              width="100%"
              height="210"
              viewBox="0 0 1000 210"
              preserveAspectRatio="none"
              fill="none"
            >
              {[
                { stroke: '#fff', strokeWidth: 6 },
                { stroke: '#0a0a0b', strokeWidth: 2.25 },
              ].map((p) => (
                <path
                  key={p.stroke}
                  d={VALENCE_PATH}
                  stroke={p.stroke}
                  strokeWidth={p.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          </div>
        </div>

        <div className="axis">
          {AXIS_YEARS.map((y) => (
            <span key={y}>{y}</span>
          ))}
        </div>
      </div>
    </section>
  )
}
