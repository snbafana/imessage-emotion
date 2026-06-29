import { Button } from '@base-ui/react/button'
import { Select } from '@base-ui/react/select'
import type { MouseEvent } from 'react'
import type { ComparativeRunWindowConfig } from '../lib/windows/windows'
import type { ConversationView, EmotionKey, RunView, WindowView } from './data'
import { EMOTIONS, SCORE_KEYS, formatMessageCount, gradientFor, runStateLabel, timelineBlocks } from './data'

export type AnalysisMethod = 'ax' | 'two-tier'

export type AnalysisSetupValue = {
  method: AnalysisMethod
  planner: 'capped' | 'manual'
  provider: 'openrouter' | 'openai'
  effort: 'low' | 'medium' | 'high'
  model: string
  maxWindows: number
  overlapPercent: number
  contextMessages: number
  focalMessages: number
  minFocalMessages: number
  twoTierFocal: number
  twoTierStride: number
  topK: number
}

export type AnalysisSetupPlan = {
  config: ComparativeRunWindowConfig
  windowCount: number
  error: string | null
}

const PLOT_WIDTH = 1000
const PLOT_HEIGHT = 210
const PLOT_TOP = 16
const PLOT_BOTTOM = 190
const BLOCK_RENDER_WINDOW_LIMIT = 50

type EmotionSeries = {
  emotion: EmotionKey
  path: string
  max: number
  average: number
  valuesByWindowId: Record<string, number>
}

function scoreY(value: number): number {
  return PLOT_BOTTOM - clamp01(value) * (PLOT_BOTTOM - PLOT_TOP)
}

