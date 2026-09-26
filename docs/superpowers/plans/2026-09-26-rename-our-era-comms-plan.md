# Rename the software to Our Era Comms — execution plan

Spec: `docs/superpowers/specs/2026-09-26-rename-our-era-comms-design.md` (R1 amended
9/26 after preflight). Worktrees on slug `new-website`: era-hub (this), era-core,
era-board, era-gaze, era-making-words; `ERA_WT_SUFFIX=--wt-new-website` for the
gate. Builders: Opus agents; Fable reviews each phase. Release: signed v0.36.0.

## Preflight (9/26, read-only survey; facts in the spec's R1 section)

- Pass: master unchanged under the hub worktree; VM host up; v0.35.0 is the live
  signed release; SimplySign cert unaffected by the rename.
- Warning → design change: self-update cannot move its own folder (in-process
  overlay). Folder moves only via installer `.onInit` or the device runbook.
- Warning: no C# compiler here; ERAgaze.cs is compiled on the device/VM by the
  hub. Leg A on the VM is the compile check. Agents must be conservative in C#.
- Warning: `--patch` hard-codes `New-ERA-Setup.exe` (build-dist.sh:165); fixed
  in this cut via `installer_file` in latest.json.
- Info: nothing rewrites .lnk files after a self-update today (appShortcut runs
  only from the wizard/toggles): the boot pass is new code with a test.
- Info: tests pinning old names are listed in the survey (update, update-boot,
  reconcile, packs, start-hub-bat, vm-e2e, drive-localfolder, clothing-share,
  reader-share, books-share, reader-strip, music-add, settings-ui, erabook,
  books, tests-vm/*). Each moves with its code, TDD style.

## Task Skeleton

### Phase 1: sibling repos (parallel, independent worktrees)
**Posture hint:** implementing

1. [ ] era-gaze: ERAgaze.cs default BaseDir `Public\ERAgaze`; start-up migration
   RaeGaze→ERAgaze (Directory.Move + `cmd /c mklink /J` junction, only when the
   new dir is absent and the old present; log every step; never throw out of
   Main on failure, fall back to the old dir); kiosk tag matches "ERAgaze" or
   "RaeGaze"; every Rae word in comments/strings/log lines → ERA; RunAsUser.cs
   path → `Public\ERAgaze` with a fallback to the old; extension manifest name.
   - **Acceptance:** `grep -rIi rae device extension` empty except the two
     literal old-path strings the migration needs (commented as such).
   - **Verification:** no compiler here: careful diff review + leg A on the VM.
2. [ ] era-core: dwell.js comments; lib-contract twin test → asserts on
   ERAgaze.cs alone. era-board: 17 spoken prompts + board.js/board-arrange.js
   → "Our Era Comms"; era-making-words: studio.js string (name + domain
   `ourerafoundation.org/communications/`) + index.html comment.
   - **Verification:** each repo's `npm test` / `node --test tests/` green.

### Phase 2: era-hub runtime (TDD)
**Posture hint:** implementing

3. [ ] Boot pass `shortcuts.reconcile()` (new module, test first): rewrite the
   home door + enabled per-app + ERAgaze Startup links with current
   `__dirname` and titles; delete `New ERA.lnk` on Desktop/Start Menu/Startup;
   called once at boot after reconcileApps; dry-runnable (returns the plan).
4. [ ] Pack install accepts `new-era-suite/` or `our-era-comms/` as the tarball
   top folder (server.js:172,179) with tests in reconcile/update tests.
5. [ ] Drive adoption accepts "New ERA Content" or "Our Era Comms Content",
   existing folder preferred over creating; creation keeps the old name for
   now (spec). Reader-share copy stops naming the folder.
6. [ ] Every user-visible string in server.js, public/, reader, book-review,
   music-add, movies-*, books-share/erabook (envelope `from.app` "Our Era
   Comms"; import accepts both), content.js, User-Agent → per spec; tests
   updated alongside.
   - **Gate:** `/reviewing` the diff against the spec's names section.

### Phase 3: installer + release pipeline
**Posture hint:** implementing

7. [ ] installer.nsi: APPNAME "Our Era Comms", DisplayName "Our Era
   Communication Tools", Publisher "Our Era Foundation", InstallDir
   `$LOCALAPPDATA\Our Era Comms`, REGKEY OurEraComms, finish text, section
   name; `.onInit` upgrade path per spec (stop processes, rename, junction,
   delete old key + old links); uninstaller removes both link names and the
   junction. build-payload.sh batch names + UNINSTALL.bat both names.
8. [ ] build-dist.sh / release.sh / sign-installer.sh (`-n`, `-i`) /
   build-installer.yml: `Our-Era-Comms-Setup.exe`, `installer_file` in
   latest.json, `--patch` reads it (fallback New-ERA-Setup.exe for old feeds),
   release titles "Our Era Comms suite $V". vm-e2e.sh + tests-vm: leg A/B/C
   find the previous installer under its recorded name and the candidate
   under the new one; leg C publisher assertion = certificate subject; add the
   upgrade-over-old check to leg A (install v0.35.0's exe, then the candidate
   exe over it: one Apps entry, folder moved, junction present, hub up).
   - **Verification:** `node --test tests/vm-e2e.test.mjs tests/start-hub-bat.test.mjs`;
     `bash -n`; nsis syntax via `makensis -V2` dry compile if available.

### Phase 4: gate + land
**Posture hint:** implementing

9. [ ] `ERA_WT_SUFFIX=--wt-new-website bash tools/era-gate.sh` green; the
   keep-list grep (spec Verification) clean; land core → board →
   making-words → hub via worktree.sh; era-gaze manual land (no gate stamp).

### Phase 5: release v0.36.0 (signed; dad stages the SimplySign code)
**Posture hint:** collaborating

10. [ ] `bash tools/release.sh v0.36.0` through 3/5; "VM green, ready for the
    code"; dad enters it; 5/5 publish; leg C. Site: remove the interim line +
    download buttons name the new exe (era-website manual land + deploy).

### Phase 6: devices (R1-device) and board (R2)
**Posture hint:** collaborating

11. [ ] Each device self-updates (POST /update/check via the tunnel); confirm
    version + shortcuts renamed. Then the runbook per device: stop hub, move
    `New ERA` → `Our Era Comms`, junction, start via the new start-hub.bat,
    verify /version and the tiles. Re-scp tile launchers. School via the
    school runbook.
12. [ ] R2: Dashboard tiles re-pointed to `ERAgaze\<App>.bat` through the
    editor + harness, cloud checkpoint first, board-sync-all after, verify in
    the DB. R3 (junction removal) is a later patch.

### Phase 7 (final): behavioral verification
13. [ ] On the tablet: Desktop shows `Our Era Comms.lnk` only; Apps & features
    shows one entry; hub title and settings update screen say Our Era Comms;
    a tile launches the board; `grep -rI "New ERA"` over the served tree
    returns only the keep-list; Drive folder still adopted; a shared book
    still imports. Evidence in status.md.
