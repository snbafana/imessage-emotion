import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const { getPrivacySafeCounts, openAppDatabase } = await import('../src/lib/db/schema.ts')
const { importBatch } = await import('../src/lib/import/import-messages.ts')
const { syncContactRecords } = await import('../src/lib/contacts/sync-contacts.ts')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function appDbPath() {
  return (
    process.env.IMESSAGE_EMOTION_DB_PATH ??
    process.env.IMESSAGE_EMOTION_APP_DB ??
    join(homedir(), 'Library', 'Application Support', 'imessage-emotion', 'imessage-emotion.sqlite')
  )
}

function seedSyntheticAppData(db) {
  importBatch(db, {
    cursor: 2,
    fetchedCount: 1,
    handles: [{ id: 2, identifier: '+14155550124', service: 'iMessage' }],
    chats: [
      {
        id: 20,
        identifier: 'chat-20',
        displayName: null,
        isGroup: false,
        participants: [{ id: 2, identifier: '+14155550124', service: 'iMessage' }],
      },
    ],
    messages: [
      {
        id: 2,
        guid: 'synthetic-guid-2',
        chatId: 20,
        text: 'synthetic local db smoke',
        timestamp: 1_700_000_001,
        isFromMe: true,
        isRead: true,
        readAt: null,
        status: 'read',
        errorCode: 0,
        hasAttachments: false,
        sender: null,
      },
    ],
  })
  syncContactRecords(db, [
    {
      sourceId: 'synthetic-card-2',
      displayName: 'Example Contact',
      company: null,
      avatarUrl: null,
      phoneNumbers: ['+14155550124'],
      emails: [],
    },
  ])
}

let tempDir = null
let source = 'real-app-db'
let path = appDbPath()

if (!existsSync(path)) {
  tempDir = mkdtempSync(join(tmpdir(), 'imessage-emotion-local-db-smoke-'))
  path = join(tempDir, 'app.sqlite')
  source = 'synthetic-temp-app-db'
}

try {
  const db = openAppDatabase(path)
  try {
    if (source === 'synthetic-temp-app-db') seedSyntheticAppData(db)
    const counts = getPrivacySafeCounts(db)

    assert(Number.isInteger(counts.conversations), 'conversation count must be an integer')
    assert(Number.isInteger(counts.messages), 'message count must be an integer')
    assert(Number.isInteger(counts.contacts), 'contact count must be an integer')
    assert(!('text' in counts), 'privacy-safe counts must not expose message text')
    assert(!('displayName' in counts), 'privacy-safe counts must not expose contact names')

    console.log(
      `Local app DB smoke passed (${source}): ${counts.conversations} conversations, ${counts.messages} messages, ${counts.contacts} contacts`,
    )
  } finally {
    db.close()
  }
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
}
