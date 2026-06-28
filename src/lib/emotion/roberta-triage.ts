import type { AppDatabase } from '../db/schema'
import { getRunWindows } from '../api/runs'
import { getWindowMessages } from '../api/messages'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from './anchors'
import { dominantOf, zeroScores } from './ax-shared'

// Tier 1: a fast, local RoBERTa pass over every window. The distilroberta emotion
// model emits the 7 Ekman labels directly, so one batched call scores the whole
// run in milliseconds. We persist these scores (no reasoning) and compute a
// rolling-baseline shift magnitude per window so Tier 2 knows what to deep-read.

const ROBERTA_MODEL = 'nicky48/emotion-english-distilroberta-base-ONNX'

export type TriagedWindow = {
  windowId: number
  ordinal: number
  focalText: string
  scores: AnchorScores
  dominant: Anchor
  shift: number
}

export type TriageResult = {
  method: string
  loadMs: number
  inferMs: number
  windows: TriagedWindow[]
}

type Labels = Array<{ label: string; score: number }>

let classifierPromise: Promise<(input: string[], opts: Record<string, unknown>) => Promise<unknown>> | null = null

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('text-classification', ROBERTA_MODEL, { dtype: 'q8' }),
    ) as never
  }
  return classifierPromise
}

function scoresFromLabels(labels: Labels): AnchorScores {
  const scores = zeroScores()
  for (const row of labels) {
    const key = row.label.toLowerCase()
    if ((EKMAN_ANCHORS as readonly string[]).includes(key)) scores[key as Anchor] = row.score
  }
  return scores
}

function meanScores(rows: AnchorScores[]): AnchorScores {
  const totals = zeroScores()
  for (const row of rows) for (const a of EKMAN_ANCHORS) totals[a] += row[a]
  return Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, rows.length ? totals[a] / rows.length : 0])) as AnchorScores
}

export type TriageProgress = (e: {
  windowId: number
  ordinal: number
  focal: string
  dominant: Anchor
  scores: AnchorScores
  shift: number
}) => void

export async function triageRunWithRoberta(
  db: AppDatabase,
  runId: number,
  opts: { onProgress?: TriageProgress } = {},
): Promise<TriageResult> {
  const windows = getRunWindows(db, runId)
  const focalTexts = windows.map((w) => {
    const focal = getWindowMessages(db, w.id, 'focal')
    return focal.map((m) => `${m.isFromMe ? 'me' : 'them'}: ${m.text ?? ''}`).join('\n').slice(0, 1800)
  })

  const t0 = performance.now()
  const classify = await getClassifier()
  const loadMs = Math.round(performance.now() - t0)

  const t1 = performance.now()
  const perWindowLabels: Labels[] = []
  const batchSize = 32
  for (let i = 0; i < focalTexts.length; i += batchSize) {
    const batch = focalTexts.slice(i, i + batchSize)
    const out = (await classify(batch, { top_k: 7, truncation: true })) as Labels[] | Labels
    // batched input -> array-of-arrays; single input -> array of labels
    if (Array.isArray(out[0])) perWindowLabels.push(...(out as Labels[]))
    else perWindowLabels.push(out as Labels)
  }
  const inferMs = Math.round(performance.now() - t1)

  const scored = windows.map((w, i) => {
    const scores = scoresFromLabels(perWindowLabels[i] ?? [])
    return { window: w, scores, dominant: dominantOf(scores) }
  })

  const triaged: TriagedWindow[] = scored.map((row, i) => {
    const priors = scored.slice(Math.max(0, i - 3), i).map((r) => r.scores)
    const baseline = priors.length ? meanScores(priors) : zeroScores()
    const shift = Math.sqrt(EKMAN_ANCHORS.reduce((sum, a) => sum + (row.scores[a] - baseline[a]) ** 2, 0))
    const confidence = Math.max(...EKMAN_ANCHORS.map((a) => row.scores[a]))

    // Persist the fast scores so the timeline reflects the triage immediately.
    const resultJson = JSON.stringify({
      scores: row.scores,
      dominant: row.dominant,
      confidence,
      summary: `${row.dominant} (roberta triage)`,
      method: 'roberta-triage',
    })
    db.prepare('UPDATE windows SET result_json = ?, status = ?, latency_ms = ? WHERE id = ?').run(
      resultJson,
      'completed',
      0,
      row.window.id,
    )

    const focal = `${row.window.focalStartOrdinal}-${row.window.focalEndOrdinal}`
    opts.onProgress?.({
      windowId: row.window.id,
      ordinal: row.window.ordinal,
      focal,
      dominant: row.dominant,
      scores: row.scores,
      shift,
    })
    return {
      windowId: row.window.id,
      ordinal: row.window.ordinal,
      focalText: focalTexts[i],
      scores: row.scores,
      dominant: row.dominant,
      shift: Math.round(shift * 1000) / 1000,
    }
  })

  return { method: 'roberta-triage', loadMs, inferMs, windows: triaged }
}
