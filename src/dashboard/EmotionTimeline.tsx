import type { RunView, WindowView } from './data'
import { EMOTIONS, gradientFor, runStateLabel, timelineBlocks } from './data'

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
