import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { dependencyClosure, dependentsOf, readManifests } from './package-closure.mjs'

/**
 * The workspace as it stands, spelled out rather than read from disk: frontend-boardfest
 * reaches shared only through frontend-shared, which is what makes the walk transitive rather
 * than a single hop, and shared depends on itself, which is what a naive walk hangs on.
 */
const WORKSPACE = [
  { directory: 'backend', name: '@nocap/backend', dependencies: ['@nocap/shared'] },
  {
    directory: 'frontend-boardfest',
    name: '@nocap/frontend-boardfest',
    dependencies: ['@nocap/frontend-shared'],
  },
  { directory: 'frontend-shared', name: '@nocap/frontend-shared', dependencies: ['@nocap/shared'] },
  { directory: 'shared', name: '@nocap/shared', dependencies: ['@nocap/shared'] },
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
  test('a change to frontend-shared also verifies the one package built on it', () => {
    assert.deepEqual(dependentsOf(['frontend-shared'], WORKSPACE), [
      'frontend-boardfest',
      'frontend-shared',
    ])
  })

  test('a change to shared verifies every package, including the one two hops away', () => {
    assert.deepEqual(dependentsOf(['shared'], WORKSPACE), [
      'backend',
      'frontend-boardfest',
      'frontend-shared',
      'shared',
    ])
  })

  test('a change to a package nothing builds on verifies only that package', () => {
    assert.deepEqual(dependentsOf(['frontend-boardfest'], WORKSPACE), ['frontend-boardfest'])
  })

  test('a package that depends on itself terminates and is listed once', () => {
    const selfReferential = [
      { directory: 'shared', name: '@nocap/shared', dependencies: ['@nocap/shared'] },
    ]

    assert.deepEqual(dependentsOf(['shared'], selfReferential), ['shared'])
  })

  test('a pair that depend on each other terminates and each is listed once', () => {
    const mutual = [
      { directory: 'left', name: '@nocap/left', dependencies: ['@nocap/right'] },
      { directory: 'right', name: '@nocap/right', dependencies: ['@nocap/left'] },
    ]

    assert.deepEqual(dependentsOf(['left'], mutual), ['left', 'right'])
    assert.deepEqual(dependentsOf(['right'], mutual), ['left', 'right'])
  })

  test('a changed directory with no manifest is passed through, not thrown on', () => {
    assert.deepEqual(dependentsOf(['docs'], WORKSPACE), ['docs'])
    assert.deepEqual(dependentsOf(['docs', 'frontend-shared'], WORKSPACE), [
      'docs',
      'frontend-boardfest',
      'frontend-shared',
    ])
  })

  test('a change to nothing verifies nothing', () => {
    assert.deepEqual(dependentsOf([], WORKSPACE), [])
  })

  test('the same package named twice is verified once', () => {
    assert.deepEqual(dependentsOf(['shared', 'shared'], WORKSPACE), [
      'backend',
      'frontend-boardfest',
      'frontend-shared',
      'shared',
    ])
  })
})

describe('what a package builds on', () => {
  const byName = new Map(WORKSPACE.map((manifest) => [manifest.name, manifest]))

  test('reaches a package it depends on only through another', () => {
    const boardfest = byName.get('@nocap/frontend-boardfest')

    assert.deepEqual(dependencyClosure(boardfest, byName), [
      'frontend-boardfest',
      'frontend-shared',
      'shared',
    ])
  })

  test('a self-dependency terminates and appears once', () => {
    assert.deepEqual(dependencyClosure(byName.get('@nocap/shared'), byName), ['shared'])
  })

  test('a dependency outside the workspace is ignored', () => {
    const manifest = { directory: 'backend', name: '@nocap/backend', dependencies: ['express'] }

    assert.deepEqual(dependencyClosure(manifest, new Map([[manifest.name, manifest]])), ['backend'])
  })
})

describe('reading the workspace manifests', () => {
  test('reports each package with its merged dependencies and whether it has a visual suite', () => {
    withTempPackages(
      {
        'frontend-boardfest': {
          name: '@nocap/frontend-boardfest',
          dependencies: { '@nocap/shared': '*' },
          devDependencies: { '@nocap/frontend-shared': '*' },
          scripts: { 'test:visual': 'playwright test' },
        },
        shared: { name: '@nocap/shared', scripts: { test: 'jest' } },
      },
      (root) => {
        assert.deepEqual(readManifests(root), [
          {
            directory: 'frontend-boardfest',
            name: '@nocap/frontend-boardfest',
            dependencies: ['@nocap/shared', '@nocap/frontend-shared'],
            hasVisualSuite: true,
          },
          { directory: 'shared', name: '@nocap/shared', dependencies: [], hasVisualSuite: false },
        ])
      },
    )
  })

  test('skips a directory whose manifest is missing or unreadable', () => {
    withTempPackages({ broken: { name: '@nocap/broken' }, nameless: {} }, (root) => {
      writeFileSync(path.join(root, 'broken', 'package.json'), '{ not json', 'utf8')
      mkdirSync(path.join(root, 'no-manifest'), { recursive: true })

      assert.deepEqual(readManifests(root), [])
    })
  })

  test('a packages directory that does not exist reads as no packages', () => {
    assert.deepEqual(readManifests(path.join(tmpdir(), 'package-closure-absent-dir')), [])
  })
})
