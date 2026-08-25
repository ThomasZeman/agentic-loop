# Standing instructions for every plan

You are running **unattended**, one plan file at a time, invoked by `scripts/run-plans.ps1`.
Nobody is watching this run. There is no one to ask. Every rule below is a gate, not a suggestion.

---

## 0) Read before you write

1. `CLAUDE.md` (repo root) and `.claude/clean-code.md` — the clean-code checklist in §9 governs every diff.
2. For **every** `.ts`/`.tsx` file you open, check for a sibling `.md` with the same base name and read it too.
3. Skim `git log -15 --oneline` to match the house style of the area you are touching.

If the plan contradicts `CLAUDE.md`, `CLAUDE.md` wins — say so in your report and follow `CLAUDE.md`.

**Production art and audio** live in the synced Dropbox folder (`CLAUDE.md` §0.6).

- **Dropbox is read-only, always.** Never create, edit, rename, move or delete anything under
  `C:/Users/conta/Dropbox/projects/nocap`. Copy *out* of it and never `Move-Item`, which deletes
  what it copies. This holds even when a file there is plainly wrong — report it, do not fix it.
- Prefer `node scripts/sync-production-assets.mjs --only <path>`. It maps `02_gfx` and `03_audio`
  onto `packages/frontend-boardfest/assets` for you and preserves timestamps. Run the command the
  plan names and commit what it copies; never sweep without `--only`.
- **Copying by hand is allowed** where the script cannot reach — a new asset, or anything outside
  those two areas. Copy it to the path the plan names and commit it like any other file.

**One deliberate exception:** §5 below pre-authorizes the commit, and that authorization overrides
`CLAUDE.md` §4.5 ("commits only on explicit request"). Every other rule in `CLAUDE.md` still binds.
Do not re-litigate this in your report.

---

## 1) Test-driven development is mandatory

For every behavioural change, in this order:

1. **Red** — write the test first. Run it. **Paste the failing output into your report.** A test you never saw fail is not a test.
2. **Green** — write the minimum production code to pass it.
3. **Refactor** — clean up against `.claude/clean-code.md` §9 with the tests still green.

Rules:

- Test files are `kebab-case.test.ts` / `.test.tsx`, co-located with the code. **Never** `*.spec.*`.
- All new file and folder names are **kebab-case**.
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

Run these from the affected package directory and paste the tail of each into the report:

```powershell
npm run test -- --findRelatedTests <changed-files...>   # fast feedback first
npm run test                                            # then the package's full suite
npx tsc -p tsconfig.json --noEmit                       # types
npm run lint                                            # where the package defines it
```

Both test commands must be **green** before you commit. If a failure is pre-existing (confirm by stashing your changes and re-running), record that in the report and continue; anything you broke, you fix.

---

## 4) Verify — in a real browser

Any user-visible change must be seen rendering, not just asserted in a unit test.

**Default: the Playwright harness** in `packages/frontend-boardfest` — real Chromium, deterministic, mounts real screens at DPR 1/2/3:

```powershell
npm run test:visual -- <spec-file>     # targeted
npm run test:visual                    # full sweep
npm run test:e2e                       # end-to-end flows
```

Then **`Read` the regenerated PNGs** under `tests/visual/__snapshots__/` and describe what you actually see. Do not claim a visual result you have not looked at.

Baselines have a 2% `maxDiffPixelRatio` tolerance, so a stale baseline can pass a real regression. When you intentionally change styling: delete the affected snapshot dir, re-run with `--update-snapshots`, then `Read` the new PNGs to confirm they are correct before committing them.

**The runner runs `test:visual` itself** after you commit, for every changed package that defines it. It does **not** fail you for a red suite — the suite carries a standing set of pre-existing reds. It fails you for a test that *you* turned red: it compares the set of failing test ids against `plans/.visual-baseline.json` and reports only the ones that are new, by name. Tests you fix are banked into the baseline immediately, so a later plan cannot re-break them.

