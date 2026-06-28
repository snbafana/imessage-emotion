import { normalizePhone, toE164 } from './phone'

const FILTERED_SUFFIX_REGEX = /\s*\(filtered\)\s*$/i

export function normalizeChatDbHandleIdentifier(identifier: string): string {
  return identifier.replace(FILTERED_SUFFIX_REGEX, '')
}

export function normalizeHandleForStorage(identifier: string): string {
  const trimmed = normalizeChatDbHandleIdentifier(identifier).trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  return toE164(trimmed) ?? normalizePhone(trimmed) ?? trimmed
}

export function buildHandleCandidates(identifier: string): string[] {
  const trimmed = identifier.trim()
  if (trimmed.length === 0) return []
  if (trimmed.includes('@')) return [trimmed.toLowerCase()]

  const candidates = new Set<string>()
  const normalized = normalizePhone(trimmed)
  const e164 = toE164(trimmed)
  candidates.add(trimmed)
  if (normalized) {
    candidates.add(normalized)
    if (!normalized.startsWith('+')) candidates.add(`+${normalized}`)
    if (normalized.length === 10) candidates.add(`+1${normalized}`)
  }
  if (e164) candidates.add(e164)
  return [...candidates].filter((candidate) => candidate.length > 0)
}
