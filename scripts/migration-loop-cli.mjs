#!/usr/bin/env node
/**
 * Drives `migration-loop.mjs` against a real checkout: the assessor is `claude --print`, the
 * runner is `run-plans.ps1`, the log is committed on whichever branch is checked out.
 *
 *   node C:/code/agentic-loop/scripts/migration-loop-cli.mjs \
 *     --target docs/frontend-target-architecture.md \
 *     --log docs/frontend-migration-log.md \
 *     --max-ticks 3 --runner-arg=-SkipPreflight
 *
 * Runner switches start with a dash, so they must be given as `--runner-arg=-Switch`: Node's
 * argument parser reads a separate `-Switch` as another option and refuses it.
 *
 * Run from the target repository's root. Everything that runs is logged under `plans/logs/`:
 * one `migration-tick-N.<stamp>.jsonl` per assessor session, next to the runner's own logs.
 *
 * Commits: this tool commits the migration log twice per tick (after the assessment, after the
 * run) so the runner always finds a clean tree. Starting it is the authorization; there is nobody
 * in the session to ask. It commits nothing else, and it refuses to start on a dirty tree.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { composePrompt, describeOutcomes, runLoop } from './migration-loop.mjs'
import { porcelainPaths } from './plan-tree.mjs'
import { readRateLimit, resumeDelay } from './rate-limit.mjs'

const runnerRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      log: { type: 'string' },
      'max-ticks': { type: 'string', default: '1' },
      'max-plans': { type: 'string', default: '3' },
      model: { type: 'string', default: 'opus' },
      effort: { type: 'string', default: 'xhigh' },
      'assess-timeout-minutes': { type: 'string', default: '60' },
      'rate-limit-wait-minutes': { type: 'string', default: '360' },
      'runner-arg': { type: 'string', multiple: true, default: [] },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (!values.target || !values.log) {
    throw new Error('usage: migration-loop-cli.mjs --target <doc> --log <log> [--max-ticks N] [--max-plans N] [--runner-arg=-Switch]... [--dry-run]')
  }
  return values
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd()
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

/** Run a child, stdout to a file and (assistant text only) to the console, with a wall clock. */
function runCaptured({ file, args, stdinFile, stdoutFile, timeoutMinutes, cwd, onLine }) {
  return new Promise((resolvePromise, reject) => {
    const out = openSync(stdoutFile, 'w')
    const err = openSync(`${stdoutFile}.stderr.txt`, 'w')
    const child = spawn(file, args, { cwd, stdio: [openSync(stdinFile, 'r'), 'pipe', err], shell: false })
    let pending = ''
    child.stdout.on('data', (chunk) => {
      writeFileSync(out, chunk)
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop()
      lines.forEach(onLine)
    })
    const timer = setTimeout(() => child.kill(), timeoutMinutes * 60_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise(code)
    })
  })
}

function consoleLineFor(jsonlLine) {
  try {
    const record = JSON.parse(jsonlLine)
    if (record.type !== 'assistant') return null
    const texts = (record.message?.content ?? []).filter((b) => b.type === 'text' && b.text?.trim())
    return texts.map((b) => `  | ${b.text.trim().split('\n')[0].slice(0, 160)}`).join('\n') || null
  } catch {
    return null
  }
}

function claudeArgs(values) {
  return [
    '--print', '--verbose', '--output-format', 'stream-json',
    '--model', values.model, '--effort', values.effort,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite', 'Task',
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git:*)',
  ]
}

function claudePath() {
  const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Node refuses to spawn a .cmd shim without a shell, and a shell would re-parse the
    // allow-list's parentheses - so on Windows only the native claude.exe will do.
    .find((line) => line && (process.platform !== 'win32' || /\.exe$/i.test(line)))
  if (!found) throw new Error("'claude' CLI not found on PATH (on Windows the native claude.exe is required)")
  return found
}

