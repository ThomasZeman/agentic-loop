#Requires -Version 5.1
<#
.SYNOPSIS
    Runs numbered plan files through Claude Code, one at a time, verifying each before moving on.

.DESCRIPTION
    Before the queue starts, fetches and fast-forwards the base branch onto its remote, so
    that everything below - the pre-flight measurement most of all - describes the tree the
    plans actually branch off. Skip it with -SkipSync; a base branch tracking no remote is
    already skipped, and the runner then behaves exactly as it did before.

    Then runs every workspace package's `test` script once against the base branch and
    refuses to start if any is red - a plan is only worth judging against a green base, and
    finding that out up front costs minutes instead of hours. The same sweep runs the
    Playwright `test:visual` suite and records its standing set of reds as this run's
    baseline, which is the set every plan inherits by branching off that base.
    Skip it with -SkipPreflight.

    Just before that sweep - so Parcel's cold build happens underneath it rather than on the
    first plan's clock - it brings up the app the plans check their work against: the backend
    on :3005 and the frontend dev server on :1701, held up for the whole batch. A server
    already listening is adopted and left running at the end; only what this run started does
    it stop, and only that frontend does it restart after a plan changes a package Parcel's
    watcher cannot see. A server that never answers does not stop the queue - each plan is
    told the live app is unavailable and falls back to the Playwright harness. Skip the whole
    arrangement with -SkipDevServers.

    Then, for each plan file (plans/NN-title.md, sorted by number):
      1. branches off the current branch - `plan/NN-title` - so nothing is implemented
         on the integration branch
      2. reads the plan's front matter - the effort its session should run at - and composes
         a prompt = plans/_preamble.md + the plan body without that header + a reporting
         trailer
      3. invokes `claude --print` headlessly with a wall-clock timeout, at that effort
      4. verifies the outcome itself: a new commit exists, the tree is clean,
         the affected packages' test suites are green - including the Playwright
         `test:visual` suite where a package defines one, which jest cannot see -
         and their tsc error and eslint problem counts have not risen (ratchet in
         plans/.quality-baseline.json)
      5. integrates the branch: syncs the base branch with its remote, rebases the
         plan branch onto it if it moved - a rebase that conflicts gets one scoped
         session to resolve it, and the result has to pass verification again - then
         pushes the branch straight at the remote base branch and only fast-forwards
         locally once the remote has accepted it
      6. records the result in plans/.state.json so re-runs skip finished plans

    A plan is out of the queue for good on two statuses: 'completed', which the runner
    writes when the plan merged, and 'wont-do', which only a human writes - through
    scripts/mark-plan.mjs - for a plan deliberately abandoned. 'needs-review' and
    'skipped' are both temporary and are queued again by the next run.

    A plan that fails verification or integration is marked needs-review, its work is
    left on its branch, and the queue moves on; pass -StopOnFailure to halt at the
    first failure instead. The one thing the queue does not move on past is a later
    part of the same ticket: those are recorded skipped and never run, since each part
    builds on the tree the one before it left.

    The working tree may be dirty under plans/ - queued plan files, half-written ones,
    reports from an earlier batch. Anything dirty outside plans/ stops the run.

    With -ReleaseEachPlan every plan that passes verification is also released, through the
    project's `release` hook (plans/runner.json): a patch tag on its commit for the per-plan
    platform, recorded as a pending deploy or waited on with -WaitForDeploy. The batch ends
    with a single tag on the batch platform, if the hook names one. Without the switch the
    runner creates no tags - its own pushes only ever fast-forward a branch.

.EXAMPLE
    pwsh scripts/run-plans.ps1 -DryRun
    Show what would run, in order, without invoking anything.

.EXAMPLE
    pwsh scripts/run-plans.ps1
    Run every not-yet-completed plan.

.EXAMPLE
    pwsh scripts/run-plans.ps1 -Only 03 -Force
    Re-run just plan 03, even though it is marked completed.

.EXAMPLE
    pwsh scripts/run-plans.ps1 -ReleaseEachPlan
    Run the queue and deploy each verified plan to web on its own version number.
#>
[CmdletBinding()]
param(
    # Directory holding the NN-title.md plan files.
    [string] $PlansDir,

    # Run only plans whose file name contains one of these strings (e.g. -Only 02,05).
    [string[]] $Only,

    # Re-run plans already marked completed.
    [switch] $Force,

    # Print the schedule and the first composed prompt, then exit.
    [switch] $DryRun,

    # Use --dangerously-skip-permissions instead of the scoped allow-list.
    [switch] $Yolo,

    # Halt the queue on the first plan that fails verification. Off by default:
    # a plan that cannot be executed is marked and the run moves to the next one.
    [switch] $StopOnFailure,

    # Skip the runner's own post-run verification - package tests and the
    # tsc/eslint quality ratchet (the agent still runs tests itself).
    [switch] $SkipVerify,

    # Skip the pre-flight sweep of every package's tests before the queue starts.
    # The sweep also measures the visual suite's inherited reds for this run, so
    # skipping it leaves the first frontend plan to record that baseline itself.
    [switch] $SkipPreflight,

    # Never contact the remote: no fetch, no push. The base branch is then synced with
    # nothing and each plan is integrated locally, exactly as the runner behaved before.
    # For running the queue with no network.
    [switch] $SkipSync,

    # Leave the dev servers alone: nothing probed, nothing started, nothing stopped. Each plan
    # is then told the live app is unavailable, so it verifies in the Playwright harness rather
    # than spending its session trying to open a page that will never answer.
    [switch] $SkipDevServers,

    [string] $Model = 'opus',

    # Hard wall-clock limit per plan.
    [int] $TimeoutMinutes = 90,

    # Per-plan spend cap in USD. 0 disables the cap.
    [double] $MaxBudgetUsd = 0,

    # Ship every plan that passes verification through the project's release hook: a patch tag
    # on the per-plan platform, recorded in .state.json as a pending deploy - then one tag on
    # the batch platform covering the whole batch. Off by default; without it the runner tags
    # nothing. Needs hooks.release in plans/runner.json.
    [switch] $ReleaseEachPlan,

    # Block on each web deploy instead of handing it over as pending. The ticket loop settles a
    # pending record on a later tick, so the runner does not have to; a standalone run has no
    # loop ticking behind it and can ask for the verdict here.
    [switch] $WaitForDeploy,

    # How long one release's GitHub Actions run may take before it is recorded as a timeout.
    # Only reached under -WaitForDeploy.
    [int] $DeployTimeoutMinutes = 30,

    # Do not put a plan's showcase screenshots on its Linear ticket, and throw them away with
    # the rest of the run. On by default, and a no-op for every plan that captured nothing or
    # belongs to no ticket - which is why it needs no switch to turn it on.
    [switch] $SkipTicketDemo,

    # Prefixed onto every plan's branch name, so plan branches are greppable and can never
    # collide with a hand-made one. Pass a bare name to drop the prefix entirely.
    [string] $BranchPrefix = 'plan/',

    # Keep each plan's branch after it merges. Off by default: the merge is a fast-forward,
    # so a merged branch ref holds nothing the base branch does not already have. A branch
    # whose plan failed is always kept, whatever this says.
    [switch] $KeepPlanBranches,

    # Hard wall-clock limit for the one session that gets to resolve a rebase conflict.
    [int] $ConflictTimeoutMinutes = 20,

    # Fail a plan the moment a gate goes red, instead of giving it one repair session.
    # See Invoke-PlanRepair for what that session is and is not allowed to do.
    [switch] $NoRepair,

    # Hard wall-clock limit for the one session that gets to repair a failed gate. Larger than
    # the conflict budget because a visual red is only proved fixed by the full sweep, and that
    # is five minutes of it.
    [int] $RepairTimeoutMinutes = 45
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# The runner pushes now, on a machine with nobody at it. A credential helper still works; a
# prompt at the terminal would block the run until somebody found the window in the morning.
$env:GIT_TERMINAL_PROMPT = '0'

# --------------------------------------------------------------------------
# Paths and state
# --------------------------------------------------------------------------

<#
.SYNOPSIS
    Runs git and returns its stdout as an array of lines.
.DESCRIPTION
    Same hazard as Invoke-PackageScript: a native command's stderr reaching PowerShell's
    error stream becomes a terminating error under $ErrorActionPreference = 'Stop'. This
    repo emits "LF will be replaced by CRLF" routinely, and an unattended overnight run
    must not die on an incidental warning. Stderr is discarded and $LASTEXITCODE is left
    as the signal callers check.
#>
function Invoke-Git {
    param([string[]] $GitArgs)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        return @(& git @GitArgs 2>$null)
    }
    finally { $ErrorActionPreference = $previous }
}

function Get-GitLine {
    param([string[]] $GitArgs)

    $line = Invoke-Git $GitArgs | Select-Object -First 1
    if ($null -eq $line) { return '' }
    return $line.Trim()
}

function Get-RepoRoot {
    $root = Get-GitLine @('rev-parse', '--show-toplevel')
    if ($LASTEXITCODE -ne 0 -or -not $root) { throw 'Not inside a git repository.' }
    return (Resolve-Path $root).Path
}

<#
.SYNOPSIS
    The leading sequence number of a plan file name, or -1 when it has none.
.DESCRIPTION
    Plans are ordered by this number, never by their file name. Sorting by name is
    lexicographic, so once the queue passed 99 it placed 100-*.md directly after
    09-*.md - the runner then started at 100 while 85..99 were still pending, and the
    three-digit plans appeared at the top of the printed list instead of the bottom.
#>
function Get-PlanNumber {
    param([string] $Name)

    if ($Name -match '^(\d+)[-_]') { return [int]$Matches[1] }
    return -1
}

<#
.SYNOPSIS
    Does one -Only token select this plan?
.DESCRIPTION
    An all-digits token means "the plan with this number" and is compared numerically, so
    -Only 10 selects 10-*.md alone rather than also dragging in 100-*.md, 101-*.md and
    110-*.md the way a substring match would. Anything else stays a plain substring of the
    file name, so -Only ticker keeps working.
#>
function Test-PlanMatchesFilter {
    param([System.IO.FileInfo] $Plan, [string] $Token)

    if ($Token -match '^\d+$') { return (Get-PlanNumber $Plan.Name) -eq [int]$Token }
    return $Plan.Name -like "*$Token*"
}

function Get-PlanFiles {
    param([string] $Directory, [string[]] $Filter)

    if (-not (Test-Path $Directory)) { throw "Plans directory not found: $Directory" }

    $files = Get-ChildItem -Path $Directory -Filter '*.md' -File |
        Where-Object { (Get-PlanNumber $_.Name) -ge 0 } |
        Sort-Object @{ Expression = { Get-PlanNumber $_.Name } }, Name

    if ($Filter) {
        $files = $files | Where-Object {
            $plan = $_
            @($Filter | Where-Object { Test-PlanMatchesFilter -Plan $plan -Token $_ }).Count -gt 0
        }
    }
    return @($files)
}

function Read-RunState {
    param([string] $Path)

    $state = @{}
    if (Test-Path $Path) {
        $raw = Get-Content -Path $Path -Raw -Encoding UTF8
        if ($raw.Trim()) {
            foreach ($prop in (ConvertFrom-Json $raw).PSObject.Properties) {
                $state[$prop.Name] = $prop.Value
            }
        }
    }
    return $state
}

function Write-RunState {
    param([string] $Path, [hashtable] $State)
    ($State | ConvertTo-Json -Depth 6) | Set-Content -Path $Path -Encoding UTF8
}

<#
.SYNOPSIS
    The plan file names the queue must not offer again, from both records of them.
.DESCRIPTION
    .state.json is this machine's record and is gitignored, so a second machine - a runner VM
    stood up by a plain clone - starts with an empty one and would re-run the whole queue.
    Git holds the durable half: a queued plan file is untracked and the plan that implements
    it commits its own file, so a tracked plan file is one that shipped. scripts/plan-ledger.mjs
    holds the reasoning and the edge cases; this only asks it.

    Asked once per run, not once per plan. There are hundreds of plan files, and putting the
    question inside Test-PlanSettled would launch a process for every one of them.
#>
function Get-SettledPlanNames {
    param([string] $RepoRoot, [string] $StatePath)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments @((Join-Path $PSScriptRoot 'plan-ledger-cli.mjs'), '--state', $StatePath) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "plan-ledger-cli failed (exit $code): $reason"
        }

        $answer = Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
        $names = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($name in @($answer.settled)) {
            if ($name) { $null = $names.Add([string] $name) }
        }
        # Leading comma: returning a set bare would unroll it into its elements.
        return ,$names
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    The target repo's runner configuration - plans/runner.json resolved over the defaults.
.DESCRIPTION
    Asked of scripts/runner-config-cli.mjs, where the defaults and the validation are
    tested. A fault is thrown, not softened: this is read before anything else happens,
    and a queue run over a half-applied config would verify every plan against the wrong
    gates - eight unattended hours spent finding out what one loud stop here says now.
