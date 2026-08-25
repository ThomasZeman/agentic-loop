// Whether the queue's pre-flight has to measure the visual suite again, or already knows the
// answer for the tree it is about to hand every plan.
//
// The pre-flight runs `npm run test:visual` once before the first plan branches, purely to learn
// which screenshots are already red on the base branch - the set every plan inherits and is
// therefore not blamed for. That sweep costs four minutes of every batch, and the ticket loop
// runs one plan per batch, so nothing amortises it.
//
// It is also redundant. Each plan runs the same suite during its own verification, on its own
// branch, and that branch tip is exactly what the base branch fast-forwards to when the plan
// merges. So by the time the base branch reaches a commit, some sweep has already measured that
// tree; the result was simply thrown away. This module decides when it may be kept instead.
//
// The guarantee is narrow on purpose: a record names **one commit**, and is only ever trusted for
// that commit. Never a range, never "and everything since" - the whole point is that a suite
// genuinely ran on that exact tree. Two things follow, and both are rules below:
//
//   - A plan that changed anything the visual suite's result depends on (the package itself or
//     any workspace package it builds against) may only bank a set its own sweep measured.
//   - A plan may carry the previous set forward only if that set was measured on the tree it
//     branched from. Carrying it across a commit nobody measured - a human's push, a batch whose
//     pre-flight swept but never banked - would vouch for a tree no suite has seen.
//
// Anything else clears the record, and the next pre-flight measures from scratch. A cleared or
// stale record only ever costs the four minutes it was meant to save.

const NO_REUSE = { reuse: false, visual: {} }

/** Package name -> its failing test ids, with anything malformed dropped rather than trusted. */
function readVisualSets(visual) {
  const sets = {}
  for (const [pkg, failures] of Object.entries(visual ?? {})) {
    if (Array.isArray(failures)) sets[pkg] = failures.map(String)
  }
  return sets
}

/**
 * May the pre-flight skip its visual sweep for a base branch sitting at this commit?
 *
 * @param {{ commit?: string, visual?: Record<string, string[]> } | null} bank
 * @param {string} baseCommit the commit the queue is about to branch every plan off
 * @returns {{ reuse: boolean, visual: Record<string, string[]> }}
 */
export function decideVisualReuse(bank, baseCommit) {
  if (!bank?.commit || !baseCommit || bank.commit !== baseCommit) return NO_REUSE

  const visual = readVisualSets(bank.visual)
  if (Object.keys(visual).length === 0) return NO_REUSE
  return { reuse: true, visual }
}

/** The previous record's sets, but only if it vouches for the tree this plan branched from. */
function inheritableSets(previousBank, from) {
  if (!previousBank?.commit || !from || previousBank.commit !== from) return {}
  return readVisualSets(previousBank.visual)
}

function isInClosure(closure, pkg, changedPackages) {
  const dependsOn = new Set([pkg, ...(closure[pkg] ?? [])])
  return changedPackages.some((changed) => dependsOn.has(changed))
}

/**
 * What to record once a plan has fast-forwarded the base branch onto its commit.
 *
 * Called only after the fast-forward has succeeded. A plan that failed verification, or whose
 * push the remote refused, must leave the previous record exactly as it was - it never became
 * the base branch, so nothing it measured describes the tree the next batch will branch off.
 *
 * @param {{ commit?: string, visual?: Record<string, string[]> } | null} previousBank
 * @param {object} options
 * @param {string | null} options.commit the base branch's new commit, the record's whole subject
 * @param {string | null} options.from the base branch's commit before this plan merged
 * @param {string[]} options.changedPackages package directory names this merge changed
 * @param {string[]} options.visualPackages package directory names that define a visual suite
 * @param {Record<string, string[]>} options.closure each visual package's own dependencies
 * @param {Record<string, string[]>} options.measured what this plan's own sweep found, if it ran
 * @returns {{ commit: string, visual: Record<string, string[]> } | null} null means "clear it"
 */
export function decideBank(
  previousBank,
  { commit, from = null, changedPackages = [], visualPackages = [], closure = {}, measured = {} } = {}
) {
  if (!commit || visualPackages.length === 0) return null

  const inherited = inheritableSets(previousBank, from)
  const visual = {}

  for (const pkg of visualPackages) {
    const fresh = measured?.[pkg]
    if (Array.isArray(fresh)) {
      visual[pkg] = fresh.map(String)
      continue
    }
    if (!inherited[pkg] || isInClosure(closure, pkg, changedPackages)) return null
    visual[pkg] = [...inherited[pkg]]
  }

  return { commit, visual }
}
