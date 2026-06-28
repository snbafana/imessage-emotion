import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ContactsPermissionState =
  | 'authorized'
  | 'not_determined'
  | 'denied'
  | 'restricted'
  | 'limited'
  | 'unknown'
  | 'check_failed'

export interface ContactsReadiness {
  state: ContactsPermissionState
  summary: string
  canSync: boolean
  error?: string
}

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

export function loadContactsFromMacOS(): ContactRecord[] {
  const script = `
    const app = Application('Contacts');
    const people = app.people();
    const output = [];

    for (let i = 0; i < people.length; i += 1) {
      const person = people[i];
      const phones = [];
      const emails = [];

      const phonesValue = person.phones();
      for (let j = 0; j < phonesValue.length; j += 1) {
        phones.push(String(phonesValue[j].value()));
      }

      const emailsValue = person.emails();
      for (let j = 0; j < emailsValue.length; j += 1) {
        emails.push(String(emailsValue[j].value()));
      }

      output.push({
        sourceId: String(person.id()),
        displayName: [String(person.firstName() || ''), String(person.lastName() || '')].join(' ').trim() || String(person.organization() || 'Unknown'),
        company: String(person.organization() || '') || null,
        avatarUrl: null,
        phoneNumbers: phones,
        emails: emails,
      });
    }

    JSON.stringify(output);
  `

  const stdout = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  return JSON.parse(stdout) as ContactRecord[]
}

export function loadLocalContacts(path = process.env.IMESSAGE_CONTACTS_JSON_PATH): ContactRecord[] {
  if (path) return loadContactsFromFile(path)

  const nativeHelper = resolveNativeContactsHelper()
  if (nativeHelper) return loadContactsFromNativeHelper(nativeHelper)

  if (process.env.IMESSAGE_CONTACTS_ALLOW_JXA === '1') return loadContactsFromMacOS()

  throw new Error(
    'Contacts native helper not found. Set IMESSAGE_CONTACTS_NATIVE_BINARY or IMESSAGE_CONTACTS_ALLOW_JXA=1 to use the slow JXA fallback.',
  )
}

function contactsStatusSummary(state: ContactsPermissionState): string {
  switch (state) {
    case 'authorized':
      return 'Contacts permission is granted for local Contacts sync.'
    case 'not_determined':
      return 'Contacts permission has not been requested yet.'
    case 'denied':
      return 'Contacts permission is denied.'
    case 'restricted':
      return 'Contacts permission is restricted by macOS policy.'
    case 'limited':
      return 'Contacts permission is limited.'
    case 'check_failed':
      return 'Contacts permission could not be checked.'
    case 'unknown':
      return 'Contacts permission status is unknown.'
  }
}

function parseContactsAuthorizationStatus(value: string): ContactsPermissionState {
  switch (value.trim()) {
    case '0':
      return 'not_determined'
    case '1':
      return 'restricted'
    case '2':
      return 'denied'
    case '3':
      return 'authorized'
    case '4':
      return 'limited'
    default:
      return 'unknown'
  }
}

export function checkContactsReadiness(): ContactsReadiness {
  if (process.env.IMESSAGE_CONTACTS_JSON_PATH) {
    return {
      state: 'authorized',
      summary: 'Contacts sync is configured to use a local contacts JSON file.',
      canSync: true,
    }
  }

  if (process.platform !== 'darwin') {
    return {
      state: 'unknown',
      summary: 'Contacts permission can only be checked on macOS.',
      canSync: false,
    }
  }

  try {
    const stdout = execFileSync(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        "ObjC.import('Contacts'); String($.CNContactStore.authorizationStatusForEntityType($.CNEntityTypeContacts));",
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const state = parseContactsAuthorizationStatus(stdout)
    return {
      state,
      summary: contactsStatusSummary(state),
      canSync: state === 'authorized' || state === 'limited' || state === 'not_determined',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      state: 'check_failed',
      summary: contactsStatusSummary('check_failed'),
      canSync: false,
      error: message,
    }
  }
}
