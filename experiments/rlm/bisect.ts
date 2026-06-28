import Database from 'better-sqlite3'
import { pipeline } from '@huggingface/transformers'
import { EKMAN_ANCHORS, type Anchor, type AnchorScores } from '../../src/lib/emotion/anchors'

// Can we binary-search RoBERTa to the text that matters most, instead of scoring
// every window? Compares a full sliding-window scan (ground truth) against a
// coarse-to-fine hierarchical zoom that recurses into the highest-delta region.
// Usage: pnpm tsx experiments/rlm/bisect.ts [conversationId]

const ROBERTA_MODEL = 'nicky48/emotion-english-distilroberta-base-ONNX'
type Labels = Array<{ label: string; score: number }>

let evals = 0
let classify: ((input: string[], opts: Record<string, unknown>) => Promise<unknown>) | null = null

async function scoreTexts(texts: string[]): Promise<AnchorScores[]> {
  if (!classify) classify = (await pipeline('text-classification', ROBERTA_MODEL, { dtype: 'q8' })) as never
  evals += texts.length
  const out = (await classify!(texts, { top_k: 7, truncation: true })) as Labels[] | Labels
  const rows = (Array.isArray(out[0]) ? out : [out]) as Labels[]
  return rows.map((labels) => {
    const s = Object.fromEntries(EKMAN_ANCHORS.map((a) => [a, 0])) as AnchorScores
    for (const l of labels) {
      const k = l.label.toLowerCase()
      if ((EKMAN_ANCHORS as readonly string[]).includes(k)) s[k as Anchor] = l.score
    }
    return s
  })
}

const dist = (a: AnchorScores, b: AnchorScores) =>
  Math.sqrt(EKMAN_ANCHORS.reduce((s, k) => s + (a[k] - b[k]) ** 2, 0))
const dominant = (s: AnchorScores): Anchor => EKMAN_ANCHORS.reduce((a, b) => (s[b] > s[a] ? b : a), 'neutral' as Anchor)
const join = (msgs: Array<{ text: string; me: boolean }>, lo: number, hi: number) =>
  msgs.slice(lo, hi).map((m) => `${m.me ? 'me' : 'them'}: ${m.text}`).join('\n').slice(0, 1800)

async function main() {
  const conversationId = Number(process.argv[2] ?? 1)
  const db = new Database(process.env.IMESSAGE_EMOTION_DB_PATH!, { readonly: true })
  const rows = db
    .prepare('SELECT text, is_from_me FROM messages WHERE conversation_id = ? AND text IS NOT NULL ORDER BY conversation_ordinal')
    .all(conversationId) as Array<{ text: string; is_from_me: number }>
  const msgs = rows.map((r) => ({ text: r.text, me: !!r.is_from_me }))
  const N = msgs.length
  console.log(`[setup] conversation ${conversationId}: ${N} messages\n`)

  // --- Full scan: score every size-8 window, find the sharpest adjacent shift.
  evals = 0
  const W = 8
  const fullWindows: Array<{ lo: number; hi: number }> = []
  for (let lo = 0; lo + W <= N; lo += W) fullWindows.push({ lo, hi: lo + W })
  const fullScores = await scoreTexts(fullWindows.map((w) => join(msgs, w.lo, w.hi)))
  let fullBest = { idx: 0, delta: -1 }
  for (let i = 1; i < fullScores.length; i++) {
    const d = dist(fullScores[i], fullScores[i - 1])
    if (d > fullBest.delta) fullBest = { idx: i, delta: d }
  }
  const fullEvals = evals
  const fullPivot = fullWindows[fullBest.idx]
  console.log(`[full scan] ${fullEvals} RoBERTa evals — sharpest shift at messages ${fullPivot.lo}-${fullPivot.hi} ` +
    `(${dominant(fullScores[fullBest.idx - 1])} -> ${dominant(fullScores[fullBest.idx])}, delta ${fullBest.delta.toFixed(3)})`)

  // --- Hierarchical zoom: split a range into K segments, recurse into the
  // adjacent pair with the largest emotional distance, until the span is small.
  evals = 0
  const K = 4
  const MIN_SPAN = 8
  async function locate(lo: number, hi: number, depth: number): Promise<{ lo: number; hi: number; delta: number }> {
    const span = hi - lo
    if (span <= MIN_SPAN || depth > 8) return { lo, hi, delta: 0 }
    const seg = Math.max(2, Math.ceil(span / K))
    const bounds: Array<{ lo: number; hi: number }> = []
    for (let s = lo; s < hi; s += seg) bounds.push({ lo: s, hi: Math.min(hi, s + seg) })
    const scores = await scoreTexts(bounds.map((b) => join(msgs, b.lo, b.hi)))
    let best = { i: 1, delta: -1 }
    for (let i = 1; i < scores.length; i++) {
      const d = dist(scores[i], scores[i - 1])
      if (d > best.delta) best = { i, delta: d }
    }
    const childLo = bounds[best.i - 1].lo
    const childHi = bounds[best.i].hi
    const indent = '  '.repeat(depth + 1)
    console.log(`${indent}depth ${depth}: ${bounds.length} segs over ${lo}-${hi} -> zoom ${childLo}-${childHi} (delta ${best.delta.toFixed(3)})`)
    const deeper = await locate(childLo, childHi, depth + 1)
    return deeper.delta > best.delta ? deeper : { lo: childLo, hi: childHi, delta: best.delta }
  }
  console.log(`\n[hierarchical zoom] K=${K}`)
  const located = await locate(0, N, 0)
  const hierEvals = evals
  const lScores = await scoreTexts([join(msgs, Math.max(0, located.lo - W), located.lo), join(msgs, located.lo, located.hi)])
  console.log(`\n[located] messages ${located.lo}-${located.hi} (${dominant(lScores[0])} -> ${dominant(lScores[1])}) in ${hierEvals} evals`)

  const overlap = located.lo < fullPivot.hi && located.hi > fullPivot.lo
  console.log('\n=== RESULT ===')
  console.log(`full scan:    ${fullEvals} evals -> pivot ${fullPivot.lo}-${fullPivot.hi}`)
  console.log(`hierarchical: ${hierEvals} evals -> pivot ${located.lo}-${located.hi}`)
  console.log(`evals saved:  ${(100 * (1 - hierEvals / fullEvals)).toFixed(0)}%   pivots overlap: ${overlap ? 'YES' : 'no'}`)
}

main().catch((error) => {
  console.error('BISECT ERR:', error?.stack ?? error?.message ?? error)
  process.exit(1)
})
