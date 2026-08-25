// The naming and the reading of a plan's branch.
//
// Every plan is implemented on a branch of its own and fast-forwarded onto the base branch once
// it verifies (R5.4). Nothing here touches git: this module answers what a branch should be
// called and what git's output means, so `run-plans.ps1` is left with the orchestration and
// these decisions can be tested without a repository.

const DEFAULT_PREFIX = 'plan/'
const MAX_ATTEMPTS = 50

/** Everything `git check-ref-format` refuses in a branch name, plus whitespace. */
const ILLEGAL_IN_REF = /[^A-Za-z0-9._-]+/g

function stripExtension(planFile) {
  return planFile.replace(/\.md$/i, '')
}

function withSeparator(prefix) {
  if (!prefix || prefix.endsWith('/')) return prefix ?? ''
  return `${prefix}/`
}

/**
 * A branch name for one plan file: its own name, made legal as a git ref.
 *
 * The plan file names the branch because that is the one identifier the runner, the report, the
 * commit and `.state.json` already share — a reader who has any of them can find the rest.
 *
 * The sanitising is not decoration. `claim-plan-number.mjs` writes kebab-case slugs that need
 * none of it, but a plan file written by hand can carry a space or a colon, and `git checkout -b`
 * would refuse the name and fail the plan for something that has nothing to do with its content.
 */
export function planBranchName(planFile, { prefix = DEFAULT_PREFIX } = {}) {
  const cleaned = stripExtension(planFile)
    .replace(ILLEGAL_IN_REF, '-')
    .replace(/\.lock(?=$|[.-])/gi, '-lock')
    .replace(/\.{2,}/g, '-')
    .replace(/[.-]{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  return `${withSeparator(prefix)}${cleaned || 'plan'}`
}

/**
 * The first free name at or after `desired`.
 *
 * A branch already holding the name belongs to an earlier attempt at the same plan, and that
 * branch is the only copy of work no one has reviewed — so a retry is numbered and goes beside
 * it. Compared case-insensitively because git on Windows will refuse `plan/A` while `plan/a`
 * exists, and a name this function called free would fail at the checkout instead.
 */
export function chooseBranchName(desired, existingNames) {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()).filter(Boolean))

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? desired : `${desired}-${attempt}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  throw new Error(`No free branch name for '${desired}' after ${MAX_ATTEMPTS} attempts.`)
}

/** The two-letter porcelain codes that mean "git could not merge this file". */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function unquotePath(entry) {
  const trimmed = entry.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
  return trimmed.slice(1, -1)
}

/**
 * The paths a rebase stopped on, read from `git status --porcelain`.
 *
 * Both status letters are checked together: `AU` is unmerged and `A ` is a plain add, so reading
 * the first letter alone would report every clean rebase as conflicted.
 */
export function conflictedPaths(porcelainLines) {
  return porcelainLines
    .filter((line) => UNMERGED.has(line.slice(0, 2)))
    .map((line) => unquotePath(line.slice(3)).replace(/\\/g, '/'))
    .filter(Boolean)
}

/** The arrow markers git writes into a conflicted file, and nothing else. */
const CONFLICT_MARKER = /^(<{7}|>{7})(?=$|\s)/

/**
 * Every conflict marker left in a file, as `{ line, text }`, counting lines from 1.
 *
 * The verdict on a resolution is never the resolver's own word for it, and this is the cheapest
 * proof it did the work: a file it claimed to resolve while leaving the markers in place would
 * otherwise compile in some languages, pass a test that never imports it, and reach the base
 * branch.
 *
 * `=======` is not looked for. It underlines a heading in markdown and rules off a section in
 * plenty of comments, so it would condemn files that were never conflicted.
 */
export function conflictMarkerLines(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((entry) => CONFLICT_MARKER.test(entry.text))
}
