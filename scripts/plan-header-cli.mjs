#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to read one plan file's header, answering on stdout as JSON:
 *
 *   { "effort": "high", "declared": false, "problem": null, "body": "# Title\n..." }
 *
 * The body comes back with it rather than being left for PowerShell to re-read, so there is
 * exactly one answer to what the plan says and the front matter cannot reach the prompt by
 * being stripped in one place and not the other.
 *
 * Reporting only: the exit code says whether the file could be read, never whether its header
 * was any good. A bad header is `problem`, and what that costs is the runner's call.
 */
import { readFileSync } from 'node:fs'

import { readPlanHeader } from './plan-header.mjs'

const [path] = process.argv.slice(2)
if (!path) {
  process.stderr.write('usage: plan-header-cli.mjs <plan-file>\n')
  process.exit(2)
}

let text
try {
  text = readFileSync(path, 'utf8')
} catch (error) {
  process.stderr.write(`plan-header-cli: ${error.message}\n`)
  process.exit(1)
}

process.stdout.write(`${JSON.stringify(readPlanHeader(text))}\n`)
