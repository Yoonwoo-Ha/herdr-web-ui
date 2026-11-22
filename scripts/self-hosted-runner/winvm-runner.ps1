# winvm-runner.ps1: the VM side of winvm-runner.sh, run in devswha's desktop session through Invoke-InSession.
# Registers one ephemeral runner for -Repository from the actions/runner package winvm-runner.sh copied beside this
# file, with the registration token it left in .\token (read and deleted here, and handed to config.cmd in
# ACTIONS_RUNNER_INPUT_TOKEN, which the runner reads and clears, never in a command line), and runs it
# until its one job ends. The job-started hook beside this file guards every job before its first step.
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$Repository = 'devswha/ovis',
    [string]$Name = 'ovis-winvm',
    [string]$Labels = 'self-hosted,self-hosted-ovis-win'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = 'C:\actions-runners\ovis-win'
$tokenFile = Join-Path $here 'token'
$token = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
Remove-Item -LiteralPath $tokenFile -Force
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
New-Item -ItemType Directory -Force -Path $root | Out-Null
tar -xf (Join-Path $here "actions-runner-win-x64-$Version.zip") -C $root
if ($LASTEXITCODE) { throw "tar exited $LASTEXITCODE" }
# the runner reads .env into every job's environment and its own: the hook runs before each job's first step
Set-Content -LiteralPath (Join-Path $root '.env') -Value "ACTIONS_RUNNER_HOOK_JOB_STARTED=$(Join-Path $here 'winvm-job-started.ps1')"
Set-Location -LiteralPath $root
# --no-default-labels: only a job that names self-hosted-ovis-win comes here, never one asking for any Windows runner
$env:ACTIONS_RUNNER_INPUT_TOKEN = $token
Remove-Variable token
& .\config.cmd --unattended --url "https://github.com/$Repository" --name $Name --no-default-labels `
    --labels $Labels --work 'C:\w' --ephemeral --disableupdate --replace
$code = $LASTEXITCODE
Remove-Item Env:\ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue
if ($code) { throw "config.cmd exited $code" }
& .\run.cmd
exit $LASTEXITCODE
