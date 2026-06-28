import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AppDatabase } from '../src/lib/db/schema'
import { openAppDatabase } from '../src/lib/db/schema'
import { getConversation, listConversations } from '../src/lib/api/conversations'
import { getWindowMessages } from '../src/lib/api/messages'
import { getRunWindows, listRuns } from '../src/lib/api/runs'

type SeededConversation = {
  conversationId: number
  contactId: number
  messageIds: number[]
}

function withTempDb(name: string, run: (db: AppDatabase) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), `imessage-emotion-${name}-`))
  const db = openAppDatabase(path.join(dir, 'smoke.sqlite'))
  try {
    run(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedConversation(
  db: AppDatabase,
  sourceChatId: number,
  chatIdentifier: string,
  displayName: string,
  handle: string,
  messagePrefix: string,
): SeededConversation {
  const contact = db
    .prepare(
      `
      INSERT INTO contacts (handle_identifier, normalized_handle, display_name)
      VALUES (?, ?, ?)
    `,
    )
    .run(handle, handle, displayName)
  const contactId = Number(contact.lastInsertRowid)

  const conversation = db
    .prepare(
      `
      INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group)
      VALUES (?, ?, NULL, 0)
    `,
    )
    .run(sourceChatId, chatIdentifier)
  const conversationId = Number(conversation.lastInsertRowid)

  db.prepare(
    `
    INSERT INTO conversation_participants (conversation_id, contact_id)
    VALUES (?, ?)
  `,
  ).run(conversationId, contactId)

  const insertMessage = db.prepare(
    `
    INSERT INTO messages (
      conversation_id,
      conversation_ordinal,
      source_rowid,
      guid,
      sender_contact_id,
      text,
      sent_at,
      is_from_me,
      is_read,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'delivered')
  `,
  )
  const messageIds: number[] = []
  for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
    const result = insertMessage.run(
      conversationId,
      ordinal,
      ordinal,
      `${chatIdentifier}-message-${ordinal}`,
      ordinal % 2 === 0 ? null : contactId,
      `${messagePrefix} synthetic message ${ordinal}`,
      1_700_000_000_000 + ordinal * 60_000 + sourceChatId,
      ordinal % 2 === 0 ? 1 : 0,
    )
    messageIds.push(Number(result.lastInsertRowid))
  }

  return { conversationId, contactId, messageIds }
}

function assertConversationReadApi(db: AppDatabase, conversationId: number): void {
  const conversations = listConversations(db)
  const conversation = conversations.find((item) => item.id === conversationId)

  assert.ok(conversation, 'conversation is listed')
  assert.equal(conversation.messageCount, 8)
  assert.equal(conversation.participantCount, 1)
  assert.equal(conversation.firstMessageAt, 1_700_000_060_001)
  assert.equal(conversation.lastMessageAt, 1_700_000_480_001)
  assert.equal(conversation.title, 'Synthetic Contact')

  const detail = getConversation(db, conversationId)
  assert.ok(detail, 'conversation detail is returned')
  assert.equal(detail.participants.length, 1)
  assert.equal(detail.runs.length, 1)
}

// Seeds the canonical run-owned schema (analysis_runs -> windows) and asserts the
// read APIs return it. No legacy scorer_configs/run_windows compatibility path.
function smokeRunOwnedSchema(): void {
  withTempDb('run-owned', (db) => {
    const primary = seedConversation(
      db,
      1,
      'chat-run-owned-primary',
      'Synthetic Contact',
      '+15550002001',
      'primary',
    )
    seedConversation(db, 2, 'chat-run-owned-other', 'Other Contact', '+15550002002', 'other')

    const analysisRun = db
      .prepare(
        `
        INSERT INTO analysis_runs (
          conversation_id,
          method_key,
          status,
          window_config_json,
          context_config_json,
          scorer_config_json,
          summary_json,
          started_at,
          completed_at
        )
        VALUES (?, 'baseline-v1', 'complete', '{}', '{}', '{}', '{"windowCount":1}', 1700000500000, 1700000600000)
      `,
      )
      .run(primary.conversationId)
    const runId = Number(analysisRun.lastInsertRowid)

    const window = db
      .prepare(
        `
        INSERT INTO windows (
          run_id,
          conversation_id,
          ordinal,
          start_ordinal,
          end_ordinal,
          context_start_ordinal,
          context_end_ordinal,
          focal_start_ordinal,
          focal_end_ordinal,
          start_message_id,
          end_message_id,
          message_count,
          context_message_count,
          focal_message_count,
          window_metadata_json,
          result_json,
          shift_json,
          status,
          latency_ms
        )
        VALUES (
          ?, ?, 1, 1, 6, 1, 3, 4, 6, ?, ?, 6, 3, 3,
          '{"mode":"comparative-message-count"}', '{"dominant":"trust"}',
          '{"delta":0.2}', 'complete', 12
        )
      `,
      )
      .run(runId, primary.conversationId, primary.messageIds[0], primary.messageIds[5])
    const windowId = Number(window.lastInsertRowid)

    assertConversationReadApi(db, primary.conversationId)

    const runs = listRuns(db, primary.conversationId)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].conversationId, primary.conversationId)
    assert.equal(runs[0].methodKey, 'baseline-v1')
    assert.equal(runs[0].summary.windowCount, 1)

    const windows = getRunWindows(db, runId)
    assert.equal(windows.length, 1)
    assert.equal(windows[0].runId, runId)
    assert.equal(windows[0].contextStartOrdinal, 1)
    assert.equal(windows[0].focalStartOrdinal, 4)
    assert.equal(windows[0].result.dominant, 'trust')

    const full = getWindowMessages(db, windowId, 'full')
    assert.deepEqual(
      full.map((message) => message.conversationOrdinal),
      [1, 2, 3, 4, 5, 6],
    )
    assert.ok(full.every((message) => message.conversationId === primary.conversationId))

    const context = getWindowMessages(db, windowId, 'context')
    assert.deepEqual(
      context.map((message) => message.conversationOrdinal),
      [1, 2, 3],
    )

    const focal = getWindowMessages(db, windowId, 'focal')
    assert.deepEqual(
      focal.map((message) => message.conversationOrdinal),
      [4, 5, 6],
    )
  })
}

smokeRunOwnedSchema()

console.log('backend read API smoke passed')
