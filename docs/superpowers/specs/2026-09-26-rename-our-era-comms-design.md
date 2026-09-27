# Rename the software: New ERA → Our Era Comms — design

Date: 2026-09-26. Owner: dad. Repos: era-hub (this), era-board, era-gaze,
era-making-words, plus one line in era-website. Sibling of the site feature
(era-website `docs/superpowers/specs/2026-09-25-foundation-site-design.md`),
which ships FIRST; this feature follows and removes the site's interim line.

## Names (dad, 9/26)

- Short name, every surface a person sees or hears: **Our Era Comms**
  (desktop and Start Menu shortcut, window titles, hub home and settings
  screens, the update screen, the board's spoken partner prompts, the reader,
  release titles, the signing description `-n`).
- Full name, where the product is introduced: **Our Era Communication Tools**
  (installer product name and Apps & features DisplayName, home page title,
  llms/README lines). Publisher field: **Our Era Foundation**.
- Installer file: `Our-Era-Comms-Setup.exe`. Signing `-i` URL:
  `https://ourerafoundation.org/communications/`.
- The signing certificate is an individual "Open Source Developer" cert in the
  maintainer's own name, not the product's, and does not change, so SmartScreen
  reputation carries over untouched (verified 9/26; Certum, valid to 2027-09-05).

## What changes (about 180 user-visible strings + ~270 doc/test mentions)

era-hub: `tools/installer.nsi` (APPNAME, DisplayName, Publisher, finish-page
text, section name, shortcut names), `tools/build-dist.sh` + `release.sh` +
`.github/workflows/build-installer.yml` (installer OutFile, release titles and
notes), `tools/sign-installer.sh` (`-n`, `-i`), `tools/build-payload.sh`
(start-hub.bat title and echo, the uninstall batch's shortcut list),
`server.js` (`appShortcut` title and ~20 messages), `public/home`,
`public/settings` (update screen, door button, hints), `public/book-review`,
`public/reader/*`, `music-add.js`, `movies-*.js` (User-Agent → "Our Era Comms
hub (family use)"), `books-share.js` + `erabook.js` (messages; the envelope's
`from.app` becomes "Our Era Comms" and import keeps accepting both), `content.js`.
era-board: `app/board-partner.js` (17 spoken prompts), `board.js`,
`board-arrange.js`. era-gaze: extension manifest name → "Our Era Comms Watch
Companion". era-making-words: `app/studio.js` start-screen string (and its
domain). Docs, tests and CI names follow in the same commits.

## Paths and identifiers: renamed in phases, not skipped (dad, 9/26)

Dad: "Why can't we change all paths and just reroute TD Snap links, we have the
tools." We can. What matters is ORDER, because a board tile that points at a
folder which does not exist yet is a dead tile on her board (9/16 lesson).

