import { Tabs } from '@base-ui/react/tabs'
import { AXIS_YEARS, EMOTIONS, TIMELINE, VALENCE_PATH } from './data'

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
          <div className="gridline" style={{ top: 0 }} />
          <div className="gridline" style={{ top: 70 }} />
          <div className="gridline" style={{ top: 140 }} />

          {TIMELINE.map((b, i) => (
            <div
              key={i}
              className={`block${i === selected ? ' selected' : ''}`}
              style={{ height: `${20 + b.intensity * 170}px`, background: EMOTIONS[b.emotion].color }}
              onClick={() => onSelectBlock(i)}
              title={EMOTIONS[b.emotion].label}
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
              <path
                d={VALENCE_PATH}
                stroke="#fff"
                strokeWidth={6}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={VALENCE_PATH}
                stroke="#0a0a0b"
                strokeWidth={2.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
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
