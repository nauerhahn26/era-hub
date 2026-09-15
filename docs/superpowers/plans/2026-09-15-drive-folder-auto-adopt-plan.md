# Drive folder auto-adoption — plan (2026-09-15)

## The bug (traced on the home tablet, dad's fresh v0.33.1 install, 9/15)

Drive for Desktop installed + signed into the family account, `G:\My Drive\New
ERA Content` fully synced down with books/music/movies/content/clothing — and
every app empty. `/integrations/drive/status`: `signedIn:true, localRoots:
["G:\My Drive"], folderPath:"", lastSync:null`; `data\` has no `drive.json`.

`folderPath` is only ever written by two Settings taps — `setLocalFolder()`
("Use this folder") and `createContentFolder()` ("✨ Create it for me").
`detectLocal()` finds the mount and never looks inside it; `start()` arms the
10-minute mirror only when `drive.json` already names a folder. Nothing was
written for the second-device / reinstall case. Dad stopped at step 3 because
its copy ("Create your content folder … makes New ERA Content in your Drive")
reads as "make a duplicate" when the folder already exists.

Second gap: after either tap the Settings page fires ONE sync, but the
10-minute timer is never armed until the hub restarts (`start()` is the only
place that arms it).

## Design (approved by dad 9/15: "Please fix and then when I update the app it should just work")

1. **Auto-adopt** — `drive.adoptLocal()`: when `drive.json` names no folder and
   no API token, walk `detectLocal().roots`; the first `<root>\New ERA Content`
   holding at least one `MIRROR_SUBDIRS` directory becomes `folderPath`
   (mode "local"), saved, logged `[drive] adopted <path>`, timers armed, and
   `module.exports.onAdopted` fired (server.js hangs `openClothingLog` there —
   the cached `clothingLog` is the one consumer that does not read drive.json
   live). Requiring a known subfolder keeps a bare/empty lookalike untouched
   (drive-localfolder.test's INSIDE is exactly that and must still start
   with `folderPath:""`).
   Called from: `start()` (boot), `status()` (every Settings paint — cheap:
   a handful of statSync), and a 60 s `setInterval` (unref) armed by `start()`
   only while unconfigured, so a mount that appears after boot (Drive signs in
   later) is adopted with nobody at the keyboard; the interval clears itself on
   adoption.
2. **Arm the mirror when the folder is set** — extract `armLocal()` (the 60 s
   first sync + 10-minute interval, guarded so it arms once per process) and
   call it from `start()`, `setLocalFolder()`, `createContentFolder()`,
   `adoptLocal()`.
3. **Copy** — Settings step 3 becomes "3. Your content folder"; hint: "Found by
   itself when New ERA Content already exists in your Drive (another computer
   made it). Otherwise one tap makes it, with books, music, movies, content,
   and clothing folders inside — or pick a folder below." `createContentFolder`
   returns `existed:true` when the folder was already there and the toast says
   "Folder connected" instead of "Folder created".

Out of scope: API (OAuth) mode, the wizard, any change to what gets mirrored.

## Preflight

- Tests: `tests/drive-localfolder.test.mjs` (port 8442) spawns a hub with
  `ERA_DRIVE_LOCAL_ROOTS` — the seam auto-adoption is testable through.
  `tests/drive-mirror.test.mjs` uses the module directly. `tests/clothing-share.test.mjs:481`
  hits create-folder. New cases go in drive-localfolder.test.mjs (same port).
- Suite ports reach 8462 → a new suite would take 8463; not needed.
- `status()` is called from content.js/clothing.js on every tick, so the
  adoption check inside it must be a few statSync calls and nothing more.
- Timer arming must stay `.unref()` (suites spawn and SIGKILL the hub).
- The gate: `bash tools/era-gate.sh` (needs the ai-key tunnel per memory —
  run as the last step, not per task).

## Tasks (TDD, Opus implements, Fable reviews)

### T1 — drive.js: `armLocal()` + `adoptLocal()` + `onAdopted` (implementing)
Tests first, in drive-localfolder.test.mjs:
- a hub started with a named root whose `New ERA Content\books` exists boots
  with `folderPath === <root>\New ERA Content` and `mode local`; `drive.json`
  written; `lastSync` arrives within the suite's patience (use
  `ERA_DRIVE_SYNC_BOOT_MS` seam? — NO new seam: assert `folderPath` + the
  mirrored file after a POST /integrations/drive/sync instead).
- a root whose `New ERA Content` is EMPTY is not adopted (existing first test
  already asserts `folderPath:""` — keep it green).
- a root that gains `New ERA Content\music` AFTER boot is adopted on the next
  `/integrations/drive/status` (no restart).
- `setLocalFolder` / `createContentFolder` arm the mirror: module-level test —
  after `setLocalFolder(p)` a file dropped into `<p>\music` reaches `<DATA>\music`
  without calling `sync()` by hand. Timers are 60 s/10 min: make the delays
  module constants overridable by env `ERA_DRIVE_LOCAL_SYNC_MS` ONLY if the
  existing seams pattern (ERA_DRIVE_*) is followed and documented in the header
  — otherwise assert `armLocal` was called via an exported `timersArmed()`
  probe. Prefer the probe (no new timing seam).
- `createContentFolder()` on an existing folder returns `{ok, folderPath, existed:true}`.
- `onAdopted` fires once, after `drive.json` is saved.
Verify: `node --test tests/drive-localfolder.test.mjs tests/drive-mirror.test.mjs tests/clothing-share.test.mjs`.
STOP if: adoption inside `status()` changes any existing suite's first status
(look for `folderPath` assertions across tests/ before touching status()).

### T2 — server.js: hang `openClothingLog` on `drive.onAdopted` (implementing)
Set `drive.onAdopted = () => openClothingLog();` BEFORE `drive.start(DATA)` so a
boot-time adoption re-opens the log (server.js:2644–2689 order: drive.start,
onSynced, clothing.start, openClothingLog — adoption at start() fires before
openClothingLog() runs anyway; the hook matters for the 60 s poll and the
status() path). Test: in clothing-share.test.mjs style, a hub booted on a root
with an existing folder reports `sharing.mode === "drive"` in /clothing/status
without any tap.

### T3 — Settings copy + toast (implementing)
`public/settings/index.html:1205–1211`: title/hint per Design 3; toast reads
`r.existed ? "Folder connected" : "Folder created in your Drive"`. No test
infra for the page beyond the existing settings smoke — verify by grep + a
scratch hub screenshot (8480+ per memory) if cheap; otherwise visual check on
the tablet after the update.

### T4 — behavioral verification + release (collaborating: signing needs dad's code)
- Scratch hub on the QA box with `ERA_DRIVE_LOCAL_ROOTS=<tmp>/My Drive` where
  `New ERA Content/music/manifest.json` exists: within 90 s `GET /integrations/drive/status`
  shows `folderPath` set and `lastSync.files ≥ 1`; `<data>/music/manifest.json` exists.
- Gate green → `tools/release.sh v0.33.2` (signing preflight first; the
  SimplySign login may need dad's 6-digit app code — ask, stage, enter within
  seconds). VM e2e 14/14. Publish.
- Tablet: `POST /update/check` through the 8503 tunnel (or wait ≤6 h); then
  `/integrations/drive/status` on the tablet shows `folderPath G:\My Drive\New ERA Content`
  and the reader/music/movies/clothing populate with no tap. That is the
  acceptance test dad asked for ("when I update the app it should just work").
