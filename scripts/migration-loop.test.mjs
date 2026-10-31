import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import {
  appendOutcome,
  assessorWroteEntry,
  assistantText,
  composePrompt,
  decideNext,
  describeOutcomes,
  newPlanFiles,
  nextTickNumber,
  parseVerdict,
  readOutcomes,
  runLoop,
} from './migration-loop.mjs'

describe('parseVerdict', () => {
  test('reads the plans off a planned verdict, in order, without backticks', () => {
    const verdict = parseVerdict('some prose\nMIGRATION-LOOP: planned `723-a.md`, 724-b.md\n')
    assert.deepEqual(verdict, { kind: 'planned', plans: ['723-a.md', '724-b.md'], reason: null })
  })

  test('the last verdict line wins', () => {
    const verdict = parseVerdict('MIGRATION-LOOP: planned 1-a.md\nlater\nMIGRATION-LOOP: target-reached')
    assert.equal(verdict.kind, 'target-reached')
  })

  test('needs-human carries its reason', () => {
    const verdict = parseVerdict('MIGRATION-LOOP: needs-human Q1 blocks PromptQueue')
    assert.deepEqual(verdict, { kind: 'needs-human', plans: [], reason: 'Q1 blocks PromptQueue' })
  })

  test('no verdict line is none; an unrecognised one is unknown', () => {
    assert.equal(parseVerdict('I ran out of budget').kind, 'none')
    assert.equal(parseVerdict('MIGRATION-LOOP: done').kind, 'unknown')
  })
})

describe('assistantText', () => {
  test('collects assistant text blocks and the final result, skipping tool use and junk', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }, { type: 'tool_use', name: 'Read' }] } }),
      'not json',
      JSON.stringify({ type: 'result', result: 'MIGRATION-LOOP: planned 9-x.md' }),
    ].join('\n')
    assert.equal(assistantText(jsonl), 'first\nMIGRATION-LOOP: planned 9-x.md')
  })
})

describe('composePrompt', () => {
  test('fills every placeholder', () => {
    assert.equal(composePrompt('tick {{TICK}} of {{MAX}}', { TICK: 2, MAX: 3 }), 'tick 2 of 3')
  })

  test('an unfilled placeholder is an error, not a prompt', () => {
    assert.throws(() => composePrompt('{{NOPE}}', {}), /\{\{NOPE\}\}/)
  })
})

describe('describeOutcomes', () => {
  test('says so on the first tick', () => {
    assert.match(describeOutcomes([]), /first tick/)
  })

  test('one line per plan with commit, branch, report and problems', () => {
    const text = describeOutcomes([
      { plan: '1-a.md', status: 'completed', commit: 'abcdef0123456789', branch: null, elapsedMin: 12.5, report: 'plans/reports/1-a.md', problems: [] },
      { plan: '2-b.md', status: 'needs-review', commit: null, branch: 'plan/2-b', elapsedMin: null, report: 'plans/reports/2-b.md', problems: ['tests red'] },
    ])
    assert.match(text, /`1-a\.md`: \*\*completed\*\* \(commit abcdef01, 12\.5 min, report `plans\/reports\/1-a\.md`\)/)
    assert.match(text, /`2-b\.md`: \*\*needs-review\*\* \(branch `plan\/2-b`, report `plans\/reports\/2-b\.md`\); problems: tests red/)
  })
})

describe('newPlanFiles and readOutcomes', () => {
  test('only numbered plan files that were not there before count', () => {
    const before = ['1-old.md', '_template.md']
    const after = ['1-old.md', '_template.md', '3-new.md', '2-newer.md', 'README.md', 'draft-x.md']
    assert.deepEqual(newPlanFiles(before, after), ['2-newer.md', '3-new.md'])
  })

  test('a plan the runner never reached reads as not-run', () => {
    const state = { '2-b.md': { status: 'completed', commit: 'c0ffee', problems: [], elapsedMin: 3 } }
    const outcomes = readOutcomes(state, ['2-b.md', '3-c.md'])
    assert.equal(outcomes[0].status, 'completed')
    assert.equal(outcomes[0].report, 'plans/reports/2-b.md')
    assert.equal(outcomes[1].status, 'not-run')
    assert.equal(outcomes[1].report, null)
  })
})

const LOG = `# Log\n\n## Decisions\n\n| D1 | x |\n\n## Ticks\n\n_No ticks yet._\n`

