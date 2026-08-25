# Plan runner

A queue of numbered plan files, executed one at a time by Claude Code, unattended.

```
plans/
  _project.md           this project's rules, appended to the runner's standing instructions
  runner.json           this project's runner config (workspace dir, gates, dev servers, hooks)
  _template.md          skeleton for a new plan
  00-first-thing.md     the queue — run in filename order
  01-next-thing.md
  reports/              one report per plan, committed with the change
  logs/                 raw stream-json transcripts + composed prompts (gitignored)
  .state.json           what has completed (gitignored)
scripts/run-plans.ps1          the driver
scripts/claim-plan-number.mjs  atomically claims the next NN when adding a plan
```

`.state.json` is this machine's record; **git is the durable one**. A queued plan file is untracked
and the plan that implements it commits its own file, so a plan file that is *tracked* is one that
shipped — and the runner counts it as done even with nothing in `.state.json` saying so. That is what
lets a second machine run the queue from a plain clone instead of re-implementing everything on disk.
`node scripts/plan-ledger-cli.mjs` prints what it makes of the two records together.

Two consequences worth knowing. **Committing a plan file ahead of the queue now silently marks it
done** — nothing in the normal workflow does that, but a stray `git add plans/…` costs you a skipped
plan. And a **`wont-do` plan has no commit to be tracked by**, so it is settled only by this machine's
`.state.json`: delete its file from disk when you abandon it, or a fresh clone will queue it again.

## Running it

```powershell
# see the schedule and composed prompts without invoking anything
.\scripts\run-plans.ps1 -DryRun

# run everything not yet completed
.\scripts\run-plans.ps1

# just one plan, even if already done
.\scripts\run-plans.ps1 -Only 03 -Force
```

Useful switches: `-Yolo` (skip permission prompts entirely), `-StopOnFailure`,
`-SkipVerify` (don't re-run package tests after each plan), `-SkipSync` (never contact the
remote — for running with no network), `-Model sonnet`, `-TimeoutMinutes 45`,
`-MaxBudgetUsd 5`, `-KeepPlanBranches`, `-BranchPrefix wip/`, `-ReleaseEachPlan` (tag and push
every plan that verifies), `-WaitForDeploy` (block on each web deploy instead of handing it over
as pending — for a standalone run with no ticket loop behind it).

Anything dirty **under `plans/` or `scripts/`** is fine — queued plan files, one you are still
writing, a report left by an earlier batch, a helper script half-rewritten in another window. That
is the runner's own paperwork and the tooling that drives it, and refusing to start over it only
ever cost a run. Anything dirty **elsewhere** stops the run dead: this machine is also the
development machine, and an unattended agent must not build on top of work in progress. Ask
`node scripts/plan-tree-cli.mjs` what the runner will make of the tree.

The `scripts/` tolerance is measured, not blanket. The paths already dirty when a plan starts ride
along; anything *else* under `scripts/` at the end is that plan's own doing, and a plan that
changed a script without committing it fails exactly as it always did. Otherwise a plan whose whole
job is a tooling change could strand its deliverable and still be marked complete.

## What happens per plan

Before any of it, the base branch is fetched and fast-forwarded onto its remote. Origin is the real
base branch; this machine's copy of it is just a copy. That has to happen before the pre-flight,
because the pre-flight measures the quality and visual baselines *from the base tree* — measure a
stale one and every plan in the run inherits a baseline that does not describe the tree it branches
off, and the ratchets blame it for reds that came from a commit nobody had fetched. A base branch
that tracks no remote skips all of it and says so once; so does `-SkipSync`.

The visual half of that measurement is usually not taken here at all. Every plan runs the same
suite during its own verification, on its own branch — and that branch tip is exactly what the base
branch fast-forwards to when the plan merges. So the set is recorded at the merge, in
`plans/.preflight-bank.json` (gitignored, runner-owned), and a batch whose base branch sits at the
commit that record names reads it back instead of spending four more minutes deriving it again. The
record names **one commit** and is trusted for that commit only: a plan that changed
`frontend-boardfest`, `frontend-shared` or `shared` may only bank what its own sweep saw, anything
else clears it, and the next pre-flight measures from scratch. `npm run test` is not part of this —
it runs for every package on every batch, and a red one still refuses the queue.