#>
function Get-RunnerConfig {
    param([string] $RepoRoot)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments @((Join-Path $PSScriptRoot 'runner-config-cli.mjs')) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "runner-config-cli failed (exit $code): $reason"
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    The standing instructions prepended to every plan's prompt, composed by
    scripts/preamble-cli.mjs, and a label saying what they were composed from.
#>
function Get-Preamble {
    param([string] $RepoRoot)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments @((Join-Path $PSScriptRoot 'preamble-cli.mjs')) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "preamble-cli failed (exit $code): $reason"
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------------------------
# Hooks -- the target project's own scripts, run at the moments runner.json names
# --------------------------------------------------------------------------

<#
.SYNOPSIS
    Where a hook's program lives: on PATH by name, or in the repo by path.
.DESCRIPTION
    Anything with a separator in it is the project's own file and resolves against the repo
    root, so a project's hooks travel with its clone. Thrown, not softened: a program that
    cannot be found is a configuration error, and the caller that would swallow it is the
    one place a wrong answer must not come from.
#>
function Resolve-HookProgram {
    param([string] $RepoRoot, [string] $Program)

    if ($Program -match '[\\/]') {
        $path = $Program
        if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path $RepoRoot $path }
        if (-not (Test-Path $path)) { throw "hook program not found: $path" }
        return (Resolve-Path $path).Path
    }

    $found = Get-Command $Program -ErrorAction SilentlyContinue
    if (-not $found) { throw "hook program '$Program' is not on PATH" }
    return $found.Source
}

<#
.SYNOPSIS
    Runs one configured hook with the runner's arguments appended, from the repo root, and
    hands back its exit code and its JSON answer.
.DESCRIPTION
    A hook is a command list from plans/runner.json - the program, then its own arguments -
    and this appends what the runner has to say. Both streams land on disk; stdout is parsed
    as JSON when it is any. Nothing here judges the outcome: whether a hook that ran and
    failed costs a plan, a line on the console, or nothing at all is each caller's call.

    A script file is never the program itself. Windows would hand a bare .ps1 to whatever
    opens it rather than run it, so a PowerShell hook is spelled
    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/x.ps1"].
#>
function Invoke-Hook {
    param([string] $RepoRoot, [string[]] $Command, [string[]] $HookArgs = @(),
          [int] $TimeoutMinutes = 10)

    $program = Resolve-HookProgram -RepoRoot $RepoRoot -Program $Command[0]
    $arguments = @()
    if ($Command.Count -gt 1) { $arguments += $Command[1..($Command.Count - 1)] }
    $arguments += $HookArgs

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath $program -Arguments $arguments `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot `
            -ProcessTimeoutMinutes $TimeoutMinutes

        $answer = $null
        $raw = Get-Content -Path $stdout -Raw -Encoding UTF8
        if ($raw -and $raw.Trim()) {
            try { $answer = $raw | ConvertFrom-Json } catch { $answer = $null }
        }
        return [pscustomobject]@{
            exitCode = $code
            answer   = $answer
            error    = (Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200)
        }
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------------------------
# Prompt composition
# --------------------------------------------------------------------------

function Write-PlanHeader {
    param([int] $Index, [int] $Total, [string] $Name)

    Write-Host ("=" * 78) -ForegroundColor Cyan
    Write-Host "[$Index/$Total] $Name" -ForegroundColor Cyan
    Write-Host ("=" * 78) -ForegroundColor Cyan
}

<#
.SYNOPSIS
    What one plan file's front matter asks for, and the body to compose into its prompt.
.DESCRIPTION
    Both answers come from one call to scripts/plan-header-cli.mjs, where the parsing is
    tested, rather than from a regex here and a re-read of the file there - the front matter
    is the runner's own setting and must not reach the session, and stripping it in one place
    and not the other is how it would.

    A fault is returned as .problem, never thrown: a plan whose header cannot be read costs
    itself, and the queue behind it goes on.
#>
function Get-PlanFrontMatter {
    param([string] $RepoRoot, [string] $PlanPath)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments @((Join-Path $PSScriptRoot 'plan-header-cli.mjs'), $PlanPath) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            return [pscustomobject]@{
                effort = $null; declared = $false; body = ''
                problem = "could not read this plan's header (exit $code): $reason"
            }
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

function New-PlanPrompt {
    param(
        [string] $Preamble,
        [System.IO.FileInfo] $Plan,
        [string] $Body,
        [string] $ReportPath,
        [int] $Index,
        [int] $Total,
        [string] $AppStatus
    )

    $trailer = @"

---

# This run

- Plan file: ``$($Plan.Name)`` ($Index of $Total in this batch)
- Write your report to: ``$ReportPath`` and include it in the commit.
- Work only on this plan. When it is committed and the tree is clean, stop -- the runner
  starts the next plan in a fresh session, so nothing carries over except the repository.
$AppStatus
- End your final message with one line, exactly: ``PLAN_STATUS: completed`` or ``PLAN_STATUS: blocked``.
"@

    return @"
$Preamble

---

# THE PLAN

$Body
$trailer
"@
}

# --------------------------------------------------------------------------
# Invocation
# --------------------------------------------------------------------------

# The effort level the plan now running asked for - the one thing about a session that is not
# the same for every plan in the queue. Script-scoped rather than threaded through the call
# chain because it follows the plan and not the call site: the conflict resolver a plan may
# need is that same plan's work, and it sits five functions down the integration path, none of
# which have any other reason to know about effort. Empty only until the first plan is read.
$script:PlanEffort = ''

function Get-ClaudeArgs {
    $claudeArgs = @(
        '--print'
        '--verbose'
        '--output-format', 'stream-json'
        '--model', $Model
    )

    # Never sent empty. `claude --effort ''` is not the same as not passing it: the CLI takes
    # an unrecognised value, warns, and runs at its own default - so a blank one would look
    # deliberate in the log and be nothing of the sort.
    if ($script:PlanEffort) { $claudeArgs += @('--effort', $script:PlanEffort) }

    if ($Yolo) {
        $claudeArgs += '--dangerously-skip-permissions'
    }
    else {
        $claudeArgs += @('--permission-mode', 'acceptEdits')
        $claudeArgs += '--allowedTools'
        # mcp__claude-in-chrome is the whole server, so a plan can open the running app and
        # look at it. Bash(powershell:*) is here for launch-test-players.ps1, which gives it
        # a Chrome of its own to look at - see rule 4 of plans/_preamble.md. Neither widens
        # the blast radius much next to Bash(node:*), which already runs arbitrary code.
        $claudeArgs += @(
            'Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite', 'Task',
            'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git:*)',
            'Bash(powershell:*)', 'mcp__claude-in-chrome'
        )
    }

    if ($MaxBudgetUsd -gt 0) { $claudeArgs += @('--max-budget-usd', "$MaxBudgetUsd") }

    return $claudeArgs
}

function Format-StreamEvent {
    param([string] $Line)

    try { $evt = $Line | ConvertFrom-Json } catch { return $null }

    switch ($evt.type) {
        'assistant' {
            foreach ($block in $evt.message.content) {
                if ($block.type -eq 'tool_use') { return '  -> ' + (Format-ToolUse $block) }
                if ($block.type -eq 'text' -and $block.text -and $block.text.Trim()) {
                    return '  .. ' + (Get-FirstLine $block.text 100)
                }
            }
            return $null
        }
        'result' {
            $cost = 0.0
            if ($null -ne $evt.total_cost_usd) { $cost = [math]::Round([double]$evt.total_cost_usd, 2) }
            $secs = 0
            if ($null -ne $evt.duration_ms) { $secs = [math]::Round([double]$evt.duration_ms / 1000) }
            return "  == $($evt.subtype)  |  $cost USD  |  $secs s"
        }
        default { return $null }
    }
}

function Format-ToolUse {
    param($Block)

    $detail = ''
    if ($Block.input.command)   { $detail = Get-FirstLine $Block.input.command 90 }
    elseif ($Block.input.file_path) { $detail = Split-Path $Block.input.file_path -Leaf }
    elseif ($Block.input.pattern)   { $detail = Get-FirstLine $Block.input.pattern 60 }
    return "$($Block.name) $detail".TrimEnd()
}

function Get-FirstLine {
    param([string] $Text, [int] $Max)

    $line = ($Text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if (-not $line) { return '' }
    if ($line.Length -gt $Max) { return $line.Substring(0, $Max) + '...' }
    return $line
}

<#
.SYNOPSIS
    Force-kills a process and everything it spawned.
.DESCRIPTION
    Start-Process launches these children through a shell shim (cmd.exe -> npm -> jest),
    so killing the process we hold a handle to reaps only the shim and orphans the worker
    that is actually hung. Process.Kill($true) would do this, but that overload is .NET
    Core only and this script runs on Windows PowerShell 5.1, so shell out to taskkill /T.

    Same hazard as Invoke-Git, and it bit at teardown: a process that has already exited
    makes taskkill write "ERROR: The process ... not found." to stderr, and `2>&1` merges
    that into PowerShell's error stream, where $ErrorActionPreference = 'Stop' promotes it
    to a terminating error. Under 5.1 that killed the whole run *after* the last plan had
    finished and its ledger was written. Stopping something already stopped is the outcome
    this function wants, so its stderr is discarded rather than merged.
#>
function Stop-ProcessTree {
    param([int] $ProcessId)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & taskkill.exe '/PID' $ProcessId '/T' '/F' 2>$null | Out-Null }
    finally { $ErrorActionPreference = $previous }
}

function Invoke-ClaudeOnPlan {
    param(
        [string] $PromptFile,
        [string] $LogFile,
        [string] $ErrorFile,
        [string] $WorkingDirectory,
        [int] $SessionTimeoutMinutes
    )

    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claude) { throw "'claude' CLI not found on PATH." }

    $proc = Start-Process -FilePath $claude.Source `
        -ArgumentList (Get-ClaudeArgs) `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardInput $PromptFile `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError $ErrorFile `
        -NoNewWindow -PassThru

    # Touching .Handle caches it; without this, Start-Process -PassThru leaves
    # .ExitCode empty once the process ends.
    try { $null = $proc.Handle } catch { }

    $deadline = (Get-Date).AddMinutes($SessionTimeoutMinutes)
    $printed = 0

    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 2
        $printed = Show-NewLogLines -LogFile $LogFile -AlreadyPrinted $printed

        if ((Get-Date) -gt $deadline) {
            Write-Host "  !! timeout after $SessionTimeoutMinutes min -- killing session" -ForegroundColor Red
            Stop-ProcessTree -ProcessId $proc.Id
            return 124
        }
    }

    $proc.WaitForExit()
    Show-NewLogLines -LogFile $LogFile -AlreadyPrinted $printed | Out-Null

    $code = $proc.ExitCode
    if ($null -eq $code) { return 0 }
    return $code
}

function Show-NewLogLines {
    param([string] $LogFile, [int] $AlreadyPrinted)

    if (-not (Test-Path $LogFile)) { return $AlreadyPrinted }

    $lines = @(Get-Content -Path $LogFile -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($lines.Count -le $AlreadyPrinted) { return $AlreadyPrinted }

    foreach ($line in $lines[$AlreadyPrinted..($lines.Count - 1)]) {
        $formatted = Format-StreamEvent $line
        if ($formatted) { Write-Host $formatted -ForegroundColor DarkGray }
    }
    return $lines.Count
}

# --------------------------------------------------------------------------
# Child processes
# --------------------------------------------------------------------------

function New-TempPath {
    param([string] $Extension)

    return Join-Path ([System.IO.Path]::GetTempPath()) ('run-plans-' + [guid]::NewGuid().ToString('n') + $Extension)
}

<#
.SYNOPSIS
    Runs a child process with both streams on disk and returns its exit code.
.DESCRIPTION
    Start-Process for the same reason Invoke-PackageScript uses it: a native command's stderr
    reaching PowerShell's error stream is a terminating error under $ErrorActionPreference =
    'Stop'. Hooks and tools like `gh` write there routinely, so none may be called directly.
    A timeout returns 124 and reaps the whole tree, since these children spawn their own.
#>
function Invoke-CapturedProcess {
    param(
        [string] $FilePath,
        [string[]] $Arguments,
        [string] $StdOutFile,
        [string] $StdErrFile,
        [string] $StdInFile,
        [string] $WorkingDirectory,
        [int] $ProcessTimeoutMinutes = 10
    )

    $startArgs = @{
        FilePath               = $FilePath
        ArgumentList           = $Arguments
        WorkingDirectory       = $WorkingDirectory
        RedirectStandardOutput = $StdOutFile
        RedirectStandardError  = $StdErrFile
        NoNewWindow            = $true
        PassThru               = $true
    }
    if ($StdInFile) { $startArgs.RedirectStandardInput = $StdInFile }

    $proc = Start-Process @startArgs
    try { $null = $proc.Handle } catch { }

    if (-not $proc.WaitForExit($ProcessTimeoutMinutes * 60 * 1000)) {
        Stop-ProcessTree -ProcessId $proc.Id
        return 124
    }

    $code = $proc.ExitCode
    if ($null -eq $code) { return 0 }
    return $code
}

# --------------------------------------------------------------------------
# Dev servers -- the running app a plan checks its work against
# --------------------------------------------------------------------------

<#
.SYNOPSIS
    Asks scripts/dev-servers-cli.mjs one question and hands back its exit code and its answer.
.DESCRIPTION
    Same shape as Get-TreeAssessment, and for the same reason: the decisions (is it up? is the
    bundle stale? how long do we wait?) live in a tested Node module, and PowerShell keeps only
    the process work. A fault is returned rather than thrown - unlike the tree guard, a dev
    server that cannot be reached is a degraded run, not an unsafe one, and the queue is worth
    more than the browser check.
#>
function Invoke-DevServerCli {
    param([string] $RepoRoot, [string[]] $CliArgs, [int] $TimeoutMinutes = 5)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments (@((Join-Path $PSScriptRoot 'dev-servers-cli.mjs')) + $CliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot `
            -ProcessTimeoutMinutes $TimeoutMinutes

        $answer = $null
        $raw = Get-Content -Path $stdout -Raw -Encoding UTF8
        if ($raw -and $raw.Trim()) {
            try { $answer = $raw | ConvertFrom-Json } catch { $answer = $null }
        }
        return [pscustomobject]@{
            exitCode = $code
            answer   = $answer
            error    = (Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200)
        }
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    Starts one dev server detached, with both its streams on disk.
.DESCRIPTION
    Through ComSpec for the same reason Invoke-PackageScript is: npm's output must not reach
    PowerShell's error stream. Unlike that one this never waits - the process is the point,
    and readiness is established by polling the port rather than by watching the log, which
    is the only signal that means the same thing for nodemon and for Parcel.
#>
function Start-DevServer {
    param([string] $RepoRoot, $Server, [string] $LogFile)

    $shell = $env:ComSpec
    if ($shell) {
        $file = $shell
        $commandArgs = @('/c', 'npm', 'run', $Server.npmScript)
    }
    else {
        $file = 'npm'
        $commandArgs = @('run', $Server.npmScript)
    }

    $proc = Start-Process -FilePath $file -ArgumentList $commandArgs `
        -WorkingDirectory (Join-Path $RepoRoot $Server.packageDir) `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError "$LogFile.stderr.txt" `
        -NoNewWindow -PassThru

    try { $null = $proc.Handle } catch { }
    return $proc
}

<#
.SYNOPSIS
    Polls until the named servers answer, or gives up and says which did not.
#>
function Wait-ForDevServers {
    param([string] $RepoRoot, [string[]] $Names)

    $cliArgs = @('--wait')
    foreach ($name in $Names) { $cliArgs += @('--server', $name) }

    # Generous next to the per-server deadlines the CLI enforces: this outer limit only exists
    # so a node that hangs cannot stall the queue, and must never be the one that fires.
    $result = Invoke-DevServerCli -RepoRoot $RepoRoot -CliArgs $cliArgs -TimeoutMinutes 20
    if ($result.exitCode -eq 0) { return @() }

    $problems = @()
    foreach ($server in @($result.answer.servers)) {
        if (-not $server.up) { $problems += "dev server '$($server.name)' never came up: $($server.detail)" }
    }
    if ($problems.Count -eq 0) {
        $problems += "waiting for the dev servers failed (exit $($result.exitCode)): $($result.error)"
    }
    return $problems
}

<#
.SYNOPSIS
    Brings up the app the batch will be checked against, and says what it now owns.
.DESCRIPTION
    Rule 4 of the preamble tells a plan to verify a user-visible change in a real browser, and
    scripts/launch-test-players.ps1 needs the backend and the dev server already running to do
    it. Nothing used to make that true - it depended on what happened to be running on the
    machine - so a plan either wasted its session on a page that never answered or quietly
    skipped the check.

    A server already listening is adopted and never stopped: this is also the development
    machine, and killing a dev server somebody is using is a worse failure than the tidiness
    it buys. Only what this run started does it stop.
#>
function Start-DevServers {
    param([string] $RepoRoot, [string] $LogDir, [string] $Stamp)

    $owned = @{}
    $probe = Invoke-DevServerCli -RepoRoot $RepoRoot -CliArgs @('--probe') -TimeoutMinutes 2
    if (-not $probe.answer) {
        return @{ owned = $owned; servers = @(); problems = @("could not probe the dev servers: $($probe.error)") }
    }

    # A project with no dev servers declared is not a fault, but it is not "the app is up"
    # either: with nothing to probe, every plan is sent to the test harness instead.
    if (@($probe.answer.servers).Count -eq 0) {
        return @{ owned = $owned; servers = @()
                  problems = @('this project declares no dev servers (plans/runner.json devServers is empty)') }
    }

    foreach ($server in @($probe.answer.servers)) {
        if ($server.up) {
            Write-Host "  ++ $($server.name) already listening at $($server.url) ($($server.detail)) - adopted, and left running at the end" -ForegroundColor DarkGray
            continue
        }

        $log = Join-Path $LogDir "devserver-$($server.name).$Stamp.txt"
        Write-Host "  ++ starting $($server.name): npm run $($server.npmScript) in $($server.packageDir)" -ForegroundColor DarkCyan
        Write-Host "     waiting for $($server.readiness) at $($server.url) - log: $log" -ForegroundColor DarkGray
        $owned[$server.name] = @{
            server  = $server
            log     = $log
            process = (Start-DevServer -RepoRoot $RepoRoot -Server $server -LogFile $log)
        }
    }

    # Caught rather than thrown: whatever goes wrong from here, the caller must still be handed
    # what this function started, or the queue runs on with two npm trees nobody can stop.
    try { $problems = @(Wait-ForDevServers -RepoRoot $RepoRoot -Names @($probe.answer.servers | ForEach-Object { $_.name })) }
    catch { $problems = @("waiting for the dev servers failed: $($_.Exception.Message)") }

    return @{ owned = $owned; servers = @($probe.answer.servers); problems = $problems }
}

function Stop-DevServers {
    param([hashtable] $Owned)

    foreach ($name in @($Owned.Keys)) {
        Write-Host "  -- stopping the $name dev server this run started" -ForegroundColor DarkGray
        Stop-ProcessTree -ProcessId $Owned[$name].process.Id
    }
}

<#
.SYNOPSIS
    The line in each plan's prompt that says whether there is an app to look at.
.DESCRIPTION
    Worth telling the agent either way. Knowing the app is up saves it from starting servers
    the runner already owns; knowing it is not saves it a session spent on a page that will
    never answer, since the Playwright harness needs neither server and is the preferred
    route anyway.
#>
function Get-AppStatusLine {
    param([bool] $Available, [string] $Reason, $Servers = @(), [string] $RepoRoot = '')

    $visualScript = $script:Config.gates.visual.script

    if ($Available) {
        # The URLs come from the same probe answer the runner started the servers with, so
        # the prompt never names a server the target project does not declare.
        $listed = (@($Servers) | ForEach-Object { "$($_.name) $($_.url)" }) -join ', '
        $status = "- The app is already running for this batch and is the runner's to manage: $listed." +
            "`n  Do not start or restart any of these servers."

        # The test-player launcher is Boardbash's own tooling; the sentence about it is
        # only true in a repo that carries the script.
        $launcher = ''
        if ($RepoRoot) { $launcher = Join-Path $RepoRoot 'scripts/launch-test-players.ps1' }
        if ($launcher -and (Test-Path $launcher)) {
            $status += " To drive it, launch a throwaway player with`n" +
                '  `./scripts/launch-test-players.ps1 -Count 1 -Reset -StartId 1` and close it with `-Close`.'
        }
        return $status
    }

    return @"
- The live app is NOT available this run. Do not try to start any dev server or browser session
  against it; verify user-visible work the way the project section describes - in the visual
  harness (``npm run $visualScript``) where a package defines one, which needs no server - and say
  in your report that the live app was unavailable. Reason: $Reason
"@
}

<#
.SYNOPSIS
    The workspace packages one commit touched.
#>
function Get-CommitPackages {
    param([string] $RepoRoot, [string] $Commit)

    $files = @(Invoke-Git @('-C', $RepoRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', $Commit))
    return @($files |
        ForEach-Object { if ($_ -match $script:PackagesPattern) { $Matches[1] } } |
        Select-Object -Unique)
}

<#
.SYNOPSIS
    Restarts the frontend dev server when a plan changed something Parcel will never notice.
.DESCRIPTION
    frontend-boardfest imports packages/shared and packages/frontend-shared through the
    node_modules workspace symlinks, and Parcel's watcher ignores node_modules - so an edit
    there triggers no rebuild at all. Files inside frontend-boardfest do rebuild, so what is
    served is a mixed old/new bundle that type-checks, builds, and breaks only at runtime.
    Left alone, the next plan in the queue would check its work against exactly that.

    Only what this run started is restarted. An adopted server belongs to whoever started it,
    and the warning is the most this may do to it.
#>
function Restart-StaleFrontend {
    param([string] $RepoRoot, [string] $Commit, [hashtable] $Owned)

    $packages = @(Get-CommitPackages -RepoRoot $RepoRoot -Commit $Commit)
    if ($packages.Count -eq 0) { return }

    $answer = Invoke-DevServerCli -RepoRoot $RepoRoot -CliArgs (@('--stale-bundle') + $packages) -TimeoutMinutes 2
    if (-not $answer.answer -or -not $answer.answer.restartFrontend) { return }

    if (-not $Owned.ContainsKey('frontend')) {
        Write-Host "  !! this plan changed a package Parcel never watches, and the frontend dev server is not this run's to restart - the next plan may be checked against a mixed old/new bundle" -ForegroundColor Yellow
        return
    }

    Write-Host "  ++ restarting the frontend dev server - this plan changed a package Parcel's watcher ignores" -ForegroundColor DarkCyan
    $entry = $Owned['frontend']
    Stop-ProcessTree -ProcessId $entry.process.Id
    $entry.process = Start-DevServer -RepoRoot $RepoRoot -Server $entry.server -LogFile $entry.log

    foreach ($problem in @(Wait-ForDevServers -RepoRoot $RepoRoot -Names @('frontend'))) {
        Write-Host "  !! $problem" -ForegroundColor Yellow
    }
}

<#
.SYNOPSIS
    Closes any test-player Chrome window a plan left open.
.DESCRIPTION
    The preamble tells each plan to close its own, and a plan that dies mid-session cannot.
    A leftover window is not harmless: each holds a WebSocket session for its uid, and the
    next plan launching the same player displaces it and gets the "Opened in Another Tab"
    overlay instead of the app.
#>
function Close-TestPlayers {
    param([string] $RepoRoot)

    $launcher = Join-Path $RepoRoot 'scripts/launch-test-players.ps1'
    if (-not (Test-Path $launcher)) { return }

    $stdout = New-TempPath '.txt'
    $stderr = New-TempPath '.err.txt'
    try {
        $null = Invoke-CapturedProcess -FilePath 'powershell.exe' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-Close') `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 3

        $said = Get-Content -Path $stdout -Raw -Encoding UTF8
        if ($said -match 'closed (\d+) test-player') {
            Write-Host "        tidy:   closed $($Matches[1]) test-player Chrome process(es) left open" -ForegroundColor DarkYellow
        }
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------------------------
# Verification -- the runner does not take the agent's word for it
# --------------------------------------------------------------------------

<#
.SYNOPSIS
    What the working tree permits right now, as scripts/plan-tree.mjs judges it.
.DESCRIPTION
    Returns .blocking (paths that must stop the run) and .carried (the paths under plans/ and
    scripts/ that ride along - see plan-tree.mjs). Pass -RunningPlan to also require that plan's
    own file and report to have been committed, and -PendingScripts to say which scripts/ paths
    were already dirty before it started, so anything else there is charged to the plan.

    A fault here is thrown, not swallowed: this is the guard that keeps an unattended agent
    off the human's work-in-progress, and a guard that cannot answer must not be read as a
    clean tree.
#>
function Get-TreeAssessment {
    param([string] $RepoRoot, [string] $RunningPlan, [string[]] $PendingScripts = @())

    $cliArgs = @((Join-Path $PSScriptRoot 'plan-tree-cli.mjs'))
    if ($RunningPlan) { $cliArgs += @('--running-plan', $RunningPlan) }
    foreach ($path in $PendingScripts) { $cliArgs += @('--pending', $path) }

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' -Arguments $cliArgs `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "plan-tree-cli failed (exit $code): $reason"
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    The scripts/ paths already dirty, taken before a plan gets the chance to touch anything.
.DESCRIPTION
    The runner carries dirty tooling under scripts/ the same way it carries queued plan files:
    this machine is also where the runner itself is developed, and refusing to run over an
    unfinished helper script only ever cost a batch.

    That tolerance must not extend to the plan's own work, though. A plan asked to change a
    script and finishing with it uncommitted has stranded its deliverable, and the post-run
    cleanliness check is the only thing that would notice. So the two are told apart the only
    way they can be: by which paths were dirty before the session started.
#>
function Get-PendingScripts {
    param([string] $RepoRoot)

    return [string[]] @((Get-TreeAssessment -RepoRoot $RepoRoot).carried |
        Where-Object { $_ -like 'scripts/*' })
}

<#
.SYNOPSIS
    The later parts of this plan's ticket - the ones that must not run now it has failed.
.DESCRIPTION
    R4.9. A ticket too large for one reviewable commit is planned in several parts, and each
    part builds on the tree the one before it left. Running part 2 over a tree missing part 1's
    work verifies it against the wrong baseline and, with -ReleaseEachPlan, tags a release for
    it - so a failed part poisons every part behind it rather than only itself.

    What makes two plans parts of one ticket is the project's business - the runner has no
    ticket model of its own - so the question goes to the `siblingsAfter` hook, when there is
    one: `--plans-dir <dir> --siblings-after <plan file>`, answering a JSON list of plan file
    names. No hook means no plan is ever held back. Asked once per failure rather than once
    per plan, and a fault answers "no siblings": failing to skip one costs a single bad plan,
    while throwing here would cost every plan still queued behind it.
#>
function Get-SiblingPlans {
    param([string] $RepoRoot, [string] $PlansDirectory, [string] $PlanName)

    $hook = $script:Config.hooks.siblingsAfter
    if (-not $hook) { return @() }

    try {
        $result = Invoke-Hook -RepoRoot $RepoRoot -Command $hook -TimeoutMinutes 2 `
            -HookArgs @('--plans-dir', $PlansDirectory, '--siblings-after', $PlanName)

        if ($result.exitCode -ne 0) {
            Write-Host "        !! could not look for later parts of this ticket: $($result.error)" -ForegroundColor Red
            return @()
        }
        if ($null -eq $result.answer) { return @() }
        # [string[]], not @(): Windows PowerShell 5.1's ConvertFrom-Json writes a JSON array as
        # a single object rather than unrolling it, so @() around it yields one element holding
        # an Object[]. The caller would then hold back a plan called "System.Object[]" and run
        # the sibling it meant to skip - which is how this was found.
        return [string[]] $result.answer
    }
    catch {
        Write-Host "        !! could not look for later parts of this ticket: $($_.Exception.Message)" -ForegroundColor Red
        return @()
    }
}

<#
.SYNOPSIS
    Records a plan the queue must not run, so the run that skipped it says why.
.DESCRIPTION
    'skipped' is not 'completed', so the next run queues this plan again - after the part that
    failed, which runs first by number. If both then pass, the split heals itself.
#>
<#
.SYNOPSIS
    Does this plan's .state.json entry take it out of the queue?
.DESCRIPTION
    Two statuses take a plan out of the queue for good, for opposite reasons. 'completed'
    landed on the base branch. 'wont-do' was abandoned on purpose - set by hand through
    scripts/mark-plan.mjs, never by the runner - and exists so that decision does not have
    to be recorded as a lie: a plan marked 'completed' with no commit behind it would tell
    every later reader it shipped.

    'needs-review' and 'skipped' are both temporary by design, and are queued again.
#>
function Test-PlanStatusSettled {
    param($Entry)

    if (-not $Entry) { return $false }
    return (@('completed', 'wont-do') -contains $Entry.status)
}

<#
.SYNOPSIS
    Is this plan finished with, as far as the queue is concerned?
.DESCRIPTION
    The state entry above is one record of that; the set from Get-SettledPlanNames is both,
    and carries the answer git can give on a machine that has no state file at all. Asked in
    that order so the run's own bookkeeping still reads as the reason where it has one.
#>
function Test-PlanSettled {
    param($Entry, [string] $Name, $Settled)

    if (Test-PlanStatusSettled -Entry $Entry) { return $true }
    return $Settled.Contains($Name)
}

function Add-SkippedPlan {
    param([hashtable] $State, [string] $StatePath, [string] $PlanName, [string] $FailedPart)

    $problem = "not run: $FailedPart is an earlier part of the same ticket and failed verification"
    $State[$PlanName] = [ordered]@{
        status     = 'skipped'
        commit     = $null
        problems   = @($problem)
        finishedAt = (Get-Date).ToString('o')
    }
    Write-RunState -Path $StatePath -State $State
    Write-Host "  SKIPPED $problem" -ForegroundColor DarkYellow
}

function Test-PlanOutcome {
    param([string] $HeadBefore, [string] $RepoRoot, [string] $LogDir, [string] $Slug,
          [string] $Stamp, [string] $PlanName, [string[]] $PendingScripts = @())

    $result = [ordered]@{ ok = $true; commit = $null; problems = @() }

    $headAfter = Get-GitLine @('-C', $RepoRoot, 'rev-parse', 'HEAD')
    if ($headAfter -eq $HeadBefore) {
        $result.ok = $false
        $result.problems += 'no commit was created'
    }
    else {
        $result.commit = $headAfter
    }

    # Nothing may survive a finished plan except other paths under plans/, and the scripts/
    # paths that were already dirty when it started. Gitignored paths (plans/logs, .state.json,
    # .plan-lock) do not appear here, so anything else listed is genuinely left behind -
    # including this plan's own file and its own report, if the commit failed to absorb them,
    # and any tooling script the plan itself changed without committing.
    $assessment = Get-TreeAssessment -RepoRoot $RepoRoot -RunningPlan $PlanName -PendingScripts $PendingScripts
    if (-not $assessment.clean) {
        $result.ok = $false
        $result.problems += "working tree not clean: $($assessment.blocking -join '; ')"
    }

    if (-not $SkipVerify -and $result.commit) {
        $baselinePath = Join-Path (Split-Path $LogDir -Parent) '.quality-baseline.json'
        $found = Test-ChangedPackages -RepoRoot $RepoRoot -From $HeadBefore -To $result.commit `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp -BaselinePath $baselinePath
        foreach ($problem in $found) {
            $result.ok = $false
            $result.problems += $problem
        }
    }

    return [pscustomobject]$result
}

<#
.SYNOPSIS
    Returns the working tree to a clean state after a failed plan, without losing anything.
.DESCRIPTION
    The queue only keeps moving if each plan starts clean - otherwise one plan's leftovers
    fail the next plan's cleanliness check and the failure cascades down the queue.

    A blocked plan is supposed to leave exactly one file: its report. That is committed as
    a bookkeeping commit, so the analysis survives in history. Anything else is unexpected
    (partial work, stray files) and is stashed rather than discarded, because deleting an
    agent's work unattended is not a call this script should make. Recover with `git stash list`.

    The stash names its paths explicitly, and the queued plan files are never among them: a
    blanket `git stash -u` here would sweep up every plan still waiting to run, and the queue
    would find nothing left to execute.

    Only this plan's own report is staged, never the whole reports directory. Reports from
    earlier batches are allowed to sit uncommitted in the tree now, and committing one here
    would tie it to a branch this plan is about to abandon - taking it out of the working tree
    on the way back to the base branch.
#>
function Clear-WorkingTree {
    param([string] $RepoRoot, [string] $PlanName)

    $actions = @()
    if (@(Invoke-Git @('-C', $RepoRoot, 'status', '--porcelain') | Where-Object { $_.Trim() }).Count -eq 0) {
        return $actions
    }

    $reportPath = "$($script:PlansRel)/reports/" + ($PlanName -replace '\.md$', '') + '.md'
    Invoke-Git @('-C', $RepoRoot, 'add', '--', $reportPath) | Out-Null
    $staged = @(Invoke-Git @('-C', $RepoRoot, 'diff', '--cached', '--name-only'))
    if ($staged.Count -gt 0) {
        Invoke-Git @('-C', $RepoRoot, 'commit', '-m', "plans: record blocked report for $PlanName") | Out-Null
        $actions += "committed the blocked report"
    }

    # Assessed without -RunningPlan on purpose. This plan failed, so its own file has to stay
    # on disk to be re-run; requiring it to be committed here would stash away the very plan
    # the operator is about to retry. The same omission leaves every scripts/ path carried,
    # which is what tidying up wants: the tooling dirty in this tree is far more likely to be
    # the human's unfinished work than the failed plan's, and burying that in a stash is the
    # one outcome worth avoiding.
    try { $blocking = @((Get-TreeAssessment -RepoRoot $RepoRoot).blocking) }
    catch { return ($actions + "could not assess the tree to tidy it: $($_.Exception.Message)") }

    if ($blocking.Count -gt 0) {
        Invoke-Git (@('-C', $RepoRoot, 'stash', 'push', '-u', '-m', "run-plans: leftovers from $PlanName", '--') + $blocking) | Out-Null
        $actions += "stashed $($blocking.Count) leftover path(s) - see 'git stash list'"
    }
    return $actions
}

function Get-ChangedPackages {
    param([string] $RepoRoot, [string] $From, [string] $To)

    $files = @(Invoke-Git @('-C', $RepoRoot, 'diff', '--name-only', "$From..$To"))
    return @($files |
        ForEach-Object { if ($_ -match $script:PackagesPattern) { $Matches[1] } } |
        Select-Object -Unique)
}

<#
.SYNOPSIS
    The packages a plan has to be verified against: the ones it changed, plus every package
    built on one of them.
.DESCRIPTION
    Get-ChangedPackages above is the truth about the diff and a lie about the blast radius.
    frontend-boardfest is built on frontend-shared, which is built on shared, so a plan editing
    a shared package could break a consumer, verify green against the one package it touched,
    merge and ship. The graph lives in scripts/package-closure.mjs, where it is tested and read
    from the manifests rather than written down.

    Only this call site expands. Save-PreflightBank deliberately keeps the literal diff: it
    records what a merge actually changed, and naming packages the plan never touched would
    vouch for the wrong thing.

    A fault here falls back to the literal set with a warning rather than throwing. That is
    exactly the verification every plan got before this existed, so it costs coverage and not a
    queue - where a throw would fail a plan for a tooling fault of its own.
#>
function Get-PackagesToVerify {
    param([string] $RepoRoot, [string[]] $Changed)

    if ($Changed.Count -eq 0) { return @() }

    $cliArgs = @('--packages-dir', $script:PackagesDirAbs)
    foreach ($pkg in $Changed) { $cliArgs += @('--changed', $pkg) }

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments (@((Join-Path $PSScriptRoot 'package-closure-cli.mjs')) + $cliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            Write-Host "     !! package-closure-cli failed (exit $code): $reason" -ForegroundColor DarkYellow
            Write-Host "     !! verifying only the packages the diff touched" -ForegroundColor DarkYellow
            return @($Changed)
        }

        $answer = Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $answer.packages) { return @($Changed) }
        return @($answer.packages)
    }
    catch {
        Write-Host "     !! could not expand the changed packages: $($_.Exception.Message)" -ForegroundColor DarkYellow
        Write-Host "     !! verifying only the packages the diff touched" -ForegroundColor DarkYellow
        return @($Changed)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    Runs one `npm run <script>` in a package directory and returns its exit code.
.DESCRIPTION
    Deliberately a subprocess rather than a plain `npm run` call. Jest writes its
    PASS/FAIL lines to stderr, and in Windows PowerShell 5.1 a native command's stderr
    merged into the error stream becomes a NativeCommandError - which this script's
    $ErrorActionPreference = 'Stop' promotes to a terminating error, aborting the whole
    run even when npm exited 0. Start-Process keeps the two streams out of PowerShell
    entirely, and the exit code stays trustworthy.

    The wait is bounded. A package whose script never terminates - a stray
    `jest --watch`, a dev server, a prompt on stdin - would otherwise stall the whole
    queue indefinitely, since unlike the agent session this wait had no deadline.
    Exceeding the deadline returns 124 (the conventional timeout code) so the caller
    reports the package red and moves on.
#>
function Invoke-PackageScript {
    param([string] $Directory, [string] $ScriptName, [string] $LogFile,
          [int] $TestTimeoutMinutes = 20)

    $shell = $env:ComSpec
    if ($shell) {
        $file = $shell
        $commandArgs = @('/c', 'npm', 'run', $ScriptName)
    }
    else {
        $file = 'npm'
        $commandArgs = @('run', $ScriptName)
    }

    $proc = Start-Process -FilePath $file -ArgumentList $commandArgs `
        -WorkingDirectory $Directory `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError "$LogFile.stderr.txt" `
        -NoNewWindow -PassThru

    try { $null = $proc.Handle } catch { }

    if (-not $proc.WaitForExit($TestTimeoutMinutes * 60 * 1000)) {
        Write-Host "  !! '$ScriptName' in '$Directory' still running after $TestTimeoutMinutes min -- killing" -ForegroundColor Red
        Stop-ProcessTree -ProcessId $proc.Id
        return 124
    }

    $code = $proc.ExitCode
    if ($null -eq $code) { return 0 }
    return $code
}

<#
.SYNOPSIS
    Does this package define an npm script by this name?
.DESCRIPTION
    Asked rather than assumed, so the visual gate below stays a property of the package
    instead of a package name hard-coded into the runner: any package that grows a
    `test:visual` script is gated by it from then on, and one that drops the script stops
    failing every plan on a missing target.
#>
function Test-PackageHasScript {
    param([string] $Directory, [string] $ScriptName)

    $manifest = Join-Path $Directory 'package.json'
    if (-not (Test-Path $manifest)) { return $false }

    try { $parsed = Get-Content -Path $manifest -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return $false }

    if (-not $parsed.scripts) { return $false }
    return $null -ne $parsed.scripts.$ScriptName
}

<#
.SYNOPSIS
    Runs one package's `test:visual` suite, when it has one, and fails the plan for any
    screenshot that this plan turned red - not for the ones it inherited.
.DESCRIPTION
    The reason this is separate from the jest run: frontend-boardfest's jest config sets
    testPathIgnorePatterns to <rootDir>/tests/, which is exactly where the Playwright specs
    live. `npm run test` therefore cannot see a single visual spec, and without this the
    runner verified a screen-shaped change without ever opening a browser - while the
    preamble's rule 4 told the agent a real browser was mandatory. That gap was honour-system
    in both directions: nothing checked that the suite ran, and nothing failed when it didn't.

    Slower than the jest run - three DPR projects over every spec - so it gets its own,
    longer deadline rather than sharing the 20-minute one.

    Why this is a ratchet and not a pass/fail on the exit code: the suite carries a standing
    set of pre-existing reds (52 on clean main when this was written, against a suite of
    ~1107). Failing on the exit code failed every frontend plan regardless of its own diff -
    plan 242 was measured introducing none of them and died anyway, which killed the whole
    frontend queue. What a plan must not do is add a *new* red.

    The comparison is on the *set of failing test ids*, never a count. A count ratchets
    itself into a corner: one lucky run recording a low number holds every later run to a
    total the suite cannot reach while any of its reds are order-dependent, and the message
    it produces does not say which test moved. See scripts/visual-failures.mjs.
#>
function Invoke-VisualSuite {
    param([string] $RepoRoot, [string] $PackageName, [string] $Directory,
          [string] $LogDir, [string] $Slug, [string] $Stamp)

    $outcome = @{ran = $false; failures = @(); problems = @()}

    if (-not (Test-PackageHasScript -Directory $Directory -ScriptName $script:Config.gates.visual.script)) { return $outcome }

    # The reader is the runner's own tooling and travels with it, wherever this script is
    # installed - never resolved against the target repo, which need not carry a copy.
    $readerScript = Join-Path $PSScriptRoot 'visual-failures.mjs'
    if (-not (Test-Path $readerScript)) { return $outcome }

    $visualLog = Join-Path $LogDir "$Slug.visual-$PackageName.$Stamp.txt"

    # A report left by an earlier run would be read as this run's result if Playwright
    # died before writing its own, turning a crashed suite into a silent pass.
    $reportPath = Join-Path $Directory $script:Config.gates.visual.report
    if (Test-Path $reportPath) { Remove-Item -Path $reportPath -Force }

    $code = Invoke-PackageScript -Directory $Directory -ScriptName $script:Config.gates.visual.script `
        -LogFile $visualLog -TestTimeoutMinutes $script:Config.gates.visual.timeoutMinutes

    # 124 is Invoke-PackageScript's timeout kill. Any report it wrote is half a run.
    if ($code -eq 124) {
        $outcome.problems = @("package '$PackageName' visual suite timed out - see $visualLog")
        return $outcome
    }
    if (-not (Test-Path $reportPath)) {
        $outcome.problems = @("package '$PackageName' visual suite wrote no report (exit $code) - see $visualLog")
        return $outcome
    }

    $failuresLog = Join-Path $LogDir "$Slug.visual-$PackageName.$Stamp.failures.json"
    $proc = Start-Process -FilePath 'node' -ArgumentList @($readerScript, $Directory, $script:Config.gates.visual.report) `
        -RedirectStandardOutput $failuresLog `
        -RedirectStandardError "$failuresLog.stderr.txt" `
        -NoNewWindow -PassThru
    try { $null = $proc.Handle } catch { }
    if (-not $proc.WaitForExit(5 * 60 * 1000)) {
        Stop-ProcessTree -ProcessId $proc.Id
        $outcome.problems = @("reading '$PackageName' visual report timed out - see $failuresLog")
        return $outcome
    }
    if ($proc.ExitCode -ne 0) {
        $outcome.problems = @("reading '$PackageName' visual report failed (exit $($proc.ExitCode)) - see $failuresLog.stderr.txt")
        return $outcome
    }

    $parsed = Get-Content -Path $failuresLog -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $parsed.failures) { $outcome.failures = @($parsed.failures) }
    foreach ($note in @($parsed.notes)) {
        if ($null -ne $note) { $outcome.problems += "package '$PackageName' visual suite: $note - see $visualLog" }
    }
    $outcome.ran = $true
    $outcome.log = $visualLog
    return $outcome
}

<#
.SYNOPSIS
    Where the accepted set of failing visual test ids lives.
.DESCRIPTION
    Co-located with the quality ratchet's baseline and gitignored the same way: both are
    runner-owned state that must not dirty the tree a plan is verified against.
#>
function Get-VisualBaselinePath {
    param([string] $PlansDir)

    return (Join-Path $PlansDir '.visual-baseline.json')
}

<#
.SYNOPSIS
    The outcome of one package's visual gate: what it objects to, and what it saw.
.DESCRIPTION
    .failures is only meaningful when .measured is true - "no failures" and "the suite never
    ran" are the same empty array otherwise, and banking the second as the first would vouch
    for a green tree nobody looked at.
#>
function New-VisualVerdict {
    param([string[]] $Problems = @(), [string[]] $Failures = @(), [switch] $Measured)

    return [pscustomobject]@{
        problems = $Problems
        failures = $Failures
        measured = [bool]$Measured
    }
}

function Test-PackageVisuals {
    param([string] $RepoRoot, [string] $PackageName, [string] $Directory,
          [string] $LogDir, [string] $Slug, [string] $Stamp)

    if (-not (Test-PackageHasScript -Directory $Directory -ScriptName $script:Config.gates.visual.script)) {
        return (New-VisualVerdict)
    }

    Write-Host "  ++ verifying package '$PackageName' (npm run $($script:Config.gates.visual.script) - real Chromium)" -ForegroundColor DarkCyan
    $outcome = Invoke-VisualSuite -RepoRoot $RepoRoot -PackageName $PackageName -Directory $Directory `
        -LogDir $LogDir -Slug $Slug -Stamp $Stamp
    if (-not $outcome.ran) { return (New-VisualVerdict -Problems @($outcome.problems)) }

    $failures = @($outcome.failures)
    $visualLog = $outcome.log
    $problems = @($outcome.problems)

    $visualBaselinePath = Get-VisualBaselinePath -PlansDir (Split-Path $LogDir -Parent)
    $baseline = Read-VisualBaseline -Path $visualBaselinePath

    if (-not $baseline.ContainsKey($PackageName)) {
        Write-Host "     visual baseline for '$PackageName' recorded: $($failures.Count) known red" -ForegroundColor DarkGray
        $baseline[$PackageName] = $failures
        Save-VisualBaseline -Path $visualBaselinePath -Baseline $baseline
        return (New-VisualVerdict -Problems $problems -Failures $failures -Measured)
    }

    $known = @($baseline[$PackageName])
    $newFailures = @($failures | Where-Object { $known -notcontains $_ })
    $fixed = @($known | Where-Object { $failures -notcontains $_ })

    if ($newFailures.Count -gt 0) {
        # Named, not counted - the whole reason for a set. The agent's next move is to
        # look at these specs, and a number would not tell it which.
        $problems += "package '$PackageName' turned $($newFailures.Count) visual test(s) red: " +
            (($newFailures | Select-Object -First 10) -join '; ') +
            " - see $visualLog"
    }
    if ($fixed.Count -gt 0) {
        Write-Host "     $($fixed.Count) visual test(s) this plan fixed" -ForegroundColor DarkGreen
    }

    # Read-only against .visual-baseline.json on purpose. Every plan branches off the base
    # branch, so the set it inherits is the base branch's, and banking a fix here would judge
    # the next plan against a tree that does not exist: a plan that fixes three tests and then
    # fails verification is never merged, so the next plan branches off a base where those three
    # still fail and would be blamed for all three.
    #
    # The measurement itself is handed back all the same. If this plan does merge, its branch
    # tip becomes the base branch, and then this is exactly the set that describes it - which is
    # what Save-PreflightBank records, and what spares the next batch the four-minute sweep.
    return (New-VisualVerdict -Problems $problems -Failures $failures -Measured)
}

<#
.SYNOPSIS
    Reads the accepted set of failing visual test ids, per package.
.DESCRIPTION
    A package present with an empty list means "nothing is excused" and is not the same as
    a package that has never been seen - the first is held to a green suite, the second is
    recorded and passed. Hence ContainsKey rather than a null check at the call site.
#>
function Read-VisualBaseline {
    param([string] $Path)

    if (-not (Test-Path $Path)) { return @{} }
    try { $parsed = Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return @{} }
    return (ConvertTo-VisualSets -Parsed $parsed)
}

<#
.SYNOPSIS
    A parsed `{ "<package>": ["<test id>", ...] }` object as a hashtable of arrays.
.DESCRIPTION
    Shared by the baseline on disk and the answer preflight-bank-cli.mjs gives, because both
    are the same shape and both are read through ConvertFrom-Json - which hands back a
    PSCustomObject whose properties have to be walked rather than indexed.
#>
function ConvertTo-VisualSets {
    param($Parsed)

    $sets = @{}
    if ($null -eq $Parsed) { return $sets }
    foreach ($pkgProp in $Parsed.psobject.Properties) {
        if ($null -eq $pkgProp.Value) { $sets[$pkgProp.Name] = @() }
        else { $sets[$pkgProp.Name] = @($pkgProp.Value) }
    }
    return $sets
}

function Save-VisualBaseline {
    param([string] $Path, [hashtable] $Baseline)

    # -Depth 4 would be enough, but the shape is one level of arrays under one of names;
    # spelling it out keeps a future nested entry from being silently truncated to a string.
    ($Baseline | ConvertTo-Json -Depth 6) | Out-File -FilePath $Path -Encoding utf8
}

<#
.SYNOPSIS
    Asks scripts/preflight-bank-cli.mjs one question, or reports that it could not be asked.
.DESCRIPTION
    Never throws and never fails a run. The bank is an optimisation over a measurement this
    script can always take again, so a fault here costs the four minutes it was meant to save
    and nothing else - where a throw would take down a queue with nothing wrong with it.
#>
function Invoke-PreflightBankCli {
    param([string] $RepoRoot, [string[]] $CliArgs)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments (@((Join-Path $PSScriptRoot 'preflight-bank-cli.mjs')) + $CliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            Write-Host "     !! preflight-bank-cli failed (exit $code): $reason" -ForegroundColor DarkYellow
            return $null
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        Write-Host "     !! could not ask about the banked visual baseline: $($_.Exception.Message)" -ForegroundColor DarkYellow
        return $null
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    The visual failure sets already measured for the commit the base branch is sitting on.
.DESCRIPTION
    Empty means "nobody can vouch for this tree" and the pre-flight sweeps for itself, which is
    what it did on every batch before the bank existed. A package missing from the answer is
    swept the same way, so a package that grows a visual suite is measured the first time.
#>
function Get-BankedVisuals {
    param([string] $RepoRoot, [string] $PlansDir, [string] $BaseCommit)

    if (-not $BaseCommit) { return @{} }

    $answer = Invoke-PreflightBankCli -RepoRoot $RepoRoot -CliArgs @(
        'reuse', '--commit', $BaseCommit, '--plans-dir', $PlansDir)
    if (-not $answer -or -not $answer.reuse) { return @{} }
    return (ConvertTo-VisualSets -Parsed $answer.visual)
}

<#
.SYNOPSIS
    Records the visual failure set that now describes the base branch, after a plan merged.
.DESCRIPTION
    Called only once the fast-forward has succeeded, and never before: until then this plan's
    tree is not the tree the next batch would branch off, and a record naming a commit no suite
    ran on is the one thing the bank must never hold.

    What gets recorded is decided in scripts/preflight-bank.mjs, where it is tested. This hands
    it the two commits the question turns on, the packages between them, and whatever this
    plan's own verification measured - which is nothing at all for a backend plan, and that is
    a legitimate answer: it changed nothing the visual suite depends on.
#>
function Save-PreflightBank {
    param([string] $RepoRoot, [string] $PlansDir, [string] $From, [string] $Commit)

    $measuredFile = New-TempPath '.measured.json'
    try {
        ($script:MeasuredVisuals | ConvertTo-Json -Depth 6) | Out-File -FilePath $measuredFile -Encoding utf8

        $cliArgs = @('bank', '--commit', $Commit, '--from', $From,
                     '--plans-dir', $PlansDir, '--packages-dir', $script:PackagesDirAbs,
                     '--measured-file', $measuredFile)
        foreach ($pkg in (Get-ChangedPackages -RepoRoot $RepoRoot -From $From -To $Commit)) {
            $cliArgs += @('--changed', $pkg)
        }

        $answer = Invoke-PreflightBankCli -RepoRoot $RepoRoot -CliArgs $cliArgs
        if ($answer -and $answer.banked) {
            Write-Host "  ++ the next batch inherits this tree's visual baseline - no pre-flight sweep" -ForegroundColor DarkGray
        }
    }
    finally { Remove-Item -Path $measuredFile -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    Every workspace package that defines a `test` script, in a stable order.
#>
function Get-TestablePackages {
    param([string] $RepoRoot)

    $packagesDir = $script:PackagesDirAbs
    if (-not (Test-Path $packagesDir)) { return @() }

    $found = @()
    foreach ($dir in (Get-ChildItem -Path $packagesDir -Directory | Sort-Object Name)) {
        if (Test-PackageHasScript -Directory $dir.FullName -ScriptName $script:Config.gates.test.script) {
            $found += [pscustomobject]@{ Name = $dir.Name; Directory = $dir.FullName }
        }
    }
    return $found
}

<#
.SYNOPSIS
    Runs every package's tests once, before the queue starts, and refuses to start on red.
.DESCRIPTION
    Two jobs, and the second is the reason it runs the slow visual suite as well.

    First: a plan is only worth judging against a base branch that is green. When the base
    is already red, every plan in the queue inherits the failure, each one is verified
    against it, and the run burns hours to produce a queue of plans that all "failed" for
    something none of them did. Better to spend ten minutes finding that out up front.

    Second: it measures the visual suite's standing set of reds *once*, from the base
    branch, and records it as this run's baseline. Every plan branches off that base, so
    that is exactly the set each of them inherits - which is why Test-PackageVisuals is a
    read-only comparison against it and never banks a fix mid-run. A plan that fixes three
    tests and then fails verification is never merged; banking its fix would leave the next
    plan branching off a base where those three still fail, and being blamed for all three.

    A red *visual* suite is therefore not a reason to refuse: it is the measurement. Only a
    suite that could not be run at all is, because then there is no baseline to judge by.

    That second job is the four minutes of these five, and it is skipped when the base branch
    is sitting at a commit some earlier plan's own sweep already measured - see
    Save-PreflightBank and scripts/preflight-bank.mjs. The unit half is not skippable and is
    not affected: every package's `npm run test` runs on every batch, and a red one still
    refuses the queue. It is cheap, and it is the half that says the base branch is worth
    building on at all.
#>
function Invoke-QueuePreflight {
    param([string] $RepoRoot, [string] $PlansDir, [string] $LogDir, [string] $Stamp,
          [string] $BaseCommit)

    $packages = Get-TestablePackages -RepoRoot $RepoRoot
    if ($packages.Count -eq 0) { return }

    Write-Host ''
    Write-Host "Pre-flight  |  $($packages.Count) package(s) - the queue does not start on a red base branch" -ForegroundColor Cyan

    $red = @()
    $baseline = Read-VisualBaseline -Path (Get-VisualBaselinePath -PlansDir $PlansDir)
    $banked = Get-BankedVisuals -RepoRoot $RepoRoot -PlansDir $PlansDir -BaseCommit $BaseCommit

    foreach ($pkg in $packages) {
        Write-Host "  ++ $($pkg.Name) (npm run $($script:Config.gates.test.script))" -ForegroundColor DarkCyan
        $testLog = Join-Path $LogDir "preflight.verify-$($pkg.Name).$Stamp.txt"
        $code = Invoke-PackageScript -Directory $pkg.Directory -ScriptName $script:Config.gates.test.script `
            -LogFile $testLog -TestTimeoutMinutes $script:Config.gates.test.timeoutMinutes
        if ($code -ne 0) {
            $red += "package '$($pkg.Name)' test suite is red (exit $code) - see $testLog"
            Write-Host "     RED (exit $code)" -ForegroundColor Red
        }

        if (-not (Test-PackageHasScript -Directory $pkg.Directory -ScriptName $script:Config.gates.visual.script)) { continue }

        if ($banked.ContainsKey($pkg.Name)) {
            $baseline[$pkg.Name] = @($banked[$pkg.Name])
            Write-Host "  == $($pkg.Name) visual baseline: $(@($banked[$pkg.Name]).Count) known red, measured on $($BaseCommit.Substring(0, 8)) by the plan that merged it" -ForegroundColor DarkGray
            continue
        }

        Write-Host "  ++ $($pkg.Name) (npm run $($script:Config.gates.visual.script) - real Chromium)" -ForegroundColor DarkCyan
        $outcome = Invoke-VisualSuite -RepoRoot $RepoRoot -PackageName $pkg.Name -Directory $pkg.Directory `
            -LogDir $LogDir -Slug 'preflight' -Stamp $Stamp
        if (-not $outcome.ran) {
            $red += @($outcome.problems)
            Write-Host "     COULD NOT RUN" -ForegroundColor Red
            continue
        }
        $red += @($outcome.problems)
        $baseline[$pkg.Name] = @($outcome.failures)
        Write-Host "     visual baseline: $(@($outcome.failures).Count) known red, inherited by every plan" -ForegroundColor DarkGray
    }

    Save-VisualBaseline -Path (Get-VisualBaselinePath -PlansDir $PlansDir) -Baseline $baseline

    if ($red.Count -gt 0) {
        throw ("Pre-flight failed - not starting the queue:`n  " + ($red -join "`n  ") +
               "`nFix the base branch first, or re-run with -SkipPreflight to start anyway.")
    }
    Write-Host "  all packages green" -ForegroundColor Green
    Write-Host ''
}

# Package name -> the failing visual test ids this plan's own verification measured. Written
# here and read once, at the merge, by Save-PreflightBank - the only moment at which that
# measurement stops describing a branch and starts describing the base branch.
#
# Script-scoped rather than threaded back through the return values, for two reasons. It would
# otherwise have to be carried by every step of verification and integration in turn, none of
# which has any use for it. And a rebased branch is verified a second time: the last measurement
# is the one taken on the tree that actually merges, which is what last-write-wins gives for free
# and what merging two return paths would have to be told.
$script:MeasuredVisuals = @{}

function Clear-MeasuredVisuals {
    $script:MeasuredVisuals = @{}
}

function Test-ChangedPackages {
    param([string] $RepoRoot, [string] $From, [string] $To, [string] $LogDir, [string] $Slug,
          [string] $Stamp, [string] $BaselinePath)

    $problems = @()
    $changed = @(Get-ChangedPackages -RepoRoot $RepoRoot -From $From -To $To)
    if ($changed.Count -eq 0 -and -not (Test-Path $script:PackagesDirAbs)) {
        Write-Host "     no package under '$($script:Config.packagesDir)/' was touched - nothing to verify (the directory does not exist)" -ForegroundColor DarkYellow
    }
    foreach ($pkg in (Get-PackagesToVerify -RepoRoot $RepoRoot -Changed $changed)) {
        $dir = Join-Path $script:PackagesDirAbs $pkg
        if (-not (Test-Path (Join-Path $dir 'package.json'))) { continue }

        # Said out loud, because a plan that edited only frontend-shared is about to spend five
        # minutes on a package it never opened, and a red one names a package its diff does not.
        $because = if ($changed -contains $pkg) { '' } else { " - built on what this plan changed" }
        Write-Host "  ++ verifying package '$pkg' (npm run $($script:Config.gates.test.script))$because" -ForegroundColor DarkCyan
        # Named per plan, not just per run. A run-wide name is overwritten by
        # every later plan that touches the same package, so the log a red plan
        # points at ends up holding some other plan's green output.
        $testLog = Join-Path $LogDir "$Slug.verify-$pkg.$Stamp.txt"
        $code = Invoke-PackageScript -Directory $dir -ScriptName $script:Config.gates.test.script `
            -LogFile $testLog -TestTimeoutMinutes $script:Config.gates.test.timeoutMinutes

        if ($code -ne 0) {
            $problems += "package '$pkg' test suite is red (exit $code) - see $testLog"
        }

        $visual = Test-PackageVisuals -RepoRoot $RepoRoot -PackageName $pkg -Directory $dir `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp
        $problems += @($visual.problems)
        if ($visual.measured) { $script:MeasuredVisuals[$pkg] = @($visual.failures) }

        $problems += Test-PackageQualityRatchet -RepoRoot $RepoRoot -PackageName $pkg -Directory $dir `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp -BaselinePath $BaselinePath
    }
    return $problems
}

<#
.SYNOPSIS
    Enforces the static-quality ratchet for one package: tsc error and eslint problem
    counts may fall, but never rise.
.DESCRIPTION
    Counts come from scripts/quality-counts.mjs. The last accepted counts live in
    plans/.quality-baseline.json (gitignored, runner-owned like .state.json). A package
    seen for the first time has its counts recorded as the baseline; a null count means
    "not measurable in this package" and is never compared. When a plan improves a
    count, the baseline ratchets down so every later plan is held to the better number.
#>
function Test-PackageQualityRatchet {
    param([string] $RepoRoot, [string] $PackageName, [string] $Directory,
          [string] $LogDir, [string] $Slug, [string] $Stamp, [string] $BaselinePath)

    if (-not $script:Config.gates.quality.enabled) { return @() }

    # The counter is the runner's own tooling and travels with it, wherever this script is
    # installed - never resolved against the target repo, which need not carry a copy.
    $countsScript = Join-Path $PSScriptRoot 'quality-counts.mjs'
    if (-not (Test-Path $countsScript)) { return @() }

    Write-Host "  ++ quality ratchet for '$PackageName' (tsc errors + eslint problems)" -ForegroundColor DarkCyan
    $qualityLog = Join-Path $LogDir "$Slug.quality-$PackageName.$Stamp.json"

    $proc = Start-Process -FilePath 'node' -ArgumentList @($countsScript, $Directory) `
        -RedirectStandardOutput $qualityLog `
        -RedirectStandardError "$qualityLog.stderr.txt" `
        -NoNewWindow -PassThru
    try { $null = $proc.Handle } catch { }
    if (-not $proc.WaitForExit($script:Config.gates.quality.timeoutMinutes * 60 * 1000)) {
        Stop-ProcessTree -ProcessId $proc.Id
        return @("quality counts for '$PackageName' timed out - see $qualityLog")
    }
    if ($proc.ExitCode -ne 0) {
        return @("quality counts for '$PackageName' failed (exit $($proc.ExitCode)) - see $qualityLog.stderr.txt")
    }

    $counts = Get-Content -Path $qualityLog -Raw -Encoding UTF8 | ConvertFrom-Json
    $baseline = Read-QualityBaseline -Path $BaselinePath
    if (-not $baseline.ContainsKey($PackageName)) { $baseline[$PackageName] = @{} }
    $entry = $baseline[$PackageName]

    $problems = @()
    foreach ($metric in @('tsc', 'lint')) {
        $now = $counts.$metric
        if ($null -eq $now) { continue }
        $before = $entry[$metric]
        if ($null -eq $before) {
            Write-Host "     $metric baseline for '$PackageName' recorded: $now" -ForegroundColor DarkGray
            $entry[$metric] = [int]$now
        }
        elseif ([int]$now -gt [int]$before) {
            $problems += "package '$PackageName' $metric count rose $before -> $now - see $qualityLog"
        }
        elseif ([int]$now -lt [int]$before) {
            Write-Host "     $metric count improved $before -> $now (baseline ratcheted)" -ForegroundColor DarkGreen
            $entry[$metric] = [int]$now
        }
    }

    Save-QualityBaseline -Path $BaselinePath -Baseline $baseline
    return $problems
}

function Read-QualityBaseline {
    param([string] $Path)

    $baseline = @{}
    if (-not (Test-Path $Path)) { return $baseline }
    $parsed = Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($pkgProp in $parsed.psobject.Properties) {
        $entry = @{}
        foreach ($metricProp in $pkgProp.Value.psobject.Properties) {
            if ($null -ne $metricProp.Value) { $entry[$metricProp.Name] = [int]$metricProp.Value }
        }
        $baseline[$pkgProp.Name] = $entry
    }
    return $baseline
}

function Save-QualityBaseline {
    param([string] $Path, [hashtable] $Baseline)

    ($Baseline | ConvertTo-Json -Depth 4) | Out-File -FilePath $Path -Encoding utf8
}

# --------------------------------------------------------------------------
# Branches -- one plan, one branch (R5.4)
# --------------------------------------------------------------------------

function Get-CurrentBranch {
    param([string] $RepoRoot)

    return Get-GitLine @('-C', $RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD')
}

function Test-GitPathExists {
    param([string] $RepoRoot, [string] $Name)

    $path = Get-GitLine @('-C', $RepoRoot, 'rev-parse', '--git-path', $Name)
    if (-not $path) { return $false }
    if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path $RepoRoot $path }
    return (Test-Path $path)
}

<#
.SYNOPSIS
    Is the repository halfway through a rebase, merge or cherry-pick?
.DESCRIPTION
    Asked before the queue starts and again after the conflict resolver has had its turn. An
    unfinished rebase is not a state anything below can reason about: the branch is on a
    detached HEAD partway through replaying commits, so 'is the plan's work here' has no
    answer, and a checkout that looks like it worked would strand the rest of the replay.
#>
function Test-GitOperationInProgress {
    param([string] $RepoRoot)

    foreach ($name in @('rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD')) {
        if (Test-GitPathExists -RepoRoot $RepoRoot -Name $name) { return $true }
    }
    return $false
}

<#
.SYNOPSIS
    Asks scripts/plan-branch-cli.mjs one question and returns its parsed JSON answer.
#>
function Invoke-BranchCli {
    param([string] $RepoRoot, [string[]] $CliArgs)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments (@((Join-Path $PSScriptRoot 'plan-branch-cli.mjs')) + $CliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "plan-branch-cli $($CliArgs[0]) failed (exit $code): $reason"
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    The branch name this plan will be implemented on.
.DESCRIPTION
    An empty -BranchPrefix is asked for with a flag rather than an empty argument: Start-Process
    joins its argument list with spaces, so an empty string vanishes on the way to node and the
    next argument would be read as the prefix.
#>
function Get-PlanBranchName {
    param([string] $RepoRoot, [string] $PlanName)

    $cliArgs = @('name', '--plan', $PlanName)
    if ($BranchPrefix) { $cliArgs += @('--prefix', $BranchPrefix) } else { $cliArgs += '--no-prefix' }
    return (Invoke-BranchCli -RepoRoot $RepoRoot -CliArgs $cliArgs).branch
}

<#
.SYNOPSIS
    Puts the repository on a fresh branch for this plan and returns its name.
.DESCRIPTION
    R5.4: no plan is implemented on the branch the queue integrates into. A plan that fails
    then leaves nothing behind on it - its half-finished work stays on its own branch, where
    it can be read, retried or deleted without touching anything else.

    The queued plan files are untracked, so they follow the checkout across untouched and this
    plan commits its own file here, exactly as it did when the runner worked on one branch.
#>
function New-PlanBranch {
    param([string] $RepoRoot, [string] $PlanName)

    $branch = Get-PlanBranchName -RepoRoot $RepoRoot -PlanName $PlanName
    Invoke-Git @('-C', $RepoRoot, 'checkout', '-b', $branch) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git checkout -b '$branch' exited $LASTEXITCODE" }
    return $branch
}

function Invoke-FastForward {
    param([string] $RepoRoot, [string] $Branch)

    Invoke-Git @('-C', $RepoRoot, 'merge', '--ff-only', $Branch) | Out-Null
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS
    Ends any rebase in progress and returns to the base branch, reporting whether it got there.
#>
function Restore-BaseCheckout {
    param([string] $RepoRoot, [string] $Base)

    if (Test-GitOperationInProgress -RepoRoot $RepoRoot) {
        Invoke-Git @('-C', $RepoRoot, 'rebase', '--abort') | Out-Null
    }
    Invoke-Git @('-C', $RepoRoot, 'checkout', $Base) | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Get-GitCount {
    param([string[]] $Output)

    $line = ($Output | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($line -match '^\s*(\d+)\s*$') { return [int]$Matches[1] }
    return 0
}

<#
.SYNOPSIS
    The prompt the one conflict-resolution session gets.
.DESCRIPTION
    No backticks anywhere in the body. This is a double-quoted here-string, where a backtick is
    PowerShell's escape character: markdown quoting would be eaten silently, and "`r" in the
    middle of a word would arrive as a carriage return.
#>
function New-ResolvePrompt {
    param([string] $Base, [string] $Branch, [string[]] $Paths)

    $files = (($Paths | ForEach-Object { "  - $_" }) -join "`n")
    return @"
You are the plan runner's conflict resolver, running unattended. Nobody is watching, there is
nobody to ask, and this is the only attempt.

A rebase of the plan branch '$Branch' onto '$Base' has stopped on a conflict. The rebase is in
progress right now. These files are unmerged:

$files

Finish that rebase so that both sides survive:

1. Read each conflicted file and work out what each side was doing. "git log --oneline
   $Base..$Branch" is the plan's work; the log of $Base is what landed underneath it while the
   plan was being written.
2. Resolve every conflict so both intents hold. Keep both changes unless they truly contradict.
3. "git add" each file you resolved, then "git -c core.editor=true rebase --continue". Always
   pass -c core.editor=true so nothing opens an editor and blocks forever. The rebase may stop
   again on a later commit: resolve and continue until it reports the rebase is finished.
4. Run "npm run $($script:Config.gates.test.script)" in every package directory you touched and get it green.

Hard rules:

- Touch only the conflicted files. This is not the moment for any other change.
- Never delete, skip or weaken a test or an assertion to make a conflict go away.
- Never run "git rebase --skip": it throws away the plan's commit.
- Leave no conflict markers behind.
- Do not commit anything unrelated, do not push, do not tag, do not switch branches.

If the two sides genuinely contradict - if resolving them means guessing at intent, or deciding
which behaviour is the correct one - do not guess. Run "git rebase --abort" and stop. A plan
reported as failed is a good outcome; a plausible merge that nobody checked is not.

The runner checks the repository itself afterwards, so say only what you actually did.
End your final message with one line, exactly: RESOLVED or REBASE_BLOCKED.
"@
}

<#
.SYNOPSIS
    What the repository says about the resolution attempt - never what the session claimed.
.DESCRIPTION
    Four questions, and all of them have to answer yes: the rebase finished, the branch now
    sits on top of the base, it still carries at least one commit of its own, and no file it
    was asked to resolve still has conflict markers in it.

    The last two are what a hurried resolution fails. "git rebase --skip" past the conflict
    finishes the rebase and leaves an empty branch, and a file "resolved" by leaving the
    markers in place still parses in enough languages to reach the base branch unnoticed.
#>
function Test-ResolvedRebase {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string[]] $Paths, [string] $LogFile)

    if (Test-GitOperationInProgress -RepoRoot $RepoRoot) {
        return @("the rebase of '$Branch' onto '$Base' was left unfinished - see $LogFile")
    }

    Invoke-Git @('-C', $RepoRoot, 'merge-base', '--is-ancestor', $Base, $Branch) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        return @("the conflict between '$Branch' and '$Base' was not resolved, and the rebase was abandoned - see $LogFile")
    }

    $problems = @()
    $carried = Get-GitCount (Invoke-Git @('-C', $RepoRoot, 'rev-list', '--count', "$Base..$Branch"))
    if ($carried -lt 1) {
        $problems += "the rebase left nothing on top of '$Base' - the plan's own commit was dropped"
    }

    $markerArgs = @('markers')
    foreach ($path in $Paths) { $markerArgs += @('--path', $path) }
    foreach ($marker in @((Invoke-BranchCli -RepoRoot $RepoRoot -CliArgs $markerArgs).found)) {
        $problems += "conflict marker left in $($marker.path) line $($marker.line)"
    }

    if ($problems.Count -gt 0) { $problems += "see $LogFile" }
    return $problems
}

<#
.SYNOPSIS
    Gives one scoped session the chance to finish a conflicted rebase, and checks its work.
#>
function Resolve-PlanRebase {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $LogDir,
          [string] $Slug, [string] $Stamp)

    $paths = @((Invoke-BranchCli -RepoRoot $RepoRoot -CliArgs @('conflicts')).paths)
    if ($paths.Count -eq 0) {
        return @("rebasing '$Branch' onto '$Base' failed without leaving a conflicted file to resolve")
    }

    Write-Host "  !! rebase conflict in $($paths.Count) file(s) - one session gets to resolve it:" -ForegroundColor Yellow
    foreach ($path in $paths) { Write-Host "       $path" -ForegroundColor Yellow }

    $promptFile = Join-Path $LogDir "$Slug.resolve.$Stamp.prompt.txt"
    Set-Content -Path $promptFile -Value (New-ResolvePrompt -Base $Base -Branch $Branch -Paths $paths) -Encoding UTF8
    $logFile = Join-Path $LogDir "$Slug.resolve.$Stamp.jsonl"

    $code = Invoke-ClaudeOnPlan -PromptFile $promptFile -LogFile $logFile `
        -ErrorFile "$logFile.stderr.txt" -WorkingDirectory $RepoRoot `
        -SessionTimeoutMinutes $ConflictTimeoutMinutes
    if ($code -ne 0) { Write-Host "     resolver exited $code" -ForegroundColor Yellow }

    return @(Test-ResolvedRebase -RepoRoot $RepoRoot -Base $Base -Branch $Branch -Paths $paths -LogFile $logFile)
}

<#
.SYNOPSIS
    Verifies a rebased branch again, because it is no longer the tree that was verified.
.DESCRIPTION
    The plan's commit has been replayed onto commits it was never tested against, and a
    conflict resolution rewrote its files. Everything the plan was held to the first time it
    is held to again - so nothing reaches the base branch on the strength of a verification
    that ran against a different tree.

    The tree check here is the pre-flight one, with every scripts/ path carried. The plan's own
    leftovers were already charged to it by Test-PlanOutcome before this point; all that is
    left to catch is dirt the resolver session made, and it is scoped to conflicted files.
#>
function Test-RebasedBranch {
    param([string] $RepoRoot, [string] $Base, [string] $LogDir, [string] $Slug, [string] $Stamp)

    $assessment = Get-TreeAssessment -RepoRoot $RepoRoot
    if (-not $assessment.clean) {
        return @("the rebase left the working tree dirty: $($assessment.blocking -join '; ')")
    }
    if ($SkipVerify) { return @() }

    Write-Host "  ++ re-verifying the rebased branch" -ForegroundColor DarkCyan
    $baselinePath = Join-Path (Split-Path $LogDir -Parent) '.quality-baseline.json'
    return @(Test-ChangedPackages -RepoRoot $RepoRoot -From $Base -To 'HEAD' `
        -LogDir $LogDir -Slug "$Slug.rebased" -Stamp $Stamp -BaselinePath $baselinePath)
}

<#
.SYNOPSIS
    Replays this plan's branch on top of a base branch that moved, and re-verifies it.
.DESCRIPTION
    Always ends on the base branch, whether it succeeded or not, so the caller never has to
    guess where the repository is standing.
#>
function Update-PlanBranchOntoBase {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $LogDir,
          [string] $Slug, [string] $Stamp)

    Invoke-Git @('-C', $RepoRoot, 'checkout', $Branch) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        return @("could not switch to '$Branch' to rebase it (git checkout exit $LASTEXITCODE)")
    }

    $problems = @()
    Invoke-Git @('-C', $RepoRoot, 'rebase', $Base) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $problems = @(Resolve-PlanRebase -RepoRoot $RepoRoot -Base $Base -Branch $Branch `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp)
    }
    if ($problems.Count -eq 0) {
        $problems = @(Test-RebasedBranch -RepoRoot $RepoRoot -Base $Base -LogDir $LogDir -Slug $Slug -Stamp $Stamp)
    }

    if (-not (Restore-BaseCheckout -RepoRoot $RepoRoot -Base $Base)) {
        $problems += "could not switch back to '$Base' after rebasing '$Branch'"
    }
    return $problems
}

<#
.SYNOPSIS
    Deletes a plan's branch now its commits are on the base branch, unless asked to keep it.
.DESCRIPTION
    -d, never -D. It refuses a branch holding anything the base branch does not, which is the
    one check worth having here: if the fast-forward was not what this script believed it was,
    the ref stays and the work with it.
#>
function Remove-MergedBranch {
    param([string] $RepoRoot, [string] $Branch)

    if ($KeepPlanBranches) { return }
    Invoke-Git @('-C', $RepoRoot, 'branch', '-d', $Branch) | Out-Null
}

# --------------------------------------------------------------------------
# The remote -- origin is the base branch, not this machine's copy of it
# --------------------------------------------------------------------------

<#
.SYNOPSIS
    Asks scripts/git-sync-cli.mjs where a branch stands against its remote.
.DESCRIPTION
    The CLI fetches, which is why it gets longer than the two minutes the other bridges are
    given: a fetch that has to bring down a week of another machine's work is slow, and being
    killed halfway through it would report a fault that is not there.
#>
function Invoke-SyncCli {
    param([string] $RepoRoot, [string[]] $CliArgs)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments (@((Join-Path $PSScriptRoot 'git-sync-cli.mjs')) + $CliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 5

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "git-sync-cli failed (exit $code): $reason"
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    Carries out the moves git-sync named, and returns what stopped it if anything did.
.DESCRIPTION
    Both moves preserve history exactly. The fast-forward is the one that matters most - it is
    what makes the local base branch equal to the remote one before anything is measured against
    it - and the push exists so that a commit made on the base branch here, such as a failed
    plan's report, does not sit unpublished until it meets an incoming commit and diverges.
#>
function Invoke-SyncActions {
    param([string] $RepoRoot, [string] $Base, $Answer)

    foreach ($action in @($Answer.actions)) {
        if ($action -eq 'fast-forward') {
            Write-Host "  ++ '$Base': $($Answer.reason) - fast-forwarding onto $($Answer.upstream)" -ForegroundColor DarkCyan
            Invoke-Git @('-C', $RepoRoot, 'merge', '--ff-only', $Answer.upstream) | Out-Null
            if ($LASTEXITCODE -ne 0) {
                return @("could not fast-forward '$Base' onto '$($Answer.upstream)' (git merge --ff-only exit $LASTEXITCODE)")
            }
        }
        elseif ($action -eq 'push') {
            Write-Host "  ++ '$Base': $($Answer.reason) - pushing to $($Answer.remote)" -ForegroundColor DarkCyan
            Invoke-Git @('-C', $RepoRoot, 'push', $Answer.remote, $Base) | Out-Null
            if ($LASTEXITCODE -ne 0) {
                return @("could not push '$Base' to '$($Answer.remote)' (git push exit $LASTEXITCODE)")
            }
        }
    }
    return @()
}

<#
.SYNOPSIS
    Makes the base branch equal to its remote, and says which remote that was.
.DESCRIPTION
    Returns .remote - the remote a plan branch may be pushed at, empty when there is none to
    push at - and .problems, which is empty when the branch is now level with its remote.

    Two states produce no remote and no problem, and both mean "carry on locally, exactly as
    this runner always did": -SkipSync, and a base branch that tracks nothing. The second is a
    supported way to run the queue - plans/README.md recommends a disposable local branch for a
    batch you intend to throw away - so it is not a warning.

    A diverged branch is a problem, never an action. Reconciling it means a merge commit or a
    force-push, and this script is not allowed to do either: one would put an untested tree on
    the base branch and the other would delete whatever the remote had.
#>
function Sync-BaseBranch {
    param([string] $RepoRoot, [string] $Base)

    if ($SkipSync) {
        return [pscustomobject]@{ state = 'skipped'; remote = ''; upstream = ''; problems = @() }
    }

    $answer = Invoke-SyncCli -RepoRoot $RepoRoot -CliArgs @('--base', $Base)
    if ($answer.state -eq 'no-upstream') {
        return [pscustomobject]@{ state = $answer.state; remote = ''; upstream = ''; problems = @() }
    }
    if ($answer.state -eq 'diverged') {
        return [pscustomobject]@{
            state = $answer.state; remote = $answer.remote; upstream = $answer.upstream
            problems = @("'$Base' has diverged from '$($answer.upstream)': $($answer.reason)")
        }
    }

    return [pscustomobject]@{
        state = $answer.state; remote = $answer.remote; upstream = $answer.upstream
        problems = @(Invoke-SyncActions -RepoRoot $RepoRoot -Base $Base -Answer $answer)
    }
}

<#
.SYNOPSIS
    Could the base branch fast-forward onto this branch right now?
.DESCRIPTION
    Asked rather than attempted, because the local fast-forward is now the last step of the
    integration and not the first: the remote has to accept the branch before this machine's
    base branch moves onto it. Merging here to find out would be the move that step exists to
    avoid.
#>
function Test-FastForwardable {
    param([string] $RepoRoot, [string] $Base, [string] $Branch)

    Invoke-Git @('-C', $RepoRoot, 'merge-base', '--is-ancestor', $Base, $Branch) | Out-Null
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS
    Pushes a verified plan branch straight at the remote base branch.
.DESCRIPTION
    This is where an integration is decided. The remote either fast-forwards its base branch
    onto this commit or refuses because somebody else got there first, and it does so
    atomically - which is the whole reason it goes before the local merge rather than after it.
#>
function Push-BranchOntoBase {
    param([string] $RepoRoot, [string] $Remote, [string] $Branch, [string] $Base)

    Invoke-Git @('-C', $RepoRoot, 'push', $Remote, "${Branch}:${Base}") | Out-Null
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS
    Refuses to start unless the repository is somewhere plans can safely merge into.
.DESCRIPTION
    Three ways this goes wrong before a single plan has run, all of them cheaper to catch here
    than halfway through a queue.

    A detached HEAD has no branch to merge into, so every plan would fail at its last step.

    A rebase or merge left in progress by whatever ran last makes git refuse the first
    checkout, and the run would report that against a plan which had nothing to do with it.

    Starting on a plan branch is the subtle one: the queue would fast-forward each plan onto an
    abandoned branch belonging to some earlier plan, quietly building the whole batch on top of
    work that was never verified and never integrated.
#>
function Assert-BaseBranchUsable {
    param([string] $RepoRoot, [string] $Base)

    if (-not $Base -or $Base -eq 'HEAD') {
        throw 'HEAD is detached - there is no branch for plans to merge into. Check one out first.'
    }
    if (Test-GitOperationInProgress -RepoRoot $RepoRoot) {
        throw 'A rebase, merge or cherry-pick is in progress. Finish or abort it before starting the queue.'
    }
    if ($BranchPrefix -and $Base.StartsWith($BranchPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "This is '$Base', a plan branch left by an earlier run. Switch to the branch plans should merge into first."
    }
}

<#
.SYNOPSIS
    The outcome of one integration. -Rejected marks the one problem worth trying again for.
.DESCRIPTION
    A push the remote refused says only that somebody else's commit got there first, which is
    not a fault in this plan and is fixed by going round again from the sync. Every other
    problem is a decision that will come out the same way twice.
#>
function New-IntegrationResult {
    param([string[]] $Problems = @(), [string] $Commit = $null, [switch] $Rejected)

    return [pscustomobject]@{
        ok       = ($Problems.Count -eq 0)
        problems = $Problems
        commit   = $Commit
        rejected = [bool]$Rejected
    }
}

<#
.SYNOPSIS
    One attempt at putting a verified plan onto the base branch, here and on its remote.
.DESCRIPTION
    The order is the whole point, and swapping the last two steps breaks the retry.

    1. Sync the base branch with its remote, so the plan is judged against, and lands on, what
       origin actually holds.
    2. If the base moved past the plan, rebase the branch onto it and verify it again - a
       rebased tree is not the tree that was verified.
    3. Push the branch straight at the remote base branch. The remote arbitrates: it either
       fast-forwards onto this commit or refuses because somebody beat us to it.
    4. Only then fast-forward locally, which can no longer fail.

    Fast-forwarding locally first would leave the base branch simultaneously ahead by this
    plan's commit and behind by the incoming one - diverged, recoverable only with a reset -
    every time a push was rejected. Letting the remote go first means a rejection has changed
    nothing here, and the retry is simply this function again.
#>
function Invoke-IntegrationAttempt {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $LogDir,
          [string] $Slug, [string] $Stamp)

    $sync = Sync-BaseBranch -RepoRoot $RepoRoot -Base $Base
    if ($sync.problems.Count -gt 0) { return (New-IntegrationResult -Problems @($sync.problems)) }

    if (-not (Test-FastForwardable -RepoRoot $RepoRoot -Base $Base -Branch $Branch)) {
        Write-Host "  ++ '$Base' moved while this plan ran - rebasing '$Branch' onto it" -ForegroundColor DarkCyan
        $problems = @(Update-PlanBranchOntoBase -RepoRoot $RepoRoot -Base $Base -Branch $Branch `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp)
        if ($problems.Count -gt 0) { return (New-IntegrationResult -Problems $problems) }

        if (-not (Test-FastForwardable -RepoRoot $RepoRoot -Base $Base -Branch $Branch)) {
            return (New-IntegrationResult -Problems @("'$Branch' would not fast-forward onto '$Base' even after rebasing"))
        }
    }

    if ($sync.remote -and -not (Push-BranchOntoBase -RepoRoot $RepoRoot -Remote $sync.remote -Branch $Branch -Base $Base)) {
        return (New-IntegrationResult -Rejected -Problems @(
            "$($sync.remote) refused '$Branch' onto '$Base' - the remote moved while this plan ran"))
    }

    if (-not (Invoke-FastForward -RepoRoot $RepoRoot -Branch $Branch)) {
        return (New-IntegrationResult -Problems @("'$Branch' would not fast-forward onto '$Base'"))
    }

    Remove-MergedBranch -RepoRoot $RepoRoot -Branch $Branch
    return (New-IntegrationResult -Commit (Get-GitLine @('-C', $RepoRoot, 'rev-parse', 'HEAD')))
}

<#
.SYNOPSIS
    Brings a verified plan onto the base branch, and says what stopped it if anything did.
.DESCRIPTION
    The base branch only ever fast-forwards, here and on the remote. A merge commit would put a
    tree on it that was never tested as a whole, and this way the history reads exactly as it
    did when plans were committed straight onto it.

    A rejected push is the one failure worth repeating, and it is repeated exactly once. It
    means the remote moved during this plan's verification, so the second attempt starts again
    from the sync - fetch, rebase, re-verify, push - against what the remote holds now. A
    second rejection fails the plan: its branch is kept and the next run retries the whole
    thing, which is a better answer than looping against a remote somebody is actively pushing
    to.
#>
function Merge-PlanBranch {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $LogDir,
          [string] $Slug, [string] $Stamp)

    $result = $null
    foreach ($attempt in 1..2) {
        if (-not (Restore-BaseCheckout -RepoRoot $RepoRoot -Base $Base)) {
            return (New-IntegrationResult -Problems @("could not switch to '$Base' to integrate '$Branch'"))
        }

        $result = Invoke-IntegrationAttempt -RepoRoot $RepoRoot -Base $Base -Branch $Branch `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp
        if ($result.ok -or -not $result.rejected) { return $result }
        if ($attempt -lt 2) {
            Write-Host "  ++ $($result.problems[0]) - trying once more" -ForegroundColor DarkCyan
        }
    }
    return $result
}

function Test-PathInBranch {
    param([string] $RepoRoot, [string] $Branch, [string] $Path)

    Invoke-Git @('-C', $RepoRoot, 'cat-file', '-e', "${Branch}:${Path}") | Out-Null
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS
    Brings a failed plan's paperwork back from its branch: the plan file, and the report.
.DESCRIPTION
    Both were committed on the branch, and switching back to the base branch took them out of
    the working tree with them. The plan file has to be on disk or the queue cannot see it to
    retry it, and the report has to reach the base branch or the only account of the failure
    sits on a branch nobody will think to look at.

    The plan file is unstaged again afterwards, so it is sitting untracked exactly as it was
    when the queue picked it up. The report is committed, as it always has been.
#>
function Restore-PlanArtifacts {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $PlanName, [string] $Slug)

    $actions = @()
    $planPath = "$($script:PlansRel)/$PlanName"
    if (-not (Test-Path (Join-Path $RepoRoot $planPath)) -and
        (Test-PathInBranch -RepoRoot $RepoRoot -Branch $Branch -Path $planPath)) {
        Invoke-Git @('-C', $RepoRoot, 'checkout', $Branch, '--', $planPath) | Out-Null
        Invoke-Git @('-C', $RepoRoot, 'reset', '-q', '--', $planPath) | Out-Null
        $actions += "put $planPath back in the tree, untracked, so the queue can retry it"
    }

    $reportPath = "$($script:PlansRel)/reports/$Slug.md"
    if (-not (Test-PathInBranch -RepoRoot $RepoRoot -Branch $Branch -Path $reportPath)) { return $actions }

    Invoke-Git @('-C', $RepoRoot, 'checkout', $Branch, '--', $reportPath) | Out-Null
    $staged = @(Invoke-Git @('-C', $RepoRoot, 'diff', '--cached', '--name-only', '--', $reportPath) |
        Where-Object { $_.Trim() })
    if ($staged.Count -eq 0) { return $actions }

    Invoke-Git @('-C', $RepoRoot, 'commit', '-m', "plans: record failed report for $PlanName", '--', $reportPath) | Out-Null
    return ($actions + "committed the report from '$Branch' onto '$Base'")
}

<#
.SYNOPSIS
    Publishes a failed plan's branch, so half-finished work can be read from another machine.
.DESCRIPTION
    Nothing merges here: the branch is pushed under its own name, and only the base branch is
    ever fast-forwarded. It is how the work leaves the unattended machine it was made on -
    otherwise the only account of a night's failed plan is a branch on a box nobody is sitting at.

    A push that fails is reported and never escalated. The plan has already failed; losing the
    rest of the tidy-up over it would strand the queue behind it.
#>
function Publish-FailedBranch {
    param([string] $RepoRoot, [string] $Remote, [string] $Branch)

    if (-not $Remote) { return @() }

    Invoke-Git @('-C', $RepoRoot, 'push', $Remote, $Branch) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        return @("could not push '$Branch' to $Remote (git push exit $LASTEXITCODE) - the work is on this machine only")
    }
    return @("pushed '$Branch' to $Remote so the work can be read from anywhere")
}

<#
.SYNOPSIS
    Returns the repository to the base branch after a failed plan, losing nothing.
.DESCRIPTION
    The queue only keeps moving if each plan starts on the base branch with a tree the next
    plan's cleanliness check will accept. The failed plan's work needs no rescuing to make
    that true - it is on its own branch, which is the whole point of running it there. It is
    pushed all the same, so that branch is readable from somewhere other than this machine.
#>
function Reset-AfterFailedPlan {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $PlanName,
          [string] $Slug, [string] $Remote)

    $actions = @()
    if (Test-GitOperationInProgress -RepoRoot $RepoRoot) {
        Invoke-Git @('-C', $RepoRoot, 'rebase', '--abort') | Out-Null
        $actions += 'aborted the rebase that was left in progress'
    }

    $actions += Clear-WorkingTree -RepoRoot $RepoRoot -PlanName $PlanName
    if (-not $Branch) { return $actions }

    if (-not (Restore-BaseCheckout -RepoRoot $RepoRoot -Base $Base)) {
        return ($actions + "could not return to '$Base' - the repository is still on '$Branch'")
    }
    $actions += "back on '$Base'; this plan's work stays on '$Branch'"
    $actions += Publish-FailedBranch -RepoRoot $RepoRoot -Remote $Remote -Branch $Branch
    return ($actions + (Restore-PlanArtifacts -RepoRoot $RepoRoot -Base $Base -Branch $Branch `
        -PlanName $PlanName -Slug $Slug))
}

<#
.SYNOPSIS
    Test-PlanOutcome, with a fault in the verification itself recorded rather than thrown.
.DESCRIPTION
    Verification must never take the run down with it. A crash here, after the agent has
    already committed, would otherwise lose the record of a finished plan and make the next
    run repeat it - expensive work redone for an infrastructure fault.
#>
function Get-PlanVerdict {
    param([string] $HeadBefore, [string] $RepoRoot, [string] $LogDir, [string] $Slug,
          [string] $Stamp, [string] $PlanName, [string[]] $PendingScripts = @())

    try {
        $outcome = Test-PlanOutcome -HeadBefore $HeadBefore -RepoRoot $RepoRoot `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp -PlanName $PlanName -PendingScripts $PendingScripts
        return [pscustomobject]@{ commit = $outcome.commit; problems = @($outcome.problems) }
    }
    catch {
        $headNow = Get-GitLine @('-C', $RepoRoot, 'rev-parse', 'HEAD')
        $commitOrNull = $null
        if ($headNow -ne $HeadBefore) { $commitOrNull = $headNow }
        return [pscustomobject]@{
            commit   = $commitOrNull
            problems = @("verification failed to run: $($_.Exception.Message)")
        }
    }
}

<#
.SYNOPSIS
    Merge-PlanBranch, with any fault recorded as a failed integration instead of thrown.
#>
function Get-PlanIntegration {
    param([string] $RepoRoot, [string] $Base, [string] $Branch, [string] $LogDir,
          [string] $Slug, [string] $Stamp)

    try {
        return Merge-PlanBranch -RepoRoot $RepoRoot -Base $Base -Branch $Branch `
            -LogDir $LogDir -Slug $Slug -Stamp $Stamp
    }
    catch {
        return (New-IntegrationResult -Problems @(
            "could not integrate '$Branch' into '$Base': $($_.Exception.Message)"))
    }
}

<#
.SYNOPSIS
    The bridge to scripts/plan-repair.mjs, where the repair rules are decided and tested.
#>
function Invoke-RepairCli {
    param([string] $RepoRoot, [string[]] $CliArgs)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-CapturedProcess -FilePath 'node' `
            -Arguments (@((Join-Path $PSScriptRoot 'plan-repair-cli.mjs')) + $CliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -WorkingDirectory $RepoRoot -ProcessTimeoutMinutes 2

        if ($code -ne 0) {
            $reason = Get-FirstLine (Get-Content -Path $stderr -Raw -Encoding UTF8) 200
            throw "plan-repair-cli $($CliArgs[0]) failed (exit $code): $reason"
        }
        return (Get-Content -Path $stdout -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    The prompt the one repair session gets.
.DESCRIPTION
    No backticks and no bare dollar signs anywhere in the body except the ones interpolated on
    purpose. This is a double-quoted here-string: a backtick is PowerShell's escape character
    and would be eaten silently, and any other "dollar-word" would expand to an empty variable.
#>
function New-RepairPrompt {
    param([string] $Branch, [string] $PlanName, [string[]] $Problems)

    $gates = (($Problems | ForEach-Object { "  - $_" }) -join "`n")
    $visualScript = $script:Config.gates.visual.script
    return @"
You are the plan runner's repair pass, running unattended. Nobody is watching, there is nobody
to ask, and this is the only attempt.

The plan '$PlanName' finished and committed its work to the branch '$Branch'. Its own tests
passed. Then the runner ran the full gates over that commit, and these went red:

$gates

They are almost always specs the plan never thought to run - a shared surface it changed that
some other spec also renders. Fix the cause:

1. Read the log each problem above names. It holds the failing test ids and the assertion.
2. Run that gate yourself to see the failure first hand. For a visual red that is
   "npm run $visualScript -- <the spec file>" in the package directory.
3. Fix the cause in the code, then re-run. For a visual red, finish with the whole sweep -
   "npm run $visualScript" - because the fix can move a third spec you have not looked at.
4. Commit on this branch. A second commit is expected here; say in its message what it repairs.
5. Append a "Repair" section to this plan's report under plans/reports/ saying what was red,
   what you changed and why. Commit that with the fix.

Hard rules:

- Never re-record a snapshot. Every file under a "__snapshots__" directory is off limits, and
  the runner checks afterwards and fails the plan if you touched one. The plan's own session
  already re-recorded the baselines it meant to move, so a red found after it finished is one
  the plan did not intend - re-recording it would bake in whatever actually broke.
- Never delete, skip, weaken or narrow a test or an assertion to get a gate green. If a test
  encodes an invariant your plan genuinely and deliberately changed, that is a judgement for a
  person: stop, and say so.
- Stay inside what this plan changed. This is not the moment for unrelated work.
- Do not push, do not tag, do not switch branches, do not touch another plan's files, and do
  not add or edit anything under plans/ except this plan's own report.

If the fix is not clear, or it means guessing at what somebody intended, or the only way to
green is to undo what the plan set out to do - stop and change nothing. A plan reported as
failed is a good outcome; a plan made green by hiding the failure is not.

The runner re-runs every gate afterwards and checks the repository itself, so say only what
you actually did. End your final message with one line, exactly: REPAIRED or REPAIR_BLOCKED.
"@
}

<#
.SYNOPSIS
    What the repository says the repair session did - never what the session claimed.
.DESCRIPTION
    Two questions before the gates are worth re-running: did it change anything at all, and did
    it stay off the snapshots. The second is the one that matters. Re-recording a baseline turns
    any visual red green while hiding what moved, it is the cheapest wrong answer available to a
    session under pressure to produce one, and section 4 of the spine forbids it for exactly
    this reason. A repair that reaches for it is failed here rather than merged.
#>
function Test-RepairedBranch {
    param([string] $RepoRoot, [string] $Commit, [string] $LogFile)

    $headNow = Get-GitLine @('-C', $RepoRoot, 'rev-parse', 'HEAD')
    if ($headNow -eq $Commit) {
        return @("the repair session committed nothing - see $LogFile")
    }

    $audit = Invoke-RepairCli -RepoRoot $RepoRoot -CliArgs @('audit', '--since', $Commit)
    $forbidden = @($audit.forbidden)
    if ($forbidden.Count -gt 0) {
        return @("the repair session re-recorded $($forbidden.Count) snapshot(s) instead of fixing the cause: " +
                 (($forbidden | Select-Object -First 5) -join ', ') + " - see $LogFile")
    }
    return @()
}

<#
.SYNOPSIS
    Gives one scoped session the chance to fix a gate it turned red, and checks its work.
.DESCRIPTION
    Why this exists at all: of the three plans that had ever failed in the queue this was
    written for, two failed on a visual spec they never ran, and both were a quarter of an hour
    of good work thrown away over a fault of a line or two. The runner caught them correctly;
    it simply had nobody left to tell.

    Narrow on purpose, and it fails closed at every step. It runs only when *every* problem is a
    gate a session can act on (scripts/plan-repair.mjs decides that, and is tested there), only
    when the plan actually committed, only once, and never when the plan's own session did not
    exit cleanly. Afterwards the whole verdict is taken again rather than just the gate that was
    red - a repair is a new tree, and nothing reaches the base branch on the strength of a gate
    that was not re-run against it.
#>
function Invoke-PlanRepair {
    param([string] $RepoRoot, [string] $Branch, [string] $PlanName, [string[]] $Problems,
          [string] $Commit, [string] $HeadBefore, [string] $LogDir, [string] $Slug,
          [string] $Stamp, [string[]] $PendingScripts = @())

    $unrepaired = [pscustomobject]@{ repaired = $false; commit = $Commit; problems = @($Problems) }
    if ($NoRepair) { return $unrepaired }

    $problemsFile = New-TempPath '.problems.json'
    try {
        # -InputObject, not the pipeline. Piping a one-item array to ConvertTo-Json on 5.1 gives
        # a bare string rather than an array, and the usual unary-comma guard against that gives
        # {"value":[...],"Count":n} - an object. Only this form yields a plain array either way.
        (ConvertTo-Json -InputObject @($Problems) -Depth 3) | Set-Content -Path $problemsFile -Encoding UTF8
        $assessment = Invoke-RepairCli -RepoRoot $RepoRoot -CliArgs @('assess', '--problems-file', $problemsFile)
    }
    finally { Remove-Item -Path $problemsFile -Force -ErrorAction SilentlyContinue }

    if (-not $assessment.repairable) { return $unrepaired }

    Write-Host "  !! $($Problems.Count) gate(s) red - one session gets to repair it:" -ForegroundColor Yellow
    foreach ($problem in $Problems) { Write-Host "       $problem" -ForegroundColor Yellow }

    $promptFile = Join-Path $LogDir "$Slug.repair.$Stamp.prompt.txt"
    Set-Content -Path $promptFile -Encoding UTF8 `
        -Value (New-RepairPrompt -Branch $Branch -PlanName $PlanName -Problems $Problems)
    $logFile = Join-Path $LogDir "$Slug.repair.$Stamp.jsonl"

    $code = Invoke-ClaudeOnPlan -PromptFile $promptFile -LogFile $logFile `
        -ErrorFile "$logFile.stderr.txt" -WorkingDirectory $RepoRoot `
        -SessionTimeoutMinutes $RepairTimeoutMinutes
    if ($code -ne 0) { Write-Host "     repairer exited $code" -ForegroundColor Yellow }

    $refused = @(Test-RepairedBranch -RepoRoot $RepoRoot -Commit $Commit -LogFile $logFile)
    if ($refused.Count -gt 0) { return [pscustomobject]@{ repaired = $false; commit = $Commit; problems = $refused } }

    Write-Host "  ++ the repair committed - taking the whole verdict again" -ForegroundColor DarkCyan
    $verdict = Get-PlanVerdict -HeadBefore $HeadBefore -RepoRoot $RepoRoot -LogDir $LogDir `
        -Slug $Slug -Stamp "$Stamp-repair" -PlanName $PlanName -PendingScripts $PendingScripts
    $after = @($verdict.problems)
    if ($after.Count -gt 0) {
        return [pscustomobject]@{
            repaired = $false
            commit   = $verdict.commit
            problems = @("the repair session did not settle it - see $logFile") + $after
        }
    }

    Write-Host "  ++ repaired - every gate green" -ForegroundColor Green
    return [pscustomobject]@{ repaired = $true; commit = $verdict.commit; problems = @() }
}

<#
.SYNOPSIS
    The whole life of one plan: its branch, its session, its verification, its merge.
.DESCRIPTION
    Nothing here throws. Every fault becomes an entry in .problems, so a plan that cannot be
    branched, run, verified or merged costs itself and not the queue behind it.

    The order is the point. Verification runs on the branch, before anything is integrated,
    so a plan that fails leaves the base branch exactly as it found it - which is what the
    old single-branch runner could not do: it verified work that was already committed there.
#>
function Invoke-PlanOnBranch {
    param([System.IO.FileInfo] $Plan, [string] $Slug, [string] $RepoRoot, [string] $Base,
          [string] $PromptFile, [string] $LogFile, [string] $ErrorFile,
          [string] $LogDir, [string] $Stamp)

    $run = [ordered]@{ branch = $null; commit = $null; problems = @() }
    $headBefore = Get-GitLine @('-C', $RepoRoot, 'rev-parse', 'HEAD')
    Clear-MeasuredVisuals

    try { $run.branch = New-PlanBranch -RepoRoot $RepoRoot -PlanName $Plan.Name }
    catch {
        $run.problems = @("could not branch for this plan: $($_.Exception.Message)")
        return [pscustomobject]$run
    }
    Write-Host "  ++ working on branch '$($run.branch)', off '$Base'" -ForegroundColor DarkCyan

    # Taken now, while everything dirty is demonstrably somebody else's doing.
    try { $pendingScripts = @(Get-PendingScripts -RepoRoot $RepoRoot) }
    catch {
        $run.problems = @("could not read the tree before starting: $($_.Exception.Message)")
        return [pscustomobject]$run
    }

    $exitCode = Invoke-ClaudeOnPlan -PromptFile $PromptFile -LogFile $LogFile `
        -ErrorFile $ErrorFile -WorkingDirectory $RepoRoot -SessionTimeoutMinutes $TimeoutMinutes

    $verdict = Get-PlanVerdict -HeadBefore $headBefore -RepoRoot $RepoRoot -LogDir $LogDir `
        -Slug $Slug -Stamp $Stamp -PlanName $Plan.Name -PendingScripts $pendingScripts
    $run.commit = $verdict.commit
    $problems = @($verdict.problems)
    if ($exitCode -ne 0) { $problems = @("claude exited with code $exitCode") + $problems }

    # A red gate is not the end of the plan yet. Anything that is not a gate - no commit, a
    # dirty tree, a session that did not exit cleanly - is still in $problems here, and makes
    # the assessment inside refuse, so this is a no-op for every failure except the one it is
    # for. See Invoke-PlanRepair.
    if ($problems.Count -gt 0 -and $run.commit) {
        $repair = Invoke-PlanRepair -RepoRoot $RepoRoot -Branch $run.branch -PlanName $Plan.Name `
            -Problems $problems -Commit $run.commit -HeadBefore $headBefore -LogDir $LogDir `
            -Slug $Slug -Stamp $Stamp -PendingScripts $pendingScripts
        $run.commit = $repair.commit
        $problems = @($repair.problems)
    }

    if ($problems.Count -gt 0) {
        $run.problems = $problems
        return [pscustomobject]$run
    }

    # Read before the integration moves it: what this plan was verified on top of, and so the
    # tree the previous batch's measurement is allowed to still describe.
    $baseBefore = Get-GitLine @('-C', $RepoRoot, 'rev-parse', $Base)

    $integration = Get-PlanIntegration -RepoRoot $RepoRoot -Base $Base -Branch $run.branch `
        -LogDir $LogDir -Slug $Slug -Stamp $Stamp
    $run.problems = @($integration.problems)
    if ($integration.ok) {
        $run.commit = $integration.commit
        Save-PreflightBank -RepoRoot $RepoRoot -PlansDir (Split-Path $LogDir -Parent) `
            -From $baseBefore -Commit $integration.commit
    }
    return [pscustomobject]$run
}

# --------------------------------------------------------------------------
# Release -- only reached with -ReleaseEachPlan, and only through the project's release hook
# --------------------------------------------------------------------------

# How a tag gets made, and how its deploy is watched, is the project's business: the
# `release` hook in plans/runner.json answers two questions -
#   tag --platform <p> --log-file <f>      -> {tag, version, actionsUrl}   (null tag = nothing pushed)
#   status --tag <t> [--fallback-url <u>]  -> {finished, outcome, url}
# - and the runner keeps what is the same for every project: which commit ships and when
# (R6.4), the pending/wait policy (R6.2), the batch tag (R6.3), and the record in .state.json.

$script:DeployPollSeconds = 20

# Set when a release fails in a way that leaves the tag sequence in doubt. Everything after
# it is skipped rather than worked around: hand-crafting a tag past a failing script is how
# a half-shipped release becomes a mystery.
$script:ReleasingDisabled = $false

<#
.SYNOPSIS
    Asks the release hook one question and returns its JSON answer, or throws.
.DESCRIPTION
    Thrown rather than softened because every caller is already inside Get-PlanRelease's or
    the batch release's catch, where a fault becomes a recorded non-release - and a hook that
    exited 0 with no JSON has still not answered.
#>
function Invoke-ReleaseHook {
    param([string] $RepoRoot, [string[]] $HookArgs, [int] $TimeoutMinutes = 10)

    $result = Invoke-Hook -RepoRoot $RepoRoot -Command $script:Config.hooks.release.command `
        -HookArgs $HookArgs -TimeoutMinutes $TimeoutMinutes
    if ($result.exitCode -ne 0) {
        throw "release hook $($HookArgs[0]) failed (exit $($result.exitCode)): $($result.error)"
    }
    if ($null -eq $result.answer) { throw "release hook $($HookArgs[0]) answered with no JSON" }
    return $result.answer
}

function Get-DeployColour {
    param([string] $Outcome)

    switch ($Outcome) {
        'green' { return 'Green' }
        'red'   { return 'Red' }
        default { return 'Yellow' }
    }
}

# Untyped $Problem on purpose: [string] would turn the no-problem case into an empty string,
# and the ticket loop reading .state.json should see a null there, not "".
function New-ReleaseRecord {
    param($Problem = $null)

    return [ordered]@{
        tag        = $null
        version    = $null
        deploy     = 'not-released'
        actionsUrl = $null
        problem    = $Problem
    }
}

<#
.SYNOPSIS
    Asks the release hook to cut one patch release and reports what it pushed.
.DESCRIPTION
    The hook owns version discovery and the tag itself (R6.5: one sanctioned way to make a
    tag, and it is the project's). The runner only names the platform and where the hook may
    leave its transcript, and reads back the tag that actually shipped - null when nothing
    was pushed - rather than predicting one.
#>
function New-PatchRelease {
    param([string] $RepoRoot, [string] $Platform, [string] $LogFile)

    $answer = Invoke-ReleaseHook -RepoRoot $RepoRoot -TimeoutMinutes 10 `
        -HookArgs @('tag', '--platform', $Platform, '--log-file', $LogFile)
    return [pscustomobject]@{
        tag        = $answer.tag
        version    = $answer.version
        actionsUrl = $answer.actionsUrl
    }
}

<#
.SYNOPSIS
    One poll of the deploy: where the hook leaves the wait for this tag's build.
.DESCRIPTION
    A hook that fails to answer is reported as "not finished yet" rather than as a verdict.
    A dropped network moment must not be turned into a red deploy on a build that is running
    fine; if it never recovers the wait ends at its deadline and records a timeout, which is
    exactly what "we do not know" means here.
#>
function Get-DeployStatus {
    param([string] $RepoRoot, [string] $Tag, [string] $FallbackUrl)

    $hookArgs = @('status', '--tag', $Tag)
    if ($FallbackUrl) { $hookArgs += @('--fallback-url', $FallbackUrl) }

    try { return Invoke-ReleaseHook -RepoRoot $RepoRoot -HookArgs $hookArgs -TimeoutMinutes 5 }
    catch { return [pscustomobject]@{ finished = $false; outcome = 'timeout'; url = $FallbackUrl } }
}

<#
.SYNOPSIS
    Waits for this tag's build to conclude, bounded by -DeployTimeoutMinutes. Only reached
    under -WaitForDeploy; by default the run is handed over as a pending deploy.
#>
function Wait-ForDeploy {
    param([string] $RepoRoot, [string] $Tag, [string] $FallbackUrl)

    $deadline = (Get-Date).AddMinutes($DeployTimeoutMinutes)
    while ($true) {
        $status = Get-DeployStatus -RepoRoot $RepoRoot -Tag $Tag -FallbackUrl $FallbackUrl
        if ($status.finished -or (Get-Date) -ge $deadline) { return $status }
        Start-Sleep -Seconds $script:DeployPollSeconds
    }
}

<#
.SYNOPSIS
    Ships one verified plan: a patch web tag on its commit, handed over as a pending deploy.
.DESCRIPTION
    R6.4: this runs while the plan's commit is still HEAD. Tagging retroactively at the end
    of the queue would tag each plan's recorded commit and deploy a tree missing every plan
    that ran after it.

    R6.2: the build is not waited on. That wait cost a median of 6.3 minutes per shipped plan,
    serial with everything else, and bought nothing a later process cannot do: a record left
    `pending` in .state.json can be polled and settled by whatever the project runs between
    batches (Boardbash's ticket loop, for one). -WaitForDeploy asks for the verdict here
    instead, for a standalone run with nothing behind it.

    `pending` is only ever recorded for a tag that was actually pushed - there would be nothing
    to poll otherwise, and the ticket would be held open forever. A release that produces no tag
    is not retried and not worked around: it stays `not-released` and disables releasing for the
    rest of the run (including the batch tag), because the next patch number is no longer
    something this script can reason about unattended.
#>
function Publish-PlanRelease {
    param([string] $RepoRoot, [string] $LogDir, [string] $Slug, [string] $Stamp)

    if ($script:ReleasingDisabled) {
        return (New-ReleaseRecord -Problem 'releasing was disabled earlier in this run')
    }

    $platform = $script:Config.hooks.release.perPlanPlatform
    $logFile = Join-Path $LogDir "$Slug.release-$platform.$Stamp.txt"
    $tagged = New-PatchRelease -RepoRoot $RepoRoot -Platform $platform -LogFile $logFile
    if (-not $tagged.tag) {
        $script:ReleasingDisabled = $true
        $problem = "the release hook pushed no $platform tag - see $logFile"
        Write-Host "  !! $problem" -ForegroundColor Red
        Write-Host '     releasing is off for the rest of this run' -ForegroundColor Red
        return (New-ReleaseRecord -Problem $problem)
    }

    $record = New-ReleaseRecord
    $record.tag = $tagged.tag
    $record.version = $tagged.version
    $record.deploy = 'pending'
    $record.actionsUrl = $tagged.actionsUrl

    if (-not $WaitForDeploy) {
        Write-Host "  ++ pushed $($tagged.tag) - not waited on; the ticket loop settles it. $($tagged.actionsUrl)" -ForegroundColor DarkCyan
        return $record
    }

    Write-Host "  ++ pushed $($tagged.tag) - waiting up to $DeployTimeoutMinutes min for the deploy" -ForegroundColor DarkCyan
    $status = Wait-ForDeploy -RepoRoot $RepoRoot -Tag $tagged.tag -FallbackUrl $tagged.actionsUrl
    $record.deploy = $status.outcome
    $record.actionsUrl = $status.url
    return $record
}

<#
.SYNOPSIS
    Publish-PlanRelease, with any fault recorded as a non-release instead of thrown.
.DESCRIPTION
    The plan itself is already committed and verified by the time this runs. Letting a
    failed `gh` call or a missing tool end the run would throw away every plan still queued
    behind it, for a fault that has nothing to do with them.
#>
function Get-PlanRelease {
    param([string] $RepoRoot, [string] $LogDir, [string] $Slug, [string] $Stamp)

    try {
        return Publish-PlanRelease -RepoRoot $RepoRoot -LogDir $LogDir -Slug $Slug -Stamp $Stamp
    }
    catch {
        $script:ReleasingDisabled = $true
        $problem = "release failed: $($_.Exception.Message)"
        Write-Host "  !! $problem" -ForegroundColor Red
        return (New-ReleaseRecord -Problem $problem)
    }
}

<#
.SYNOPSIS
    R6.3: has the finished batch earned its one batch-platform tag? Only if something shipped.
#>
function Test-BatchReleaseOwed {
    param([object[]] $Releases)

    return @($Releases | Where-Object { $_.tag }).Count -gt 0
}

<#
.SYNOPSIS
    R6.3: one tag on the batch platform for the whole run, cut after the last plan.
.DESCRIPTION
    Per-plan releases on a store-reviewed platform would mean one submission per ticket. This
    tag is not waited on: such a build ends in a submission a human reviews anyway, and
    holding the queue's tickets unresolved for its duration buys nothing. A project whose
    release hook names no batch platform gets no batch tag.
#>
function Publish-BatchRelease {
    param([string] $RepoRoot, [object[]] $Releases, [string] $LogDir, [string] $Stamp)

    $platform = $script:Config.hooks.release.perBatchPlatform
    if (-not $platform) { return $null }

    if (-not (Test-BatchReleaseOwed -Releases $Releases)) {
        Write-Host "No plan shipped this run - no $platform release." -ForegroundColor DarkGray
        return $null
    }
    if ($script:ReleasingDisabled) {
        Write-Host "$platform release skipped - releasing was disabled earlier in this run." -ForegroundColor Red
        return (New-ReleaseRecord -Problem 'releasing was disabled earlier in this run')
    }

    $logFile = Join-Path $LogDir "batch.release-$platform.$Stamp.txt"
    $tagged = New-PatchRelease -RepoRoot $RepoRoot -Platform $platform -LogFile $logFile
    if (-not $tagged.tag) {
        $problem = "the release hook pushed no $platform tag - see $logFile"
        Write-Host "  !! $problem" -ForegroundColor Red
        return (New-ReleaseRecord -Problem $problem)
    }

    Write-Host "$platform release $($tagged.tag) pushed - not waited on. $($tagged.actionsUrl)" -ForegroundColor Green
    $record = New-ReleaseRecord
    $record.tag = $tagged.tag
    $record.version = $tagged.version
    $record.actionsUrl = $tagged.actionsUrl
    return $record
}

<#
.SYNOPSIS
    -ReleaseEachPlan is only honoured for a project that declares a release hook, and its
    program has to resolve now - not an hour into the first plan.
#>
function Assert-ReleaseToolsPresent {
    param([string] $RepoRoot)

    $hook = $script:Config.hooks.release
    if (-not $hook) {
        throw '-ReleaseEachPlan needs hooks.release in plans/runner.json - this project declares no release hook.'
    }
    $null = Resolve-HookProgram -RepoRoot $RepoRoot -Program $hook.command[0]
}

# --------------------------------------------------------------------------
# Ticket demo
# --------------------------------------------------------------------------

# A plan that changed how something looks is asked to photograph it (rule 4 of the preamble),
# and leaves the shots in a gitignored directory of its own. This is the half of that the
# agent cannot do: the ticket's author should see pictures of work that *shipped*, and only
# the runner knows whether the plan survived verification. So the demo waits here, and a plan
# that failed has its shots discarded rather than posted.
#
# Deliberately outside -ReleaseEachPlan. Releasing is about tags and CI and needs no Linear
# credentials (see release-cli.mjs); this is the one thing the runner does that does need
# them, and only ever for a plan that both captured something and names a ticket - which is
# why it costs a queue of ordinary plans nothing and needs no switch to turn it on.

<#
.SYNOPSIS
    Runs one ticket-demo-cli.mjs command over a plan. Reports rather than throws.
.DESCRIPTION
    Nothing here may fail a plan. By the time this runs the work is committed, merged and
    possibly released; a Linear outage, a missing credential or a malformed manifest is a
    line on the console, not a verdict on an hour of verified work.
#>
function Invoke-TicketDemoCli {
    param([string] $RepoRoot, [string] $Command, [string] $PlanPath, [string] $Version)

    # The `demo` hook: `post|clear --plan <path> [--version <v>]`. No hook, no demo.
    $hook = $script:Config.hooks.demo
    if (-not $hook) { return $null }

    $hookArgs = @($Command, '--plan', $PlanPath)
    if ($Version) { $hookArgs += @('--version', $Version) }

    try {
        $result = Invoke-Hook -RepoRoot $RepoRoot -Command $hook -HookArgs $hookArgs -TimeoutMinutes 10
        if ($result.exitCode -ne 0) {
            Write-Host "  !! ticket demo ($Command) failed (exit $($result.exitCode)): $($result.error)" -ForegroundColor Yellow
            return $null
        }
        return $result.answer
    }
    catch {
        Write-Host "  !! ticket demo ($Command) failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

<#
.SYNOPSIS
    Puts a verified plan's showcase screenshots on the ticket it was written from.
#>
function Publish-PlanDemo {
    param([string] $RepoRoot, [string] $PlanPath, [string] $Version)

    if ($SkipTicketDemo) { return }

    $result = Invoke-TicketDemoCli -RepoRoot $RepoRoot -Command 'post' -PlanPath $PlanPath -Version $Version
    # Silent on the two ordinary answers - no demo, no ticket - which is most of the queue.
    if ($result -and $result.posted) {
        Write-Host "  ++ demo: $($result.shots) screenshot(s) posted to $($result.issue)" -ForegroundColor Green
    }
}

<#
.SYNOPSIS
    Throws away the screenshots of a plan that never made it, so nothing can post them later.
#>
function Clear-PlanDemo {
    param([string] $RepoRoot, [string] $PlanPath)

    if ($SkipTicketDemo) { return }
    Invoke-TicketDemoCli -RepoRoot $RepoRoot -Command 'clear' -PlanPath $PlanPath | Out-Null
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

$repoRoot = Get-RepoRoot

# The target repo's configuration, read before anything else: every gate, path and server
# below comes from it. Script-scoped like $script:PlanEffort - it follows the run, and
# threading it through every function that names a gate would be all noise.
$script:Config = Get-RunnerConfig -RepoRoot $repoRoot
$script:PackagesDirAbs = Join-Path $repoRoot $script:Config.packagesDir
$script:PackagesPattern = '^' + [regex]::Escape($script:Config.packagesDir) + '/([^/]+)/'

# Said out loud, not thrown: a repo with no packages is legitimate, but a typo here would
# otherwise merge every plan of an eight-hour run with no test verification and no sign of it.
if (-not (Test-Path $script:PackagesDirAbs)) {
    Write-Host "  !! packagesDir '$($script:Config.packagesDir)' does not exist under the repo root ($repoRoot)" -ForegroundColor Yellow
    Write-Host "  !! no package tests will be verified for any plan in this run" -ForegroundColor Yellow
    Write-Host "  !! set packagesDir in plans/runner.json to the workspace directory that holds the packages" -ForegroundColor Yellow
}

if ($ReleaseEachPlan) { Assert-ReleaseToolsPresent -RepoRoot $repoRoot }
if (-not $PlansDir) { $PlansDir = Join-Path $repoRoot 'plans' }
$PlansDir = (Resolve-Path $PlansDir).Path

# The plans directory as git spells it: repo-relative and forward-slashed. Used wherever a
# plan file or report is named in a git pathspec, which used to hardcode 'plans/' and so
# silently ignored -PlansDir.
$script:PlansRel = ($PlansDir -replace '\\', '/')
if ($PlansDir.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $script:PlansRel = ($PlansDir.Substring($repoRoot.Length).TrimStart('\', '/') -replace '\\', '/')
}

# The standing instructions: the tool's spine plus this project's plans/_project.md, or the
# project's own plans/_preamble.md whole where it still has one. Composed once per run in
# scripts/preamble.mjs, where the rules are tested; a fault stops the run before any plan
# inherits a prompt composed wrong.
$composed = Get-Preamble -RepoRoot $repoRoot
$preamble = $composed.text
if ($composed.source -ne 'plans/_preamble.md') {
    Write-Host "Preamble: $($composed.source)" -ForegroundColor DarkGray
}

$logDir    = Join-Path $PlansDir 'logs'
$reportDir = Join-Path $PlansDir 'reports'
foreach ($dir in @($logDir, $reportDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
}

# The path handed to the agent: repo-relative and forward-slashed when the plans
# directory lives inside the repo, absolute otherwise.
$reportRelDir = ($reportDir -replace '\\', '/')
if ($reportDir.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $reportRelDir = ($reportDir.Substring($repoRoot.Length).TrimStart('\', '/') -replace '\\', '/')
}

$statePath = Join-Path $PlansDir '.state.json'
$state = Read-RunState $statePath
$settledNames = Get-SettledPlanNames -RepoRoot $repoRoot -StatePath $statePath

$plans = Get-PlanFiles -Directory $PlansDir -Filter $Only
if ($plans.Count -eq 0) { throw "No plan files matched in $PlansDir (expected names like 01-do-a-thing.md)." }

$queue = @($plans | Where-Object {
    $entry = $state[$_.Name]
    $Force -or -not (Test-PlanSettled -Entry $entry -Name $_.Name -Settled $settledNames)
})

$baseBranch = Get-CurrentBranch -RepoRoot $repoRoot

Write-Host ''
Write-Host "Plan runner  |  $($queue.Count) of $($plans.Count) plan(s) queued  |  merging into $baseBranch" -ForegroundColor Cyan
foreach ($plan in $plans) {
    $entry = $state[$plan.Name]
    $mark = '  '
    if ($entry) { $mark = switch ($entry.status) { 'completed' { 'ok' } 'wont-do' { 'xx' } 'skipped' { '--' } default { '!!' } } }
    $queued = ''
    if ($queue -contains $plan) { $queued = '  <- queued' }
    Write-Host ("  [{0}] {1}{2}" -f $mark, $plan.Name, $queued)
}

# Otherwise a clone with no .state.json prints a list of unmarked plans and queues none of
# them, with nothing on screen saying why.
$settledByGit = @($plans | Where-Object {
    -not (Test-PlanStatusSettled -Entry $state[$_.Name]) -and $settledNames.Contains($_.Name)
})
if ($settledByGit.Count -gt 0) {
    Write-Host ("{0} plan(s) count as done because their file is committed, with no .state.json entry saying so." -f $settledByGit.Count) -ForegroundColor DarkGray
}

Write-Host "Each plan is implemented on '$BranchPrefix<plan file>' and fast-forwarded into '$baseBranch' once it verifies." -ForegroundColor DarkGray
Write-Host ''

if ($queue.Count -eq 0) { Write-Host 'Nothing to do.' -ForegroundColor Green; return }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# The remote a plan's branch is pushed at, once the queue-start sync has found one. Empty until
# then, and empty for good under -DryRun, -SkipSync, or a base branch that tracks nothing.
$syncRemote = ''

# The dev servers this run started, name -> @{server; log; process}, and so the only ones it
# may stop or restart. A server that was already listening is adopted instead and never appears
# here; nor does anything under -DryRun or -SkipDevServers.
$devServers = @{}
$appAvailable = $false
$appServers = @()
$appReason = 'the runner was started with -SkipDevServers'
if ($DryRun) { $appReason = 'this is a dry run - nothing is executed' }

if (-not $DryRun) {
    Assert-BaseBranchUsable -RepoRoot $repoRoot -Base $baseBranch

    # Anything dirty under plans/ is the runner's own paperwork and rides along - the queued
    # plan files most of all, each committed by the plan that implements it - and so does
    # anything under scripts/, which is the runner's own tooling. Everything else stops the run
    # dead: this machine is also the development machine.
    $atStart = Get-TreeAssessment -RepoRoot $repoRoot
    if (-not $atStart.clean) {
        throw "Working tree is dirty outside plans/ and scripts/. Commit or stash first.`n$($atStart.blocking -join "`n")"
    }
    if ($atStart.carried.Count -gt 0) {
        Write-Host "Carrying $($atStart.carried.Count) uncommitted path(s) under plans/ and scripts/ - each queued plan is committed by its own run." -ForegroundColor DarkGray
    }

    # Before the pre-flight, and not only for tidiness. The pre-flight measures the quality and
    # visual baselines from the base tree, and measuring a stale one hands every plan in the run
    # a baseline that does not describe the tree it branches off - the ratchets would then blame
    # plans for reds they inherited from a commit this machine had not fetched yet.
    $sync = Sync-BaseBranch -RepoRoot $repoRoot -Base $baseBranch
    if ($sync.problems.Count -gt 0) {
        throw ("Cannot start the queue:`n  " + ($sync.problems -join "`n  ") +
               "`nReconcile '$baseBranch' with its remote by hand, or re-run with -SkipSync to work locally.")
    }
    $syncRemote = $sync.remote
    if ($sync.state -eq 'no-upstream') {
        Write-Host "'$baseBranch' tracks no remote - plans are integrated on this machine only." -ForegroundColor DarkGray
    }

    # The app each plan checks its work against, brought up before the pre-flight rather than
    # after it: the pre-flight is the longest thing in the run, and Parcel's cold build gets to
    # happen underneath it instead of on the first plan's clock.
    if (-not $SkipDevServers) {
        Write-Host ''
        Write-Host 'Dev servers  |  the running app rule 4 of the preamble sends each plan to' -ForegroundColor Cyan
        $brought = Start-DevServers -RepoRoot $repoRoot -LogDir $logDir -Stamp $stamp
        $devServers = $brought.owned
        $appServers = @($brought.servers)
        if ($brought.problems.Count -gt 0) {
            # Not fatal. A batch of backend plans needs no browser at all, and a frontend plan
            # still has the Playwright harness, which needs neither server. What a plan must not
            # do is spend its session on a page that will never answer - so it is told instead.
            $appReason = ($brought.problems -join '; ')
            Write-Host "  !! $appReason" -ForegroundColor Yellow
            Write-Host '     running the queue anyway - every plan is told to verify in the Playwright harness instead' -ForegroundColor Yellow
        }
        else {
            $appAvailable = $true
            Write-Host '  the app is up, and stays up for the whole batch' -ForegroundColor Green
        }
    }
}

$appStatus = Get-AppStatusLine -Available $appAvailable -Reason $appReason -Servers $appServers -RepoRoot $repoRoot

$index = 0
$needsReview = @()
$halted = $null
$planReleases = @()

# Plan name -> the earlier part of its ticket that failed. Filled in as failures happen, so a
# plan reaches it only if something ahead of it in this same run went red (R4.9).
$skip = @{}
$skipped = @()

# Everything from here to the last plan runs inside a finally that stops the dev servers this
# run started. A pre-flight that refuses the base branch, or a fault in the middle of the queue,
# would otherwise orphan two npm trees against a repository nobody is working in any more.
try {

    # After the tree check, so a dirty tree is reported in a second rather than ten minutes, and
    # before the first plan branches - the base branch is what it measures.
    if (-not $DryRun -and -not $SkipPreflight -and -not $SkipVerify) {
        # After the sync, so the commit named is the one origin holds and every plan branches off.
        Invoke-QueuePreflight -RepoRoot $repoRoot -PlansDir $PlansDir -LogDir $logDir -Stamp $stamp `
            -BaseCommit (Get-GitLine @('-C', $repoRoot, 'rev-parse', 'HEAD'))
    }

    foreach ($plan in $queue) {
        $index++
        $slug = [System.IO.Path]::GetFileNameWithoutExtension($plan.Name)
        $reportPath = "$reportRelDir/$slug.md"

        if ($skip.ContainsKey($plan.Name)) {
            Write-PlanHeader -Index $index -Total $queue.Count -Name $plan.Name
            Add-SkippedPlan -State $state -StatePath $statePath -PlanName $plan.Name -FailedPart $skip[$plan.Name]
            $skipped += $plan.Name
            continue
        }

        Write-PlanHeader -Index $index -Total $queue.Count -Name $plan.Name

        # Read before anything is branched, written or spent: this is where the plan says how
        # hard its session should think, and a header that cannot be honoured is cheapest to
        # find out about here.
        $frontMatter = Get-PlanFrontMatter -RepoRoot $repoRoot -PlanPath $plan.FullName
        if ($frontMatter.problem) {
            Write-Host "  !! $($frontMatter.problem)" -ForegroundColor Red
        }
        else {
            $script:PlanEffort = $frontMatter.effort
            $source = if ($frontMatter.declared) { 'declared' } else { 'default' }
            Write-Host "  ++ $Model at $($frontMatter.effort) effort ($source)" -ForegroundColor DarkGray
        }

        $promptFile = Join-Path $logDir "$slug.$stamp.prompt.txt"
        $logFile    = Join-Path $logDir "$slug.$stamp.jsonl"
        $errorFile  = Join-Path $logDir "$slug.$stamp.stderr.txt"

        if (-not $frontMatter.problem) {
            # The body, not the file: the front matter is the runner's setting and has already
            # been taken off the top, so what reaches the session is the plan and nothing else.
            $prompt = New-PlanPrompt -Preamble $preamble -Plan $plan -Body $frontMatter.body `
                -ReportPath $reportPath -Index $index -Total $queue.Count -AppStatus $appStatus
            Set-Content -Path $promptFile -Value $prompt -Encoding UTF8
        }

        if ($DryRun) {
            if ($frontMatter.problem) {
                Write-Host "  (dry run) this plan would fail on its header, before any session started" -ForegroundColor Yellow
            }
            else {
                Write-Host "  (dry run) prompt written to $promptFile  [$($prompt.Length) chars]" -ForegroundColor Yellow
            }
            if ($ReleaseEachPlan) {
                $deployPlan = 'and record its deploy as pending for the ticket loop to settle'
                if ($WaitForDeploy) { $deployPlan = "then wait up to $DeployTimeoutMinutes min for its deploy" }
                Write-Host "  (dry run) would push a patch $($script:Config.hooks.release.perPlanPlatform) tag once verified, $deployPlan" -ForegroundColor Yellow
            }
            continue
        }

        $started = Get-Date
        if ($frontMatter.problem) {
            # No branch, no session, no spend. `claude --effort hgih` only warns and runs at
            # its own default, so a typo that reached the CLI would cost the whole plan at an
            # effort somebody deliberately chose against - and nothing afterwards would say so.
            $run = [pscustomobject]@{ branch = $null; commit = $null; problems = @($frontMatter.problem) }
        }
        else {
            $run = Invoke-PlanOnBranch -Plan $plan -Slug $slug -RepoRoot $repoRoot -Base $baseBranch `
                -PromptFile $promptFile -LogFile $logFile -ErrorFile $errorFile `
                -LogDir $logDir -Stamp $stamp
        }
        $problems = @($run.problems)

        $status = 'completed'
        if ($problems.Count -gt 0) { $status = 'needs-review' }

        $entry = [ordered]@{
            status     = $status
            commit     = $run.commit
            branch     = $run.branch
            # What it actually ran at, not what the file said - so a plan that failed can be
            # retried at a higher level knowing which one it already had.
            effort     = $frontMatter.effort
            problems   = $problems
            finishedAt = (Get-Date).ToString('o')
            elapsedMin = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
            log        = (Split-Path $logFile -Leaf)
        }
        $state[$plan.Name] = $entry
        # Written before the release so a run killed mid-deploy still records the finished plan.
        Write-RunState -Path $statePath -State $state

        # Whatever the outcome. The preamble tells each plan to close its own test players and a
        # plan that died mid-session could not - and a window left open holds the WebSocket
        # session for its uid, so the next plan launching that player is displaced by it.
        if (-not $SkipDevServers) { Close-TestPlayers -RepoRoot $repoRoot }

        if ($status -eq 'completed') {
            Write-Host "  OK  committed $($run.commit.Substring(0,8)) and merged into $baseBranch" -ForegroundColor Green

            # Before the next plan branches: what this one merged may be invisible to the running
            # Parcel, and the next plan would then check its work against a mixed old/new bundle.
            if (-not $SkipDevServers) {
                Restart-StaleFrontend -RepoRoot $repoRoot -Commit $run.commit -Owned $devServers
            }

            $shippedVersion = $null

            # R6.1/R6.4: only a verified plan ships, and it ships now, while it is still HEAD.
            if ($ReleaseEachPlan) {
                $release = Get-PlanRelease -RepoRoot $repoRoot -LogDir $logDir -Slug $slug -Stamp $stamp
                $entry['release'] = $release
                Write-RunState -Path $statePath -State $state
                if ($release.tag) {
                    $planReleases += $release
                    $shippedVersion = $release.version
                    Write-Host "  ++ $($release.tag) deploy: $($release.deploy)  $($release.actionsUrl)" `
                        -ForegroundColor (Get-DeployColour $release.deploy)
                }
            }

            # After the release, so the comment can name the version the pictures are of. A
            # plan that shipped nothing still shows its work; it just says so.
            Publish-PlanDemo -RepoRoot $repoRoot -PlanPath $plan.FullName -Version $shippedVersion
        }
        else {
            Write-Host "  FAILED verification:" -ForegroundColor Red
            foreach ($problem in $problems) { Write-Host "        - $problem" -ForegroundColor Red }
            Write-Host "        log:    $logFile" -ForegroundColor Red
            Write-Host "        report: $reportPath" -ForegroundColor Red
            if ($run.branch) { Write-Host "        branch: $($run.branch)" -ForegroundColor Red }

            # Whatever this plan photographed is a demo of work that never landed. Discarded
            # here rather than left to age out, so a retry of the same slug cannot inherit it.
            Clear-PlanDemo -RepoRoot $repoRoot -PlanPath $plan.FullName

            # The next plan must start on the base branch, clean, or this failure cascades into
            # the rest of the queue.
            $tidied = Reset-AfterFailedPlan -RepoRoot $repoRoot -Base $baseBranch -Branch $run.branch `
                -PlanName $plan.Name -Slug $slug -Remote $syncRemote
            foreach ($action in $tidied) {
                Write-Host "        tidy:   $action" -ForegroundColor DarkYellow
            }

            # R4.9: the later parts of this plan's ticket would build on work that never landed.
            $siblings = @(Get-SiblingPlans -RepoRoot $repoRoot -PlansDirectory $PlansDir -PlanName $plan.Name)
            foreach ($sibling in $siblings) { $skip[$sibling] = $plan.Name }
            if ($siblings.Count -gt 0) {
                Write-Host "        parts:  $($siblings -join ', ') will not run - later part(s) of the same ticket" -ForegroundColor DarkYellow
            }

            $needsReview += $plan.Name
            if ($StopOnFailure) {
                $halted = $plan.Name
                break
            }
        }
    }
}
finally {
    if ($devServers.Count -gt 0) {
        Write-Host ''
        Stop-DevServers -Owned $devServers
    }
}

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------

Write-Host ''
if ($DryRun) {
    if ($ReleaseEachPlan -and $script:Config.hooks.release.perBatchPlatform) {
        Write-Host "Dry run: the batch would end with one patch $($script:Config.hooks.release.perBatchPlatform) tag covering every plan that shipped." -ForegroundColor Yellow
    }
    Write-Host 'Dry run complete - nothing was executed.' -ForegroundColor Yellow
    return
}

# R6.3: after the last plan, never per plan. Recorded against the run rather than any one
# plan, under a key no plan file can collide with - every plan name ends in .md.
if ($ReleaseEachPlan) {
    try { $batchRelease = Publish-BatchRelease -RepoRoot $repoRoot -Releases $planReleases -LogDir $logDir -Stamp $stamp }
    catch {
        Write-Host "Batch release failed: $($_.Exception.Message)" -ForegroundColor Red
        $batchRelease = New-ReleaseRecord -Problem "batch release failed: $($_.Exception.Message)"
    }

    $state['_run'] = [ordered]@{
        stamp        = $stamp
        finishedAt   = (Get-Date).ToString('o')
        batchRelease = $batchRelease
    }
    Write-RunState -Path $statePath -State $state
    Write-Host ''
}

Write-Host ("=" * 78) -ForegroundColor Cyan
foreach ($plan in $queue) {
    $entry = $state[$plan.Name]
    if (-not $entry) {
        Write-Host ("  --  {0}  (not reached)" -f $plan.Name) -ForegroundColor DarkGray
    }
    elseif ($entry.status -eq 'completed') {
        $line = "  ok  {0}  {1}" -f $plan.Name, $entry.commit.Substring(0, 8)
        if ($entry.release -and $entry.release.tag) {
            $line += "  {0} {1}" -f $entry.release.tag, $entry.release.deploy
        }
        Write-Host $line -ForegroundColor Green
    }
    elseif ($entry.status -eq 'skipped') {
        Write-Host ("  --  {0}  {1}" -f $plan.Name, ($entry.problems -join '; ')) -ForegroundColor DarkYellow
    }
    else {
        Write-Host ("  !!  {0}  {1}" -f $plan.Name, ($entry.problems -join '; ')) -ForegroundColor Red
    }
}
Write-Host ("=" * 78) -ForegroundColor Cyan

if ($halted) {
    Write-Host "Halted at '$halted' (-StopOnFailure). Re-run to continue; finished plans are skipped." -ForegroundColor Red
    exit 1
}

if ($skipped.Count -gt 0) {
    Write-Host "$($skipped.Count) plan(s) never ran - each is a later part of a ticket whose earlier part failed:" -ForegroundColor DarkYellow
    foreach ($name in $skipped) { Write-Host "  - $name  (after $($skip[$name]))" -ForegroundColor DarkYellow }
    Write-Host "Nothing is wrong with them. Fix the part that failed and re-run; they are still queued." -ForegroundColor DarkYellow
}

if ($needsReview.Count -gt 0) {
    Write-Host "Queue finished. $($needsReview.Count) plan(s) need review:" -ForegroundColor Yellow
    foreach ($name in $needsReview) { Write-Host "  - $name" -ForegroundColor Yellow }
    Write-Host "Read their reports under $($script:PlansRel)/reports/, then re-run to retry them." -ForegroundColor Yellow
    exit 1
}

Write-Host 'Plan queue finished - every plan completed.' -ForegroundColor Green
