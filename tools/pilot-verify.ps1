# pilot-verify.ps1 — on-device proof for the New ERA payload (staging device).
# Pulls the payload tarball from the family hub, extracts, starts the bundled-Node
# hub on a local test port, probes the apps, stops it. Leaves the folder in place
# (inert — nothing autostarts) so a human can double-click start-hub.bat later.
param(
  [string]$Hub  = "http://127.0.0.1:8377",   # pass your family hub URL at run time
  [string]$Base = "C:\Users\Public\Documents\new-era-pilot",
  [int]$Port    = 8378
)
$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $Base | Out-Null
Set-Location $Base
& curl.exe -s -o payload.tar.gz "$Hub/dist-payload.tar.gz"
if (-not (Test-Path payload.tar.gz)) { Write-Output "PILOT-FAIL: download"; exit 1 }
if (Test-Path new-era-payload) { Remove-Item -Recurse -Force new-era-payload }
& tar.exe -xzf payload.tar.gz
if (-not (Test-Path "new-era-payload\node\node.exe")) { Write-Output "PILOT-FAIL: no bundled node"; exit 1 }

$env:ERA_DATA_DIR = "$Base\new-era-payload\data"
$p = Start-Process -FilePath "$Base\new-era-payload\node\node.exe" `
      -ArgumentList "server.js", "$Port" -WorkingDirectory "$Base\new-era-payload" `
      -WindowStyle Hidden -PassThru
try {
  $up = $false
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    $code = & curl.exe -s -o NUL -w "%{http_code}" "http://127.0.0.1:$Port/settings"
    if ($code -eq "200") { $up = $true; break }
  }
  if (-not $up) { Write-Output "PILOT-FAIL: server never answered"; exit 1 }
  foreach ($path in @("/settings", "/", "/pencil/", "/board/", "/predict?prefix=ca")) {
    $code = & curl.exe -s -o NUL -w "%{http_code}" "http://127.0.0.1:$Port$path"
    Write-Output "PILOT $path -> $code"
    if ($code -ne "200") { Write-Output "PILOT-FAIL: $path"; exit 1 }
  }
  $ver = Get-Content "$Base\new-era-payload\VERSION"
  Write-Output "PILOT-PASS: payload $ver runs on-device with bundled node (data dir: $env:ERA_DATA_DIR)"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
