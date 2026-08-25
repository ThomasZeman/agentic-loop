import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import { failingTestIds, ratchetVisualBaseline } from './visual-failures.mjs'

/** Builds the minimum of Playwright's JSON-reporter shape that the reader looks at. */
function spec(title, projectName, status, file = 'dom-qr-dialog.test.ts') {
  return { title, file, tests: [{ projectName, status }] }
}

function report(suites) {
  return { suites, stats: {} }
}

describe('failingTestIds', () => {
  test('reads a failed test as project, file and title', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'dom-qr-dialog.test.ts',
          file: 'dom-qr-dialog.test.ts',
          specs: [spec('dom qr dialog lobby default', 'DPR-1', 'unexpected')],
        },
      ]),
    )
    assert.deepEqual(parsed, ['DPR-1 | dom-qr-dialog.test.ts | dom qr dialog lobby default'])
  })

  test('ignores tests that passed', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'dom-qr-dialog.test.ts',
          file: 'dom-qr-dialog.test.ts',
          specs: [
            spec('lobby default', 'DPR-1', 'unexpected'),
            spec('tt default', 'DPR-1', 'expected'),
          ],
        },
      ]),
    )
    assert.deepEqual(parsed, ['DPR-1 | dom-qr-dialog.test.ts | lobby default'])
  })

  test('a test that passed on retry is flaky, not a failure', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'dom-qr-dialog.test.ts',
          file: 'dom-qr-dialog.test.ts',
          specs: [spec('lobby default', 'DPR-1', 'flaky')],
        },
      ]),
    )
    assert.deepEqual(parsed, [])
  })

  test('a skipped test is not a failure', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'x.test.ts',
          file: 'x.test.ts',
          specs: [spec('skipped one', 'DPR-1', 'skipped', 'x.test.ts')],
        },
      ]),
    )
    assert.deepEqual(parsed, [])
  })

  test('the same spec failing at three DPRs is three distinct ids', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'nine-slice-button.test.ts',
          file: 'nine-slice-button.test.ts',
          specs: [
            {
              title: 'field button',
              file: 'nine-slice-button.test.ts',
              tests: [
                { projectName: 'DPR-1', status: 'unexpected' },
                { projectName: 'DPR-2', status: 'unexpected' },
                { projectName: 'DPR-3', status: 'unexpected' },
              ],
            },
          ],
        },
      ]),
    )
    assert.deepEqual(parsed, [
      'DPR-1 | nine-slice-button.test.ts | field button',
      'DPR-2 | nine-slice-button.test.ts | field button',
      'DPR-3 | nine-slice-button.test.ts | field button',
    ])
  })

  test('descends into describe blocks and prefixes their titles', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'dom-dialog-centering.test.ts',
          file: 'dom-dialog-centering.test.ts',
          specs: [],
          suites: [
            {
              title: 'dom dialog is centred in the stage',
              file: 'dom-dialog-centering.test.ts',
              specs: [spec('room-menu', 'DPR-3', 'unexpected', 'dom-dialog-centering.test.ts')],
            },
          ],
        },
      ]),
    )
    assert.deepEqual(parsed, [
      'DPR-3 | dom-dialog-centering.test.ts | dom dialog is centred in the stage > room-menu',
    ])
  })

  test('spells file paths with forward slashes so ids match across platforms', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'a',
          file: 'tests\\visual\\dom-qr-dialog.test.ts',
          specs: [spec('lobby default', 'DPR-1', 'unexpected', 'tests\\visual\\dom-qr-dialog.test.ts')],
        },
      ]),
    )
    assert.deepEqual(parsed, ['DPR-1 | tests/visual/dom-qr-dialog.test.ts | lobby default'])
  })

  test('ids come back sorted, so two runs compare line for line', () => {
    const parsed = failingTestIds(
      report([
        {
          title: 'b.test.ts',
          file: 'b.test.ts',
          specs: [spec('zulu', 'DPR-2', 'unexpected', 'b.test.ts')],
        },
        {
          title: 'a.test.ts',
          file: 'a.test.ts',
          specs: [spec('alpha', 'DPR-1', 'unexpected', 'a.test.ts')],
        },
      ]),
    )
    assert.deepEqual(parsed, [
      'DPR-1 | a.test.ts | alpha',
      'DPR-2 | b.test.ts | zulu',
    ])
  })

  test('a report with no suites yields no failures rather than throwing', () => {
    assert.deepEqual(failingTestIds({ stats: {} }), [])
  })
})

describe('ratchetVisualBaseline', () => {
  test('a first sighting records the whole set and passes', () => {
    const outcome = ratchetVisualBaseline(null, ['a', 'b'])
    assert.deepEqual(outcome, {
      firstSighting: true,
      newFailures: [],
      fixed: [],
      nextBaseline: ['a', 'b'],
    })
  })

  test('the same failures as the baseline pass and change nothing', () => {
    const outcome = ratchetVisualBaseline(['a', 'b'], ['b', 'a'])
    assert.equal(outcome.firstSighting, false)
    assert.deepEqual(outcome.newFailures, [])
    assert.deepEqual(outcome.fixed, [])
    assert.deepEqual(outcome.nextBaseline, ['a', 'b'])
  })

  test('a failure the baseline does not know about is reported as new', () => {
    const outcome = ratchetVisualBaseline(['a'], ['a', 'b'])
    assert.deepEqual(outcome.newFailures, ['b'])
  })

  test('a new failure leaves the baseline alone, so the next plan is judged the same way', () => {
    const outcome = ratchetVisualBaseline(['a'], ['a', 'b'])
    assert.deepEqual(outcome.nextBaseline, ['a'])
  })

  test('a baseline failure that now passes is dropped, locking the fix in', () => {
    const outcome = ratchetVisualBaseline(['a', 'b'], ['a'])
    assert.deepEqual(outcome.fixed, ['b'])
    assert.deepEqual(outcome.nextBaseline, ['a'])
  })

  test('fixing one test while breaking another still fails, and keeps the fix', () => {
    const outcome = ratchetVisualBaseline(['a', 'b'], ['a', 'c'])
    assert.deepEqual(outcome.newFailures, ['c'])
    assert.deepEqual(outcome.fixed, ['b'])
    // 'b' is banked; 'c' is not excused. The next plan starts from ['a'].
    assert.deepEqual(outcome.nextBaseline, ['a'])
  })

  test('an all-green run empties the baseline', () => {
    const outcome = ratchetVisualBaseline(['a', 'b'], [])
    assert.deepEqual(outcome.fixed, ['a', 'b'])
    assert.deepEqual(outcome.nextBaseline, [])
  })
})
