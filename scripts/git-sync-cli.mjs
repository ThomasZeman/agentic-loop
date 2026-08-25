#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to ask how the base branch stands against its remote,
 * answering on stdout as JSON.
 *
 * It fetches - that is the only way the question has a current answer - and then measures.
 * It performs no merge and no push: the runner does those itself, so that everything which
 * moves a branch stays in one place and goes through `Invoke-Git`.
 *
 * Reporting only, in the sense `plan-tree-cli.mjs` states: the exit code says whether the
 * question could be answered, never what the answer was. A diverged branch is an answer and
 * exits 0; a directory that is not a repository, or a fetch that failed, is not and exits 1.
 *
 *   node scripts/git-sync-cli.mjs [--base main]
 */
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

import { syncDecision } from './git-sync.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { base: { type: 'string' } },
})

// A credential prompt would hang an unattended overnight run forever, on a machine with nobody
// at it. A fetch that fails instead is a plan's problem for a minute and then somebody's morning.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Runs git for a question whose answer may legitimately be "no" - an unset key, a missing ref. */
function gitOrNull(args) {
  try {
    return git(args) || null
  } catch {
    return null
  }
}

function assertRepository() {
  if (gitOrNull(['rev-parse', '--git-dir'])) return
  throw new Error(`not a git repository: ${process.cwd()}`)
}

/**
 * The remote this branch belongs to.
 *
 * Its own configured remote first, because that is the one answer nobody has to guess at. A
 * branch that has never been pushed has none, and then 'origin' is what every clone of this
 * repository calls its remote - falling back to the only remote there is when it is named
 * something else, and to nothing at all when there is a choice to be made.
 */
function remoteFor(base) {
  const configured = gitOrNull(['config', '--get', `branch.${base}.remote`])
  if (configured) return configured

  const remotes = git(['remote']).split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? remotes[0] : null
}

/**
 * The remote-tracking branch to measure against.
 *
 * The configured upstream is the truth when there is one. Without it, `<remote>/<base>` is
 * still the branch this one would push to, and a runner started on a freshly-checked-out base
 * branch is a normal way to arrive here - so a branch that has an obvious counterpart on the
 * remote is not called untracked. One that has no counterpart is.
 */
function upstreamFor(base, remote) {
  const tracked = gitOrNull(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${base}@{upstream}`])
  if (tracked) return tracked
  if (!remote) return null

  const candidate = `refs/remotes/${remote}/${base}`
  return gitOrNull(['rev-parse', '--verify', '--quiet', candidate]) ? `${remote}/${base}` : null
}

/**
 * How far apart the two are, as `git rev-list --left-right` counts it: the left side is the
 * upstream, so its count is what the branch is behind by, and the right side is the branch.
 */
function countsFor(base, upstream) {
  const [behind, ahead] = git(['rev-list', '--left-right', '--count', `${upstream}...${base}`])
    .split(/\s+/)
    .map(Number)
  return { ahead, behind }
}

function main() {
  assertRepository()

  const base = values.base?.trim() || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = remoteFor(base)
  if (remote) git(['fetch', '--prune', '--tags', remote])

  const upstream = upstreamFor(base, remote)
  const counts = upstream ? countsFor(base, upstream) : { ahead: 0, behind: 0 }
  const decision = syncDecision({ hasUpstream: Boolean(upstream), ...counts })

  return { remote: remote ?? '', base, upstream: upstream ?? '', ...counts, ...decision }
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`)
} catch (error) {
  process.stderr.write(`git-sync: ${error.message}\n`)
  process.exit(1)
}
