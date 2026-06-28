import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@/server/router'

// Typed tRPC client — all input/output types are inferred from AppRouter,
// so there is no hand-maintained contract between frontend and backend.
export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/api/trpc' })],
})
