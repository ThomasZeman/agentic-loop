#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls once at startup to learn the target repo's runner
 * configuration, resolved over the defaults. It replies on stdout as JSON.
 *
 *   node runner-config-cli.mjs [--repo-root <dir>]
 *     -> {"packagesDir":"packages","gates":{...},"devServers":[...],...}
 *
 * The repo root defaults to the working directory, which is where the runner starts every
 * bridge. A malformed config file exits 1 with the reason on stderr: this is read before
 * anything else happens, and a run over a half-applied config is the one outcome an
 * unattended queue must not offer.
 */
import process from 'node:process'
import { parseArgs } from 'node:util'

import { loadRunnerConfig } from './runner-config.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'repo-root': { type: 'string' },
  },
})

try {
  const config = loadRunnerConfig(values['repo-root'] ?? process.cwd())
  process.stdout.write(`${JSON.stringify(config)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
