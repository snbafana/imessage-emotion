import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import ts from 'typescript'

const root = process.cwd()
const tempDir = path.join(root, '.smoke-dashboard-real')
const appDbCandidates = [
  process.env.IMESSAGE_EMOTION_DB_PATH,
  path.join(homedir(), 'Library/Application Support/imessage-emotion/imessage-emotion.sqlite'),
  path.join(homedir(), 'Library/Application Support/iMessage Emotion/imessage-emotion.sqlite'),
  path.join(homedir(), 'Library/Application Support/Electron/imessage-emotion.sqlite'),
].filter(Boolean)

const started = Date.now()
const dashboard = await importDashboardData()
const source = findAppDb()

if (source.skipped) {
  printResult(source)
  process.exit(0)
}

const db = new Database(source.dbPath, { readonly: true })
try {
  const api = realDbApi(db)
  globalThis.window = { ipcRenderer: api }

  const exposedApi = dashboard.getDashboardApi()
  assert(exposedApi === api, 'dashboard reads typed window.ipcRenderer app API')

  const conversations = dashboard.normalizeConversations(await api.listConversations())
  if (conversations.length === 0) {
    printSkip(
      'App DB has no imported conversations.',
      'Run app sync/import first, then rerun npm run smoke:dashboard:real.',
      { appDbFound: true, conversationCount: 0 },
    )
  }
  assert(
    conversations.every((conversation) => conversation.title.startsWith('Conversation ')),
    'real smoke uses redacted conversation labels',
  )

  const selectedConversation = conversations.find((conversation) => conversation.latestRun)
  if (!selectedConversation) {
    printSkip(
      'App DB has imported conversations but no analysis runs.',
      'Run Create Baseline Run after Lane 2 is available, then rerun npm run smoke:dashboard:real.',
      {
        appDbFound: true,
        conversationCount: conversations.length,
        importedMessageCount: totalMessageCount(db),
      },
    )
  }

  const runs = dashboard.normalizeRuns(await api.listRuns(Number(selectedConversation.rawId)))
  const run = dashboard.latestRun(runs)
  if (!run) {
    printSkip(
      'Selected real conversation has no latest run.',
      'Run Create Baseline Run after Lane 2 is available, then rerun npm run smoke:dashboard:real.',
      {
        appDbFound: true,
        conversationCount: conversations.length,
        selectedConversationId: Number(selectedConversation.rawId),
      },
    )
  }

  const windows = dashboard.normalizeWindows(await api.getRunWindows(Number(run.rawId)))
  if (windows.length === 0) {
    printSkip(
      'Latest real analysis run has no persisted run-owned windows.',
      'Run or repair baseline window generation after Lane 2 is available, then rerun npm run smoke:dashboard:real.',
      {
        appDbFound: true,
        conversationCount: conversations.length,
        selectedConversationId: Number(selectedConversation.rawId),
        runId: Number(run.rawId),
        runState: run.state,
      },
    )
  }

  const selectedWindow = windows[0]
  const contextMessages = await dashboard.getWindowMessages(api, selectedWindow.rawId, 'context')
  const focalMessages = await dashboard.getWindowMessages(api, selectedWindow.rawId, 'focal')
  assert(contextMessages.length > 0, 'real inspector has context messages')
  assert(focalMessages.length > 0, 'real inspector has focal messages')
  assert(
    [...contextMessages, ...focalMessages].every((message) => message.text === '[redacted message]'),
    'real smoke redacts private message text before rendering',
  )

  const html = dashboard.renderDashboardSmokeHtml({
    conversations,
    run,
    windows,
    selectedWindow,
    contextMessages,
    focalMessages,
  })
  assert(html.includes(selectedConversation.title), 'rendered sidebar includes real API conversation')
  assert(html.includes(dashboard.runStateLabel(run, windows)), 'timeline renders real run state')
  assert(html.includes(selectedWindow.label), 'timeline renders real window artifact')
  assert(html.includes('Old context'), 'inspector labels old context section')
  assert(html.includes('New focal'), 'inspector labels new focal section')
  assert(!html.includes('Maya Chen'), 'old PEOPLE mock data is not the normal path')
  assert(!looksLikePrivateContact(html), 'rendered smoke artifact contains no obvious contact handles')

  const noRunHtml = dashboard.renderDashboardSmokeHtml({
    conversations,
    run: null,
    windows: [],
    selectedWindow: null,
    contextMessages: [],
    focalMessages: [],
  })
  assert(noRunHtml.includes('No baseline run yet'), 'empty/no-run state is visible')

  printResult({
    status: 'passed',
    mode: 'app-db-only',
    db: 'existing app DB',
    importedFromChatDb: false,
    conversationCount: conversations.length,
    selectedConversationId: Number(selectedConversation.rawId),
    selectedConversationMessageCount: selectedConversation.messageCount,
    runId: Number(run.rawId),
    runState: run.state,
    windowId: Number(selectedWindow.rawId),
    windowState: selectedWindow.state,
    contextMessageCount: contextMessages.length,
    focalMessageCount: focalMessages.length,
    noRunStateVisible: true,
    screenshots: 'none',
    timingsMs: {
      total: Date.now() - started,
      dbPrepare: source.preparedAt - started,
      validate: Date.now() - source.preparedAt,
    },
  })
} finally {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
}

