// Which dirty paths a plan run may tolerate, and which must stop it.
//
// The runner used to demand a spotless tree, so every plan file had to be committed before the
// queue started — one bookkeeping commit per plan, separate from the work it describes. Now a
// plan file rides in the commit of its own implementation, which means the queue's remaining
// plan files are sitting untracked while earlier plans run.
//
// The line is drawn at `plans/` and `scripts/`. Everything under those is the runner's own
// paperwork and the tooling that drives it — queued plans, half-written ones, reports from an
// earlier batch, an edit to the preamble, a runner script being worked on in another window —
// and none of it is the product source an unattended agent might build on top of. Everything
// outside them blocks, because the alternative is an agent sweeping real work into a 3 a.m.
// commit.
//
// This is deliberately wider than it once was. The old rule carried only *untracked, numbered*
// plan files, which meant a plan file mid-edit, a stale report, or a note filed beside the plans
// stopped the whole queue over a file no plan would ever touch.
//
// It stays narrow in two places, both about what a *finished* plan must have committed:
//
//   - `runningPlan` names the plan just executed, and that plan's own file and report must be
//     *in* its commit, as the preamble requires.
//   - `pendingScripts` lists the paths under `scripts/` that were already dirty when that plan
//     started. Those keep riding along; anything else under `scripts/` is something the plan
//     itself produced and did not commit, which is the failure the post-run check exists to
//     catch. Without the list — before any plan has run, or when tidying up after one — the
//     whole directory is carried.

const PLANS_PREFIX = 'plans/'
const SCRIPTS_PREFIX = 'scripts/'

function toPosix(path) {
  return path.replace(/\\/g, '/')
}

function unquotePath(entry) {
  const trimmed = entry.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
  return trimmed.slice(1, -1)
}

/** The paths one `git status --porcelain` line names — two of them for a rename. */
export function porcelainPaths(line) {
  return line
    .slice(3)
    .trim()
    .split(' -> ')
    .map(unquotePath)
    .filter(Boolean)
}

/**
 * The two paths a finished plan must have committed: its own file and its report.
 *
 * Both are named by the runner from the same plan file name, so the convention lives here once
 * rather than in every caller that has to ask about it.
 */
function ownPathsOf(runningPlan) {
  if (!runningPlan) return []
  const name = toPosix(runningPlan)
  return [`${PLANS_PREFIX}${name}`, `${PLANS_PREFIX}reports/${name}`]
}

/** Whether one dirty path may ride along rather than stopping the run. */
function isCarriable(path, own, pendingScripts) {
  if (path.startsWith(PLANS_PREFIX)) return !own.includes(path)
  if (path.startsWith(SCRIPTS_PREFIX)) return pendingScripts === null || pendingScripts.has(path)
  return false
}

/**
 * Splits a porcelain listing into what stops the runner and what it carries.
 *
 * `runningPlan` is the plan file just executed, e.g. `100-a-thing.md`. Its own file and its
 * report are deliberately not carried: finishing with either still dirty means the commit that
 * was supposed to absorb them did not, and a plan nobody ever commits is the failure this
 * exemption would otherwise hide.
 *
 * `pendingScripts` are the paths under `scripts/` that were already dirty before that plan
 * started, and so cannot be its doing. Omit it and the whole directory is carried, which is
 * what the pre-flight check wants: nothing has run yet, so everything dirty is pending work.
 *
 * Each path is judged on its own, so a file renamed out of the repository's source into `plans/`
 * blocks on the side that came from source and is carried on the side that landed in `plans/`.
 *
 * @param {string[]} porcelainLines
 * @param {{ runningPlan?: string | null, pendingScripts?: string[] | null }} options
 * @returns {{ clean: boolean, blocking: string[], carried: string[] }}
 */
export function assessRunnerTree(porcelainLines, { runningPlan = null, pendingScripts = null } = {}) {
  const own = ownPathsOf(runningPlan)
  const pending = pendingScripts === null ? null : new Set(pendingScripts.map(toPosix))
  const blocking = []
  const carried = []

  for (const line of porcelainLines.filter((entry) => entry.trim())) {
    for (const path of porcelainPaths(line).map(toPosix)) {
      if (isCarriable(path, own, pending)) carried.push(path)
      else blocking.push(path)
    }
  }

  return { clean: blocking.length === 0, blocking, carried }
}
