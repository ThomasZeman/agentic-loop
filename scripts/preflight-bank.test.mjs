import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import { decideBank, decideVisualReuse } from './preflight-bank.mjs'

const CLOSURE = { 'frontend-boardfest': ['frontend-boardfest', 'frontend-shared', 'shared'] }
const VISUAL_PACKAGES = ['frontend-boardfest']

const bankAt = (commit, failures) => ({ commit, visual: { 'frontend-boardfest': failures } })

const bankFor = (options) =>
  decideBank(options.previousBank ?? null, {
    commit: options.commit,
    from: options.from ?? null,
    changedPackages: options.changedPackages ?? [],
    visualPackages: VISUAL_PACKAGES,
    closure: CLOSURE,
    measured: options.measured ?? {},
  })

describe('decideVisualReuse', () => {
  test('reuses the set banked for the commit the base branch sits on', () => {
    const answer = decideVisualReuse(bankAt('c0ffee', ['lobby.spec.ts:12']), 'c0ffee')

    assert.equal(answer.reuse, true)
    assert.deepEqual(answer.visual, { 'frontend-boardfest': ['lobby.spec.ts:12'] })
  })

  test('refuses a set banked for some other commit', () => {
    const answer = decideVisualReuse(bankAt('c0ffee', ['lobby.spec.ts:12']), 'deadbee')

    assert.equal(answer.reuse, false)
    assert.deepEqual(answer.visual, {})
  })

  test('refuses when nothing has been banked', () => {
    assert.deepEqual(decideVisualReuse(null, 'c0ffee'), { reuse: false, visual: {} })
  })

  test('refuses a record that names a commit but measured nothing', () => {
    assert.equal(decideVisualReuse({ commit: 'c0ffee', visual: {} }, 'c0ffee').reuse, false)
  })

  test('a package banked green is reused as green, not as unmeasured', () => {
    const answer = decideVisualReuse(bankAt('c0ffee', []), 'c0ffee')

    assert.equal(answer.reuse, true)
    assert.deepEqual(answer.visual, { 'frontend-boardfest': [] })
  })
})

describe('decideBank, after a plan fast-forwards the base branch', () => {
  test('records the set the plan\'s own sweep measured', () => {
    const record = bankFor({
      previousBank: bankAt('c0ffee', ['lobby.spec.ts:12']),
      from: 'c0ffee',
      commit: 'deadbee',
      changedPackages: ['frontend-boardfest'],
      measured: { 'frontend-boardfest': ['lobby.spec.ts:12', 'menu.spec.ts:4'] },
    })

    assert.deepEqual(record, {
      commit: 'deadbee',
      visual: { 'frontend-boardfest': ['lobby.spec.ts:12', 'menu.spec.ts:4'] },
    })
  })

  test('a measurement is banked even when nothing was banked before', () => {
    const record = bankFor({
      commit: 'deadbee',
      changedPackages: ['frontend-boardfest'],
      measured: { 'frontend-boardfest': [] },
    })

    assert.deepEqual(record, { commit: 'deadbee', visual: { 'frontend-boardfest': [] } })
  })

  test('carries the previous set over a plan that touched nothing in the closure', () => {
    const record = bankFor({
      previousBank: bankAt('c0ffee', ['lobby.spec.ts:12']),
      from: 'c0ffee',
      commit: 'deadbee',
      changedPackages: ['backend'],
    })

    assert.deepEqual(record, {
      commit: 'deadbee',
      visual: { 'frontend-boardfest': ['lobby.spec.ts:12'] },
    })
  })

  test('clears when a plan changed the closure without sweeping it', () => {
    for (const changed of [['shared'], ['frontend-shared'], ['frontend-boardfest']]) {
      const record = bankFor({
        previousBank: bankAt('c0ffee', ['lobby.spec.ts:12']),
        from: 'c0ffee',
        commit: 'deadbee',
        changedPackages: changed,
      })

      assert.equal(record, null, `changing ${changed[0]} unmeasured must clear the bank`)
    }
  })

  test('stays cleared when the next plan touches nothing in the closure', () => {
    const record = bankFor({
      previousBank: null,
      from: 'c0ffee',
      commit: 'deadbee',
      changedPackages: ['backend'],
    })

    assert.equal(record, null)
  })

  test('refuses to carry a set measured on a tree the plan did not branch from', () => {
    const record = bankFor({
      previousBank: bankAt('c0ffee', ['lobby.spec.ts:12']),
      from: 'a11ce',
      commit: 'deadbee',
      changedPackages: ['backend'],
    })

    assert.equal(record, null)
  })

  test('a fresh measurement outweighs a previous bank the plan did not branch from', () => {
    const record = bankFor({
      previousBank: bankAt('c0ffee', ['lobby.spec.ts:12']),
      from: 'a11ce',
      commit: 'deadbee',
      changedPackages: ['frontend-boardfest'],
      measured: { 'frontend-boardfest': ['menu.spec.ts:4'] },
    })

    assert.deepEqual(record, {
      commit: 'deadbee',
      visual: { 'frontend-boardfest': ['menu.spec.ts:4'] },
    })
  })

  test('banks nothing when no package has a visual suite to measure', () => {
    const record = decideBank(null, {
      commit: 'deadbee',
      from: 'c0ffee',
      changedPackages: ['backend'],
      visualPackages: [],
      closure: {},
      measured: {},
    })

    assert.equal(record, null)
  })

  test('banks nothing when the fast-forward produced no commit to name', () => {
    assert.equal(bankFor({ commit: null, measured: { 'frontend-boardfest': [] } }), null)
  })

  test('every visual package must be accounted for, not just the one that ran', () => {
    const record = decideBank(bankAt('c0ffee', ['lobby.spec.ts:12']), {
      commit: 'deadbee',
      from: 'c0ffee',
      changedPackages: ['frontend-boardfest', 'frontend-original'],
      visualPackages: ['frontend-boardfest', 'frontend-original'],
      closure: { ...CLOSURE, 'frontend-original': ['frontend-original', 'shared'] },
      measured: { 'frontend-boardfest': [] },
    })

    assert.equal(record, null)
  })

  test('the record it writes is not the previous bank\'s array', () => {
    const previous = bankAt('c0ffee', ['lobby.spec.ts:12'])
    const record = bankFor({
      previousBank: previous,
      from: 'c0ffee',
      commit: 'deadbee',
      changedPackages: ['backend'],
    })

    record.visual['frontend-boardfest'].push('menu.spec.ts:4')
    assert.deepEqual(previous.visual['frontend-boardfest'], ['lobby.spec.ts:12'])
  })
})
