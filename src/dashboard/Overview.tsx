import { formatMessageCount, type ConversationView, type OverviewSeries, type RunView } from './data'

export type OverviewEntry = {
  conversation: ConversationView
  run: RunView
  series: OverviewSeries
}

const PLOT_WIDTH = 1000
const PLOT_HEIGHT = 240
const PLOT_TOP = 16
const PLOT_BOTTOM = 224

// Map valence in [-1, 1] to the plot's y axis (+1 at the top, -1 at the bottom).
function valenceY(valence: number): number {
  const normalized = (Math.max(-1, Math.min(1, valence)) + 1) / 2
  return PLOT_BOTTOM - normalized * (PLOT_BOTTOM - PLOT_TOP)
}

// Spread a conversation's points evenly across the full width so arcs of
// different lengths can be compared by shape.
function pointX(index: number, count: number): number {
  if (count <= 1) return PLOT_WIDTH / 2
  return (index / (count - 1)) * PLOT_WIDTH
}

// Smooth Catmull-Rom path, matching the per-conversation timeline's curve style.
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M0,${points[0][1]} L${PLOT_WIDTH},${points[0][1]}`
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`
  }
  return d
}

function trendLabel(averageValence: number): string {
  if (averageValence >= 0.15) return 'Warm overall'
  if (averageValence <= -0.15) return 'Cool overall'
  return 'Mixed / neutral'
}

export default function Overview({
  entries,
  loading,
  error,
  activeId,
  onSelect,
}: {
  entries: OverviewEntry[]
  loading: boolean
  error: string | null
  activeId: string | null
  onSelect: (conversationId: string) => void
}) {
  return (
    <section className="overview-panel">
      <div className="panel-head">
        <div className="heading">
          <div className="title-row">
            <h1>Emotion overview</h1>
            <span className="trend-note">
              Net valence (joy vs. anger/fear/sadness/disgust) across your analyzed conversations
            </span>
          </div>
        </div>
      </div>

      <div className="chart">
        {loading ? (
          <div className="timeline-state neutral">Loading analyzed conversations…</div>
        ) : error ? (
          <div className="timeline-state error">{error}</div>
        ) : entries.length === 0 ? (
          <div className="timeline-state neutral">
            No analyzed conversations yet. Pick a conversation and run Ax analysis to add it here.
          </div>
        ) : (
          <>
            <div className="overview-plot">
              <div className="gridline" style={{ top: 0 }} />
              <div className="gridline baseline" style={{ top: PLOT_HEIGHT / 2 }} />
              <div className="gridline" style={{ top: PLOT_HEIGHT }} />
              <span className="overview-axis-label top">happier</span>
              <span className="overview-axis-label bottom">tenser</span>

              <svg
                width="100%"
                height={PLOT_HEIGHT}
                viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
                preserveAspectRatio="none"
                fill="none"
              >
                {entries.map((entry) => {
                  const coords = entry.series.points.map(
                    (point, index) =>
                      [pointX(index, entry.series.points.length), valenceY(point.valence)] as [
                        number,
                        number,
                      ],
                  )
                  const selected = entry.conversation.id === activeId
                  return (
                    <g key={entry.conversation.id} opacity={!activeId || selected ? 1 : 0.35}>
                      <path
                        d={smoothPath(coords)}
                        stroke={entry.conversation.avatar}
                        strokeWidth={selected ? 3.2 : 2.2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      {entry.series.points.map((point, index) =>
                        point.sharp ? (
                          <circle
                            key={point.windowId}
                            cx={pointX(index, entry.series.points.length)}
                            cy={valenceY(point.valence)}
                            r={4}
                            fill={entry.conversation.avatar}
                            stroke="#fff"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                          >
                            <title>{`${entry.conversation.title}: sharp shift at window ${point.ordinal}`}</title>
                          </circle>
                        ) : null,
                      )}
                    </g>
                  )
                })}
              </svg>
            </div>

            <ul className="overview-legend">
              {entries.map((entry) => (
                <li key={entry.conversation.id}>
                  <button
                    type="button"
                    className={`overview-row${entry.conversation.id === activeId ? ' selected' : ''}`}
                    onClick={() => onSelect(entry.conversation.id)}
                  >
                    <span className="legend-swatch" style={{ background: entry.conversation.avatar }} />
                    <span className="overview-row-name">{entry.conversation.title}</span>
                    <span className="overview-row-meta">
                      {trendLabel(entry.series.averageValence)} ·{' '}
                      {entry.series.sharpShiftCount} sharp shift
                      {entry.series.sharpShiftCount === 1 ? '' : 's'} ·{' '}
                      {formatMessageCount(entry.conversation.messageCount)} msgs
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="overview-caption">
              Each line is one conversation&rsquo;s valence arc over its scored windows, normalized to
              the full width so shapes line up. Dots mark windows with a sharp emotional shift. Select a
              conversation to open its detailed timeline.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
