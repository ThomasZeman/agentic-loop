#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to decide whether a failed plan gets a repair session, and
 * to audit what that session did, answering on stdout as JSON.
 *
 *   node scripts/plan-repair-cli.mjs assess --problems-file <path-to-json-array>
 *   node scripts/plan-repair-cli.mjs audit --since <sha>
 *
 * The problems arrive in a file rather than as arguments: they carry quotes, pipes and "->",
 * and PowerShell's Start-Process joins its argument list with spaces, so passing them along
 * the command line mangles them. The file may well have a BOM on it - Set-Content -Encoding
 * UTF8 on PowerShell 5.1 writes one - which is stripped here for the reason plan-branch-cli.mjs
 * gives: it would otherwise arrive glued to the first string.
 *
 * Reporting only - the exit code says whether the question could be answered, never what the
 * answer was.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { forbiddenRepairPaths, isRepairable, repairableProblems } from './plan-repair.mjs'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'problems-file': { type: 'string' },
    since: { type: 'string' },
  },
})

function fail(message) {
  console.error(message)
  process.exit(2)
}

function readProblems(path) {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '').trim()
  if (raw === '') return []
  const parsed = JSON.parse(raw)
  // Three shapes, because PowerShell 5.1's ConvertTo-Json has two traps and the runner is the
  // only caller. Piping a one-item array gives a bare string rather than an array; wrapping it
  // in a unary comma to stop that gives {"value":[...],"Count":n} instead. `-InputObject` is
  // the form that yields a plain array either way and is what run-plans.ps1 uses - the other
  // two are accepted so a later edit reaching for the obvious pipe cannot silently turn every
  // repair off, which is exactly how this was found.
  if (typeof parsed === 'string') return [parsed]
  if (Array.isArray(parsed)) return parsed.map(String)
  if (Array.isArray(parsed?.value)) return parsed.value.map(String)
  fail(`${path} holds ${typeof parsed}, expected a JSON array of problem strings`)
}

function changedSince(sha) {
  return execFileSync('git', ['diff', '--name-only', `${sha}..HEAD`], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

const command = positionals[0]

if (command === 'assess') {
  if (!values['problems-file']) fail('assess needs --problems-file <path>')
  const problems = readProblems(values['problems-file'])
  console.log(JSON.stringify({ repairable: isRepairable(problems), problems: repairableProblems(problems) }))
}
else if (command === 'audit') {
  if (!values.since) fail('audit needs --since <sha>')
  const changed = changedSince(values.since)
  console.log(JSON.stringify({ changed, forbidden: forbiddenRepairPaths(changed) }))
}
else {
  fail('usage: plan-repair-cli.mjs assess --problems-file <path> | audit --since <sha>')
}
