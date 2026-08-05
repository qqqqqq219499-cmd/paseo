# Paseo portable (no-installer) one-click iteration:
# build (skip NSIS) -> sync to D:\Apps\Paseo-portable
# Usage: powershell -File scripts/dev-portable.ps1 [-BuildOnly]
# Note: quit the running portable Paseo first, or the sync will fail on the locked exe.
# -BuildOnly: build while Paseo is still running, skip the sync; afterwards run
#   schtasks /run /tn PaseoPortableSync  to sync+relaunch automatically on exit.
param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$env:PATH = 'D:\Program Files\nodejs;' + $env:PATH
$repo = 'E:\paseo-official'
$portable = 'D:\Apps\Paseo-portable'

if (-not $BuildOnly) {
  $running = Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$portable\*" }
  if ($running) {
    Write-Host 'Portable Paseo is running. Quit it first, then re-run this script.' -ForegroundColor Red
    exit 1
  }
}

Set-Location $repo
Write-Host '== 1/4 build:app-deps ==' -ForegroundColor Cyan
npm run build:app-deps
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== 2/4 expo export (electron web) ==' -ForegroundColor Cyan
Push-Location (Join-Path $repo 'packages\app')
npx cross-env PASEO_WEB_PLATFORM=electron npx expo export --platform web
$expoExit = $LASTEXITCODE
Pop-Location
if ($expoExit -ne 0) { exit $expoExit }

Write-Host '== 3/4 electron-builder --dir (portable, skip NSIS) ==' -ForegroundColor Cyan
npm run build --workspace=@getpaseo/desktop -- --dir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($BuildOnly) {
  Write-Host 'Build done. Now arm the watcher:  schtasks /run /tn PaseoPortableSync' -ForegroundColor Green
  Write-Host 'It syncs and relaunches Paseo as soon as you quit the app.' -ForegroundColor Green
  exit 0
}

Write-Host '== 4/4 sync to portable dir ==' -ForegroundColor Cyan
robocopy (Join-Path $repo 'packages\desktop\release\win-unpacked') $portable /MIR /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -gt 7) { exit $LASTEXITCODE }

Write-Host "Done: $portable\Paseo.exe is up to date." -ForegroundColor Green
