import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tempDir = await mkdtemp(path.join(tmpdir(), 'imessage-emotion-real-smoke-'))
const appDbPath =
  process.env.IMESSAGE_EMOTION_DB_PATH ??
  path.join(homedir(), 'Library', 'Application Support', 'imessage-emotion', 'imessage-emotion.sqlite')

if (!existsSync(appDbPath)) {
  console.error(
    'App DB not found. Run the app sync/import first, or set IMESSAGE_EMOTION_DB_PATH to the app-owned imported SQLite DB.',
  )
  process.exit(2)
}

try {
  const entryPath = path.join(tempDir, 'entry.ts')
  const bundlePath = path.join(tempDir, 'entry.mjs')
  const appDbCopyPath = path.join(tempDir, 'app-db-copy.sqlite')
  await copyFile(appDbPath, appDbCopyPath)
  await symlink(path.join(repoRoot, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')

  await writeFile(
    entryPath,
    `
      import assert from 'node:assert/strict'
      import { openAppDatabase } from ${JSON.stringify(path.join(repoRoot, 'src/lib/db/schema.ts'))}
      import { createBaselineRun } from ${JSON.stringify(
        path.join(repoRoot, 'src/lib/emotion/run-baseline.ts'),
      )}

      const MIN_MESSAGES = 150
      const MAX_CONVERSATIONS = 3
      const MAX_MESSAGES_PER_CONVERSATION = 225

      function percentile(values, p) {
        if (values.length === 0) return 0
        const sorted = [...values].sort((left, right) => left - right)
        return sorted[Math.floor((sorted.length - 1) * p)]
      }

      function round(value) {
        return Math.round(value * 1000) / 1000
      }

      function setupMessage() {
        return 'App DB has no imported conversations with enough messages. Run the app sync/import first, then rerun npm run smoke:run-owned-windows:real.'
      }

      function selectImportedConversations(db) {
        return db.prepare(
          \`
          SELECT
            id,
            message_count
          FROM conversations
          WHERE message_count >= ?
            AND EXISTS (
              SELECT 1
              FROM messages
              WHERE messages.conversation_id = conversations.id
                AND messages.text IS NOT NULL
                AND LENGTH(TRIM(messages.text)) > 0
            )
          ORDER BY message_count DESC, id DESC
          LIMIT ?
        \`,
        ).all(MIN_MESSAGES, MAX_CONVERSATIONS)
      }

      function countBoundedTextMessages(db, conversationId) {
        const row = db.prepare(
          \`
          SELECT COUNT(*) AS count
          FROM (
            SELECT id
            FROM messages
            WHERE conversation_id = ?
              AND text IS NOT NULL
              AND LENGTH(TRIM(text)) > 0
            ORDER BY conversation_ordinal DESC
            LIMIT ?
          )
        \`,
        ).get(conversationId, MAX_MESSAGES_PER_CONVERSATION)
        return row.count
      }

      function assertRun(db, runId) {
        const run = db.prepare(
          \`
          SELECT id, summary_json
          FROM analysis_runs
          WHERE id = ?
        \`,
        ).get(runId)
        assert.ok(run, 'analysis run must exist')
        const summary = JSON.parse(run.summary_json)
        assert.ok(summary.windowCount > 0, 'summary must record windows')

        const windows = db.prepare(
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

      export function runRealSmoke(appDbPath) {
        const startedAt = Date.now()
        const db = openAppDatabase(appDbPath)

        try {
          const candidates = selectImportedConversations(db)
          assert.ok(candidates.length > 0, setupMessage())

          const summaries = []
          const allLatencies = []
          for (const [index, candidate] of candidates.entries()) {
            const boundedMessageCount = countBoundedTextMessages(db, candidate.id)
            assert.ok(boundedMessageCount >= MIN_MESSAGES, setupMessage())

            const firstRun = createBaselineRun(db, candidate.id, {
              mode: 'comparative-message-count',
              contextMessages: 100,
              focalMessages: 50,
              stride: 50,
              minFocalMessages: 25,
              scorerConfig: { smoke: 'run-owned-windows-real' },
            })
            const secondRun = createBaselineRun(db, candidate.id, {
              mode: 'comparative-message-count',
              contextMessages: 100,
              focalMessages: 50,
              stride: 50,
              minFocalMessages: 25,
              scorerConfig: { smoke: 'run-owned-windows-real' },
            })

            const firstWindows = assertRun(db, firstRun.runId)
            const secondWindows = assertRun(db, secondRun.runId)
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

            const resultRows = db.prepare(
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
              importedMessages: candidate.message_count,
              boundedTextMessages: boundedMessageCount,
              runIds: [firstRun.runId, secondRun.runId],
              windowsPerRun: firstWindows.length,
              dominantCounts,
            })
          }

          assert.equal(
            db.prepare(
              \`
              SELECT COUNT(*) AS count
              FROM sqlite_master
              WHERE type = 'table' AND name = 'window_results'
            \`,
            ).get().count,
            0,
          )

          return {
            source: 'app-owned-imported-db-temp-copy',
            conversations: summaries,
            totals: {
              conversationCount: summaries.length,
              runCount: summaries.length * 2,
              windowCount: summaries.reduce(
                (sum, summary) => sum + summary.windowsPerRun * 2,
                0,
              ),
              totalMs: Date.now() - startedAt,
              meanWindowLatencyMs: round(
                allLatencies.reduce((sum, value) => sum + value, 0) /
                  Math.max(allLatencies.length, 1),
              ),
              medianWindowLatencyMs: percentile(allLatencies, 0.5),
            },
          }
        } finally {
          db.close()
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
  const result = runRealSmoke(appDbCopyPath)
  console.log(JSON.stringify(result, null, 2))
  console.log('real app-db run-owned windows smoke passed')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
