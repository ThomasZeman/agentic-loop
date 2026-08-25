import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { syncDecision } from './git-sync.mjs'

const CLI = fileURLToPath(new URL('./git-sync-cli.mjs', import.meta.url))

/**
 * git with an identity and a signing setting of its own.
 *
 * The machine running this may sign every commit, or have no user.name at all; neither is
 * this test's business, and both would fail it for something that has nothing to do with
 * the code under test.
 */
function git(cwd, args) {
  const identity = [
    '-c', 'user.email=runner@example.test',
    '-c', 'user.name=Plan Runner',
    '-c', 'commit.gpgsign=false',
  ]
  return execFileSync('git', [...identity, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function commit(repo, name, text) {
  writeFileSync(join(repo, name), text)
  git(repo, ['add', name])
  git(repo, ['commit', '-m', `add ${name}`])
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
}

/**
 * A bare repository with one commit on `main`, plus a clone that pushed it - and a way to make
 * more clones of it. The remote is a path on disk, so nothing here touches the network.
 */
function withRemote(run) {
  const root = mkdtempSync(join(tmpdir(), 'git-sync-'))
  try {
    git(root, ['init', '--bare', 'origin.git'])
    // Before anything is pushed, so every clone gets 'main' as its checked-out branch with its
    // upstream already set. A bare repo whose HEAD names a ref that does not exist clones into
    // a repository with no branch at all.
    git(join(root, 'origin.git'), ['symbolic-ref', 'HEAD', 'refs/heads/main'])

    const first = join(root, 'first')
    git(root, ['clone', 'origin.git', 'first'])
    git(first, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    commit(first, 'a.txt', 'one\n')
    git(first, ['push', '-u', 'origin', 'main'])

    const clone = (name) => {
      git(root, ['clone', 'origin.git', name])
      return join(root, name)
    }
    run({ root, first, clone })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('syncDecision', () => {
  test('a branch tracking nothing has nothing to do, whatever the counts say', () => {
    const decision = syncDecision({ hasUpstream: false, ahead: 4, behind: 9 })

    assert.equal(decision.state, 'no-upstream')
    assert.deepEqual(decision.actions, [])
  })

  test('a branch level with its remote has nothing to do', () => {
    const decision = syncDecision({ hasUpstream: true, ahead: 0, behind: 0 })

    assert.equal(decision.state, 'in-sync')
    assert.deepEqual(decision.actions, [])
  })

  test('a branch only behind fast-forwards', () => {
    const decision = syncDecision({ hasUpstream: true, ahead: 0, behind: 3 })

    assert.equal(decision.state, 'behind')
    assert.deepEqual(decision.actions, ['fast-forward'])
  })

  test('a branch only ahead pushes', () => {
    const decision = syncDecision({ hasUpstream: true, ahead: 2, behind: 0 })

    assert.equal(decision.state, 'ahead')
    assert.deepEqual(decision.actions, ['push'])
  })

  // Neither action reconciles this, and the runner never merges or force-pushes to make it look
  // as though one did. The reason has to carry both counts because it is the whole diagnosis a
  // human gets before deciding what to do about it.
  test('a diverged branch does nothing and says how far apart the two sides are', () => {
    const decision = syncDecision({ hasUpstream: true, ahead: 2, behind: 3 })

    assert.equal(decision.state, 'diverged')
    assert.deepEqual(decision.actions, [])
    assert.match(decision.reason, /2/)
    assert.match(decision.reason, /3/)
  })
})

describe('git-sync-cli', () => {
  test('measures a clone the remote has moved past, and moves nothing itself', () => {
    withRemote(({ first, clone }) => {
      const behind = clone('behind')
      const before = git(behind, ['rev-parse', 'main'])
      commit(first, 'b.txt', 'two\n')
      git(first, ['push', 'origin', 'main'])

      const result = runCli(behind, ['--base', 'main'])

      assert.equal(result.status, 0, result.stderr)
      const answer = JSON.parse(result.stdout)
      assert.equal(answer.state, 'behind')
      assert.equal(answer.behind, 1)
      assert.equal(answer.ahead, 0)
      assert.deepEqual(answer.actions, ['fast-forward'])
      assert.equal(answer.upstream, 'origin/main')
      assert.equal(answer.remote, 'origin')
      assert.equal(git(behind, ['rev-parse', 'main']), before, 'the CLI merged something')
    })
  })

  // A refusal is an answer. Exiting non-zero here would be indistinguishable from a fetch that
  // failed, and the runner would report an infrastructure fault instead of a diverged branch.
  test('answers 0 for a diverged clone rather than failing', () => {
    withRemote(({ first, clone }) => {
      const diverged = clone('diverged')
      commit(diverged, 'mine.txt', 'mine\n')
      commit(first, 'theirs.txt', 'theirs\n')
      git(first, ['push', 'origin', 'main'])

      const result = runCli(diverged, ['--base', 'main'])

      assert.equal(result.status, 0, result.stderr)
      const answer = JSON.parse(result.stdout)
      assert.equal(answer.state, 'diverged')
      assert.equal(answer.ahead, 1)
      assert.equal(answer.behind, 1)
      assert.deepEqual(answer.actions, [])
    })
  })

  // The supported way to run a throwaway batch: a local-only branch. It must degrade to the
  // runner's old behaviour, not stop it.
  test('reports a local-only branch as tracking nothing', () => {
    withRemote(({ clone }) => {
      const local = clone('local')
      git(local, ['checkout', '-b', 'plan-run/20260815'])

      const result = runCli(local, ['--base', 'plan-run/20260815'])

      assert.equal(result.status, 0, result.stderr)
      const answer = JSON.parse(result.stdout)
      assert.equal(answer.state, 'no-upstream')
      assert.deepEqual(answer.actions, [])
      assert.equal(answer.upstream, '')
    })
  })

  test('fails, with a diagnosis, when there is no repository to measure', () => {
    const outside = mkdtempSync(join(tmpdir(), 'git-sync-bare-'))
    try {
      const result = runCli(outside, ['--base', 'main'])

      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /not a git repository/i)
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
