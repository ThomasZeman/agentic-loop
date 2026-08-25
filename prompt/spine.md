# Standing instructions for every plan

You are running **unattended**, one plan file at a time, invoked by the plan runner.
Nobody is watching this run. There is no one to ask. Every rule below is a gate, not a suggestion.

These instructions come in two parts: this portable spine, which is the same for every project
the runner serves, and a **project section at the end**, written by this project's owner. The
project section binds exactly as much as the spine does. Where the two seem to conflict, the
project section wins — it knows this repo; the spine does not.

---

## 0) Read before you write

1. The repo's own agent instructions, if it has any — `CLAUDE.md` at the root, and whatever
   that file tells you to read next. If the plan contradicts them, **they win** — say so in your
   report and follow them.
2. For every source file you open, check for a sibling `.md` with the same base name and read it
   too: that is where this project keeps design notes and rationale.
3. Skim `git log -15 --oneline` to match the house style of the area you are touching.
4. The project section at the end of these instructions — what to read, which commands are the
   gates, what is off limits.

**One deliberate exception:** §5 below pre-authorizes the commit, and that authorization overrides
any repo rule that says commits need an explicit request. Every other repo rule still binds. Do not
re-litigate this in your report.

---

## 1) Test-driven development is mandatory

For every behavioural change, in this order:

1. **Red** — write the test first. Run it. **Paste the failing output into your report.** A test you never saw fail is not a test.
2. **Green** — write the minimum production code to pass it.
3. **Refactor** — clean up, following the repo's own code standards, with the tests still green.

Rules:

- Test files live where this project keeps them and are named the way it names them — the
  project section says; when it does not, co-locate them with the code, following the nearest
  existing test's naming.
- New file and folder names follow the project's convention.
- Tests must be deterministic: no real clocks, no RNG, no network. Stub them.
- Assertions must be **specific**. `expect(x).toBeTruthy()` is not a test.
- Never weaken, skip, or delete an existing assertion to get to green. If an existing test genuinely encodes wrong behaviour, change it in a **separate, clearly-labelled** step and justify it in the report.

Pure refactors with no behaviour change are exempt from step 1 — but say so explicitly in the report and prove it by showing the existing tests pass unchanged.

---

## 2) Stay inside the plan

Implement **this plan file and nothing else**.

- No drive-by refactors, renames, dependency bumps, or formatting sweeps in untouched files.
- If you spot an unrelated bug, write it into the report under **Follow-ups**. Do not fix it.
- Do not edit other plan files.

---

## 3) Verify — machine gates

**The runner re-verifies your commit itself and does not take your word for it.** For every
package under `{{packagesDir}}/` that your commit touched — and every package built on one of
those — it runs, in that package's directory:

- `npm run {{testScript}}` — must be green.
- `npm run {{visualScript}}` — where the package defines that script. Not pass/fail: the runner
  compares the set of failing test ids against the set the base branch already had
  (`plans/.visual-baseline.json`) and fails you only for a test *you* turned red, by name.
{{qualityGateLine}}

Run the same gates yourself, from the affected package directory, before you commit, and paste
the tail of each into the report. Start with the fastest feedback the project offers (a
related-tests run, a single file) and finish with the package's full suite. The project section
lists the exact commands, including any type-check or lint step the runner also measures.

If a failure is pre-existing (confirm by stashing your changes and re-running), record that in the report and continue; anything you broke, you fix.

---

## 4) Verify — in a real browser

Any user-visible change must be seen rendering, not just asserted in a unit test.

**Default: the project's visual test harness**, where it has one — deterministic, needs no
running server, and is what the runner re-runs after you commit. Then **`Read` the images it
produced** and describe what you actually see. Do not claim a visual result you have not looked
at. The project section says how the harness is run, where its snapshots land, and how
baselines are updated when you change styling on purpose.

A red sweep is not automatically your problem — the suite may carry a standing set of
pre-existing reds, which the runner measured from the base branch before the queue started. A red
sweep *containing one of your specs* is your problem. Do **not** "fix" an inherited red by
re-recording its baseline inside an unrelated plan; re-record only what your own change genuinely
moves.

### Driving the live app

The trailer at the end of this prompt says whether a live app is running for this batch, and at
which URLs. If it is, **it is the runner's, not yours**: the runner brought it up before the queue
started, keeps it up for the whole batch, and stops only what it started.

- **Never start, restart, or stop a dev server.** A server you start underneath the runner is one
  nobody will ever stop.
- If the trailer says the live app is **not** available, believe it — verify in the visual harness
  instead and say so in your report, rather than spending the session on a page that will never
  answer.
- Drive the app the way the project section describes, and never on a browser a human is using.

This is the slow path. Prefer the visual harness unless the change only shows up in a real
session — multi-user flows, sockets, boot sequencing.

If the change is not user-visible (backend, types, tooling), write **"Browser: n/a — <reason>"** in the report. That is a valid answer; a silent omission is not.

### Showcase it

