# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$originalPath = $env:PATH
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserProfile = $env:USERPROFILE
# The cases below install from source (Bun and herdr's plugin checkout); the release's binary has its own cases,
# against a local release folder, near the end
$originalFromSource = $env:OVIS_FROM_SOURCE
$env:OVIS_FROM_SOURCE = '1'
$state = @{ installed = $false; installs = 0; uninstalls = 0; ref = ''; running = $true; started = $false; failInstall = $false; bunVersion = '1.4.2'; failBun = $false; windowsRelease = $true; refId = 'devswha.ovis'; installedId = ''; manifestBlocked = $false; startedLegacy = $false; legacyInstalled = $false; stopStateDirs = @(); handStarted = $false; pluginSource = ''; launcherCalls = @(); failBuild = $false; cutBuild = $null; annotated = @(); moved = @(); offline = $false }
$global:herdrInstallOpened = @()
# gh is a stand-in .cmd, first on PATH: the installer runs gh as a process, and no real star is read or given.
# mode.txt beside it is what it answers: starred, not, refuses (the star itself), upstream, signed-out, hangs or
# lingering (it answers, and leaves a child holding its output; child.txt gets that child's PID).
$star = @{ asked = 0; answer = ''; failAsk = $false }
$ghStandIn = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-gh-$PID"
# A real directory: the installer reads the installed copy to tell whether it can run on Windows.
$pluginRoot = Join-Path ([IO.Path]::GetTempPath()) "herdr plugin with spaces $PID"
$launcher = Join-Path $pluginRoot 'scripts\plugin.ps1'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Start-Process { $global:herdrInstallOpened += ($args -join ' ') }

# Tool boundaries only: no downloads, installed plugins, processes or user settings are changed.
# The commit a ref names: a commit id itself, or a stand-in id for a branch or tag
function Get-TestCommit {
    param([string]$Ref)
    if ($Ref -match '^[0-9a-f]{7,40}$') { return $Ref.PadRight(40, '0') }
    -join ([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Ref)) | ForEach-Object { $_.ToString('x2') })
}
function git {
    $global:LASTEXITCODE = 0
    # herdr's checkout, detached at the commit of the ref it was installed at, which a prefix of it names there
    if ($args[0] -eq '-C' -and $args[2] -eq 'rev-parse') {
        $head = Get-TestCommit $state.ref
        if ($args[-1] -eq 'HEAD') { return $head }
        $id = $args[-1] -replace '\^\{commit\}$' -replace '^--disambiguate='
        if ($args[-1] -like '--disambiguate=*' -and -not $head.StartsWith($id)) { return }
        if ($id -match '^[0-9a-f]{4,40}$' -and $head.StartsWith($id)) { return $head }
        $global:LASTEXITCODE = 1; return
    }
    # GitHub's refs by name: a branch at its tip ($state.moved: a commit after the one installed), an annotated tag as its
    # tag object and, asked for <name>^{}, its commit; nothing for a commit id, and exit 128 offline
    if ($args[0] -eq 'ls-remote' -and $args[1] -ne '--tags') {
        if ($state.offline) { $global:LASTEXITCODE = 128; return }
        foreach ($pattern in $args[2..($args.Count - 1)] | Where-Object { $_ -ne '--' }) {
            $name = $pattern -replace '\^\{\}$'
            if ($state.annotated -contains $name) {
                if ($pattern -ne $name) { "$(Get-TestCommit $name)`trefs/tags/$name^{}" } else { "$(Get-TestCommit "tag object $name")`trefs/tags/$name" }
            } elseif ($pattern -eq $name -and $name -notmatch '^[0-9a-f]{4,40}$') {
                "$(Get-TestCommit $(if ($state.moved -contains $name) { "$name, moved" } else { $name }))`trefs/heads/$name"
            }
        }
        return
    }
    "aaa`trefs/tags/v1.9.0"
    "bbb`trefs/tags/v1.10.0"
    "ccc`trefs/tags/v2.0.0-rc.1"
    "ddd`trefs/tags/remote-v99"
}
function bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { $state.bunVersion }
    elseif ($args[-1] -eq 'status') { 'running http://127.0.0.1:7317 (pid 1234)'; 'config: none' }
    # the old id's stop: where it was told to look for its server's pid
    # (a server started by hand from the checkout is found only without one)
    elseif ($args[-1] -eq 'stop' -and $args[0] -like '*legacy root*') {
        $state.stopStateDirs += "$env:HERDR_PLUGIN_STATE_DIR"
        if ($state.handStarted -and $env:HERDR_PLUGIN_STATE_DIR) { 'herdr web ui is not running' } else { 'stopped herdr web ui (pid 1234)' }
    }
    # the plugin's launcher: its command, and whether it was told to build from source. As scripts/plugin-launch.ts does,
    # a stop under OVIS_FROM_SOURCE=1, with a marker naming this version, or without the release's binary in
    # .ovis/server/bin (a branch's sources are not the release's) goes to scripts/plugin.ts, which fails without the
    # packages, and an install under it names the version in .ovis/server/from-source before it builds the packages and
    # the client
    elseif ($args[0] -like '*\scripts\plugin-launch.ts') {
        $state.launcherCalls += "$($args[-1]) $env:OVIS_FROM_SOURCE".Trim()
        $root = Split-Path (Split-Path $args[0])
        $serverDir = Join-Path $root '.ovis\server'
        $marked = (Test-Path -LiteralPath (Join-Path $serverDir 'from-source')) -and (Get-Content -Raw -LiteralPath (Join-Path $serverDir 'from-source')).Trim() -eq '1.2.3'
        $toSource = $marked -or -not (Test-Path -LiteralPath (Join-Path $serverDir 'bin\ovis-server.exe'))
        if ($args[-1] -eq 'stop' -and ($env:OVIS_FROM_SOURCE -eq '1' -or ($toSource -and -not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))))) { $global:LASTEXITCODE = 1 }
        if ($env:OVIS_FROM_SOURCE -eq '1' -and $args[-1] -eq 'install') {
            New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
            Set-Content -LiteralPath (Join-Path $serverDir 'from-source') -Value '1.2.3'
            if ($state.failBuild) { $global:LASTEXITCODE = 1; return }
            # a build cut off: it says the marker is written, then runs until the test stops the installer, as Ctrl+C does
            if ($state.cutBuild) { $null = $state.cutBuild.Set(); Start-Sleep -Seconds 60 }
            New-Item -ItemType Directory -Force -Path (Join-Path $root 'node_modules'), (Join-Path $root 'dist') | Out-Null
            Set-Content -LiteralPath (Join-Path $root 'dist\index.html') -Value ''
        }
    }
    else { throw "Unexpected Bun command: $args" }
}
function herdr {
    $global:LASTEXITCODE = 0
    switch ($args -join ' ') {
        '--version' { 'herdr 0.9.3' }
        'plugin list --json' {
            $plugins = @()
            if ($state.installed) { $plugins = @(@{ plugin_id = $state.installedId; plugin_root = $pluginRoot }) }
            if ($state.linkedRoot) { $plugins = @(@{ plugin_id = 'devswha.ovis'; plugin_root = $state.linkedRoot }) }
            if ($state.legacyInstalled) { $plugins += @{ plugin_id = 'devswha.herdr-web-ui'; plugin_root = (Join-Path $ghStandIn 'legacy root') } }
            @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 4 -Compress
        }
        'status server --json' { @{ running = $state.running } | ConvertTo-Json -Compress }
        'plugin action invoke devswha.ovis.start-windows' { $state.started = $true; '{}' }
        'plugin action invoke devswha.herdr-web-ui.start-windows' { $state.started = $true; $state.startedLegacy = $true; '{}' }
        'plugin uninstall devswha.ovis' { $state.installed = $false; $state.uninstalls++; 'Uninstalled' }
        'plugin uninstall devswha.herdr-web-ui' { $state.legacyInstalled = $false; 'Uninstalled' }
        'plugin config-dir devswha.ovis' { Join-Path $ghStandIn 'config\devswha.ovis' }
        'plugin config-dir devswha.herdr-web-ui' { Join-Path $ghStandIn 'config\devswha.herdr-web-ui' }
        default {
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'link') { $state.linkedRoot = $args[2]; return 'Linked' }
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'install') {
                if ($state.failInstall) { $global:LASTEXITCODE = 1; return }
                # under the id the ref's manifest names
                $state.installed = $true; $state.installs++; $state.ref = $args[4]; $state.installedId = $state.refId
                # what herdr's build step (scripts/plugin-launch.ts install) is told: source, or the release's binary
                $state.pluginSource = "$env:OVIS_FROM_SOURCE"
                Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
                if ($state.windowsRelease) { Set-Content -LiteralPath $launcher -Value '' }
                'Installed Ovis'
            } else { throw "Unexpected herdr command: $args" }
        }
    }
}
function Invoke-WebRequest {
    # the manifest of the ref being installed: what its id is, or a network that blocks the host
    if ("$($args[-1])" -like 'https://raw.githubusercontent.com/devswha/ovis/*/herdr-plugin.toml') {
        if ($state.manifestBlocked) { throw 'Unable to connect to the remote server' }
        return @{ Content = "name = `"Ovis`"`nid = `"$($state.refId)`"" }
    }
    # herdr's installer, as the stand-in the test wrote: -OutFile is the last argument
    if ($args[0] -eq 'https://herdr.dev/install.cmd') { Set-Content -LiteralPath $args[-1] -Value $state.herdrInstaller -Encoding Ascii; return }
    if ($args[0] -ne 'https://bun.sh/install.ps1') { throw "Unexpected download: $args" }
    if ($state.failBun) { return @{ Content = 'param($Version)' } }
    # as Bun's installer does: the session is left with the user's PATH and nothing of the machine's
    @{ Content = 'param($Version) $state.bunVersion = $Version; $env:PATH = "C:\Users\someone\.bun\bin"' }
}

