import { ai, ax } from '@ax-llm/ax'

// Outcome + speed test across OpenAI models on windows with known ground-truth
// emotions. Measures dominant-emotion accuracy and latency, and prints rationales.
// Usage: pnpm tsx experiments/rlm/models.ts

const MODELS = ['gpt-5-nano', 'gpt-5-mini', 'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4.1']

// Labeled windows covering all 7 Ekman emotions (synthetic, hand-labeled).
const CASES: Array<{ text: string; expected: string }> = [
  { expected: 'joy', text: 'me: Loved catching up today, I missed your jokes.\nthem: That made my week, seriously.\nme: Let us do dinner Friday, I can cook.' },
  { expected: 'anger', text: 'me: I feel like you keep dodging the actual issue.\nme: I am not mad, but I am frustrated that this keeps happening.\nme: Can you please just tell me directly if plans changed?' },
  { expected: 'sadness', text: 'me: I do not really have energy to talk tonight.\nthem: ok.\nme: Let us just leave it for later.' },
  { expected: 'neutral', text: 'me: Train is delayed 12 minutes.\nthem: Can you grab the keys from the desk?\nme: I will be there at 6:40.' },
  { expected: 'sadness', text: 'them: That hurt more than I expected.\nthem: I felt dismissed when you laughed it off.\nme: I did not realize, I am sorry.' },
  { expected: 'joy', text: 'me: I am sorry. I was defensive and did not listen well.\nthem: Thank you for saying that, it means a lot.\nme: I care about us.' },
  { expected: 'surprise', text: 'them: wait WHAT?? no way that actually happened??\nme: I literally cannot believe it\nthem: did not see that coming at all' },
  { expected: 'disgust', text: 'them: ugh that is so gross, I cannot even\nme: that whole thing made me sick honestly\nthem: absolutely revolting' },
  { expected: 'fear', text: 'me: I am really worried about the results tomorrow\nme: so anxious I cannot sleep\nthem: I keep panicking about what could go wrong' },
]

const sig = ax(`
  messages:string "a short iMessage window"
  ->
  dominant:class "anger, disgust, fear, joy, neutral, sadness, surprise" "the single dominant emotion",
  confidence:number "0..1",
  rationale:string "one short sentence explaining the call"
`)

function service(model: string) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  // gpt-5* are reasoning models: they require temperature 1 and need token
  // headroom for hidden reasoning, so give them a larger completion budget.
  const isReasoning = model.startsWith('gpt-5')
  return ai({
    name: 'openai',
    apiKey,
    models: [{ key: 'default', description: model, model: model as never }],
    config: { model: 'default' as never, temperature: isReasoning ? 1 : 0, maxTokens: isReasoning ? 3000 : 400 },
  } as never)
}

async function main() {
  const results: Array<{ model: string; acc: number; avgMs: number; perCase: Array<{ expected: string; got: string; ok: boolean; ms: number; rationale: string }> }> = []

  for (const model of MODELS) {
    const svc = service(model)
    const perCase = []
    try {
      // run cases concurrently per model
      const timed = await Promise.all(
        CASES.map(async (c) => {
          const t0 = performance.now()
          const out = (await sig.forward(svc as never, { messages: c.text })) as { dominant?: string; confidence?: number; rationale?: string }
          const ms = Math.round(performance.now() - t0)
          const got = String(out.dominant ?? '').toLowerCase().trim()
          return { expected: c.expected, got, ok: got === c.expected, ms, rationale: String(out.rationale ?? '').slice(0, 80) }
        }),
      )
      perCase.push(...timed)
      const acc = perCase.filter((r) => r.ok).length / perCase.length
      const avgMs = Math.round(perCase.reduce((s, r) => s + r.ms, 0) / perCase.length)
      results.push({ model, acc, avgMs, perCase })
      console.log(`[done] ${model}: acc=${(acc * 100).toFixed(0)}%  avg=${avgMs}ms/window`)
    } catch (error) {
      console.log(`[skip] ${model}: ${(error as Error)?.message?.slice(0, 80)}`)
    }
  }

  console.log('\n=== ACCURACY x SPEED ===')
  console.log(['model', 'accuracy', 'avg ms/window'].join('\t'))
  for (const r of results) console.log([r.model, `${(r.acc * 100).toFixed(0)}%`, `${r.avgMs}ms`].join('\t'))

  console.log('\n=== PER-CASE (model x expected -> got) ===')
  const header = ['expected', ...results.map((r) => r.model)].join('\t')
  console.log(header)
  CASES.forEach((c, i) => {
    const row = [c.expected, ...results.map((r) => `${r.perCase[i]?.got ?? '-'}${r.perCase[i]?.ok ? '' : ' ✗'}`)]
    console.log(row.join('\t'))
  })

  console.log('\n=== SAMPLE RATIONALES (smartest model) ===')
  const best = results[results.length - 1]
  if (best) best.perCase.forEach((r, i) => console.log(`  ${CASES[i].expected} -> ${r.got}: ${r.rationale}`))
}

main().catch((error) => {
  console.error('MODELS ERR:', error?.stack ?? error?.message ?? error)
  process.exit(1)
})
