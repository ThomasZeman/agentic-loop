import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  CONFIG_FILE_RELATIVE_PATH,
  DEFAULT_CONFIG,
  loadRunnerConfig,
  resolveRunnerConfig,
} from './runner-config.mjs'

describe('resolveRunnerConfig', () => {
  test('no overrides at all yields the defaults', () => {
    const config = resolveRunnerConfig({})
    assert.deepEqual(config, DEFAULT_CONFIG)
  })

  test('null stands for a missing file and also yields the defaults', () => {
    assert.deepEqual(resolveRunnerConfig(null), DEFAULT_CONFIG)
  })

  test('defaults are generic npm conventions, with no servers or blind packages', () => {
    const config = resolveRunnerConfig({})
    assert.equal(config.packagesDir, 'packages')
    assert.equal(config.gates.test.script, 'test')
    assert.equal(config.gates.visual.script, 'test:visual')
    assert.equal(config.gates.visual.report, 'test-results/visual-report.json')
    assert.equal(config.gates.quality.enabled, true)
    assert.deepEqual(config.devServers, [])
    assert.deepEqual(config.watcherBlindPackages, [])
  })

  test('a top-level override replaces only its own key', () => {
    const config = resolveRunnerConfig({ packagesDir: 'apps' })
    assert.equal(config.packagesDir, 'apps')
    assert.equal(config.gates.test.script, 'test')
  })

  test('a gate override merges field by field, keeping the rest of the gate', () => {
    const config = resolveRunnerConfig({ gates: { visual: { timeoutMinutes: 5 } } })
    assert.equal(config.gates.visual.timeoutMinutes, 5)
    assert.equal(config.gates.visual.script, 'test:visual')
    assert.equal(config.gates.test.timeoutMinutes, DEFAULT_CONFIG.gates.test.timeoutMinutes)
  })

  test('the quality gate can be switched off', () => {
    const config = resolveRunnerConfig({ gates: { quality: { enabled: false } } })
    assert.equal(config.gates.quality.enabled, false)
  })

  test('devServers replaces the whole table, and an empty table is a valid one', () => {
    const config = resolveRunnerConfig({ devServers: [] })
    assert.deepEqual(config.devServers, [])
  })

  test('a declared dev server gets its optional fields filled in', () => {
    const config = resolveRunnerConfig({
      devServers: [{ name: 'api', url: 'http://127.0.0.1:4000/', packageDir: 'services/api', npmScript: 'dev' }],
    })
    assert.deepEqual(config.devServers, [{
      name: 'api',
      url: 'http://127.0.0.1:4000/',
      packageDir: 'services/api',
      npmScript: 'dev',
      startTimeoutSeconds: 180,
      readyWhen: 'any-response',
      readiness: 'any HTTP status',
    }])
  })

  test('a dev server missing a required field is refused by name', () => {
    assert.throws(
      () => resolveRunnerConfig({ devServers: [{ name: 'api', url: 'http://127.0.0.1:4000/' }] }),
      /dev server 'api'.*packageDir/,
    )
  })

  test('an unknown readyWhen is refused, naming the choices', () => {
    assert.throws(
      () => resolveRunnerConfig({
        devServers: [{ name: 'api', url: 'u', packageDir: 'd', npmScript: 's', readyWhen: 'tea-ready' }],
      }),
      /readyWhen.*any-response.*http-200/,
    )
  })

  test('an unknown top-level key is refused rather than silently ignored', () => {
    assert.throws(() => resolveRunnerConfig({ packageDir: 'packages' }), /unknown key 'packageDir'/)
  })

  test('an unknown gate name is refused', () => {
    assert.throws(() => resolveRunnerConfig({ gates: { lint: {} } }), /unknown gate 'lint'/)
  })

  test('watcherBlindPackages must be a list of strings', () => {
    assert.throws(() => resolveRunnerConfig({ watcherBlindPackages: 'shared' }), /watcherBlindPackages/)
  })

  test('every hook is off by default - a project opts in by naming a command', () => {
    const config = resolveRunnerConfig({})
    assert.deepEqual(config.hooks, { siblingsAfter: null, demo: null, afterPlan: null, release: null })
  })

  test('the afterPlan hook is a plain command hook like the others', () => {
    const config = resolveRunnerConfig({ hooks: { afterPlan: ['node', 'scripts/hooks/sweep.mjs'] } })
    assert.deepEqual(config.hooks.afterPlan, ['node', 'scripts/hooks/sweep.mjs'])
    assert.throws(() => resolveRunnerConfig({ hooks: { afterPlan: 'sweep' } }), /hooks\.afterPlan.*list/)
  })

  test('a command hook is a non-empty list of strings: program first, then its arguments', () => {
    const config = resolveRunnerConfig({ hooks: { siblingsAfter: ['node', 'scripts/siblings-after.mjs'] } })
    assert.deepEqual(config.hooks.siblingsAfter, ['node', 'scripts/siblings-after.mjs'])
    assert.equal(config.hooks.demo, null)
  })

  test('a command hook that is not a list of strings is refused by name', () => {
    assert.throws(() => resolveRunnerConfig({ hooks: { demo: 'node x.mjs' } }), /hooks\.demo.*list/)
    assert.throws(() => resolveRunnerConfig({ hooks: { demo: [] } }), /hooks\.demo.*list/)
  })

  test('the release hook carries the platform names its command is asked to tag', () => {
    const config = resolveRunnerConfig({
      hooks: { release: { command: ['pwsh', 'release-hook.ps1'], perPlanPlatform: 'web', perBatchPlatform: 'android' } },
    })
    assert.deepEqual(config.hooks.release, {
      command: ['pwsh', 'release-hook.ps1'],
      perPlanPlatform: 'web',
      perBatchPlatform: 'android',
    })
  })

  test('a release hook without perPlanPlatform is refused, naming the key', () => {
    assert.throws(
      () => resolveRunnerConfig({ hooks: { release: { command: ['pwsh', 'r.ps1'] } } }),
      /hooks\.release\.perPlanPlatform/,
    )
    assert.throws(
      () => resolveRunnerConfig({ hooks: { release: { command: ['pwsh', 'r.ps1'], perPlanPlatform: '' } } }),
      /hooks\.release\.perPlanPlatform/,
    )
  })

  test('a release hook has no batch platform unless it names one', () => {
    const config = resolveRunnerConfig({
      hooks: { release: { command: ['pwsh', 'r.ps1'], perPlanPlatform: 'web' } },
    })
    assert.equal(config.hooks.release.perBatchPlatform, null)
  })

  test('a release hook without a command is refused', () => {
    assert.throws(() => resolveRunnerConfig({ hooks: { release: { perPlanPlatform: 'web' } } }), /hooks\.release\.command/)
  })

  test('an unknown hook name is refused', () => {
    assert.throws(() => resolveRunnerConfig({ hooks: { onMerge: ['x'] } }), /unknown hook 'onMerge'/)
  })

  test('the resolved config is a fresh object each time, not a shared mutable default', () => {
    const first = resolveRunnerConfig({})
    first.packagesDir = 'mutated'
    assert.equal(resolveRunnerConfig({}).packagesDir, 'packages')
  })
})

