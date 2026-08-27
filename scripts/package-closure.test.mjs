import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { dependencyClosure, dependentsOf, readManifests } from './package-closure.mjs'

/**
 * An invented workspace, spelled out rather than read from disk: the `web` app reaches `core`
 * only through the `ui` library, which is what makes the walk transitive rather than a single
 * hop, and `core` depends on itself, which is what a naive walk hangs on.
 */
const WORKSPACE = [
  { directory: 'api', name: '@acme/api', dependencies: ['@acme/core'] },
  {
    directory: 'web',
    name: '@acme/web',
    dependencies: ['@acme/ui'],
  },
  { directory: 'ui', name: '@acme/ui', dependencies: ['@acme/core'] },
  { directory: 'core', name: '@acme/core', dependencies: ['@acme/core'] },
]

const withTempPackages = (packages, assertions) => {
  const root = mkdtempSync(path.join(tmpdir(), 'package-closure-'))
  try {
    for (const [directory, manifest] of Object.entries(packages)) {
      mkdirSync(path.join(root, directory), { recursive: true })
      writeFileSync(path.join(root, directory, 'package.json'), JSON.stringify(manifest), 'utf8')
    }
    assertions(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('which packages a change has to be verified against', () => {
  test('a change to ui also verifies the one package built on it', () => {
    assert.deepEqual(dependentsOf(['ui'], WORKSPACE), ['ui', 'web'])
  })

  test('a change to core verifies every package, including the one two hops away', () => {
    assert.deepEqual(dependentsOf(['core'], WORKSPACE), ['api', 'core', 'ui', 'web'])
  })

  test('a change to a package nothing builds on verifies only that package', () => {
    assert.deepEqual(dependentsOf(['web'], WORKSPACE), ['web'])
  })

  test('a package that depends on itself terminates and is listed once', () => {
    const selfReferential = [
      { directory: 'core', name: '@acme/core', dependencies: ['@acme/core'] },
    ]

    assert.deepEqual(dependentsOf(['core'], selfReferential), ['core'])
  })

  test('a pair that depend on each other terminates and each is listed once', () => {
    const mutual = [
      { directory: 'left', name: '@acme/left', dependencies: ['@acme/right'] },
      { directory: 'right', name: '@acme/right', dependencies: ['@acme/left'] },
    ]

    assert.deepEqual(dependentsOf(['left'], mutual), ['left', 'right'])
    assert.deepEqual(dependentsOf(['right'], mutual), ['left', 'right'])
  })

  test('a changed directory with no manifest is passed through, not thrown on', () => {
    assert.deepEqual(dependentsOf(['docs'], WORKSPACE), ['docs'])
    assert.deepEqual(dependentsOf(['docs', 'ui'], WORKSPACE), ['docs', 'ui', 'web'])
  })

  test('a change to nothing verifies nothing', () => {
    assert.deepEqual(dependentsOf([], WORKSPACE), [])
  })

  test('the same package named twice is verified once', () => {
    assert.deepEqual(dependentsOf(['core', 'core'], WORKSPACE), ['api', 'core', 'ui', 'web'])
  })
})

describe('what a package builds on', () => {
  const byName = new Map(WORKSPACE.map((manifest) => [manifest.name, manifest]))

  test('reaches a package it depends on only through another', () => {
    const web = byName.get('@acme/web')

    assert.deepEqual(dependencyClosure(web, byName), ['core', 'ui', 'web'])
  })

  test('a self-dependency terminates and appears once', () => {
    assert.deepEqual(dependencyClosure(byName.get('@acme/core'), byName), ['core'])
  })

  test('a dependency outside the workspace is ignored', () => {
    const manifest = { directory: 'api', name: '@acme/api', dependencies: ['express'] }

    assert.deepEqual(dependencyClosure(manifest, new Map([[manifest.name, manifest]])), ['api'])
  })
})

describe('reading the workspace manifests', () => {
  test('reports each package with its merged dependencies and whether it has a visual suite', () => {
    withTempPackages(
      {
        web: {
          name: '@acme/web',
          dependencies: { '@acme/core': '*' },
          devDependencies: { '@acme/ui': '*' },
          scripts: { 'test:visual': 'playwright test' },
        },
        core: { name: '@acme/core', scripts: { test: 'jest' } },
      },
      (root) => {
        assert.deepEqual(readManifests(root), [
          { directory: 'core', name: '@acme/core', dependencies: [], hasVisualSuite: false },
          {
            directory: 'web',
            name: '@acme/web',
            dependencies: ['@acme/core', '@acme/ui'],
            hasVisualSuite: true,
          },
        ])
      },
    )
  })

  test('skips a directory whose manifest is missing or unreadable', () => {
    withTempPackages({ broken: { name: '@acme/broken' }, nameless: {} }, (root) => {
      writeFileSync(path.join(root, 'broken', 'package.json'), '{ not json', 'utf8')
      mkdirSync(path.join(root, 'no-manifest'), { recursive: true })

      assert.deepEqual(readManifests(root), [])
    })
  })

  test("packages that are the repo root's own subdirectories are read like any other", () => {
    withTempPackages(
      {
        backend: { name: '@acme/backend', dependencies: { '@acme/shared': '*' } },
        shared: { name: '@acme/shared' },
      },
      (root) => {
        const manifests = readManifests(root)
        assert.deepEqual(
          manifests.map((entry) => entry.directory),
          ['backend', 'shared'],
        )
        assert.deepEqual(dependentsOf(['shared'], manifests), ['backend', 'shared'])
      },
    )
  })

  test('a packages directory that does not exist reads as no packages', () => {
    assert.deepEqual(readManifests(path.join(tmpdir(), 'package-closure-absent-dir')), [])
  })
})
