---
name: run-plans
description: Use when the user wants the queued plan files executed by the unattended runner ("run the plans", "start the plan queue", "kick off the runner", "run plan 07", "dry-run the plans"). Pre-flights the tree and queue, then launches scripts/run-plans.ps1 in a NEW detached PowerShell window so the hours-long run does not block this session. Do NOT use to author a plan (that is the `add-plan` skill), to run the app (`run`), or for non-Boardbash repos.
---

# Run the plan queue in its own shell

`scripts/run-plans.ps1` walks `plans/NN-*.md` in order and, for each one, branches (`plan/NN-title`),
spawns a fresh headless `claude --print` session, waits for it, verifies the result (new commit,
clean tree, green package tests), fast-forwards the branch back onto the branch it started on, and
records it in `plans/.state.json`. A single plan can take up to `-TimeoutMinutes` (default 90) and a
full queue runs for hours.

**That is why this skill exists.** Running it with the PowerShell tool would pin this session for
the entire batch, and the run would die with the session. You launch it **detached, in a new
console window**, confirm it started, and hand the user back their session.

The runner is Windows-only by construction — `#Requires -Version 5.1`, `taskkill /T` for reaping
process trees, `Start-Process` redirection. There is no `.sh` twin. On macOS/Linux, stop and say so
rather than improvising a port.

## Inputs

`$ARGUMENTS` maps onto the script's own switches. Pass through only what the user actually asked
for — every one of these changes what lands in the repo:

| User says | Switch |
| --- | --- |
| "just plan 07", "only 03 and 05" | `-Only 07` / `-Only 03,05` |
| "re-run it even though it's done" | `-Force` |
| "don't actually run it", "show me what it would do" | `-DryRun` |
| "stop if one fails" | `-StopOnFailure` |
| "no permission prompts", "yolo" | `-Yolo` |
| "skip the test re-run" | `-SkipVerify` |
| "skip the pre-flight", "don't run everything first" | `-SkipPreflight` |
| "leave the dev servers alone", "don't start the app" | `-SkipDevServers` |
| "use sonnet" | `-Model sonnet` |
| "cap it at $5 a plan" | `-MaxBudgetUsd 5` |
| "give each plan 45 minutes" | `-TimeoutMinutes 45` |
| "keep the branches", "don't delete the plan branches" | `-KeepPlanBranches` |
| "name the branches differently" | `-BranchPrefix wip/` |

No arguments means: run every plan not marked `completed`, with defaults. Never add `-Force`,
`-Yolo`, or `-SkipVerify` on your own initiative — they respectively redo finished work, drop the
permission allow-list, and remove the runner's independent test gate.

Before the first plan, the runner sweeps every package's tests against the base branch and refuses
to start if any is red (~8 minutes on this repo: 503 suites, 6251 tests, plus the ~2.5-minute
Playwright sweep). That is deliberate — it is far cheaper than discovering a red base after a
queue of plans has each inherited it. It also measures the visual suite's inherited reds as the
run's baseline. Do not add `-SkipPreflight` on your own initiative either.

Each plan declares how hard its session should think, in front matter at the top of the file
(`effort: low|medium|high|xhigh|max`), and the runner passes it to `claude --effort`. The model is
always `-Model` (opus by default) — effort is the per-plan knob. A plan that declares nothing runs at
`high`, which is every plan file written before this existed; a plan that misspells a level fails
before its session starts, since the CLI would otherwise ignore the value and run at its own default.
The dry run prints the level for each queued plan, so it is worth a look before a long batch.

The runner also brings the app up before the queue — the backend on `:3005` and the frontend dev
server on `:1701` — so a plan told to check its work in a real browser has one to open. A server
already listening is adopted and left running at the end; only what the runner started does it
stop, and it restarts the frontend itself after any plan that changed `packages/shared` or
`packages/frontend-shared`, which Parcel's watcher never sees. If a server cannot be brought up the
queue still runs: every plan is told the live app is unavailable and falls back to the Playwright
harness. `-SkipDevServers` opts out of all of it — only pass it if the user asks.

## Procedure

### 1) Platform check

If not on Windows, stop: the runner shells out to `taskkill.exe` and assumes Windows PowerShell.
Tell the user it cannot run here and offer nothing else.

### 2) Pre-flight (read-only)

From the repo root:

```powershell
node scripts/plan-tree-cli.mjs
git rev-parse --abbrev-ref HEAD
git log -1 --pretty='%h %s'
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
    Where-Object { $_.CommandLine -match 'run-plans\.ps1' } |
    Select-Object ProcessId, CommandLine
```

Three things to evaluate:

- **A runner is already running** (the process scan returned anything) — **stop and ask.** Two
  runners share one working tree: they will interleave commits, and each will fail the other's
  cleanliness check. Report the PID and let the user decide whether to wait or kill it.
- **Dirty working tree** — `plan-tree-cli.mjs` answers this exactly as the runner will, and its
  `blocking` list is the answer: anything dirty **outside `plans/` and `scripts/`**. That makes the
  runner throw, so the new window would flash open and die with a message nobody reads. Report those
  files and stop. Do **not** commit or stash them for the user — per CLAUDE.md §4.5 that is their
  call. Its `carried` list is *not* a problem: everything under `plans/` rides along, queued plan
  files most of all, each committed by the run that implements it (R5.3), and so does everything
  under `scripts/`, which is the runner's own tooling. Each plan is still held to the scripts it
  changes itself — the runner snapshots what was already dirty before it starts one.
