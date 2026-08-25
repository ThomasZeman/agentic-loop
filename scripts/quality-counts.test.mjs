import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { hasEslintConfig } from './quality-counts.mjs'

const made = []

/** A throwaway package directory carrying exactly the config files named. */
function packageDirWith(...configFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-counts-'))
  made.push(dir)
  mkdirSync(join(dir, 'src'))
  for (const name of configFiles) writeFileSync(join(dir, name), '{}')
  return dir
}

describe('hasEslintConfig', () => {
  test.after(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  test('a flat config makes the package lintable', () => {
    assert.equal(hasEslintConfig(packageDirWith('eslint.config.mjs')), true)
    assert.equal(hasEslintConfig(packageDirWith('eslint.config.js')), true)
    assert.equal(hasEslintConfig(packageDirWith('eslint.config.cjs')), true)
  })

  test('a legacy .eslintrc makes it lintable too - the frontend packages pin eslint 8, which reads them', () => {
    assert.equal(hasEslintConfig(packageDirWith('.eslintrc.json')), true)
    assert.equal(hasEslintConfig(packageDirWith('.eslintrc.cjs')), true)
    assert.equal(hasEslintConfig(packageDirWith('.eslintrc.js')), true)
    assert.equal(hasEslintConfig(packageDirWith('.eslintrc.yml')), true)
    assert.equal(hasEslintConfig(packageDirWith('.eslintrc.yaml')), true)
    assert.equal(hasEslintConfig(packageDirWith('.eslintrc')), true)
  })

  test('a package carrying both spellings is lintable once, not confused by the pair', () => {
    assert.equal(hasEslintConfig(packageDirWith('eslint.config.mjs', '.eslintrc.json')), true)
  })

  test('a package with no eslint config of any spelling is not lintable', () => {
    assert.equal(hasEslintConfig(packageDirWith()), false)
    assert.equal(hasEslintConfig(packageDirWith('tsconfig.json', 'package.json')), false)
  })
})
