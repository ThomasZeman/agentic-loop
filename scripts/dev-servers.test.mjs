import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { describe, test } from 'node:test'

import {
  findDevServer,
  needsFrontendRestart,
  planServerStartup,
  probeServer,
  serverTable,
  waitForServer,
} from './dev-servers.mjs'
import { resolveRunnerConfig } from './runner-config.mjs'

// The default table is Boardbash's own pair, per runner-config.mjs - so the descriptors the
// suite drives are exactly what a config-less run gets.
const servers = serverTable(resolveRunnerConfig(null))
const backend = findDevServer(servers, 'backend')
const frontend = findDevServer(servers, 'frontend')
const defaultBlind = resolveRunnerConfig(null).watcherBlindPackages

/** A fetch that answers each call from the queue, so a poll can be scripted turn by turn. */
function scriptedFetch(answers) {
  const queue = [...answers]
  return async () => {
    const answer = queue.length > 1 ? queue.shift() : queue[0]
    if (answer instanceof Error) throw answer
    return { status: answer }
  }
}

describe('serverTable', () => {
  test('turns the default config into both halves of the running app', () => {
    assert.deepEqual(servers.map((server) => server.name), ['backend', 'frontend'])
    assert.equal(backend.url, 'http://127.0.0.1:3005/')
    assert.equal(frontend.url, 'http://127.0.0.1:1701/boardbash/')
  })

  test("derives each server's probe predicate from its declared readyWhen", () => {
    const table = serverTable(resolveRunnerConfig({
      devServers: [
        { name: 'lenient', url: 'u', packageDir: 'd', npmScript: 's', readyWhen: 'any-response' },
        { name: 'strict', url: 'u', packageDir: 'd', npmScript: 's', readyWhen: 'http-200' },
      ],
    }))
    assert.equal(table[0].isReady(404), true)
    assert.equal(table[1].isReady(404), false)
    assert.equal(table[1].isReady(200), true)
  })

  test('an empty table is a project with no dev servers, not a fault', () => {
    assert.deepEqual(serverTable(resolveRunnerConfig({ devServers: [] })), [])
  })
})

describe('findDevServer', () => {
  test('answers by name, and an unknown name is a fault rather than undefined', () => {
    assert.equal(findDevServer(servers, 'frontend').npmScript, 'start')
    assert.throws(() => findDevServer(servers, 'database'), /unknown dev server 'database'/)
  })
})

describe('probeServer', () => {
  test('reads any HTTP status from the backend as a live server', async () => {
    // Fastify has no health route, so the root answers 404 - which only a running
    // server can do. Demanding a 200 there would wait for a readiness it never reports.
    const probe = await probeServer(backend, { fetchImpl: scriptedFetch([404]) })
    assert.equal(probe.up, true)
    assert.equal(probe.name, 'backend')
    assert.match(probe.detail, /404/)
  })

  test('holds the frontend to a 200, since Parcel answers before its build is done', async () => {
    const probe = await probeServer(frontend, { fetchImpl: scriptedFetch([503]) })
    assert.equal(probe.up, false)
    assert.match(probe.detail, /503/)
  })

  test('reports a refused connection as down rather than throwing', async () => {
    const probe = await probeServer(backend, {
      fetchImpl: scriptedFetch([new Error('connect ECONNREFUSED 127.0.0.1:3005')]),
    })
    assert.equal(probe.up, false)
    assert.match(probe.detail, /ECONNREFUSED/)
  })

  test('unwraps the cause, which is the only place fetch puts the real reason', async () => {
    // Node's fetch reports every connection failure as a bare 'fetch failed'; without this
    // the runner's log says nothing about whether the port was refused, timed out, or hung.
    const wrapped = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:1701'),
    })
    const probe = await probeServer(frontend, { fetchImpl: scriptedFetch([wrapped]) })
    assert.equal(probe.detail, 'fetch failed: connect ECONNREFUSED 127.0.0.1:1701')
  })
})