Phase R1 (this signed release, v0.36.0). Every user-visible name (section
above). PREFLIGHT 9/26 (update.js:18,124,54): self-update is an IN-PROCESS
overlay into `__dirname` by the running hub, which then re-spawns itself; a
process cannot move the folder it runs from, and post-exit batch/PowerShell
helpers have a Defender history here. So the install folder moves ONLY when
nothing runs from it:
  - fresh install: `InstallDir "$LOCALAPPDATA\Our Era Comms"`, uninstall key
    `OurEraComms`, `Our Era Comms.lnk` on Desktop + Start Menu;
  - the new installer run over an old install (`.onInit`): stop node.exe and
    ERAgaze.exe, rename `New ERA` → `Our Era Comms`, junction old → new,
    delete the `NewERA` key and the old-name .lnk files, then install into
    the new folder (`data\` rides along; the wizard step is skipped as today);
  - a device that only self-updates keeps its folder until the installer or
    the device runbook (ssh: stop hub, move, junction, start from the new
    start-hub.bat) touches it; the family's three devices get the runbook.
  - Boot pass (new, server.js): on every boot rewrite every hub-written .lnk
    (home door, per-app, Startup ERAgaze) with the current `__dirname` and the
    current titles, and delete `New ERA.lnk` on Desktop/Start Menu/Startup.
    This also self-heals links after a folder move.
  - Tarball top folder stays `new-era-suite/` THIS release (installed hubs
    hard-code it for pack installs, server.js:172,179); server.js learns to
    accept `our-era-comms/` too, and the folder flips in R3. Asset names
    (`new-era-suite.tar.gz`, `latest.json`) never change: feed continuity.
  - latest.json gains `"installer_file"`; build-dist.sh's `--patch` reads it
    (today it hard-codes New-ERA-Setup.exe, :165) so patches under the new
    installer work.
  - ERAgaze: default BaseDir `C:\Users\Public\ERAgaze`; at start, if it does
    not exist and `Public\RaeGaze` does, move it (Directory.Move) and create a
    junction `RaeGaze` → `ERAgaze` (`cmd /c mklink /J`, no admin needed); the
    kiosk tag match (:1437-1445, :1534-1538) accepts both names. The .bat tile
    launchers in aac-board-builder try `%LOCALAPPDATA%\Our Era Comms` first,
    then `New ERA`; re-scp them in R2.
  - start-hub.bat / UNINSTALL.bat: names only (paths are `%~dp0`-relative);
    UNINSTALL.bat also removes the old-name links.

Phase R2 (board job, after all three devices report the R1 build): the
Dashboard tiles are re-pointed from `RaeGaze\<App>.bat` to `ERAgaze\<App>.bat`
through the editor via the QA harness (Law 1: prompt dad, cloud checkpoint
first, `tools/board-sync/board-sync-all.sh` after; school i13 via the school
runbook and its queue). Verify in the DB, not by eye.

Phase R3 (patch release, after R2 is confirmed on all three devices): remove
the junctions; school Tailscale task/folder/markers → `OurEraComms` with the
old task removed in the same script run.

Waiting, on purpose, for now: the Drive folder name (adopt either name,
rename inside Drive later by hand; splitting the family library is the risk)
and the GitHub repo names + update feed default (feed continuity for every
installed hub; GitHub redirects renamed repos, but it goes in its own step
once R1 is on every device). Neither is visible to a person using the app.

## Shortcuts on existing devices

The hub's `appShortcut` writes the home shortcut at runtime: after the rename it
writes `Our Era Comms.lnk` and deletes `New ERA.lnk` from the Desktop and Start
Menu if present (never Startup). The NSIS uninstaller and the uninstall batch
remove both names.

## Drive folder

`drive.js` `CONTENT_FOLDER` stays "New ERA Content" as the name it creates;
adoption accepts either "New ERA Content" or "Our Era Comms Content", preferring
an existing folder over creating one. Renaming the folder inside Drive is then
a later, manual, zero-code act. Reader-share copy stops naming the folder and
says "in your content folder › shared".

## Rae → ERA (dad, 9/26: "make sure all uses of rae are era")

The superseded codename survives in code comments and a few strings, never on
the website (0 hits). In scope here: era-gaze `device/ERAgaze.cs` (header
comment "RaeGaze v2", the build comment's `/out:RaeGaze.exe`, the startup log
line "RaeGaze 2.0 start", the `_doc` string in the default tuning file, the
kiosk-chrome comments, the `SIG` comment) and `device/RunAsUser.cs`; era-core
`dwell.js` comments and the `lib-contract` twin test (RaeGaze.cs no longer
exists; the test is rewritten to assert on ERAgaze.cs alone); Making Words
`app/index.html` comment; era-hub `erabook.js` / `books-share.js` example
titles ("Rae's Día" → "Ellie's Día"); the `RaeGaze.json` → `ERAgaze.json`
migration branch stays (it is what renames old files on devices).

Out of scope, on purpose: the device folder `C:\Users\Public\RaeGaze`
(default BaseDir). Her TD Snap Dashboard tiles target `RaeGaze\<App>.bat` by
path on every device, and the school runbook says replace files, never the
page set. Renaming the folder is a board edit under Law 1 (editor + QA harness
+ board-sync), logged as its own job in aac-board-builder status.md. The
tile-launcher comments in aac-board-builder say so too. "rae-flow" in old plan
files is the name of the planning tooling, not the codename; untouched.

## Release shape

The installer's file name and product name change, so this is a **signed
vX.Y.0** (`bash tools/release.sh vX.Y.0`): gate, unsigned build, VM legs A+B,
SimplySign code from dad, publish, leg C. The website's download button and the
`installer` field pick up the new exe name. `tests-vm/leg-c-smartscreen.e2e.mjs`
asserts the publisher label against the certificate's subject, not "New ERA";
`tests-vm/lib/vm.mjs` and `vm-e2e.sh` look for `Our-Era-Comms-Setup.exe`
(substring-safe, per the 9/9 OneDriveSetup lesson).

## Verification

era-gate fully green across the four worktrees (`ERA_WT_SUFFIX`); VM legs A/B/C
green; on the VM after leg B: Desktop shows only `Our Era Comms.lnk`, Apps &
features shows one entry "Our Era Communication Tools", the hub's home title
and settings update screen say Our Era Comms; a `grep -rI "New ERA"` over the
served `public/` tree and the four apps' `app/` trees returns only the
deliberate keep-list (InstallDir, Drive folder constant, uninstall key).

## Site follow-up (same day as publish)

era-website: remove the interim "still carries the name New ERA" line; the
download buttons name `Our-Era-Comms-Setup.exe`. Manual land + wrangler deploy.

## Worktrees

era-hub uses this worktree (`feat/new-website`, opened 9/25 and otherwise
unused). era-board, era-gaze, era-making-words get worktrees on the same slug
when implementation starts; land in dependency order in one sitting.
