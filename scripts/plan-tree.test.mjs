import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import { assessRunnerTree, porcelainPaths } from './plan-tree.mjs'

describe('porcelainPaths', () => {
  test('reads the path out of an untracked line', () => {
    assert.deepEqual(porcelainPaths('?? plans/101-a-thing.md'), ['plans/101-a-thing.md'])
  })

  test('reads both sides of a rename', () => {
    assert.deepEqual(porcelainPaths('R  plans/1-old.md -> plans/2-new.md'), [
      'plans/1-old.md',
      'plans/2-new.md',
    ])
  })

  test('unquotes a path git had to quote', () => {
    assert.deepEqual(porcelainPaths('?? "plans/101-a thing.md"'), ['plans/101-a thing.md'])
  })
})

describe('assessRunnerTree, before a plan starts', () => {
  test('a clean tree is clean', () => {
    assert.deepEqual(assessRunnerTree([]), { clean: true, blocking: [], carried: [] })
  })

  test('an untracked queued plan is carried, not blocking', () => {
    const assessment = assessRunnerTree(['?? plans/101-a-thing.md'])

    assert.equal(assessment.clean, true)
    assert.deepEqual(assessment.carried, ['plans/101-a-thing.md'])
    assert.deepEqual(assessment.blocking, [])
  })

  test('one modified source file blocks, even beside a carried plan', () => {
    const assessment = assessRunnerTree([
      '?? plans/101-a-thing.md',
      ' M packages/web/src/app.ts',
    ])

    assert.equal(assessment.clean, false)
    assert.deepEqual(assessment.blocking, ['packages/web/src/app.ts'])
    assert.deepEqual(assessment.carried, ['plans/101-a-thing.md'])
  })

  test('a plan file someone is still editing is carried', () => {
    assert.equal(assessRunnerTree([' M plans/101-a-thing.md']).clean, true)
  })

  test('a staged plan file is carried', () => {
    assert.equal(assessRunnerTree(['A  plans/101-a-thing.md']).clean, true)
  })

  test('a deleted plan file is carried', () => {
    assert.equal(assessRunnerTree([' D plans/99-gone.md']).clean, true)
  })

  test('a report left behind by an earlier run is carried', () => {
    assert.deepEqual(assessRunnerTree(['?? plans/reports/101-a-thing.md']).carried, [
      'plans/reports/101-a-thing.md',
    ])
  })

  test('the preamble every plan is composed from is carried while it is being edited', () => {
    assert.equal(assessRunnerTree([' M plans/_preamble.md']).clean, true)
  })

  test('the match is anchored to the plans directory', () => {
    assert.deepEqual(assessRunnerTree(['?? plans-notes/101-a-thing.md']).blocking, [
      'plans-notes/101-a-thing.md',
    ])
  })

  test('a runner script being worked on is carried', () => {
    const assessment = assessRunnerTree([' M scripts/quality-counts.mjs'])

    assert.equal(assessment.clean, true)
    assert.deepEqual(assessment.carried, ['scripts/quality-counts.mjs'])
  })

  test('a new script nobody has committed yet is carried', () => {
    assert.equal(assessRunnerTree(['?? scripts/hooks/siblings-after.mjs']).clean, true)
  })

  test('the match is anchored to the scripts directory too', () => {
    assert.deepEqual(assessRunnerTree(['?? scripts-old/tidy.mjs']).blocking, [
      'scripts-old/tidy.mjs',
    ])
  })

  test('a source file still blocks beside a carried script', () => {
    const assessment = assessRunnerTree([
      ' M scripts/run-plans.ps1',
      ' M packages/backend/src/app.ts',
    ])

    assert.deepEqual(assessment.blocking, ['packages/backend/src/app.ts'])
    assert.deepEqual(assessment.carried, ['scripts/run-plans.ps1'])
  })

  test('a note filed beside the plans is carried, whatever it is named', () => {
    assert.equal(assessRunnerTree(['?? plans/101-a-thing/notes.md']).clean, true)
  })

  test('each side of a rename is judged on its own', () => {
    const assessment = assessRunnerTree(['R  docs/old.md -> plans/220-moved.md'])

    assert.deepEqual(assessment.blocking, ['docs/old.md'])
    assert.deepEqual(assessment.carried, ['plans/220-moved.md'])
  })

  test('blank porcelain lines are ignored', () => {
    assert.equal(assessRunnerTree(['', '   ', '?? plans/101-a-thing.md']).clean, true)
  })
})

