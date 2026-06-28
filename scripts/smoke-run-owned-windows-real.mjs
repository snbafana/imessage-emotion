import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tempDir = await mkdtemp(path.join(repoRoot, '.smoke-run-owned-windows-real-'))
const chatDbPath = process.env.IMESSAGE_CHAT_DB_PATH ?? path.join(homedir(), 'Library', 'Messages', 'chat.db')

try {
  const entryPath = path.join(tempDir, 'entry.ts')
  const bundlePath = path.join(tempDir, 'entry.mjs')
  const appDbPath = path.join(tempDir, 'real-smoke.sqlite')

  await writeFile(
    entryPath,
    `
      import assert from 'node:assert/strict'
      import Database from 'better-sqlite3'
      import { openAppDatabase } from ${JSON.stringify(path.join(repoRoot, 'src/lib/db/schema.ts'))}
      import { createBaselineRun } from ${JSON.stringify(
        path.join(repoRoot, 'src/lib/emotion/run-baseline.ts'),
      )}

      const APPLE_EPOCH_OFFSET_MS = 978_307_200_000
      const MIN_MESSAGES = 150
      const MAX_CONVERSATIONS = 3
      const MAX_MESSAGES_PER_CONVERSATION = 225

      function statusFor(row) {
        if (row.error !== 0) return 'failed'
        if (row.is_read === 1) return 'read'
        if (row.is_from_me === 1) return 'sent'
        return 'delivered'
      }

      function percentile(values, p) {
        if (values.length === 0) return 0
        const sorted = [...values].sort((left, right) => left - right)
        return sorted[Math.floor((sorted.length - 1) * p)]
      }

      function round(value) {
        return Math.round(value * 1000) / 1000
      }

      function selectRealConversations(messagesDb) {
        return messagesDb.prepare(
          \`
          WITH text_messages AS (
            SELECT
              cmj.chat_id,
              m.ROWID AS message_id
            FROM message m
            INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            WHERE m.item_type IN (0, 1, 2)
              AND COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3007
              AND m.text IS NOT NULL
              AND LENGTH(TRIM(m.text)) > 0
          ),
          participant_counts AS (
            SELECT chat_id, COUNT(*) AS participant_count
            FROM chat_handle_join
            GROUP BY chat_id
          )
          SELECT
            tm.chat_id,
            COUNT(*) AS text_message_count,
            COALESCE(pc.participant_count, 0) > 1 AS is_group
          FROM text_messages tm
          LEFT JOIN participant_counts pc ON pc.chat_id = tm.chat_id
          GROUP BY tm.chat_id
          HAVING text_message_count >= ?
          ORDER BY text_message_count DESC, tm.chat_id DESC
          LIMIT ?
        \`,
        ).all(MIN_MESSAGES, MAX_CONVERSATIONS)
      }

      function readConversationMessages(messagesDb, chatId) {
        return messagesDb.prepare(
          \`
          SELECT *
          FROM (
            SELECT
              m.ROWID AS rowid,
              m.text,
              CAST(m.date / 1000000 AS INTEGER) + ? AS sent_at_ms,
              m.is_from_me,
              m.is_read,
              COALESCE(m.error, 0) AS error,
              COALESCE(m.cache_has_attachments, 0) AS cache_has_attachments
            FROM message m
            INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            WHERE cmj.chat_id = ?
              AND m.item_type IN (0, 1, 2)
              AND COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3007
              AND m.text IS NOT NULL
              AND LENGTH(TRIM(m.text)) > 0
            ORDER BY m.date DESC, m.ROWID DESC
            LIMIT ?
          )
          ORDER BY sent_at_ms ASC, rowid ASC
        \`,
        ).all(APPLE_EPOCH_OFFSET_MS, chatId, MAX_MESSAGES_PER_CONVERSATION)
      }

      function seedConversation(appDb, sourceChatId, redactedIndex, isGroup, rows) {
        const conversation = appDb.prepare(
          \`
          INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group)
          VALUES (?, ?, NULL, ?)
        \`,
        ).run(sourceChatId, 'real-conversation-' + redactedIndex, isGroup ? 1 : 0)
        const conversationId = Number(conversation.lastInsertRowid)
        const insert = appDb.prepare(
          \`
          INSERT INTO messages (
            conversation_id,
            conversation_ordinal,
            source_rowid,
            guid,
            text,
            sent_at,
            is_from_me,
            is_read,
            status,
            has_attachments
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        \`,
        )

        for (const [index, row] of rows.entries()) {
          insert.run(
            conversationId,
            index + 1,
            row.rowid,
            'real-redacted-' + redactedIndex + '-' + row.rowid,
            row.text,
            row.sent_at_ms,
            row.is_from_me,
            row.is_read,
            statusFor(row),
            row.cache_has_attachments,
          )
        }

        appDb.prepare(
          \`
          UPDATE conversations
          SET message_count = ?,
            first_message_at = ?,
            last_message_at = ?
          WHERE id = ?
        \`,
        ).run(rows.length, rows[0]?.sent_at_ms ?? null, rows.at(-1)?.sent_at_ms ?? null, conversationId)

        return conversationId
      }

      function assertRun(appDb, runId) {
        const run = appDb.prepare(
          \`
          SELECT id, summary_json
          FROM analysis_runs
          WHERE id = ?
        \`,
        ).get(runId)
        assert.ok(run, 'analysis run must exist')
        const summary = JSON.parse(run.summary_json)
        assert.ok(summary.windowCount > 0, 'summary must record windows')

        const windows = appDb.prepare(
          \`
          SELECT
            ordinal,
            start_ordinal,
            end_ordinal,
            context_start_ordinal,
            context_end_ordinal,
            focal_start_ordinal,
            focal_end_ordinal,
            context_message_count,
            focal_message_count,
            result_json,
            latency_ms
          FROM windows
          WHERE run_id = ?
          ORDER BY ordinal
        \`,
        ).all(runId)
        assert.equal(windows.length, summary.windowCount)

        for (const window of windows) {
          assert.ok(window.start_ordinal <= window.end_ordinal)
          assert.ok(window.context_start_ordinal <= window.context_end_ordinal)
          assert.equal(window.context_end_ordinal + 1, window.focal_start_ordinal)
          assert.ok(window.focal_start_ordinal <= window.focal_end_ordinal)
          assert.equal(window.context_message_count, 100)
          assert.ok(window.focal_message_count >= 25)
          const result = JSON.parse(window.result_json)
          assert.equal(result.method, 'baseline-v1')
          assert.equal(typeof result.scores.warmth, 'number')
          assert.equal(typeof result.scores.joy, 'number')
          assert.equal(typeof result.scores.stress, 'number')
          assert.equal(typeof result.scores.friction, 'number')
          assert.equal(typeof result.scores.sadness, 'number')
        }

        return windows
      }

      export function runRealSmoke(chatDbPath, appDbPath) {
        const startedAt = Date.now()
        const messagesDb = new Database(chatDbPath, { readonly: true, fileMustExist: true })
        const appDb = openAppDatabase(appDbPath)
        const candidates = selectRealConversations(messagesDb)
        assert.ok(
          candidates.length > 0,
          'No local Messages conversations with enough text messages were found',
        )

        const summaries = []
        const allLatencies = []
        for (const [index, candidate] of candidates.entries()) {
          const rows = readConversationMessages(messagesDb, candidate.chat_id)
          assert.ok(rows.length >= MIN_MESSAGES)
          const conversationId = seedConversation(
            appDb,
            candidate.chat_id,
            index + 1,
            candidate.is_group,
            rows,
          )
          const firstRun = createBaselineRun(appDb, conversationId, {
            mode: 'comparative-message-count',
            contextMessages: 100,
            focalMessages: 50,
            stride: 50,
            minFocalMessages: 25,
          })
          const secondRun = createBaselineRun(appDb, conversationId, {
            mode: 'comparative-message-count',
            contextMessages: 100,
            focalMessages: 50,
            stride: 50,
            minFocalMessages: 25,
          })

          const firstWindows = assertRun(appDb, firstRun.runId)
          const secondWindows = assertRun(appDb, secondRun.runId)
          assert.deepEqual(
            firstWindows.map((window) => [
              window.start_ordinal,
              window.end_ordinal,
              window.focal_start_ordinal,
              window.focal_end_ordinal,
            ]),
            secondWindows.map((window) => [
              window.start_ordinal,
              window.end_ordinal,
              window.focal_start_ordinal,
              window.focal_end_ordinal,
            ]),
          )

          const resultRows = appDb.prepare(
            \`
            SELECT result_json, latency_ms
            FROM windows
            WHERE run_id IN (?, ?)
          \`,
          ).all(firstRun.runId, secondRun.runId)
          const dominantCounts = {}
          for (const row of resultRows) {
            const result = JSON.parse(row.result_json)
            dominantCounts[result.dominant] = (dominantCounts[result.dominant] ?? 0) + 1
            allLatencies.push(row.latency_ms ?? 0)
          }

          summaries.push({
            label: 'conversation-' + (index + 1),
            importedMessages: rows.length,
            runIds: [firstRun.runId, secondRun.runId],
            windowsPerRun: firstWindows.length,
            dominantCounts,
          })
        }

        assert.equal(
          appDb.prepare(
            \`
            SELECT COUNT(*) AS count
            FROM sqlite_master
            WHERE type = 'table' AND name = 'window_results'
          \`,
          ).get().count,
          0,
        )

        messagesDb.close()
        appDb.close()

        const totalMs = Date.now() - startedAt
        return {
          source: 'local-messages-chat-db',
          conversations: summaries,
          totals: {
            conversationCount: summaries.length,
            runCount: summaries.length * 2,
            windowCount: summaries.reduce(
              (sum, summary) => sum + summary.windowsPerRun * 2,
              0,
            ),
            totalMs,
            meanWindowLatencyMs: round(
              allLatencies.reduce((sum, value) => sum + value, 0) / Math.max(allLatencies.length, 1),
            ),
            medianWindowLatencyMs: percentile(allLatencies, 0.5),
          },
        }
      }
    `,
  )

  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['better-sqlite3'],
    logLevel: 'silent',
  })

  const { runRealSmoke } = await import(pathToFileURL(bundlePath).href)
  const result = runRealSmoke(chatDbPath, appDbPath)
  console.log(JSON.stringify(result, null, 2))
  console.log('real run-owned windows smoke passed')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
