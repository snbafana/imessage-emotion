import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tempDir = await mkdtemp(path.join(repoRoot, '.smoke-run-owned-windows-'))

try {
  const entryPath = path.join(tempDir, 'entry.ts')
  const bundlePath = path.join(tempDir, 'entry.mjs')
  const dbPath = path.join(tempDir, 'smoke.sqlite')

  await writeFile(
    entryPath,
    `
      import assert from 'node:assert/strict'
      import Database from 'better-sqlite3'
      import { migrate } from ${JSON.stringify(path.join(repoRoot, 'src/lib/db/schema.ts'))}
      import { createBaselineRun } from ${JSON.stringify(
        path.join(repoRoot, 'src/lib/emotion/run-baseline.ts'),
      )}

      export function runSmoke(dbPath) {
        const db = new Database(dbPath)
        migrate(db)
        db.pragma('foreign_keys = ON')

        const conversation = db.prepare(
          \`
          INSERT INTO conversations (source_chat_id, chat_identifier, display_name, is_group)
          VALUES (1, 'smoke-chat', 'Smoke Chat', 0)
        \`,
        ).run()
        const conversationId = Number(conversation.lastInsertRowid)
        const insertMessage = db.prepare(
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
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'delivered')
        \`,
        )

        for (let ordinal = 1; ordinal <= 225; ordinal += 1) {
          const text = ordinal <= 100
            ? 'neutral planning message'
            : ordinal <= 150
              ? 'thanks happy appreciate love'
              : ordinal <= 200
                ? 'busy stressed urgent worried'
                : 'sorry sad hurt disappointed'
          insertMessage.run(
            conversationId,
            ordinal,
            ordinal,
            'smoke-message-' + ordinal,
            text,
            ordinal * 1000,
            ordinal % 2,
          )
        }

        const config = {
          mode: 'comparative-message-count',
          contextMessages: 100,
          focalMessages: 50,
          stride: 50,
          minFocalMessages: 25,
        }
        const firstRun = createBaselineRun(db, conversationId, config)
        const secondRun = createBaselineRun(db, conversationId, config)

        assert.equal(firstRun.windowCount, 3)
        assert.equal(secondRun.windowCount, 3)

        const windows = db.prepare(
          \`
          SELECT
            run_id,
            ordinal,
            start_ordinal,
            end_ordinal,
            context_start_ordinal,
            context_end_ordinal,
            focal_start_ordinal,
            focal_end_ordinal,
            context_message_count,
            focal_message_count,
            result_json
          FROM windows
          ORDER BY run_id, ordinal
        \`,
        ).all()

        assert.equal(windows.length, 6)
        assert.deepEqual(
          windows.map((window) => [
            window.ordinal,
            window.start_ordinal,
            window.end_ordinal,
            window.context_start_ordinal,
            window.context_end_ordinal,
            window.focal_start_ordinal,
            window.focal_end_ordinal,
            window.context_message_count,
            window.focal_message_count,
          ]),
          [
            [1, 1, 150, 1, 100, 101, 150, 100, 50],
            [2, 51, 200, 51, 150, 151, 200, 100, 50],
            [3, 101, 225, 101, 200, 201, 225, 100, 25],
            [1, 1, 150, 1, 100, 101, 150, 100, 50],
            [2, 51, 200, 51, 150, 151, 200, 100, 50],
            [3, 101, 225, 101, 200, 201, 225, 100, 25],
          ],
        )

        assert.notEqual(windows[0].run_id, windows[3].run_id)
        assert.deepEqual(
          windows.slice(0, 3).map((window) => [
            window.start_ordinal,
            window.end_ordinal,
            window.focal_start_ordinal,
            window.focal_end_ordinal,
          ]),
          windows.slice(3).map((window) => [
            window.start_ordinal,
            window.end_ordinal,
            window.focal_start_ordinal,
            window.focal_end_ordinal,
          ]),
        )

        for (const window of windows) {
          const result = JSON.parse(window.result_json)
          assert.equal(result.method, 'baseline-v1')
          assert.equal(typeof result.scores.warmth, 'number')
          assert.equal(typeof result.scores.joy, 'number')
          assert.equal(typeof result.scores.stress, 'number')
          assert.equal(typeof result.scores.friction, 'number')
          assert.equal(typeof result.scores.sadness, 'number')
        }

        const summaries = db.prepare(
          \`
          SELECT id, summary_json
          FROM analysis_runs
          ORDER BY id
        \`,
        ).all()
        assert.equal(summaries.length, 2)
        for (const run of summaries) {
          assert.equal(JSON.parse(run.summary_json).windowCount, 3)
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

        db.close()
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

  const { runSmoke } = await import(pathToFileURL(bundlePath).href)
  runSmoke(dbPath)
  console.log('run-owned windows smoke passed')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
