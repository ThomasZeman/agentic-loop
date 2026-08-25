#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to ask about the dev servers a plan needs, answering on
 * stdout as JSON. The server table and the watcher-blind package list come from the target
 * repo's `plans/runner.json`, read from the working directory - which is the repo root, the
 * place the runner starts every bridge.
 *
 * Three questions, one per mode:
 *
 *   --probe                    which servers are up right now, and which must be started
 *   --wait [--server <name>]   poll until they answer, or give up at the deadline
 *   --stale-bundle <pkg...>    did this plan change something the bundler will never notice?
 *
 * Reporting only, with one deliberate exception: `--wait` exits 1 when a server never came
 * up, because that is the one answer PowerShell acts on directly and a JSON round-trip to
 * learn it would buy nothing. The other modes always exit 0 - the exit code says the
 * question could be answered, never what the answer was.
 */
import { parseArgs } from 'node:util'

import {
  findDevServer,
  needsFrontendRestart,
  planServerStartup,
  probeAll,
  serverTable,
  waitForServer,
} from './dev-servers.mjs'
import { loadRunnerConfig } from './runner-config.mjs'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    probe: { type: 'boolean' },
    wait: { type: 'boolean' },
    'stale-bundle': { type: 'boolean' },
    // Repeatable. Narrows --probe/--wait to these servers; all of them by default.
    server: { type: 'string', multiple: true },
    // Seconds, overriding the per-server default. 0 or absent keeps the default.
    timeout: { type: 'string' },
  },
})

const config = loadRunnerConfig(process.cwd())
const servers = serverTable(config)

function say(answer) {
  process.stdout.write(`${JSON.stringify(answer)}\n`)
}

function chosenServers() {
  const names = values.server ?? []
  if (names.length === 0) return servers
  return names.map((name) => findDevServer(servers, name))
}

function timeoutSecondsFor(server) {
  const asked = Number(values.timeout ?? 0)
  if (Number.isFinite(asked) && asked > 0) return asked
  return server.startTimeoutSeconds
}

if (values['stale-bundle']) {
  say({ restartFrontend: needsFrontendRestart(positionals, config.watcherBlindPackages) })
  process.exit(0)
}

if (values.wait) {
  const probes = []
  for (const server of chosenServers()) {
    probes.push(await waitForServer(server, { timeoutSeconds: timeoutSecondsFor(server) }))
  }
  const down = probes.filter((probe) => !probe.up)
  say({ servers: probes, allUp: down.length === 0 })
  process.exit(down.length === 0 ? 0 : 1)
}

if (values.probe) {
  const probes = await probeAll(chosenServers())
  // Answered with the descriptor merged in, so PowerShell knows what to run and where to run
  // it without keeping a second copy of the table the config already holds.
  const described = probes.map((probe) => {
    const { name, url, packageDir, npmScript, readiness, startTimeoutSeconds } = findDevServer(servers, probe.name)
    return { ...probe, name, url, packageDir, npmScript, readiness, startTimeoutSeconds }
  })
  say({ servers: described, ...planServerStartup(probes) })
  process.exit(0)
}

process.stderr.write('usage: dev-servers-cli.mjs --probe | --wait [--server <name>] | --stale-bundle <pkg...>\n')
process.exit(2)