async function importDashboardData() {
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(tempDir, { recursive: true })

  const sourcePath = path.join(root, 'src/dashboard/data.ts')
  const modulePath = path.join(tempDir, 'data.mjs')
  const source = await readFile(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  await writeFile(modulePath, compiled)
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`)
}

function findAppDb() {
  for (const dbPath of appDbCandidates) {
    if (!existsSync(dbPath)) continue
    const summary = inspectAppDb(dbPath)
    if (summary.tableReady) {
      return {
        skipped: false,
        dbPath,
        preparedAt: Date.now(),
        ...summary,
      }
    }
  }

  return {
    skipped: true,
    status: 'skipped',
    mode: 'app-db-only',
    reason: 'No app-owned imported DB was found.',
    setup: 'Run the app sync/import first so the app DB exists, then rerun npm run smoke:dashboard:real.',
    importedFromChatDb: false,
    screenshots: 'none',
    timingsMs: { total: Date.now() - started },
  }
}

function inspectAppDb(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = tableNames(db)
    if (!tables.has('conversations') || !tables.has('messages')) return { tableReady: false }
    return {
      tableReady: true,
      conversationCount: db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count,
      importedMessageCount: db.prepare('SELECT COUNT(*) AS count FROM messages').get().count,
    }
  } finally {
    db.close()
  }
}

function realDbApi(db) {
  return {
    async listConversations() {
      return db
        .prepare(
          `
          SELECT id, message_count, first_message_at, last_message_at
          FROM conversations
          WHERE message_count > 0
          ORDER BY last_message_at DESC, id DESC
          LIMIT 8
        `,
        )
        .all()
        .map((row) => ({
          id: row.id,
          title: `Conversation ${row.id}`,
          participantSummary: 'redacted participants',
          messageCount: row.message_count,
          firstMessageAt: row.first_message_at,
          lastMessageAt: row.last_message_at,
          latestRun: latestRunForConversation(db, row.id),
        }))
    },
    async listRuns(conversationId) {
      return listRunsForConversation(db, conversationId)
    },
    async getRunWindows(runId) {
      return windowsForRun(db, runId)
    },
    async getWindowMessages(windowId, slice) {
      const bounds = windowBounds(db, windowId)
      assert(bounds, `Missing window ${windowId}`)
      const start = slice === 'context' ? bounds.contextStartOrdinal : bounds.focalStartOrdinal
      const end = slice === 'context' ? bounds.contextEndOrdinal : bounds.focalEndOrdinal
      assert(start != null && end != null, `Missing ${slice} bounds for window ${windowId}`)
      return db
        .prepare(
          `
          SELECT id, conversation_ordinal, sent_at, is_from_me
          FROM messages
          WHERE conversation_id = ?
            AND conversation_ordinal BETWEEN ? AND ?
          ORDER BY conversation_ordinal
        `,
        )
        .all(bounds.conversationId, start, end)
        .map((row) => ({
          id: row.id,
          conversationId: bounds.conversationId,
          conversationOrdinal: row.conversation_ordinal,
          senderContactId: null,
          senderName: row.is_from_me === 1 ? 'You' : 'Contact',
          text: '[redacted message]',
          sentAt: row.sent_at,
          isFromMe: row.is_from_me === 1,
          isRead: true,
          hasAttachments: false,
        }))
    },
  }
}

function latestRunForConversation(db, conversationId) {
  return listRunsForConversation(db, conversationId)[0] ?? null
}

function listRunsForConversation(db, conversationId) {
  const tables = tableNames(db)
  if (!tables.has('analysis_runs')) return []
  const columns = columnNames(db, 'analysis_runs')

  if (columns.has('conversation_id')) {
    return db
      .prepare(
        `
        SELECT id, conversation_id, method_key, status, started_at, completed_at, summary_json, error
        FROM analysis_runs
        WHERE conversation_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 5
      `,
      )
      .all(conversationId)
      .map((row) => runRow(db, row))
  }

  if (!tables.has('run_windows') || !tables.has('windows')) return []
  return db
    .prepare(
      `
      SELECT DISTINCT ar.id, w.conversation_id, sc.key AS method_key, ar.status, ar.started_at,
        ar.completed_at, ar.notes AS summary_json, NULL AS error
      FROM analysis_runs ar
      JOIN scorer_configs sc ON sc.id = ar.scorer_config_id
      JOIN run_windows rw ON rw.run_id = ar.id
      JOIN windows w ON w.id = rw.window_id
      WHERE w.conversation_id = ?
      ORDER BY ar.started_at DESC, ar.id DESC
      LIMIT 5
    `,
    )
    .all(conversationId)
    .map((row) => runRow(db, row))
}

function runRow(db, row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    methodKey: row.method_key ?? 'baseline-v1',
    status: row.status,
    windowCount: countRunWindows(db, row.id),
    scoredWindowCount: countScoredRunWindows(db, row.id),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: safeJson(row.summary_json),
    error: row.error ?? undefined,
  }
}

function windowsForRun(db, runId) {
  const tables = tableNames(db)
  if (!tables.has('windows')) return []
  const columns = columnNames(db, 'windows')
  if (columns.has('run_id')) {
    return db.prepare('SELECT * FROM windows WHERE run_id = ? ORDER BY ordinal').all(runId).map(windowRow)
  }
  if (!tables.has('run_windows')) return []
  return db
    .prepare(
      `
      SELECT w.*, rw.run_id, rw.status AS run_window_status, wr.result_json
      FROM run_windows rw
      JOIN windows w ON w.id = rw.window_id
      LEFT JOIN window_results wr ON wr.run_id = rw.run_id AND wr.window_id = rw.window_id
      WHERE rw.run_id = ?
      ORDER BY w.start_ordinal
    `,
    )
    .all(runId)
    .map(windowRow)
}

function windowBounds(db, windowId) {
  const row = db.prepare('SELECT * FROM windows WHERE id = ?').get(windowId)
  return row ? windowRow(row) : null
}

function windowRow(row) {
  const contextStart = row.context_start_ordinal ?? row.start_ordinal
  const contextEnd = row.context_end_ordinal ?? Math.floor((row.start_ordinal + row.end_ordinal) / 2)
  const focalStart = row.focal_start_ordinal ?? contextEnd + 1
  const focalEnd = row.focal_end_ordinal ?? row.end_ordinal
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    ordinal: row.ordinal ?? row.id,
    status: row.status ?? row.run_window_status ?? 'pending',
    startOrdinal: row.start_ordinal,
    endOrdinal: row.end_ordinal,
    contextStartOrdinal: contextStart,
    contextEndOrdinal: contextEnd,
    focalStartOrdinal: focalStart,
    focalEndOrdinal: focalEnd,
    messageCount: row.message_count,
    contextMessageCount: Math.max(0, contextEnd - contextStart + 1),
    focalMessageCount: Math.max(0, focalEnd - focalStart + 1),
    result: safeJson(row.result_json),
    shift: safeJson(row.shift_json),
    latencyMs: row.latency_ms ?? null,
    error: row.error ?? undefined,
  }
}

function countRunWindows(db, runId) {
  const tables = tableNames(db)
  if (tables.has('windows') && columnNames(db, 'windows').has('run_id')) {
    return db.prepare('SELECT COUNT(*) AS count FROM windows WHERE run_id = ?').get(runId).count
  }
  if (tables.has('run_windows')) {
    return db.prepare('SELECT COUNT(*) AS count FROM run_windows WHERE run_id = ?').get(runId).count
  }
  return 0
}

function countScoredRunWindows(db, runId) {
  const tables = tableNames(db)
  if (tables.has('windows') && columnNames(db, 'windows').has('run_id')) {
    return db
      .prepare("SELECT COUNT(*) AS count FROM windows WHERE run_id = ? AND status IN ('completed', 'scored')")
      .get(runId).count
  }
  if (tables.has('run_windows')) {
    return db
      .prepare("SELECT COUNT(*) AS count FROM run_windows WHERE run_id = ? AND status IN ('completed', 'scored')")
      .get(runId).count
  }
  return 0
}

function totalMessageCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM messages').get().count
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

function safeJson(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function looksLikePrivateContact(value) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) || /\+?\d[\d\s().-]{7,}\d/.test(value)
}

function printSkip(reason, setup, extra = {}) {
  printResult({
    status: 'skipped',
    mode: 'app-db-only',
    reason,
    setup,
    importedFromChatDb: false,
    screenshots: 'none',
    timingsMs: { total: Date.now() - started },
    ...extra,
  })
  process.exit(0)
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2))
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Real dashboard smoke assertion failed: ${message}`)
  }
}
