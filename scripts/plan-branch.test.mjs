import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import {
  chooseBranchName,
  conflictMarkerLines,
  conflictedPaths,
  planBranchName,
} from './plan-branch.mjs'

describe('planBranchName', () => {
  test('names the branch after the plan, without the extension', () => {
    assert.equal(planBranchName('142-signup-deadline.md'), 'plan/142-signup-deadline')
  })

  test('takes the prefix it is given, including none', () => {
    assert.equal(planBranchName('142-a-thing.md', { prefix: '' }), '142-a-thing')
    assert.equal(planBranchName('142-a-thing.md', { prefix: 'wip/' }), 'wip/142-a-thing')
  })

  test('adds the separator a prefix forgot', () => {
    assert.equal(planBranchName('142-a-thing.md', { prefix: 'wip' }), 'wip/142-a-thing')
  })

  // git check-ref-format rejects these outright, and a plan file written by hand can carry any
  // of them. A refused checkout would fail the plan for its file name rather than its content.
  test('replaces the characters git refuses in a ref', () => {
    assert.equal(planBranchName('7 my plan: draft?.md'), 'plan/7-my-plan-draft')
    assert.equal(planBranchName('7~a^b[c].md'), 'plan/7-a-b-c')
    assert.equal(planBranchName('7-back\\slash.md'), 'plan/7-back-slash')
  })

  test('leaves no doubled dot, trailing dot, or .lock ending for git to reject', () => {
    assert.equal(planBranchName('7-a..b.md'), 'plan/7-a-b')
    assert.equal(planBranchName('7-trailing..md'), 'plan/7-trailing')
    assert.equal(planBranchName('7-a.lock.md'), 'plan/7-a-lock')
  })

  test('keeps a plan whose name is only punctuation from becoming an empty ref', () => {
    assert.equal(planBranchName('...md'), 'plan/plan')
  })

  test('only the extension goes, not a dot inside the name', () => {
    assert.equal(planBranchName('7-v1.2-rollout.md'), 'plan/7-v1.2-rollout')
  })
})

describe('chooseBranchName', () => {
  test('takes the name it asked for when nothing holds it', () => {
    assert.equal(chooseBranchName('plan/142-a-thing', ['main', 'plan/7-other']), 'plan/142-a-thing')
  })

  // A re-run of a failed plan meets the branch its last attempt left behind. That branch is the
  // only copy of work nobody has reviewed, so the retry goes beside it rather than over it.
  test('goes around a branch the last attempt left behind', () => {
    assert.equal(chooseBranchName('plan/142-a-thing', ['plan/142-a-thing']), 'plan/142-a-thing-2')
  })

  test('keeps counting past every attempt so far', () => {
    const existing = ['plan/142-a-thing', 'plan/142-a-thing-2', 'plan/142-a-thing-3']

    assert.equal(chooseBranchName('plan/142-a-thing', existing), 'plan/142-a-thing-4')
  })

  test('reads branch names case-insensitively, as Windows git does', () => {
    assert.equal(chooseBranchName('plan/142-A-Thing', ['plan/142-a-thing']), 'plan/142-A-Thing-2')
  })

  test('gives up rather than spin when every candidate is taken', () => {
    const existing = ['plan/7', ...Array.from({ length: 50 }, (_, i) => `plan/7-${i + 2}`)]

    assert.throws(() => chooseBranchName('plan/7', existing), /plan\/7/)
  })
})

describe('conflictedPaths', () => {
  test('finds every unmerged status code git can print', () => {
    const paths = conflictedPaths([
      'UU packages/backend/src/a.ts',
      'AA packages/backend/src/b.ts',
      'DU packages/backend/src/c.ts',
      'UD packages/backend/src/d.ts',
      'AU packages/backend/src/e.ts',
      'UA packages/backend/src/f.ts',
      'DD packages/backend/src/g.ts',
    ])

    assert.equal(paths.length, 7)
    assert.equal(paths[0], 'packages/backend/src/a.ts')
  })

  test('ignores everything the rebase merged on its own', () => {
    assert.deepEqual(
      conflictedPaths(['M  packages/backend/src/a.ts', '?? scratch.txt', ' D old.ts', '', '  ']),
      []
    )
  })

  // 'AU' is unmerged; 'A ' and 'AM' are not. Matching on the first letter alone would report a
  // clean rebase as conflicted and fail every plan that reached one.
  test('does not mistake a plain add for an unmerged one', () => {
    assert.deepEqual(conflictedPaths(['A  plans/142-a-thing.md', 'AM packages/a.ts']), [])
  })

  test('unquotes a path git had to quote', () => {
    assert.deepEqual(conflictedPaths(['UU "packages/backend/a file.ts"']), [
      'packages/backend/a file.ts',
    ])
  })
})

describe('conflictMarkerLines', () => {
  test('finds a marker the resolver left behind, with its line number', () => {
    const text = ['const a = 1', '<<<<<<< HEAD', 'const b = 2', '=======', 'const b = 3', '>>>>>>> theirs'].join('\n')

    assert.deepEqual(conflictMarkerLines(text), [
      { line: 2, text: '<<<<<<< HEAD' },
      { line: 6, text: '>>>>>>> theirs' },
    ])
  })

  test('a resolved file has none', () => {
    assert.deepEqual(conflictMarkerLines('const a = 1\nconst b = 3\n'), [])
  })

  // '=======' underlines a heading in markdown and rules off a section in plenty of comments, so
  // it is not evidence on its own. The two arrow markers are.
  test('does not read a markdown heading underline as a conflict', () => {
    assert.deepEqual(conflictMarkerLines('Title\n=======\n\ntext'), [])
  })

  test('reads markers only at the start of a line', () => {
    assert.deepEqual(conflictMarkerLines('  // <<<<<<< explained in prose'), [])
  })

  test('survives a file with CRLF line endings', () => {
    assert.deepEqual(conflictMarkerLines('a\r\n<<<<<<< HEAD\r\nb\r\n'), [
      { line: 2, text: '<<<<<<< HEAD' },
    ])
  })
})
