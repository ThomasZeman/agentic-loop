// Whether a plan's visual sweep has to run.
//
// The runner verifies every changed package with its `test:visual` suite, because nothing it can
// read tells it which of a thousand screenshots render what a diff touched. That is the right
// default and the wrong price for a plan that rewrites a frame dispatcher: twenty minutes of
// Chromium for a change no screen can show. So a plan may opt out, and the opt-out is a
// declaration the author makes in the plan file, read here - never inferred from the diff.
//
// The diff still gets the last word in one direction. A project names the paths that always
// render (`gates.visual.alwaysFor` in plans/runner.json: extensions and directory segments), and
// a declared opt-out over a diff touching one of them is overruled, by name. That catches the
// author who called a stylesheet edit "logic only"; it cannot catch styling written in a `.ts`
// file, which is why the declaration stays the author's responsibility and the report says so.
//
// Pure and tested; run-plans.ps1 reaches it through visual-gate-cli.mjs.

/**
 * The one line that opts a plan out of the visual sweep, as the plan template spells it:
 *
 *   **Visual gate:** none — <reason>
 *
 * Bold, plain and list-item spellings all count; so do a hyphen, an en dash or an em dash before
 * the reason. The value has to be the whole word `none` - `nonetheless` is prose, not a
 * declaration - and the line has to start with the label, so the phrase inside a sentence does
 * not count either.
 */
const DECLARATION_LINE = /^\s*(?:[-*]\s+)?\*{0,2}Visual gate\*{0,2}:?\*{0,2}\s*none\b(?!\w)\s*(?:[-–—]+\s*(?<reason>.*\S))?\s*$/im

/**
 * What the plan says about its visual gate.
 *
 * @param {string} planText the plan file's content
 * @returns {{ declared: boolean, reason: string | null }} declared is true only for `none`
 */
export function readVisualGateDeclaration(planText) {
  const match = DECLARATION_LINE.exec(planText ?? '')
  if (!match) return { declared: false, reason: null }
  return { declared: true, reason: match.groups?.reason ?? null }
}

function normalisePath(file) {
  return file.replace(/\\/g, '/')
}

/**
 * Does one always-sweep pattern claim this file? A pattern starting with a dot is a file
 * extension; anything else is a directory segment, matched at a path boundary so `assets/`
 * does not claim `my-assets/`.
 */
function patternClaims(pattern, file) {
  if (pattern.startsWith('.')) return file.endsWith(pattern)
  const segment = pattern.replace(/^\/+/, '')
  return file.startsWith(segment) || file.includes(`/${segment}`)
}

function firstAlwaysSweptFile(changedFiles, alwaysFor) {
  for (const raw of changedFiles) {
    const file = normalisePath(raw)
    const pattern = alwaysFor.find((candidate) => patternClaims(candidate, file))
    if (pattern) return { file: raw, pattern }
  }
  return null
}

/**
 * The decision: run the sweep, or skip it on the plan's word.
 *
 * @param {object} input
 * @param {{ declared: boolean, reason: string | null }} input.declaration what the plan says
 * @param {string[]} input.changedFiles repo-relative paths this plan's commit changed
 * @param {string[]} input.alwaysFor the project's always-sweep extensions and directories
 * @returns {{ run: boolean, why: string }}
 */
export function decideVisualGate({ declaration, changedFiles = [], alwaysFor = [] }) {
  if (!declaration?.declared) {
    return { run: true, why: 'the plan does not opt out of the visual sweep' }
  }

  const hit = firstAlwaysSweptFile(changedFiles, alwaysFor)
  if (hit) {
    return {
      run: true,
      why: `the plan declares \`Visual gate: none\` but changed '${hit.file}', which matches '${hit.pattern}'`,
    }
  }

  const reason = declaration.reason ? ` (${declaration.reason})` : ''
  return {
    run: false,
    why: `the plan declares \`Visual gate: none\`${reason} and the diff touches nothing on the always-sweep list`,
  }
}
