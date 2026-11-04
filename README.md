# agentic-loop

An unattended plan runner for Claude Code, shared across projects: clone it next to your
repos and point each one at it.

It executes numbered plan files (`plans/NN-title.md`) through Claude Code, one at a time:
each plan gets its own branch and a fresh headless session, the runner verifies the outcome
itself (a commit exists, the tree is clean, the affected packages' tests are green, quality
counts have not risen), integrates the branch onto the base branch, and records the result
in `plans/.state.json`. A plan that fails is marked `needs-review`, its work stays on its
branch, and the queue moves on.

## Using it from a project

Run the runner from the target repo's root — it finds the repo via `git rev-parse
--show-toplevel` from the working directory, and finds its own helper scripts next to
itself:

```powershell
# PowerShell, from e.g. C:\code\my-project
pwsh C:\code\agentic-loop\scripts\run-plans.ps1 -DryRun
```

The target repo needs a `plans/` directory. Seed it from `templates/plans/`:

- `_project.md` — this project's own rules, appended to the runner's standing instructions
  (see below)
- `runner.json` — the runner's per-project config (see below); optional
- `_template.md` — the skeleton new plans are drafted against
- `.gitignore` — keeps the runner's state, logs, and baselines out of the repo
- `README.md` — the plans-directory contract, for humans and for planning agents

## The prompt: spine + project section

Every plan's prompt opens with standing instructions. They come in two parts:

- **The spine**, `prompt/spine.md`, shipped with the tool — TDD, staying in scope, the gates
  the runner itself enforces (named from `runner.json`, so prompt and verification cannot
  disagree), the browser rule, the commit authorization, the blocked protocol, the report
  format, the definition of done.
- **The project section**, `plans/_project.md` in the target repo — what only that project's
  owner can say: what to read first, the exact gate commands, how its visual harness and live
  app are driven, how to stage a showcase, what is off limits. Appended after the spine under
  a `# Project section` heading; it binds as much as the spine and wins where they conflict.

A repo that carries a whole `plans/_preamble.md` instead gets it used verbatim and the spine is
not consulted — for a project that wants to own the entire prompt.

`templates/skills/` holds generic `run-plans` and `add-plan` Claude Code skills to copy into a
project's `.claude/skills/` and fill in.

## Per-project configuration: `plans/runner.json`

Optional. The defaults are neutral npm conventions — a `packages/` workspace, `test` and
`test:visual` gate scripts, the quality ratchet on — with no dev servers, no watcher-blind
packages and no hooks. A project declares what it has and overrides what differs:

```json
{
  "packagesDir": "modules",
  "gates": {
    "test":    { "script": "test", "timeoutMinutes": 20 },
    "visual":  { "script": "test:screens", "timeoutMinutes": 30,
                 "report": "test-results/visual-report.json" },
    "quality": { "enabled": false, "timeoutMinutes": 15 }
  },
  "devServers": [
    { "name": "api", "url": "http://127.0.0.1:4000/", "packageDir": "modules/api",
      "npmScript": "dev", "startTimeoutSeconds": 180, "readyWhen": "any-response" }
  ],
  "watcherBlindPackages": []
}
```

- `packagesDir` — the directory holding one workspace package per subdirectory. Every
  package with the `test` gate's script is swept in pre-flight and verified when changed.
  A directory that does not exist is warned about at startup (`!!`) and means no package
  verification for any plan in the run - check the value if the warning surprises you.
  `""` (or `"."`) is for a project with no workspace wrapper: the packages *are* the repo
  root's own subdirectories. That shape gets no startup warning - the repo root always
  exists - and sweeps every root subdirectory, narrowed first to the ones carrying a
  `package.json` and then to the ones defining the gate's script, so `node_modules`,
  `plans` and `docs` fall out on their own.
