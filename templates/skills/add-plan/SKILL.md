---
name: add-plan
description: Use when the user wants a new plan file queued for the unattended plan runner ("add a plan for X", "create a plan file", "write a plan to do Y", "queue up this work", "make a plan for the runner"). Scans plans/ for overlap, researches the real files and symbols involved, drafts against plans/_template.md, then publishes via the shared runner's C:/code/agentic-loop/scripts/claim-plan-number.mjs which atomically claims the sequence number. Safe to run many instances at once. Do NOT use for interactive planning of work you are about to do yourself (that is plan mode), and not for any repo other than the one this skill is installed in.
---

<!--
Template from C:\code\agentic-loop\templates\skills\. Copy to .claude/skills/add-plan/SKILL.md.
Nothing here is project-specific: the project's own rules come from plans/_project.md, which the
procedure reads. Adapt step 3 if this repo keeps canonical prose (requirements, architecture
docs) that a plan must name. Delete this comment when done.
-->

# Author a plan file for the runner

You turn an informal description of some work into a single, self-contained plan file in `plans/`,
ready for the shared plan runner (`C:/code/agentic-loop/scripts/run-plans.ps1`) to execute
unattended in a fresh session with no human present.

The agent that eventually runs this plan **starts from zero context**. It has never seen this
conversation. Everything it needs must be in the file — and anything it can already infer must be
left out.

## Inputs

- `$ARGUMENTS` (if non-empty) is the informal description. If empty, ask the user what the plan
  should cover, in one sentence, before doing anything else.

## Procedure

Follow these in order. Do not skip step 3 — the research is what separates a usable plan from a
restatement of the request.

### 1) Read the contract

- `plans/_template.md` — the exact section structure you must fill in.
- `C:/code/agentic-loop/prompt/spine.md` — the runner's standing instructions, prepended to
  **every** plan at runtime, with the gate names filled in from `plans/runner.json`.
- `plans/_project.md` — this repo's own rules, appended to the spine as its "Project section".
- `plans/README.md` — how plans are queued and verified.

If any of these are missing, stop and tell the user. Do not recreate them from memory.

**The spine and the project section are the most important things you read**, because of the rule
in step 4.

### 2) Scan existing plans for overlap

- List `plans/*.md` matching `^\d+[-_]` — that regex is what the runner discovers.
- Read the titles/goals of any plan touching the same area.
- Read `plans/.state.json` if present, to see which plans already ran.

Classify:

- **Already covered** — a queued or completed plan does this. Stop, name it, and ask whether to
  skip, amend that plan, or add a deliberate follow-up (and how it differs).
- **Overlapping** — another plan touches the same files. Say which, and state in the new plan's
  *Notes* that it must land after that one. Sequence numbers are the only ordering mechanism.
- **Dependent** — the new plan **consumes an artifact another queued plan creates** (a script,
  module, harness, endpoint). This is stronger than overlap: if the prerequisite blocks or fails
  verification, this plan is unimplementable, and the runner will still execute it — the queue
  moves on past failures. Step 6 turns the dependency into a *Preconditions* gate, and the user
  must be told the plan is conditional.
- **Independent** — proceed.

**Do not pick a sequence number here.** You are reading this directory to understand what already
exists, not to reserve a slot. Numbering happens in step 9, at the instant of writing — see the
note on parallel runs below.

### 3) Research the actual code

The template says the *Context* section is the biggest lever on plan quality, and it is: an agent
that has to guess where the code lives burns its budget searching and often edits the wrong module.

So go find out. Grep and read until you can name:

- The concrete files that will need to change, with paths.
- The specific functions, types, components, or messages involved, by name.
- Any co-located `.md` design notes next to those files (`foo-bar.ts` → `foo-bar.md`) — link them.
- The existing test files that cover this area, and their conventions.
- The package(s) affected — this determines which test suite the runner will use to verify.

Prefer the `Explore` agent for broad sweeps. Do not guess a path you have not confirmed exists.

If `plans/_project.md` names canonical prose for the area (requirements, architecture notes), read
it against the code: where it already disagrees, note the drift so step 8 can ask which side is
the status quo.

### 4) Do not restate the spine or the project section

Every plan is executed with the spine and `plans/_project.md` prepended. Between them they
**already** mandate: TDD with observed-red tests, the project's naming and test conventions, the
gate commands, browser verification, the showcase rule, one commit, the commit-message format, the
blocked protocol, and the report file.

