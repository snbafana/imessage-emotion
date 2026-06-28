// Mock data for the dashboard view. Frontend-only — no DB, no agent calls.
// Replaced by real ingestion + emotion engine later.

export type EmotionKey =
  | 'joy'
  | 'trust'
  | 'sadness'
  | 'anger'
  | 'fear'
  | 'surprise'

// Harmonized OKLCH emotion wheel: hues spread evenly at consistent
// lightness/chroma so any two emotions blend cleanly into gradients.
// `color` = vivid (blocks, bars, dots); `ink` = darker, for text on white.
export const EMOTIONS: Record<EmotionKey, { label: string; color: string; ink: string }> = {
  joy: { label: 'Joy', color: 'oklch(0.79 0.15 78)', ink: 'oklch(0.55 0.13 78)' },
  trust: { label: 'Trust', color: 'oklch(0.69 0.12 182)', ink: 'oklch(0.52 0.12 182)' },
  sadness: { label: 'Sadness', color: 'oklch(0.61 0.13 252)', ink: 'oklch(0.5 0.13 252)' },
  anger: { label: 'Anger', color: 'oklch(0.63 0.2 27)', ink: 'oklch(0.52 0.2 27)' },
  fear: { label: 'Fear', color: 'oklch(0.58 0.17 300)', ink: 'oklch(0.5 0.16 300)' },
  surprise: { label: 'Surprise', color: 'oklch(0.84 0.16 108)', ink: 'oklch(0.58 0.14 108)' },
}

// A single-emotion sample (used by sidebar sparklines).
export type Block = { emotion: EmotionKey; intensity: number }

// A window in the main timeline: an emotional composition + overall intensity.
export type Composition = { emotion: EmotionKey; weight: number }[]
export type TimelineBlock = { composition: Composition; intensity: number }

const W2 = [0.66, 0.34]
const W3 = [0.5, 0.3, 0.2]

// Build a composition (dominant first) with sensible default weights.
function mix(...emotions: EmotionKey[]): Composition {
  const w = emotions.length === 3 ? W3 : emotions.length === 2 ? W2 : [1]
  return emotions.map((emotion, i) => ({ emotion, weight: w[i] }))
}

// Vertical gradient reading bottom-up from the dominant emotion into its
// secondary notes; stop positions follow each emotion's weight.
export function gradientFor(composition: Composition): string {
  const colors = composition.map((c) => EMOTIONS[c.emotion].color)
  if (composition.length === 1) return colors[0]
  const stops = [`${colors[0]} 0%`]
  let cum = 0
  composition.forEach((c, i) => {
    const mid = cum + c.weight / 2
    stops.push(`${colors[i]} ${Math.round(mid * 100)}%`)
    cum += c.weight
  })
  stops.push(`${colors[colors.length - 1]} 100%`)
  return `linear-gradient(to top, ${stops.join(', ')})`
}

export type Person = {
  id: string
  name: string
  initial: string
  avatar: string
  meta: string
  trend: Block[]
}

export const PEOPLE: Person[] = [
  {
    id: 'maya',
    name: 'Maya Chen',
    initial: 'M',
    avatar: '#1F44FF',
    meta: '2,481 msgs · 3 yrs',
    trend: [
      { emotion: 'trust', intensity: 0.4 },
      { emotion: 'trust', intensity: 0.6 },
      { emotion: 'joy', intensity: 0.3 },
      { emotion: 'trust', intensity: 0.72 },
      { emotion: 'trust', intensity: 0.9 },
    ],
  },
  {
    id: 'jordan',
    name: 'Jordan Reyes',
    initial: 'J',
    avatar: 'oklch(0.61 0.13 252)',
    meta: '1,033 msgs · 2 yrs',
    trend: [
      { emotion: 'trust', intensity: 0.72 },
      { emotion: 'trust', intensity: 0.5 },
      { emotion: 'sadness', intensity: 0.4 },
      { emotion: 'sadness', intensity: 0.62 },
      { emotion: 'sadness', intensity: 0.9 },
    ],
  },
  {
    id: 'dad',
    name: 'Dad',
    initial: 'D',
    avatar: 'oklch(0.69 0.12 182)',
    meta: '5,902 msgs · 6 yrs',
    trend: [
      { emotion: 'joy', intensity: 0.54 },
      { emotion: 'trust', intensity: 0.72 },
      { emotion: 'trust', intensity: 0.58 },
      { emotion: 'joy', intensity: 0.5 },
      { emotion: 'trust', intensity: 0.68 },
    ],
  },
  {
    id: 'priya',
    name: 'Priya Anand',
    initial: 'P',
    avatar: 'oklch(0.58 0.17 300)',
    meta: '744 msgs · 8 mo',
    trend: [
      { emotion: 'trust', intensity: 0.36 },
      { emotion: 'anger', intensity: 0.9 },
      { emotion: 'joy', intensity: 0.32 },
      { emotion: 'fear', intensity: 0.82 },
      { emotion: 'trust', intensity: 0.5 },
    ],
  },
  {
    id: 'sam',
    name: 'Sam Okafor',
    initial: 'S',
    avatar: 'oklch(0.63 0.2 27)',
    meta: '1,610 msgs · 4 yrs',
    trend: [
      { emotion: 'trust', intensity: 0.45 },
      { emotion: 'anger', intensity: 0.9 },
      { emotion: 'anger', intensity: 0.72 },
      { emotion: 'joy', intensity: 0.4 },
      { emotion: 'trust', intensity: 0.6 },
    ],
  },
]

