import type { AppDatabase } from '../db/schema'
import { syncLocalContacts } from '../contacts/sync-contacts'

export interface ContactsSyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'stopped'
  scannedContacts: number
  resolvedHandles: number
  error?: string
}

export interface ContactsSyncController {
  syncNow(): Promise<ContactsSyncStatus>
  stop(): void
}

const DEFAULT_CONTACTS_POLL_INTERVAL_MS = 10 * 60 * 1000

export function startContactsSync(
  db: AppDatabase,
  options: {
    pollIntervalMs?: number
    onStatus?: (status: ContactsSyncStatus) => void
  } = {},
): ContactsSyncController {
  let stopped = false
  let running: Promise<ContactsSyncStatus> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CONTACTS_POLL_INTERVAL_MS

  function emit(status: ContactsSyncStatus): ContactsSyncStatus {
    options.onStatus?.(status)
    return status
  }

  async function syncNow(): Promise<ContactsSyncStatus> {
    if (running) return running
    running = Promise.resolve()
      .then(() => {
        emit({ state: 'syncing', scannedContacts: 0, resolvedHandles: 0 })
        const result = syncLocalContacts(db)
        return emit({
          state: 'idle',
          scannedContacts: result.scannedContacts,
          resolvedHandles: result.resolvedHandles,
        })
      })
      .catch((error: unknown) =>
        emit({
          state: 'error',
          scannedContacts: 0,
          resolvedHandles: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        running = null
      })
    return running
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void syncNow().finally(schedule)
    }, pollIntervalMs)
  }

  void syncNow().finally(schedule)

  return {
    syncNow,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      emit({ state: 'stopped', scannedContacts: 0, resolvedHandles: 0 })
    },
  }
}
