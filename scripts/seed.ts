/* Seed the app DB with synthetic conversations + a scored run shaped like the
 * Paper design's arc (tentative -> conflict -> warming). No Full Disk Access /
 * chat.db needed. Run: `pnpm seed`. Idempotent for source_chat_id >= 9000. */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openAppDatabase, type AppDatabase } from '../src/lib/db/schema'

function dbPath(): string {
  if (process.env.IMESSAGE_EMOTION_DB_PATH) return process.env.IMESSAGE_EMOTION_DB_PATH
  const dir = join(homedir(), 'Library', 'Application Support', 'imessage-emotion')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'imessage-emotion.sqlite')
}

type Scores = {
  anger: number
  disgust: number
  fear: number
  joy: number
  neutral: number
  sadness: number
  surprise: number
}
const dominant = (s: Scores) =>
  (Object.entries(s).sort((a, b) => b[1] - a[1])[0][0]) as keyof Scores

// 20-window Ekman arc: tentative (sadness/fear) -> conflict (anger/disgust/fear)
// -> warming (joy). neutral/surprise as light filler.
const z = { anger: 0.05, disgust: 0.03, fear: 0.05, joy: 0.05, neutral: 0.1, sadness: 0.05, surprise: 0.05 }
const ARC: Scores[] = [
  { ...z, sadness: 0.5, fear: 0.3, neutral: 0.25, joy: 0.15 },
  { ...z, sadness: 0.45, fear: 0.25, neutral: 0.25, joy: 0.2 },
  { ...z, sadness: 0.35, fear: 0.2, neutral: 0.3, joy: 0.32, surprise: 0.1 },
  { ...z, joy: 0.5, neutral: 0.25, sadness: 0.2, surprise: 0.12 },
  { ...z, joy: 0.6, neutral: 0.2, sadness: 0.15 },
  { ...z, joy: 0.4, anger: 0.3, fear: 0.3, sadness: 0.25 },
  { ...z, anger: 0.7, disgust: 0.4, fear: 0.45, sadness: 0.35, joy: 0.12 },
  { ...z, anger: 0.78, disgust: 0.5, fear: 0.5, sadness: 0.4, joy: 0.1 },
  { ...z, anger: 0.6, disgust: 0.45, fear: 0.4, sadness: 0.5, joy: 0.12 },
  { ...z, sadness: 0.6, fear: 0.35, anger: 0.3, joy: 0.18 },
  { ...z, sadness: 0.4, joy: 0.35, neutral: 0.2, fear: 0.2 },
  { ...z, joy: 0.55, neutral: 0.2, sadness: 0.2 },
  { ...z, joy: 0.68, neutral: 0.18, surprise: 0.12, sadness: 0.12 },
  { ...z, joy: 0.62, neutral: 0.2, sadness: 0.14 },
  { ...z, joy: 0.72, neutral: 0.15, sadness: 0.1 },
  { ...z, joy: 0.8, neutral: 0.12, surprise: 0.12 },
  { ...z, joy: 0.74, neutral: 0.14 },
  { ...z, joy: 0.84, neutral: 0.1 },
  { ...z, joy: 0.82, neutral: 0.1, surprise: 0.1 },
  { ...z, joy: 0.88, neutral: 0.08 },
]

const WARM = ['so good to see you', 'haha that made my day', 'thank you, really', 'love that', 'miss you', 'proud of you']
const TENSE = ["i feel like you've been distant", "that's what you said last time", 'why does this keep happening', 'i needed you there', 'this is frustrating', 'we need to talk']
const REPAIR = ['you were right, i hear you', "let's plan that trip", 'i appreciate you saying that', 'we got through it', 'feeling close again', 'thanks for being patient']

function phraseFor(ordinal: number): string {
  if (ordinal <= 60) return ordinal % 3 === 0 ? TENSE[ordinal % TENSE.length] : WARM[ordinal % WARM.length]
  if (ordinal <= 90) return TENSE[ordinal % TENSE.length]
  return REPAIR[ordinal % REPAIR.length]
}

