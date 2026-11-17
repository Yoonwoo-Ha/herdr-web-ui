param([Parameter(Mandatory = $true)][string]$NewExe, [string]$Herdr = '')
$ErrorActionPreference = 'Stop'
$failed = 0
function Step([string]$What, [scriptblock]$Body) {
    try { & $Body } catch { Write-Output "could not $What`: $($_.Exception.Message)"; $script:failed++ }
}

$dir = Join-Path $env:LOCALAPPDATA 'Programs\Ovis'
$exe = Join-Path $dir 'Ovis.exe'
$newPath = [IO.Path]::GetFullPath($NewExe)
if ($newPath -ieq [IO.Path]::GetFullPath($exe)) { exit 0 }

function IsOldSetup([string]$Path) {
    if (-not $Path -or [IO.Path]::GetFullPath($Path) -ieq $newPath -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $info = (Get-Item -LiteralPath $Path).VersionInfo
    return $info.CompanyName -eq 'Ovis' -and $info.ProductName -eq 'Ovis' -and $info.LegalCopyright -eq 'Ovis contributors' -and $info.OriginalFilename -eq 'Ovis.exe'
}

$present = Test-Path -LiteralPath $exe -PathType Leaf
if ($present -and -not (IsOldSetup $exe)) {
    Write-Output "left $exe alone: it is not Ovis for Windows"
    exit 0
}

function FindHerdr {
    $dirs = @((Join-Path $env:USERPROFILE '.bun\bin'), (Join-Path $env:LOCALAPPDATA 'Programs\Herdr\bin')) +
        ([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
    foreach ($dir in $dirs) {
        if (-not $dir.Trim()) { continue }
        foreach ($extension in '.exe', '.cmd', '.bat') {
            try {
                $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($dir.Trim())) ('herdr' + $extension)
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            } catch { }
        }
    }
    return $null
}

function OvisPluginState {
    $herdr = if ($Herdr) { $Herdr } else { FindHerdr }
    if (-not $herdr) { return 'absent' }
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo $herdr
        $start.Arguments = 'plugin list --json'
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.CreateNoWindow = $true
        $process = [System.Diagnostics.Process]::Start($start)
        $output = $process.StandardOutput.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); return 'unknown' }
        if ($process.ExitCode -ne 0) { return 'unknown' }
        $json = @($output.Result -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') })[0]
        $plugins = (ConvertFrom-Json $json).result.plugins
        if ($null -eq $plugins) { return 'unknown' }
        $listed = @($plugins | Where-Object { ($_.plugin_id -eq 'devswha.ovis' -or $_.plugin_id -eq 'devswha.herdr-web-ui') -and $_.plugin_root })
        return $(if ($listed.Count -gt 0) { 'present' } else { 'absent' })
    } catch {
        return 'unknown'
    }
}
$plugin = OvisPluginState
$keepStart = $plugin -ne 'absent'

Step 'close its windows' {
    # a second download saves as Ovis (1).exe
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'Ovis%.exe'")) {
        if (IsOldSetup $process.ExecutablePath) {
            $running = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
            if ($running -and $running.CloseMainWindow()) { Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
            if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
            }
            Write-Output "closed its window $($process.ExecutablePath) (pid $($process.ProcessId))"
        }
    }
}

if ($plugin -eq 'present') {
    Write-Output "kept its sign-in start and $exe`: they start herdr's server at sign-in for the Ovis plugin"
} elseif ($plugin -eq 'unknown') {
    Write-Output "kept its sign-in start and $exe`: herdr did not say whether the Ovis plugin is installed"
} else {
    Step 'remove its sign-in start' {
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $value = (Get-ItemProperty -Path $runKey -Name Ovis -ErrorAction SilentlyContinue).Ovis
        if ($value -ieq ('"' + $exe + '" --start')) {
            Remove-ItemProperty -Path $runKey -Name Ovis
            Write-Output 'removed its sign-in start'
        }
    }
}

Step 'remove its shortcuts' {
    $shell = New-Object -ComObject WScript.Shell
    $links = @()
    foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        if (-not $folder) { continue }
        $links += @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse:($folder -eq [Environment]::GetFolderPath('Programs')) -ErrorAction SilentlyContinue)
    }
    foreach ($file in $links) {
        if ($shell.CreateShortcut($file.FullName).TargetPath -ieq $exe) {
            # Explorer may hold a shortcut open for a moment
            for ($try = 1; ; $try++) {
                try { Remove-Item -LiteralPath $file.FullName -Force; break }
                catch { if ($try -ge 5) { throw }; Start-Sleep -Milliseconds 500 }
            }
            Write-Output "removed its shortcut $($file.FullName)"
        }
    }
}

if ($present -and -not $keepStart) {
    Step "remove $exe" {
        Remove-Item -LiteralPath $exe -Force
        Write-Output "removed $exe"
        if (-not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
    }
}
exit $failed
