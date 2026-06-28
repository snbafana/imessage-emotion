import Database from 'better-sqlite3'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { openAppDatabase } = await import('../src/lib/db/schema.ts')
const { importBatch } = await import('../src/lib/import/import-messages.ts')
const { syncContactRecords } = await import('../src/lib/contacts/sync-contacts.ts')
const { buildOnboardingStatus } = await import('../src/lib/onboarding/status.ts')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const dir = mkdtempSync(join(tmpdir(), 'imessage-emotion-onboarding-smoke-'))
const oldContactsPath = process.env.IMESSAGE_CONTACTS_JSON_PATH
const oldAppDbPath = process.env.IMESSAGE_EMOTION_DB_PATH
const oldChatDbPath = process.env.IMESSAGE_CHAT_DB_PATH

try {
  const chatDbPath = join(dir, 'synthetic-chat.sqlite')
  const chatDb = new Database(chatDbPath)
  chatDb.exec('CREATE TABLE message (ROWID INTEGER PRIMARY KEY)')
  chatDb.prepare('INSERT INTO message (ROWID) VALUES (1)').run()
  chatDb.close()
  chmodSync(chatDbPath, 0o600)

  const contactsPath = join(dir, 'contacts.json')
  writeFileSync(contactsPath, JSON.stringify({ contacts: [] }))
  process.env.IMESSAGE_CONTACTS_JSON_PATH = contactsPath
  process.env.IMESSAGE_CHAT_DB_PATH = chatDbPath
  process.env.IMESSAGE_EMOTION_DB_PATH = join(dir, 'router-app.sqlite')

  const appDb = openAppDatabase(join(dir, 'app.sqlite'))
  try {
    importBatch(appDb, {
      cursor: 1,
      fetchedCount: 1,
      handles: [{ id: 1, identifier: '+14155550123', service: 'iMessage' }],
      chats: [
        {
          id: 10,
          identifier: 'chat-10',
          displayName: null,
          isGroup: false,
          participants: [{ id: 1, identifier: '+14155550123', service: 'iMessage' }],
        },
      ],
      messages: [
        {
          id: 1,
          guid: 'synthetic-guid-1',
          chatId: 10,
          text: 'synthetic setup smoke',
          timestamp: 1_700_000_000,
          isFromMe: false,
          isRead: true,
          readAt: null,
          status: 'read',
          errorCode: 0,
          hasAttachments: false,
          sender: { id: 1, identifier: '+14155550123', service: 'iMessage' },
        },
      ],
    })
    syncContactRecords(appDb, [
      {
        sourceId: 'synthetic-card-1',
        displayName: 'Example Contact',
        company: null,
        avatarUrl: null,
        phoneNumbers: ['+14155550123'],
        emails: [],
      },
    ])

    const status = buildOnboardingStatus(
      appDb,
      {
        messages: { state: 'idle', cursor: 1, importedMessages: 1, hasMore: false },
        contacts: { state: 'idle', scannedContacts: 1, resolvedHandles: 1 },
      },
      { chatDbPath },
    )

    assert(status.ready, 'onboarding status should be ready with readable sources and app data')
    assert(status.permissions.length === 2, 'onboarding status should expose two setup rows')
    assert(status.permissions.every((permission) => permission.canSync), 'all setup rows can sync')
    assert(status.counts.messages === 1, 'message count should come from the app database')
    assert(status.counts.conversations === 1, 'conversation count should come from the app database')
    assert(status.counts.contacts === 1, 'contact count should come from the app database')

    const { appRouter } = await import('../src/server/router.ts')
    const caller = appRouter.createCaller({})
    const apiStatus = await caller.onboardingStatus()
    const { getDb } = await import('../src/lib/db/connection.ts')
    const { getServerSyncEngine } = await import('../src/lib/sync/server-sync.ts')
    getServerSyncEngine(getDb()).stop()
    assert(apiStatus.permissions.length === 2, 'onboarding API should expose two setup rows')
    assert(apiStatus.permissions.every((permission) => permission.canSync), 'onboarding API should be syncable with synthetic state')
    assert(!('text' in apiStatus.counts), 'onboarding API counts must not expose message text')
    assert(!('displayName' in apiStatus.counts), 'onboarding API counts must not expose contact names')

    console.log(
      `Onboarding status smoke passed: ${status.counts.messages} messages, ${status.counts.contacts} contacts`,
    )
  } finally {
    appDb.close()
  }
} finally {
  if (oldContactsPath === undefined) {
    delete process.env.IMESSAGE_CONTACTS_JSON_PATH
  } else {
    process.env.IMESSAGE_CONTACTS_JSON_PATH = oldContactsPath
  }
  if (oldAppDbPath === undefined) {
    delete process.env.IMESSAGE_EMOTION_DB_PATH
  } else {
    process.env.IMESSAGE_EMOTION_DB_PATH = oldAppDbPath
  }
  if (oldChatDbPath === undefined) {
    delete process.env.IMESSAGE_CHAT_DB_PATH
  } else {
    process.env.IMESSAGE_CHAT_DB_PATH = oldChatDbPath
  }
  rmSync(dir, { recursive: true, force: true })
}
