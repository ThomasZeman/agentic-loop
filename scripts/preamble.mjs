/**
 * The standing instructions prepended to every plan's prompt, and where they come from.
 *
 * Two parts. The spine (`prompt/spine.md`, shipped with the tool) is what is true of every
 * project the runner serves: TDD, scope, the gates the runner itself enforces, the commit
 * authorization, the blocked protocol, the report. The project section (`plans/_project.md`
 * in the target repo) is what only that project's owner can say: what to read first, the exact
 * gate commands, how its visual harness and live app are driven, what is off limits.
 *
 * A repo that still carries a whole `plans/_preamble.md` gets it used verbatim and the spine is
 * not consulted - that is how a project written against the old single-file layout keeps
 * running unchanged until it splits its own.
 *
 * The spine names the gates from the runner config rather than by hand, so the prompt and the
 * verification can never disagree about which script is run.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRunnerConfig } from './runner-config.mjs'

export const SPINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompt', 'spine.md')
export const PROJECT_PREAMBLE_RELATIVE_PATH = path.join('plans', '_preamble.md')
export const PROJECT_SECTION_RELATIVE_PATH = path.join('plans', '_project.md')

const NO_PROJECT_SECTION =
  'This project declares no additional rules (no `plans/_project.md`). The spine above is the whole of it.'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

function qualityGateLine(config) {
  if (!config.gates.quality.enabled) return ''
  return (
    '- The tsc error count and the eslint problem count of each package, which may fall but never\n' +
    '  rise against the last accepted counts (`plans/.quality-baseline.json`).'
  )
}

function placeholderValues(config) {
  return {
    packagesDir: config.packagesDir,
    testScript: config.gates.test.script,
    visualScript: config.gates.visual.script,
    qualityGateLine: qualityGateLine(config),
  }
}

/** The spine with its `{{placeholders}}` filled from the config. An unknown one throws. */
export function renderSpine(spine, config) {
  const values = placeholderValues(config)
  return spine.replace(PLACEHOLDER, (_match, name) => {
    if (!(name in values)) throw new Error(`preamble spine: unknown placeholder '${name}'`)
    return values[name]
  })
}

function trimTrailingNewlines(text) {
  return text.replace(/\s+$/, '')
}

/**
 * The preamble text from its parts, and a label saying which parts were used. Pure: the
 * caller does the reading.
 */
export function composePreamble({ projectPreamble, spine, projectSection, config }) {
  if (projectPreamble !== null && projectPreamble !== undefined) {
    return { text: projectPreamble, source: 'plans/_preamble.md' }
  }

  const rendered = trimTrailingNewlines(renderSpine(spine, config))
  const hasSection = projectSection !== null && projectSection !== undefined
  const section = hasSection ? trimTrailingNewlines(projectSection) : NO_PROJECT_SECTION
  return {
    text: `${rendered}\n\n---\n\n# Project section\n\n${section}\n`,
    source: hasSection ? 'spine + plans/_project.md' : 'spine',
  }
}

const BOM = String.fromCharCode(0xfeff)

function readOptional(file) {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  return text.startsWith(BOM) ? text.slice(BOM.length) : text
}

/** Reads the parts for one repo and composes them. `config` defaults to the repo's own. */
export function loadPreamble(repoRoot, config = null) {
  const spine = readOptional(SPINE_PATH)
  if (spine === null) throw new Error(`preamble spine missing at ${SPINE_PATH} - the tool is incomplete`)

  return composePreamble({
    projectPreamble: readOptional(path.join(repoRoot, PROJECT_PREAMBLE_RELATIVE_PATH)),
    spine,
    projectSection: readOptional(path.join(repoRoot, PROJECT_SECTION_RELATIVE_PATH)),
    config: config ?? loadRunnerConfig(repoRoot),
  })
}
