import { agent, ai, AxJSRuntime } from '@ax-llm/ax'

// Minimal RLM smoke: confirm agent() + AxJSRuntime + llmQuery + forward run
// against the AI Gateway. Run with: pnpm tsx experiments/rlm/smoke.ts
async function main() {
  const apiKey = process.env.AI_GATEWAY_API_KEY
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY not set')

  const service = ai({
    name: 'openai',
    apiKey,
    apiURL: 'https://ai-gateway.vercel.sh/v1',
    models: [{ key: 'default', description: 'sonnet', model: 'anthropic/claude-sonnet-4.6' as never }],
    config: { model: 'default' as never, temperature: 0 },
  } as never)

  const classify = agent('task:string, notes:json -> answer:string "one-line summary"', {
    contextFields: ['notes'],
    runtime: new AxJSRuntime(),
    contextPolicy: { preset: 'checkpointed', budget: 'balanced' },
  })

  const out = await classify.forward(service as never, {
    task: 'For each note, use llmQuery to classify its dominant emotion (one word). Then summarize the arc in one line.',
    notes: [
      { id: 1, text: 'i love you, today was perfect' },
      { id: 2, text: 'honestly i am so done with this' },
      { id: 3, text: "i'm sorry, can we talk?" },
    ],
  })

  console.log('OK output:', JSON.stringify(out, null, 2))
}

main().catch((error) => {
  console.error('SMOKE ERR:', error?.message ?? error)
  process.exit(1)
})
