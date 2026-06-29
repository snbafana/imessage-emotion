import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '@/server/router'

// better-sqlite3 must run in the Node runtime, and the DB is read live.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => ({}),
  })
}

export { handler as GET, handler as POST }
