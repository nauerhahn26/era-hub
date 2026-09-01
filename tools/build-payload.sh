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
cp "$HUB/server.js" "$HUB/predict.js" "$HUB/pool.js" "$HUB/update.js" "$HUB/drive.js" "$HUB/clothing.js" "$HUB/clothing-worker.js" "$HUB/segment.js" "$HUB/predict-model.json" "$OUT/"
cp -r "$HUB/vendor" "$OUT/vendor"   # HEIC decode (libheif, LGPL - see NOTICE) + jpeg-js
# Garment cut-out (dad 9/1: "add the 50mb so trim is nice looking") — U^2-Net
# u2netp through ONNX Runtime, the same model her Python pipeline uses. Ship
# ONLY the Windows x64 CPU binaries: the npm package carries every platform and
# the DirectML/dxcompiler GPU providers we never ask for (285MB -> ~31MB).
rm -rf "$OUT/vendor/onnxruntime-node/bin/napi-v6/linux" \
       "$OUT/vendor/onnxruntime-node/bin/napi-v6/darwin" \
       "$OUT/vendor/onnxruntime-node/bin/napi-v6"/*/arm64
du -sh "$OUT/vendor/onnxruntime-node" "$OUT/vendor/models" 2>/dev/null || true
cp "$HUB/LICENSE" "$HUB/README.md" "$OUT/"; cp "$HUB/../era-core/NOTICE" "$OUT/" 2>/dev/null || true
# apps + shared foundation - COPIES, never symlinks
cp -rL "$ROOT/era-core/lib" "$OUT/public/lib"
cp "$ROOT/era-core/dwell.js" "$ROOT/era-core/speech.js" "$OUT/public/"
cp "$ROOT/era-making-words/app/index.html" "$ROOT/era-making-words/app/studio.js" "$OUT/public/"
# lesson content ships with the app (dad's 8/28 ruling) — the PUBLIC copy in
# era-making-words/content, never the family one (runway/sentences stay home)
cp "$ROOT/era-making-words/content/lessons.json" "$OUT/public/lessons.json"
# ERAgaze engine SOURCE ships (dad 8/29: gaze is the point of the product).
# The hub compiles it on-device with Windows' built-in csc and pairs it with
# the Tobii runtime already present on Tobii devices (NuGet fallback) — we
# never redistribute Tobii's binaries.
mkdir -p "$OUT/gaze"
cp "$ROOT/era-gaze/device/ERAgaze.cs" "$OUT/gaze/ERAgaze.cs"
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
rem   start-hub.bat [port] [path]   path = which app page to open (default /home/)
title New ERA
echo Starting New ERA...
cd /d %~dp0
if "%1"=="" (set PORT=8377) else (set PORT=%1)
if "%2"=="" (set OPEN=/home/) else (set OPEN=%~2)
if not defined ERA_DATA_DIR set ERA_DATA_DIR=%~dp0data
rem already running? just open the page (dad's 8/29 double-click pile-up)
curl.exe -s -o NUL --max-time 2 http://127.0.0.1:%PORT%/settings
if not errorlevel 1 goto open
set NODE=node
if exist "%~dp0node\node.exe" set NODE=%~dp0node\node.exe
start "New ERA hub" /min "%NODE%" server.js %PORT%
timeout /t 2 /nobreak >nul
:open
rem full-screen, chrome-less app experience (dad 8/29): kiosk mode in Chrome
rem or Edge with its own profile; a plain browser tab only as a last resort.
rem Leave an app via its door (back to the hub home); leave the window with
rem Alt+F4 or the gaze engine's exit.
rem (explicit paths: under a 32-bit parent, %ProgramFiles% lies — dad's first
rem launch fell back to Edge because the installer is a 32-bit process)
set B=
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set B=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set B=C:\Program Files\Google\Chrome\Application\chrome.exe
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set B=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
if not defined B (
  start "" http://127.0.0.1:%PORT%%OPEN%
  goto done
)
start "" "%B%" --kiosk "http://127.0.0.1:%PORT%%OPEN%" --edge-kiosk-type=fullscreen --user-data-dir="%~dp0data\kiosk-profile" --no-first-run --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required
:done
BAT
cat > "$OUT/start-hub.sh" <<'SH'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export ERA_DATA_DIR="${ERA_DATA_DIR:-$PWD/data}"
exec node server.js "${1:-8377}"
SH
chmod +x "$OUT/start-hub.sh"

# The double-clickable front door. NO PowerShell anywhere in the package:
# Defender's download-time ML flagged the zip (Sabsik.FL.A!ml — the classic
# bat-invokes-powershell-Bypass false-positive profile, 8/29), and the same
# behavioral engine was what killed the updater's cmd relaunch ("spawn
# EPERM"). App choice + shortcuts happen in the welcome wizard; the hub
# writes the .lnk files itself. Uninstall is plain batch.
cat > "$OUT/INSTALL.bat" <<'BAT'
@echo off
rem Starts New ERA and opens the welcome screen - pick your apps there.
call "%~dp0start-hub.bat"
BAT
cat > "$OUT/UNINSTALL.bat" <<'BAT'
@echo off
rem Removes the shortcuts and stops New ERA. Your data folder stays yours.
taskkill /IM node.exe /F >nul 2>&1
for %%d in ("%USERPROFILE%\Desktop" "%APPDATA%\Microsoft\Windows\Start Menu\Programs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup") do (
  for %%n in ("New ERA" "Making Words" "The Pencil" "Board" "Music" "Movies" "Book Reader") do (
    del /q "%%~d\%%~n.lnk" >nul 2>&1
  )
)
echo UNINSTALL-OK: shortcuts removed, hub stopped. Your data stays in %~dp0data
pause
BAT

echo "$VERSION" > "$OUT/VERSION"

# L3: never ship what hasn't been scanned
SCAN="$ROOT/era-family/tools/era-scan.sh"
if [ -x "$SCAN" ]; then bash "$SCAN" "$OUT" || { echo "PAYLOAD SCAN FAILED - not shippable"; exit 1; }
else echo "note: era-scan not present (CI injects denylists there)"; fi

tar -C "$(dirname "$OUT")" -czf "$OUT-$VERSION.tar.gz" "$(basename "$OUT")"
echo "payload: $OUT ($VERSION); tarball: $OUT-$VERSION.tar.gz"
