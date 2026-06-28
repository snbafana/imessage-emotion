import { getDb } from '../../../src/lib/db/connection'
import { createAxRun } from '../../../src/lib/emotion/run-analysis'
import { scoreRunTwoTier } from '../../../src/lib/emotion/two-tier-scorer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Streams a two-tier analysis (RoBERTa triage -> RLM exploration) as Server-Sent
// Events so the UI can render the triage sweep and the deep-reads live.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const conversationId = Number(url.searchParams.get('conversationId'))
  const focal = Number(url.searchParams.get('focal') ?? 4)
  const stride = Number(url.searchParams.get('stride') ?? 1)
  const topK = Number(url.searchParams.get('topK') ?? 25)

  if (!Number.isFinite(conversationId)) {
    return new Response('conversationId required', { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      try {
        const db = getDb()
        const { runId, windowCount } = createAxRun(db, conversationId, {
          mode: 'comparative-message-count',
          contextMessages: focal * 2,
          focalMessages: focal,
          stride,
          minFocalMessages: 1,
        })
        send({ type: 'setup', runId, total: windowCount, topK })
        const result = await scoreRunTwoTier(db, runId, {
          topK,
          subConcurrency: 50,
          onTriage: (e) => send({ type: 'triage', ...e }),
          onExplore: (e) => send({ type: 'explore', ...e }),
        })
        send({ type: 'done', runId, summary: result.explore.summary, hot: result.hot, triage: result.triage })
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
