import type { JsonRecord } from './types'

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
