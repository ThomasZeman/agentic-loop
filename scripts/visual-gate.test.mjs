import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import { decideVisualGate, readVisualGateDeclaration } from './visual-gate.mjs'

const ALWAYS = ['.tsx', '.css', 'tests/visual/', 'assets/']

describe('readVisualGateDeclaration', () => {
  test('a plan that says nothing has not opted out', () => {
    assert.deepEqual(readVisualGateDeclaration('## Browser check\n\nRun the sweep.\n'), {
      declared: false,
      reason: null,
    })
  })

  test('the bold template line opts out and keeps its reason', () => {
    const plan = '## Browser check\n\n**Visual gate:** none — the diff is a frame-dispatch rewrite; no screen renders differently.\n'
    assert.deepEqual(readVisualGateDeclaration(plan), {
      declared: true,
      reason: 'the diff is a frame-dispatch rewrite; no screen renders differently.',
    })
  })

  test('plain and hyphenated spellings are accepted too', () => {
    assert.equal(readVisualGateDeclaration('Visual gate: none - logic only').declared, true)
    assert.equal(readVisualGateDeclaration('- **Visual gate**: none').declared, true)
  })

  test('a reason is optional', () => {
    assert.deepEqual(readVisualGateDeclaration('**Visual gate:** none'), { declared: true, reason: null })
  })

  test('only "none" opts out; any other value keeps the gate', () => {
    assert.equal(readVisualGateDeclaration('**Visual gate:** full sweep').declared, false)
    assert.equal(readVisualGateDeclaration('**Visual gate:** nonetheless run it').declared, false)
  })

  test('the word inside prose does not count as a declaration', () => {
    assert.equal(readVisualGateDeclaration('The visual gate: none of the specs cover this.').declared, false)
  })
})

describe('decideVisualGate', () => {
  test('with no declaration the sweep runs', () => {
    const verdict = decideVisualGate({
      declaration: { declared: false, reason: null },
      changedFiles: ['packages/web/src/net.ts'],
      alwaysFor: ALWAYS,
    })
    assert.equal(verdict.run, true)
    assert.match(verdict.why, /does not opt out/)
  })

  test('a declared opt-out over a diff of plain logic files skips the sweep', () => {
    const verdict = decideVisualGate({
      declaration: { declared: true, reason: 'logic only' },
      changedFiles: ['packages/web/src/net.ts', 'packages/web/src/net.test.ts', 'docs/log.md'],
      alwaysFor: ALWAYS,
    })
    assert.equal(verdict.run, false)
    assert.equal(verdict.why, 'the plan declares `Visual gate: none` (logic only) and the diff touches nothing on the always-sweep list')
  })

  test('an extension on the always-sweep list overrides the declaration', () => {
    const verdict = decideVisualGate({
      declaration: { declared: true, reason: null },
      changedFiles: ['packages/web/src/net.ts', 'packages/web/src/board.tsx'],
      alwaysFor: ALWAYS,
    })
    assert.equal(verdict.run, true)
    assert.equal(verdict.why, "the plan declares `Visual gate: none` but changed 'packages/web/src/board.tsx', which matches '.tsx'")
  })

  test('a directory on the always-sweep list overrides the declaration', () => {
    const verdict = decideVisualGate({
      declaration: { declared: true, reason: null },
      changedFiles: ['packages/web/tests/visual/dom-lobby.test.ts'],
      alwaysFor: ALWAYS,
    })
    assert.equal(verdict.run, true)
    assert.match(verdict.why, /matches 'tests\/visual\/'/)
  })

  test('directory patterns match path segments, not substrings of names', () => {
    const verdict = decideVisualGate({
      declaration: { declared: true, reason: null },
      changedFiles: ['packages/web/src/my-assets/index.ts'],
      alwaysFor: ['assets/'],
    })
    assert.equal(verdict.run, false)
  })

  test('backslash paths are normalised before matching', () => {
    const verdict = decideVisualGate({
      declaration: { declared: true, reason: null },
      changedFiles: ['packages\\web\\assets\\logo.svg'],
      alwaysFor: ['assets/'],
    })
    assert.equal(verdict.run, true)
  })

  test('an empty always-sweep list leaves the decision to the plan alone', () => {
    const verdict = decideVisualGate({
      declaration: { declared: true, reason: null },
      changedFiles: ['packages/web/src/board.tsx'],
      alwaysFor: [],
    })
    assert.equal(verdict.run, false)
  })
})
