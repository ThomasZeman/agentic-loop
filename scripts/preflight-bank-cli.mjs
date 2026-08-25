#!/usr/bin/env node
/**
 * The bridge `run-plans.ps1` calls to ask whether its pre-flight already knows the visual
 * suite's answer for the base branch, and to record that answer when a plan merges. It replies
 * on stdout as JSON.
 *
 *   node preflight-bank-cli.mjs reuse --commit <sha>
 *     -> {"reuse":true,"visual":{"frontend-boardfest":["DPR-1 | ...", ...]}}
 *
 *   node preflight-bank-cli.mjs bank --commit <new base sha> --from <old base sha>
 *                                    [--changed <package dir>]... [--measured-file <path>]
 *     -> {"banked":true,"commit":"<sha>","packages":["frontend-boardfest"]}
 *
 * Which packages have a visual suite, and what each one's result depends on, is read here from
 * the manifests under `packages/` rather than passed in - the same reason plan-tree-cli.mjs reads
 * the working tree itself. The runner's Get-ChangedPackages is a literal diff of `packages/<name>/`
 * prefixes with no dependent expansion, so the closure has to come from somewhere that knows what
 * `@nocap/frontend-boardfest` builds against: package-closure.mjs, which the runner now asks the
 * same question in the other direction before it verifies a plan.
 *
 * Reporting only: the exit code says whether the question could be answered, never what the
 * answer was. Every decision lives in preflight-bank.mjs, where it is tested.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { dependencyClosure, readManifests } from './package-closure.mjs'
import { decideBank, decideVisualReuse } from './preflight-bank.mjs'
import { loadRunnerConfig } from './runner-config.mjs'

// The working directory is the target repo's root - the runner starts every bridge there.
// The tool itself lives elsewhere, so nothing here may resolve against import.meta.url.
const REPO_ROOT = process.cwd()
const BANK_FILE_NAME = '.preflight-bank.json'

const BOM = String.fromCharCode(0xfeff)

function stripBom(text) {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text
}

/**
 * A JSON file, or null if it is absent or unreadable.
 *
 * The leading BOM matters: PowerShell 5.1's `Out-File -Encoding utf8` writes one, and JSON.parse
 * refuses it - which would turn a perfectly good measurement into a silent miss.
 */
function readJsonFile(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** The packages with a visual suite, and what each one's result depends on. */
function readVisualClosures(packagesDir) {
  const manifests = readManifests(packagesDir)
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]))

  const closure = {}
  for (const manifest of manifests.filter((entry) => entry.hasVisualSuite)) {
    closure[manifest.directory] = dependencyClosure(manifest, byName)
  }
  return { visualPackages: Object.keys(closure).sort(), closure }
}

function writeBank(bankPath, record) {
  if (!record) {
    if (existsSync(bankPath)) rmSync(bankPath, { force: true })
    return { banked: false, commit: null, packages: [] }
  }
  writeFileSync(bankPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { banked: true, commit: record.commit, packages: Object.keys(record.visual).sort() }
}

function answerBank(bankPath, values) {
  const packagesDir =
    values['packages-dir'] ?? path.join(REPO_ROOT, loadRunnerConfig(REPO_ROOT).packagesDir)
  const { visualPackages, closure } = readVisualClosures(packagesDir)
  const measuredFile = values['measured-file']
  const record = decideBank(readJsonFile(bankPath), {
    commit: values.commit ?? null,
    from: values.from ?? null,
    changedPackages: values.changed ?? [],
    visualPackages,
    closure,
    measured: (measuredFile ? readJsonFile(measuredFile) : null) ?? {},
  })
  return writeBank(bankPath, record)
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      commit: { type: 'string' },
      from: { type: 'string' },
      // Repeatable. Each is a `packages/<name>` directory the merge changed, as
      // run-plans.ps1's Get-ChangedPackages spells them.
      changed: { type: 'string', multiple: true },
      // A JSON object of package directory -> failing test ids, from this plan's own sweep.
      // A file rather than an argument: the sets run to hundreds of ids.
      'measured-file': { type: 'string' },
      'plans-dir': { type: 'string' },
      'packages-dir': { type: 'string' },
    },
  })

  const command = positionals[0]
  const bankPath = path.join(values['plans-dir'] ?? path.join(REPO_ROOT, 'plans'), BANK_FILE_NAME)

  if (command === 'reuse') return decideVisualReuse(readJsonFile(bankPath), values.commit ?? null)
  if (command === 'bank') return answerBank(bankPath, values)

  console.error('usage: preflight-bank-cli.mjs reuse|bank --commit <sha> [...]')
  process.exit(2)
}

process.stdout.write(`${JSON.stringify(main())}\n`)
