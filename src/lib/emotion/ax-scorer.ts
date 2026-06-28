import { ai, ax } from '@ax-llm/ax'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from './anchors'

export type AxEffort = keyof typeof AX_EFFORT
export type AxProvider = 'openai' | 'openrouter'

export interface AxScorerConfig {
  effort?: AxEffort
  provider?: AxProvider
  model?: string
  maxTokens?: number
  promptKey?: string
  label?: string
}

export interface AxWindowMessage {
  id: number
  ordinal: number
  text: string | null
  isFromMe: boolean
  senderName: string | null
  role: 'context' | 'focal'
}

export interface AxWindowInput {
  runId: number
  windowId: number
  ordinal: number
  messages: AxWindowMessage[]
}

export interface AxWindowResult {
  scores: AnchorScores
  dominant: Anchor
  confidence: number
  summary: string
  rationale: string
  scoreRationales: Partial<Record<Anchor, string>>
  evidenceMessageIds: number[]
  method: 'ax-llm-v1'
  scorer: 'ax-llm'
  provider: AxProvider
  model: string
  effort: AxEffort
  promptKey: string
}

type AxOutput = Partial<Record<Anchor, unknown>> & {
  confidence?: unknown
  stateLabel?: unknown
  rationale?: unknown
  scoreRationalesJson?: unknown
  evidenceMessageRefs?: unknown
}

type FormattedMessage = {
  id: number
  ref: string
  line: string
}

export const AX_EFFORT = {
  low: { model: 'google/gemini-2.5-flash-lite', maxTokens: 300 },
  medium: { model: 'google/gemini-2.5-flash', maxTokens: 450 },
  high: { model: 'anthropic/claude-haiku-4.5', maxTokens: 700 },
} as const

const DEFAULT_PROMPT_KEY = 'ax-ekman-window-v1'

const axWindowSignature = ax(`
  taskContext:string "Instructions and JSON contract",
  windowRef:string "Stable local window reference",
  windowText:string "Bounded private iMessage window with local message refs"
  ->
  anger:number "anger score from 0 to 1",
  disgust:number "disgust score from 0 to 1",
  fear:number "fear score from 0 to 1",
  joy:number "joy score from 0 to 1",
  neutral:number "neutral score from 0 to 1",
  sadness:number "sadness score from 0 to 1",
  surprise:number "surprise score from 0 to 1",
  confidence:number "confidence from 0 to 1",
  stateLabel:string "short non-identifying state label",
  rationale:string "short abstract reason for the window score, no private quotes",
  scoreRationalesJson:string "JSON object mapping each emotion anchor to a short non-identifying reason",
  evidenceMessageRefs:string[] "local message refs only, like m0042"
`)

export async function scoreWindowWithAx(
  input: AxWindowInput,
  config: AxScorerConfig = {},
): Promise<AxWindowResult> {
  const resolved = resolveAxConfig(config)
  const formatted = formatMessages(input.messages)
  const output = (await axWindowSignature.forward(service(resolved), {
    taskContext: taskContext(resolved),
    windowRef: `run:${input.runId}:window:${input.ordinal}`,
    windowText: formatted.map((message) => message.line).join('\n'),
  })) as AxOutput

  const scores = Object.fromEntries(
    EKMAN_ANCHORS.map((anchor) => [anchor, clamp(output[anchor])]),
  ) as AnchorScores
  const dominant = strongestAnchor(scores)
  const summary =
    typeof output.stateLabel === 'string' && output.stateLabel.trim()
      ? output.stateLabel.trim().slice(0, 120)
      : `${dominant} leading`

  return {
    scores,
    dominant,
    confidence: clamp(output.confidence),
    summary,
    rationale:
      typeof output.rationale === 'string' && output.rationale.trim()
        ? output.rationale.trim().slice(0, 600)
        : summary,
    scoreRationales: scoreRationales(output.scoreRationalesJson),
    evidenceMessageIds: evidenceIds(output.evidenceMessageRefs, formatted),
    method: 'ax-llm-v1',
    scorer: 'ax-llm',
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    promptKey: resolved.promptKey,
  }
}

