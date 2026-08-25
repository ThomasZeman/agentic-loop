---
name: run-plans
description: Use when the user wants the queued plan files executed by the unattended runner ("run the plans", "start the plan queue", "kick off the runner", "run plan 07", "dry-run the plans"). Pre-flights the tree and queue, then launches the shared runner C:\code\agentic-loop\scripts\run-plans.ps1 against this repo in a NEW detached PowerShell window so the hours-long run does not block this session. Do NOT use to author a plan (that is the `add-plan` skill), to run the app, or for any repo other than the one this skill is installed in.
---

<!--
Template from C:\code\agentic-loop\templates\skills\. Copy to .claude/skills/run-plans/SKILL.md
and fill in:
  <PROJECT NAME>  - the repo's name, in the heading below
  <REPO ROOT>     - the absolute path of this repo's root, e.g. C:\code\my-project
The runner path C:\code\agentic-loop\scripts\run-plans.ps1 is the tool's documented location;
change it only if the tool lives elsewhere on this machine. Delete this comment when done.
-->

# Run <PROJECT NAME>'s plan queue in its own shell

The runner is shared across projects and lives in the peer repo `C:\code\agentic-loop`. Started
from this repo's root, it walks `plans/NN-*.md` in order and, for each one, branches `plan/<file>`
off the branch it started on, spawns a fresh headless `claude --print` session, waits for it,
verifies the result itself (a new commit, a clean tree, the gates `plans/runner.json` declares —
package tests, the visual suite where a package has one, the tsc/eslint count ratchet), and
fast-forwards the branch into the base branch — pushing it to the remote unless `-SkipSync` —
then records it in `plans/.state.json`. A single plan can take up to `-TimeoutMinutes` (default
90) and a full queue runs for hours.

**That is why this skill exists.** Running it with the PowerShell tool would pin this session for
the entire batch, and the run would die with the session. You launch it **detached, in a new
console window**, confirm it started, and hand the user back their session.

The runner is Windows-only by construction — `#Requires -Version 5.1`, `taskkill /T` for reaping
process trees, `Start-Process` redirection. There is no `.sh` twin. On macOS/Linux, stop and say so
rather than improvising a port.

## Inputs

`$ARGUMENTS` maps onto the runner's own switches. Pass through only what the user actually asked
for — every one of these changes what lands in the repo:

| User says | Switch |
| --- | --- |
| "just plan 07", "only 03 and 05" | `-Only 07` / `-Only 03,05` |
| "re-run it even though it's done" | `-Force` |
| "don't actually run it", "show me what it would do" | `-DryRun` |
| "stop if one fails" | `-StopOnFailure` |
| "no permission prompts", "yolo" | `-Yolo` |
| "skip the test re-run" | `-SkipVerify` |
| "skip the pre-flight sweep" | `-SkipPreflight` |
| "don't push", "keep it local", "no network" | `-SkipSync` |
| "leave the dev servers alone", "don't start the app" | `-SkipDevServers` |
| "use sonnet" | `-Model sonnet` |
| "cap it at $5 a plan" | `-MaxBudgetUsd 5` |
| "give each plan 45 minutes" | `-TimeoutMinutes 45` |
| "keep the branches" | `-KeepPlanBranches` |
| "no repair session", "fail it the moment a gate is red" | `-NoRepair` |
| "release each plan", "tag every plan that passes" | `-ReleaseEachPlan` |
| "wait for the deploy" | `-WaitForDeploy` |

No arguments means: run every plan not yet settled, with defaults — which includes **pushing each
merged plan to the remote base branch**. Say that in the confirmation. Never add `-Force`, `-Yolo`,
`-SkipVerify`, or `-SkipPreflight` on your own initiative — they respectively redo finished work,
drop the permission allow-list, remove the runner's independent gate, and skip the sweep that
refuses a red base.

`-ReleaseEachPlan` only means anything when `plans/runner.json` declares a `release` hook; the
runner refuses the switch at startup otherwise. `-WaitForDeploy` only matters under
`-ReleaseEachPlan`. Check `plans/runner.json` before passing either.

Before the first plan, the runner fetches and fast-forwards the base branch onto its remote (unless
`-SkipSync`), brings up any dev servers `runner.json` declares (unless `-SkipDevServers`), then
sweeps every package's tests against the base and refuses to start if any is red. When a gate goes
red after a plan's session, the runner gives it exactly one scoped repair session before failing
it — `-NoRepair` skips that.

## Procedure

### 1) Platform check

If not on Windows, stop: the runner shells out to `taskkill.exe` and assumes Windows PowerShell.
Tell the user it cannot run here and offer nothing else.

Also confirm the runner is where this skill expects it:

```powershell
Test-Path C:\code\agentic-loop\scripts\run-plans.ps1
```

If that is false, stop and say so — the peer repo is missing or moved.

### 2) Pre-flight (read-only)

From the repo root:

