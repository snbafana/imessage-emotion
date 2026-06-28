import type { AppDatabase } from '../db/schema'
import { getLastImportedRowid, importBatch, recordImportError } from '../import/import-messages'
import { DEFAULT_CHAT_DB_PATH, LocalIMessageReader } from '../imessage/reader'

export interface IMessageSyncOptions {
  chatDbPath?: string
  batchSize?: number
  pollIntervalMs?: number
  onStatus?: (status: IMessageSyncStatus) => void
}

export interface IMessageSyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'stopped'
  cursor: number
  importedMessages: number
  error?: string
}

export interface IMessageSyncController {
  syncNow(): Promise<IMessageSyncStatus>
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
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const chatDbPath = options.chatDbPath ?? process.env.IMESSAGE_CHAT_DB_PATH ?? DEFAULT_CHAT_DB_PATH

  function emit(status: IMessageSyncStatus): IMessageSyncStatus {
    options.onStatus?.(status)
    return status
  }

  async function syncNow(): Promise<IMessageSyncStatus> {
    if (running) return running
    running = Promise.resolve()
      .then(() => {
        let cursor = getLastImportedRowid(db)
        let importedMessages = 0
        emit({ state: 'syncing', cursor, importedMessages })

        const reader = new LocalIMessageReader(chatDbPath)
        try {
          for (;;) {
            const batch = reader.buildBatch(cursor, batchSize)
            const result = importBatch(db, batch)
            cursor = result.cursor
            importedMessages += result.importedMessages
            if (batch.fetchedCount < batchSize) break
          }
        } finally {
          reader.close()
        }

        return emit({ state: 'idle', cursor, importedMessages })
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
    }, pollIntervalMs)
  }

  void syncNow().finally(schedule)

  return {
    syncNow,
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
