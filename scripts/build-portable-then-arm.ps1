# Detached BuildOnly + arm PaseoPortableSync. Safe to run under Task Scheduler.
$ErrorActionPreference = 'Stop'
$env:PATH = 'D:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;' + $env:PATH
$repo = 'E:\paseo-official'
$log = Join-Path $repo '.tmp-portable-build-now.out'
$err = Join-Path $repo '.tmp-portable-build-now.err'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

function Log($msg) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

Set-Location $repo
"[$stamp] detached build-then-arm starting" | Set-Content -Path $log -Encoding utf8
'' | Set-Content -Path $err -Encoding utf8

try {
  Log 'running dev-portable.ps1 -BuildOnly'
  & (Join-Path $repo 'scripts\dev-portable.ps1') -BuildOnly *>> $log
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
  Log "build exit=$code"
  if ($code -ne 0) {
    Log 'BUILD FAILED — not arming watcher'
    exit $code
  }

  Log 'arming PaseoPortableSync'
  $run = schtasks /run /tn PaseoPortableSync 2>&1 | Out-String
  Log ("schtasks: " + $run.Trim())
  Log 'done: close portable Paseo to sync+relaunch'
  exit 0
} catch {
  Log ("EXCEPTION: " + $_.Exception.Message)
  $_ | Out-String | Add-Content -Path $err
  exit 1
}
