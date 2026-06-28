import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { answerConversation } from '../src/lib/chat/answer.ts'
import { retrieveConversationContext } from '../src/lib/chat/retrieve.ts'
import { migrate } from '../src/lib/db/schema.ts'
import {
  createAnalysisRunForWindows,
  ensureWindowsForConversation,
  upsertScorerConfig,
  upsertWindowConfig,
} from '../src/lib/windows/windows.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = mkdtempSync(path.join(tmpdir(), 'imessage-emotion-chat-'))
const dbPath = path.join(dir, 'smoke.sqlite')
const db = new Database(dbPath)

try {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      source_chat_id INTEGER NOT NULL UNIQUE,
      chat_identifier TEXT NOT NULL,
      display_name TEXT,
      is_group INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_message_at INTEGER,
      last_message_at INTEGER
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      conversation_ordinal INTEGER NOT NULL,
      source_rowid INTEGER NOT NULL,
      guid TEXT NOT NULL UNIQUE,
      text TEXT,
      sent_at INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL,
      is_read INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (conversation_id, conversation_ordinal)
    );

    CREATE TABLE analysis_runs (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      method_key TEXT NOT NULL,
      status TEXT NOT NULL,
      window_config_json TEXT NOT NULL,
      context_config_json TEXT NOT NULL,
      scorer_config_json TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );

    CREATE TABLE windows (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      context_start_ordinal INTEGER,
      context_end_ordinal INTEGER,
      focal_start_ordinal INTEGER NOT NULL,
      focal_end_ordinal INTEGER NOT NULL,
      start_message_id INTEGER NOT NULL,
      end_message_id INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      context_message_count INTEGER NOT NULL DEFAULT 0,
      focal_message_count INTEGER NOT NULL,
      window_metadata_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      shift_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (run_id, ordinal)
    );
  `)

  db.prepare(
    `
    INSERT INTO conversations (
      id, source_chat_id, chat_identifier, display_name, is_group, message_count,
      first_message_at, last_message_at
    )
    VALUES
      (1, 101, 'chat-selected', 'Selected Conversation', 0, 12, 1000, 12000),
      (2, 202, 'chat-other', 'Other Conversation', 0, 2, 1000, 2000)
  `,
  ).run()

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, conversation_id, conversation_ordinal, source_rowid, guid, text, sent_at,
      is_from_me, is_read, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'delivered')
  `)
  for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
    insertMessage.run(
      ordinal,
      1,
      ordinal,
      ordinal,
      `selected-${ordinal}`,
      `selected conversation message ${ordinal}`,
      ordinal * 1000,
      ordinal % 2,
    )
  }
  insertMessage.run(201, 2, 1, 1, 'other-1', 'wrong conversation private text', 1000, 0)
  insertMessage.run(202, 2, 2, 2, 'other-2', 'wrong conversation private text', 2000, 1)

  db.prepare(
    `
    INSERT INTO analysis_runs (
      id, conversation_id, method_key, status, window_config_json, context_config_json,
      scorer_config_json, summary_json, started_at, completed_at
    )
    VALUES (
      1,
      1,
      'baseline-v1',
      'completed',
      '{"mode":"comparative-message-count","contextMessages":4,"focalMessages":4}',
      '{"split":"context-vs-focal"}',
      '{"method":"baseline-v1"}',
      '{"summary":"synthetic run summary"}',
      1000,
      2000
    )
  `,
  ).run()

  const insertWindow = db.prepare(`
    INSERT INTO windows (
      id, run_id, conversation_id, ordinal, start_ordinal, end_ordinal,
      context_start_ordinal, context_end_ordinal, focal_start_ordinal, focal_end_ordinal,
      start_message_id, end_message_id, message_count, context_message_count,
      focal_message_count, window_metadata_json, result_json, shift_json, status
    )
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
  `)
  insertWindow.run(
    10,
    1,
    1,
    1,
    4,
    null,
    null,
    1,
    4,
    1,
    4,
    4,
    0,
    4,
    '{"label":"previous window"}',
    '{"summary":"previous result","dominant":"warmth","method":"baseline-v1"}',
    '{}',
  )
  insertWindow.run(
    11,
    1,
    2,
    1,
    8,
    1,
    4,
    5,
    8,
    1,
    8,
    8,
    4,
    4,
    '{"label":"selected window"}',
    '{"summary":"selected result","dominant":"friction","method":"baseline-v1"}',
    '{"summary":"stress increased"}',
  )
  insertWindow.run(
    12,
    1,
    3,
    5,
    12,
    5,
    8,
    9,
    12,
    5,
    12,
    8,
    4,
    4,
    '{"label":"next window"}',
    '{"summary":"next result","dominant":"repair","method":"baseline-v1"}',
    '{}',
  )

  const input = {
    conversationId: 1,
    runId: 1,
    windowId: 11,
    question: 'What changed in the selected window?',
  }
  const packet = retrieveConversationContext(db, input)
  const response = answerConversation(db, input)

  assert.match(response.answer, /conversation #1/)
  assert.doesNotMatch(response.answer, /wrong conversation private text/)
  assert.equal('packet' in response, false)
  assert.equal(packet.conversation.id, 1)
  assert.equal(packet.selectedWindow.id, 11)
  assert.deepEqual(
    packet.contextMessages.map((message) => message.ordinal),
    [1, 2, 3, 4],
  )
  assert.deepEqual(
    packet.focalMessages.map((message) => message.ordinal),
    [5, 6, 7, 8],
  )
  assert.equal(packet.contextMessages.every((message) => message.role === 'context'), true)
  assert.equal(packet.focalMessages.every((message) => message.role === 'focal'), true)
  assert.deepEqual(
    packet.neighboringWindows.map((window) => window.id),
    [10, 12],
  )
  assert.equal(
    response.citations.some((citation) => citation.type === 'window' && citation.id === 11),
    true,
  )
  assert.equal(
    response.citations.some((citation) => citation.type === 'message' && citation.id === 1),
    true,
  )
  assert.equal(
    response.citations.some((citation) => citation.type === 'message' && citation.id === 8),
    true,
  )
  assert.equal(response.answer.includes('Context/old messages'), true)
  assert.equal(response.answer.includes('Focal/new messages'), true)
  assert.equal(packet.run.summary.summary, 'synthetic run summary')
  assert.equal(packet.selectedWindow.result.summary, 'selected result')
  assert.equal(packet.selectedWindow.shift.summary, 'stress increased')
  assert.throws(
    () =>
      answerConversation(db, {
        conversationId: 1,
        runId: 1,
        question: 'Missing selected window?',
      }),
    /windowId must be a positive integer/,
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat%'").get()
      .count,
    0,
  )

  assertLegacySchemaPath()
  assertRebasedContract()
  console.log('smoke-chat-retrieval passed')
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

function assertLegacySchemaPath() {
  const db = new Database(':memory:')
  migrate(db)
  try {
    const conversationId = seedLegacyConversation(db, 120, 'selected')
    seedLegacyConversation(db, 12, 'other')
    const windowConfigId = upsertWindowConfig(db, {
      name: 'legacy-smoke-40-by-40',
      messageCount: 40,
      stride: 40,
      minTailMessages: 40,
    })
    const windowIds = ensureWindowsForConversation(db, conversationId, windowConfigId)
    assert.equal(windowIds.length >= 3, true)

    const scorerConfigId = upsertScorerConfig(db, 'legacy-smoke', 'Legacy smoke')
    const runId = createAnalysisRunForWindows(db, scorerConfigId, windowIds)
    db.prepare(
      `
      INSERT INTO window_results (run_id, window_id, scorer_config_id, result_json)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      runId,
      windowIds[1],
      scorerConfigId,
      '{"summary":"legacy selected result","dominant":"baseline","method":"legacy-smoke"}',
    )

    const packet = retrieveConversationContext(db, {
      conversationId,
      runId,
      windowId: windowIds[1],
      question: 'Legacy schema selected window?',
    })
    const response = answerConversation(db, {
      conversationId,
      runId,
      windowId: windowIds[1],
      question: 'Legacy schema selected window?',
    })

    assert.equal(packet.selectedWindow.id, windowIds[1])
    assert.equal(packet.contextMessages.length, 0)
    assert.equal(packet.focalMessages.length, 40)
    assert.deepEqual(
      packet.neighboringWindows.map((window) => window.id),
      [windowIds[0], windowIds[2]],
    )
    assert.equal(response.citations.some((citation) => citation.type === 'window'), true)
    assert.equal(response.citations.some((citation) => citation.type === 'message'), true)
    assert.equal(response.answer.includes('legacy selected result'), true)
  } finally {
    db.close()
  }
}

function seedLegacyConversation(db, messageCount, label) {
  const conversation = db
    .prepare(
      `
      INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group, message_count)
      VALUES (?, ?, NULL, 0, ?)
    `,
    )
    .run(label === 'selected' ? 1 : 2, `chat-${label}`, messageCount)
  const conversationId = Number(conversation.lastInsertRowid)
  const insert = db.prepare(
    `
    INSERT INTO messages (
      conversation_id, conversation_ordinal, source_rowid, guid, text, sent_at,
      is_from_me, is_read, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'delivered')
  `,
  )
  for (let ordinal = 1; ordinal <= messageCount; ordinal += 1) {
    insert.run(
      conversationId,
      ordinal,
      ordinal,
      `${label}-legacy-${ordinal}`,
      `${label} legacy message ${ordinal}`,
      ordinal * 1000,
      ordinal % 2,
    )
  }
  return conversationId
}

function assertRebasedContract() {
  const apiTypes = read('src/lib/api/types.ts')
  const main = read('electron/main.ts')
  const preload = read('electron/preload.ts')
  const env = read('electron/electron-env.d.ts')

  assert.match(apiTypes, /runId:\s*number/, 'askConversation must require runId')
  assert.match(apiTypes, /windowId:\s*number/, 'askConversation must require windowId')
  assert.match(
    apiTypes,
    /askConversation\(input:\s*AskConversationInput\):\s*Promise<ConversationChatResponse>/,
    'typed API must return the rich chat response',
  )
  assert.match(
    main,
    /ipcMain\.handle\(\s*API_CHANNELS\.askConversation[\s\S]*answerConversation\(db,/,
    'main must route the typed askConversation channel to the real answer path',
  )
  assert.match(
    preload,
    /contextBridge\.exposeInMainWorld\('ipcRenderer', appApi\)/,
    'preload must keep the Lane 0 window.ipcRenderer bridge name',
  )
  assert.doesNotMatch(preload, /exposeInMainWorld\('imessageEmotion'/)
  assert.match(env, /ipcRenderer:\s*import\('\.\.\/src\/lib\/api\/types'\)\.ImessageEmotionApi/)
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}