```powershell
git status --porcelain
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
- **Dirty working tree** — anything dirty under `plans/` or `scripts/` is tolerated (queued plan
  files most of all, each committed by the plan that implements it). Anything dirty **elsewhere**
  makes the runner throw at startup, so the new window would flash open and die with a message
  nobody reads. Report the exact files and stop. Do **not** commit or stash them for the user —
  that is their call. `node C:\code\agentic-loop\scripts\plan-tree-cli.mjs` answers this exactly
  as the runner will, if the plain `git status` is ambiguous.
- **Branch** — whatever branch the repo is on is the one every plan merges into. Surface it in the
  confirmation; it is the user's call, not a blocker. Two things *are* blockers, and the runner
  refuses both itself: a detached HEAD, and starting on a `plan/*` branch left by an earlier run.

`-DryRun` is exempt from the dirty-tree check, so a dry run may proceed on a dirty tree.

### 3) Show the queue

Get the real schedule from the runner rather than reconstructing it — it is cheap, invokes
nothing, and reflects `.state.json` and git exactly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\code\agentic-loop\scripts\run-plans.ps1 -DryRun -SkipSync -SkipPreflight -SkipDevServers <user's switches>
```

Run this **inline** (not in a new window) — it returns in seconds. It prints every plan with `[ok]`
(completed), `[xx]` (wont-do), `[!!]` (needs-review), `[--]` (skipped), or `[  ]` (never run), and
marks which are queued, with the effort level each will run at. Relay the queued list and the
count.

If it ends with `Nothing to do.`, every plan is already settled. Say so and stop — do not open a
window for an empty queue. If the user wants a finished plan re-run, that needs `-Only NN -Force`,
and they have to ask for it.

If the user asked for a dry run, this *was* the job. Report the output and stop — do not open a
window.

### 4) Confirm

The run makes real commits to the base branch, pushes them to the remote unless `-SkipSync`, and
spends real money, unattended, for hours. Always confirm, even when the user sounded decisive.
Show:

```
Queued    : 3 of 25 plans
            23-something.md
            24-something-else.md
            25-a-third-thing.md
Switches  : (defaults — 90 min/plan, opus, verify on, pushes to the remote)
Merges to : main   <- each plan runs on plan/<plan file> and fast-forwards into this
On commit : c3eb75f area: last commit subject
```

Plus any pre-flight warning still standing. Mention that the pre-flight sweep runs every
package's tests before the first plan starts and refuses a red base.

### 5) Launch it detached

```powershell
Start-Process -FilePath 'powershell' -WorkingDirectory '<REPO ROOT>' -ArgumentList @(
    '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', 'C:\code\agentic-loop\scripts\run-plans.ps1'
)
```

Append the user's switches as further `-ArgumentList` entries, each as its own string
(`..., '-Only', '07', '-StopOnFailure'`).

Why each part matters:

- **`Start-Process` without `-NoNewWindow`** is what gives the run its own console. The process is
  independent of this session's shell, so it survives the tool call, the turn, and the session.
- **`-NoExit`** keeps the window open on the final summary. Without it the window vanishes at the
  end and the user loses the pass/needs-review list.
- **`-NoProfile -ExecutionPolicy Bypass -File`** avoids the execution-policy failure.
- **`-WorkingDirectory`** is what points the shared runner at *this* repo: it resolves `plans/`
  and `plans/runner.json` from the git root of its working directory, and a window inheriting some
  other cwd runs some other project's queue.

Do **not** use `run_in_background`, `Start-Job`, or a plain `&` call. Those keep the run inside this
session's process tree and inside its lifetime — exactly what this skill exists to avoid.

### 6) Verify it actually started, then let go

Give it a moment and confirm the process is alive and writing:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -match 'run-plans\.ps1' } |
    Select-Object ProcessId
Get-ChildItem .\plans\logs | Sort-Object LastWriteTime | Select-Object -Last 1
```

A live PID and a fresh file under `plans\logs\` mean it is under way (the pre-flight sweep writes
`preflight.verify-*.txt` before the first `.jsonl` appears). If the process is gone within seconds,
the runner threw at startup — read the newest file in `plans\logs\` and report the error verbatim.

Then **stop**. Do not poll the log, do not wait for the batch, do not start reviewing commits it has
not made yet.

### 7) Report back

- The PID and that the run is in its own window.
- Which plans are queued, in order, and roughly how long the batch could take (queued count ×
  `TimeoutMinutes` is the worst case, not the expectation), plus the pre-flight sweep up front.
- How to watch it: the window itself, or `Get-Content .\plans\logs\<newest>.jsonl -Wait`.
- How to check later: `plans\.state.json` for per-plan status, `plans\reports\` for each agent's
  account, `git log` for the actual evidence.
- That a failed plan is marked `needs-review`, its work stays on its `plan/` branch (named in
  `.state.json`, and pushed unless `-SkipSync`), and the queue continues (unless
  `-StopOnFailure`); that re-running skips whatever completed and retries `needs-review`.
- That abandoning a plan for good is
  `node C:\code\agentic-loop\scripts\mark-plan.mjs <plan-file.md> wont-do "<reason>"`, never a
  hand-edit of `.state.json` and never marking it `completed`.
- That the run is now independent of this session — closing Claude Code will not stop it, and the
  only way to stop it is closing that window or killing the PID.

## Guardrails

- **Never run the queue in the foreground** of this session — not with the PowerShell tool, not
  backgrounded, not via `Start-Job`. New window or nothing.
- **Never `git commit`, `git stash`, or `git checkout --` to clear a dirty tree** so the runner will
  start. Report and stop.
- **Never invoke `claude --print` yourself** to execute a plan. The runner composes the prompt,
  enforces the timeout and budget cap, and verifies the outcome; hand-running a plan skips all
  three.
- **Never add `-Yolo`, `-Force`, `-SkipVerify`, or `-SkipPreflight`** unless the user asked in this
  conversation.
- Do not launch a second runner while one is alive. Ask.
- Do not edit plan files as part of this skill. If a plan looks wrong, say so and stop — fixing it
  is `add-plan`'s territory (or a direct edit the user asks for).
- If the user wants the batch watched over time, that is `/loop` on a status check — not this skill
  blocking on the process.
