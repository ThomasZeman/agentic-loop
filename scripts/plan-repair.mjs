// Whether a failed plan is worth giving one more session, and what that session is not
// allowed to do with it.
//
// Without this, a plan that trips a gate is finished: the runner marks it needs-review, resets
// to the base branch and moves on, and the whole session - a quarter of an hour of work - is
// thrown away over a fault that is often one line. The typical case is a visual spec the plan
// never thought to run, red by a few pixels.
//
// So the runner gets a repair pass. It is deliberately narrow, because an unattended second
// session that is allowed to do anything is a way to turn a failed plan into a bad merge:
//
//   - It runs only for gates, and only when *every* problem is one. A plan that committed
//     nothing, or left the tree dirty, or whose verification could not run, went wrong in a
//     way a scoped session cannot reason about, and is failed as before.
//   - It may not re-record a snapshot. That is the one "fix" that makes any red go green
//     while hiding what actually moved, and the plan's own session already had its chance to
//     re-record the baselines it meant to change. A red the runner found
//     afterwards is by definition one the plan did not intend.
//   - It gets one attempt, and the full verdict is taken again afterwards, so nothing reaches
//     the base branch on the strength of a gate that was not re-run.

/**
 * The gate failures a scoped session can act on: it can read the log, see the failing test or
 * the count that rose, and fix the code. Each is matched on the exact shape run-plans.ps1
 * writes, so a problem this file has not been taught about fails closed rather than open.
 */
const REPAIRABLE_GATES = [
  // Test-PackageVisuals: specs this plan turned red, named against the run's baseline.
  /^package '[^']+' turned \d+ visual test\(s\) red: /,
  // Test-ChangedPackages: the package's own suite.
  /^package '[^']+' test suite is red \(exit -?\d+\)/,
  // Test-PackageQualityRatchet: tsc errors or eslint problems that went up.
  /^package '[^']+' (?:tsc|lint) count rose \d+ -> \d+/,
]

/** Those of a plan's problems that a repair session could actually do something about. */
export function repairableProblems(problems) {
  return problems.filter((problem) => REPAIRABLE_GATES.some((gate) => gate.test(problem)))
}

/**
 * Whether this plan gets a repair pass at all.
 *
 * All or nothing on purpose. A plan that failed a gate *and* left something else behind has a
 * second thing wrong with it, and a session sent to fix the gate would be working on ground
 * neither it nor the runner understands.
 */
export function isRepairable(problems) {
  if (problems.length === 0) return false
  return repairableProblems(problems).length === problems.length
}

/**
 * The paths a repair session was not allowed to touch: anything inside a snapshot directory,
 * jest's and Playwright's alike. Split on both separators - git reports forward slashes, but
 * this is also handed lists that came from PowerShell.
 */
export function forbiddenRepairPaths(changedPaths) {
  return changedPaths.filter((path) => path.split(/[/\\]/).includes('__snapshots__'))
}
