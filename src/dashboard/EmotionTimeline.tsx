import type { EmotionKey, RunView, WindowView } from './data'
import { EMOTIONS, gradientFor, runStateLabel, timelineBlocks } from './data'

const POSITIVE_EMOTIONS = new Set<EmotionKey>(['warmth', 'joy', 'trust'])

// Per-window valence: positive emotions lift, tense ones drop. ~[-1, 1].
function windowValence(composition: { emotion: EmotionKey; weight: number }[]): number {
  return composition.reduce(
    (sum, { emotion, weight }) => sum + (POSITIVE_EMOTIONS.has(emotion) ? weight : -weight),
    0,
  )
}

// Smooth Catmull-Rom path through per-window valence (high-fidelity overlay on
// the discrete blocks) in a 1000x210 non-scaling viewBox.
function valencePath(valences: number[]): string {
  if (valences.length === 0) return ''
  const points: [number, number][] = valences.map((v, i) => [
    ((i + 0.5) / valences.length) * 1000,
    Math.min(198, Math.max(12, 110 - v * 82)),
  ])
  if (points.length === 1) return `M${points[0][0]},${points[0][1]} L1000,${points[0][1]}`
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

export default function EmotionTimeline({
  run,
  windows,
  selectedId,
  loading,
  error,
  onSelectWindow,
}: {
  run: RunView | null
  windows: WindowView[]
  selectedId: string | null
  loading: boolean
  error: string | null
  onSelectWindow: (id: string) => void
}) {
  const stateLabel = runStateLabel(run, windows)
  const blocks = timelineBlocks(windows)
  const hasScores = blocks.some((block) => block.composition.length > 0)
  const valenceLine =
    hasScores && blocks.length > 1 ? valencePath(blocks.map((b) => windowValence(b.composition))) : ''

  return (
    <section className="timeline-panel">
      <div className="panel-head">
        <div className="heading">
          <span className="label">Emotional timeline</span>
          <div className="title-row">
            <h1>{stateLabel}</h1>
            <span className={`trend-note status-${run?.state ?? 'no-run'}`}>
              {run ? `${run.methodKey} · ${run.status}` : 'create a baseline to begin'}
            </span>
          </div>
        </div>
      </div>

      <div className="chart">
        {loading ? (
          <TimelineState label="Loading run windows..." />
        ) : error ? (
          <TimelineState label={error} tone="error" />
        ) : blocks.length === 0 ? (
          <TimelineState label={stateLabel} />
        ) : (
          <>
            <div className="plot">
              <div className="gridline" style={{ top: 0 }} />
              <div className="gridline" style={{ top: 70 }} />
              <div className="gridline" style={{ top: 140 }} />

              {blocks.map((block) => {
                const dominant = block.window.dominant ?? block.composition[0]?.emotion ?? null
                return (
                  <button
                    key={block.window.id}
                    className={`block window-block${block.window.id === selectedId ? ' selected' : ''}`}
                    style={{
                      height: `${24 + block.intensity * 166}px`,
                      background:
                        block.window.state === 'failed'
                          ? '#d9d9dd'
                          : gradientFor(block.composition),
                    }}
                    onClick={() => onSelectWindow(block.window.id)}
                    title={`${block.window.label} · ${dominant ? EMOTIONS[dominant].label : 'no score yet'}`}
                  >
                    <span>{block.window.ordinal}</span>
                  </button>
                )
              })}

              {valenceLine ? (
                <div className="line-overlay">
                  <svg width="100%" height="210" viewBox="0 0 1000 210" preserveAspectRatio="none" fill="none">
                    <path d={valenceLine} stroke="#fff" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                    <path d={valenceLine} stroke="#0a0a0b" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  </svg>
                </div>
              ) : null}
            </div>

            <div className="axis">
              <span>{windows[0]?.startOrdinal}</span>
              <span>{windows[Math.floor(windows.length / 2)]?.startOrdinal}</span>
              <span>{windows[windows.length - 1]?.endOrdinal}</span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

function TimelineState({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'error' }) {
  return <div className={`timeline-state ${tone}`}>{label}</div>
}
