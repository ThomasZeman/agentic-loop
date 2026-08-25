import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'

import { DEFAULT_EFFORT, EFFORT_LEVELS, readPlanHeader, splitFrontMatter } from './plan-header.mjs'

const PLAN = `# Lobby content lines up on one edge

## Goal

The lobby column gets a deliberate two-level alignment system.
`

describe('splitFrontMatter', () => {
  test('takes the fields off the top and leaves the plan body untouched', () => {
    const split = splitFrontMatter(`---\neffort: high\n---\n\n${PLAN}`)
    assert.deepEqual(split.fields, { effort: 'high' })
    assert.equal(split.body, `\n${PLAN}`)
    assert.equal(split.problem, null)
  })

  test('leaves a plan with no front matter exactly as it found it', () => {
    const split = splitFrontMatter(PLAN)
    assert.deepEqual(split.fields, {})
    assert.equal(split.body, PLAN)
  })

  test('keeps CRLF bodies byte for byte', () => {
    // The prompt is composed from this and handed to a headless session; rewriting the line
    // endings of every plan on a Windows checkout would show up in nothing but the diff noise.
    const split = splitFrontMatter('---\r\neffort: low\r\n---\r\n# Title\r\n\r\nBody\r\n')
    assert.deepEqual(split.fields, { effort: 'low' })
    assert.equal(split.body, '# Title\r\n\r\nBody\r\n')
  })

  test('reads a value with a colon in it, and strips quotes', () => {
    const split = splitFrontMatter('---\nticket: "NOC-142: the thing"\n---\nbody\n')
    assert.deepEqual(split.fields, { ticket: 'NOC-142: the thing' })
  })

  test('drops a trailing comment, so the template can carry its own rubric', () => {
    const split = splitFrontMatter('---\neffort: high   # low | medium | high | xhigh | max\n---\nbody\n')
    assert.deepEqual(split.fields, { effort: 'high' })
  })

  test('keeps a # that is part of the value rather than a comment', () => {
    const split = splitFrontMatter('---\nticket: NOC-1#2\n---\nbody\n')
    assert.deepEqual(split.fields, { ticket: 'NOC-1#2' })
  })

  test('keeps a commented-out value as empty rather than guessing', () => {
    const split = splitFrontMatter('---\neffort: # not decided yet\n---\nbody\n')
    assert.deepEqual(split.fields, { effort: '' })
  })

  test('ignores blank lines and comments between fields', () => {
    const split = splitFrontMatter('---\n# why high\n\neffort: high\n---\nbody\n')
    assert.deepEqual(split.fields, { effort: 'high' })
  })

  test('closes only on a --- of its own, not on one inside a value', () => {
    const split = splitFrontMatter('---\nticket: NOC-1 --- part 2\neffort: low\n---\nbody\n')
    assert.deepEqual(split.fields, { ticket: 'NOC-1 --- part 2', effort: 'low' })
    assert.equal(split.body, 'body\n')
  })

  test('reads empty front matter as no fields rather than as unclosed', () => {
    const split = splitFrontMatter('---\n---\nbody\n')
    assert.deepEqual(split.fields, {})
    assert.equal(split.problem, null)
    assert.equal(split.body, 'body\n')
  })

  test('refuses front matter that is opened and never closed', () => {
    const split = splitFrontMatter('---\neffort: high\n\n# Title\n')
    assert.match(split.problem, /never closed/)
  })

  test('refuses a line that is not a field', () => {
    const split = splitFrontMatter('---\neffort high\n---\nbody\n')
    assert.match(split.problem, /could not read/)
    assert.match(split.problem, /effort high/)
  })

  test('survives a byte-order mark, which is how PowerShell writes a file', () => {
    const split = splitFrontMatter('﻿---\neffort: max\n---\nbody\n')
    assert.deepEqual(split.fields, { effort: 'max' })
    assert.equal(split.body, 'body\n')
  })
})

describe('readPlanHeader', () => {
  test('reads the level the plan asked for', () => {
    const header = readPlanHeader(`---\neffort: medium\n---\n${PLAN}`)
    assert.equal(header.effort, 'medium')
    assert.equal(header.declared, true)
    assert.equal(header.problem, null)
  })

  test('accepts every level the CLI accepts', () => {
    for (const level of EFFORT_LEVELS) {
      assert.equal(readPlanHeader(`---\neffort: ${level}\n---\nbody\n`).effort, level)
    }
    assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('is forgiving about case and stray space, strict about spelling', () => {
    assert.equal(readPlanHeader('---\neffort:  High \n---\nbody\n').effort, 'high')
  })

  test('falls back to the default when a plan declares nothing', () => {
    // Every plan file written before this existed is in exactly this state, so the fallback
    // is the behaviour of the whole standing queue - not an edge case.
    const header = readPlanHeader(PLAN)
    assert.equal(header.effort, DEFAULT_EFFORT)
    assert.equal(header.declared, false)
    assert.equal(header.problem, null)
  })

  test('falls back when front matter is present but says nothing about effort', () => {
    const header = readPlanHeader('---\nticket: NOC-142\n---\nbody\n')
    assert.equal(header.effort, DEFAULT_EFFORT)
    assert.equal(header.declared, false)
  })

  test('refuses a level the CLI does not have, rather than letting it be ignored', () => {
    // `claude --effort hgih` is a warning, not an error: it runs the session at the default
    // and says so in a line nobody reads. A typo must cost the plan, not three hours of the
    // wrong effort.
    const header = readPlanHeader('---\neffort: hgih\n---\nbody\n')
    assert.equal(header.effort, null)
    assert.match(header.problem, /unknown effort 'hgih'/)
    assert.match(header.problem, /low, medium, high, xhigh, max/)
  })

  test('refuses an empty declaration', () => {
    assert.match(readPlanHeader('---\neffort:\n---\nbody\n').problem, /unknown effort/)
  })

  test('carries the body through, so the caller never re-reads the file', () => {
    assert.equal(readPlanHeader(`---\neffort: low\n---\n${PLAN}`).body, PLAN)
  })
})
