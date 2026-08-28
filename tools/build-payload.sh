#!/usr/bin/env bash
# build-payload.sh - assemble a self-contained, no-symlink New ERA payload from
# the sibling module repos: everything a machine with Node 18+ needs to run the
# hub + apps locally. This is the precursor of the Windows installer (which
# adds a bundled Node runtime + shortcuts + tray).
# The payload contains NO family data and NO secrets: first run creates ./data
# next to it (or set ERA_DATA_DIR). Release QC: the built payload is scanned
# (era-scan) before it is considered shippable.
set -euo pipefail
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
# Default output lives INSIDE this checkout (worktree-safe: the old $ROOT/dist
# default made a worktree run rm -rf the main checkout's reference payload).
# `--with-node` as the first arg is a flag, not an output dir.
OUT="${1:-$HUB/dist/new-era-payload}"
[ "$OUT" = "--with-node" ] && OUT="$HUB/dist/new-era-payload"
VERSION="$(date -u +%Y%m%d.%H%M)"

rm -rf "$OUT"; mkdir -p "$OUT/public"
cp "$HUB/server.js" "$HUB/predict.js" "$HUB/pool.js" "$HUB/predict-model.json" "$OUT/"
cp "$HUB/LICENSE" "$HUB/README.md" "$OUT/"; cp "$HUB/../era-core/NOTICE" "$OUT/" 2>/dev/null || true
# apps + shared foundation - COPIES, never symlinks
cp -rL "$ROOT/era-core/lib" "$OUT/public/lib"
cp "$ROOT/era-core/dwell.js" "$ROOT/era-core/speech.js" "$OUT/public/"
cp "$ROOT/era-making-words/app/index.html" "$ROOT/era-making-words/app/studio.js" "$OUT/public/"
# lesson content ships with the app (dad's 8/28 ruling) — the PUBLIC copy in
# era-making-words/content, never the family one (runway/sentences stay home)
cp "$ROOT/era-making-words/content/lessons.json" "$OUT/public/lessons.json"
cp -r "$ROOT/era-pencil/app" "$OUT/public/pencil"
cp -r "$ROOT/era-board/app" "$OUT/public/board"
cp -r "$HUB/public/settings" "$OUT/public/settings"
cp -r "$HUB/public/home" "$OUT/public/home"
cp -r "$HUB/public/reader" "$OUT/public/reader"
cp "$HUB/public/favicon.ico" "$OUT/public/favicon.ico"

# --with-node: bundle a portable Windows Node runtime (no install needed)
if [ "${2:-}" = "--with-node" ] || [ "${1:-}" = "--with-node" ]; then
  NODE_EXE="$ROOT/era-family/cache/node-22-win-x64.exe"
  [ -f "$NODE_EXE" ] || { echo "missing $NODE_EXE (download once from nodejs.org dist)"; exit 1; }
  mkdir -p "$OUT/node"; cp "$NODE_EXE" "$OUT/node/node.exe"
fi

cat > "$OUT/start-hub.bat" <<'BAT'
@echo off
rem New ERA hub - local-first: binds 127.0.0.1, state lives in .\data
cd /d %~dp0
if "%1"=="" (set PORT=8377) else (set PORT=%1)
if not defined ERA_DATA_DIR set ERA_DATA_DIR=%~dp0data
set NODE=node
if exist "%~dp0node\node.exe" set NODE=%~dp0node\node.exe
start "New ERA hub" /min "%NODE%" server.js %PORT%
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/home/
BAT
cat > "$OUT/start-hub.sh" <<'SH'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export ERA_DATA_DIR="${ERA_DATA_DIR:-$PWD/data}"
exec node server.js "${1:-8377}"
SH
chmod +x "$OUT/start-hub.sh"
cat > "$OUT/install.ps1" <<'PS1'
# install.ps1 - per-user setup for the New ERA payload: shortcuts + optional
# autostart. No admin needed; nothing leaves this folder except .lnk files.
param([switch]$AutoStart)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$W = New-Object -ComObject WScript.Shell
function Mk($dir, $name) {
  $lnk = $W.CreateShortcut((Join-Path $dir "$name.lnk"))
  $lnk.TargetPath = Join-Path $Here "start-hub.bat"
  $lnk.WorkingDirectory = $Here
  $lnk.Description = "New ERA Communications - local eye-gaze apps"
  $lnk.Save()
}
Mk ([Environment]::GetFolderPath("Desktop")) "New ERA"
$sm = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
Mk $sm "New ERA"
if ($AutoStart) { Mk ([Environment]::GetFolderPath("Startup")) "New ERA" }
Write-Output "INSTALL-OK: shortcuts created$(if($AutoStart){' (+autostart)'})"
PS1
cat > "$OUT/uninstall.ps1" <<'PS1'
# uninstall.ps1 - removes shortcuts and stops the hub; NEVER touches .\data -
# your family's content, settings, and history stay yours.
$ErrorActionPreference = "SilentlyContinue"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($d in @([Environment]::GetFolderPath("Desktop"),
                 (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"),
                 [Environment]::GetFolderPath("Startup"))) {
  Remove-Item (Join-Path $d "New ERA.lnk") -Force
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*$Here*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Output "UNINSTALL-OK: shortcuts removed, hub stopped. Family data kept at $Here\data"
PS1

echo "$VERSION" > "$OUT/VERSION"

# L3: never ship what hasn't been scanned
SCAN="$ROOT/era-family/tools/era-scan.sh"
if [ -x "$SCAN" ]; then bash "$SCAN" "$OUT" || { echo "PAYLOAD SCAN FAILED - not shippable"; exit 1; }
else echo "note: era-scan not present (CI injects denylists there)"; fi

tar -C "$(dirname "$OUT")" -czf "$OUT-$VERSION.tar.gz" "$(basename "$OUT")"
echo "payload: $OUT ($VERSION); tarball: $OUT-$VERSION.tar.gz"
