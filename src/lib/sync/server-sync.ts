import type { SyncStatus } from '../api/types'
import type { AppDatabase } from '../db/schema'
import { startContactsSync } from './contacts-sync'
import { startIMessageSync } from './imessage-sync'

export interface ServerSyncEngine {
  getStatus(): SyncStatus
  syncMessages(): Promise<SyncStatus>
  syncContacts(): Promise<SyncStatus>
  stop(): void
}

const globalForSync = globalThis as unknown as { __imeServerSyncEngine?: ServerSyncEngine }

export function createServerSyncEngine(db: AppDatabase): ServerSyncEngine {
  const messages = startIMessageSync(db)
  const contacts = startContactsSync(db)

  function getStatus(): SyncStatus {
    return {
      messages: messages.getStatus(),
      contacts: contacts.getStatus(),
    }
  }

  const engine: ServerSyncEngine = {
    getStatus,
    async syncMessages() {
      await messages.syncNow({ catchUp: true })
      return getStatus()
    },
    async syncContacts() {
      await contacts.syncNow()
      return getStatus()
    },
    stop() {
      messages.stop()
      contacts.stop()
      if (globalForSync.__imeServerSyncEngine === engine) {
        globalForSync.__imeServerSyncEngine = undefined
      }
    },
  }
  return engine
}

export function getServerSyncEngine(db: AppDatabase): ServerSyncEngine {
  if (!globalForSync.__imeServerSyncEngine) {
    globalForSync.__imeServerSyncEngine = createServerSyncEngine(db)
  }
  return globalForSync.__imeServerSyncEngine
}
