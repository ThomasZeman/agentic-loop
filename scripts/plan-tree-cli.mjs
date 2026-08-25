#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` (and any other automation sharing the checkout) calls to ask
 * whether the working tree permits a plan run, answering on stdout as JSON.
 *
 * It reads the tree itself rather than taking a snapshot from PowerShell: `Set-Content
 * -Encoding UTF8` on PowerShell 5.1 writes a BOM, which would arrive glued to the first path
 * in the listing and turn it into a path git has never heard of.
 *
 * Reporting only — the exit code says whether the question could be answered, never what the
 * answer was. The caller decides what a dirty tree costs it.
 */
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

import { assessRunnerTree } from './plan-tree.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'running-plan': { type: 'string' },
    // Repeatable. Each is a path under scripts/ that was already dirty before the plan ran, so
    // the plan cannot be blamed for it. Passing none means "do not narrow" - see plan-tree.mjs.
    pending: { type: 'string', multiple: true },
  },
})

// --running-plan is what says a plan has just run and can be held responsible for what it left
// behind. Only then is the scripts/ carry narrowed to the paths that were already dirty - and to
// exactly those, so the usual case of none passed narrows to nothing rather than to everything.
const runningPlan = values['running-plan'] ?? null
const porcelain = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
const assessment = assessRunnerTree(porcelain.split(/\r?\n/), {
  runningPlan,
  pendingScripts: runningPlan ? values.pending ?? [] : null,
})

process.stdout.write(`${JSON.stringify(assessment)}\n`)
