/**
 * The front matter at the top of a plan file, and the two settings it carries: how much effort
 * the headless session implementing that plan should run at, and on which model.
 *
 * A copy change and a concurrency fix do not deserve the same session. `effort` says how hard
 * it is worth thinking; `model` lets a mechanical plan run on a faster model (Sonnet) while the
 * hard ones stay on the runner's default (`-Model`, Opus unless overridden).
 *
 * The header is deliberately a *header* rather than a line in the prose. It is the runner's
 * setting, not the agent's instruction, so it is taken off the top before the body is composed
 * into the prompt - what reaches the session is the plan, unchanged.
 */

/** The levels `claude --effort` accepts, in the order it lists them. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * What a plan that says nothing runs at.
 *
 * `medium` since Opus 5.5 (2026-11-22). Effort names do not carry across models: Opus 5.5 at
 * `medium` beats Opus 5 at `high` on coding evaluations, and at any one level it thinks more
 * per turn. The old `high` default was set for Opus 5; keeping it would have quietly bought
 * more thinking than anyone chose. A plan that needs more says so.
 */
export const DEFAULT_EFFORT = 'medium'

/**
 * The model aliases a plan may name; `claude --model` resolves each to the latest of its family.
 * A plan that names none answers `null` and runs on whatever `-Model` the runner was started with.
 */
export const MODELS = Object.freeze(['opus', 'sonnet', 'haiku'])

/**
 * `---` on the first line, fields, `---`. Tolerates a byte-order mark, CRLF, and trailing
 * space on either fence. The body is what follows, sliced from the original text rather than
 * rebuilt from lines, so a CRLF plan reaches the prompt byte for byte.
 */
const FRONT_MATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/
const OPENS_FRONT_MATTER = /^﻿?---[ \t]*\r?\n/
const FIELD = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/

/**
 * The value of one field: quoted verbatim, or bare with any trailing comment cut off.
 *
 * The comment matters more than it looks. `_template.md` carries the list of levels on the
 * effort line itself, so an author choosing one is reading the choices while they choose - and
 * a template that only parses once you have deleted part of it is a template that ships typos.
 * A `#` with no space in front of it is part of the value, so `ABC-1#2` survives.
 */
function readValue(raw) {
  const quoted = /^(['"])([\s\S]*?)\1/.exec(raw.trim())
  if (quoted) return quoted[2]
  return raw.replace(/(^|\s)#.*$/, '$1').trim()
}

function readFields(block) {
  const fields = {}
  for (const line of block.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue

    const field = FIELD.exec(text)
    if (!field) return { fields, problem: `could not read the front-matter line '${text}'` }
    fields[field[1]] = readValue(field[2])
  }
  return { fields, problem: null }
}

/**
 * Splits a plan file into its front-matter fields and its body.
 *
 * A file with no front matter is not a fault - it is most of them - and comes back with no
 * fields and its whole text as the body. A file that opens front matter and never closes it
 * is a fault, because the alternative is silently feeding a half-written header to the agent
 * as if it were part of the plan.
 */
export function splitFrontMatter(text) {
  const match = FRONT_MATTER.exec(text)
  if (!match) {
    if (OPENS_FRONT_MATTER.test(text)) {
      return { fields: {}, body: text, problem: 'front matter is opened with --- but never closed' }
    }
    return { fields: {}, body: text, problem: null }
  }

  const { fields, problem } = readFields(match[1])
  return { fields, body: text.slice(match[0].length), problem }
}

/**
 * The effort one plan file asks for, the body to compose into its prompt, and whether either
 * question could be answered at all.
 *
 * An unrecognised level is refused rather than shrugged off. `claude --effort hgih` is only a
 * warning: it runs the session at the default effort and says so in one line of a log nobody
 * reads afterwards. Refusing costs a five-second fix; accepting costs the whole plan running
 * at an effort somebody deliberately chose against.
 */
export function readPlanHeader(text) {
  const { fields, body, problem } = splitFrontMatter(text)
  if (problem) return { effort: null, model: null, declared: false, body, problem }

  const model = readModel(fields)
  if (model.problem) return { effort: null, model: null, declared: true, body, problem: model.problem }

  if (fields.effort === undefined) {
    return { effort: DEFAULT_EFFORT, model: model.value, declared: false, body, problem: null }
  }

  const effort = fields.effort.trim().toLowerCase()
  if (!EFFORT_LEVELS.includes(effort)) {
    return {
      effort: null,
      model: null,
      declared: true,
      body,
      problem: `unknown effort '${fields.effort}' - expected one of ${EFFORT_LEVELS.join(', ')}`,
    }
  }
  return { effort, model: model.value, declared: true, body, problem: null }
}

/**
 * The model a plan names, or `null` for none. Refused when unknown for the same reason as an
 * effort typo: `claude --model sonet` fails the session, and failing before a branch is cut is
 * cheaper than failing after.
 */
function readModel(fields) {
  if (fields.model === undefined) return { value: null, problem: null }
  const value = fields.model.trim().toLowerCase()
  if (MODELS.includes(value)) return { value, problem: null }
  return { value: null, problem: `unknown model '${fields.model}' - expected one of ${MODELS.join(', ')}` }
}
