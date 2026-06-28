import { trpc } from '../lib/trpc/client'
import type { DashboardApi } from './data'

// The dashboard's imperative data client, backed by the typed tRPC client.
// Kept separate from ./data so the pure normalizers/types there carry no
// runtime dependency on the tRPC/server modules.
export function getDashboardApi(): DashboardApi | null {
  if (typeof window === 'undefined') return null
  return {
    listConversations: () => trpc.listConversations.query(),
    getConversation: (id) => trpc.getConversation.query(id),
    listRuns: (id) => trpc.listRuns.query(id),
    createBaselineRun: (id) => trpc.createBaselineRun.mutate({ conversationId: id }),
    getRunWindows: (id) => trpc.getRunWindows.query(id),
    getWindowMessages: (id, slice) => trpc.getWindowMessages.query({ windowId: id, slice }),
    syncMessagesNow: () => trpc.syncMessages.mutate(),
  }
}