1. **Branch** — `git checkout -b plan/<plan file>` off the branch you started the runner on. No plan
   is ever implemented on the integration branch; if it fails, its work stays on its own branch and
   the branch you started from never saw it. A branch left by an earlier attempt is stepped around
   (`plan/07-thing-2`), never reused.
2. **Compose** — `_preamble.md` + the plan body + a per-run trailer (report path, position in queue).
   The plan's front matter is taken off the top first: it is the runner's setting, not the agent's
   instruction, so what reaches the session is the plan itself.
3. **Invoke** — `claude --print` in a fresh session, streaming `stream-json` to `plans/logs/`, with a
   wall-clock timeout, an optional spend cap, and the effort level this plan asked for. Fresh session
   per plan is deliberate: no context bleed, no accumulated wrong assumptions, and the repo is the
   only handoff.
4. **Verify** — the runner checks, itself: a new commit exists, the tree is clean apart from other
   paths under `plans/` and the `scripts/` paths that were already dirty when this plan started
   (this plan's own file *and its report* must be in that commit), `npm run test`
   is green in every `packages/*` directory the commit touched, and each touched package's
   `tsc --noEmit` error count and eslint problem count have not risen against
   `plans/.quality-baseline.json` (measured by `scripts/quality-counts.mjs`; counts ratchet
   down as plans improve them, and a first-seen package just has its counts recorded).
   CI enforces the same ratchet on every push and PR — `.github/workflows/quality-gate.yml`
   runs `scripts/quality-gate.mjs` against the *committed* `scripts/quality-baseline.json`,
   so attended commits are held to the same bar. After a plan batch lowers counts, lock the
   improvement in with `node scripts/quality-gate.mjs --update` and commit the baseline.
5. **Integrate** — the base branch is synced with its remote again, the branch is pushed *straight at
   the remote base branch* (`git push origin plan/07-thing:main`), and only once the remote has
   accepted it is it fast-forwarded locally. So the base branch only ever fast-forwards, here and on
   origin: the history reads exactly as it did when plans committed straight onto it, and no tree
   lands there that was not verified as a whole. The merged branch is then deleted (it holds nothing
   the base branch does not); pass `-KeepPlanBranches` to keep it.

   The remote goes first on purpose. Fast-forward locally and *then* get the push rejected, and the
   base branch is at once ahead by this plan's commit and behind by the incoming one — diverged, and
   recoverable only with a reset. Let the remote arbitrate and a rejection has changed nothing here,
   so the retry is just the same three steps again.
6. **Record** — result to `.state.json`, including the branch it ran on. Completed plans are skipped
   on the next run.

Under `-ReleaseEachPlan`, a verified plan is tagged and pushed while its commit is still HEAD, and
its deploy is recorded as `pending` — the runner does not watch the build. The ticket loop settles
that record on a later tick, once the Actions run has concluded, and moves the ticket then. Waiting
here cost a median of 6.3 minutes per shipped plan and blocked everything behind it; pass
`-WaitForDeploy` to get the verdict in-run instead, bounded by `-DeployTimeoutMinutes`.

### When the fast-forward is refused

Something moved the base branch while the plan was running — a commit of yours, or one that arrived
from another machine when the base branch was synced. Then the branch is **rebased** onto the new
base and the integration is retried. That is the point of syncing first: a commit pushed from
somewhere else takes the same rebase-and-re-verify path a local one always did, so it can never land
a plan on `main` untested.

A push the remote **rejects** — origin moved during this plan's verification — is retried exactly
once, from the sync. A second rejection fails the plan: its branch is kept, its file is put back
untracked, and the next run retries the whole thing rather than looping against a remote somebody is
actively pushing to.

A rebase that conflicts gets exactly one attempt at resolution: a scoped session that sees only the
conflicted files and is told to keep both intents or abort. Its word is never taken for it. The
runner checks the repository afterwards — the rebase finished, the branch still sits on top of the
base, it still carries a commit of its own, and no file it was asked to resolve still has conflict
markers in it — and then **runs the whole verification again**, because a rebased tree is not the
tree that was verified. Only then does it merge. Anything short of that and the plan is failed with
its work left on its branch.

A plan that fails verification is marked `needs-review` and **the queue moves on** to the next
plan. Pass `-StopOnFailure` to halt at the first failure instead.

Continuing is only safe because the runner puts the repository back first. The next plan has to
start on the base branch with a tree its cleanliness check will accept, or one failure cascades
into every plan behind it. So after a failure the runner:

- leaves the work where it is — on the failed plan's own branch, named in `.state.json`. Nothing to
  recover, nothing to reset; read it with `git log plan/<plan file>` or delete the branch.
- **pushes that branch**, so a night's failed work is readable from a dev box rather than only from
  the machine that ran it. Nothing is merged by this: the branch goes up under its own name, and
  only the base branch is ever fast-forwarded. A push that fails here is reported and shrugged off —
  the plan has already failed, and losing the rest of the tidy-up over it would strand the queue.
- stashes anything the agent left loose in the tree rather than deleting it (`git stash list` to
  recover). That stash names explicit paths and never touches the queued plan files.
- puts the plan file back on disk, untracked, so the queue can retry it — it was committed on the
  branch, and switching away took it out of the tree.
- commits the report onto the base branch, so the account of the failure is where you will look for
  it rather than on a branch you have to know about.

The run ends with a summary of what passed, what needs review, and a non-zero exit code if anything
did.

## Writing a plan

Use the `add-plan` skill, which researches the code, drafts against `_template.md`, and publishes
via the claim script. To add one by hand, write the body to a scratch file and then:

```powershell
node scripts/claim-plan-number.mjs --slug my-plan-title --body <scratch-file>
```

Do not name the file yourself. Scanning for the highest number and then writing is a TOCTOU race:
two authors both read `05`, both pick `06`, and because their titles differ the files do not even
collide — you just get an ambiguous slot in the queue. The script decides and uses the number inside
one lock-held critical section, so any number of authors can run at once. It always appends after
the highest number and never fills gaps (a deleted `02` is not a free slot — reusing it would
silently reorder queued work).

The two fields that decide whether the run succeeds:

- **Context** — name the actual files and symbols. An agent that has to guess where the code lives
  spends its budget searching and often lands in the wrong module.
- **Scope → Out** — the explicit non-goals. This is what stops a drive-by refactor from landing in
  the same commit as the feature.

Keep one plan ≈ one commit ≈ one reviewable change. If a plan needs more than a handful of files
touched, split it — the queue is cheap, a 40-file unattended commit is not.

### How hard the session thinks

Every plan runs on Opus. What a plan chooses is the *effort*, in front matter at the top of the file:

```markdown
---
effort: high   # low | medium | high | xhigh | max
---

# Title
```

The runner passes it to `claude --effort` for that plan's session, and for the scoped session it may
get to resolve a rebase conflict — the same plan's work, so the same level. It is stripped before the
body is composed into the prompt.

| Level | When |
| --- | --- |
| `low` | Mechanical and local — a string, a constant, a rename the compiler catches. |
| `medium` | One package, an existing pattern to copy, criteria that map one-to-one onto named tests. |
| `high` | **The default, and most plans.** Several files or packages, a new abstraction or shared type, tests that still need designing. |
| `xhigh` | Concurrency or ordering, a migration or wire-format change, a bug with no known repro. |
| `max` | Work you expect to fail at `xhigh`. Rare, and slow. |

Two behaviours worth knowing. **A plan with no front matter runs at `high`** — which is every plan
file written before this existed, so the standing queue is unchanged. And **a misspelt level fails
that plan before its session starts**: `claude --effort hgih` is only a warning, so the alternative
is a plan silently running at an effort somebody deliberately chose against.

## Guardrails worth keeping

- **Each plan branches itself, the batch does not.** Only verified plans reach the branch you start
  on, but they do reach it, one fast-forward at a time. For a batch you want to throw away as a
  whole, still start it somewhere disposable: `git switch -c plan-run/$(Get-Date -Format yyyyMMdd)`.
- **Whatever branch you start on is the one plans merge into.** The runner refuses to start on a
  `plan/*` branch left by an earlier run, because the whole batch would end up stacked on top of
  work that was never verified.
- **Review the commits, not the reports.** The report is the agent's account of itself; the diff is
  the evidence. Reports are useful for spotting *where* it went wrong, not *whether*.
- **`-DryRun` first** whenever you change `_preamble.md`. That file multiplies across every plan.
- **The 2% snapshot tolerance is a real hole.** Visual baselines can pass a genuine regression, so
  treat "visual tests green" as weaker evidence than a PNG someone actually looked at.
