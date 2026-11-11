// Whether a plan's session died on an account rate limit, and when it is worth starting again.
//
// Without this the runner cannot tell a rate limit from a plan that went wrong, and the
// difference is the whole queue. A session refused at the five-hour window exits non-zero after
// about half a second having done nothing at all: no branch work, no commit, a tree holding
// only its own plan file. From the outside that is the same shape as a session that ran and
// failed - so the runner marked it needs-review, tidied up, and fed the next plan into the same
// wall. One exhausted window took eight plans in under a minute and recorded every one of them
// as a plan that had been tried, under a diagnosis ("the work is probably sound - recover it
// from the stash") describing work that was never done.
//
// Two things follow, and this module decides both:
//
//   - A refused session is not an attempt. It earns no verdict, no repair pass and no failure;
//     its plan is still queued.
//   - The window says when it reopens, so the runner can sleep through it and start the same
//     plan again rather than losing the night's queue. The wait is capped, because a seven-day
//     window reopening on Thursday is not something to sleep through, and an account out of
//     credits can reopen to the same refusal.

/** What the CLI reports on the terminal `result` line when the account was refused. */
const RATE_LIMIT_HTTP_STATUS = 429

/**
 * Enough of a line to be worth parsing. The logs are JSONL and run to megabytes - a plan that
 * worked for an hour leaves four - and every line is a complete JSON object on its own, some of
 * them very large. Matching the two shapes as text first keeps this to a parse of the handful
 * that could carry the answer.
 */
const CANDIDATE = /"type"\s*:\s*"(result|rate_limit_event)"|"error"\s*:\s*"rate_limit"/

function parseCandidates(sessionLog) {
  const found = []
  for (const line of String(sessionLog).split(/\r?\n/)) {
    if (line === '' || !CANDIDATE.test(line)) continue
    try { found.push(JSON.parse(line)) }
    // A log read while the session still holds the file ends in half a line. Everything before
    // it still parsed, and the terminal record is not in a line that was cut off anyway.
    catch { /* not a complete record */ }
  }
  return found
}

/**
 * Was this session refused, rather than failed?
 *
 * Only the session's own terminal record answers it. A `rate_limit_event` on its own does not:
 * the CLI emits one whenever the window's utilisation is worth reporting, including on healthy
 * sessions, and treating a warning as a refusal would park the runner in front of a session
 * that was about to run perfectly well.
 */
function wasRefused(records) {
  return records.some((record) =>
    (record.type === 'result' && record.api_error_status === RATE_LIMIT_HTTP_STATUS) ||
    (record.type === 'result' && record.error === 'rate_limit') ||
    (record.error === 'rate_limit' && record.is_api_error_message === true))
}

/** The epoch second a rejected window reopens, from whichever record carries one. */
function readResetsAt(records) {
  const rejected = records
    .filter((record) => record.type === 'rate_limit_event' && record.rate_limit_info?.status === 'rejected')
    .map((record) => record.rate_limit_info)

  for (const info of rejected.reverse()) {
    if (Number.isFinite(info.resetsAt)) return info.resetsAt
    // No top-level resetsAt: take the soonest window that is actually full, since a window
    // under its limit is not what refused this session.
    const spent = Object.values(info.unifiedWindows ?? {})
      .filter((window) => Number.isFinite(window?.resetsAt) && (window.utilization ?? 0) >= 1)
      .map((window) => window.resetsAt)
    if (spent.length > 0) return Math.min(...spent)
  }
  return null
}

/** What the CLI told the session, which is the only text that names the reset in local time. */
function readMessage(records) {
  const terminal = records.filter((record) => record.type === 'result' && typeof record.result === 'string')
  if (terminal.length > 0) return terminal[terminal.length - 1].result
  return null
}

/**
 * Read a session's JSONL log and say whether an account limit ended it.
 *
 * `resetsAt` is null when the stream never said - an older CLI, or a log truncated before the
 * event. The refusal still stands; only the waiting needs the number.
 */
export function readRateLimit(sessionLog) {
  const records = parseCandidates(sessionLog)
  if (!wasRefused(records)) return { limited: false, resetsAt: null, message: null }
  return { limited: true, resetsAt: readResetsAt(records), message: readMessage(records) }
}

/**
 * How long to sleep before starting the same plan again, or why the runner should stop instead.
 *
 * The grace is added rather than trusted away: `resetsAt` is the second the window turns over,
 * and a session started on that second is a session racing the accounting behind it. A window
 * that has already reopened still takes the grace, because the only reason the runner is
 * reading a past `resetsAt` is that something is out of step.
 */
export function resumeDelay(limit, { now, maxWaitSeconds, graceSeconds = 60 }) {
  if (!limit.limited) throw new Error('resumeDelay is for a refused session')
  if (!Number.isFinite(limit.resetsAt)) {
    return { wait: false, reason: 'the session did not say when the window reopens' }
  }

  const seconds = Math.max(limit.resetsAt - now, 0) + graceSeconds
  if (seconds > maxWaitSeconds) {
    return {
      wait: false,
      reason: `the window reopens in ${formatDuration(seconds)}, past the ${formatDuration(maxWaitSeconds)} this run will wait`,
    }
  }
  return { wait: true, seconds, until: now + seconds }
}

/** Whole hours and minutes, for a line a human reads at the top of a log in the morning. */
export function formatDuration(seconds) {
  const whole = Math.max(Math.round(seconds), 0)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.round((whole % 3600) / 60)
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}
