#Requires -Version 5.1
<#
.SYNOPSIS
    Boardbash's release hook for the plan runner: cuts a patch tag through
    scripts/tag-release.ps1 and reads a deploy's state off GitHub Actions through `gh`.

.DESCRIPTION
    Implements the runner's `hooks.release` contract (agentic-loop README):

      tag --platform <web|android> --log-file <path>   -> {"tag","version","actionsUrl"}
      status --tag <tag> [--fallback-url <url>]        -> {"finished","outcome","url"}

    Runs from the repo root, which is where the runner starts every hook. Everything here
    used to live inside run-plans.ps1 and is exactly as Boardbash-shaped as it looks: the
    three interactive answers tag-release.ps1 wants, the name of the deploy workflow, and
    scripts/linear/release-cli.mjs doing the parsing. A copy of this file belongs at
    scripts/release-hook.ps1 in the Boardbash repo, named from plans/runner.json.

    R6.5: tag-release.ps1 is the only sanctioned way to make a tag - it is the single source
    of truth for version discovery, and a hand-rolled `git tag` would drift from it. It asks
    three questions in order (bump, platform, confirm), so the answers are fed as three lines
    on stdin, written as ASCII: a UTF-8 BOM would arrive as part of the first answer and fail
    its switch. The tag is read back out of the transcript rather than predicted, because the
    script recomputes the version against origin and its value is the one that shipped.
#>

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# The workflow whose run is the deploy. A tag push also starts the version-check workflow,
# which finishes in seconds and would be read as a green deploy before the build even began.
$DeployWorkflow = 'build-boardbash.yml'
$PlatformAnswer = @{ web = '1'; android = '2' }
$ReleaseCli = 'scripts/linear/release-cli.mjs'
$TagRelease = 'scripts/tag-release.ps1'

<#
.SYNOPSIS
    `command --name value ...` as the runner spells hook arguments, into a hashtable.
#>
function Read-HookArgs {
    param([string[]] $Raw)

    $parsed = @{ command = '' }
    if ($Raw.Count -gt 0) { $parsed.command = $Raw[0] }
    for ($i = 1; $i -lt $Raw.Count; $i += 2) {
        $name = $Raw[$i] -replace '^--', ''
        $parsed[$name] = if ($i + 1 -lt $Raw.Count) { $Raw[$i + 1] } else { '' }
    }
    return $parsed
}

function New-TempPath {
    param([string] $Extension)

    return Join-Path ([System.IO.Path]::GetTempPath()) ('release-hook-' + [guid]::NewGuid().ToString('n') + $Extension)
}

<#
.SYNOPSIS
    Runs a child with both streams on disk and returns its exit code.
.DESCRIPTION
    Start-Process because a native command's stderr reaching PowerShell's error stream is a
    terminating error under $ErrorActionPreference = 'Stop', and both `gh` and
    tag-release.ps1 write there routinely.
#>
function Invoke-Captured {
    param([string] $FilePath, [string[]] $Arguments, [string] $StdOutFile, [string] $StdErrFile,
          [string] $StdInFile, [int] $TimeoutMinutes = 10)

    $startArgs = @{
        FilePath = $FilePath; ArgumentList = $Arguments
        RedirectStandardOutput = $StdOutFile; RedirectStandardError = $StdErrFile
        NoNewWindow = $true; PassThru = $true
    }
    if ($StdInFile) { $startArgs.RedirectStandardInput = $StdInFile }

    $proc = Start-Process @startArgs
    try { $null = $proc.Handle } catch { }
    if (-not $proc.WaitForExit($TimeoutMinutes * 60 * 1000)) {
        & taskkill.exe '/PID' $proc.Id '/T' '/F' 2>$null | Out-Null
        return 124
    }
    if ($null -eq $proc.ExitCode) { return 0 }
    return $proc.ExitCode
}

<#
.SYNOPSIS
    Asks release-cli.mjs one question and passes its JSON answer straight through to stdout.
