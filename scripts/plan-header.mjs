/**
 * The front matter at the top of a plan file, and the one setting it currently carries: how
 * much effort the headless session implementing that plan should run at.
 *
 * Every plan runs on Opus. What varies between them is how hard it is worth thinking: a copy
 * change and a concurrency fix do not deserve the same session, and until now they got one,
 * because `run-plans.ps1` passed no `--effort` at all and every plan inherited whatever the
 * CLI happened to default to.
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
 * `high` rather than something cheaper because that is the standing queue: every plan file
 * written before this existed declares nothing, and lowering them all wholesale is a decision
 * about work already planned, made by a default nobody chose. A plan that wants less says so.
 */
export const DEFAULT_EFFORT = 'high'

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
 * A `#` with no space in front of it is part of the value, so `NOC-1#2` survives.
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
  if (problem) return { effort: null, declared: false, body, problem }

  if (fields.effort === undefined) {
    return { effort: DEFAULT_EFFORT, declared: false, body, problem: null }
  }

  const effort = fields.effort.trim().toLowerCase()
  if (!EFFORT_LEVELS.includes(effort)) {
    return {
      effort: null,
      declared: true,
      body,
      problem: `unknown effort '${fields.effort}' - expected one of ${EFFORT_LEVELS.join(', ')}`,
    }
  }
  return { effort, declared: true, body, problem: null }
}