function buildDeps({ repoRoot, values }) {
  const plansDir = join(repoRoot, 'plans')
  const logsDir = join(plansDir, 'logs')
  const logPath = resolve(repoRoot, values.log)
  const logRel = relative(repoRoot, logPath).replace(/\\/g, '/')
  const template = readFileSync(join(runnerRoot, 'prompt', 'migration-assess.md'), 'utf8')
  const claude = claudePath()
  mkdirSync(logsDir, { recursive: true })

  const listPlans = () => readdirSync(plansDir).filter((name) => /^\d+[-_].+\.md$/.test(name))
  const say = (line) => process.stdout.write(`[migration-loop ${new Date().toLocaleTimeString()}] ${line}\n`)

  async function assess({ tick, lastOutcomes }) {
    const prompt = composePrompt(template, {
      TICK: tick,
      MAX_PLANS: values['max-plans'],
      RUNNER_ROOT: runnerRoot.replace(/\\/g, '/'),
      TARGET: values.target.replace(/\\/g, '/'),
      LOG: logRel,
      REPORTS_DIR: 'plans/reports',
      PLANS_DIR: 'plans',
      DATE: new Date().toISOString().slice(0, 10),
      LAST_OUTCOMES: describeOutcomes(lastOutcomes, tick),
    })
    const promptFile = join(logsDir, `migration-tick-${tick}.${stamp()}.prompt.md`)
    const transcriptFile = promptFile.replace(/\.prompt\.md$/, '.jsonl')
    writeFileSync(promptFile, prompt, 'utf8')
    const code = await runCaptured({
      file: claude, args: claudeArgs(values), stdinFile: promptFile, stdoutFile: transcriptFile,
      timeoutMinutes: Number(values['assess-timeout-minutes']), cwd: repoRoot,
      onLine: (line) => { const shown = consoleLineFor(line); if (shown) process.stdout.write(`${shown}\n`) },
    })
    say(`assessor exited ${code}; transcript ${relative(repoRoot, transcriptFile)}`)
    const transcript = readFileSync(transcriptFile, 'utf8')
    const limit = readRateLimit(transcriptFile)
    if (!limit.limited) return { transcript, limited: false }
    const delay = resumeDelay(limit, { now: Date.now() / 1000, maxWaitSeconds: Number(values['rate-limit-wait-minutes']) * 60 })
    return { transcript, limited: true, waitSeconds: delay.wait ? delay.seconds : null }
  }

  function dirtyPaths() {
    const lines = git(repoRoot, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean)
    return lines
      .filter((line) => !(line.startsWith('??') && /^plans\/\d+[-_].+\.md$/.test(porcelainPaths(line)[0] ?? '')))
      .flatMap(porcelainPaths)
  }

  function commitLog(message) {
    if (git(repoRoot, ['status', '--porcelain', '--', logRel]) === '') return
    git(repoRoot, ['add', '--', logRel])
    git(repoRoot, ['commit', '-q', '-m', message, '--', logRel])
    say(`committed: ${message}`)
  }

  function runPlans(planFiles) {
    const runner = join(runnerRoot, 'scripts', 'run-plans.ps1')
    const quote = (s) => `'${s.replace(/'/g, "''")}'`
    const only = planFiles.map((name) => quote(name.replace(/\.md$/, ''))).join(',')
    // -StopOnFailure always: a tick's plans run in order against each other's trees, so the
    // plan behind a failure has nothing valid to run on, and the loop halts on it anyway.
    const command = `& ${quote(runner)} -Only ${only} -StopOnFailure ${values['runner-arg'].join(' ')}; exit $LASTEXITCODE`
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    return new Promise((resolvePromise, reject) => {
      const child = spawn(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: repoRoot, stdio: 'inherit' })
      child.on('error', reject)
      child.on('close', resolvePromise)
    })
  }

  function readState() {
    const file = join(plansDir, '.state.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}
  }

  return {
    readLog: () => readFileSync(logPath, 'utf8'),
    writeLog: (text) => writeFileSync(logPath, text, 'utf8'),
    listPlans, assess, dirtyPaths, commitLog, runPlans, readState, say,
    now: () => new Date().toISOString(),
    sleep: (seconds) => new Promise((r) => setTimeout(r, seconds * 1000)),
    logPath: logRel,
  }
}

async function main() {
  const values = readOptions(process.argv.slice(2))
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  for (const file of [values.target, values.log]) {
    if (!existsSync(resolve(repoRoot, file))) throw new Error(`${file} does not exist under ${repoRoot}`)
  }
  const deps = buildDeps({ repoRoot, values })
  const dirty = deps.dirtyPaths()
  if (dirty.length > 0) throw new Error(`the tree is dirty; the runner would refuse it: ${dirty.join(', ')}`)

  deps.say(`branch ${git(repoRoot, ['branch', '--show-current'])}; target ${values.target}; log ${values.log}; up to ${values['max-ticks']} tick(s)`)
  const result = await runLoop(deps, {
    maxTicks: Number(values['max-ticks']),
    dryRun: values['dry-run'],
    logPath: deps.logPath,
  })
  deps.say(`stopped after ${result.ticks.length} tick(s): ${result.reason}`)
}

main().catch((error) => {
  process.stderr.write(`migration-loop: ${error.message}\n`)
  process.exit(1)
})
