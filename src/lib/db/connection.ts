import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
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

type Connection = { sqlite: AppDatabase; orm: BetterSQLite3Database }

// Cache on globalThis so Next's dev HMR reuses one connection (and one migrate()).
const globalForDb = globalThis as unknown as { __imeConnection?: Connection }

export function getConnection(): Connection {
  if (!globalForDb.__imeConnection) {
    const sqlite = openAppDatabase(resolveDbPath())
    globalForDb.__imeConnection = { sqlite, orm: drizzle(sqlite) }
  }
  return globalForDb.__imeConnection
}

// The raw better-sqlite3 handle the existing query layer (src/lib/api/*) expects.
export function getDb(): AppDatabase {
  return getConnection().sqlite
}

// The Drizzle ORM instance, for typed queries going forward.
export function getOrm(): BetterSQLite3Database {
  return getConnection().orm
}
