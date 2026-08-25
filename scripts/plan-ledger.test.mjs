import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { settledPlanNames, trackedPlanNames } from './plan-ledger.mjs'

const CLI = fileURLToPath(new URL('./plan-ledger-cli.mjs', import.meta.url))

/**
 * git with an identity and a signing setting of its own, so the test does not depend on
 * whatever the machine running it has configured.
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

describe('settledPlanNames, from .state.json alone', () => {
  test('a completed plan is settled', () => {
    const settled = settledPlanNames({ state: { '07-thing.md': { status: 'completed' } }, trackedPaths: [] })

    assert.deepEqual([...settled], ['07-thing.md'])
  })

  test('a wont-do plan is settled', () => {
    const settled = settledPlanNames({ state: { '07-thing.md': { status: 'wont-do' } }, trackedPaths: [] })

    assert.deepEqual([...settled], ['07-thing.md'])
  })

  test('needs-review and skipped are not settled', () => {
    const settled = settledPlanNames({
      state: { '07-thing.md': { status: 'needs-review' }, '08-other.md': { status: 'skipped' } },
      trackedPaths: [],
    })

    assert.deepEqual([...settled], [])
  })
})

describe('settledPlanNames, from the tracked files', () => {
  test('a tracked plan file is settled with no state entry at all', () => {
    const settled = settledPlanNames({ state: {}, trackedPaths: ['plans/07-thing.md'] })

    assert.deepEqual([...settled], ['07-thing.md'])
  })

  test('tracked beats needs-review, because only its own plan ever commits it', () => {
    const settled = settledPlanNames({
      state: { '07-thing.md': { status: 'needs-review' } },
      trackedPaths: ['plans/07-thing.md'],
    })

    assert.equal(settled.has('07-thing.md'), true)
  })

  test('a committed report does not settle the plan it reports on', () => {
    const settled = settledPlanNames({ state: {}, trackedPaths: ['plans/reports/07-thing.md'] })

    assert.deepEqual([...settled], [])
  })

  test('the paperwork beside the plans is not a plan', () => {
    const settled = settledPlanNames({
      state: {},
      trackedPaths: ['plans/_preamble.md', 'plans/.gitignore', 'plans/README.md'],
    })

    assert.deepEqual([...settled], [])
  })
})

// The ticket loop lists from inside plans/ rather than from the repo root, so it sees the
// same files under one path segment fewer. Both callers must agree on which of them is a plan.
describe('trackedPlanNames, from a listing taken inside the plans directory', () => {
  test('a plan file is one', () => {
    assert.deepEqual([...trackedPlanNames(['07-thing.md'])], ['07-thing.md'])
  })

  test('a report is not the plan it reports on', () => {
    assert.deepEqual([...trackedPlanNames(['reports/07-thing.md'])], [])
  })

  test('the paperwork beside the plans is not a plan', () => {
    assert.deepEqual([...trackedPlanNames(['_preamble.md', '.gitignore', 'README.md'])], [])
  })

  test('a listing with nothing tracked is empty rather than a throw', () => {
    assert.deepEqual([...trackedPlanNames([])], [])
  })
})

describe('plan-ledger-cli', () => {
  test('reports the tracked plans when there is no state file', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-ledger-'))
    try {
      git(root, ['init'])
      mkdirSync(join(root, 'plans'))
      writeFileSync(join(root, 'plans', '07-thing.md'), '# thing\n')
      writeFileSync(join(root, 'plans', '_preamble.md'), '# preamble\n')
      git(root, ['add', 'plans/07-thing.md', 'plans/_preamble.md'])
      git(root, ['commit', '-m', 'add a plan'])

      const result = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { settled: ['07-thing.md'] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