- `gates.test` / `gates.visual` — npm script names and deadlines. The visual gate applies
  only to packages that define its script; `report` is where its JSON report lands,
  relative to the package directory (Playwright report shape). A plan may opt out of the
  sweep by writing `**Visual gate:** none — <reason>` in its *Browser check*; the runner
  honours that unless the plan's diff touches a path on `gates.visual.alwaysFor` (file
  extensions with a leading dot, directory segments with a trailing slash — defaults cover
  `.tsx`, stylesheets, images and `tests/visual/`; a project value replaces the list). The
  decision is printed per package (`-- skipping package 'web' visual suite: ...`) and lives
  in `scripts/visual-gate.mjs`. A skipped sweep measures nothing, so the pre-flight bank is
  not refreshed by that merge.
- `gates.quality.enabled` — the tsc/eslint count ratchet; turn off for non-TypeScript
  repos.
- `devServers` — the app the runner brings up for the batch. `readyWhen` is
  `"any-response"` or `"http-200"`. `[]` means no app: plans are told to verify in the
  test harness instead.
- `watcherBlindPackages` — packages the frontend bundler compiles in but never watches;
  merging one triggers a frontend dev-server restart.

Resolution is strict: unknown keys, unknown gates, and malformed server entries are
refused at startup, before anything runs. Defaults and validation live in
`scripts/runner-config.mjs`.

## Hooks: the project's own scripts at the runner's decision points

Everything ticket- or release-shaped lives in the target project and is reached through a
hook named in `runner.json`. Every hook is off (`null`) until named. A hook is a command
list — the program first (a PATH name, or a repo-relative path), then its own arguments —
and the runner appends its question and runs it from the repo root, reading JSON from
stdout. A script file is never the program itself: spell a PowerShell hook as
`["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/x.ps1"]`.

```json
"hooks": {
  "siblingsAfter": ["node", "scripts/hooks/siblings-after.mjs"],
  "demo":          ["node", "scripts/hooks/demo.mjs"],
  "afterPlan":     ["node", "scripts/hooks/sweep.mjs"],
  "release": {
    "command": ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", "scripts/release-hook.ps1"],
    "perPlanPlatform": "web",
    "perBatchPlatform": "android"
  }
}
```

A release hook must name `perPlanPlatform`; `perBatchPlatform` is `null` (no batch tag)
unless given.

| Hook | Called with | Answers | When |
| --- | --- | --- | --- |
| `siblingsAfter` | `--plans-dir <dir> --siblings-after <plan file>` | JSON list of plan file names | after a plan fails: those plans are recorded `skipped` and not run this batch (later parts of the same ticket) |
| `demo` | `post --plan <path> [--version <v>]` / `clear --plan <path>` | `{posted, shots, issue}` / anything | after a plan merges (post) or fails (clear); never fails a plan |
| `afterPlan` | `--plan <plan file>` | optional `{note}` | after every plan, whatever its outcome — the project's sweep of what a dead session may have left behind (a browser window, a device state); never fails a plan |
| `release.command` | `tag --platform <p> --log-file <f>` | `{tag, version, actionsUrl}` — `tag: null` means nothing was pushed | under `-ReleaseEachPlan`, once per verified plan on `perPlanPlatform`, then once per batch on `perBatchPlatform` (`null` = no batch tag) |
| `release.command` | `status --tag <t> [--fallback-url <u>]` | `{finished, outcome, url}` | under `-WaitForDeploy`, polled every 20 s until `finished` or `-DeployTimeoutMinutes` |

A hook that fails costs what its moment costs: `siblingsAfter` answers "no siblings", `demo`
prints a line, a `tag` that pushes nothing disables releasing for the rest of the run.
`-ReleaseEachPlan` without a release hook is refused at startup, as is a hook whose program
cannot be found.

The hooks are the project's own scripts and live in the project — the tool ships none. A
typical release hook wraps whatever already cuts the project's tags and reads its CI's run
state; a typical demo hook posts staged screenshots to the project's ticket system.

## When the account runs out

A session the account refuses is not a plan that failed. It exits non-zero in about half a
second having done nothing — no branch work, no commit, a tree holding only its own plan file
— which from the runner's side is the same shape as a session that ran and went wrong. Read as
one, it costs the whole queue: an exhausted five-hour window once took eight plans in under a
minute and wrote every one of them up as work that was probably sound and sitting in a stash.

