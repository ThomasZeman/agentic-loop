import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { forbiddenRepairPaths, isRepairable, repairableProblems } from './plan-repair.mjs'

const CLI = fileURLToPath(new URL('./plan-repair-cli.mjs', import.meta.url))

const VISUAL_RED = "package 'web' turned 3 visual test(s) red: DPR-1 | settings-screen.test.ts | settings tab > the empty state keeps its status line one section gap below the header - see C:\\code\\acme\\plans\\logs\\42.visual.txt"
const SUITE_RED = "package 'api' test suite is red (exit 1) - see C:\\code\\acme\\plans\\logs\\42.verify.txt"
const LINT_ROSE = "package 'web' lint count rose 122 -> 130 - see C:\\code\\acme\\plans\\logs\\42.quality.json"
const TSC_ROSE = "package 'core' tsc count rose 50 -> 51 - see C:\\code\\acme\\plans\\logs\\42.quality.json"

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

describe('repairableProblems', () => {
  test('a gate the agent can see and fix is repairable', () => {
    assert.deepEqual(repairableProblems([VISUAL_RED]), [VISUAL_RED])
    assert.deepEqual(repairableProblems([SUITE_RED]), [SUITE_RED])
    assert.deepEqual(repairableProblems([LINT_ROSE]), [LINT_ROSE])
    assert.deepEqual(repairableProblems([TSC_ROSE]), [TSC_ROSE])
  })

  test('several gates at once are all repairable', () => {
    assert.deepEqual(repairableProblems([VISUAL_RED, LINT_ROSE]), [VISUAL_RED, LINT_ROSE])
  })

  test('a plan that committed nothing has nothing to repair', () => {
    assert.deepEqual(repairableProblems(['no commit was created']), [])
  })

  test('a fault in the verification itself is not a gate a session can fix', () => {
    assert.deepEqual(repairableProblems(['verification failed to run: node is not on PATH']), [])
    assert.deepEqual(repairableProblems(["package 'web' visual suite: could not be measured - see log.txt"]), [])
  })

  test('a dirty tree is not repaired, because it says the plan itself went wrong', () => {
    assert.deepEqual(repairableProblems(['working tree not clean: src/stray.ts']), [])
  })
})

describe('isRepairable', () => {
  test('every problem must be a repairable gate, not merely one of them', () => {
    assert.equal(isRepairable([VISUAL_RED, LINT_ROSE]), true)
    assert.equal(isRepairable([VISUAL_RED, 'working tree not clean: src/stray.ts']), false)
    assert.equal(isRepairable([VISUAL_RED, 'no commit was created']), false)
  })

  test('a plan with no problems is not sent to a repair session', () => {
    assert.equal(isRepairable([]), false)
  })
})

describe('forbiddenRepairPaths', () => {
  test('a re-recorded visual baseline is refused - the plan never intended that change', () => {
    const changed = [
      'packages/web/src/settings/settings-content.tsx',
      'packages/web/tests/visual/__snapshots__/settings-screen.test.ts/DPR-2/settings-empty.png',
    ]

    assert.deepEqual(forbiddenRepairPaths(changed), [
      'packages/web/tests/visual/__snapshots__/settings-screen.test.ts/DPR-2/settings-empty.png',
    ])
  })

  test('a jest snapshot is refused on the same grounds', () => {
    assert.deepEqual(
      forbiddenRepairPaths(['packages/api/src/__snapshots__/codec.test.ts.snap']),
      ['packages/api/src/__snapshots__/codec.test.ts.snap'],
    )
  })

  test('backslash paths are read the same way, because git is not the only thing that lists them', () => {
    assert.deepEqual(
      forbiddenRepairPaths(['packages\\web\\tests\\visual\\__snapshots__\\a\\b.png']),
      ['packages\\web\\tests\\visual\\__snapshots__\\a\\b.png'],
    )
  })

  test('production code, tests and the report are all fair game', () => {
    const changed = [
      'packages/web/src/settings/settings-content.tsx',
      'packages/web/tests/visual/settings-screen.test.ts',
      'plans/reports/42-empty-settings-tab-explains-itself.md',
    ]

    assert.deepEqual(forbiddenRepairPaths(changed), [])
  })

  test('a file merely named like one is not mistaken for a snapshot directory', () => {
    assert.deepEqual(forbiddenRepairPaths(['packages/api/src/__snapshots__helper.ts']), [])
  })
})

