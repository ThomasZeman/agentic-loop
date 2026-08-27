/**
 * The per-project configuration of the plan runner, read from `plans/runner.json` in the
 * repo the runner is pointed at.
 *
 * The defaults are neutral: generic npm conventions (a `packages/` workspace, `test` and
 * `test:visual` scripts, the quality ratchet on), no dev servers, no watcher-blind packages
 * and no hooks. A project declares what it has - its own dev servers, its blind packages,
 * its hooks - and overrides only the gate values that differ, all in its own
 * `plans/runner.json`.
 *
 * Resolution is strict rather than forgiving. This file is read at the start of an
 * unattended overnight run; a typo silently ignored here surfaces eight hours later as a
 * batch verified against the wrong gates. Unknown keys, unknown gates, and malformed server
 * entries are all refused with the name of the offender.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const CONFIG_FILE_RELATIVE_PATH = 'plans/runner.json'

/** What `readyWhen` may say, and the probe predicate plus report wording each choice means. */
const READINESS = Object.freeze({
  'any-response': Object.freeze({
    isReady: (status) => status > 0,
    readiness: 'any HTTP status',
  }),
  'http-200': Object.freeze({
    isReady: (status) => status === 200,
    readiness: 'HTTP 200',
  }),
})

export const READY_WHEN_CHOICES = Object.freeze(Object.keys(READINESS))

const SERVER_DEFAULTS = Object.freeze({
  startTimeoutSeconds: 180,
  readyWhen: 'any-response',
})

const SERVER_REQUIRED_FIELDS = Object.freeze(['name', 'url', 'packageDir', 'npmScript'])

export const DEFAULT_CONFIG = Object.freeze({
  /**
   * Repo-relative directory holding one workspace package per subdirectory. An empty string
   * (or `.`) means the packages are the repo root's own subdirectories - a project with no
   * workspace wrapper. In that shape the startup existence check cannot warn about anything,
   * because the repo root always exists.
   */
  packagesDir: 'packages',
  gates: Object.freeze({
    /** The per-package unit suite; a package without this script is not gated by it. */
    test: Object.freeze({ script: 'test', timeoutMinutes: 20 }),
    /** The per-package browser suite, gated by its JSON report. */
    visual: Object.freeze({
      script: 'test:visual',
      timeoutMinutes: 30,
      report: 'test-results/visual-report.json',
    }),
    /** The tsc/eslint count ratchet. Off means no counts are taken at all. */
    quality: Object.freeze({ enabled: true, timeoutMinutes: 15 }),
  }),
  /** The app the runner brings up for a batch; none means plans verify in the test harness. */
  devServers: Object.freeze([]),
  /**
   * Workspace packages the frontend bundler compiles in but never watches, so a merge
   * touching one silently stales the served bundle until the frontend server restarts.
   */
  watcherBlindPackages: Object.freeze([]),
  /**
   * Commands the runner calls at defined moments, each off (null) unless the project names
   * one. A command is a list: the program first - a PATH name or a repo-relative path - then
   * its arguments; the runner appends its own and runs it from the repo root. Contracts are
   * spelled out in the README.
   */
  hooks: Object.freeze({
    /** `--plans-dir <dir> --siblings-after <plan file>` -> JSON list of plan files to skip. */
    siblingsAfter: null,
    /** `post|clear --plan <path> [--version <v>]` -> JSON `{posted, shots, issue}`. */
    demo: null,
    /**
     * `--plan <plan file>`, run after every plan whatever its outcome: the project's own sweep
     * of what a dead session may have left behind (a browser window, a device state). Output
     * is optional; a JSON `{note}` is shown. Never fails a plan.
     */
    afterPlan: null,
    /**
     * `{ command, perPlanPlatform, perBatchPlatform }`; `perPlanPlatform` is required,
     * `perBatchPlatform` defaults to null (no batch tag). `tag --platform <p> --log-file <f>`
     * -> `{tag, version, actionsUrl}`; `status --tag <t> [--fallback-url <u>]` ->
     * `{finished, outcome, url}`.
     */
    release: null,
  }),
})

const COMMAND_HOOKS = Object.freeze(['siblingsAfter', 'demo', 'afterPlan'])

const RELEASE_HOOK_DEFAULTS = Object.freeze({
  perBatchPlatform: null,
})

const RELEASE_HOOK_KEYS = Object.freeze(['command', 'perPlanPlatform', ...Object.keys(RELEASE_HOOK_DEFAULTS)])

/** The probe predicate a resolved server's `readyWhen` stands for. */
export function readinessOf(server) {
  return READINESS[server.readyWhen].isReady
}

function fail(message) {
  throw new Error(`runner config: ${message}`)
}

