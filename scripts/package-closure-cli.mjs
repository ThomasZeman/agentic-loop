#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to turn what a plan's diff touched into what it has to be
 * verified against. It replies on stdout as JSON.
 *
 *   node package-closure-cli.mjs --changed frontend-shared
 *     -> {"packages":["frontend-boardfest","frontend-shared"]}
 *
 * The graph is read here from the manifests under `packages/` rather than passed in, for the same
 * reason plan-tree-cli.mjs reads the working tree itself: the caller knows what changed, not what
 * builds on it.
 *
 * Reporting only: the exit code says whether the question could be answered, never what the
 * answer was. The expansion itself lives in package-closure.mjs, where it is tested.
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { dependentsOf, readManifests } from './package-closure.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    // Repeatable. Each is a `packages/<name>` directory the plan changed, as
    // run-plans.ps1's Get-ChangedPackages spells them.
    changed: { type: 'string', multiple: true },
    'packages-dir': { type: 'string' },
  },
})

const packagesDir = values['packages-dir'] ?? path.join(REPO_ROOT, 'packages')
const packages = dependentsOf(values.changed ?? [], readManifests(packagesDir))

process.stdout.write(`${JSON.stringify({ packages })}\n`)