describe('plan-repair-cli', () => {
  test('assess reads the problems from a file, BOM and all, and says they are repairable', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-repair-'))
    try {
      const problemsFile = join(root, 'problems.json')
      // PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM; the runner is the only
      // caller, so the CLI has to survive one.
      writeFileSync(problemsFile, '\uFEFF' + JSON.stringify([VISUAL_RED]), 'utf8')

      const result = spawnSync(process.execPath, [CLI, 'assess', '--problems-file', problemsFile], { encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { repairable: true, problems: [VISUAL_RED] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('assess reads a bare string - what a one-item array becomes when piped to ConvertTo-Json', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-repair-'))
    try {
      const problemsFile = join(root, 'problems.json')
      writeFileSync(problemsFile, JSON.stringify(VISUAL_RED), 'utf8')

      const result = spawnSync(process.execPath, [CLI, 'assess', '--problems-file', problemsFile], { encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { repairable: true, problems: [VISUAL_RED] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('assess reads the {value, Count} wrapper PowerShell 5.1 emits for a comma-wrapped array', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-repair-'))
    try {
      const problemsFile = join(root, 'problems.json')
      writeFileSync(problemsFile, JSON.stringify({ value: [VISUAL_RED, LINT_ROSE], Count: 2 }), 'utf8')

      const result = spawnSync(process.execPath, [CLI, 'assess', '--problems-file', problemsFile], { encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { repairable: true, problems: [VISUAL_RED, LINT_ROSE] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('assess refuses the set when one problem is not a gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-repair-'))
    try {
      const problemsFile = join(root, 'problems.json')
      writeFileSync(problemsFile, JSON.stringify([VISUAL_RED, 'no commit was created']), 'utf8')

      const result = spawnSync(process.execPath, [CLI, 'assess', '--problems-file', problemsFile], { encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).repairable, false)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('audit names the snapshot a repair commit re-recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-repair-'))
    try {
      git(root, ['init'])
      mkdirSync(join(root, 'tests', 'visual', '__snapshots__'), { recursive: true })
      writeFileSync(join(root, 'app.ts'), 'export const a = 1\n')
      writeFileSync(join(root, 'tests', 'visual', '__snapshots__', 'screen.png'), 'before')
      git(root, ['add', '.'])
      git(root, ['commit', '-m', 'the plan'])
      const before = git(root, ['rev-parse', 'HEAD'])

      writeFileSync(join(root, 'app.ts'), 'export const a = 2\n')
      writeFileSync(join(root, 'tests', 'visual', '__snapshots__', 'screen.png'), 'after')
      git(root, ['add', '.'])
      git(root, ['commit', '-m', 'the repair'])

      const result = spawnSync(process.execPath, [CLI, 'audit', '--since', before], { cwd: root, encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), {
        changed: ['app.ts', 'tests/visual/__snapshots__/screen.png'],
        forbidden: ['tests/visual/__snapshots__/screen.png'],
      })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test('audit passes a repair that only touched code', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-repair-'))
    try {
      git(root, ['init'])
      writeFileSync(join(root, 'app.ts'), 'export const a = 1\n')
      git(root, ['add', '.'])
      git(root, ['commit', '-m', 'the plan'])
      const before = git(root, ['rev-parse', 'HEAD'])

      writeFileSync(join(root, 'app.ts'), 'export const a = 2\n')
      git(root, ['add', '.'])
      git(root, ['commit', '-m', 'the repair'])

      const result = spawnSync(process.execPath, [CLI, 'audit', '--since', before], { cwd: root, encoding: 'utf8' })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { changed: ['app.ts'], forbidden: [] })
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
