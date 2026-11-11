#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls after a session exits non-zero, to ask whether the account
 * was refused and how long the runner should sleep before starting the same plan again.
 *
 *   node scripts/rate-limit-cli.mjs inspect --log-file <path> [--max-wait-minutes N] [--now <epoch>]
 *
 * Answers on stdout as JSON: {limited, resetsAt, message, wait, waitSeconds, reason}. `--now`
 * exists for the tests; left off, it is the clock.
 *
 * Reporting only - the exit code says whether the question could be answered, never what the
 * answer was. A log that cannot be read is not a rate limit: the plan then fails the ordinary
 * way, which is the safe direction to be wrong in.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { readRateLimit, resumeDelay } from './rate-limit.mjs'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'log-file': { type: 'string' },
    'max-wait-minutes': { type: 'string' },
    now: { type: 'string' },
  },
})

function fail(message) {
  console.error(message)
  process.exit(2)
}

if (positionals[0] !== 'inspect') fail('usage: rate-limit-cli.mjs inspect --log-file <path> [--max-wait-minutes N]')
if (!values['log-file']) fail('inspect needs --log-file <path>')

const maxWaitSeconds = Number(values['max-wait-minutes'] ?? 360) * 60
if (!Number.isFinite(maxWaitSeconds) || maxWaitSeconds < 0) fail('--max-wait-minutes must be a non-negative number')
const now = values.now === undefined ? Math.floor(Date.now() / 1000) : Number(values.now)
if (!Number.isFinite(now)) fail('--now must be an epoch second')

// A session killed at its timeout leaves no log at all if it never got going; so does a plan
// whose header was refused. Neither is a rate limit.
let sessionLog = ''
try { sessionLog = readFileSync(values['log-file'], 'utf8') }
catch { sessionLog = '' }

const limit = readRateLimit(sessionLog)
if (!limit.limited) {
  console.log(JSON.stringify({ limited: false, wait: false }))
}
else {
  const delay = resumeDelay(limit, { now, maxWaitSeconds })
  console.log(JSON.stringify({
    limited: true,
    resetsAt: limit.resetsAt,
    message: limit.message,
    wait: delay.wait,
    waitSeconds: delay.wait ? delay.seconds : 0,
    reason: delay.wait ? null : delay.reason,
  }))
}