function seedConversation(
  db: AppDatabase,
  i: number,
  name: string,
  handle: string,
  messageCount: number,
): { conversationId: number; messageIds: number[] } {
  const contact = db
    .prepare(`INSERT INTO contacts (handle_identifier, normalized_handle, display_name) VALUES (?, ?, ?)`)
    .run(handle, handle, name)
  const contactId = Number(contact.lastInsertRowid)
  const baseTime = 1_700_000_000_000 + i * 1_000_000_000
  const conv = db
    .prepare(
      `INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group, message_count, first_message_at, last_message_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(9000 + i, `seed-${handle}`, name, messageCount, baseTime + 60_000, baseTime + messageCount * 60_000)
  const conversationId = Number(conv.lastInsertRowid)
  db.prepare(`INSERT INTO conversation_participants (conversation_id, contact_id) VALUES (?, ?)`).run(conversationId, contactId)

  const insert = db.prepare(
    `INSERT INTO messages (conversation_id, conversation_ordinal, source_rowid, guid, sender_contact_id, text, sent_at, is_from_me, is_read, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'delivered')`,
  )
  const messageIds: number[] = []
  for (let ordinal = 1; ordinal <= messageCount; ordinal += 1) {
    const fromMe = ordinal % 2 === 0
    const r = insert.run(
      conversationId,
      ordinal,
      ordinal,
      `seed-${handle}-${ordinal}`,
      fromMe ? null : contactId,
      phraseFor(ordinal),
      baseTime + ordinal * 60_000,
      fromMe ? 1 : 0,
    )
    messageIds.push(Number(r.lastInsertRowid))
  }
  return { conversationId, messageIds }
}

function seedRun(db: AppDatabase, conversationId: number, messageIds: number[]): void {
  const run = db
    .prepare(
      `INSERT INTO analysis_runs (conversation_id, method_key, status, window_config_json, context_config_json, scorer_config_json, summary_json, started_at, completed_at)
       VALUES (?, 'baseline-v1', 'completed', '{}', '{}', '{}', ?, ?, ?)`,
    )
    .run(
      conversationId,
      JSON.stringify({ method: 'rolling-shift-summary-v1', windowCount: ARC.length }),
      1_700_000_500_000,
      1_700_000_600_000,
    )
  const runId = Number(run.lastInsertRowid)

  const insertWindow = db.prepare(
    `INSERT INTO windows (
      run_id, conversation_id, ordinal, start_ordinal, end_ordinal,
      context_start_ordinal, context_end_ordinal, focal_start_ordinal, focal_end_ordinal,
      start_message_id, end_message_id, message_count, context_message_count, focal_message_count,
      window_metadata_json, result_json, shift_json, status, latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
  )

  // Only create windows that fit this conversation's message count.
  const usable = ARC.filter((_, k) => k * 10 + 10 <= messageIds.length)
  usable.forEach((scores, k) => {
    const ordinal = k + 1
    const focalStart = k * 10 + 1
    const focalEnd = focalStart + 9
    const contextStart = Math.max(1, focalStart - 20)
    const contextEnd = focalStart - 1
    const dom = dominant(scores)
    const tense = scores.anger + scores.disgust + scores.fear
    const warm = scores.joy
    const shift =
      k === 0
        ? { method: 'rolling-shift-v1', status: 'pending_baseline', strongest: [] }
        : {
            method: 'rolling-shift-v1',
            status: tense > 1.0 ? 'major_shift' : warm > 0.7 ? 'major_shift' : 'stable',
            trend: tense > warm ? 'tenser' : 'warmer',
            strongest: [{ emotion: dom, delta: 0.3, direction: 'increase', label: `${dom} rising` }],
          }
    insertWindow.run(
      runId,
      conversationId,
      ordinal,
      contextStart,
      focalEnd,
      k === 0 ? null : contextStart,
      k === 0 ? null : contextEnd,
      focalStart,
      focalEnd,
      messageIds[contextStart - 1],
      messageIds[focalEnd - 1],
      focalEnd - contextStart + 1,
      k === 0 ? 0 : contextEnd - contextStart + 1,
      10,
      JSON.stringify({ fixtureArc: k < 5 ? 'tentative' : k < 9 ? 'conflict' : 'warming' }),
      JSON.stringify({
        scores,
        dominant: dom,
        confidence: 0.8,
        summary: `Window ${ordinal}: ${dom} leading.`,
        evidenceMessageIds: [messageIds[focalStart - 1], messageIds[focalEnd - 1]],
        method: 'baseline-v1',
      }),
      JSON.stringify(shift),
      8 + k,
    )
  })
}

function main(): void {
  const db = openAppDatabase(dbPath())
  // Idempotent: clear prior seed (cascades to messages/runs/windows).
  db.exec(`DELETE FROM conversations WHERE source_chat_id >= 9000`)
  db.exec(`DELETE FROM contacts WHERE handle_identifier LIKE '+1555000%'`)

  const people = [
    { name: 'Maya Chen', handle: '+15550000001', messages: 220, scored: true },
    { name: 'Jordan Reyes', handle: '+15550000002', messages: 60, scored: true },
    { name: 'Dad', handle: '+15550000003', messages: 40, scored: false },
    { name: 'Priya Anand', handle: '+15550000004', messages: 30, scored: false },
    { name: 'Sam Okafor', handle: '+15550000005', messages: 80, scored: true },
  ]

  const tx = db.transaction(() => {
    people.forEach((p, i) => {
      const { conversationId, messageIds } = seedConversation(db, i + 1, p.name, p.handle, p.messages)
      if (p.scored) seedRun(db, conversationId, messageIds)
    })
  })
  tx()

  const convs = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE source_chat_id >= 9000`).get() as { c: number }
  const wins = db.prepare(`SELECT COUNT(*) AS c FROM windows`).get() as { c: number }
  db.close()
  console.log(`Seeded ${convs.c} conversations, ${wins.c} scored windows -> ${dbPath()}`)
}

main()