function assertPlainObject(value, what) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`)
  }
}

function assertKnownKeys(overrides, known, describeUnknown) {
  for (const key of Object.keys(overrides)) {
    if (!known.includes(key)) fail(describeUnknown(key))
  }
}

function resolveGates(overrides) {
  assertPlainObject(overrides, 'gates')
  assertKnownKeys(overrides, Object.keys(DEFAULT_CONFIG.gates), (key) => `unknown gate '${key}'`)

  const gates = {}
  for (const [name, defaults] of Object.entries(DEFAULT_CONFIG.gates)) {
    const gate = overrides[name] ?? {}
    assertPlainObject(gate, `gates.${name}`)
    assertKnownKeys(gate, Object.keys(defaults), (key) => `unknown key '${key}' in gates.${name}`)
    gates[name] = { ...defaults, ...gate }
  }
  return gates
}

function resolveServer(entry, index) {
  assertPlainObject(entry, `devServers[${index}]`)
  const label = typeof entry.name === 'string' ? `dev server '${entry.name}'` : `devServers[${index}]`

  for (const field of SERVER_REQUIRED_FIELDS) {
    if (typeof entry[field] !== 'string' || entry[field] === '') {
      fail(`${label} is missing required field '${field}'`)
    }
  }
  assertKnownKeys(
    entry,
    [...SERVER_REQUIRED_FIELDS, ...Object.keys(SERVER_DEFAULTS), 'readiness'],
    (key) => `unknown key '${key}' on ${label}`,
  )

  const server = { ...SERVER_DEFAULTS, ...entry }
  if (!READY_WHEN_CHOICES.includes(server.readyWhen)) {
    fail(`${label} has readyWhen '${server.readyWhen}'; the choices are: ${READY_WHEN_CHOICES.join(', ')}`)
  }
  return { readiness: READINESS[server.readyWhen].readiness, ...server }
}

function isCommand(value) {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part !== '')
}

function resolveCommandHook(name, value) {
  if (value === null || value === undefined) return null
  if (!isCommand(value)) fail(`hooks.${name} must be a non-empty list of strings: the program, then its arguments`)
  return [...value]
}

function resolveReleaseHook(value) {
  if (value === null || value === undefined) return null
  assertPlainObject(value, 'hooks.release')
  assertKnownKeys(value, RELEASE_HOOK_KEYS, (key) => `unknown key '${key}' in hooks.release`)
  if (!isCommand(value.command)) fail('hooks.release.command must be a non-empty list of strings')
  if (typeof value.perPlanPlatform !== 'string' || value.perPlanPlatform === '') {
    fail('hooks.release.perPlanPlatform is required: the platform name each verified plan is tagged for')
  }

  const release = { ...RELEASE_HOOK_DEFAULTS, ...value, command: [...value.command] }
  if (release.perBatchPlatform !== null && typeof release.perBatchPlatform !== 'string') {
    fail('hooks.release.perBatchPlatform must be a platform name or null')
  }
  return release
}

function resolveHooks(overrides) {
  assertPlainObject(overrides, 'hooks')
  assertKnownKeys(overrides, Object.keys(DEFAULT_CONFIG.hooks), (key) => `unknown hook '${key}'`)

  const hooks = {}
  for (const name of COMMAND_HOOKS) hooks[name] = resolveCommandHook(name, overrides[name])
  hooks.release = resolveReleaseHook(overrides.release)
  return hooks
}

function resolveWatcherBlind(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail('watcherBlindPackages must be a list of package names')
  }
  return [...value]
}

/**
 * One spelling of "the repo root", so only one reaches the pattern the runner matches commit
 * paths against. `.`, `./` and a trailing slash all name a directory that exists, so a
 * mis-spelled value would pass the startup check and then match nothing git ever prints -
 * which costs a run its package verification and says nothing about it.
 */
function normalisePackagesDir(value) {
  const trimmed = value.replace(/[/]+$/, '')
  return trimmed === '.' ? '' : trimmed
}

/**
 * Merges one raw config object (or null, standing for a missing file) over the defaults.
 * Pure and throwing: the caller decides what a fault costs.
 */
export function resolveRunnerConfig(raw) {
  const overrides = raw ?? {}
  assertPlainObject(overrides, 'the config')
  assertKnownKeys(overrides, Object.keys(DEFAULT_CONFIG), (key) => `unknown key '${key}'`)

  if (overrides.packagesDir !== undefined && typeof overrides.packagesDir !== 'string') {
    fail('packagesDir must be a string')
  }

  return {
    packagesDir: normalisePackagesDir(overrides.packagesDir ?? DEFAULT_CONFIG.packagesDir),
    gates: resolveGates(overrides.gates ?? {}),
    devServers:
      overrides.devServers === undefined
        ? DEFAULT_CONFIG.devServers.map((server) => ({ ...server }))
        : (Array.isArray(overrides.devServers)
            ? overrides.devServers.map(resolveServer)
            : fail('devServers must be a list')),
    watcherBlindPackages:
      overrides.watcherBlindPackages === undefined
        ? [...DEFAULT_CONFIG.watcherBlindPackages]
        : resolveWatcherBlind(overrides.watcherBlindPackages),
    hooks: resolveHooks(overrides.hooks ?? {}),
  }
}

const BOM = String.fromCharCode(0xfeff)

/**
 * Reads and resolves `plans/runner.json` under the given repo root. A missing file is the
 * defaults; an unreadable or malformed one throws, naming the file - a config half-applied
 * is worse for an unattended run than one refused outright.
 */
export function loadRunnerConfig(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, CONFIG_FILE_RELATIVE_PATH)
  if (!existsSync(file)) return resolveRunnerConfig(null)

  const text = readFileSync(file, 'utf8')
  let raw
  try {
    raw = JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text)
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`)
  }
  try {
    return resolveRunnerConfig(raw)
  } catch (error) {
    throw new Error(`${error.message} (in ${file})`)
  }
}
