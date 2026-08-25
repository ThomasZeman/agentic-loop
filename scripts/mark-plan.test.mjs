import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import { MARKABLE_STATUSES, markPlanStatus } from './mark-plan.mjs'

const NOW = '2026-08-15T09:00:00.000Z'

function stateWith(entry) {
  return { '242-a-thing.md': entry }
}

describe('markPlanStatus', () => {
  test('sets the status and stamps when it was settled', () => {
    const next = markPlanStatus(stateWith({ status: 'needs-review' }), '242-a-thing.md', 'wont-do', 'abandoned', NOW)
    assert.equal(next['242-a-thing.md'].status, 'wont-do')
    assert.equal(next['242-a-thing.md'].finishedAt, NOW)
  })

  test('records the reason where the runner already writes its problems', () => {
    const next = markPlanStatus(stateWith({ status: 'needs-review' }), '242-a-thing.md', 'wont-do', 'gate was broken', NOW)
    assert.deepEqual(next['242-a-thing.md'].problems, ['wont-do: gate was broken'])
  })

  test('a wont-do plan keeps no commit or branch, because neither survives it', () => {
    const before = stateWith({ status: 'needs-review', commit: '7ecbb5cd', branch: 'plan/242-a-thing' })
    const next = markPlanStatus(before, '242-a-thing.md', 'wont-do', 'abandoned', NOW)
    assert.equal(next['242-a-thing.md'].commit, null)
    assert.equal(next['242-a-thing.md'].branch, null)
  })

  test('marking completed leaves the commit alone - that one did land', () => {
    const before = stateWith({ status: 'needs-review', commit: '7ecbb5cd', branch: 'plan/242-a-thing' })
    const next = markPlanStatus(before, '242-a-thing.md', 'completed', 'merged by hand', NOW)
    assert.equal(next['242-a-thing.md'].commit, '7ecbb5cd')
  })

  test('other fields on the entry survive untouched', () => {
    const before = stateWith({ status: 'needs-review', log: '242.jsonl', elapsedMin: 24.1 })
    const next = markPlanStatus(before, '242-a-thing.md', 'wont-do', 'abandoned', NOW)
    assert.equal(next['242-a-thing.md'].log, '242.jsonl')
    assert.equal(next['242-a-thing.md'].elapsedMin, 24.1)
  })

  test('other plans are left exactly as they were', () => {
    const before = { '242-a.md': { status: 'needs-review' }, '243-b.md': { status: 'completed', commit: 'abc' } }
    const next = markPlanStatus(before, '242-a.md', 'wont-do', 'abandoned', NOW)
    assert.deepEqual(next['243-b.md'], { status: 'completed', commit: 'abc' })
  })

  test('does not mutate the state it was given', () => {
    const before = stateWith({ status: 'needs-review' })
    markPlanStatus(before, '242-a-thing.md', 'wont-do', 'abandoned', NOW)
    assert.equal(before['242-a-thing.md'].status, 'needs-review')
  })

  test('a plan the runner has never seen can still be marked', () => {
    const next = markPlanStatus({}, '999-never-ran.md', 'wont-do', 'changed our mind', NOW)
    assert.equal(next['999-never-ran.md'].status, 'wont-do')
    assert.equal(next['999-never-ran.md'].commit, null)
  })

  test('refuses a status the runner does not understand', () => {
    assert.throws(
      () => markPlanStatus(stateWith({ status: 'needs-review' }), '242-a-thing.md', 'donezo', 'x', NOW),
      /donezo/,
    )
  })

  test('refuses to invent a status silently by leaving it empty', () => {
    assert.throws(() => markPlanStatus(stateWith({}), '242-a-thing.md', '', 'x', NOW), /status/)
  })

  test('the markable statuses are the two a human ever needs to set by hand', () => {
    assert.deepEqual(MARKABLE_STATUSES, ['completed', 'wont-do'])
  })
})
