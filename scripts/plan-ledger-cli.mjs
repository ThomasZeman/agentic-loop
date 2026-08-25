#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to ask which plans are already finished with, answering
 * on stdout as JSON: `{"settled": ["07-thing.md", ...]}`.
 *
 * It reads both records itself rather than taking either from PowerShell. `.state.json` is
 * written with a BOM, which JSON.parse rejects outright; and the tracked-file listing has to
 * be filtered by hand, since git's pathspec matcher would fold every report into it (see
 * plan-ledger.mjs).
 *
 * Reporting only - the exit code says whether the question could be answered, never what the
 * answer was.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { settledPlanNames } from './plan-ledger.mjs'

const BOM = '﻿'

function readState(statePath) {
  if (!existsSync(statePath)) return {}
  const raw = readFileSync(statePath, 'utf8')
  const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw
  return withoutBom.trim() ? JSON.parse(withoutBom) : {}
}

// -z, so a path git would otherwise quote arrives intact. The pathspec is the whole
// directory on purpose; plan-ledger.mjs decides which of those paths is a plan.
function readTrackedPlanPaths() {
  const listing = execFileSync('git', ['ls-files', '-z', '--', 'plans'], { encoding: 'utf8' })
  return listing.split('\0').filter(Boolean)
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { state: { type: 'string' } },
})

const statePath = values.state ?? path.join(process.cwd(), 'plans', '.state.json')
const settled = settledPlanNames({
  state: readState(statePath),
  trackedPaths: readTrackedPlanPaths(),
})

process.stdout.write(`${JSON.stringify({ settled: [...settled] })}\n`)
