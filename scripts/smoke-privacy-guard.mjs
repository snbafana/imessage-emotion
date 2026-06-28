import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const blockedDbExtensions = new Set(['.db', '.sqlite', '.sqlite3'])
const sourceExtensions = new Set(['.html', '.json', '.json5', '.md', '.mjs', '.ts', '.tsx'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function filesToCheck() {
  const changed = execFileSync('git', ['diff', '--name-only', '-z', 'origin/main'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  return [...new Set([...changed, ...untracked])].filter((file) => !file.startsWith('.smoke-'))
}

function isLikelyPrivateEmail(value) {
  return /[A-Z0-9._%+-]+@(?!(example\.com|example\.org)\b)[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
}

function isLikelyPrivatePhone(value) {
  const matches =
    value.match(/(?:\+\d[\d .()-]{8,}\d|\(\d{3}\)\s*\d{3}-\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/g) ??
    []
  return matches.some((match) => !match.includes('555'))
}

const files = filesToCheck()
const rawDbFiles = files.filter((file) => {
  const ext = extname(file)
  return blockedDbExtensions.has(ext) || file.endsWith('.db-wal') || file.endsWith('.db-shm')
})
assert(rawDbFiles.length === 0, `raw database files are tracked: ${rawDbFiles.join(', ')}`)

const failures = []
const referenceName = String.fromCharCode(67, 117, 101, 100)
const referenceBrandingPattern = new RegExp(`\\b${referenceName}\\b`)
const referencePathPattern = new RegExp(
  `/Users/snbafana/Documents/personal/${'cued'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  'i',
)
for (const file of files) {
  if (file === 'package-lock.json') continue
  if (!sourceExtensions.has(extname(file))) continue
  const source = readFileSync(file, 'utf8')
  if (referencePathPattern.test(source)) {
    failures.push(`${file}: reference repo path`)
  }
  if (referenceBrandingPattern.test(source)) {
    failures.push(`${file}: reference repo branding`)
  }
  if (isLikelyPrivateEmail(source)) {
    failures.push(`${file}: non-example email address`)
  }
  if (isLikelyPrivatePhone(source)) {
    failures.push(`${file}: non-synthetic phone number`)
  }
}

assert(failures.length === 0, `privacy guard failed:\n${failures.join('\n')}`)
console.log(`Privacy guard passed: ${files.length} tracked files checked`)
