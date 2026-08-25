/**
 * The dev servers a plan needs running before it can look at the real app, and the
 * questions `run-plans.ps1` asks about them.
 *
 * Rule 4 of `plans/_preamble.md` tells an unattended plan to verify a user-visible change in
 * a browser, and `scripts/launch-test-players.ps1` needs "the backend and the dev server
 * already running" to do it. Nothing used to make that true: whether a plan could open the
 * app at all depended on what happened to be running on the machine when the queue started.
 * The runner now guarantees it for the whole batch, and this module holds the parts of that
 * worth testing - PowerShell keeps only what it is good at, which is starting a detached
 * process and killing it again.
 *
 * Addressed as 127.0.0.1 rather than localhost on purpose: both servers bind 0.0.0.0, which
 * is IPv4 only, while `localhost` on Windows resolves to ::1 first. A probe through the name
 * can therefore fail against a server that is up and answering.
 */

import { get as httpGet } from 'node:http'

/** How long each poll waits for a single answer before treating it as no answer. */
const PROBE_TIMEOUT_MS = 4000

/** Gap between polls while waiting for a server to come up. */
const POLL_INTERVAL_MS = 2000

export const DEV_SERVERS = Object.freeze([
  Object.freeze({
    name: 'backend',
    url: 'http://127.0.0.1:3005/',
    packageDir: 'packages/backend',
    npmScript: 'dev',
    // tsx compiles the whole server on boot; a cold start on this repo is tens of seconds.
    startTimeoutSeconds: 180,
    // Any status at all. There is no health route, so the root answers 404 - which only a
    // running server can do. Waiting for a 200 there would wait forever.
    isReady: (status) => status > 0,
    readiness: 'any HTTP status (no health route; a 404 at / is a live server)',
  }),
  Object.freeze({
    name: 'frontend',
    url: 'http://127.0.0.1:1701/boardbash/',
    packageDir: 'packages/frontend-boardfest',
    npmScript: 'start',
    // `npm start` clears .parcel-cache first, so every start this runner makes is a cold build.
    startTimeoutSeconds: 420,
    // Parcel accepts connections immediately and holds the request until its build finishes,
    // so only a served page means ready.
    isReady: (status) => status === 200,
    readiness: 'HTTP 200 (Parcel answers before its first build is done)',
  }),
])

/**
 * The workspace packages Parcel compiles into the bundle but never watches.
 *
 * `frontend-boardfest` imports both through the `node_modules/@nocap/*` workspace symlinks,
 * and Parcel's watcher ignores node_modules - so editing one produces no rebuild at all.
 * The result is worse than a stale bundle: files inside `frontend-boardfest` do rebuild, so
 * the served JS mixes new code against old, which type-checks, builds, and breaks only at
 * runtime. Restarting the dev server is the only remedy in the tree.
 */
export const WATCHER_BLIND_PACKAGES = Object.freeze(['shared', 'frontend-shared'])

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

export function findDevServer(name) {
  const server = DEV_SERVERS.find((candidate) => candidate.name === name)
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

export async function probeAll(servers = DEV_SERVERS, options = {}) {
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

/** Did this plan change something the running Parcel will never notice? */
export function needsFrontendRestart(changedPackages) {
  return (changedPackages ?? []).some((name) => WATCHER_BLIND_PACKAGES.includes(name))
}