Writing any of that into the plan is noise that dilutes the parts that are actually specific to
this task. Cut it.

The plan carries **only** what the standing instructions cannot know: what to build, where, what
"done" means, and what not to touch.

### 5) Draft against the template

Use `plans/_template.md` section-for-section. Filling each one well:

- **Front matter — `effort:`** — the only setting the runner reads rather than the agent; it goes
  to `claude --effort` for this plan's session. Pick it *last*, by what the plan had to leave open,
  using the rubric at the foot of the template (do not copy that comment into the plan). Omitting
  it means `high`; misspelling it fails the plan before its session starts. Say which level you
  chose and why in your report.
- **Title** — what the user gets, not how it is built.
- **Goal** — one paragraph, phrased so "done" is unambiguous.
- **Context** — the real paths and symbols from step 3. This is the section worth spending your
  effort on.
- **Scope / In** — the work.
- **Scope / Out** — the explicit non-goals. Name the tempting adjacent refactor the agent will
  otherwise fold into the same commit. A vague *Out* is the most common cause of a sprawling
  unattended diff.
- **Preconditions** — leave a placeholder while drafting; step 6 fills it (or writes `none — all
  assumptions verified at authoring time`). If the template lacks the section, add it right after
  *Scope*; it is the one addition the template tolerates.
- **Acceptance criteria** — each phrased as something a test can assert: *Given <state>, when
  <action>, then <observable result>*. If you cannot phrase one as an assertion, it is not a
  criterion yet — sharpen it or drop it.
- **Tests to write first** — real file paths, following the conventions you found in step 3, one
  line on what each pins down.
- **Browser check** — for user-visible work, name what to render and how, in terms of the
  project's visual harness if it has one (see *Browser check* in `plans/_project.md`): the spec to
  run and which snapshots to read, or the live-app flow to drive when only that shows the change.
  For work with no rendered surface write `n/a — <reason>`. Never leave this blank.
- **Demo shots** — only if `plans/_project.md` describes a showcase/demo mechanism: two to four
  things worth photographing, in reading order, each with its caption; `n/a — <reason>` for work
  nobody can look at. In a project without such a mechanism, drop the section.
- **Notes / constraints** — only what the agent cannot infer: perf budgets, wire-format
  stability, back-compat, ordering against another plan, known-flaky suites, "do not touch X".

### 6) Prove the plan is implementable — verify every load-bearing assumption

A plan is a claim that the work can be built **and verified** as specified. Step 3 confirms the
*nouns* — that the files and symbols exist. This step confirms the *verbs*: that the plan's
mechanism can actually work. A tool can exist and still be unable to do what the plan needs; a plan
that consumes an artifact from a plan that never landed inherits its failure at run time.

Sweep the draft and list every **load-bearing assumption** — anything the goal or the acceptance
criteria stand on that the tree does not already prove true:

- **Mechanism** — every external tool, command, or environment the plan's build *or verification*
  relies on (a CLI, an emulator, a harness script).
- **Arithmetic** — every "X fits in Y" goal: layout budgets, perf budgets, payload or size limits.
- **Artifacts** — every file, script, or symbol the plan consumes but does not create.

Then, for each one, in order of preference:

1. **Verify it now, yourself.** You run interactively, with the user present — you can afford
   what the unattended executor cannot. Run the real probe against the real target; if the goal is
   a fit, do the arithmetic from the real values and put the numbers with their margin **into the
   plan's Context**. A probe that costs minutes here is cheaper than a failed multi-dollar run there.
2. **If it cannot be verified now** — the artifact comes from a queued-but-unlanded plan, or the
   assumption is only falsifiable at run time — write it into the plan's **Preconditions** as a
   check the executor runs *before any other work*: the exact command or file test, the expected
   result, and (for a plan-supplied artifact) which plan supplies it. A failed precondition means
   blocked **immediately**, per the spine, with zero code written.
3. **If verification says no** — the probe fails, the margin is negative or within noise — the
   plan as requested is not implementable. That is a product decision, not a drafting detail:
   take it to the user (step 8) before anything is published.

An assumption you neither verified nor gated has no place in a published plan.

### 7) Check the size

One plan ≈ one commit ≈ one reviewable change.

If the work would touch more than a handful of files, or has two distinct acceptance stories,
**split it** into several numbered plans and show the user the proposed split before writing. A
40-file unattended commit is not reviewable, and if it fails verification you cannot tell which
half broke.

Cheap plans are the point. Err toward more, smaller files.

