// Which plans the queue is finished with - from both records of it, not just the local one.
//
// `plans/.state.json` is gitignored, so it never leaves the machine that wrote it. Stand a
// second runner up with a plain clone (scripts/vm/provision-runner-guest.ps1 does exactly
// that) and it starts with an empty ledger: every plan file on disk reads as unfinished and
// the queue sets about re-implementing years of shipped work.
//
// Git already holds the durable half of that record. A queued plan file is untracked - the
// plan that implements it commits its own file, per the preamble's §5 - so a plan file that
// is *tracked* was committed by the plan that implemented it, and there is no other way for
// it to have got there. That makes "tracked" a settled record every clone shares.
//
// It beats a `needs-review` entry (see settledPlanNames) rather than losing to it: a failed
// plan's file is deliberately put back on disk untracked so the queue can retry it, so a
// tracked file cannot coexist with unfinished work.
//
// The one thing git cannot record is a `wont-do` plan, abandoned before any commit existed
// to carry its file. That stays local to `.state.json`, and the practice that covers it -
// delete the abandoned file from disk - is written down in plans/README.md.

const PLANS_PREFIX = 'plans/'

/** The two statuses that take a plan out of the queue for good. Mirrors run-plans.ps1. */
const SETTLED_STATUSES = ['completed', 'wont-do']

/** run-plans.ps1's own discovery pattern (Get-PlanNumber). It must not drift from this. */
const PLAN_FILE_NAME = /^\d+[-_]/

/**
 * Whether a path *inside* the plans directory is a plan rather than something else there.
 *
 * Only files sitting directly in it count. `reports/07-thing.md` is a report of a plan, not
 * the plan, and a plan whose report landed on the base branch after a failure is exactly the
 * plan that must be retried.
 *
 * The filtering happens here rather than in the pathspec because git's matcher has no
 * FNM_PATHNAME: `*` crosses `/`, so `git ls-files 'plans/*.md'` also returns every report.
 */
function isPlanFileName(name) {
  return !name.includes('/') && PLAN_FILE_NAME.test(name)
}

/** The plan file name a repo-root-relative tracked path names, or null when it names something else. */
function planNameOf(trackedPath) {
  const path = trackedPath.replace(/\\/g, '/')
  if (!path.startsWith(PLANS_PREFIX)) return null

  const name = path.slice(PLANS_PREFIX.length)
  return isPlanFileName(name) ? name : null
}

/**
 * Every plan file git tracks, from a listing taken *inside* the plans directory.
 *
 * The same question `settledPlanNames` answers from the repo root, asked one path segment
 * further down: the ticket loop runs `git ls-files` with `-C <plans dir>`, so it never has to
 * know where in the repo that directory sits. Both callers share `isPlanFileName`, because two
 * ideas of what counts as a plan is how the two halves of this ledger drift apart.
 *
 * @param {string[]} paths - tracked paths relative to the plans directory
 * @returns {Set<string>}
 */
export function trackedPlanNames(paths = []) {
  return new Set(paths.map((path) => path.replace(/\\/g, '/')).filter(isPlanFileName))
}

/**
 * Every plan file name the queue must not offer again.
 *
 * @param {{ state?: Record<string, { status?: string }>, trackedPaths?: string[] }} sources
 * @returns {Set<string>}
 */
export function settledPlanNames({ state = {}, trackedPaths = [] } = {}) {
  const settled = new Set()

  for (const [name, entry] of Object.entries(state)) {
    if (entry && SETTLED_STATUSES.includes(entry.status)) settled.add(name)
  }
  for (const path of trackedPaths) {
    const name = planNameOf(path)
    if (name) settled.add(name)
  }

  return settled
}
