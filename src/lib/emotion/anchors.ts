// Canonical emotion dimensions for the whole app — the RoBERTa/Ekman anchors
// decided in experiments/emotion-methods (harness_ax.ts). Single source of truth
// shared by the scorer, the dashboard, and the eve agent tools.

export const EKMAN_ANCHORS = [
  'anger',
  'disgust',
  'fear',
  'joy',
  'neutral',
  'sadness',
  'surprise',
] as const

export type Anchor = (typeof EKMAN_ANCHORS)[number]
export type AnchorScores = Record<Anchor, number>

// Display palette (OKLCH) — `color` vivid for blocks/bars, `ink` darker for text.
export const ANCHOR_DISPLAY: Record<Anchor, { label: string; color: string; ink: string }> = {
  anger: { label: 'Anger', color: 'oklch(0.63 0.20 27)', ink: 'oklch(0.52 0.20 27)' },
  disgust: { label: 'Disgust', color: 'oklch(0.62 0.15 140)', ink: 'oklch(0.5 0.15 140)' },
  fear: { label: 'Fear', color: 'oklch(0.58 0.17 300)', ink: 'oklch(0.5 0.16 300)' },
  joy: { label: 'Joy', color: 'oklch(0.79 0.15 78)', ink: 'oklch(0.55 0.13 78)' },
  neutral: { label: 'Neutral', color: 'oklch(0.78 0.02 250)', ink: 'oklch(0.55 0.02 250)' },
  sadness: { label: 'Sadness', color: 'oklch(0.61 0.13 252)', ink: 'oklch(0.5 0.13 252)' },
  surprise: { label: 'Surprise', color: 'oklch(0.84 0.16 108)', ink: 'oklch(0.58 0.14 108)' },
}
