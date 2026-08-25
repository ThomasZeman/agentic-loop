/**
 * The dev servers a plan needs running before it can look at the real app, and the
 * questions `run-plans.ps1` asks about them.
 *
 * The preamble tells an unattended plan to verify a user-visible change in a browser, and
 * that needs the app's servers already running. Left to chance, whether a plan can open the
 * app at all depends on what happens to be running on the machine when the queue starts.
 * The runner guarantees it for the whole batch instead, and this module holds the parts of
 * that worth testing - PowerShell keeps only what it is good at, which is starting a
 * detached process and killing it again.
 *
 * Which servers exist is the target project's business, not this module's: the table comes
 * from `plans/runner.json` (see runner-config.mjs), and the default is no servers at all. A
 * project served by no dev server leaves `devServers` out (or declares `[]`) and the runner
 * skips the whole arrangement.
 *
 * Servers are best addressed as 127.0.0.1 rather than localhost: a server binding 0.0.0.0
 * is IPv4 only, while `localhost` on Windows resolves to ::1 first, so a probe through the
 * name can fail against a server that is up and answering.
 */

import { get as httpGet } from 'node:http'

import { readinessOf } from './runner-config.mjs'

/** How long each poll waits for a single answer before treating it as no answer. */
const PROBE_TIMEOUT_MS = 4000

/** Gap between polls while waiting for a server to come up. */
const POLL_INTERVAL_MS = 2000

/**
 * The resolved config's server list as probe-ready descriptors: each entry as declared,
 * plus the `isReady` predicate its `readyWhen` stands for.
 */
export function serverTable(config) {
  return config.devServers.map((server) => ({ ...server, isReady: readinessOf(server) }))
}

/**
 * A GET that yields only the status, and keeps not one socket open once it has it.
 *
 * node:http rather than fetch, which is the obvious choice here and was the first one tried:
 * fetch pools its connections, and the process then died on exit with a libuv assertion
 * (`UV_HANDLE_CLOSING`) instead of returning the exit code it had chosen - which the runner
 * read as a server that never came up. `agent: false` plus `Connection: close` means the
 * socket belongs to this request alone and is gone with it.
 */
function statusOf(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false, headers: { connection: 'close' } }, (response) => {
      // Drained rather than read: the body is of no interest, but an unread one holds the
      // socket open until the server gives up on it.
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`no answer within ${timeoutMs}ms`))
    })
    request.on('error', reject)
  })
}

/**
 * Node's fetch reports every connection failure as a bare `fetch failed` and hides the real
 * reason on `.cause`, which is exactly the part the runner's log needs.
 */
function describeFailure(error) {
  const message = error?.message ?? String(error)
  const cause = error?.cause?.message
  return cause ? `${message}: ${cause}` : message
}

export function findDevServer(servers, name) {
  const server = servers.find((candidate) => candidate.name === name)
  if (!server) throw new Error(`unknown dev server '${name}'`)
  return server
}

/**
 * Asks one server whether it is up. Never throws: a refused connection is the answer, not a
 * fault, and this is polled in a loop by a runner that must not die on it.
 */
export async function probeServer(server, { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const status = fetchImpl
      ? (await fetchImpl(server.url, { timeoutMs })).status
      : await statusOf(server.url, timeoutMs)
    if (server.isReady(status)) {
      return { name: server.name, up: true, detail: `HTTP ${status}` }
    }
    return { name: server.name, up: false, detail: `HTTP ${status} - not ready yet` }
  } catch (error) {
    return { name: server.name, up: false, detail: describeFailure(error) }
  }
}

export async function probeAll(servers, options = {}) {
  const probes = []
  for (const server of servers) probes.push(await probeServer(server, options))
  return probes
}

/**
 * Polls one server until it answers or the deadline passes.
 *
 * The clock and the sleep are injected so the wait can be tested without one, and so a
 * caller can hold a whole batch's start-up to one budget.
 */
export async function waitForServer(server, options = {}) {
  const {
    timeoutSeconds = server.startTimeoutSeconds,
    intervalMs = POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    ...probeOptions
  } = options

  const deadline = now() + timeoutSeconds * 1000
  let probe = await probeServer(server, probeOptions)
  while (!probe.up && now() < deadline) {
    await sleep(intervalMs)
    probe = await probeServer(server, probeOptions)
  }
  return { ...probe, timedOut: !probe.up }
}

/** Splits a set of probes into what is already listening and what the runner must start. */
export function planServerStartup(probes) {
  return {
    adopt: probes.filter((probe) => probe.up).map((probe) => probe.name),
    start: probes.filter((probe) => !probe.up).map((probe) => probe.name),
  }
}

/**
 * Did this plan change a package the frontend bundler compiles in but never watches?
 * The blind list is the target project's, from its runner config.
 */
export function needsFrontendRestart(changedPackages, watcherBlindPackages) {
  return (changedPackages ?? []).some((name) => watcherBlindPackages.includes(name))
}