- **Branch** — whatever branch the repo is on is the branch every plan merges into. Surface it in
  the confirmation; if it is `main`, say so plainly once. It is the user's call, not a blocker.
  Two things *are* blockers, and the runner refuses both itself: a detached HEAD, and starting on a
  `plan/*` branch left behind by an earlier run.

`-DryRun` is exempt from the dirty-tree check (the script skips it), so a dry run may proceed on a
dirty tree.

### 3) Show the queue

Get the real schedule from the script rather than reconstructing it — it is cheap, invokes nothing,
and reflects `.state.json` exactly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-plans.ps1 -DryRun <user's switches>
```

Run this **inline** (not in a new window) — it returns in seconds. It prints every plan with `[ok]`
(completed), `[xx]` (wont-do), `[!!]` (needs-review), `[--]` (skipped), or `[  ]` (never run), and
marks which are queued. Relay the queued list and the count.

If it ends with `Nothing to do.`, every plan is already settled. Say so and stop — do not open a
window for an empty queue. If the user wants a finished plan re-run, that needs `-Only NN -Force`,
and they have to ask for it.

If the user asked for a dry run, this *was* the job. Report the output and stop — do not open a
window.

### 4) Confirm

The run makes real commits to the repo and spends real money, unattended, for hours. Always confirm,
even when the user sounded decisive. Show:

```
Queued    : 3 of 54 plans
            52-profile-edit-refreshes-live-snapshots.md
            53-friends-list-live-profile-refresh.md
            54-in-room-rename-reaches-opponents.md
Switches  : (defaults — 90 min/plan, opus, verify on)
Merges to : main   <- each plan runs on plan/<plan file> and fast-forwards into this
On commit : bae2bb2d profile: push an in-room rename ...
```

Plus any pre-flight warning still standing.

### 5) Launch it detached

```powershell
Start-Process -FilePath 'powershell' -WorkingDirectory 'C:\code\boardbash' -ArgumentList @(
    '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', '.\scripts\run-plans.ps1'
)
```

Append the user's switches as further `-ArgumentList` entries, each as its own string
(`..., '-Only', '07', '-StopOnFailure'`).

Why each part matters:

- **`Start-Process` without `-NoNewWindow`** is what gives the run its own console. The process is
  independent of this session's shell, so it survives the tool call, the turn, and the session.
- **`-NoExit`** keeps the window open on the final summary. Without it the window vanishes at the
  end and the user loses the pass/needs-review list.
- **`-NoProfile -ExecutionPolicy Bypass -File`** avoids the execution-policy failure the other
  repo scripts document.
- **`-WorkingDirectory`** because the script resolves `plans/` from the git root, and a window
  inheriting some other cwd resolves the wrong repo.

Do **not** use `run_in_background`, `Start-Job`, or a plain `&` call. Those keep the run inside this
session's process tree and inside its lifetime — exactly what this skill exists to avoid.

### 6) Verify it actually started, then let go

Give it a moment and confirm the process is alive and writing:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -match 'run-plans\.ps1' } |
    Select-Object ProcessId
Get-ChildItem .\plans\logs -Filter '*.jsonl' | Sort-Object LastWriteTime | Select-Object -Last 1
```

A live PID and a fresh `.jsonl` mean it is under way. If the process is gone within seconds, the
script threw at startup — read the newest file in `plans\logs\` and report the error verbatim.

Then **stop**. Do not poll the log, do not wait for the batch, do not start reviewing commits it has
not made yet.

### 7) Report back

- The PID and that the run is in its own window.
- Which plans are queued, in order, and roughly how long the batch could take (queued count ×
  `TimeoutMinutes` is the worst case, not the expectation).
- How to watch it: the window itself, or `Get-Content .\plans\logs\<newest>.jsonl -Wait`.
- How to check later: `plans\.state.json` for per-plan status, `plans\reports\` for each agent's
  account, `git log` for the actual evidence.
- That a failed plan is marked `needs-review` and the queue continues (unless `-StopOnFailure`),
  that its work is left on its own `plan/*` branch (the name is in `.state.json`) rather than on the
  branch they started from, and that re-running skips whatever completed.
- That abandoning a plan for good is `node scripts/mark-plan.mjs <plan-file.md> wont-do "<reason>"`,
  never a hand-edit of `.state.json` (it carries a BOM that `JSON.parse` rejects) and never marking
  it `completed` — a plan recorded as completed with no commit behind it reads, forever after, as
  having shipped.
- That the run is now independent of this session — closing Claude Code will not stop it, and the
  only way to stop it is closing that window or killing the PID.

## Guardrails

- **Never run the queue in the foreground** of this session — not with the PowerShell tool, not
  backgrounded, not via `Start-Job`. New window or nothing.
- **Never `git commit`, `git stash`, or `git checkout --` to clear a dirty tree** so the runner will
  start. Report and stop.
- **Never invoke `claude --print` yourself** to execute a plan. The runner composes the preamble,
  enforces the timeout and budget cap, and verifies the outcome; hand-running a plan skips all
  three.
- **Never add `-Yolo`, `-Force`, `-SkipVerify`, or `-SkipPreflight`** unless the user asked in this
  conversation.
- Do not launch a second runner while one is alive. Ask.
- Do not edit plan files as part of this skill. If a plan looks wrong, say so and stop — fixing it
  is `add-plan`'s territory (or a direct edit the user asks for).
- If the user wants the batch watched over time, that is `/loop` on a status check — not this skill
  blocking on the process.
