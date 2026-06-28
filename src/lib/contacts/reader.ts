import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ContactRecord {
  sourceId: string
  displayName: string
  company: string | null
  avatarUrl: string | null
  phoneNumbers: string[]
  emails: string[]
}

type ContactRecordInput = Partial<ContactRecord> & {
  displayName?: string
  phoneNumbers?: string[]
  emails?: string[]
}

const CUED_NATIVE_HELPER_NAME = 'cued-native-helper'
const APP_NATIVE_HELPER_NAME = 'imessage-emotion-native-helper'

function normalizeContactRecord(contact: ContactRecordInput, index: number): ContactRecord {
  const phoneNumbers = contact.phoneNumbers ?? []
  const emails = contact.emails ?? []
  const displayName = contact.displayName?.trim() || 'Unknown'
  return {
    sourceId: contact.sourceId ?? `contacts:${index}:${displayName}:${phoneNumbers.join(',')}:${emails.join(',')}`,
    displayName,
    company: contact.company ?? null,
    avatarUrl: contact.avatarUrl ?? null,
    phoneNumbers,
    emails,
  }
}

export function loadContactsFromFile(path: string): ContactRecord[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as
    | ContactRecord[]
    | {
        contacts?: Array<{
          sourceId?: string
          displayName?: string
          company?: string | null
          avatarUrl?: string | null
          phoneNumbers?: string[]
          emails?: string[]
        }>
      }

  if (Array.isArray(parsed)) return parsed

  if (parsed && Array.isArray(parsed.contacts)) {
    return parsed.contacts.map(normalizeContactRecord)
  }

  throw new Error(`Unsupported contacts file shape: ${path}`)
}

export function getNativeContactsHelperCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.IMESSAGE_CONTACTS_NATIVE_BINARY,
    join(process.cwd(), 'native', 'macos', 'ContactsHelper', '.build', 'release', APP_NATIVE_HELPER_NAME),
    join(process.cwd(), 'native', 'macos', 'ContactsHelper', '.build', 'debug', APP_NATIVE_HELPER_NAME),
    join(
      process.cwd(),
      'native',
      'macos',
      'ContactsHelper',
      '.build',
      'arm64-apple-macosx',
      'release',
      APP_NATIVE_HELPER_NAME,
    ),
    join(
      process.cwd(),
      'native',
      'macos',
      'ContactsHelper',
      '.build',
      'x86_64-apple-macosx',
      'release',
      APP_NATIVE_HELPER_NAME,
    ),
    env.CUED_CONTACTS_NATIVE_BINARY,
    env.CUED_APP_PATH
      ? join(env.CUED_APP_PATH, 'Contents', 'Resources', 'helpers', CUED_NATIVE_HELPER_NAME)
      : null,
    join('/Applications', 'Cued.app', 'Contents', 'Resources', 'helpers', CUED_NATIVE_HELPER_NAME),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()))
}

export function resolveNativeContactsHelper(env: NodeJS.ProcessEnv = process.env): string | null {
  return getNativeContactsHelperCandidates(env).find((candidate) => existsSync(candidate)) ?? null
}

export function loadContactsFromNativeHelper(path: string): ContactRecord[] {
  const statusStdout = execFileSync(path, ['contacts', 'status'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  const status = JSON.parse(statusStdout) as { status?: string }
  if (status.status !== 'authorized') {
    throw new Error(`Contacts permission is ${status.status ?? 'unknown'}`)
  }

  const stdout = execFileSync(path, ['contacts', 'dump'], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  const contacts = JSON.parse(stdout) as ContactRecordInput[]
  return contacts.map(normalizeContactRecord)
}

export function loadLocalContacts(path = process.env.IMESSAGE_CONTACTS_JSON_PATH): ContactRecord[] {
  if (path) return loadContactsFromFile(path)

  const nativeHelper = resolveNativeContactsHelper()
  if (nativeHelper) return loadContactsFromNativeHelper(nativeHelper)

  throw new Error(
    'Contacts native helper not found. Set IMESSAGE_CONTACTS_NATIVE_BINARY or install Cued.app.',
  )
}