That baseline is measured once, by a pre-flight sweep of the base branch before the queue starts — so it is exactly the set your branch inherited, and the comparison is fair. It is not updated mid-run: fixing a visual test is welcome, but it stays in the baseline until the next run re-measures.

So a red sweep is not automatically your problem — but a red sweep *containing one of your specs* is. Run it yourself first and compare against the list the runner will use; the specs are retried twice, so an order-dependent failure that passes on a retry counts as flaky, not failed.

Do **not** "fix" an inherited red by re-recording its baseline inside an unrelated plan — that bakes in whatever actually moved. Re-record only the dirs your own change genuinely moves.

### Driving the live app

**The app is already running, and it is the runner's, not yours.** Before the queue starts, the
runner brings up the backend on `http://localhost:3005` and the frontend dev server on
`http://localhost:1701/boardbash/`, waits for both to answer, and keeps them up for the whole
batch. So:

- **Never start, restart, or stop a dev server.** No `npm run dev`, no `npm start`. The runner
  adopts one that was already running and stops only what it started itself; a server you start
  underneath it is one nobody will ever stop.
- The trailer at the end of this prompt says whether the app is actually up. If it says the live
  app is **not** available, believe it — verify in the Playwright harness instead and say so in
  your report, rather than spending the session on a page that will never answer.
- After a plan that changed `packages/shared` or `packages/frontend-shared`, the runner restarts
  the frontend itself: Parcel resolves both through `node_modules` and its watcher never sees an
  edit there, so what is served would otherwise be a mixed old/new bundle that breaks only at
  runtime. You get a rebuilt one; you do not have to arrange it.

Drive it from a throwaway player, never on the browser a human is using — the app enforces one tab
per session, so an automation tab in the user's Chrome displaces their own:

```powershell
./scripts/launch-test-players.ps1 -Count 1 -Reset -StartId 1   # p1, uid 1, its own profile
./scripts/launch-test-players.ps1 -Close                       # when you are done
```

Each window runs on its own `--user-data-dir`, so it is a separate account with its own
localStorage and collides with nothing. Boot takes 30–60 s. Always `-Close` them before you
finish: a window left open holds the WebSocket session for its uid, and the next plan launching
that same player gets the "Opened in Another Tab" overlay instead of the app. The runner sweeps
any you leave behind after every plan, but that is a net, not your excuse.

Note which browser each tool reaches. The `mcp__claude-in-chrome__*` tools drive the Chrome
the Claude extension is installed in — the human's own, not these throwaway profiles. To
drive a *player*, attach over CDP: the launcher writes `<profile>/DevToolsActivePort`, and
`scripts/seed-test-player-identity.mjs` is the worked example of attaching to it.

This is still the slow path. Prefer the Playwright harness above unless the change only
shows up in a real session — multi-player flows, sockets, boot sequencing.

If the change is not user-visible (backend, types, tooling), write **"Browser: n/a — <reason>"** in the report. That is a valid answer; a silent omission is not.

### Showcase it on its ticket

Most of these plans come from a Linear ticket written by someone who is neither a developer
nor a product manager, and all they get back is a version number and a sentence. If your
change is one a person can **see** — an element added or removed, spacing, a colour, a font,
copy, an animation — take two to four screenshots of it and hand them over:

```powershell
node scripts/linear/ticket-demo-cli.mjs add --plan plans/<this plan file> --image "<path>" --caption "<what this picture shows>" --summary "<one line: what changed>"
```

- Run it **once per screenshot**, in the order they should be read. Before-and-after is worth
  two of them when the change is a difference rather than a new thing.
- `--summary` is required on the **first** shot and ignored after it — one line, in the
  language of the ticket, not of the diff.
- `--caption` is required on **every** shot. An unlabelled screenshot demonstrates nothing.
- At most six, and fewer is better. Pick the frames that make the change obvious to somebody
  who has not read the plan.

