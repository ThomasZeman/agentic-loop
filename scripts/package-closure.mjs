// Which workspace packages a change has to be verified against.
//
// The runner learns what a plan changed from a literal diff of `packages/<name>/` prefixes,
// which is the truth about the diff and a lie about the blast radius: `frontend-boardfest` is
// built on `frontend-shared`, which is built on `shared`, so a plan can break a consumer, verify
// green against the one package it edited, merge and ship. Expanding that set is a decision, so
// it lives here, tested, rather than in run-plans.ps1.
//
// Two directions over the same graph, and the difference matters:
//
//   - `dependencyClosure` walks *down* - what one package builds on. That is what the visual
//     bank asks: the suite's result can only be vouched for while nothing underneath it moved.
//   - `dependentsOf` walks *up* - what is built on the packages a plan changed. That is what
//     verification asks: everything that could have been broken by the edit.
//
// The graph comes from the manifests under `packages/`, never from a list written down here, so
// a package added later is covered on the day it is added. The root manifest's `workspaces`
// array is not that source: it names seven paths, four of which exist.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const VISUAL_SCRIPT = 'test:visual'

const BOM = String.fromCharCode(0xfeff)

/**
 * A JSON file, or null if it is absent or unreadable - a package the runner cannot see.
 *
 * The BOM is tolerated rather than trusted to be absent: JSON.parse rejects one outright, and a
 * manifest this refuses is a package silently left unverified, which is the whole failure this
 * module exists to close.
 */
function readJsonFile(file) {
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8')
    return JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text)
  } catch {
    return null
  }
}

/**
 * One entry per workspace package: the directory the runner names it by, the name its
 * dependants import it by, and whether it has a visual suite of its own.
 */
export function readManifests(packagesDir) {
  if (!existsSync(packagesDir)) return []

  const manifests = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const parsed = readJsonFile(path.join(packagesDir, entry.name, 'package.json'))
    if (!parsed?.name) continue
    manifests.push({
      directory: entry.name,
      name: parsed.name,
      dependencies: Object.keys({ ...parsed.dependencies, ...parsed.devDependencies }),
      hasVisualSuite: Boolean(parsed.scripts?.[VISUAL_SCRIPT]),
    })
  }
  return manifests
}

/**
 * Every workspace package this one's build depends on, itself included, as directory names.
 *
 * Transitive, because frontend-boardfest reaches shared only through frontend-shared. Cycles and
 * the self-dependency `packages/shared` declares on itself are absorbed by the seen set.
 */
export function dependencyClosure(manifest, byName) {
  const seen = new Set([manifest.directory])
  const queue = [manifest]

  while (queue.length > 0) {
    const current = queue.shift()
    for (const dependency of current.dependencies) {
      const target = byName.get(dependency)
      if (!target || seen.has(target.directory)) continue
      seen.add(target.directory)
      queue.push(target)
    }
  }
  return [...seen].sort()
}

/**
 * The packages a plan must verify: the ones it changed, plus every package that transitively
 * builds on one of them.
 *
 * A changed directory with no manifest is kept rather than dropped - a plan may touch
 * `packages/whatever/README.md`, and the caller is the one that knows there is nothing to run
 * there.
 *
 * @param {string[]} changedDirectories package directory names, as the runner's diff spells them
 * @param {Array<{directory: string, name: string, dependencies: string[]}>} manifests
 * @returns {string[]} directory names, sorted and deduplicated
 */
export function dependentsOf(changedDirectories, manifests) {
  const changed = new Set(changedDirectories)
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]))

  const toVerify = new Set(changed)
  for (const manifest of manifests) {
    const buildsOn = dependencyClosure(manifest, byName)
    if (buildsOn.some((directory) => changed.has(directory))) toVerify.add(manifest.directory)
  }
  return [...toVerify].sort()
}