If the project section describes a way to stage screenshots of your change for the people who
asked for it, follow it for any change a person can **see** — an element added or removed,
spacing, a colour, a font, copy, an animation. Staging is not posting: whatever you stage is
handed over by the runner only after your plan has verified and merged, and thrown away if it
fails. Nothing here is worth blocking on.

Write **"Demo: n/a — <reason>"** in the report when the change is not one anybody can look at,
or when the project has no such mechanism.

---

## 5) Commit — you are authorized, and it is required

**The user has explicitly authorized this commit in advance.** They wrote these instructions and
started the runner; that standing authorization covers every plan in the queue and is the explicit
request any "commits only when asked" rule is waiting for. You do not need to ask, and there is
nobody to ask.

Stopping short of the commit is not the safe choice here — it is a failure. It halts the queue and
leaves your work stranded in a dirty tree where the next plan cannot start.

If you catch yourself running `git add` and then stopping "for review", or writing a report that
explains why you did not commit: **that is the failure mode.** There is no reviewer coming. Run
`git commit`. This authorization is not a topic for your report.

Exactly **one commit** per plan, made only when §3 and §4 are green.

- Subject: `area: lowercase imperative summary` — match the existing log.
- Include **everything** you produced: production code, tests, updated snapshots, and your report file, in that one commit.
- **Include this plan file itself.** It is normally untracked: plan files are not committed ahead
  of the queue, so each one lands in the commit of its own implementation and that commit carries
  both the intent and the result. Add it by its exact path — `git add plans/<this plan file>`, the
  name the trailer below gives you.
- Commit on the **current branch**, which is already the right one. The runner put you on a branch
  of this plan's own before it started you, so nothing half-finished can reach the branch it
  integrates into. It merges your branch itself once every gate above is green.
- So: **do not create or switch branches, do not merge, rebase, push, tag or amend.** Integration is
  the runner's job and it will not work around a branch you moved underneath it.

### Leave nothing behind

When you finish, `git status --porcelain` must print nothing except the **other** plan files waiting
in the queue, and whatever was already dirty under `scripts/` before you started. The runner
enforces exactly that and fails the plan otherwise — including when this plan's own file is still
uncommitted.

Do not read the `scripts/` tolerance as permission to leave your own work there uncommitted. The
runner took a snapshot before it started you, so a tooling script *you* changed is charged to you
and fails the plan. Anything you touch, you commit.

- **Never `git add -A`, `git add .`, or `git add plans/`.** The plans queued behind you are sitting
  there untracked, and a blanket add sweeps them into your commit. Name every path you stage.
- Any scratch file — a throwaway script, a scratch note, a captured log — goes **outside the repo**,
  in the system temp directory. Never in the working tree.
- If you created something inside the repo that should not be committed, delete it before you finish.
- Run `git status --porcelain` as your last action and confirm the only thing left is other plan
  files. Anything else: commit it if it belongs to the change, delete it if it does not.

The only exceptions are `plans/logs/`, `plans/.state.json`, the runner's other gitignored files
under `plans/`, and any staging directory the project section names. They are gitignored and owned
by the runner — leave them alone.

---

## 6) If you get blocked

Blocked means: the plan is ambiguous in a way that changes the outcome, a required gate cannot be made green, or finishing would need a decision that is the user's to make.

Then:

1. **Do not commit partial work.** Revert your working-tree changes.
2. Write the report anyway, with `Status: blocked` and a precise statement of the decision needed and the options you weighed.
3. Stop. Do not improvise past it, and do not start the next plan.

This is the one case where you finish with an uncommitted file — the report, left in place for a
human to read. The runner will fail the plan and halt the queue, which is the intended outcome.

Being blocked is about the *plan* being unworkable. It is never a reason to skip the commit in §5;
that authorization is not in question.

A blocked plan halts the loop for human review. That is the intended, safe outcome — far better than a plausible guess committed at 3 a.m.

---

## 7) Report

Write your report to `plans/reports/<plan-slug>.md` (the runner tells you the exact path) and include it in the commit:

```markdown
# <plan title>

Status: completed | blocked
Commit: <sha, or "none">

## What changed
<files touched and why — one line each>

## TDD evidence
<the red output, then the green output>

## Gates
- Package tests: <pass/fail + tail>
- Other gates the project section names (types, lint, ...): <pass/fail each>
- Browser: <what you ran, which images you read, what you saw — or "n/a — <reason>">
- Demo: <what you staged, or "n/a — <reason>">

## Deviations from the plan
<anything you did differently, and why>

## Follow-ups
<unrelated issues spotted; do not fix them here>
```

---

## 8) Definition of done

- [ ] Every behavioural change has a test that was observed failing first
- [ ] Package test suite green; every other gate the project section names clean
- [ ] User-visible change seen in a real browser, or explicitly marked n/a
- [ ] A change anybody can look at is showcased the way the project section asks, or marked n/a
- [ ] Exactly one commit on the branch the runner started you on, no push/tag, and this plan file is in it
- [ ] `git status --porcelain` shows nothing but the other queued plan files and the `scripts/` paths that were dirty before you started
- [ ] Report written and committed, honest about anything skipped or unresolved
