#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls once per run for the standing instructions it prepends to
 * every plan's prompt. It replies on stdout as JSON:
 *
 *   node preamble-cli.mjs [--repo-root <dir>]
 *     -> {"text":"# Standing instructions...","source":"spine + plans/_project.md"}
 *
 * The repo root defaults to the working directory. A fault - a spine missing from the tool,
 * a placeholder it misspells, a malformed runner config - exits 1 with the reason on stderr:
 * a prompt composed wrong is the one input every plan in the queue would inherit.
 */
import process from 'node:process'
import { parseArgs } from 'node:util'

import { loadPreamble } from './preamble.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'repo-root': { type: 'string' },
  },
})

try {
  process.stdout.write(`${JSON.stringify(loadPreamble(values['repo-root'] ?? process.cwd()))}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
