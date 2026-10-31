#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to ask whether one package's visual sweep has to run for a
 * plan. It replies on stdout as JSON.
 *
 *   node visual-gate-cli.mjs --plan plans/728-....md --package-prefix packages/web/ --diff-file <tmp>
 *     -> {"run":false,"why":"the plan declares `Visual gate: none` (...) and ..."}
 *
 * `--diff-file` lists the commit's changed paths, one per line, as `git diff --name-only`
 * prints them; only the ones under `--package-prefix` are weighed, because the decision is per
 * package. The always-sweep list comes from plans/runner.json (`gates.visual.alwaysFor`).
 *
 * Reporting only: a non-zero exit means the question could not be answered, and the runner
 * then runs the sweep - the safe direction to be wrong in. The decision itself lives in
 * visual-gate.mjs, where it is tested.
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { loadRunnerConfig } from './runner-config.mjs'
import { decideVisualGate, readVisualGateDeclaration } from './visual-gate.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    plan: { type: 'string' },
    'diff-file': { type: 'string' },
    'package-prefix': { type: 'string', default: '' },
  },
})

if (!values.plan || !values['diff-file']) {
  process.stderr.write('usage: visual-gate-cli.mjs --plan <plan file> --diff-file <changed paths> [--package-prefix packages/<name>/]\n')
  process.exit(2)
}

const prefix = values['package-prefix'].replace(/\\/g, '/')
const changedFiles = readFileSync(values['diff-file'], 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && line.replace(/\\/g, '/').startsWith(prefix))

// The working directory is the target repo's root - the runner starts every bridge there.
const { alwaysFor } = loadRunnerConfig(process.cwd()).gates.visual
const declaration = readVisualGateDeclaration(readFileSync(values.plan, 'utf8'))
const verdict = decideVisualGate({ declaration, changedFiles, alwaysFor })

process.stdout.write(`${JSON.stringify({ ...verdict, declared: declaration.declared })}\n`)
