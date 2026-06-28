import { Button } from '@base-ui/react/button'
import type { EmotionKey, RunView, WindowView } from './data'
import { EMOTIONS, SCORE_KEYS, gradientFor, runStateLabel, timelineBlocks } from './data'

const PLOT_WIDTH = 1000
const PLOT_HEIGHT = 210
const PLOT_TOP = 16
const PLOT_BOTTOM = 190

type EmotionSeries = {
  emotion: EmotionKey
  path: string
  max: number
  average: number
  values: number[]
}

function scoreY(value: number): number {
  return PLOT_BOTTOM - clamp01(value) * (PLOT_BOTTOM - PLOT_TOP)
}

// Smooth Catmull-Rom path through per-window scores in a fixed non-scaling
// viewBox. This keeps sparse large-window runs and dense granular runs readable.
function scorePath(values: number[]): string {
  if (values.length === 0) return ''
  const points: [number, number][] = values.map((value, i) => [
    values.length === 1 ? PLOT_WIDTH / 2 : (i / (values.length - 1)) * PLOT_WIDTH,
    scoreY(value),
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

function emotionSeries(windows: WindowView[]): EmotionSeries[] {
  return SCORE_KEYS.map((emotion) => {
    const values = windows.map((window) => clamp01(window.scores[emotion] ?? 0))
    const total = values.reduce((sum, value) => sum + value, 0)
    return {
      emotion,
      path: scorePath(values),
      max: Math.max(0, ...values),
      average: values.length === 0 ? 0 : total / values.length,
      values,
    }
  })
}

function selectedX(index: number, count: number): number {
  if (index < 0) return -1
  if (count <= 1) return PLOT_WIDTH / 2
  return (index / (count - 1)) * PLOT_WIDTH
}

function runMeta(run: RunView): string {
  const scored = run.scoredWindowCount ?? run.windowCount ?? 0
  const total = run.windowCount ?? scored
  return `${scored}/${total} windows`
}

export default function EmotionTimeline({
  run,
  runs,
  windows,
  selectedId,
  selectedRunId,
  loading,
  error,
  onSelectRun,
  onSelectWindow,
}: {
  run: RunView | null
  runs: RunView[]
  windows: WindowView[]
  selectedId: string | null
  selectedRunId: string | null
  loading: boolean
  error: string | null
  onSelectRun: (id: string) => void
  onSelectWindow: (id: string) => void
}) {
  const stateLabel = runStateLabel(run, windows)
  const blocks = timelineBlocks(windows)
  const hasScores = blocks.some((block) => block.composition.length > 0)
  const series = emotionSeries(windows)
  const selectedIndex = blocks.findIndex((block) => block.window.id === selectedId)
  const markerX = selectedX(selectedIndex, blocks.length)

  return (
    <section className="timeline-panel">
      <div className="panel-head">
        <div className="heading">
          <div className="title-row">
            <h1>{run ? 'Emotion graph' : stateLabel}</h1>
            {run && (
              <span className={`trend-note status-${run.state}`}>
                {run.scaleLabel} · {run.configLabel} · {runMeta(run)}
              </span>
            )}
          </div>
        </div>
        {runs.length > 1 && (
          <div className="run-switcher" aria-label="Baseline runs">
            {runs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`run-tab scale-${item.scale}`}
                aria-pressed={item.id === selectedRunId}
                data-selected={item.id === selectedRunId ? '' : undefined}
                onClick={() => onSelectRun(item.id)}
              >
                <span className="run-kind">{item.scaleLabel}</span>
                <span className="run-count">{runMeta(item)}</span>
              </button>
            ))}
          </div>
        )}
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
                  <Button
                    key={block.window.id}
                    className={`block window-block${block.window.id === selectedId ? ' selected' : ''}`}
                    style={{
                      height: `${30 + block.intensity * 160}px`,
                      background:
                        block.window.state === 'failed'
                          ? '#d9d9dd'
                          : gradientFor(block.composition),
                    }}
                    onClick={() => onSelectWindow(block.window.id)}
                    title={`${block.window.label} · ${dominant ? EMOTIONS[dominant].label : 'no score yet'}`}
                    aria-label={`${block.window.label}, ${dominant ? EMOTIONS[dominant].label : 'no score yet'}`}
                  >
                    <span>{block.window.ordinal}</span>
                  </Button>
                )
              })}

              {hasScores ? (
                <div className="line-overlay">
                  <svg
                    width="100%"
                    height={PLOT_HEIGHT}
                    viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
                    preserveAspectRatio="none"
                    fill="none"
                  >
                    {series.map((item) => (
                      <path
                        key={item.emotion}
                        d={item.path}
                        stroke={EMOTIONS[item.emotion].color}
                        strokeWidth={item.emotion === 'neutral' ? 1.7 : 2.35}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray={item.emotion === 'neutral' ? '4 7' : undefined}
                        opacity={item.max > 0.01 ? 0.86 : 0.22}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                    {markerX >= 0 &&
                      series.map((item) => (
                        <circle
                          key={`${item.emotion}-marker`}
                          cx={markerX}
                          cy={scoreY(item.values[selectedIndex] ?? 0)}
                          r={3.2}
                          fill={EMOTIONS[item.emotion].color}
                          stroke="#fff"
                          strokeWidth={1.4}
                          opacity={item.max > 0.01 ? 0.95 : 0.25}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                  </svg>
                </div>
              ) : null}
            </div>

            <div className="emotion-legend">
              {series.map((item) => (
                <span key={item.emotion} className="legend-item">
                  <span className="legend-swatch" style={{ background: EMOTIONS[item.emotion].color }} />
                  <span className="legend-name">{EMOTIONS[item.emotion].label}</span>
                  <span className="legend-value">{Math.round(item.average * 100)}%</span>
                </span>
              ))}
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
