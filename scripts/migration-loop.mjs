/**
 * The migration loop: assess, plan a few steps, run them, record, repeat with a fresh mind.
 *
 * For a target state too large to plan in one sitting (an architecture migration, say), a queue
 * of plans written up front goes stale by the tenth one: the tree they were written against no
 * longer exists. This loop plans only a tick ahead. Each tick a headless assessor session reads
 * the target document, the migration log and the last tick's reports, measures the code, and
 * claims one to a few plan files. The shared plan runner executes them. The loop appends what
 * happened to the log, commits it on the base branch so the runner's clean-tree rule keeps
 * holding, and starts the next assessor with no memory but those files.
 *
 * Everything that touches a process or the file system is injected (`deps`), so the loop's
 * decisions are tested with fakes and `migration-loop-cli.mjs` is wiring only.
 */

export const VERDICT_PREFIX = 'MIGRATION-LOOP:'
const PLAN_FILE = /^\d+[-_].+\.md$/
const TICK_HEADING = /^### Tick (\d+)\b/m
const NO_TICKS_PLACEHOLDER = '_No ticks yet._'

// --------------------------------------------------------------------------
// The assessor's verdict
// --------------------------------------------------------------------------

/**
 * The last `MIGRATION-LOOP:` line of what the assessor said, or `kind: 'none'` when it never
 * gave one - an assessor that ran out of context or budget mid-way.
 */
export function parseVerdict(text) {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim())
  const verdictLines = lines.filter((line) => line.startsWith(VERDICT_PREFIX))
  if (verdictLines.length === 0) return { kind: 'none', plans: [], reason: null }
  return parseVerdictLine(verdictLines[verdictLines.length - 1].slice(VERDICT_PREFIX.length).trim())
}

function parseVerdictLine(body) {
  if (body === 'target-reached') return { kind: 'target-reached', plans: [], reason: null }
  if (body.startsWith('needs-human')) {
    return { kind: 'needs-human', plans: [], reason: body.slice('needs-human'.length).trim() || null }
  }
  if (body.startsWith('planned')) {
    const plans = body
      .slice('planned'.length)
      .split(',')
      .map((name) => name.trim().replace(/^`|`$/g, ''))
      .filter(Boolean)
    return { kind: 'planned', plans, reason: null }
  }
  return { kind: 'unknown', plans: [], reason: body }
}

/**
 * Everything the assistant said in a `stream-json` session transcript, in order. The verdict is
 * the last line of the final message, so the final `result` record alone would do - but a
 * session killed by the wall clock has no result record, and its last assistant text still says
 * how far it got.
 */
export function assistantText(jsonl) {
  const texts = []
  for (const line of jsonl.split(/\r?\n/)) {
    const record = parseRecord(line)
    if (!record) continue
    if (record.type === 'result' && typeof record.result === 'string') texts.push(record.result)
    if (record.type === 'assistant') texts.push(...textBlocks(record))
  }
  return texts.join('\n')
}

function parseRecord(line) {
  if (!line.trim()) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function textBlocks(record) {
  const content = record.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block.type === 'text' && block.text).map((block) => block.text)
}

// --------------------------------------------------------------------------
// The assessor's prompt
// --------------------------------------------------------------------------

/** Fill `{{NAME}}` placeholders; an unknown or unfilled one is a template bug, not a prompt. */
export function composePrompt(template, vars) {
  const filled = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => {
    if (!(name in vars)) throw new Error(`prompt template names {{${name}}}, which nothing fills`)
    return String(vars[name])
  })
  return filled
}

/**
 * The previous tick's outcomes as the assessor should read them; or the words for "none".
 * A process launched with `--max-ticks 1` carries no outcomes into its first tick even when
 * earlier ticks exist, so the words for "none" depend on the tick number.
 */
export function describeOutcomes(outcomes, tick = 1) {
  if (outcomes && outcomes.length > 0) return outcomes.map(describeOutcome).join('\n')
  if (tick <= 1) return 'This is the first tick; no plans have run yet.'
  return `This process started at tick ${tick} and carries no outcomes of its own: read tick ${tick - 1}'s **Outcome** list in the log for what the last tick ran and how each plan ended.`
}

function describeOutcome(outcome) {
  const head = `- \`${outcome.plan}\`: **${outcome.status}**`
  const parts = []
  if (outcome.commit) parts.push(`commit ${outcome.commit.slice(0, 8)}`)
  if (outcome.branch) parts.push(`branch \`${outcome.branch}\``)
  if (outcome.elapsedMin != null) parts.push(`${outcome.elapsedMin} min`)
  if (outcome.report) parts.push(`report \`${outcome.report}\``)
  const problems = outcome.problems?.length ? `; problems: ${outcome.problems.join('; ')}` : ''
  return `${head}${parts.length ? ` (${parts.join(', ')})` : ''}${problems}`
}

