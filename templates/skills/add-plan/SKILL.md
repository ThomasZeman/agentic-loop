---
name: add-plan
description: Use when the user wants a new plan file queued for the unattended plan runner ("add a plan for X", "create a plan file", "write a plan to do Y", "queue up this work", "make a plan for the runner"). Scans plans/ for overlap, researches the real files and symbols involved, drafts against plans/_template.md, then publishes via scripts/claim-plan-number.mjs which atomically claims the sequence number. Safe to run many instances at once. Do NOT use for interactive planning of work you are about to do yourself (that is plan mode), and not for non-Boardbash repos.
---

# Author a plan file for the runner

You turn an informal description of some work into a single, self-contained plan file in `plans/`, ready for `scripts/run-plans.ps1` to execute unattended in a fresh session with no human present.

The agent that eventually runs this plan **starts from zero context**. It has never seen this conversation. Everything it needs must be in the file — and anything it can already infer must be left out.

## Inputs

- `$ARGUMENTS` (if non-empty) is the informal description. If empty, ask the user what the plan should cover, in one sentence, before doing anything else.

## Procedure

Follow these in order. Do not skip step 3 — the research is what separates a usable plan from a restatement of the request.

### 1) Read the contract

- `plans/_template.md` — the exact section structure you must fill in.
- `plans/_preamble.md` — the standing instructions already prepended to **every** plan at runtime.
- `plans/README.md` — how plans are queued and verified.

If any of these are missing, stop and tell the user. Do not recreate them from memory.

**The preamble is the single most important thing you read**, because of the rule in step 4.

### 2) Scan existing plans for overlap

- List `plans/*.md` matching `^\d+[-_]` — that regex is what the runner discovers.
- Read the titles/goals of any plan touching the same area.
- Read `plans/.state.json` if present, to see which plans already ran.

Classify:

- **Already covered** — a queued or completed plan does this. Stop, name it, and ask whether to skip, amend that plan, or add a deliberate follow-up (and how it differs).
- **Overlapping** — another plan touches the same files. Say which, and state in the new plan's *Notes* that it must land after that one. Sequence numbers are the only ordering mechanism.
- **Independent** — proceed.

**Do not pick a sequence number here.** You are reading this directory to understand what already exists, not to reserve a slot. Numbering happens in step 8, at the instant of writing — see the note on parallel runs below.

### 3) Research the actual code

The template says the *Context* section is the biggest lever on plan quality, and it is: an agent that has to guess where the code lives burns its budget searching and often edits the wrong module.

So go find out. Grep and read until you can name:

- The concrete files that will need to change, with paths.
- The specific functions, types, components, or frames involved, by name.
- Any co-located `.md` design notes next to those files (`foo-bar.ts` → `foo-bar.md`) — link them.
- The existing test files that cover this area, and their conventions.
- The package(s) affected — this determines which test suite the runner will use to verify.

Prefer the `Explore` agent for broad sweeps. Do not guess a path you have not confirmed exists.

### 4) Do not restate the preamble

Every plan is executed with `_preamble.md` prepended. It **already** mandates: TDD with observed-red tests, kebab-case naming, `*.test.ts` suffixes, `tsc --noEmit`, lint, package test suites, browser verification, one commit, the commit-message format, the blocked protocol, and the report file.

Writing any of that into the plan is noise that dilutes the parts that are actually specific to this task. Cut it.

The plan carries **only** what the preamble cannot know: what to build, where, what "done" means, and what not to touch.

### 5) Draft against the template

Use `plans/_template.md` section-for-section. Filling each one well:

- **Front matter — `effort:`** — the first thing in the file, and the only setting the runner
  reads rather than the agent. It decides how hard the session implementing this plan thinks
  (`claude --effort`); the model is always Opus. Pick it *last*, once you know what the plan
  leaves open, and pick by that rather than by how much the work matters:

  | Level | When |
  | --- | --- |
  | `low` | Mechanical and local — a string, a constant, a rename the compiler catches. No design decision left in it. |
  | `medium` | One package, an existing pattern to copy, criteria that map one-to-one onto tests you can already name. |
  | `high` | **The default, and most plans.** Several files or packages, a new abstraction or shared type, tests that still need designing, or an approach you had to argue for. |
  | `xhigh` | Genuinely hard — concurrency or ordering, a migration or wire-format change, a bug with no known repro, criteria you could only phrase approximately. |
  | `max` | Work you expect to fail at `xhigh`. Rare, and slow. |

  A plan you had to split because it was too big is a signal about *size*, not difficulty —
  three `medium` parts are usually right, not three `xhigh` ones. Say which level you chose and
  why in your report; the user overrides it by editing one line.

  Misspell a level and the runner fails that plan before its session starts, on purpose: the
  CLI would otherwise ignore the value and quietly run at its own default. The rubric comment
  at the foot of the template is guidance for you — do not copy it into the plan.
