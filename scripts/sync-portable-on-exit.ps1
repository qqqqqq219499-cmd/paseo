# Watcher: wait for the portable Paseo to exit, then sync win-unpacked -> portable and relaunch.
# Designed to run via Task Scheduler (detached from the Paseo process tree), so it
# survives the Paseo daemon (and the agent that armed it) shutting down.
# Usage: powershell -NoProfile -File scripts/sync-portable-on-exit.ps1 [-Relaunch]
param(
  [switch]$Relaunch = $true,
  [int]$TimeoutMinutes = 60
)
$ErrorActionPreference = 'Stop'
$repo = 'E:\paseo-official'
$source = Join-Path $repo 'packages\desktop\release\win-unpacked'
$portable = 'D:\Apps\Paseo-portable'
$log = Join-Path $repo '.tmp-portable-watcher.log'

function Log($msg) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

Log 'watcher started, waiting for portable Paseo to exit'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ($true) {
  $running = Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$portable\*" }
  if (-not $running) { break }
  if ((Get-Date) -gt $deadline) {
    Log "TIMEOUT after $TimeoutMinutes min, giving up"
    exit 1
  }
  Start-Sleep -Seconds 5
}

Log 'Paseo exited, syncing'
robocopy $source $portable /MIR /NFL /NDL /NJH /NJS /R:2 /W:5 | Out-Null
if ($LASTEXITCODE -gt 7) {
  Log "robocopy failed, exit=$LASTEXITCODE"
  exit $LASTEXITCODE
}
Log "sync done (robocopy exit=$LASTEXITCODE)"

if ($Relaunch) {
  Start-Process (Join-Path $portable 'Paseo.exe')
  Log 'relaunched Paseo'
}
