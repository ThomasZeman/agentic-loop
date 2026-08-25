# agentic-loop

The unattended plan runner, extracted from Boardbash so any repo in `C:\code` can use it.

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

- `_preamble.md` — the standing instructions prepended to every plan's prompt (required)
- `_template.md` — the skeleton new plans are drafted against
- `.gitignore` — keeps the runner's state, logs, and baselines out of the repo
- `README.md` — the plans-directory contract, for humans and for planning agents

`templates/skills/` holds the `run-plans` and `add-plan` Claude Code skills to copy into a
project's `.claude/skills/` and adapt.

## Per-project configuration: `plans/runner.json`

Optional. Every field defaults to the value the runner grew up with inside Boardbash, so a
repo with no config file behaves exactly as the original runner did — Boardbash itself
needs an almost empty one. Another project overrides what differs:

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
- `gates.test` / `gates.visual` — npm script names and deadlines. The visual gate applies
  only to packages that define its script; `report` is where its JSON report lands,
  relative to the package directory (Playwright report shape).
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
  "siblingsAfter": ["node", "scripts/linear/plan-index-cli.mjs"],
  "demo":          ["node", "scripts/linear/ticket-demo-cli.mjs"],
  "release": {
    "command": ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", "scripts/release-hook.ps1"],
    "perPlanPlatform": "web",
    "perBatchPlatform": "android"
  }
}
```

| Hook | Called with | Answers | When |
| --- | --- | --- | --- |
| `siblingsAfter` | `--plans-dir <dir> --siblings-after <plan file>` | JSON list of plan file names | after a plan fails: those plans are recorded `skipped` and not run this batch (later parts of the same ticket) |
| `demo` | `post --plan <path> [--version <v>]` / `clear --plan <path>` | `{posted, shots, issue}` / anything | after a plan merges (post) or fails (clear); never fails a plan |
| `release.command` | `tag --platform <p> --log-file <f>` | `{tag, version, actionsUrl}` — `tag: null` means nothing was pushed | under `-ReleaseEachPlan`, once per verified plan on `perPlanPlatform`, then once per batch on `perBatchPlatform` (`null` = no batch tag) |
| `release.command` | `status --tag <t> [--fallback-url <u>]` | `{finished, outcome, url}` | under `-WaitForDeploy`, polled every 20 s until `finished` or `-DeployTimeoutMinutes` |

A hook that fails costs what its moment costs: `siblingsAfter` answers "no siblings", `demo`
prints a line, a `tag` that pushes nothing disables releasing for the rest of the run.
`-ReleaseEachPlan` without a release hook is refused at startup, as is a hook whose program
cannot be found.

`examples/boardbash/` holds Boardbash's `runner.json` and its `release-hook.ps1` — the
adapter that drives `scripts/tag-release.ps1` and reads GitHub Actions through `gh`, lifted
out of the runner. Both are meant to be copied into the Boardbash repo when it adopts this
tool.

## Still Boardbash-shaped (later phases)

- The copied `templates/plans/_preamble.md` and skills are Boardbash's own; they need
  per-project rewrites until the planned spine/include split lands.
- The default `devServers` table is still Boardbash's pair; it flips to `[]` once
  Boardbash carries its own `runner.json`.

## Development

```
npm run test
```

Node's built-in test runner, no dependencies. The tests build throwaway git repos in the
system temp directory and drive the CLIs end to end.