function resolveAxConfig(config: AxScorerConfig): Required<AxScorerConfig> {
  const effort = config.effort ?? 'medium'
  const tier = AX_EFFORT[effort]
  const provider = config.provider ?? defaultProvider()
  return {
    effort,
    provider,
    model: config.model ?? defaultModel(provider, tier.model),
    maxTokens: config.maxTokens ?? tier.maxTokens,
    promptKey: config.promptKey ?? DEFAULT_PROMPT_KEY,
    label: config.label ?? 'Ax LLM',
  }
}

function service(config: Required<AxScorerConfig>) {
  const apiKey = apiKeyFor(config.provider)
  if (!apiKey) {
    throw new Error('Set OPENAI_API_KEY or OPENROUTER_API_KEY to run the Ax LLM scorer')
  }

  return ai({
    name: 'openai',
    apiKey,
    apiURL: config.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined,
    models: [{ key: 'default', description: config.model, model: config.model as never }],
    config: {
      model: 'default' as never,
      temperature: 0,
      maxTokens: config.maxTokens,
    },
  } as never)
}

function taskContext(config: Required<AxScorerConfig>): string {
  return [
    `Prompt key: ${config.promptKey}`,
    'Score a private iMessage conversation window for temporal relationship-emotion analysis.',
    'Do not quote or paraphrase private message text in the state label.',
    `Use exactly these Ekman/RoBERTa dimensions: ${EKMAN_ANCHORS.join(', ')}.`,
    'Return evidenceMessageRefs as local refs like m0042 only.',
    'Return rationale and scoreRationalesJson without quoting or paraphrasing private message text.',
    'The window already contains the prior conversation as old_context messages; score the new_focal messages in that context.',
  ].join('\n')
}

function scoreRationales(value: unknown): Partial<Record<Anchor, string>> {
  const parsed =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : parseObject(typeof value === 'string' ? value : '')
  const rationales: Partial<Record<Anchor, string>> = {}
  for (const anchor of EKMAN_ANCHORS) {
    const reason = parsed[anchor]
    if (typeof reason === 'string' && reason.trim()) rationales[anchor] = reason.trim().slice(0, 220)
  }
  return rationales
}

function parseObject(value: string): Record<string, unknown> {
  if (!value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function formatMessages(messages: AxWindowMessage[]): FormattedMessage[] {
  return messages.map((message, index) => {
    const ref = `m${String(index).padStart(4, '0')}`
    const role = message.role === 'context' ? 'old_context' : 'new_focal'
    const sender = message.isFromMe ? 'me' : (message.senderName ?? 'them')
    const text = message.text?.replace(/\s+/g, ' ').trim() || '[no text]'
    return {
      id: message.id,
      ref,
      line: `${ref} [${role}] [ordinal:${message.ordinal}] [${sender}]: ${text}`,
    }
  })
}

function evidenceIds(value: unknown, messages: FormattedMessage[]): number[] {
  if (!Array.isArray(value)) return []
  const byRef = new Map(messages.map((message) => [message.ref, message.id]))
  const ids = value
    .map((item) => (typeof item === 'string' ? byRef.get(item) : null))
    .filter((id): id is number => typeof id === 'number')
  return [...new Set(ids)].slice(0, 8)
}

function defaultProvider(): AxProvider {
  return process.env.OPENROUTER_API_KEY ? 'openrouter' : 'openai'
}

function apiKeyFor(provider: AxProvider): string | null {
  const value = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY
  return value && value.trim() ? value : null
}

function defaultModel(provider: AxProvider, model: string): string {
  if (provider === 'openrouter' && !model.includes('/')) return `openai/${model}`
  return model
}

function strongestAnchor(scores: AnchorScores): Anchor {
  return EKMAN_ANCHORS.reduce((best, anchor) => (scores[anchor] > scores[best] ? anchor : best), 'neutral' as Anchor)
}

function clamp(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(Math.min(1, Math.max(0, number)) * 1000) / 1000
}
