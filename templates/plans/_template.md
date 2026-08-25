---
effort: high   # low | medium | high | xhigh | max — how hard this plan's session should think
---

# <Title — what the user gets, not how it is built>

## Goal

<One paragraph. The observable outcome. Written so "done" is unambiguous.>

## Context

<Where this lives. Name the concrete files and symbols you already know are involved —
this is the single biggest lever on plan quality. Link co-located `.md` design notes.>

- `<package>/src/...`
- `<package>/src/...`

## Scope

**In:**
- <bullet>

**Out:**
- <bullet — be explicit; this is what keeps the agent from wandering>

## Preconditions

<Checks the executor runs before any other work, for anything this plan stands on that the
tree does not already prove: an artifact another queued plan supplies, a tool that must be
able to do a specific thing, a budget that must fit. Give the exact command or file test and
the expected result; a failed precondition means blocked immediately, zero code written.
Write "none — all assumptions verified at authoring time" when that is true.>

## Acceptance criteria

<Each one phrased as something a test can assert.>

1. Given <state>, when <action>, then <observable result>.
2. ...

## Tests to write first

- `path/to/thing.test.ts` — <what it pins down>

## Browser check

<What to render and look at, and how. Usually a spec in the project's visual harness + which
snapshots to read. Write "n/a — <reason>" for non-visual work.>

## Demo shots

<Only for a project with a demo hook (see "Showcase" in `plans/_project.md`). Two to four
things worth photographing, in the order they should be read, each with the caption it should
carry. The runner hands them over once this plan verifies and merges. Write "n/a — <reason>"
when the change is not one anybody can look at; delete this section in a project without the
hook.>

## Notes / constraints

<Anything the agent cannot infer: perf budgets, back-compat, wire-format stability,
"do not touch X", known-flaky suites.>

---

<!--
Picking the effort. Every plan runs on Opus; this only says how hard to think, and the
runner passes it to `claude --effort`. Choose by what the *plan* had to leave open, not by
how much it matters:

  low     Mechanical and local. A string, a constant, a rename the compiler catches.
          No design decision left in it, and the test to write is obvious.
  medium  One package, an existing pattern to copy, and acceptance criteria that map
          one-to-one onto tests this plan can already name.
  high    The default, and most plans. Several files or packages, a new abstraction or a
          shared type, tests that still need designing, or an approach this plan had to
          argue for.
  xhigh   Genuinely hard: concurrency or ordering, a migration or wire-format change, a
          bug with no known repro, criteria you could only phrase approximately.
  max     Reserve for work you expect to fail at xhigh. Rare, and slow.

Omitting the header is the same as `high`. Misspelling a level fails the plan before its
session starts - the CLI would otherwise ignore it and run at its own default.
-->