// Active person's full timeline: tentative start → conflict spikes → warming
// finish. Each window is an emotional composition (dominant first).
export const TIMELINE: TimelineBlock[] = [
  { intensity: 0.39, composition: mix('fear', 'sadness') },
  { intensity: 0.49, composition: mix('sadness', 'fear') },
  { intensity: 0.36, composition: mix('sadness', 'trust') },
  { intensity: 0.58, composition: mix('surprise', 'joy') },
  { intensity: 0.71, composition: mix('joy', 'trust') },
  { intensity: 0.61, composition: mix('trust', 'joy') },
  { intensity: 0.84, composition: mix('anger', 'sadness') },
  { intensity: 0.77, composition: mix('anger', 'fear') },
  { intensity: 0.55, composition: mix('sadness', 'anger') },
  { intensity: 0.45, composition: mix('sadness', 'trust') },
  { intensity: 0.65, composition: mix('trust', 'joy') },
  { intensity: 0.74, composition: mix('joy', 'trust') },
  { intensity: 0.81, composition: mix('joy', 'surprise') },
  { intensity: 0.68, composition: mix('trust', 'joy') },
  { intensity: 0.52, composition: mix('fear', 'anger') },
  { intensity: 0.9, composition: mix('anger', 'sadness', 'fear') }, // selected
  { intensity: 0.71, composition: mix('anger', 'sadness') },
  { intensity: 0.5, composition: mix('sadness', 'trust') },
  { intensity: 0.59, composition: mix('trust', 'joy') },
  { intensity: 0.77, composition: mix('joy', 'trust') },
  { intensity: 0.85, composition: mix('trust', 'joy') },
  { intensity: 0.94, composition: mix('trust', 'joy') },
  { intensity: 0.97, composition: mix('joy', 'trust') },
  { intensity: 0.89, composition: mix('trust', 'joy') },
  { intensity: 0.95, composition: mix('trust', 'joy') },
  { intensity: 0.92, composition: mix('joy', 'surprise') },
  { intensity: 1.0, composition: mix('trust', 'joy') },
  { intensity: 0.97, composition: mix('trust', 'joy') },
]

export const SELECTED_INDEX = 15

export const AXIS_YEARS = ['2022', '2023', '2024', '2025', '2026']

// High-fidelity valence line (viewBox 0 0 1000 210, y inverted: lower = happier).
export const VALENCE_PATH =
  'M0,120 C40,116 70,108 110,118 C150,128 175,150 215,150 C255,150 270,120 300,112 C340,102 360,150 400,146 C430,143 450,98 480,92 C510,86 525,150 560,158 C600,166 620,150 650,120 C685,88 705,70 740,66 C780,62 800,48 840,44 C880,40 910,38 1000,30'

export type Message = { from: 'them' | 'me'; text: string; time: string }

export const SELECTED_WINDOW = {
  label: 'Week of Mar 18, 2024',
  sub: 'selected window · 34 messages',
  emotion: 'anger' as EmotionKey,
  score: '0.71',
  messages: [
    {
      from: 'them',
      text: "honestly it feels like you've been somewhere else all week",
      time: 'Maya · 9:42 PM',
    },
    {
      from: 'me',
      text: "i'm buried under the launch, it's genuinely not about us",
      time: 'You · 9:48 PM',
    },
    {
      from: 'them',
      text: "that's exactly what you said in February",
      time: 'Maya · 9:51 PM',
    },
  ] as Message[],
  reasoning:
    'A bid for attention went unmet, then Maya tied it to a recurring February pattern. Your reassurance was read as dismissal rather than repair — valence dropped sharply while arousal stayed high, the signature of unresolved conflict rather than sadness.',
  drivers: [
    { label: 'Recurring grievance (Feb)', value: 82, color: EMOTIONS.anger.color },
    { label: 'Reassurance read as dismissal', value: 64, color: EMOTIONS.anger.color },
    { label: 'Unmet bid for attention', value: 55, color: EMOTIONS.joy.color },
  ],
}

export type ChatTurn = {
  role: 'user' | 'agent'
  text: string
  citation?: { label: string; delta: string; color: string }
}

export const CHAT: ChatTurn[] = [
  { role: 'user', text: 'why did things recover after that March fight?' },
  {
    role: 'agent',
    text: 'The repair was concrete, not verbal. Within nine days you shifted from defending to planning — the trip thread on Mar 27 is the inflection. Trust climbed steadily for six weeks after, and the Feb grievance stopped recurring.',
    citation: { label: 'Week of Mar 25 · trust', delta: '+0.39', color: EMOTIONS.trust.ink },
  },
]