describe('the log', () => {
  test('the first tick is 1; after ticks 1 and 2 it is 3', () => {
    assert.equal(nextTickNumber(LOG), 1)
    assert.equal(nextTickNumber(`${LOG}\n### Tick 1 — assessed\n\n### Tick 2 — assessed\n`), 3)
  })

  test('the assessor must leave a heading for its tick', () => {
    assert.equal(assessorWroteEntry(LOG, LOG, 1), false)
    assert.equal(assessorWroteEntry(LOG, `${LOG}\n### Tick 2 — assessed\n`, 1), false)
    assert.equal(assessorWroteEntry(LOG, LOG.replace('_No ticks yet._', '### Tick 1 — assessed\n\n**Outcome.**\n'), 1), true)
  })

  test('appendOutcome lands under the right tick, before the next one', () => {
    const log = `## Ticks\n\n### Tick 1 — assessed\n\n**Planned.**\n- a\n\n**Outcome.**\n\n### Tick 2 — assessed\n\n**Outcome.**\n`
    const updated = appendOutcome(log, 1, '- `a`: **completed**')
    const tick1 = updated.slice(0, updated.indexOf('### Tick 2'))
    assert.match(tick1, /\*\*Outcome\.\*\*\n- `a`: \*\*completed\*\*\n/)
    assert.doesNotMatch(updated.slice(updated.indexOf('### Tick 2')), /completed/)
  })

  test('appendOutcome on a tick with no heading adds one at the end rather than losing the text', () => {
    const updated = appendOutcome(LOG, 4, '- nothing')
    assert.match(updated, /### Tick 4\n\n\*\*Outcome\.\*\*\n- nothing\n$/)
  })
})

describe('decideNext', () => {
  test('stops at the cap', () => {
    assert.deepEqual(decideNext({ tick: 2, maxTicks: 2, consecutiveEmptyTicks: 0, maxConsecutiveEmptyTicks: 2 }), {
      again: false,
      reason: 'reached the 2-tick cap',
    })
  })

  test('stops after a run of ticks that shipped nothing', () => {
    const next = decideNext({ tick: 1, maxTicks: 9, consecutiveEmptyTicks: 2, maxConsecutiveEmptyTicks: 2 })
    assert.equal(next.again, false)
    assert.match(next.reason, /2 ticks in a row/)
  })

  test('otherwise goes on', () => {
    assert.equal(decideNext({ tick: 1, maxTicks: 9, consecutiveEmptyTicks: 1, maxConsecutiveEmptyTicks: 2 }).again, true)
  })
})

// --------------------------------------------------------------------------
// runLoop with a fake world
// --------------------------------------------------------------------------

/**
 * A world the loop can act on without a process or a disk. `script` is what the fake assessor
 * does per tick: the plan files it drops, the verdict it ends with, whether it writes its entry,
 * and what the fake runner then records about each plan.
 */
function fakeWorld(script, { log = LOG } = {}) {
  const world = { log, plans: ['_template.md'], state: {}, commits: [], said: [], runs: [], slept: [], dirty: [] }
  let call = 0
  const deps = {
    readLog: () => world.log,
    writeLog: (text) => { world.log = text },
    listPlans: () => [...world.plans],
    dirtyPaths: () => [...world.dirty],
    commitLog: (message) => world.commits.push(message),
    readState: () => world.state,
    now: () => '2026-11-01T10:00:00Z',
    sleep: async (seconds) => { world.slept.push(seconds) },
    say: (line) => world.said.push(line),
    logPath: 'docs/log.md',
    async assess({ tick }) {
      const step = script[Math.min(call, script.length - 1)]
      call += 1
      if (step.limited) return { transcript: '', limited: true, waitSeconds: step.waitSeconds ?? null }
      for (const plan of step.plans ?? []) world.plans.push(plan)
      if (step.entry !== false) {
        world.log = world.log.replace('_No ticks yet._', '').trimEnd() + `\n\n### Tick ${tick} — assessed\n\n**Outcome.**\n`
      }
      if (step.dirty) world.dirty.push(...step.dirty)
      const transcript = JSON.stringify({ type: 'result', result: `MIGRATION-LOOP: ${step.verdict}` })
      return { transcript, limited: false }
    },
    async runPlans(planFiles) {
      world.runs.push(planFiles)
      const step = script[Math.min(call - 1, script.length - 1)]
      for (const plan of planFiles) {
        const status = step.results?.[plan] ?? 'completed'
        if (status !== 'not-run') world.state[plan] = { status, commit: status === 'completed' ? 'abc123' : null, problems: [] }
      }
      return 0
    },
  }
  return { world, deps }
}

describe('runLoop', () => {
  test('a planned tick runs its plans, records the outcome and commits twice', async () => {
    const { world, deps } = fakeWorld([{ plans: ['10-a.md', '11-b.md'], verdict: 'planned 10-a.md, 11-b.md' }])
    const result = await runLoop(deps, { maxTicks: 1, logPath: 'docs/log.md' })

    assert.deepEqual(world.runs, [['10-a.md', '11-b.md']])
    assert.deepEqual(world.commits, ['migration loop: tick 1 assessed (planned)', 'migration loop: tick 1 ran (2/2 completed)'])
    assert.match(world.log, /### Tick 1 — assessed\n\n\*\*Outcome\.\*\*\n- `10-a\.md`: \*\*completed\*\* \(commit abc123, report `plans\/reports\/10-a\.md`\)\n- `11-b\.md`/)
    assert.match(world.log, /- run finished 2026-11-01T10:00:00Z/)
    assert.equal(result.reason, 'reached the 1-tick cap')
    assert.equal(result.ticks[0].outcomes.length, 2)
  })

  test('the next tick is told what the last one did', async () => {
    const { world, deps } = fakeWorld([
      { plans: ['10-a.md'], verdict: 'planned 10-a.md', results: { '10-a.md': 'needs-review' } },
      { plans: ['11-b.md'], verdict: 'planned 11-b.md' },
    ])
    const seen = []
    const assess = deps.assess
    deps.assess = async (input) => { seen.push(input.lastOutcomes); return assess(input) }
    await runLoop(deps, { maxTicks: 2, logPath: 'docs/log.md' })

    assert.deepEqual(seen[0], [])
    assert.equal(seen[1][0].plan, '10-a.md')
    assert.equal(seen[1][0].status, 'needs-review')
    assert.equal(nextTickNumber(world.log), 3)
  })

  test('target-reached commits the entry and stops without running anything', async () => {
    const { world, deps } = fakeWorld([{ verdict: 'target-reached' }])
    const result = await runLoop(deps, { maxTicks: 5, logPath: 'docs/log.md' })

    assert.deepEqual(world.runs, [])
    assert.deepEqual(world.commits, ['migration loop: tick 1 assessed (target-reached)'])
    assert.equal(result.reason, 'the assessor reports the target reached')
  })

  test('needs-human stops with the reason', async () => {
    const { deps } = fakeWorld([{ verdict: 'needs-human Q1 is open' }])
    const result = await runLoop(deps, { maxTicks: 5, logPath: 'docs/log.md' })
    assert.equal(result.reason, 'needs a human: Q1 is open')
  })

  test('a verdict naming a plan that was never written stops the loop', async () => {
    const { world, deps } = fakeWorld([{ plans: ['10-a.md'], verdict: 'planned 10-a.md, 12-ghost.md' }])
    const result = await runLoop(deps, { maxTicks: 5, logPath: 'docs/log.md' })
    assert.deepEqual(world.runs, [])
    assert.match(result.reason, /12-ghost\.md/)
  })

  test('an assessor that touched other files stops the loop before anything is committed', async () => {
    const { world, deps } = fakeWorld([{ plans: ['10-a.md'], verdict: 'planned 10-a.md', dirty: ['docs/log.md', 'plans/10-a.md', 'src/app.ts'] }])
    const result = await runLoop(deps, { maxTicks: 5, logPath: 'docs/log.md' })
    assert.deepEqual(world.commits, [])
    assert.match(result.reason, /src\/app\.ts/)
    assert.doesNotMatch(result.reason, /docs\/log\.md|plans\/10-a\.md/)
  })

  test('an assessor with no verdict gets a note in the log and the loop stops', async () => {
    const { world, deps } = fakeWorld([{ verdict: '', entry: false }])
    const result = await runLoop(deps, { maxTicks: 5, logPath: 'docs/log.md' })
    assert.match(world.log, /### Tick 1\n\n\*\*Outcome\.\*\*\n- the assessor wrote no tick entry; verdict: unknown/)
    assert.match(result.reason, /no usable verdict/)
  })

  test('a dry run queues the plans and never starts the runner', async () => {
    const { world, deps } = fakeWorld([{ plans: ['10-a.md'], verdict: 'planned 10-a.md' }])
    const result = await runLoop(deps, { maxTicks: 5, dryRun: true, logPath: 'docs/log.md' })
    assert.deepEqual(world.runs, [])
    assert.deepEqual(result.ticks[0].plans, ['10-a.md'])
    assert.match(result.reason, /dry run/)
  })

  test('a refused assessor sleeps the window out and the same tick is tried again', async () => {
    const { world, deps } = fakeWorld([
      { limited: true, waitSeconds: 900 },
      { plans: ['10-a.md'], verdict: 'planned 10-a.md' },
    ])
    const result = await runLoop(deps, { maxTicks: 1, logPath: 'docs/log.md' })
    assert.deepEqual(world.slept, [900])
    assert.deepEqual(world.runs, [['10-a.md']])
    assert.equal(result.ticks.length, 1)
  })

  test('a refusal with no reopening time stops rather than guesses', async () => {
    const { deps } = fakeWorld([{ limited: true }])
    const result = await runLoop(deps, { maxTicks: 1, logPath: 'docs/log.md' })
    assert.match(result.reason, /did not say when/)
  })

  test('two ticks in a row that ship nothing stop the loop', async () => {
    const { world, deps } = fakeWorld([
      { plans: ['10-a.md'], verdict: 'planned 10-a.md', results: { '10-a.md': 'needs-review' } },
      { plans: ['11-b.md'], verdict: 'planned 11-b.md', results: { '11-b.md': 'needs-review' } },
      { plans: ['12-c.md'], verdict: 'planned 12-c.md' },
    ])
    const result = await runLoop(deps, { maxTicks: 9, logPath: 'docs/log.md' })
    assert.equal(world.runs.length, 2)
    assert.match(result.reason, /2 ticks in a row shipped nothing/)
  })
})
