#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to name a plan's branch and to read what a rebase left
 * behind, answering on stdout as JSON.
 *
 * It runs git itself rather than taking a snapshot from PowerShell, for the reason
 * `plan-tree-cli.mjs` spells out: `Set-Content -Encoding UTF8` on PowerShell 5.1 writes a BOM,
 * which would arrive glued to the first path in the listing.
 *
 * Reporting only — the exit code says whether the question could be answered, never what the
 * answer was.
 *
 *   node scripts/plan-branch-cli.mjs name --plan 142-a-thing.md [--prefix plan/]
 *   node scripts/plan-branch-cli.mjs conflicts
 *   node scripts/plan-branch-cli.mjs markers --path packages/backend/src/a.ts [--path ...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { chooseBranchName, conflictMarkerLines, conflictedPaths, planBranchName } from './plan-branch.mjs'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    plan: { type: 'string' },
    prefix: { type: 'string' },
    // Asked for as a flag because an empty --prefix cannot survive the trip: PowerShell's
    // Start-Process joins its argument list with spaces, so an empty string simply vanishes
    // and the next argument would be read as the prefix.
    'no-prefix': { type: 'boolean' },
    path: { type: 'string', multiple: true },
  },
})

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split(/\r?\n/)
}

function requestedPrefix() {
  if (values['no-prefix']) return { prefix: '' }
  if (values.prefix === undefined) return {}
  return { prefix: values.prefix }
}

function nameCommand() {
  if (!values.plan) throw new Error('name needs --plan <plan-file.md>')

  const desired = planBranchName(values.plan, requestedPrefix())
  const existing = git(['branch', '--format=%(refname:short)'])
  return { branch: chooseBranchName(desired, existing), desired }
}

function conflictsCommand() {
  return { paths: conflictedPaths(git(['status', '--porcelain'])) }
}

/**
 * A file that no longer exists is not evidence of an unresolved conflict: deleting it is a
 * legitimate resolution when one side removed it.
 */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function markersCommand() {
  const found = []
  for (const path of values.path ?? []) {
    const text = readOrNull(path)
    if (text === null) continue
    for (const marker of conflictMarkerLines(text)) found.push({ path, ...marker })
  }
  return { found }
}

const COMMANDS = { name: nameCommand, conflicts: conflictsCommand, markers: markersCommand }

const command = COMMANDS[positionals[0]]
if (!command) {
  process.stderr.write(`Unknown command '${positionals[0] ?? ''}'. Expected one of: ${Object.keys(COMMANDS).join(', ')}\n`)
  process.exit(2)
}

process.stdout.write(`${JSON.stringify(command())}\n`)
