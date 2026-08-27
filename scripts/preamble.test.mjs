import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { composePreamble, loadPreamble, renderSpine, SPINE_PATH } from './preamble.mjs'
import { resolveRunnerConfig } from './runner-config.mjs'

const config = resolveRunnerConfig({})

describe('renderSpine', () => {
  test('fills the gate placeholders from the config', () => {
    const text = renderSpine('run `npm run {{testScript}}` in {{packagesLocation}}; visual `{{visualScript}}`', config)
    assert.equal(text, 'run `npm run test` in `packages/`; visual `test:visual`')
  })

  test('a project whose packages are the repo root is told so, not sent to a bare slash', () => {
    const flat = renderSpine(readFileSync(SPINE_PATH, 'utf8'), resolveRunnerConfig({ packagesDir: '' }))
    assert.match(flat, /package under the repo root/)
    assert.doesNotMatch(flat, /package under `\/`/)
  })

  test('a project with a workspace directory still reads it as a path', () => {
    assert.match(renderSpine(readFileSync(SPINE_PATH, 'utf8'), config), /package under `packages\/`/)
  })

  test('says what the quality ratchet measures when it is on, and nothing when it is off', () => {
    assert.match(renderSpine('{{qualityGateLine}}', config), /tsc[\s\S]*eslint[\s\S]*never\s+rise/i)
    const off = resolveRunnerConfig({ gates: { quality: { enabled: false } } })
    assert.equal(renderSpine('{{qualityGateLine}}', off), '')
  })

  test('a placeholder the spine misspells is a fault, not a literal left in the prompt', () => {
    assert.throws(() => renderSpine('{{testScirpt}}', config), /unknown placeholder 'testScirpt'/)
  })
})

describe('composePreamble', () => {
  test('a project preamble, when there is one, is the whole preamble - verbatim', () => {
    const result = composePreamble({ projectPreamble: '# Mine\n', spine: '# Spine', projectSection: '# P', config })
    assert.equal(result.text, '# Mine\n')
    assert.equal(result.source, 'plans/_preamble.md')
  })

  test('otherwise the spine is followed by the project section under its own heading', () => {
    const result = composePreamble({ projectPreamble: null, spine: '# Spine body', projectSection: 'Read X first.', config })
    assert.match(result.text, /^# Spine body\n/)
    assert.match(result.text, /\n---\n\n# Project section\n\nRead X first\.\n$/)
    assert.equal(result.source, 'spine + plans/_project.md')
  })

  test('a project with no section at all is told so, in the prompt, instead of the spine dangling', () => {
    const result = composePreamble({ projectPreamble: null, spine: '# Spine', projectSection: null, config })
    assert.match(result.text, /# Project section\n\nThis project declares no additional rules/)
    assert.equal(result.source, 'spine')
  })

  test('the spine is rendered with the config before it is composed', () => {
    const result = composePreamble({ projectPreamble: null, spine: 'gate: {{testScript}}', projectSection: null, config })
    assert.match(result.text, /^gate: test\n/)
  })
})

describe('loadPreamble', () => {
  function inTempRepo(run) {
    const root = mkdtempSync(path.join(tmpdir(), 'preamble-'))
    try {
      mkdirSync(path.join(root, 'plans'))
      return run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test("reads the tool's own spine and the repo's _project.md", () => {
    inTempRepo((root) => {
      writeFileSync(path.join(root, 'plans', '_project.md'), 'Project rule.\n')
      const result = loadPreamble(root)
      assert.equal(result.source, 'spine + plans/_project.md')
      assert.match(result.text, /^# Standing instructions for every plan/)
      assert.match(result.text, /npm run test/)
      assert.match(result.text, /# Project section\n\nProject rule\./)
    })
  })

  test('prefers a whole _preamble.md when the repo still carries one', () => {
    inTempRepo((root) => {
      writeFileSync(path.join(root, 'plans', '_preamble.md'), 'Legacy whole preamble.\n')
      writeFileSync(path.join(root, 'plans', '_project.md'), 'Ignored.\n')
      const result = loadPreamble(root)
      assert.equal(result.text, 'Legacy whole preamble.\n')
      assert.equal(result.source, 'plans/_preamble.md')
    })
  })

  test('strips a BOM from either project file, because PowerShell 5.1 writes one', () => {
    inTempRepo((root) => {
      const bom = String.fromCharCode(0xfeff)
      writeFileSync(path.join(root, 'plans', '_project.md'), `${bom}Project rule.\n`)
      assert.match(loadPreamble(root).text, /# Project section\n\nProject rule\./)
    })
  })
})