- **Title** — what the user gets, not how it is built.
- **Goal** — one paragraph, phrased so "done" is unambiguous.
- **Context** — the real paths and symbols from step 3. This is the section worth spending your effort on.
- **Scope / In** — the work.
- **Scope / Out** — the explicit non-goals. Name the tempting adjacent refactor the agent will otherwise fold into the same commit. A vague *Out* is the most common cause of a sprawling unattended diff.
- **Acceptance criteria** — each phrased as something a test can assert: *Given <state>, when <action>, then <observable result>*. If you cannot phrase one as an assertion, it is not a criterion yet — sharpen it or drop it.
- **Tests to write first** — real file paths, following the conventions you found in step 3, one line on what each pins down.
- **Browser check** — for user-visible work, name the visual spec (`packages/frontend-boardfest/tests/visual/dom-<screen>.test.ts`) or e2e flow to run, and which snapshots to read. For non-visual work write `n/a — <reason>`. Never leave this blank.
- **Demo shots** — for a change anybody can look at, name two to four things worth photographing for the ticket, in reading order, each with its caption. Before-and-after when the change is a difference; the new thing alone when it is new. The runner posts them to the ticket once the plan verifies (`plans/_preamble.md` §4). For non-visual work write `n/a — <reason>`. Never leave this blank.
- **Notes / constraints** — only what the agent cannot infer: perf budgets, wire-format stability, back-compat, ordering against another plan, known-flaky suites, "do not touch X".

### 6) Check the size

One plan ≈ one commit ≈ one reviewable change.

If the work would touch more than a handful of files, or has two distinct acceptance stories, **split it** into several numbered plans and show the user the proposed split before writing. A 40-file unattended commit is not reviewable, and if it fails verification you cannot tell which half broke.

Cheap plans are the point. Err toward more, smaller files.

### 7) Resolve every open question — ask the user, never defer

A plan must be executable with **zero doubts**. The runner session has no human present: any
question the plan leaves open is answered at 3 a.m. by a guess, and a guess becomes a commit.

Before publishing, sweep the draft for anything that would make the executing agent stop and
wonder:

- "TBD", "decide later", "either X or Y", "whichever is cleaner", "if unclear, ask" — none of
  these may appear. The executor cannot ask anyone.
- Design choices with more than one defensible answer (naming, placement, wire format, UX
  copy, ordering) that the plan does not settle.
- Acceptance criteria whose "done" could be read two ways.
- Gaps in the user's description that you papered over with an assumption during drafting.

For every such item, **ask the user now** — with `AskUserQuestion` or directly — and fold the
answer into the plan text. Do not publish first and list the open points in your report;
questions are resolved *before* the file exists, not after. Purely mechanical implementation
details the preamble's conventions already determine (test file naming, TDD flow, etc.) do
not count as open questions.

Only when the plan answers every question it raises may you proceed to publish.

### 8) Write the file — via the claim script, never directly

Several instances of this skill may be authoring plans at the same time. Choosing a number
yourself is a race: two agents both read `05`, both decide on `06`, and you get two plans
numbered 06. They will not even collide on filename when their titles differ, so nothing
fails loudly — the queue just has an ambiguous slot in it.

So the number is claimed atomically, at the last possible moment, by a script:

1. Write the finished plan **body** to a scratch file — anywhere temporary, not in `plans/`.
   The body starts with the `---` front-matter block; the script writes what you give it
   verbatim, so an `effort:` line you leave out is a plan that runs at `high` by default.
2. Claim the number and publish it in one atomic step:

   ```powershell
   node scripts/claim-plan-number.mjs --slug <kebab-case-title> --body <scratch-file>
   ```

   Same command in bash/zsh. It prints the path it created; read the number off that.

The script scans and writes under a directory lock, so the number is decided and used
inside one critical section that no other agent can enter. It always appends after the
highest existing number and never fills gaps.

**Never write `plans/NN-*.md` with the Write tool, and never pass a number to the script.**
The `--slug` is just the kebab-case title, with no numeric prefix.

Then re-read what you wrote and cut every sentence that the preamble already covers or that does not change what gets built.

### 9) Report back

Tell the user:

- The plan's filename **as the script reported it** — never the number you expected. Under
  parallel authoring the number you would have guessed in step 2 is routinely not the one
  you get, and that is correct behaviour, not a problem to report.
- The overlap-scan result in one line (`No overlap` / `Overlaps NN-… — sequenced after it`).
- The questions you asked in step 7 and how the answers shaped the plan (or "no open questions came up").
- Anything you deliberately left out of scope.
- That they can preview the composed prompt with `.\scripts\run-plans.ps1 -DryRun`.

## Guardrails

- **This skill writes one markdown file.** Do not implement the plan, edit production code, create tests, or commit anything.
- Never renumber, rename, or edit existing plan files; if the user wants a change to an existing plan, edit that plan in place and leave its number alone.
- Never invent a file path or symbol name — confirm it exists first, or describe it as something the agent must locate.
- **Never publish a plan that leaves an open question.** Any ambiguity, undecided design choice, or gap in the request must be resolved by asking the user **before** the file is written (step 7). An ambiguity resolved now costs one question; resolved at 3 a.m. by an unattended agent it costs a wrong commit.
- Do not add an "Out of scope" section that duplicates *Scope / Out*, and do not add sections the template does not have.

### Running in parallel

Many instances of this skill can run at once. The sequence number is safe: it is claimed
under a lock at write time, so numbers are always distinct and contiguous.

**The overlap scan in step 2 is not covered by that lock**, and cannot be — a plan that
another agent has not written yet is invisible to you. Two agents given similar briefs at
the same moment can both scan clean and both publish. To keep that window small, do the
scan as late as you can and go straight from it to step 8; do not scan, then spend a long
research phase, then publish against stale knowledge.

The residual risk is real but bounded: you get two overlapping plans in the queue, which a
human sees on review, rather than corrupted numbering that is hard to spot. If the user is
fanning out several plans at once over related areas, say so in your report so they can
check for overlap across the batch.