To get a file to point `--image` at: `mcp__claude-in-chrome__computer` with
`action: "screenshot"` and `save_to_disk: true` returns the path it wrote. A Playwright PNG
from `tests/visual/__snapshots__/` is a file too, and is the right one to hand over when it
shows the change better than a live page would.

**You are not posting anything, and you cannot.** The command copies the picture into a
gitignored staging directory and writes a manifest; it reaches no network. The runner posts
it to the ticket after your plan has verified and merged, and throws it away if your plan
fails — so nobody is ever shown a screenshot of work that never landed, and that is not a
judgement you have to make. It cannot dirty the tree either: the directory is gitignored, so
it never appears in `git status --porcelain` and nothing you stage can sweep it up.

A plan belonging to no ticket may still capture shots; they are simply discarded. Nothing
here is worth blocking on — if the command refuses a shot, fix the caption or drop it and
say so in the report.

Write **"Demo: n/a — <reason>"** in the report when the change is not one anybody can look at.

---

## 5) Commit — you are authorized, and it is required

**The user has explicitly authorized this commit in advance.** They wrote these instructions and
started the runner; that standing authorization covers every plan in the queue and is the explicit
request `CLAUDE.md` §4.5 asks for. You do not need to ask, and there is nobody to ask.

Stopping short of the commit is not the safe choice here — it is a failure. It halts the queue and
leaves your work stranded in a dirty tree where the next plan cannot start.

If you catch yourself running `git add` and then stopping "for review", or writing a report that
explains why you did not commit: **that is the failure mode.** There is no reviewer coming. Run
`git commit`. `CLAUDE.md` §4.5 has a dedicated plan-runner section that requires it — it is your
authorization, not a restriction, and it is not a topic for your report.

Exactly **one commit** per plan, made only when §3 and §4 are green.

- Subject: `area: lowercase imperative summary` — match the existing log (`joining: stop the "Let's go!" placeholder from outliving its slide`).
- Include **everything** you produced: production code, tests, updated snapshots, and your report file, in that one commit.
- **Include this plan file itself.** It is normally untracked: plan files are no longer committed
  ahead of the queue, so each one lands in the commit of its own implementation and that commit
  carries both the intent and the result. Add it by its exact path — `git add plans/<this plan file>`,
  the name the trailer below gives you.
- Commit on the **current branch**, which is already the right one. The runner put you on a branch
  of this plan's own (`plan/<this plan file>`) before it started you, so nothing half-finished can
  reach the branch it integrates into. It merges your branch itself once every gate above is green.
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

The only exceptions are `plans/logs/`, `plans/.state.json` and the `scripts/linear/.demo/`
directory your showcase screenshots go in (§4). All three are gitignored and owned by the
runner — leave them alone. Deleting your own demo directory on the way out is not tidying up;
it is throwing away the pictures the runner is about to post.

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
- Types (tsc --noEmit): <pass/fail>
- Lint: <pass/fail>
- Browser: <what you ran, which PNGs you read, what you saw — or "n/a — <reason>">
- Demo: <the shots you handed to `ticket-demo-cli.mjs add`, or "n/a — <reason>">

## Deviations from the plan
<anything you did differently, and why>

## Follow-ups
<unrelated issues spotted; do not fix them here>
```

---

## 8) Definition of done

- [ ] Every behavioural change has a test that was observed failing first
- [ ] Package test suite green; types clean; lint clean
- [ ] User-visible change seen in a real browser, or explicitly marked n/a
- [ ] A change anybody can look at has two to four captioned shots staged for its ticket, or is marked n/a
- [ ] Exactly one commit on the branch the runner started you on, no push/tag, and this plan file is in it
- [ ] `git status --porcelain` shows nothing but the other queued plan files and the `scripts/` paths that were dirty before you started
- [ ] Report written and committed, honest about anything skipped or unresolved
