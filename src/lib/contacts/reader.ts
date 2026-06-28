import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface ContactRecord {
  sourceId: string
  displayName: string
  company: string | null
  avatarUrl: string | null
  phoneNumbers: string[]
  emails: string[]
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
    return parsed.contacts.map((contact, index) => {
      const phoneNumbers = contact.phoneNumbers ?? []
      const emails = contact.emails ?? []
      const displayName = contact.displayName?.trim() || 'Unknown'
      return {
        sourceId: contact.sourceId ?? `contacts-file:${index}:${displayName}`,
        displayName,
        company: contact.company ?? null,
        avatarUrl: contact.avatarUrl ?? null,
        phoneNumbers,
        emails,
      }
    })
  }

  throw new Error(`Unsupported contacts file shape: ${path}`)
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
  return path ? loadContactsFromFile(path) : loadContactsFromMacOS()
}