try {
    New-Item -ItemType Directory -Force -Path $ghStandIn | Out-Null
    Set-Content -LiteralPath (Join-Path $ghStandIn 'gh.cmd') -Encoding Ascii -Value @'
@echo off
echo %*>>"%~dp0calls.txt"
set /p mode=<"%~dp0mode.txt"
echo %* | findstr /C:"--method PUT" >nul
if not errorlevel 1 goto star
if "%mode%"=="starred" goto starred
if "%mode%"=="hangs" goto hangs
if "%mode%"=="signed-out" goto signedout
if "%mode%"=="upstream" goto upstream
if "%mode%"=="lingering" goto lingering
echo HTTP/2.0 404 Not Found
echo gh: Not Found (HTTP 404) 1>&2
exit /b 1
:starred
echo HTTP/2.0 204 No Content
exit /b 0
:hangs
ping -n 16 127.0.0.1 >nul
exit /b 0
:signedout
echo To get started with GitHub CLI, please run:  gh auth login 1>&2
exit /b 4
:lingering
powershell -NoProfile -Command "(Start-Process ping -ArgumentList '-n','47','127.0.0.1' -NoNewWindow -PassThru).Id | Set-Content -Encoding Ascii '%~dp0child.txt'"
echo HTTP/2.0 404 Not Found
exit /b 1
:upstream
echo HTTP/2.0 500 Internal Server Error
echo gh: upstream answered HTTP 404 (HTTP 500) 1>&2
exit /b 1
:star
if "%mode%"=="refuses" goto refused
echo HTTP/2.0 204 No Content
exit /b 0
:refused
echo HTTP/2.0 404 Not Found
echo gh: Not Found (HTTP 404) 1>&2
exit /b 1
'@
    $env:PATH = "$ghStandIn;$env:PATH"
    $ghCalls = Join-Path $ghStandIn 'calls.txt'
    # a first install with this gh; then what the installer said, and how often it starred
    $firstInstall = {
        param([string]$Gh, [string]$Source)
        $state.installed = $false; $star.asked = 0
        Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value $Gh
        Remove-Item -LiteralPath $ghCalls -Force -ErrorAction SilentlyContinue
        if ($Source) { Invoke-Expression $Source 6>&1 | Out-String } else { & $installer -Ref '' 6>&1 | Out-String }
    }
    $given = { @(Get-Content -LiteralPath $ghCalls -ErrorAction SilentlyContinue | Where-Object { $_ -match '--method PUT' }).Count }
    # the status read: the installer's own launcher must reach the stand-in, or a wrong launcher would pass as "already starred"
    $read = { @(Get-Content -LiteralPath $ghCalls -ErrorAction SilentlyContinue | Where-Object { $_ -match 'user/starred' -and $_ -notmatch '--method PUT' }).Count }
    Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value 'signed-out'

    & $installer -Ref ''
    Assert ($state.installed -and $state.ref -eq 'v1.10.0' -and $state.started) 'Install must choose the highest stable release and start a running server'
    & $installer -Ref ''
    Assert ($state.installs -eq 1) 'Rerun must preserve the installed plugin'
    & {
        $ErrorActionPreference = 'Continue'
        Invoke-Expression (Get-Content -Raw $installer)
        Assert ($ErrorActionPreference -eq 'Continue') 'The one-line installer must preserve the caller error preference'
        Assert (-not (Test-Path Function:\Run-Tool)) 'The one-line installer must keep helper functions in its own scope'
    }

    $state.bunVersion = '1.3.0'
    & $installer -Ref ''
    Assert ($state.bunVersion -eq '1.4.2') 'An old Bun must be updated through its installer'
    Assert ($env:PATH.EndsWith($originalPath)) "Bun's installer must not leave the session without the machine PATH"
    $state.bunVersion = '1.3.0'; $state.failBun = $true
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'Needs Bun' }
    Assert $failed 'An unsuccessful Bun bootstrap must stop installation'
    $state.bunVersion = '1.4.2'; $state.failBun = $false

    $state.installed = $false; $state.running = $false; $state.started = $false
    & $installer -Ref 'feat/windows-install'
    Assert ($state.ref -eq 'feat/windows-install' -and -not $state.started) 'Explicit ref must install without starting herdr'
    # without OVIS_FROM_SOURCE, herdr still builds a branch from its own sources, and the caller's variable is left as it was
    $state.installed = $false; $env:OVIS_FROM_SOURCE = ''
    & $installer -Ref 'feat/windows-install'
    Assert ($state.pluginSource -eq '1' -and -not $env:OVIS_FROM_SOURCE) "A branch must be built from its own sources (herdr's build was told '$($state.pluginSource)')"
    # a branch an earlier installer left on the release's binary (a launcher, no from-source marker): with herdr running,
    # a rerun stops that server and builds the checkout from its own sources before the start and the status read
    $state.running = $true; $state.started = $false; $state.launcherCalls = @(); $installs = $state.installs
    Set-Content -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts') -Value ''
    Set-Content -LiteralPath (Join-Path $pluginRoot 'package.json') -Value '{ "version": "1.2.3" }'
    $fromSource = Join-Path $pluginRoot '.ovis\server\from-source'
    # no build of this checkout: no marker, packages or built client
    $unbuilt = { foreach ($name in '.ovis', 'node_modules', 'dist') { Remove-Item -LiteralPath (Join-Path $pluginRoot $name) -Recurse -Force -ErrorAction SilentlyContinue } }
    # a checkout on the release's binary: unbuilt, with that version's binary and client kept in .ovis/server/bin
    $onBinary = {
        & $unbuilt
        New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server\bin\dist') | Out-Null
        Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.exe'), (Join-Path $pluginRoot '.ovis\server\bin\dist\index.html') -Value ''
        Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.json') -Value '{ "version": "1.2.3" }'
    }
    & $onBinary
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and $state.installs -eq $installs -and $state.started -and -not $env:OVIS_FROM_SOURCE) "A rerun over a branch on the release's binary must stop it and build it from source in place (launcher: $($state.launcherCalls -join ','))"
    # the same with OVIS_FROM_SOURCE=1 set by the caller: the stop still goes to the binary, and the variable is the caller's again
    & $onBinary; $state.launcherCalls = @(); $env:OVIS_FROM_SOURCE = '1'
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and $env:OVIS_FROM_SOURCE -eq '1' -and (Test-Path -LiteralPath $fromSource)) "With OVIS_FROM_SOURCE=1 set, a rerun must stop the binary and build from source (launcher: $($state.launcherCalls -join ','))"
    # a build that fails takes back the marker the launcher wrote before it, so the next rerun builds again; it hands over
    # the rerun, and the start of the release's binary the checkout keeps
    & $onBinary; $state.launcherCalls = @(); $env:OVIS_FROM_SOURCE = ''; $state.failBuild = $true
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'bun failed' -and -not (Test-Path -LiteralPath $fromSource) -and -not $env:OVIS_FROM_SOURCE) "A failed build must stop the install and leave no from-source marker: $message"
    Assert ($message.Contains('OVIS_REF=feat/windows-install') -and $message.Contains('herdr plugin action invoke devswha.ovis.start-windows')) "A failed build must hand over the rerun and the start of the release's binary: $message"
    # a kept binary of another version is not what the launcher's start runs: no start is handed over then
    Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.json') -Value '{ "version": "1.2.2" }'
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'bun failed' -and -not $message.Contains('start-windows')) "A failed build must not hand over the start of a kept binary of another version: $message"
    Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.json') -Value '{ "version": "1.2.3" }'
    $state.failBuild = $false; $state.launcherCalls = @()
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath $fromSource)) "A rerun after a failed build must build again (launcher: $($state.launcherCalls -join ','))"
    # a build cut off after the launcher wrote the marker (Ctrl+C stops the pipeline: finally runs, catch does not): the
    # installer runs in a pipeline of its own, which is stopped as the console's Ctrl+C stops it
    & $onBinary; $state.launcherCalls = @()
    $state.cutBuild = New-Object Threading.ManualResetEvent($false)
    $runspace = [RunspaceFactory]::CreateRunspace(); $runspace.Open()
    foreach ($name in 'state', 'pluginRoot', 'ghStandIn', 'launcher') { $runspace.SessionStateProxy.SetVariable($name, (Get-Variable $name -ValueOnly)) }
    $stubs = [PowerShell]::Create(); $stubs.Runspace = $runspace
    $null = $stubs.AddScript((@(foreach ($name in 'Get-TestCommit', 'git', 'bun', 'herdr') { "function global:$name {$((Get-Item "Function:\$name").Definition)}" }) -join "`n")).Invoke()
    $stubs.Dispose()
    $cut = [PowerShell]::Create(); $cut.Runspace = $runspace
    $null = $cut.AddScript((Get-Content -Raw $installer)).AddParameter('Ref', 'feat/windows-install')
    try {
        $running = $cut.BeginInvoke()
        Assert ($state.cutBuild.WaitOne(30000)) "control: the installer must reach the build (launcher: $($state.launcherCalls -join ','))"
        $cut.Stop()
        Assert ($running.IsCompleted -and $cut.InvocationStateInfo.State -eq 'Stopped') "control: the installer must have been stopped: $($cut.InvocationStateInfo.State) $($cut.InvocationStateInfo.Reason)"
    } finally { $cut.Dispose(); $runspace.Dispose(); $state.cutBuild.Dispose(); $state.cutBuild = $null }
    Assert (-not (Test-Path -LiteralPath $fromSource) -and -not $env:OVIS_FROM_SOURCE) "A build cut off must leave no from-source marker and the caller's OVIS_FROM_SOURCE (launcher: $($state.launcherCalls -join ','))"
    $state.launcherCalls = @()
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath $fromSource)) "A rerun after a build cut off must build again (launcher: $($state.launcherCalls -join ','))"
    # a build cut off where no finally runs (a closed window, a restart): the marker names the version, and neither the
    # packages nor the client are there, so the rerun builds again (its stop going to the binary, not the unbuilt sources)
    & $onBinary; $state.launcherCalls = @()
    New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null
    Set-Content -LiteralPath $fromSource -Value '1.2.3'
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath (Join-Path $pluginRoot 'dist\index.html'))) "A marker without the packages and the client must be built again (launcher: $($state.launcherCalls -join ',')): $message"
    # the same with no release binary kept (a source build herdr ran itself, cut off): nothing of this checkout can be
    # running, and the launcher's stop would fail in the sources it never built, so the rerun builds without a stop
    & $unbuilt; $state.launcherCalls = @()
    New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null
    Set-Content -LiteralPath $fromSource -Value '1.2.3'
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert (($state.launcherCalls -join ',') -eq 'install 1' -and (Test-Path -LiteralPath (Join-Path $pluginRoot 'dist\index.html'))) "A cut-off build with no release binary kept must be built again without a stop (launcher: $($state.launcherCalls -join ',')): $message"
    # the ref must name the installed commit: another branch, a branch that moved since, or another commit is said, with the
    # commits, and nothing is stopped or built; offline, nothing is either
    $installedAt = (Get-TestCommit 'feat/windows-install').Substring(0, 12)
    foreach ($case in @(
        @{ name = 'another branch'; ref = 'other-branch'; at = (Get-TestCommit 'other-branch').Substring(0, 12) },
        @{ name = 'a branch that moved'; ref = 'feat/windows-install'; at = (Get-TestCommit 'feat/windows-install, moved').Substring(0, 12); moved = $true },
        @{ name = 'another commit'; ref = 'abcdef1'; at = 'abcdef1' },
        @{ name = 'GitHub out of reach'; ref = 'feat/windows-install'; offline = $true }
    )) {
        & $onBinary; $state.launcherCalls = @()
        $state.moved = @(if ($case.moved) { 'feat/windows-install' }); $state.offline = [bool]$case.offline
        $message = ''
        try { & $installer -Ref $case.ref } catch { $message = $_.Exception.Message }
        $state.moved = @(); $state.offline = $false
        Assert ($message -and $state.launcherCalls.Count -eq 0) "$($case.name): nothing must be stopped or built (launcher: $($state.launcherCalls -join ',')): $message"
        if ($case.at) { Assert ($message.Contains($installedAt) -and $message.Contains($case.at)) "$($case.name) must be said with both commits ($installedAt, $($case.at)): $message" }
    }
    # the installed commit's id, short or long, and an annotated tag at it (its commit is the tag's ^{}) are that checkout
    foreach ($case in @(@{ ref = $installedAt }, @{ ref = $installedAt.Substring(0, 5) }, @{ ref = 'tag/annotated'; tag = $true })) {
        & $onBinary; $state.launcherCalls = @()
        if ($case.tag) { $state.annotated = @($case.ref); $state.ref = $case.ref }
        & $installer -Ref $case.ref
        $state.annotated = @(); $state.ref = 'feat/windows-install'
        Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath $fromSource)) "$($case.ref) names the installed commit and must build that checkout (launcher: $($state.launcherCalls -join ','))"
    }
    # a release tag keeps its binary, and a checkout whose marker names its version was built from source already
    $state.launcherCalls = @()
    & $installer -Ref 'v1.10.0'
    New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null
    Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\from-source') -Value '1.2.3'
    & $installer -Ref 'feat/windows-install'
    Assert ($state.launcherCalls.Count -eq 0 -and $state.installs -eq $installs) "Nothing must be rebuilt for a release tag or a branch built from source (launcher: $($state.launcherCalls -join ','))"
    Remove-Item -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts'), (Join-Path $pluginRoot 'package.json') -Force; & $unbuilt
    $state.running = $false
    $env:OVIS_FROM_SOURCE = '1'

    $state.installed = $false; $state.failInstall = $true; $state.started = $false
    $failed = $false
    try { & $installer -Ref 'broken' } catch { $failed = $_.Exception.Message -match 'herdr failed' }
    Assert ($failed -and -not $state.started) 'A failed native command must stop installation'

    # A copy from a release without Windows support: installed, listed, and unable to start.
    $state.failInstall = $false; $state.running = $true; $state.installed = $false; $state.windowsRelease = $false
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'does not support Windows yet' }
    Assert ($failed -and -not $state.started) 'A release without Windows support must not be reported as installed'
    $state.windowsRelease = $true; $installs = $state.installs
    & $installer -Ref ''
    Assert ($state.uninstalls -eq 1 -and $state.installs -eq $installs + 1 -and $state.started) 'A copy without Windows support must be replaced and started'
    # release tags are a lowercase vX.Y.Z: V1.2.3 is none, so herdr builds it from source, on a fresh install (here the
    # one that replaces a copy without Windows support) and on a rerun over a checkout left on the release's binary
    $env:OVIS_FROM_SOURCE = ''; $state.launcherCalls = @()
    Remove-Item -LiteralPath $launcher
    & $installer -Ref 'V1.2.3'
    Assert ($state.ref -eq 'V1.2.3' -and $state.pluginSource -eq '1') "V1.2.3 is no release tag and must be built from source (herdr's build was told '$($state.pluginSource)')"
    Set-Content -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts') -Value ''
    Set-Content -LiteralPath (Join-Path $pluginRoot 'package.json') -Value '{ "version": "1.2.3" }'
    & $onBinary
    & $installer -Ref 'V1.2.3'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and -not $env:OVIS_FROM_SOURCE) "A rerun at V1.2.3 must build the checkout from source (launcher: $($state.launcherCalls -join ','))"
    Remove-Item -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts'), (Join-Path $pluginRoot 'package.json') -Force; & $unbuilt
    $env:OVIS_FROM_SOURCE = '1'
    Write-Host 'PASS native installer release selection, rerun, Bun bootstrap, explicit ref, stopped herdr, install failure and a copy without Windows support'

    # Releases up to 0.4.13 name the plugin by its old id: told by the manifest, or by the version when it cannot be read.
    foreach ($blocked in $false, $true) {
        $state.installed = $false; $state.started = $false; $state.startedLegacy = $false
        $state.refId = 'devswha.herdr-web-ui'; $state.manifestBlocked = $blocked
        & $installer -Ref 'v0.4.13'
        Assert ($state.installedId -eq 'devswha.herdr-web-ui' -and $state.startedLegacy) "A release that names the old id must install and start under it (manifest blocked: $blocked)"
    }
    $state.installed = $false; $state.started = $false; $state.refId = 'devswha.ovis'; $state.manifestBlocked = $false
    Write-Host 'PASS a release from before the rename installs under its old id'

    # An install under the old id moves to the new one. Its server is stopped with the state dir herdr hands the
    # plugin, where a release from before 0.4.13 keeps its pid: told nothing, that stop looks in ~/.local/state,
    # finds no server, and the one that outlived herdr keeps the old checkout open for the uninstall.
    $savedXdg = $env:XDG_STATE_HOME; $savedPluginState = $env:HERDR_PLUGIN_STATE_DIR
    try {
        Remove-Item Env:\HERDR_PLUGIN_STATE_DIR -ErrorAction SilentlyContinue
        $xdgState = Join-Path $ghStandIn 'xdg state'
        foreach ($xdg in $null, $xdgState) {
            if ($xdg) { $env:XDG_STATE_HOME = $xdg } else { Remove-Item Env:\XDG_STATE_HOME -ErrorAction SilentlyContinue }
            $state.installed = $false; $state.legacyInstalled = $true; $state.stopStateDirs = @(); $state.started = $false
            & $installer -Ref ''
            $expected = Join-Path $(if ($xdg) { $xdg } else { $env:LOCALAPPDATA }) 'herdr\plugins\devswha.herdr-web-ui'
            Assert ($state.stopStateDirs.Count -eq 1 -and $state.stopStateDirs[0] -eq $expected) "The old id's stop must look for its pid where herdr keeps the plugin's state ($expected), not: $($state.stopStateDirs -join ', ')"
            Assert (-not $state.legacyInstalled -and $state.installedId -eq 'devswha.ovis' -and $state.started) 'An install under the old id must move to the new id and start'
            Assert ($null -eq $env:HERDR_PLUGIN_STATE_DIR) 'The state dir given to the old stop must not stay set for later commands'
        }
        # a server started by hand from the old checkout: not found through herdr's dir, so the stop asks again without it
        $state.installed = $false; $state.legacyInstalled = $true; $state.stopStateDirs = @(); $state.handStarted = $true
        & $installer -Ref ''
        Assert ($state.stopStateDirs.Count -eq 2 -and $state.stopStateDirs[0] -and -not $state.stopStateDirs[1]) "A stop that found no server through herdr's dir must ask once more without it: $($state.stopStateDirs -join ' | ')"
        $state.handStarted = $false
    } finally {
        foreach ($pair in @(@('XDG_STATE_HOME', $savedXdg), @('HERDR_PLUGIN_STATE_DIR', $savedPluginState))) {
            if ($null -eq $pair[1]) { Remove-Item "Env:$($pair[0])" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$($pair[0])" $pair[1] }
        }
        $state.legacyInstalled = $false
    }
    Write-Host 'PASS an install under the old id stops its server through the state dir herdr gives it, and moves'

    # Browser opening is covered through a stand-in; this harness never starts a real browser.
    $savedCi = $env:CI; $savedNoOpen = $env:OVIS_NO_OPEN; $savedSsh = $env:SSH_CONNECTION
    try {
        Remove-Item Env:\CI, Env:\OVIS_NO_OPEN, Env:\SSH_CONNECTION -ErrorAction SilentlyContinue
        $state.installed = $false; $state.running = $true; $global:herdrInstallOpened = @()
        $freshOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 1 -and $global:herdrInstallOpened[0] -eq 'http://127.0.0.1:7317') 'A fresh install must open the loopback origin exactly once'
        Assert ($freshOutput -match 'opened http://127\.0\.0\.1:7317.*click Install') 'A fresh install must explain where to click Install'

        $global:herdrInstallOpened = @()
        $rerunOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 0 -and $rerunOutput -notmatch 'opened ') 'A rerun must not open the app'

        foreach ($gate in 'OVIS_NO_OPEN', 'CI', 'SSH_CONNECTION') {
            $state.installed = $false; $global:herdrInstallOpened = @()
            Set-Item "Env:$gate" '1'
            $output = & $installer -Ref 'test' 6>&1 | Out-String
            Assert ($global:herdrInstallOpened.Count -eq 0) "$gate must prevent opening"
            if ($gate -eq 'SSH_CONNECTION') {
                Assert ($output -match 'ssh -L 7317:127\.0\.0\.1:7317' -and $output -match 'Tailscale') 'SSH guidance must include the tunnel command and Tailscale pointer'
            }
            Remove-Item "Env:$gate" -ErrorAction SilentlyContinue
        }
        $state.installed = $false; $state.running = $false; $global:herdrInstallOpened = @()
        $stoppedOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 0 -and $stoppedOutput -notmatch 'opened ') 'A fresh install must not open the app when herdr is stopped'
        $state.running = $true
        Write-Host 'PASS Windows app opening: fresh install, rerun, OVIS_NO_OPEN, SSH tunnel and Tailscale, and CI'
    } finally {
        foreach ($pair in @(@('CI', $savedCi), @('OVIS_NO_OPEN', $savedNoOpen), @('SSH_CONNECTION', $savedSsh))) {
            if ($null -eq $pair[1]) { Remove-Item "Env:$($pair[0])" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$($pair[0])" $pair[1] }
        }
        $global:herdrInstallOpened = @()
    }

    # The star: mentioned once on a first install, asked only at a terminal, given only on "y".
    $mention = 'a GitHub star helps other herdr users find it'
    $question = 'star it now with the GitHub account'
    $said = & $firstInstall 'starred'
    Assert ($said -notmatch $mention -and $star.asked -eq 0 -and (& $read) -eq 1 -and (& $given) -eq 0) "An account that already starred must hear nothing of it, after one status read: $said"
    $said = & $firstInstall 'signed-out'
    Assert ($said -match $mention -and $said -notmatch $question -and (& $given) -eq 0) "Without a gh sign-in the link is all there is: $said"
    $newInstall = $true
    $said = & $installer -Ref '' 6>&1 | Out-String
    Remove-Variable newInstall
    Assert ($said -notmatch $mention) "A rerun must not mention the star, whatever the caller's variables hold: $said"
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $said = & $firstInstall 'hangs'
    Assert ($said -match $mention -and $said -notmatch $question -and $clock.Elapsed.TotalSeconds -lt 14) "A gh that does not answer must be left after 10 seconds, with the link: $($clock.Elapsed.TotalSeconds) s, $said"

    # The installer as it is, where this test runs: CI has no terminal, and a developer's terminal is told it is CI.
    $ci = $env:CI; $env:CI = 'true'
    try { $said = & $firstInstall 'not' } finally { $env:CI = $ci }
    Assert ($said -match $mention -and $said -notmatch $question -and $star.asked -eq 0 -and (& $given) -eq 0) "An agent or a script must get the link and no question: $said"

    # Whether somebody is at a terminal is what a test host cannot be: the installer's own text, with those two answers given.
    $source = Get-Content -Raw $installer
    $decision = 'if ($newInstall) {'
    Assert (($source -split [regex]::Escape($decision)).Count -eq 2) 'The installer must decide once, after its helpers, whether this was a first install'
    # The installer defines its own Read-Answer above the decision, so the test's stands in after it: the answer
    # given here, or null where nobody is at the terminal and the installer's own wait is what ended.
    $answering = 'function Read-Answer { $star.asked++; if ($star.failAsk) { throw "Read-Answer has no console to read from" }; $star.answer }'
    $atTerminal = $source.Replace($decision, "function Test-Terminal { `$true }; $answering; $decision")
    $nobodyThere = $source.Replace($decision, "function Test-Terminal { `$true }; function Read-Answer { `$null }; $decision")
    $star.answer = 'y'
    $said = & $firstInstall 'not' $nobodyThere
    Assert ($said -match $question -and $star.asked -eq 0 -and (& $given) -eq 0) "A question nobody answers must be left without a star: $said"
    foreach ($gh in 'upstream', 'signed-out') {
        $said = & $firstInstall $gh $atTerminal
        Assert ($said -match $mention -and $said -notmatch $question -and $star.asked -eq 0) "Only GitHub's own 404 is a reason to ask, not ${gh}: $said"
    }
    foreach ($answer in '', 'n', 'yy') {
        $star.answer = $answer
        $said = & $firstInstall 'not' $atTerminal
        Assert ($said -match $question -and $star.asked -eq 1 -and (& $given) -eq 0) "The answer '$answer' must not star: $said"
    }
    $star.answer = 'y'
    $said = & $firstInstall 'not' $atTerminal
    Assert ($star.asked -eq 1 -and (& $given) -eq 1 -and $said -match 'starred\. Thank you') "A yes must star once: $said"
    $said = & $firstInstall 'refuses' $atTerminal
    Assert ($said -match 'could not star it' -and $state.installed) "A star gh refuses must be said, not thrown: $said"
    $star.failAsk = $true
    $said = & $firstInstall 'not' $atTerminal
    $star.failAsk = $false
    Assert ($state.installed -and $star.asked -eq 1 -and (& $given) -eq 0) "A question that cannot be asked must not fail the install: $said"
    & $firstInstall 'signed-out' | Out-Null
    Write-Host 'PASS star: silent when starred or on a rerun, a link without gh, an answer or a terminal, asked once at a terminal and given only on yes'

    # A gh that leaves a child holding its output: the call ends on its deadline and the child ends with it.
    # Invoke-GhApi alone, from the installer's own text, so that only what it starts is looked at.
    $parsed = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer).Path, [ref]$null, [ref]$null)
    $ghApi = $parsed.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-GhApi' }, $true)
    Assert ($null -ne $ghApi) 'The installer must define Invoke-GhApi'
    Invoke-Expression $ghApi.Extent.Text
    Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value 'lingering'
    $childFile = Join-Path $ghStandIn 'child.txt'
    Remove-Item -LiteralPath $childFile -Force -ErrorAction SilentlyContinue
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $answer = Invoke-GhApi 'user/starred/devswha/ovis'
    $elapsed = $clock.Elapsed.TotalSeconds
    $childPid = [int](Get-Content -LiteralPath $childFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    Assert ($childPid -gt 0) 'control: the lingering stand-in must have started its child and named its PID'
    Assert ($null -eq $answer -and $elapsed -lt 15) "control: a gh whose output stays open must be left after its deadline, with no answer: $elapsed s"
    $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'PING'
    $left = $child -and -not $child.WaitForExit(5000)
    if ($left) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
    Assert (-not $left) "regression (fails on main): the child gh left holding its output (PID $childPid) must not outlive the call"
    Write-Host "PASS gh deadline: a child of gh that holds its output ends with the call (PID $childPid, $([math]::Round($elapsed, 1)) s)"

    # A native shim starts its output-holding child as its first action, without a PowerShell startup delay.
    # At the assignment boundary, force the old runnable launcher to reach child-ready before proceeding.
    # The fixed launcher must still be suspended there. The same assertion is run against both launches.
    $immediate = Join-Path $ghStandIn 'immediate shim'
    New-Item -ItemType Directory -Path $immediate | Out-Null
    Add-Type -OutputAssembly (Join-Path $immediate 'gh.exe') -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class ImmediateGh {
    public static void Main() {
        Process child = Process.Start(new ProcessStartInfo("ping.exe", "-n 47 127.0.0.1") { UseShellExecute = false });
        File.WriteAllText(Environment.GetEnvironmentVariable("HERDR_TEST_GH_CHILD"), child.Id.ToString());
        using (EventWaitHandle ready = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("HERDR_TEST_GH_READY"))) ready.Set();
        Console.WriteLine("HTTP/2.0 404 Not Found");
        Console.Error.WriteLine("gh: Not Found (HTTP 404)");
        Environment.ExitCode = 1;
    }
}
'@
    $assignment = '[Ovis.GhJob]::Assign($job, $process.Handle)'
    $orderedSource = $ghApi.Extent.Text.Replace("`r`n", "`n").Replace($assignment, '(Assign-TestGhJob $job $process)')
    Assert ($orderedSource -ne $ghApi.Extent.Text) 'control: interpose at the real job assignment boundary'
    function Assign-TestGhJob($Job, $Process) {
        if ($Process -is [Diagnostics.Process]) {
            Assert ($ready.WaitOne(5000)) 'control: the runnable shim must reach child-ready before assignment'
        }
        Assert (-not $ready.WaitOne(0)) 'regression: shim ran before job assignment'
        [Ovis.GhJob]::Assign($Job, $Process.Handle)
    }
    $suspendedLaunch = @'
        if ($job -ne [IntPtr]::Zero) {
            $process = [Ovis.GhJob]::StartSuspended($start.FileName, $start.Arguments)
            if (-not (Assign-TestGhJob $job $process)) {
                $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
            }
            $process.Resume()
        } else {
            $process = [Diagnostics.Process]::Start($start)
        }