describe('loadRunnerConfig', () => {
  function inTempRepo(run) {
    const root = mkdtempSync(path.join(tmpdir(), 'runner-config-'))
    try {
      return run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('a repo without the file gets the defaults', () => {
    inTempRepo((root) => {
      assert.deepEqual(loadRunnerConfig(root), DEFAULT_CONFIG)
    })
  })

  test('the file is read from plans/runner.json under the given root', () => {
    inTempRepo((root) => {
      mkdirSync(path.join(root, 'plans'))
      writeFileSync(path.join(root, CONFIG_FILE_RELATIVE_PATH), '{"packagesDir":"apps"}')
      assert.equal(loadRunnerConfig(root).packagesDir, 'apps')
    })
  })

  test('a UTF-8 BOM is tolerated, because PowerShell 5.1 writes one', () => {
    inTempRepo((root) => {
      mkdirSync(path.join(root, 'plans'))
      const bom = String.fromCharCode(0xfeff)
      writeFileSync(path.join(root, CONFIG_FILE_RELATIVE_PATH), `${bom}{"packagesDir":"apps"}`)
      assert.equal(loadRunnerConfig(root).packagesDir, 'apps')
    })
  })

  test('malformed JSON is a loud fault naming the file, never a silent fallback', () => {
    inTempRepo((root) => {
      mkdirSync(path.join(root, 'plans'))
      writeFileSync(path.join(root, CONFIG_FILE_RELATIVE_PATH), '{not json')
      assert.throws(() => loadRunnerConfig(root), /runner\.json/)
    })
  })
})
