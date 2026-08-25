#!/usr/bin/env node
/**
 * Atomically claims the next sequence number in the plans directory and writes the
 * plan file in one step.
 *
 * Safe to run from many agents at once. Scanning for the highest number and then
 * writing the file is a TOCTOU race: two agents read `05`, both decide on `06`, and
 * you end up with two plans numbered 06 (they do not even collide on filename when
 * their titles differ, so an exclusive-create flag alone does not save you). The
 * number therefore has to be claimed under a lock covering the whole directory.
 *
 * The critical section is a directory scan plus one write - single-digit
 * milliseconds - so contention is negligible even with a dozen agents.
 *
 *   node scripts/claim-plan-number.mjs --slug add-friend-badge --body /tmp/plan.md
 *
 * Prints the path of the created file to stdout.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SEQUENCE_PATTERN = /^(\d+)[-_]/
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MIN_DIGITS = 2
const LOCK_NAME = '.plan-lock'
const LOCK_TIMEOUT_MS = 30_000
const LOCK_POLL_MS = 25
const LOCK_STALE_MS = 60_000

/**
 * Errors that mean "someone else is mid-flight, try again" rather than "give up".
 * EEXIST is the ordinary case. The rest are Windows: creating a directory that is
 * concurrently being deleted surfaces as EPERM/EACCES/EBUSY/ENOENT instead, and
 * treating those as fatal kills an otherwise healthy claimer under load.
 */
const CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ENOTEMPTY'])

function parseArgs(argv) {
  const args = { dir: 'plans', slug: null, body: null }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    if (!(key in args)) throw new Error(`Unknown argument: ${argv[i]}`)
    if (argv[i + 1] === undefined) throw new Error(`Missing value for --${key}`)
    args[key] = argv[i + 1]
  }
  if (!args.slug) throw new Error('--slug is required')
  if (!args.body) throw new Error('--body <file> is required')
  if (!SLUG_PATTERN.test(args.slug)) {
    throw new Error(`--slug must be kebab-case, got: ${args.slug}`)
  }
  return args
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function releaseStaleLock(lockPath) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      rmSync(lockPath, { recursive: true, force: true })
    }
  } catch {
    // Someone else released it first; nothing to do.
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lockPath) // atomic on every platform we run on
      return
    } catch (err) {
      if (!CONTENTION_CODES.has(err.code)) throw err
      releaseStaleLock(lockPath)
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${LOCK_TIMEOUT_MS} ms waiting for ${lockPath}`)
      }
      // Jitter keeps a queue of waiters from waking in lockstep and colliding again.
      sleepSync(LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS))
    }
  }
}

function withDirectoryLock(dir, action) {
  const lockPath = join(dir, LOCK_NAME)
  acquireLock(lockPath)
  try {
    return action()
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      // Never let cleanup mask the outcome of the claim itself; a leftover lock is
      // reclaimed as stale after LOCK_STALE_MS.
    }
  }
}

/** Existing numbers decide both the next value and how wide it is zero-padded. */
function readSequenceState(dir) {
  let highest = -1
  let digits = MIN_DIGITS
  for (const name of readdirSync(dir)) {
    const match = SEQUENCE_PATTERN.exec(name)
    if (!match) continue
    highest = Math.max(highest, Number(match[1]))
    digits = Math.max(digits, match[1].length)
  }
  return { next: highest + 1, digits }
}

/**
 * Always appends after the highest number rather than filling gaps - a deleted 02
 * is not a free slot, and reusing it would silently reorder queued work.
 */
function claimPlanFile(dir, slug, body) {
  const { next, digits } = readSequenceState(dir)
  const fileName = `${String(next).padStart(digits, '0')}-${slug}.md`
  const filePath = join(dir, fileName)
  writeFileSync(filePath, body, { flag: 'wx', encoding: 'utf8' })
  return filePath
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dir = resolve(args.dir)
  if (!statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`)

  const body = readFileSync(resolve(args.body), 'utf8')
  const filePath = withDirectoryLock(dir, () => claimPlanFile(dir, args.slug, body))

  process.stdout.write(`${relative(process.cwd(), filePath).replace(/\\/g, '/')}\n`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`claim-plan-number: ${err.message}\n`)
  process.exit(1)
}
