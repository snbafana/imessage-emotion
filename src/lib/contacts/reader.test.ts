import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadContactsFromFile,
  loadContactsFromNativeHelper,
  resolveNativeContactsHelper,
} from './reader'

describe('contacts reader', () => {
  it('accepts cached contacts wrapper files without source ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imessage-emotion-contacts-'))
    const path = join(dir, 'contacts.json')
    writeFileSync(
      path,
      JSON.stringify({
        contacts: [
          {
            displayName: 'Ava Chen',
            phoneNumbers: ['(415) 555-0123'],
            emails: ['ava@example.com'],
          },
        ],
      }),
    )

    expect(loadContactsFromFile(path)).toEqual([
      {
        sourceId: 'contacts:0:Ava Chen:(415) 555-0123:ava@example.com',
        displayName: 'Ava Chen',
        company: null,
        avatarUrl: null,
        phoneNumbers: ['(415) 555-0123'],
        emails: ['ava@example.com'],
      },
    ])
  })

  it('resolves an explicit native helper path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imessage-emotion-helper-'))
    const helperPath = join(dir, 'cued-native-helper')
    writeFileSync(helperPath, '#!/bin/sh\nexit 0\n')
    chmodSync(helperPath, 0o755)

    expect(
      resolveNativeContactsHelper({ ...process.env, IMESSAGE_CONTACTS_NATIVE_BINARY: helperPath }),
    ).toBe(helperPath)
  })

  it('loads contacts through the native helper contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imessage-emotion-helper-'))
    const helperPath = join(dir, 'cued-native-helper')
    writeFileSync(
      helperPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "contacts" ] && [ "$2" = "status" ]; then',
        '  printf \'{"status":"authorized"}\'',
        '  exit 0',
        'fi',
        'if [ "$1" = "contacts" ] && [ "$2" = "dump" ]; then',
        '  printf \'[{"sourceId":"card-1","displayName":"Ava Chen","phoneNumbers":["(415) 555-0123"],"emails":["ava@example.com"]}]\'',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
    )
    chmodSync(helperPath, 0o755)

    expect(loadContactsFromNativeHelper(helperPath)).toEqual([
      {
        sourceId: 'card-1',
        displayName: 'Ava Chen',
        company: null,
        avatarUrl: null,
        phoneNumbers: ['(415) 555-0123'],
        emails: ['ava@example.com'],
      },
    ])
  })
})