### 8) Resolve every open question — ask the user, never defer

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
- Drift from step 3 where you cannot tell whether the doc or the code is the intended design.

For every such item, **ask the user now** — with `AskUserQuestion` or directly — and fold the
answer into the plan text. Do not publish first and list the open points in your report;
questions are resolved *before* the file exists, not after. Purely mechanical implementation
details the standing instructions already determine (test file naming, TDD flow, etc.) do not
count as open questions.

Only when the plan answers every question it raises may you proceed to publish.

### 9) Write the file — via the claim script, never directly

Several instances of this skill may be authoring plans at the same time. Choosing a number
yourself is a race: two agents both read `05`, both decide on `06`, and you get two plans
numbered 06. They will not even collide on filename when their titles differ, so nothing
fails loudly — the queue just has an ambiguous slot in it.

So the number is claimed atomically, at the last possible moment, by a script:

1. Write the finished plan **body** to a scratch file — anywhere temporary, not in `plans/`. The
   body starts with the `---` front-matter block; the script writes what you give it verbatim.
2. Claim the number and publish it in one atomic step, from the repo root:

   ```powershell
   node C:/code/agentic-loop/scripts/claim-plan-number.mjs --slug <kebab-case-title> --body <scratch-file>
   ```

   Same command in bash/zsh. It prints the path it created; read the number off that.

The script scans and writes under a directory lock, so the number is decided and used
inside one critical section that no other agent can enter. It always appends after the
highest existing number and never fills gaps.

**Never write `plans/NN-*.md` with the Write tool, and never pass a number to the script.**
The `--slug` is just the kebab-case title, with no numeric prefix.

Then re-read what you wrote and cut every sentence that the standing instructions already cover
or that does not change what gets built.

### 10) Report back

Tell the user:

- The plan's filename **as the script reported it** — never the number you expected. Under
  parallel authoring the number you would have guessed in step 2 is routinely not the one
  you get, and that is correct behaviour, not a problem to report.
- The overlap-scan result in one line (`No overlap` / `Overlaps NN-… — sequenced after it` /
  `Depends on NN-… — gated by a precondition; dies if NN blocks`).
- The load-bearing assumptions from step 6: which you verified and how (probe run, arithmetic
  done), and which are gated as Preconditions instead — or "none; the plan stands on the tree
  as it is".
- The questions you asked in step 8 and how the answers shaped the plan (or "no open questions
  came up").
- The effort level you chose, and why.
- Anything you deliberately left out of scope.
- That they can preview the composed prompt with
  `powershell -File C:/code/agentic-loop/scripts/run-plans.ps1 -DryRun -SkipSync -SkipPreflight -SkipDevServers`
  from the repo root.

## Guardrails

- **This skill writes one markdown file.** Do not implement the plan, edit production code,
  create tests, or commit anything.
- Never renumber, rename, or edit existing plan files; if the user wants a change to an existing
  plan, edit that plan in place and leave its number alone.
- Never invent a file path or symbol name — confirm it exists first, or describe it as something
  the agent must locate.
- **Never publish a plan that leaves an open question.** Any ambiguity, undecided design choice,
  or gap in the request must be resolved by asking the user **before** the file is written
  (step 8). An ambiguity resolved now costs one question; resolved at 3 a.m. by an unattended
  agent it costs a wrong commit.
- **Never publish a plan with an unverified, ungated load-bearing assumption.** Every mechanism,
  fit, and consumed artifact the acceptance rests on is either proven at authoring time or written
  into *Preconditions* as a fail-fast check (step 6). "The tool exists" is not "the tool can do
  this".
- Do not add an "Out of scope" section that duplicates *Scope / Out*, and do not add sections the
  template does not have (*Preconditions* excepted).

### Running in parallel

Many instances of this skill can run at once. The sequence number is safe: it is claimed
under a lock at write time, so numbers are always distinct and contiguous.

**The overlap scan in step 2 is not covered by that lock**, and cannot be — a plan that
another agent has not written yet is invisible to you. Two agents given similar briefs at
the same moment can both scan clean and both publish. To keep that window small, do the
scan as late as you can and go straight from it to step 9; do not scan, then spend a long
research phase, then publish against stale knowledge.

The residual risk is real but bounded: you get two overlapping plans in the queue, which a
human sees on review, rather than corrupted numbering that is hard to spot. If the user is
fanning out several plans at once over related areas, say so in your report so they can
check for overlap across the batch.
