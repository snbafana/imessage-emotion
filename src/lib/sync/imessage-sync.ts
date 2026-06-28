import type { AppDatabase } from '../db/schema'
import { getLastImportedRowid, importBatch, recordImportError } from '../import/import-messages'
import { DEFAULT_CHAT_DB_PATH, LocalIMessageReader } from '../imessage/reader'

export interface IMessageSyncOptions {
  chatDbPath?: string
  batchSize?: number
  pollIntervalMs?: number
  startOnCreate?: boolean
  onStatus?: (status: IMessageSyncStatus) => void
}

export interface IMessageSyncNowOptions {
  catchUp?: boolean
}

export interface IMessageSyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'stopped'
  cursor: number
  importedMessages: number
  hasMore?: boolean
  error?: string
}

export interface IMessageSyncController {
  syncNow(options?: IMessageSyncNowOptions): Promise<IMessageSyncStatus>
  getStatus(): IMessageSyncStatus
  stop(): void
}

const DEFAULT_BATCH_SIZE = 1_000
const DEFAULT_POLL_INTERVAL_MS = 30_000

export function startIMessageSync(
  db: AppDatabase,
  options: IMessageSyncOptions = {},
): IMessageSyncController {
  let stopped = false
  let running: Promise<IMessageSyncStatus> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRunHadMore = false
  let lastStatus: IMessageSyncStatus = {
    state: 'idle',
    cursor: getLastImportedRowid(db),
    importedMessages: 0,
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const chatDbPath = options.chatDbPath ?? process.env.IMESSAGE_CHAT_DB_PATH ?? DEFAULT_CHAT_DB_PATH

  function emit(status: IMessageSyncStatus): IMessageSyncStatus {
    lastStatus = status
    options.onStatus?.(status)
    return status
  }

  async function syncNow(syncOptions: IMessageSyncNowOptions = {}): Promise<IMessageSyncStatus> {
    if (running) {
      if (!syncOptions.catchUp) return running
      return running.then((status) => (status.hasMore ? syncNow(syncOptions) : status))
    }
    running = Promise.resolve()
      .then(() => {
        let cursor = getLastImportedRowid(db)
        let importedMessages = 0
        let hasMore = false
        emit({ state: 'syncing', cursor, importedMessages })

        const reader = new LocalIMessageReader(chatDbPath)
        try {
          do {
            const batch = reader.buildBatch(cursor, batchSize)
            const result = importBatch(db, batch)
            cursor = result.cursor
            importedMessages += result.importedMessages
            hasMore = batch.fetchedCount >= batchSize
            lastRunHadMore = hasMore
            if (syncOptions.catchUp && hasMore) {
              emit({ state: 'syncing', cursor, importedMessages, hasMore })
            }
          } while (syncOptions.catchUp && hasMore)
        } finally {
          reader.close()
        }

        return emit({ state: 'idle', cursor, importedMessages, hasMore })
      })
      .catch((error: unknown) => {
        recordImportError(db, error)
        const message = error instanceof Error ? error.message : String(error)
        return emit({
          state: 'error',
          cursor: getLastImportedRowid(db),
          importedMessages: 0,
          error: message,
        })
      })
      .finally(() => {
        running = null
      })
    return running
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void syncNow().finally(schedule)
    }, lastRunHadMore ? 0 : pollIntervalMs)
  }

  if (options.startOnCreate ?? true) {
    void syncNow().finally(schedule)
  }

  return {
    syncNow,
    getStatus() {
      return lastStatus
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      emit({
        state: 'stopped',
        cursor: getLastImportedRowid(db),
        importedMessages: 0,
      })
    },
  }
}
