import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { formatDuration, readRateLimit, resumeDelay } from './rate-limit.mjs'

const CLI = fileURLToPath(new URL('./rate-limit-cli.mjs', import.meta.url))

/** The second the five-hour window in the fixtures below reopens. */
const RESETS_AT = 1790191200

/** The shapes are the ones the CLI actually wrote the night this was found, cut to the fields read here. */
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' })

const REJECTED_EVENT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: RESETS_AT,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    unifiedWindows: {
      five_hour: { utilization: 1.02, resetsAt: RESETS_AT },
      seven_day: { utilization: 0.37, resetsAt: 1790481600 },
    },
  },
})

const REFUSED_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  terminal_reason: 'api_error',
  num_turns: 1,
  duration_ms: 601,
  result: "You've hit your session limit · resets 5:20am (Australia/Sydney)",
})

const REFUSED = [INIT, REJECTED_EVENT, REFUSED_RESULT].join('\n') + '\n'

/** A session that ran and failed its own way: no refusal anywhere in it. */
const ORDINARY_FAILURE = [
  INIT,
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'the suite is red' }),
].join('\n') + '\n'

describe('readRateLimit', () => {
  test('a session the account refused is read as limited, with its window and its message', () => {
    const limit = readRateLimit(REFUSED)
    assert.equal(limit.limited, true)
    assert.equal(limit.resetsAt, RESETS_AT)
    assert.match(limit.message, /session limit/)
  })

  test('a session that ran and failed is not a rate limit', () => {
    assert.equal(readRateLimit(ORDINARY_FAILURE).limited, false)
  })

  test('an empty log is not a rate limit', () => {
    assert.equal(readRateLimit('').limited, false)
  })

  // The CLI reports the window's utilisation on healthy sessions too. Reading one of those as a
  // refusal would park the runner for hours in front of a plan that was about to run.
  test('a window reported but not rejected is not a rate limit', () => {
    const warned = [
      INIT,
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: RESETS_AT, unifiedWindows: { five_hour: { utilization: 0.8, resetsAt: RESETS_AT } } },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'committed' }),
    ].join('\n') + '\n'
    assert.equal(readRateLimit(warned).limited, false)
  })

  test('a refusal with no top-level resetsAt takes the soonest window that is actually full', () => {
    const noTopLevel = [
      INIT,
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          unifiedWindows: {
            seven_day: { utilization: 1.01, resetsAt: 1790481600 },
            five_hour: { utilization: 1.02, resetsAt: RESETS_AT },
          },
        },
      }),
      REFUSED_RESULT,
    ].join('\n') + '\n'
    assert.equal(readRateLimit(noTopLevel).resetsAt, RESETS_AT)
  })

  test('a window under its limit is not taken as the one that refused the session', () => {
    const onlyHealthyWindows = [
      INIT,
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', unifiedWindows: { seven_day: { utilization: 0.37, resetsAt: 1790481600 } } },
      }),
      REFUSED_RESULT,
    ].join('\n') + '\n'
    assert.equal(readRateLimit(onlyHealthyWindows).resetsAt, null)
  })

  test('the refusal still reads when only the terminal record carries it', () => {
    const noEvent = [INIT, REFUSED_RESULT].join('\n') + '\n'
    const limit = readRateLimit(noEvent)
    assert.equal(limit.limited, true)
    assert.equal(limit.resetsAt, null)
  })

  // A log read while the session still holds the file ends mid-line.
  test('a log cut off mid-line still reads the records before the cut', () => {
    assert.equal(readRateLimit(REFUSED + '{"type":"result","api_er').limited, true)
  })
})

describe('resumeDelay', () => {
  const limit = { limited: true, resetsAt: RESETS_AT, message: 'limited' }

  test('waits until the window reopens, plus a grace', () => {
    const delay = resumeDelay(limit, { now: RESETS_AT - 3600, maxWaitSeconds: 6 * 3600 })
    assert.deepEqual(delay, { wait: true, seconds: 3660, until: RESETS_AT + 60 })
  })

  test('a window further off than this run will wait stops the queue instead', () => {
    const delay = resumeDelay(limit, { now: RESETS_AT - 20 * 3600, maxWaitSeconds: 6 * 3600 })
    assert.equal(delay.wait, false)
    assert.match(delay.reason, /past the 6 h this run will wait/)
  })

  // Only reached when something is out of step - but a session started on the turnover second
  // races the accounting behind it, so the grace is still taken.
  test('a window that has already reopened still takes the grace', () => {
    const delay = resumeDelay(limit, { now: RESETS_AT + 500, maxWaitSeconds: 6 * 3600 })
    assert.deepEqual(delay, { wait: true, seconds: 60, until: RESETS_AT + 560 })
  })

  test('a refusal that never said when it reopens stops the queue', () => {
    const delay = resumeDelay({ limited: true, resetsAt: null }, { now: RESETS_AT, maxWaitSeconds: 6 * 3600 })
    assert.equal(delay.wait, false)
    assert.match(delay.reason, /did not say when/)
  })
})

describe('formatDuration', () => {
  test('reads as a human would say it', () => {
    assert.equal(formatDuration(0), '0 min')
    assert.equal(formatDuration(3660), '1 h 1 min')
    assert.equal(formatDuration(7200), '2 h')
    assert.equal(formatDuration(90), '2 min')
  })
})

describe('rate-limit-cli', () => {
  function inspect(sessionLog, args = []) {
    const dir = mkdtempSync(join(tmpdir(), 'rate-limit-'))
    try {
      const logFile = join(dir, 'session.jsonl')
      writeFileSync(logFile, sessionLog, 'utf8')
      const run = spawnSync(process.execPath, [CLI, 'inspect', '--log-file', logFile, ...args], { encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      return JSON.parse(run.stdout)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }

  test('answers a refused session with the wait it wants', () => {
    const answer = inspect(REFUSED, ['--now', String(RESETS_AT - 600), '--max-wait-minutes', '360'])
    assert.equal(answer.limited, true)
    assert.equal(answer.wait, true)
    assert.equal(answer.waitSeconds, 660)
    assert.match(answer.message, /session limit/)
  })

  test('answers a refused session past the cap with the reason not to wait', () => {
    const answer = inspect(REFUSED, ['--now', String(RESETS_AT - 20 * 3600), '--max-wait-minutes', '360'])
    assert.equal(answer.limited, true)
    assert.equal(answer.wait, false)
    assert.match(answer.reason, /past the 6 h/)
  })

  test('answers an ordinary failure with no rate limit at all', () => {
    assert.deepEqual(inspect(ORDINARY_FAILURE), { limited: false, wait: false })
  })

  // The safe direction to be wrong in: a plan whose log is missing fails the ordinary way
  // rather than parking the queue in front of a limit nobody reported.
  test('a log that is not there is not a rate limit', () => {
    const run = spawnSync(process.execPath, [CLI, 'inspect', '--log-file', join(tmpdir(), 'no-such-session.jsonl')], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { limited: false, wait: false })
  })

  test('a log of four megabytes is read without parsing all of it', () => {
    const filler = JSON.stringify({ type: 'tool_progress', heartbeat: true, blob: 'x'.repeat(4000) })
    const heavy = [INIT, ...Array(1000).fill(filler), REJECTED_EVENT, REFUSED_RESULT].join('\n') + '\n'
    assert.equal(inspect(heavy, ['--now', String(RESETS_AT - 600)]).wait, true)
  })
})
