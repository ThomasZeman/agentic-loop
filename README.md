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

## Status: Phase 1 — verbatim copy

This is a byte-for-byte copy of Boardbash's runner (2026-08-25). The Boardbash-specific
parts still carry their defaults and degrade gracefully elsewhere, but are NOT yet
configurable:

- workspace shape: `packages/*` with npm and a `test` script per package (a repo without
  `packages/` gets no test verification at all)
- gate names: `test`, `test:visual` (Playwright report at `test-results/visual-report.json`),
  tsc/eslint quality ratchet
- dev servers: the table in `scripts/dev-servers.mjs` hardcodes Boardbash's two servers;
  skip with `-SkipDevServers` anywhere else
- optional hooks the runner probes for and lives without: `scripts/linear/*` (ticket
  integration), `scripts/tag-release.ps1` (`-ReleaseEachPlan`),
  `scripts/launch-test-players.ps1` — these stay in Boardbash and are not copied
- the copied `templates/plans/_preamble.md` and skills are Boardbash's own; they need
  per-project rewrites until the planned spine/include split lands

Planned next phases: a per-project `plans/runner.json` config (workspace dir, gates,
dev-server table), named hooks replacing the `scripts/linear` call sites, and splitting the
preamble into a portable spine plus a project include.

## Development

```
npm run test
```

Node's built-in test runner, no dependencies. The tests build throwaway git repos in the
system temp directory and drive the CLIs end to end.