// Smooth Catmull-Rom path through per-window scores in a fixed non-scaling
// viewBox. This keeps sparse large-window runs and dense granular runs readable.
function scorePath(points: [number, number][]): string {
  if (points.length === 0) return ''
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
    const rows = windows
      .map((window, index) => {
        const value = window.scores[emotion]
        if (value == null) return null
        return {
          windowId: window.id,
          value: clamp01(value),
          x: selectedX(index, windows.length),
        }
      })
      .filter((row): row is { windowId: string; value: number; x: number } => row !== null)
    const values = rows.map((row) => row.value)
    const total = values.reduce((sum, value) => sum + value, 0)
    return {
      emotion,
      path: scorePath(rows.map((row) => [row.x, scoreY(row.value)])),
      max: Math.max(0, ...values),
      average: values.length === 0 ? 0 : total / values.length,
      valuesByWindowId: Object.fromEntries(rows.map((row) => [row.windowId, row.value])),
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

function runScorerMeta(run: RunView): string {
  const provider = stringValue(run.scorerConfig.provider) ?? 'provider unknown'
  const model = stringValue(run.scorerConfig.model) ?? 'default model'
  const effort = stringValue(run.scorerConfig.effort)
  const overlap = numberValue(run.scorerConfig.overlapPercent)
  const parts = [provider, model, effort, overlap == null ? null : `${overlap}% overlap`].filter(Boolean)
  return parts.join(' · ')
}

function runOptionLabel(run: RunView): string {
  return `${run.scaleLabel} · ${runMeta(run)}`
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function hasScores(window: WindowView): boolean {
  return SCORE_KEYS.some((key) => window.scores[key] != null)
}

export default function EmotionTimeline({
  run,
  runs,
  windows,
  selectedId,
  selectedRunId,
  loading,
  error,
  conversation,
  setup,
  setupPlan,
  setupRunning,
  onChangeSetup,
  onRunSetup,
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
  conversation: ConversationView | null
  setup: AnalysisSetupValue
  setupPlan: AnalysisSetupPlan | null
  setupRunning: boolean
  onChangeSetup: (patch: Partial<AnalysisSetupValue>) => void
  onRunSetup: () => void
  onSelectRun: (id: string) => void
  onSelectWindow: (id: string) => void
}) {
  const stateLabel = runStateLabel(run, windows)
  const blocks = timelineBlocks(windows)
  const scoredBlocks = blocks.filter((block) => hasScores(block.window))
  const blockWindowCount = run?.windowCount ?? windows.length
  const showBlocks = blockWindowCount <= BLOCK_RENDER_WINDOW_LIMIT
  const hasScoreData = scoredBlocks.length > 0
  const series = emotionSeries(windows)
  const selectedIndex = windows.findIndex((window) => window.id === selectedId)
  const markerX = selectedX(selectedIndex, windows.length)

  // Clicking anywhere in the plot selects the window nearest to the click on the
  // x axis. This keeps windows reachable even when there are too many to render
  // individual clickable blocks (see BLOCK_RENDER_WINDOW_LIMIT).
  const handlePlotClick = (event: MouseEvent<HTMLDivElement>) => {
    if (windows.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const fraction = clamp01((event.clientX - rect.left) / rect.width)
    const index = Math.round(fraction * (windows.length - 1))
    const target = windows[index]
    if (target) onSelectWindow(target.id)
  }

  return (
    <section className="timeline-panel">
      <div className="panel-head">
        <div className="heading">
          <div className="title-row">
            <h1>{run ? 'Emotion graph' : stateLabel}</h1>
          </div>
        </div>
        {run && runs.length > 0 && (
          <Select.Root
            value={selectedRunId ?? run.id}
            onValueChange={(value) => value && onSelectRun(String(value))}
          >
            <Select.Trigger className="run-select" aria-label="Select analysis run">
              <span className="run-select-label">{runOptionLabel(run)}</span>
              <Select.Icon className="run-select-icon">
                <ChevronDownIcon />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner className="run-select-positioner" sideOffset={6} align="end">
                <Select.Popup className="run-select-popup">
                  {runs.map((item) => (
                    <Select.Item key={item.id} value={item.id} className="run-select-item">
                      <span className="run-option">
                        <Select.ItemText className="run-option-main">
                          {runOptionLabel(item)}
                        </Select.ItemText>
                        <span className="run-option-sub">{runScorerMeta(item)}</span>
                      </span>
                      <Select.ItemIndicator className="run-select-check">
                        <CheckIcon />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        )}
      </div>

      <div className="chart">
        {loading ? (
          <TimelineState label="Loading run windows..." />
        ) : error ? (
          <TimelineState label={error} tone="error" />
        ) : blocks.length === 0 ? (
          <AnalysisSetupPanel
            conversation={conversation}
            setup={setup}
            plan={setupPlan}
            running={setupRunning}
            onChange={onChangeSetup}
            onRun={onRunSetup}
          />
        ) : !hasScoreData ? (
          <TimelineState label="Waiting for first scored Ax window..." />
        ) : (
          <>
            <div
              className="plot interactive"
              role="presentation"
              onClick={handlePlotClick}
              title="Click the graph to select the nearest window"
            >
              <div className="gridline" style={{ top: 0 }} />
              <div className="gridline" style={{ top: 70 }} />
              <div className="gridline" style={{ top: 140 }} />

              {showBlocks &&
                scoredBlocks.map((block) => {
                  const dominant = block.window.dominant ?? block.composition[0]?.emotion ?? null
                  const index = windows.findIndex((window) => window.id === block.window.id)
                  return (
                    <Button
                      key={block.window.id}
                      className={`block window-block${block.window.id === selectedId ? ' selected' : ''}`}
                      style={{
                        left: `${selectedX(index, windows.length) / 10}%`,
                        width: `max(2px, ${100 / Math.max(1, windows.length)}%)`,
                        height: `${30 + block.intensity * 160}px`,
                        background:
                          block.window.state === 'failed'
                            ? '#d9d9dd'
                            : gradientFor(block.composition),
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelectWindow(block.window.id)
                      }}
                      title={`${block.window.label} · ${dominant ? EMOTIONS[dominant].label : 'no score yet'}`}
                      aria-label={`${block.window.label}, ${dominant ? EMOTIONS[dominant].label : 'no score yet'}`}
                    >
                      <span>{block.window.ordinal}</span>
                    </Button>
                  )
                })}

              {hasScoreData ? (
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
                    {markerX >= 0 && (
                      <line
                        x1={markerX}
                        y1={PLOT_TOP}
                        x2={markerX}
                        y2={PLOT_BOTTOM}
                        stroke="#1f44ff"
                        strokeWidth={1.5}
                        strokeDasharray="3 4"
                        opacity={0.7}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {markerX >= 0 &&
                      series.map((item) => (
                        <circle
                          key={`${item.emotion}-marker`}
                          cx={markerX}
                          cy={scoreY(item.valuesByWindowId[selectedId ?? ''] ?? 0)}
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

export function AnalysisSetupPanel({
  conversation,
  setup,
  plan,
  running,
  onChange,
  onRun,
}: {
  conversation: ConversationView | null
  setup: AnalysisSetupValue
  plan: AnalysisSetupPlan | null
  running: boolean
  onChange: (patch: Partial<AnalysisSetupValue>) => void
  onRun: () => void
}) {
  return (
    <div className="analysis-setup">
      <div className="setup-summary">
        <div>
          <span className="label">Run setup</span>
          <h2>{conversation ? conversation.title : 'Choose a conversation'}</h2>
        </div>
        <span className="setup-count">
          {conversation ? `${formatMessageCount(conversation.messageCount)} messages` : 'No conversation'}
        </span>
      </div>

      <div className="setup-mode setup-method" role="group" aria-label="Analysis method">
        <button
          type="button"
          data-selected={setup.method === 'ax' ? '' : undefined}
          onClick={() => onChange({ method: 'ax' })}
        >
          Ax · per-window
        </button>
        <button
          type="button"
          data-selected={setup.method === 'two-tier' ? '' : undefined}
          onClick={() => onChange({ method: 'two-tier' })}
        >
          RoBERTa → RLM
        </button>
      </div>

      {setup.method === 'ax' ? (
        <>
          <div className="setup-grid">
            <label className="setup-field">
              <span>Provider</span>
              <select
                value={setup.provider}
                onChange={(event) => onChange({ provider: event.target.value as AnalysisSetupValue['provider'] })}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label className="setup-field model-field">
              <span>Model</span>
              <input
                list="ax-models"
                value={setup.model}
                onChange={(event) => onChange({ model: event.target.value })}
              />
              <datalist id="ax-models">
                <option value="google/gemini-2.5-flash" />
                <option value="google/gemini-2.5-flash-lite" />
                <option value="anthropic/claude-haiku-4.5" />
              </datalist>
            </label>
            <label className="setup-field">
              <span>Effort</span>
              <select
                value={setup.effort}
                onChange={(event) => onChange({ effort: event.target.value as AnalysisSetupValue['effort'] })}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="setup-field">
              <span>Max windows</span>
              <input
                type="number"
                min={1}
                max={200}
                value={setup.maxWindows}
                onChange={(event) => onChange({ maxWindows: numberInput(event.target.value, 200) })}
              />
            </label>
            <label className="setup-field">
              <span>Overlap</span>
              <input
                type="range"
                min={10}
                max={40}
                value={setup.overlapPercent}
                onChange={(event) => onChange({ overlapPercent: numberInput(event.target.value, 25) })}
              />
              <strong>{setup.overlapPercent}%</strong>
            </label>
          </div>

          <div className="setup-mode" role="group" aria-label="Window planning mode">
            <button
              type="button"
              data-selected={setup.planner === 'capped' ? '' : undefined}
              onClick={() => onChange({ planner: 'capped' })}
            >
              Capped planner
            </button>
            <button
              type="button"
              data-selected={setup.planner === 'manual' ? '' : undefined}
              onClick={() => onChange({ planner: 'manual' })}
            >
              Manual window
            </button>
          </div>

          {setup.planner === 'manual' && (
            <div className="setup-grid compact">
              <label className="setup-field">
                <span>Context</span>
                <input
                  type="number"
                  min={1}
                  value={setup.contextMessages}
                  onChange={(event) => onChange({ contextMessages: numberInput(event.target.value, 80) })}
                />
              </label>
              <label className="setup-field">
                <span>Focal</span>
                <input
                  type="number"
                  min={1}
                  value={setup.focalMessages}
                  onChange={(event) => onChange({ focalMessages: numberInput(event.target.value, 40) })}
                />
              </label>
              <label className="setup-field">
                <span>Min tail</span>
                <input
                  type="number"
                  min={1}
                  value={setup.minFocalMessages}
                  onChange={(event) => onChange({ minFocalMessages: numberInput(event.target.value, 20) })}
                />
              </label>
            </div>
          )}
        </>
      ) : (
        <div className="setup-grid compact">
          <label className="setup-field">
            <span>Focal</span>
            <input
              type="number"
              min={1}
              value={setup.twoTierFocal}
              onChange={(event) => onChange({ twoTierFocal: numberInput(event.target.value, 4) })}
            />
          </label>
          <label className="setup-field">
            <span>Stride</span>
            <input
              type="number"
              min={1}
              value={setup.twoTierStride}
              onChange={(event) => onChange({ twoTierStride: numberInput(event.target.value, 1) })}
            />
          </label>
          <label className="setup-field">
            <span>Deep reads</span>
            <input
              type="number"
              min={1}
              max={200}
              value={setup.topK}
              onChange={(event) => onChange({ topK: numberInput(event.target.value, 25) })}
            />
          </label>
        </div>
      )}

      <div className={`setup-plan${plan?.error ? ' error' : ''}`}>
        {plan ? (
          <>
            <span>{formatMessageCount(plan.windowCount)} estimated windows</span>
            <span>{plan.config.contextMessages} context</span>
            <span>{plan.config.focalMessages} focal</span>
            <span>{plan.config.stride} stride</span>
            {plan.error && <strong>{plan.error}</strong>}
          </>
        ) : (
          <span>Select a conversation before running analysis.</span>
        )}
      </div>

      <Button
        className="setup-run"
        disabled={
          !conversation ||
          running ||
          !plan ||
          Boolean(plan.error) ||
          (setup.method === 'ax' && !setup.model.trim())
        }
        onClick={onRun}
      >
        {running
          ? 'Running analysis...'
          : setup.method === 'two-tier'
            ? 'Run RoBERTa → RLM'
            : 'Run Ax analysis'}
      </Button>
    </div>
  )
}

function numberInput(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