// --------------------------------------------------------------------------
// Plan files and their outcomes
// --------------------------------------------------------------------------

/** The plan files present after the assessor ran that were not there before. */
export function newPlanFiles(before, after) {
  const seen = new Set(before)
  return after.filter((name) => PLAN_FILE.test(name) && !seen.has(name)).sort()
}

/**
 * What `plans/.state.json` says about each plan the tick queued. A plan the runner never reached
 * (it halted, or refused the queue) has no entry and reads as `not-run`.
 */
export function readOutcomes(state, planFiles, { reportsDir = 'plans/reports' } = {}) {
  return planFiles.map((plan) => {
    const entry = state?.[plan]
    if (!entry) return { plan, status: 'not-run', commit: null, branch: null, problems: [], elapsedMin: null, report: null }
    return {
      plan,
      status: entry.status ?? 'unknown',
      commit: entry.commit ?? null,
      branch: entry.branch ?? null,
      problems: Array.isArray(entry.problems) ? entry.problems : [],
      elapsedMin: entry.elapsedMin ?? null,
      report: `${reportsDir}/${plan}`,
    }
  })
}

export function allCompleted(outcomes) {
  return outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'completed')
}

// --------------------------------------------------------------------------
// The migration log
// --------------------------------------------------------------------------

/** The number the next tick gets: one past the highest `### Tick N` heading, or 1. */
export function nextTickNumber(logText) {
  let highest = 0
  for (const match of logText.matchAll(new RegExp(TICK_HEADING.source, 'gm'))) {
    highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/** True when the log already carries this tick's heading - the assessor did its part. */
export function hasTickEntry(logText, tick) {
  return new RegExp(`^### Tick ${tick}\\b`, 'm').test(logText)
}

/**
 * Append the loop's own section under the given tick's **Outcome.** line. The entry shape is
 * fixed by the assessor prompt; when an assessor strayed from it, the text goes at the end of
 * the log instead of nowhere.
 */
export function appendOutcome(logText, tick, outcomeText) {
  const tickStart = logText.search(new RegExp(`^### Tick ${tick}\\b`, 'm'))
  if (tickStart < 0) return `${logText.trimEnd()}\n\n### Tick ${tick}\n\n**Outcome.**\n${outcomeText}\n`

  const rest = logText.slice(tickStart)
  const nextTick = rest.slice(1).search(/^### Tick \d+\b/m)
  const entryEnd = nextTick < 0 ? logText.length : tickStart + 1 + nextTick
  const entry = logText.slice(tickStart, entryEnd)
  const updated = entry.includes('**Outcome.**')
    ? `${entry.trimEnd()}\n${outcomeText}\n\n`
    : `${entry.trimEnd()}\n\n**Outcome.**\n${outcomeText}\n\n`
  return logText.slice(0, tickStart) + updated + logText.slice(entryEnd)
}

/** The outcome lines the loop writes after the runner finishes. */
export function formatOutcome(outcomes, { finishedAt }) {
  const lines = outcomes.map((outcome) => describeOutcome(outcome))
  lines.push(`- run finished ${finishedAt}`)
  return lines.join('\n')
}

/** Guard: the assessor's tick entry must not drop the placeholder-and-nothing-else state. */
export function assessorWroteEntry(logBefore, logAfter, tick) {
  if (logAfter === logBefore) return false
  if (logAfter.includes(NO_TICKS_PLACEHOLDER) && !hasTickEntry(logAfter, tick)) return false
  return hasTickEntry(logAfter, tick)
}

// --------------------------------------------------------------------------
// Stop rules
// --------------------------------------------------------------------------

/**
 * Whether to start another tick. A verdict other than `planned` ends the loop by itself, and so
 * does a plan that did not complete (`haltAfterRun`); what is left to rule on is the cap.
 */
export function decideNext({ tick, maxTicks }) {
  if (tick >= maxTicks) return { again: false, reason: `reached the ${maxTicks}-tick cap` }
  return { again: true, reason: null }
}

/**
 * Why the loop stops after a run, or null when every plan landed.
 *
 * A failed plan ends the loop, not just the batch. The plans behind it were written against a
 * tree that now does not exist, and the next assessor would plan on top of the same gap; a
 * human has to look at the branch first. The runner is started with -StopOnFailure for the
 * same reason, so the plans behind a failure read as not-run rather than as failures of their
 * own.
 */
export function haltAfterRun(outcomes) {
  const failed = outcomes.find((outcome) => outcome.status !== 'completed')
  if (!failed) return null
  const where = failed.branch ? `; its work is on branch ${failed.branch}` : ''
  return `plan ${failed.plan} ended ${failed.status}${where} - the loop stops until a human has looked`
}

// --------------------------------------------------------------------------
// One tick, then the loop
// --------------------------------------------------------------------------

/**
 * `deps` is the loop's whole view of the world:
 *   readLog() / writeLog(text)           the migration log's text
 *   listPlans()                          basenames in the plans directory
 *   assess({tick, lastOutcomes})         run the assessor; → {transcript, limited, resetsAt}
 *   dirtyPaths()                         paths `git status` reports, excluding the carried plans
 *   commitLog(message)                   stage the log and commit it
 *   runPlans(planFiles)                  run the plan runner on exactly these; → exit code
 *   readState()                          parsed plans/.state.json, or {}
 *   now()                                ISO timestamp
 *   sleep(seconds)                       wait out a rate limit
 *   say(line)                            the operator's console
 * Returns the tick's record: what was planned, what came back, and whether the loop goes on.
 */
export async function runTick(deps, options) {
  const tick = nextTickNumber(deps.readLog())
  deps.say(`tick ${tick}: assessing`)
  const assessed = await assessUntilNotLimited(deps, { tick, lastOutcomes: options.lastOutcomes }, options)
  if (assessed.stopped) return { tick, stop: assessed.reason, outcomes: [] }

  const verdict = parseVerdict(assistantText(assessed.transcript))
  const plans = newPlanFiles(assessed.plansBefore, deps.listPlans())
  const stray = deps.dirtyPaths().filter((path) => path !== options.logPath && !plans.some((plan) => path.endsWith(plan)))
  if (stray.length > 0) return { tick, stop: `the assessor changed files it must not: ${stray.join(', ')}`, outcomes: [] }

  if (!assessorWroteEntry(assessed.logBefore, deps.readLog(), tick)) {
    deps.writeLog(appendOutcome(deps.readLog(), tick, `- the assessor wrote no tick entry; verdict: ${verdict.kind}`))
  }
  deps.commitLog(`migration loop: tick ${tick} assessed (${verdict.kind})`)

  const halted = haltAfterAssessment(verdict, plans)
  if (halted) return { tick, stop: halted, outcomes: [] }
  if (options.dryRun) return { tick, stop: 'dry run: plans queued, runner not started', outcomes: [], plans }

  deps.say(`tick ${tick}: running ${plans.join(', ')}`)
  const exitCode = await deps.runPlans(plans)
  const outcomes = readOutcomes(deps.readState(), plans)
  deps.writeLog(appendOutcome(deps.readLog(), tick, formatOutcome(outcomes, { finishedAt: deps.now() })))
  deps.commitLog(`migration loop: tick ${tick} ran (${outcomes.filter((o) => o.status === 'completed').length}/${plans.length} completed)`)
  deps.say(`tick ${tick}: runner exited ${exitCode}; ${outcomes.map((o) => `${o.plan} ${o.status}`).join(', ')}`)
  return { tick, stop: haltAfterRun(outcomes), outcomes, plans }
}

function haltAfterAssessment(verdict, plans) {
  if (verdict.kind === 'target-reached') return 'the assessor reports the target reached'
  if (verdict.kind === 'needs-human') return `needs a human: ${verdict.reason ?? 'see the log'}`
  if (verdict.kind === 'none' || verdict.kind === 'unknown') {
    return `the assessor gave no usable verdict (${verdict.kind}${verdict.reason ? `: ${verdict.reason}` : ''})`
  }
  if (plans.length === 0) return 'the assessor said it planned but no new plan file appeared'
  const missing = verdict.plans.filter((name) => !plans.includes(name))
  if (missing.length > 0) return `the verdict names plans that do not exist: ${missing.join(', ')}`
  return null
}

/** Run the assessor; on an account refusal, wait the window out and try the same tick again. */
async function assessUntilNotLimited(deps, input, options) {
  for (let attempt = 1; attempt <= options.maxRateLimitRetries; attempt += 1) {
    const logBefore = deps.readLog()
    const plansBefore = deps.listPlans()
    const result = await deps.assess(input)
    if (!result.limited) return { ...result, logBefore, plansBefore }
    const waitSeconds = result.waitSeconds ?? null
    if (waitSeconds == null) return { stopped: true, reason: 'the assessor was refused and the window did not say when it reopens' }
    deps.say(`tick ${input.tick}: assessor refused by the account limit; sleeping ${Math.ceil(waitSeconds / 60)} min`)
    await deps.sleep(waitSeconds)
  }
  return { stopped: true, reason: `the assessor was refused ${options.maxRateLimitRetries} times running` }
}

export async function runLoop(deps, options) {
  const settings = {
    maxTicks: 1,
    maxRateLimitRetries: 3,
    dryRun: false,
    ...options,
  }
  const ticks = []
  let lastOutcomes = []
  for (;;) {
    const record = await runTick(deps, { ...settings, lastOutcomes })
    ticks.push(record)
    if (record.stop) return { ticks, reason: record.stop }

    lastOutcomes = record.outcomes
    const next = decideNext({ tick: ticks.length, ...settings })
    if (!next.again) return { ticks, reason: next.reason }
  }
}
