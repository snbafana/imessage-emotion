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
