import { defineAgent } from 'eve'

// Routed through Vercel AI Gateway (provider/model). Override with EVE_MODEL.
export default defineAgent({
  model: process.env.EVE_MODEL ?? 'anthropic/claude-sonnet-4.6',
})