So a refusal is read for what it is (`scripts/rate-limit.mjs`, off the `429` on the session's
terminal record), and the runner sleeps the window out and starts **the same plan** again. The
refused session's log is kept beside the retry — one refused after an hour of work is the only
record of that hour — and the tree is left as it was, on the plan's own branch.

It stops rather than waits when the window reopens further off than `-RateLimitWaitMinutes`
(default 360 — a seven-day window is not something to sleep through), when the same plan is
refused three times running, or under `-NoWaitForRateLimit`. Stopping means stopping: the plan
stays queued, every plan behind it keeps no state entry at all, and the next run picks the
queue up where it left off. A refused plan reaches neither a verdict nor the repair session —
both would be spent against the same wall.

## The migration loop: planning one tick ahead

For a target state too large to plan up front (an architecture migration), a queue of plans
written in one sitting goes stale by the tenth plan: the tree they describe no longer exists.
`scripts/migration-loop-cli.mjs` plans one tick ahead instead:

```
assess  → a fresh headless session reads the target document, the migration log and the last
          tick's reports, measures the code, claims 1..N plan files, appends its tick entry to
          the log, ends with `MIGRATION-LOOP: planned …` / `target-reached` / `needs-human …`
commit  → the log alone, on the checked-out branch (the runner needs a clean tree)
run     → run-plans.ps1 -Only <those plans> <your runner switches>
record  → each plan's outcome from plans/.state.json goes under the tick entry; commit
repeat  → with a new assessor that knows nothing but those files
```

```powershell
# from the target repo's root
node C:\code\agentic-loop\scripts\migration-loop-cli.mjs `
  --target docs/frontend-target-architecture.md `
  --log docs/frontend-migration-log.md `
  --max-ticks 3 --max-plans 3 --runner-arg=-SkipPreflight
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--target` / `--log` | required | the target-state document and the migration log, repo-relative |
| `--max-ticks` | 1 | ticks per invocation; the log makes stopping and resuming free |
| `--max-plans` | 3 | the most plan files one assessor may claim |
| `--model` / `--effort` | opus / xhigh | the assessor's session (plans run at their own `effort:`) |
| `--assess-timeout-minutes` | 60 | wall clock on one assessor session |
| `--rate-limit-wait-minutes` | 360 | longest account-limit wait before stopping instead |
| `--runner-arg=<switch>` | none | repeatable; passed to `run-plans.ps1` verbatim. The `=` form is required because the switch starts with a dash |
| `--keep-ticks` | 3 | after each tick runs, tick entries older than the last N move to `<log>-archive.md` beside the log (committed with it), leaving a pointer line, so the assessor's read stays short; `0` keeps the log whole |
| `--dry-run` | off | assess and queue, then stop without running |

The loop stops on its own when the assessor says `target-reached` or `needs-human`, when it gave
no usable verdict, when it named a plan it never wrote, when it changed any file other than the
log and its plans, when any plan of a tick ends other than `completed` (the runner is started
with `-StopOnFailure`, so the plans behind it are recorded `not-run`, and the loop names the
failed plan and its branch and does not start another tick), or at the tick cap. It refuses to
start on a dirty tree, and on Windows it needs the native `claude.exe` (Node cannot spawn the npm
`.cmd` shim without a shell, and a shell would re-parse the allow-list).

The log is the loop's only state and the human's view of it. Its contract is in the assessor
prompt, `prompt/migration-assess.md`: **Decisions** are settled and never reopened by an
assessor, **Open questions** block the steps that depend on them, each **Tick** entry carries
what was planned, what the implementing sessions shipped, and what the runner recorded. The
`.jsonl` transcript and the composed prompt of every assessor land in `plans/logs/`.

## Development

```
npm run test
```

Node's built-in test runner, no dependencies. The tests build throwaway git repos in the
system temp directory and drive the CLIs end to end.
