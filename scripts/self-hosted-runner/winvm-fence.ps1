# winvm-fence.ps1 [-IncludeOwn]: keeps the other repositories' runners in winvm (services kept in its snapshot) from
# taking a job. Stops every such runner service that is not in a job, and leaves one that is in a job to finish it. It
# reads the workers again right before each stop, so a service that took a job while an earlier one stopped keeps it.
# Prints "FENCE <runner services not stopped> <Runner.Worker processes>": "FENCE 0 0" means none can take or run a job
# until the next reset starts them again. Used by winvm-job-started.ps1 before this runner's job and, over ssh with
# -IncludeOwn, by winvm-runner.sh before a reset: then this runner's own job counts as well (the ssh that watched it
# can end while the job goes on), and its idle listener is ended first so it takes none. A service's worker can only
# appear between a worker read and that service's Stop-Service, milliseconds apart.
param([switch]$IncludeOwn)
$ErrorActionPreference = 'Stop'
$own = 'C:\actions-runners\ovis-win\*'
$workers = { @(Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike $own }) }
$mine = { @(Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue | Where-Object { $_.Path -like $own }) }
$services = { @(Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%' AND State <> 'Stopped'") }
foreach ($service in & $services) {
    $busy = @(& $workers | ForEach-Object { Split-Path (Split-Path $_.Path) })
    if ($busy -notcontains (Split-Path (Split-Path $service.PathName.Trim('"')))) {
        Stop-Service -Name $service.Name
        Write-Output "Stopped $($service.Name)"
    }
}
$count = (& $workers).Count
if ($IncludeOwn) {
    if ((& $mine).Count -eq 0) {
        Get-Process -Name Runner.Listener -ErrorAction SilentlyContinue | Where-Object { $_.Path -like $own } |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
    $count += (& $mine).Count
}
'FENCE {0} {1}' -f (& $services).Count, $count