'@
    $runnableLaunch = @'
        $process = [Diagnostics.Process]::Start($start)
        if ($job -ne [IntPtr]::Zero -and -not (Assign-TestGhJob $job $process)) {
            $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
        }
'@
    # Scratch-source reversion of exactly the pre-fix runnable Start/Assign ordering; no repository file changes.
    $runnableSource = $orderedSource.Replace($suspendedLaunch.Replace("`r`n", "`n"), $runnableLaunch)
    $path = $env:PATH
    $oldReady = $env:HERDR_TEST_GH_READY; $oldChild = $env:HERDR_TEST_GH_CHILD
    try {
        $env:PATH = "$immediate;$path"
        foreach ($case in @(
            @{ name = 'reverted'; source = $runnableSource },
            @{ name = 'fixed'; source = $orderedSource }
        )) {
            $env:HERDR_TEST_GH_READY = "Local\herdr-gh-ready-$([Guid]::NewGuid())"
            $env:HERDR_TEST_GH_CHILD = Join-Path $immediate 'child.txt'
            Remove-Item -LiteralPath $env:HERDR_TEST_GH_CHILD -Force -ErrorAction SilentlyContinue
            $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $env:HERDR_TEST_GH_READY)
            $failure = ''
            try {
                Invoke-Expression $case.source
                $clock = [Diagnostics.Stopwatch]::StartNew()
                $answer = Invoke-GhApi 'user/starred/devswha/ovis'
                Assert ($null -eq $answer -and $clock.Elapsed.TotalSeconds -lt 15) 'regression: immediate child must not keep the call waiting past its deadline'
                Assert ($ready.WaitOne(0)) 'control: the resumed shim must have started its child'
                $childPid = [int](Get-Content -LiteralPath $env:HERDR_TEST_GH_CHILD)
                $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue
                Assert (-not $child -or $child.WaitForExit(5000)) 'regression: immediate child must end with the assigned job'
            } catch { $failure = $_.Exception.Message } finally {
                $childPid = [int](Get-Content -LiteralPath $env:HERDR_TEST_GH_CHILD -ErrorAction SilentlyContinue | Select-Object -First 1)
                if ($childPid -gt 0) {
                    Get-Process -Id $childPid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'PING' |
                        Stop-Process -Force -ErrorAction SilentlyContinue
                }
                $ready.Dispose()
            }
            if ($case.name -eq 'reverted') {
                Assert ($failure -eq 'regression: shim ran before job assignment') "The reverted launch must fail the ordering assertion, not another error: $failure"
                Write-Host "PASS gh ordering negative control: reverted launch 0 pass, 1 fail ($failure)"
            } else {
                Assert (-not $failure) "The suspended launch must pass the same ordering and child cleanup test: $failure"
                Write-Host 'PASS gh ordering: suspended launch 1 pass, 0 fail; immediate child ends with its job'
            }
        }
    } finally {
        $env:PATH = $path
        $env:HERDR_TEST_GH_READY = $oldReady; $env:HERDR_TEST_GH_CHILD = $oldChild
    }

    # The release's binary, from a local release folder signed by a key made for this test. The installer trusts only
    # the key on its $releasePublicKey line, so the test runs a copy whose line names the test's key: nothing in the
    # shipped script reads a key from anywhere else.
    $binaryScratch = Join-Path ([IO.Path]::GetTempPath()) "ovis-binary-install-$PID"
    New-Item -ItemType Directory -Force -Path $binaryScratch | Out-Null
    $realBun = (Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    Assert ([bool]$realBun) 'The binary cases make their release folder with Bun (ci.yml sets it up before this test)'
    $fixture = Join-Path $binaryScratch 'fixture.ts'
    Set-Content -LiteralPath $fixture -Encoding UTF8 -Value @'
// <release folder> <scripts/server-manifest.ts>: v1.2.3 to v1.2.7 signed by one key, v1.2.5 then again by another,
// v1.2.6 with a manifest for 1.2.2; prints the first key's public half
const [releases, module] = process.argv.slice(2);
const { generateKeyPair, releaseFile, SERVER_PLATFORMS, DIST_ARCHIVE, PTY_ASSETS, ptyFile, signManifest, writeManifest } = await import(module);
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const key = generateKeyPair();
for (const version of ["1.2.3", "1.2.4", "1.2.5", "1.2.6", "1.2.7"]) {
  const dir = join(releases, `v${version}`);
  const client = join(releases, `client-${version}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(client, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `ovis-server ${version} for ${platform}\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
  writeFileSync(join(client, "index.html"), `<!doctype html><title>${version}</title>`);
  if (Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", client, "."]).exitCode !== 0) throw new Error("tar failed");
  writeManifest(dir, { version: version === "1.2.6" ? "1.2.2" : version, sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
  signManifest(dir, version === "1.2.5" ? generateKeyPair().privateKeyPem : key.privateKeyPem);
}
// v1.2.8 to v1.3.0 as main's release step (todo 5) writes them: version, sources and assets only; v1.2.9 signed by
// another key, v1.3.0 with "schema": 2
const { createHash, createPrivateKey, sign } = await import("node:crypto");
for (const [version, signer, schema] of [["1.2.8", key.privateKeyPem, null], ["1.2.9", generateKeyPair().privateKeyPem, null], ["1.3.0", key.privateKeyPem, 2]]) {
  const dir = join(releases, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const assets = {};
  for (const platform of SERVER_PLATFORMS) {
    writeFileSync(join(dir, releaseFile(platform)), `old binary ${platform}\n`);
    assets[platform] = { file: releaseFile(platform), sha256: createHash("sha256").update(`old binary ${platform}\n`).digest("hex") };
  }
  const manifest = schema === null ? { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) }, assets } : { schema, version, sources: { server: "a".repeat(40), shared: "b".repeat(40) }, assets };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "ovis-server.json"), bytes);
  writeFileSync(join(dir, "ovis-server.json.sig"), `${sign(null, bytes, createPrivateKey(signer)).toString("base64")}\n`);
}
console.log(key.publicKey);
'@
    $releaseDir = Join-Path $binaryScratch 'release'
    $testKey = "$(& $realBun $fixture $releaseDir (Join-Path $PSScriptRoot 'server-manifest.ts') | Select-Object -Last 1)".Trim()
    Assert ($LASTEXITCODE -eq 0 -and $testKey -match '^[A-Za-z0-9+/]{43}=$') "The release fixture must be made: $testKey"
    # v1.2.4's binary with one byte changed, the same size: only its SHA-256 can tell
    $corrupt = Join-Path $releaseDir 'v1.2.4\ovis-server-windows-x64.exe'
    $bytes = [IO.File]::ReadAllBytes($corrupt); $bytes[3] = $bytes[3] -bxor 1; [IO.File]::WriteAllBytes($corrupt, $bytes)
    $shipped = Get-Content -Raw $installer
    $keyLine = [regex]::Match($shipped, '(?m)^\$releasePublicKey = ''[^'']+''(?=\r?$)').Value
    Assert ([bool]$keyLine) 'install.ps1 must pin its key on one $releasePublicKey line'
    $copy = Join-Path $binaryScratch 'install.ps1'
    Set-Content -LiteralPath $copy -Encoding UTF8 -Value $shipped.Replace($keyLine, "`$releasePublicKey = '$testKey'").Replace('[int]$WaitSeconds = 600', '[int]$WaitSeconds = 2')
    $env:OVIS_FROM_SOURCE = ''
    $env:OVIS_RELEASES_URL = ([Uri]$releaseDir).AbsoluteUri
    $env:LOCALAPPDATA = Join-Path $binaryScratch 'local app data'
    $state.installed = $false; $state.running = $false; $state.linkedRoot = ''
    $ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
    $exe = Join-Path $ovisHome 'bin\ovis-server.exe'
    & $copy -Ref 'v1.2.3'
    Assert ((Get-FileHash $exe).Hash -eq (Get-FileHash (Join-Path $releaseDir 'v1.2.3\ovis-server-windows-x64.exe')).Hash) 'The checked binary must be installed in bin'
    Assert ((Get-Content -Raw (Join-Path $ovisHome 'bin\dist\index.html')) -match '1\.2\.3') 'The client must be unpacked beside it'
    Assert ($state.linkedRoot -eq (Join-Path $ovisHome 'plugin') -and (Test-Path (Join-Path $ovisHome 'plugin\herdr-plugin.toml'))) 'The plugin that runs it must be linked into herdr'
    $again = & $copy -Ref 'v1.2.3' 6>&1 | Out-String
    Assert ($again -match 'nothing to do') "A second run must have nothing to do: $again"
    Remove-Item -LiteralPath (Join-Path $ovisHome 'bin\dist\index.html')
    $restored = & $copy -Ref 'v1.2.3' 6>&1 | Out-String
    Assert ($restored -notmatch 'nothing to do' -and ((Get-Content -Raw (Join-Path $ovisHome 'bin\dist\index.html')) -match '1\.2\.3')) "A missing client must be installed again: $restored"
    $kept = (Get-FileHash $exe).Hash
    foreach ($case in @(@('v1.2.4', 'does not match its SHA-256'), @('v1.2.5', 'not a valid signature'), @('v1.2.6', 'is for version 1\.2\.2, not 1\.2\.6'))) {
        $message = ''
        try { & $copy -Ref $case[0] } catch { $message = $_.Exception.Message }
        Assert ($message -match $case[1] -and $message -match 'nothing was changed') "$($case[0]) must be refused, saying why: $message"
        Assert ((Get-FileHash $exe).Hash -eq $kept) "$($case[0]) must leave the installed binary as it was"
    }
    $env:OVIS_RELEASES_URL = 'http://mirror.example/ovis'
    $message = ''
    try { & $copy -Ref 'v1.2.3' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'OVIS_RELEASES_URL') "Plain http must be refused: $message"
    $env:OVIS_RELEASES_URL = ([Uri]$releaseDir).AbsoluteUri
    $message = ''
    try { & $installer -Ref 'v1.2.4' 6>&1 | Out-Null } catch { $message = $_.Exception.Message }
    Assert ($message -match 'not a valid signature') "The shipped installer must refuse a release its pinned key did not sign: $message"
    # a release whose signed manifest has the shape from before schema 1 ships no compiled server this installer runs;
    # with no plugin listed, as on a PC where the binary is what herdr runs, so the release is probed
    $kept = (Get-FileHash $exe).Hash
    $before = @($state.installed, $state.running, $state.linkedRoot)
    $state.installed = $false; $state.running = $false; $state.linkedRoot = ''
    $old = & { try { & $copy -Ref 'v1.2.8' } catch { "THREW $($_.Exception.Message)" } } *>&1 | Out-String
    Assert ($old -match "v1\.2\.8's signed ovis-server\.json has the shape from before this installer" -and $old -match 'ships no compiled server, so it is installed from source') "An old-shape release must go to source: $old"
    Assert ((Get-FileHash $exe).Hash -eq $kept) 'An old-shape release must not touch the installed binary'
    Assert ($state.ref -eq 'v1.2.8' -and $state.pluginSource -eq '') "A release tag must be built as its release says, not forced to source (herdr's build was told '$($state.pluginSource)')"
    $message = ''; $state.installed = $false; $state.linkedRoot = ''
    try { & $copy -Ref 'v1.2.9' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'is not signed by the key') "An old-shape release signed by another key must be refused: $message"
    $message = ''; $state.installed = $false; $state.linkedRoot = ''
    try { & $copy -Ref 'v1.3.0' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'schema this installer does not know') "A manifest of schema 2 must be refused: $message"
    $state.installed, $state.running, $state.linkedRoot = $before
    $env:OVIS_FROM_SOURCE = '1'; $env:LOCALAPPDATA = $originalLocalAppData; Remove-Item Env:\OVIS_RELEASES_URL
    $state.linkedRoot = ''; $state.running = $true
    Write-Host 'PASS the release binary: installed and linked once checked, nothing to do again; a release of the old manifest shape goes to source; a corrupt binary, another key, another version and plain http refused, leaving the install as it was'

    # One install at a time: a live holder's lock is waited out (the copy waits 2 s, not 600) and named, a dead holder's is
    # taken over, and two installs started together in two processes never leave bin without a whole release.
    $env:OVIS_FROM_SOURCE = ''
    $env:OVIS_RELEASES_URL = ([Uri]$releaseDir).AbsoluteUri
    $env:LOCALAPPDATA = Join-Path $binaryScratch 'lock app data'
    $state.installed = $false; $state.running = $false; $state.linkedRoot = ''
    $ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
    $lock = Join-Path $ovisHome '.install.lock'
    New-Item -ItemType Directory -Force -Path $lock | Out-Null
    Set-Content -LiteralPath (Join-Path $lock 'pid') -Value $PID -Encoding Ascii
    $message = ''
    try { & $copy -Ref 'v1.2.3' } catch { $message = $_.Exception.Message }
    Assert ($message -match "another install is running in .* \(pid $PID\)" -and -not (Test-Path (Join-Path $ovisHome 'bin'))) "A live holder's lock must be waited out and named: $message"
    Assert ((Get-Content -LiteralPath (Join-Path $lock 'pid')) -eq "$PID") 'A live holder keeps its lock'
    $gone = [Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo -Property @{ FileName = "$env:SystemRoot\System32\cmd.exe"; Arguments = '/c exit'; UseShellExecute = $false; CreateNoWindow = $true }))
    $gone.WaitForExit()
    Set-Content -LiteralPath (Join-Path $lock 'pid') -Value $gone.Id -Encoding Ascii
    & $copy -Ref 'v1.2.3'
    Assert ((Test-Path (Join-Path $ovisHome 'bin\ovis-server.exe')) -and -not (Test-Path $lock)) 'A dead holder''s lock must be taken over'
    $runner = Join-Path $binaryScratch 'install-runner.ps1'
    Set-Content -LiteralPath $runner -Encoding UTF8 -Value @'
param([string]$Installer, [string]$Version, [string]$Barrier)
$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw -LiteralPath $Installer
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($definition.Extent.Text)) }
$ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
$releasePublicKey = [regex]::Match($source, "(?m)^\`$releasePublicKey = '([^']+)'").Groups[1].Value
while (-not (Test-Path -LiteralPath $Barrier)) { Start-Sleep -Milliseconds 10 }
try { $null = Install-OvisBinary $Version; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }
'@
    $hashes = @{}
    foreach ($version in '1.2.3', '1.2.7') { $hashes[(Get-FileHash (Join-Path $releaseDir "v$version\ovis-server-windows-x64.exe")).Hash] = $version }
    for ($pair = 0; $pair -lt 6; $pair++) {
        $barrier = Join-Path $binaryScratch "barrier-$pair"
        $versions = if ($pair % 2) { '1.2.3', '1.2.7' } else { '1.2.7', '1.2.3' }
        $children = foreach ($version in $versions) {
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = (Get-Command powershell).Source
            $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Installer `"$copy`" -Version $version -Barrier `"$barrier`""
            $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true
            [Diagnostics.Process]::Start($info)
        }
        Set-Content -LiteralPath $barrier -Value ''
        $said = foreach ($child in $children) { $child.StandardOutput.ReadToEnd(); $child.WaitForExit() }
        Assert (@($children | Where-Object { $_.ExitCode -eq 0 }).Count -ge 1) "Pair ${pair}: at least one install must succeed: $said"
        $running = $hashes[(Get-FileHash (Join-Path $ovisHome 'bin\ovis-server.exe')).Hash]
        Assert ($running -and ((Get-Content -Raw (Join-Path $ovisHome 'bin\dist\index.html')) -match [regex]::Escape($running))) "Pair ${pair}: bin must hold one whole release: $said"
        Assert (-not (Test-Path $lock)) "Pair ${pair}: the lock must be released"
    }
    $state.linkedRoot = ''; $state.running = $true
    $env:OVIS_FROM_SOURCE = '1'; $env:LOCALAPPDATA = $originalLocalAppData; Remove-Item Env:\OVIS_RELEASES_URL
    Write-Host 'PASS one install at a time: a live holder waited out and named, a dead holder''s lock taken over, overlapping installs in two processes leave one whole release'

    # A PC without herdr: its installer is a stand-in .cmd, and nothing of this PC's own herdr is in reach.
    $scratch = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-test-$PID"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $runs = Join-Path $scratch 'runs.txt'
    $marker = Join-Path $scratch 'second-run'
    $herdrStandIn = ${function:herdr}
    Remove-Item Function:\herdr
    $env:PATH = "$env:SystemRoot\System32"; $env:LOCALAPPDATA = $scratch; $env:USERPROFILE = $scratch
    Assert (-not (Get-Command herdr -ErrorAction SilentlyContinue)) 'The herdr installer cases need a session without herdr'
    $slow = 'echo curl: (28) Operation too slow. Less than 1024 bytes/sec transferred the last 30 seconds 1>&2'
    $attempts = { @(Get-Content -LiteralPath $runs -ErrorAction SilentlyContinue).Count }

    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'could not be downloaded' -and (& $attempts) -eq 2) "A download that fails twice must be tried twice and named as a download: $message"

    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'security software' -and (& $attempts) -eq 1) "A stop without a download error must not be retried: $message"

    # The second try succeeds: the script goes on to ask herdr its version, and this session has none.
    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nif exist `"$marker`" exit /b 0`r`necho.>`"$marker`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -and $message -notmatch 'could not be downloaded|did not finish' -and (& $attempts) -eq 2) "A download that succeeds on the second try must carry on: $message"
    Write-Host 'PASS herdr installer: a failed download is retried once and named, a silent stop is not retried'
} finally {
    $env:PATH = $originalPath
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:USERPROFILE = $originalUserProfile
    $env:OVIS_FROM_SOURCE = $originalFromSource
    Remove-Item Env:\OVIS_RELEASES_URL -ErrorAction SilentlyContinue
    if ($binaryScratch) { Remove-Item -LiteralPath $binaryScratch -Recurse -Force -ErrorAction SilentlyContinue }
    if ($herdrStandIn) { Set-Item Function:\herdr $herdrStandIn }
    if ($scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $ghStandIn -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
}
