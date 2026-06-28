import type { AppDatabase } from '../db/schema'
import type { JsonRecord } from './types'

const tableColumnCache = new WeakMap<AppDatabase, Map<string, Set<string>>>()

export function hasColumn(db: AppDatabase, table: string, column: string): boolean {
  let dbCache = tableColumnCache.get(db)
  if (!dbCache) {
    dbCache = new Map()
    tableColumnCache.set(db, dbCache)
  }

  let columns = dbCache.get(table)
  if (!columns) {
    columns = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string
        }>
      ).map((row) => row.name),
    )
    dbCache.set(table, columns)
  }

  return columns.has(column)
}

export function parseJsonRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonRecord
    }
  } catch {
    return {}
  }
  return {}
}
