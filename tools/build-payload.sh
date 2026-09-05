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
# a RELEASE payload (bundled Windows node) — the cut, not a dev assemble
RELEASE=0
if [ "${1:-}" = "--with-node" ] || [ "${2:-}" = "--with-node" ]; then RELEASE=1; fi

rm -rf "$OUT"; mkdir -p "$OUT/public"
cp "$HUB/server.js" "$HUB/predict.js" "$HUB/pool.js" "$HUB/update.js" "$HUB/packs.js" "$HUB/drive.js" "$HUB/clothing.js" "$HUB/clothing-worker.js" "$HUB/clothing-photos.js" "$HUB/content.js" "$HUB/content-worker.js" "$HUB/content-store.js" "$HUB/content-ingest.js" "$HUB/content-imprint.js" "$HUB/content-narrate.js" "$HUB/content-providers.js" "$HUB/content-publish.js" "$HUB/content-animate.js" "$HUB/music-add.js" "$HUB/movies-add.js" "$HUB/movies-lookup.js" "$HUB/words.js" "$HUB/segment.js" "$HUB/slug.js" "$HUB/books-index.js" "$HUB/image-orient.js" "$HUB/image-util.js" "$HUB/ai-config.js" "$HUB/notify.js" "$HUB/predict-model.json" "$OUT/"
# every local require of the hub's modules must resolve INSIDE the payload —
# a module added to the repo but not to the list above shipped a hub that
# died on its first line (packs.js, caught by the VM e2e 9/3, never by the
# tier-1 gate, which runs from the checkout).
# A WORKER is loaded by PATH, not by require, so it is invisible to a grep for
# require() — clothing-worker.js and content-worker.js would have gone missing
# in exactly the same silent way. Both forms are collected here.
workers="$(grep -ho 'new Worker(path\.join(__dirname, "[a-z-]*\.js")' "$OUT"/*.js | sed 's/.*__dirname, "//; s/\.js")$//' | sort -u)"
for m in $(grep -ho 'require("\./[a-z-]*\(\.js\)\?")' "$OUT"/*.js | sed 's/require("\.\///; s/")//; s/\.js$//' | sort -u) $workers; do
  [ -f "$OUT/$m.js" ] || { echo "build-payload: $m.js is required by the hub but not in the payload"; exit 1; }
done
cp -r "$HUB/vendor" "$OUT/vendor"   # HEIC decode (libheif, LGPL - see NOTICE) + jpeg-js
# ...but NOT the media-tools binary. .gitignore expects a developer to drop a
# local vendor/yt-dlp in for testing, and the blanket copy above would ship it
# as the pack without ever checking its hash. The only copy allowed in a
# payload is the pinned one laid down below. "Wrong hash = no build, ever."
rm -rf "$OUT/vendor/yt-dlp"
# Garment cut-out (dad 9/1: "add the 50mb so trim is nice looking") — U^2-Net
# u2netp, the same model her Python pipeline uses, run through ONNX Runtime's
# WEBASSEMBLY build. Deliberately not the native binding: a clean Windows 10
# ships no Visual C++ runtime, so the .node refused to load on the QA machine
# and would fail the same way on a family's fresh PC. WASM needs only Node.
du -sh "$OUT/vendor/onnxruntime-web" "$OUT/vendor/models" 2>/dev/null || true

# media-tools pack (packs.js): yt-dlp.exe, the downloader behind Music's
# "+ Add a song". ~18 MB of standalone Windows binary (it bundles its own
# Python), so it is NOT committed — it is fetched from the release PINNED in
# tools/yt-dlp.pin, checked against that release's own sha256, and kept on the
# same shelf as the bundled node.exe so a re-build never re-downloads it.
# Wrong hash = no build, ever. Missing (no network on a dev box) = the pack is
# simply absent from a dev payload; on a release cut it stops the cut.
# shellcheck source=./yt-dlp.pin
. "$HUB/tools/yt-dlp.pin"
YTDLP="$ROOT/era-family/cache/yt-dlp-$YTDLP_VERSION.exe"
ytdlp_sha_ok() { [ -f "$YTDLP" ] && [ "$(sha256sum "$YTDLP" | cut -d' ' -f1)" = "$YTDLP_EXE_SHA256" ]; }
if ! ytdlp_sha_ok; then
  URL="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp.exe"
  echo "fetching yt-dlp $YTDLP_VERSION (media-tools pack)"
  mkdir -p "$(dirname "$YTDLP")"
  if curl -fsSL --retry 2 -o "$YTDLP.part" "$URL"; then
    mv "$YTDLP.part" "$YTDLP"
    ytdlp_sha_ok || { echo "yt-dlp.exe DOES NOT MATCH tools/yt-dlp.pin ($YTDLP_EXE_SHA256) - refusing to ship it"; rm -f "$YTDLP"; exit 1; }
  else
    rm -f "$YTDLP.part"
    if [ "$RELEASE" = 1 ]; then
      echo "could not download $URL - the media-tools pack is part of a release; no build."
      exit 1
    fi
    echo "note: yt-dlp not available (no network?) - this payload ships without the media-tools pack"
  fi
fi
if ytdlp_sha_ok; then
  mkdir -p "$OUT/vendor/yt-dlp"
  cp "$YTDLP" "$OUT/vendor/yt-dlp/yt-dlp.exe"
fi
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
# the book review page (spec §5) — CORE, like settings/home/reader: it is the
# only builder UI, it is a few KB of html, and a family whose book came out with
# its pages in the wrong order needs it on the machine that built the book. No
# /x in installer.nsi: every /x there belongs to a pack (tests/packs.test.mjs).
cp -r "$HUB/public/book-review" "$OUT/public/book-review"
cp "$HUB/public/favicon.ico" "$OUT/public/favicon.ico"
cp -r "$HUB/public/icons" "$OUT/public/icons"   # per-app icons (tiles + shortcuts)

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
rem %~2, not %2: the shortcut quotes the page ("/board/?recipe=songs"); re-quoting
rem the quoted form puts its = outside the quotes, where cmd reads a delimiter
rem and the Music/Movies icons did nothing at all (VM QA 9/5)
if "%~2"=="" (set OPEN=/home/) else (set OPEN=%~2)
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
rem QA only: the unattended VM e2e drives this very window over DevTools.
rem The flag exists only when the launcher's environment sets ERA_QA_CDP —
rem a family's double-click never has it.
set CDP=
if defined ERA_QA_CDP set CDP=--remote-debugging-port=%ERA_QA_CDP%
start "" "%B%" --kiosk "http://127.0.0.1:%PORT%%OPEN%" --edge-kiosk-type=fullscreen --user-data-dir="%~dp0data\kiosk-profile" --no-first-run --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required %CDP%
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
