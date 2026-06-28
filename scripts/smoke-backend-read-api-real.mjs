import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tempDir = await mkdtemp(path.join(root, '.smoke-backend-read-api-real-'))
const bundlePath = path.join(tempDir, 'smoke-backend-read-api-real.mjs')

try {
  await build({
    entryPoints: [path.join(root, 'scripts/smoke-backend-read-api-real.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['better-sqlite3'],
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
