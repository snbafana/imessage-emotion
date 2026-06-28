// Seeds the app's SQLite DB with synthetic conversations, messages, and contacts
// so anyone can click "Continue" through onboarding and explore the dashboard
// without real iMessage data or macOS permissions.
//
// Writes to the same DB the server reads (resolveDbPath / IMESSAGE_EMOTION_DB_PATH).
// Safe to run repeatedly: imports are upserts keyed by stable ids/guids.
//
//   pnpm seed:mock

import { resolveDbPath } from '../src/lib/db/connection.ts'
import { openAppDatabase, getPrivacySafeCounts } from '../src/lib/db/schema.ts'
import { importBatch } from '../src/lib/import/import-messages.ts'
import { syncContactRecords } from '../src/lib/contacts/sync-contacts.ts'

// Base timestamp (seconds) — a fixed point so reruns are deterministic.
const BASE = 1_700_000_000
const minutes = (n) => BASE + n * 60

// Three demo people + a small group, each with a short, emotionally-varied thread.
const HANDLES = [
  { id: 101, identifier: '+14155550101', service: 'iMessage' },
  { id: 102, identifier: '+14155550102', service: 'iMessage' },
  { id: 103, identifier: '+14155550103', service: 'iMessage' },
]

const CHATS = [
  {
    id: 201,
    identifier: 'chat-201',
    displayName: null,
    isGroup: false,
    participants: [HANDLES[0]],
  },
  {
    id: 202,
    identifier: 'chat-202',
    displayName: null,
    isGroup: false,
    participants: [HANDLES[1]],
  },
  {
    id: 203,
    identifier: 'chat-203',
    displayName: 'Weekend Trip',
    isGroup: true,
    participants: [HANDLES[0], HANDLES[1], HANDLES[2]],
  },
]

// [chatId, fromMe, sender, text, minuteOffset]
const SCRIPT = [
  [201, false, HANDLES[0], 'hey! are we still on for dinner tonight?', 0],
  [201, true, null, 'yes! 7pm works. so excited 🎉', 2],
  [201, false, HANDLES[0], 'perfect, been looking forward to this all week', 4],
  [201, true, null, 'same. see you soon!', 6],

  [202, false, HANDLES[1], 'did you get a chance to look at the doc?', 30],
  [202, true, null, 'not yet, slammed today. sorry.', 33],
  [202, false, HANDLES[1], 'this is the third time. i really needed it by noon.', 40],
  [202, true, null, 'you’re right, that’s on me. sending notes in 10.', 45],
  [202, false, HANDLES[1], 'ok. thank you.', 52],

  [203, false, HANDLES[0], 'who’s driving up friday?', 120],
  [203, false, HANDLES[2], 'i can! got room for 3', 122],
  [203, true, null, 'amazing, i’ll bring snacks', 124],
  [203, false, HANDLES[1], 'wait i might have to bail, work thing', 130],
  [203, false, HANDLES[0], 'noooo come on, we planned this forever ago', 132],
  [203, false, HANDLES[1], 'i know, i’m trying to move it. will confirm tonight', 140],
]

const CONTACTS = [
  {
    sourceId: 'mock-card-101',
    displayName: 'Alex Rivera',
    company: null,
    avatarUrl: null,
    phoneNumbers: ['+14155550101'],
    emails: [],
  },
  {
    sourceId: 'mock-card-102',
    displayName: 'Jordan Lee',
    company: 'Acme Co',
    avatarUrl: null,
    phoneNumbers: ['+14155550102'],
    emails: [],
  },
  {
    sourceId: 'mock-card-103',
    displayName: 'Sam Patel',
    company: null,
    avatarUrl: null,
    phoneNumbers: ['+14155550103'],
    emails: [],
  },
]

const messages = SCRIPT.map(([chatId, isFromMe, sender, text, offset], index) => ({
  id: 1000 + index,
  guid: `mock-guid-${1000 + index}`,
  chatId,
  text,
  timestamp: minutes(offset),
  isFromMe,
  isRead: true,
  readAt: null,
  status: 'read',
  errorCode: 0,
  hasAttachments: false,
  sender,
}))

const path = resolveDbPath()
const db = openAppDatabase(path)
try {
  importBatch(db, {
    cursor: 1000 + messages.length,
    fetchedCount: messages.length,
    handles: HANDLES,
    chats: CHATS,
    messages,
  })
  syncContactRecords(db, CONTACTS)

  const counts = getPrivacySafeCounts(db)
  console.log(
    `Seeded mock data into ${path}\n` +
      `  ${counts.conversations} conversations, ${counts.messages} messages, ${counts.contacts} contacts`,
  )
} finally {
  db.close()
}