#>
function Write-ReleaseCliAnswer {
    param([string[]] $CliArgs)

    $stdout = New-TempPath '.json'
    $stderr = New-TempPath '.err.txt'
    try {
        $code = Invoke-Captured -FilePath 'node' -Arguments (@($ReleaseCli) + $CliArgs) `
            -StdOutFile $stdout -StdErrFile $stderr -TimeoutMinutes 5
        if ($code -ne 0) {
            [Console]::Error.WriteLine("release-cli $($CliArgs[0]) failed (exit $code): " + (Get-Content -Path $stderr -Raw))
            exit 1
        }
        [Console]::Out.Write((Get-Content -Path $stdout -Raw))
    }
    finally { Remove-Item -Path $stdout, $stderr -Force -ErrorAction SilentlyContinue }
}

function Invoke-TagCommand {
    param([hashtable] $HookArgs)

    $platform = $HookArgs['platform']
    if (-not $PlatformAnswer.ContainsKey($platform)) {
        [Console]::Error.WriteLine("unknown platform '$platform' - this hook tags web or android")
        exit 1
    }
    $logFile = $HookArgs['log-file']
    if (-not $logFile) { $logFile = New-TempPath '.tag.txt' }

    $answerFile = New-TempPath '.answers.txt'
    try {
        Set-Content -Path $answerFile -Value "1`n$($PlatformAnswer[$platform])`ny" -Encoding ASCII
        $null = Invoke-Captured -FilePath 'powershell.exe' `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $TagRelease) `
            -StdOutFile $logFile -StdErrFile "$logFile.stderr.txt" -StdInFile $answerFile -TimeoutMinutes 10
    }
    finally { Remove-Item -Path $answerFile -Force -ErrorAction SilentlyContinue }

    # The transcript says what shipped, whatever the exit code did; a null tag is the answer
    # "nothing was pushed", which the runner treats as a disabling failure of its own accord.
    Write-ReleaseCliAnswer -CliArgs @('parse', '--output-file', $logFile)
}

function Invoke-StatusCommand {
    param([hashtable] $HookArgs)

    $tag = $HookArgs['tag']
    $fallback = $HookArgs['fallback-url']
    $runsFile = New-TempPath '.runs.json'
    $stderr = New-TempPath '.gh-err.txt'
    try {
        $gh = Get-Command gh -ErrorAction SilentlyContinue
        $code = 1
        if ($gh) {
            $code = Invoke-Captured -FilePath $gh.Source -Arguments @(
                'run', 'list', '--workflow', $DeployWorkflow, '--limit', '20',
                '--json', 'databaseId,headBranch,event,status,conclusion,url'
            ) -StdOutFile $runsFile -StdErrFile $stderr -TimeoutMinutes 5
        }

        # A failing `gh` is "not finished yet", never a verdict: a dropped network moment must
        # not become a red deploy on a build that is running fine.
        if ($code -ne 0) {
            [Console]::Out.Write((@{ finished = $false; outcome = 'timeout'; url = $fallback } | ConvertTo-Json -Compress))
            return
        }

        $cliArgs = @('status', '--runs-file', $runsFile, '--tag', $tag)
        if ($fallback) { $cliArgs += @('--fallback-url', $fallback) }
        Write-ReleaseCliAnswer -CliArgs $cliArgs
    }
    finally { Remove-Item -Path $runsFile, $stderr -Force -ErrorAction SilentlyContinue }
}

$hookArgs = Read-HookArgs -Raw @($args)
switch ($hookArgs.command) {
    'tag'    { Invoke-TagCommand -HookArgs $hookArgs }
    'status' { Invoke-StatusCommand -HookArgs $hookArgs }
    default {
        [Console]::Error.WriteLine('usage: release-hook.ps1 tag --platform <web|android> --log-file <path> | status --tag <tag> [--fallback-url <url>]')
        exit 2
    }
}