describe('probeServer, over a real socket', () => {
  /** A one-request server on an ephemeral port, so the default probe path is the one tested. */
  async function servedBy(status) {
    const server = createServer((_req, res) => {
      res.writeHead(status)
      res.end('hello')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { server, url: `http://127.0.0.1:${server.address().port}/` }
  }

  test('reads the status of a server that is actually listening', async () => {
    const { server, url } = await servedBy(200)
    try {
      const probe = await probeServer({ name: 'stub', url, isReady: (status) => status === 200 })
      assert.equal(probe.up, true)
      assert.equal(probe.detail, 'HTTP 200')
    } finally {
      server.close()
    }
  })

  test('leaves no socket behind, so the caller can exit the moment it has its answer', async () => {
    // Node's fetch pools its connections and the process crashed on exit with a libuv
    // assertion (UV_HANDLE_CLOSING) rather than returning the exit code it had chosen -
    // which the runner read as "the server never came up".
    const { server, url } = await servedBy(404)
    try {
      const stub = { name: 'stub', url, isReady: (status) => status > 0 }
      await probeServer(stub)
      await probeServer(stub)
      await new Promise((resolve) => server.getConnections((_error, count) => resolve(count)))
      const open = await new Promise((resolve) => server.getConnections((_error, count) => resolve(count)))
      assert.equal(open, 0)
    } finally {
      server.close()
    }
  })

  test('reports a port nothing is listening on as down', async () => {
    const { server, url } = await servedBy(200)
    await new Promise((resolve) => server.close(resolve))
    const probe = await probeServer({ name: 'stub', url, isReady: () => true })
    assert.equal(probe.up, false)
    assert.match(probe.detail, /ECONNREFUSED/)
  })
})

describe('waitForServer', () => {
  test('keeps polling until the server answers', async () => {
    const slept = []
    const probe = await waitForServer(frontend, {
      fetchImpl: scriptedFetch([new Error('ECONNREFUSED'), 503, 200]),
      sleep: async (ms) => { slept.push(ms) },
      now: () => 0,
      intervalMs: 2000,
    })
    assert.equal(probe.up, true)
    assert.deepEqual(slept, [2000, 2000])
  })

  test('gives up at the deadline and says what it last saw', async () => {
    let clock = 0
    const probe = await waitForServer(frontend, {
      fetchImpl: scriptedFetch([new Error('ECONNREFUSED')]),
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      intervalMs: 2000,
      timeoutSeconds: 6,
    })
    assert.equal(probe.up, false)
    assert.equal(probe.timedOut, true)
    assert.match(probe.detail, /ECONNREFUSED/)
  })

  test('never sleeps when the server is up on the first ask', async () => {
    const slept = []
    const probe = await waitForServer(backend, {
      fetchImpl: scriptedFetch([200]),
      sleep: async (ms) => { slept.push(ms) },
      now: () => 0,
    })
    assert.equal(probe.up, true)
    assert.deepEqual(slept, [])
  })
})

describe('planServerStartup', () => {
  test('adopts what is already listening and starts only the rest', () => {
    const plan = planServerStartup([
      { name: 'backend', up: true, detail: 'HTTP 404' },
      { name: 'frontend', up: false, detail: 'ECONNREFUSED' },
    ])
    assert.deepEqual(plan, { adopt: ['backend'], start: ['frontend'] })
  })

  test('starts nothing when the whole app is already up', () => {
    const plan = planServerStartup([
      { name: 'backend', up: true, detail: 'HTTP 404' },
      { name: 'frontend', up: true, detail: 'HTTP 200' },
    ])
    assert.deepEqual(plan.start, [])
  })
})

describe('needsFrontendRestart', () => {
  test('is true for the packages the config says the watcher is blind to', () => {
    // Parcel compiles these into the bundle but its watcher ignores node_modules, so an
    // edit here produces no rebuild at all - and a mixed old/new bundle that only fails
    // at runtime. Restarting the dev server is the only remedy in the tree.
    assert.equal(needsFrontendRestart(['shared'], defaultBlind), true)
    assert.equal(needsFrontendRestart(['frontend-shared'], defaultBlind), true)
    assert.equal(needsFrontendRestart(['backend', 'shared'], defaultBlind), true)
  })

  test('is false for packages the watcher does see, and for none at all', () => {
    assert.equal(needsFrontendRestart(['frontend-boardfest'], defaultBlind), false)
    assert.equal(needsFrontendRestart(['backend'], defaultBlind), false)
    assert.equal(needsFrontendRestart([], defaultBlind), false)
    assert.equal(needsFrontendRestart(null, defaultBlind), false)
    assert.equal(needsFrontendRestart(['shared'], []), false)
  })
})
