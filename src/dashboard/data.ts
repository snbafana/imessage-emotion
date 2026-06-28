// Mock data for the dashboard view. Frontend-only — no DB, no agent calls.
// Replaced by real ingestion + emotion engine later.

export type EmotionKey =
  | 'joy'
  | 'trust'
  | 'sadness'
  | 'anger'
  | 'fear'
  | 'surprise'

export const EMOTIONS: Record<EmotionKey, { label: string; color: string }> = {
  joy: { label: 'Joy', color: '#E8A317' },
  trust: { label: 'Trust', color: '#2E9E8F' },
  sadness: { label: 'Sadness', color: '#3B6BD6' },
  anger: { label: 'Anger', color: '#D6453B' },
  fear: { label: 'Fear', color: '#7A5AD6' },
  surprise: { label: 'Surprise', color: '#A8B81E' },
}

export type Block = { emotion: EmotionKey; intensity: number }

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
    avatar: '#3B6BD6',
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
    avatar: '#2E9E8F',
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
    avatar: '#7A5AD6',
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
    avatar: '#D6453B',
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

// Active person's full timeline: tentative start → conflict spikes → warming finish.
export const TIMELINE: Block[] = [
  { emotion: 'fear', intensity: 0.39 },
  { emotion: 'sadness', intensity: 0.49 },
  { emotion: 'sadness', intensity: 0.36 },
  { emotion: 'surprise', intensity: 0.58 },
  { emotion: 'joy', intensity: 0.71 },
  { emotion: 'trust', intensity: 0.61 },
  { emotion: 'anger', intensity: 0.84 },
  { emotion: 'anger', intensity: 0.77 },
  { emotion: 'sadness', intensity: 0.55 },
  { emotion: 'sadness', intensity: 0.45 },
  { emotion: 'trust', intensity: 0.65 },
  { emotion: 'joy', intensity: 0.74 },
  { emotion: 'joy', intensity: 0.81 },
  { emotion: 'trust', intensity: 0.68 },
  { emotion: 'fear', intensity: 0.52 },
  { emotion: 'anger', intensity: 0.9 }, // selected
  { emotion: 'anger', intensity: 0.71 },
  { emotion: 'sadness', intensity: 0.5 },
  { emotion: 'trust', intensity: 0.59 },
  { emotion: 'joy', intensity: 0.77 },
  { emotion: 'trust', intensity: 0.85 },
  { emotion: 'trust', intensity: 0.94 },
  { emotion: 'joy', intensity: 0.97 },
  { emotion: 'trust', intensity: 0.89 },
  { emotion: 'trust', intensity: 0.95 },
  { emotion: 'joy', intensity: 0.92 },
  { emotion: 'trust', intensity: 1.0 },
  { emotion: 'trust', intensity: 0.97 },
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
    { label: 'Recurring grievance (Feb)', value: 82, color: '#D6453B' },
    { label: 'Reassurance read as dismissal', value: 64, color: '#D6453B' },
    { label: 'Unmet bid for attention', value: 55, color: '#E8A317' },
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
    citation: { label: 'Week of Mar 25 · trust', delta: '+0.39', color: '#2E9E8F' },
  },
]