describe('assessRunnerTree, when a plan has just run', () => {
  test('the plan that just ran must be committed', () => {
    const assessment = assessRunnerTree(['?? plans/100-done.md'], { runningPlan: '100-done.md' })

    assert.equal(assessment.clean, false)
    assert.deepEqual(assessment.blocking, ['plans/100-done.md'])
    assert.deepEqual(assessment.carried, [])
  })

  test('so must its report', () => {
    const assessment = assessRunnerTree(['?? plans/reports/100-done.md'], {
      runningPlan: '100-done.md',
    })

    assert.equal(assessment.clean, false)
    assert.deepEqual(assessment.blocking, ['plans/reports/100-done.md'])
  })

  test('a report the agent edited but did not commit blocks just the same', () => {
    assert.deepEqual(
      assessRunnerTree([' M plans/reports/100-done.md'], { runningPlan: '100-done.md' }).blocking,
      ['plans/reports/100-done.md']
    )
  })

  test("another plan's report is still only carried", () => {
    const assessment = assessRunnerTree(['?? plans/reports/99-earlier.md'], {
      runningPlan: '100-done.md',
    })

    assert.equal(assessment.clean, true)
    assert.deepEqual(assessment.carried, ['plans/reports/99-earlier.md'])
  })

  test('the plans queued behind it stay carried while it blocks', () => {
    const assessment = assessRunnerTree(['?? plans/100-done.md', '?? plans/101-next.md'], {
      runningPlan: '100-done.md',
    })

    assert.deepEqual(assessment.blocking, ['plans/100-done.md'])
    assert.deepEqual(assessment.carried, ['plans/101-next.md'])
  })

  test('once it is committed the plans queued behind it leave the tree clean', () => {
    const assessment = assessRunnerTree(['?? plans/101-next.md'], { runningPlan: '100-done.md' })

    assert.equal(assessment.clean, true)
    assert.deepEqual(assessment.carried, ['plans/101-next.md'])
  })

  test('a script the plan changed but did not commit blocks', () => {
    const assessment = assessRunnerTree([' M scripts/quality-counts.mjs'], {
      runningPlan: '100-done.md',
      pendingScripts: [],
    })

    assert.equal(assessment.clean, false)
    assert.deepEqual(assessment.blocking, ['scripts/quality-counts.mjs'])
  })

  test('a script that was already pending when it started is still carried', () => {
    const assessment = assessRunnerTree([' M scripts/quality-counts.mjs'], {
      runningPlan: '100-done.md',
      pendingScripts: ['scripts/quality-counts.mjs'],
    })

    assert.equal(assessment.clean, true)
    assert.deepEqual(assessment.carried, ['scripts/quality-counts.mjs'])
  })

  test('being pending excuses only the paths named', () => {
    const assessment = assessRunnerTree(
      [' M scripts/quality-counts.mjs', '?? scripts/tidy-up.mjs'],
      { runningPlan: '100-done.md', pendingScripts: ['scripts/quality-counts.mjs'] }
    )

    assert.deepEqual(assessment.blocking, ['scripts/tidy-up.mjs'])
    assert.deepEqual(assessment.carried, ['scripts/quality-counts.mjs'])
  })

  test('a pending path listed the way Windows spells it still matches', () => {
    const assessment = assessRunnerTree([' M scripts/hooks/demo.mjs'], {
      runningPlan: '100-done.md',
      pendingScripts: ['scripts\\hooks\\demo.mjs'],
    })

    assert.equal(assessment.clean, true)
  })

  test('without a pending list every script is carried, as before the plan ran', () => {
    assert.equal(
      assessRunnerTree([' M scripts/quality-counts.mjs'], { runningPlan: '100-done.md' }).clean,
      true
    )
  })

  test("the plan's own file blocks even while its scripts are excused", () => {
    const assessment = assessRunnerTree(['?? plans/100-done.md', ' M scripts/run-plans.ps1'], {
      runningPlan: '100-done.md',
      pendingScripts: ['scripts/run-plans.ps1'],
    })

    assert.deepEqual(assessment.blocking, ['plans/100-done.md'])
    assert.deepEqual(assessment.carried, ['scripts/run-plans.ps1'])
  })
})
