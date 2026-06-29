import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openAppDatabase, type AppDatabase } from './schema'

// The app's own synced SQLite DB (NOT Apple's chat.db, which the importer reads).
// Override with IMESSAGE_EMOTION_DB_PATH.
export function resolveDbPath(): string {
  const override = process.env.IMESSAGE_EMOTION_DB_PATH
  if (override) return override
  const dir = join(homedir(), 'Library', 'Application Support', 'imessage-emotion')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'imessage-emotion.sqlite')
}

// Cache on globalThis so Next's dev HMR reuses one connection (and one migrate()).
const globalForDb = globalThis as unknown as { __imeConnection?: AppDatabase }

export function getConnection(): AppDatabase {
  if (!globalForDb.__imeConnection) {
    globalForDb.__imeConnection = openAppDatabase(resolveDbPath())
  }
  return globalForDb.__imeConnection
}

export function getDb(): AppDatabase {
  return getConnection()
}
