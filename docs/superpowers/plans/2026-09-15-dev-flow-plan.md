# Dev flow: worktree-per-feature, merge-only master, patch releases, push-to-device — plan (2026-09-15)

Spec: `docs/superpowers/specs/2026-09-15-dev-flow-worktrees-and-patch-releases-design.md`
(approved by dad 9/15: "go for it"). This file is the living workpad: tick
tasks, append results under each phase, record the publish at the end.

## Preflight (done 9/15, main thread)

- `update.js` `check(port)` reads a module-level `FEED`; `server.js:2598`
  `POST /update/check` takes no body. Body reading in server.js is inline per
  route (`req.on("data")`, 4 KB cap, e.g. :1317) — follow that, no helper.
- `tests/update.test.mjs` boots a REAL installed hub (VERSION file, no .git)
  on 8410 against a fake feed on 8411 — the override test lives there.
- `ssh -R 8510:127.0.0.1:8480 i13 'curl.exe …'` probed 9/15: the reverse
  tunnel forwards (the "connect_to … failed" came from our side — nothing on
  8480), `curl.exe` 8.13 is on the device, `/version` answers on loopback.
  §5 needs no PowerShell.
- `era-gate.sh` prints `== era-gate: N passed, M failed ==` and exits by
  `$fail`; the green stamp is release.sh's (`/tmp/era-release-gate.head`),
  written only from release.sh. The per-tree stamp is new.
- `build-dist.sh <V> <DIST>` positional only; makensis is one block with
  `-DSIGN` hard-coded; verify is conditional on `signing.env`.
- `sign-installer.sh` soft-exits 0 with no `signing.env` (the silent-unsigned
  hole). `--check` likewise.
- `vm-e2e.sh <DIST> [prev exe] [--only a|b]` — `--only b` exists; PREV
  defaults to the newest TAGGED `dist/release-*`.
- `tests-vm/leg-c-smartscreen.e2e.mjs` reads `VM_SITE_URL`, `VM_DIST` (for the
  expected sha), `VM_DOWNLOAD_SELECTOR`; never wired.
- `aac-board-builder` has no `tests/`; `tools/worktree.sh` is 40 lines,
  repo-agnostic (`<repo-path>` arg). Its test goes beside it.
- `EnterWorktree` (Claude Code) switches a session into an existing worktree
  by `path` when it appears in `git worktree list` — the sibling layout
  `era-hub--wt-<slug>` works. It only fires on an explicit instruction in
  CLAUDE.md/memory, so Phase 6 must write that instruction.
- Ports: tests hold 8391-8411; `update.test.mjs` = 8410/8411. No new suite
  needs a port. push-device uses 8480+ (local feed) and 8500+ (tunnels).
- Warning: dad's tunnel/scratch ports collide with gates (9/15 memory) —
  push-device must `ss -ltn` its ports before binding.

House rules for every executing agent (from §C guardrails, clothing plan):
named `git add` paths only, never `-A`; commit only in this worktree
(`era-hub--wt-install-qa`, branch `feat/audit-fixes`) or in
`aac-board-builder` (single checkout, master); never stash; never start a hub
on 8377-8416 / 8425 / 8427 / 8450-8462; era-gate once machine-wide (check
`flock`/`ps` first). Building agents run as `model:'opus'`; Fable reviews.

## Task Skeleton

### Phase 1: Hub — feed override on `POST /update/check` (spec §5.3)
**Posture hint:** implementing

1. [x] `update.js`: `check(port, feed = FEED)` — the override is a parameter;
   boot/6-hourly ticks keep calling `check(port)`.
   - **Acceptance:** `check(port, "http://127.0.0.1:8411")` uses that base
     for `latest.json` and the tarball; `FEED` export unchanged.
   - **Verification:** `node --test tests/update.test.mjs` (existing cases
     still green; new case below).
   - **Guardrails:** TDD — write the failing test first (a second fake feed
     on 8412 serving a newer build; assert the hub updated from IT while the
     default feed still says up-to-date).
2. [x] `server.js` `/update/check`: read a JSON body (inline, 4 KB cap, as
   :1317); honour `{feed}` only when `req.socket.remoteAddress` is
   `127.0.0.1` / `::1` / `::ffff:127.0.0.1`; otherwise ignore the body and
   call `check(PORT)`. Malformed JSON = ignore body, not 400 (the FE's
   body-less POST must keep working).
   - **Acceptance:** loopback POST with `{feed}` → result carries
     `feed: <override>`; a POST whose socket is non-loopback (test binds the
     hub on `0.0.0.0` for one case and connects via the LAN IP, or stubs
     `remoteAddress`) → default feed used, `feed` absent from the result.
   - **Verification:** `node --test tests/update.test.mjs`; `bash
     tools/era-gate.sh` before the phase gate.
   - **Guardrails:** TDD. The hub in `update.test.mjs` listens on
     `127.0.0.1`? — check `server.js` listen host; if it binds all
     interfaces, connect via `os.networkInterfaces()` non-internal IPv4 for
     the negative case, else stub. Document which in the test.
   - **Gate:** `/reviewing` against §5.3 (the loopback rule is the security
     property — reviewer checks it cannot be bypassed via `X-Forwarded-For`
     or an IPv4-mapped form not in the list).

### Phase 2: Per-tree green stamp (spec §3.1)
**Posture hint:** implementing

3. [x] `era-gate.sh`: on `fail == 0`, write
   `/tmp/era-gate-green/<tree-sha>` (`git -C "$HUB" rev-parse HEAD^{tree}`)
   containing the summary line + `date +%s` + `$HUB`. Untracked/dirty trees
   still stamp (the tree sha is HEAD's; a dirty worktree is the operator's
   problem, printed as a WARNING line when `git status --porcelain` is
   non-empty).
   - **Acceptance:** after a green run, the file exists for HEAD's tree;
     a red run writes nothing.
   - **Verification:** `bash tools/era-gate.sh | tail -1 && ls
     /tmp/era-gate-green/$(git rev-parse HEAD^{tree})`.
   - **Guardrails:** shell only; no test suite for the gate itself (it IS the
     suite runner) — verify by running it once.
4. [x] `release.sh --skip-gate`: read the per-tree stamp for `$HEAD^{tree}`
   (same 2 h window, same `git diff --quiet` exclusions of tools/, tests-vm/,
   docs/ — compare against the stamped HEAD recorded in the file). Keep
   writing the old `/tmp/era-release-gate.*` for one release (i13 runbooks
   mention it), then drop.
   - **Acceptance:** `release.sh vX --dry-run --skip-gate` accepts a stamp
     made by a worktree gate on the same tree.
   - **Verification:** covered by Phase 7's dry-run.
   - **Gate:** none (folded into Phase 4's review).

### Phase 3: `worktree.sh` — open / sync / land / close (spec §3.2-3.3)
**Posture hint:** implementing

5. [x] `aac-board-builder/tools/worktree.sh`: `open` (`--fix` → `fix/<slug>`;
   runs `tools/assemble.sh` against `era-family/test-data` when the repo has
   one; prints the port ledger, no `IN FLIGHT` text); `sync` (in the
   worktree: `git merge master`, no-edit, refuses on a dirty tree); `land`
   (in the main checkout: clean-tree check → `merge-base --is-ancestor
   master <branch>` → green stamp for the branch's tree under 2 h →
   `flock /tmp/era-land.lock` → `git merge --no-ff -m "land <branch>: <stamp
   line>"` → `git push origin master` → prints next steps); `close`
   unchanged; `list` unchanged.
   - **Acceptance:** each refusal names its reason and exits 1 before any
     write; `land` never rebases, never touches the worktree.
   - **Verification:** `bash tools/worktree.test.sh` (task 6).
   - **Guardrails:** TDD in bash — task 6's test is written first and red.
     The green-stamp path and the 2 h window are shared with release.sh
     (Phase 2) — read `/tmp/era-gate-green/<tree>`; the test seeds one by
     hand.
6. [x] `aac-board-builder/tools/worktree.test.sh`: throwaway repo under
   `$(mktemp -d)` with a `master`; `open` → commit → advance master → `land`
   refuses (master moved) → `sync` → `land` refuses (no stamp) → seed stamp
   → `land` succeeds; assert `git log --merges -1` is the `--no-ff` commit,
   `git reflog | grep -c rebase` is 0, `close` removes both, and `close` on an
   unmerged branch refuses. Also: `land` with a dirty main checkout refuses.
   - **Acceptance:** `bash tools/worktree.test.sh` prints `PASS n/n`, exit 0.
   - **Verification:** same.
   - **Gate:** `/reviewing` against §3.3 (ordering of checks; lock held
     across merge+push; no `git stash` anywhere).

### Phase 4: Release shapes (spec §4)
**Posture hint:** implementing (dry-runs are the proof; no publish in this phase)

7. [x] `build-dist.sh`: split the makensis block into `build_installer
   [--sign]`; new flags `--patch` (skip makensis; fetch the current feed's
   `latest.json` → `installer` (fallback `version`) → `gh release download
   <tag> -p New-ERA-Setup.exe --repo nauerhahn26/new-era-releases` into
   `$DIST`; `osslsigncode verify` must say ok or exit 1) and `--unsigned`
   (makensis without `-DSIGN`). Default (no flag) = makensis WITH `-DSIGN`
   and a hard-failing verify (no more `if [ -f signing.env ]`). `latest.json`
   gains `"installer":"<tag>"` (own `$V` when an installer was cut here).
   `--patch` refuses unless `$V`'s `X.Y` equals the installer tag's `X.Y`.
   - **Acceptance:** `build-dist.sh v0.33.3 <dir> --patch` produces the six
     assets with the v0.33.2 exe re-attached and verified; `--unsigned`
     produces an exe `osslsigncode verify` calls unsigned; default with no
     `signing.env` exits 1 with "SIGNING REQUIRED".
   - **Verification:** the three invocations above against a scratch
     `dist/` dir (2 GB free check applies — prune old `dist/release-*`
     first per the 9/3 memory).
   - **Guardrails:** `sign-installer.sh` loses its soft-exit: no
     `signing.env` → exit 1 (and `--check` → exit 1). Nothing calls it
     without meaning to sign any more.
8. [x] `release.sh`: `--patch` flow (gate → build --patch → `vm-e2e.sh $DIST
   --only b` → tag + publish with patch notes naming the installer tag);
   signed flow reordered (gate → build --unsigned → vm-e2e A+B → prompt
   "VM green — ready for the SimplySign code" + `sign-installer.sh --check`
   → `build_installer --sign` (makensis again with `-DSIGN`, same payload dir)
   → verify → tag + publish → leg C with `VM_SITE_URL`/`VM_DIST` set; red
   leg C prints `PULL THE RELEASE: gh release delete <V>` and exits 1 without
   deleting). `--dry-run` stops before signing in the signed flow and before
   tagging in the patch flow. Remove step 0's signing preflight.
   - **Acceptance:** `release.sh v0.33.3 --patch --dry-run` runs gate →
     build → leg B and exits 0 with "DRY RUN"; `release.sh v0.34.0 --dry-run`
     runs A+B on an unsigned exe and stops before asking for a code.
   - **Verification:** both dry-runs, logs kept under `gate/vm-e2e/`.
   - **Guardrails:** the release-notes string becomes two strings (signed /
     patch); the patch one must not claim the tarball is signed. Wire
     `run_leg c` in vm-e2e.sh behind `--post-publish` so release.sh can call
     it alone.
9. [x] `vm-e2e.sh`: in patch mode (`$DIST/latest.json` has `installer` ≠
   `version`) PREV defaults to `$DIST/New-ERA-Setup.exe` itself (it IS the
   family's installer); the TAGGED-dist search stays for signed cuts.
   `--post-publish` runs leg C only.
   - **Acceptance:** banner line says `previous <DIST>/New-ERA-Setup.exe
     (installer v0.33.2 re-attached)` in patch mode.
   - **Verification:** part of task 8's dry-runs.
   - **Gate:** `/reviewing` Phase 4 against §4.2-4.4 — reviewer specifically
     checks (a) no path builds an installer that is unsigned-by-accident,
     (b) the tarball file is the same inode/sha through sign and publish,
     (c) `--patch` version rule, (d) leg C failure does not delete anything.

### Phase 5: `tools/push-device.sh` (spec §5.2)
**Posture hint:** implementing

10. [x] `push-device.sh <host> <dist-dir>`: checks (assets present; the
    dist's `VERSION`→ its tree stamp: `build-dist` writes `$DIST/TREE` with
    the tree sha so push-device can look up `/tmp/era-gate-green/<tree>`;
    refuse without it); `ss -ltn` free-port pick for local feed (8480-8499)
    and tunnel ports (8500-8519, `-R` and `-L`); `python3 -m http.server`
    bound to 127.0.0.1 serving `<dist-dir>`; one `ssh -o ExitOnForwardFailure
    -N -R … -L …` in the background; `curl -s -X POST
    http://127.0.0.1:<L>/update/check -H content-type:application/json -d
    '{"feed":"http://127.0.0.1:<R>"}'`; print the JSON; poll
    `/version` up to 90 s until `build` = the dist's build; tear down (kill
    by pid — never `pkill -f`, 9/x memory); exit 0 only on match.
    - **Acceptance:** against a hub that has Phase 1: `updated` then
      `/version.build` equals the pushed stamp. Against a hub without it
      (today's i13): the hub answers `up-to-date` (it ignored the body) and
      the script says so plainly: "device hub predates feed override —
      publish a patch first".
    - **Verification:** the second case can run NOW against i13 (harmless);
      the first is Phase 7 task 15.
    - **Guardrails:** `build-dist.sh` writes `$DIST/TREE` (task 7 adds it).
      Never binds 8377-8462. No PowerShell.
    - **Gate:** `/reviewing` against §5.2 (port hygiene; cleanup on every
      exit path via `trap`).

### Phase 6: Policy, docs, memory, cleanup (spec §3.4-3.5)
**Posture hint:** collaborating (wording of house law; deleting branches)

11. [x] `aac-board-builder/docs/parallel-worktrees.md` rewritten as the
    default flow: open/sync/land/close; rules 1,3,4,5 kept; rule 2 and the
    rebase close-out removed; a "dad's routine" section: new chat in the
    main checkout → "new feature: <name>" → the chat opens + enters the
    worktree → "land it" / "push it to i13" / "patch it" / "close it".
    `CLAUDE.md` "How we work" paragraph updated (one session per worktree;
    `worktree.sh list` is the registry; PARALLEL EXCEPTION → default).
    - **Acceptance:** no remaining mention of rebase, `IN FLIGHT`, or
      "opt-in" in either file.
    - **Verification:** `grep -n "rebase\|IN FLIGHT\|opt-in" docs/
      parallel-worktrees.md CLAUDE.md` → empty.
12. [x] era-hub `docs/dev-flow.md` (one page: the routine, the three release
    shapes, push-device, links to the aac-board-builder doc and this spec);
    `tools/era-gate.sh` header comment points at it too. Memory file
    (Fable's `memory/`): "new feature: <name>" ⇒ `worktree.sh open` +
    `EnterWorktree path=…`; "land/patch/push/close" verbs ⇒ the commands.
    - **Acceptance:** a fresh era-hub session reading MEMORY.md + dev-flow.md
      can run the routine without this chat.
    - **Verification:** read-through by the reviewer; `ls docs/dev-flow.md`.
13. [x] Cleanup: for each of books-loose, built-once, clothing, launcher,
    movie-player, reader, smartscreen: `git merge-base --is-ancestor <branch>
    master && worktree.sh close`; `git worktree remove
    .claude/worktrees/agent-a5e6cbddb39ac78fd` + `git branch -D
    worktree-agent-…` (tool-made, unmerged, confirmed disposable — LIST its
    commits first and stop if any touch non-scratch files); `git branch -D
    feat/install-qa` (297 behind, never pushed — list its unmerged commits
    first; they were re-landed as feat/audit-fixes 9/2); `git push origin
    --delete feat/app-picker feat/clothing-migration feat/movie-player` after
    ancestry confirmed; remove the 8/28 `IN FLIGHT (worktree): install-qa`
    block from `status.md` and add the 9/15 ruling line.
    - **Acceptance:** `git worktree list` shows main + this worktree only;
      `git branch -a` shows master, feat/audit-fixes, origin/master (+
      origin/feat/audit-fixes until task 14).
    - **Verification:** the two commands above.
    - **Guardrails:** STOP and show dad before any `-D` whose branch has a
      commit not in master. Never touch `era-hub--wt-install-qa` (this one).
    - **Gate:** `/reviewing` Phase 6 docs for accuracy against the shipped
      scripts (commands in the doc must be the commands that exist).

### Phase 7: Behavioral verification (mandatory)
**Posture hint:** collaborating (dad's "go" on the publish; his device)

14. [x] First `land`: in `/home/claude/new-era/era-hub` (main checkout),
    `worktree.sh land era-hub audit-fixes` — expected: refuses until a green
    stamp exists for this tree (run the gate here first), then a `--no-ff`
    merge on master pushed to origin. Then `worktree.sh close era-hub
    install-qa` — expected refusal (dir slug ≠ branch slug: this worktree is
    the misnamed one) → close by hand: `git worktree remove
    ../era-hub--wt-install-qa && git branch -d feat/audit-fixes && git push
    origin --delete feat/audit-fixes`. This chat then continues in the main
    checkout for the release only.
    - **Evidence:** `git log --oneline --merges -1` on master; `git
      worktree list` = main only.
15. [x] `tools/release.sh v0.33.3 --patch --dry-run` → expected
    `== vm-e2e: N passed, 0 failed ==` from leg B alone and `DRY RUN`; then,
    on dad's go, `tools/release.sh v0.33.3 --patch` → `RELEASED: v0.33.3`;
    `gh release view v0.33.3 --json assets` lists six assets;
    `curl -sL https://github.com/nauerhahn26/new-era-releases/releases/latest/
    download/latest.json` → `{"version":"v0.33.3","build":"…","sha256":"…",
    "installer":"v0.33.2"}`; `curl -sIL …/New-ERA-Setup.exe` → 200 and the
    sha equals v0.33.2's `checksums.txt` line. No SimplySign code was asked
    for at any point (the log has no "sign:" line).
    - **Evidence:** the four outputs pasted below this task.
16. [x] i13 takes the patch: `ssh i13 'curl.exe -s -X POST
    http://127.0.0.1:8377/update/check'` → `{"status":"updated",…}`; within
    ~30 s `/version` → `build` = v0.33.3's stamp. (Tablet + school follow on
    their 6 h tick; check the tablet the same way.)
    - **Evidence:** both JSON lines.
17. [x] push-device end to end: `tools/release.sh v0.33.4 --patch --dry-run`
    (a dist with a newer stamp, leg B green) → `tools/push-device.sh i13
    dist/release-v0.33.4` → prints `{"status":"updated",…,"feed":"http://
    127.0.0.1:85xx"}` and `i13 now on <stamp>`; public `latest.json` still
    says v0.33.3; the tablet's `/version` unchanged. Then, on dad's go,
    publish v0.33.4 for real (or leave it: the i13 stays ahead harmlessly —
    record which).
    - **Evidence:** push-device output + the two `/version` lines +
      `latest.json`.
18. [x] Signed-flow rehearsal without publishing: `tools/release.sh v0.34.0
    --dry-run` → gate, unsigned build, legs A+B green, stops with "DRY RUN:
    signing not attempted". Not the real signed cut — that happens when the
    installer next changes.
    - **Evidence:** the last 5 lines of the run.
19. [ ] Dad's routine, for real: dad opens a new chat in the main checkout
    and says "new feature: <anything small>"; the chat opens + enters a
    worktree by itself. Record what he typed and what happened. This is the
    acceptance test of §3 from his side of the keyboard.
    - **Evidence:** dad's one-line verdict.

## Phase retrospectives
(append after each phase: decisions, surprises, follow-ups)

### Phases 1–3 built in parallel (9/15 ~19:20 UTC, three Opus builders) — review pending
- P1 hub `f816024`: `check(port, feed = FEED)` over `runCheck`; `isLoopback()` exported
  as an exact-string Set; route reads body inline (4 KB cap), honours `{feed}` only when
  `isLoopback(req.socket.remoteAddress)` and the value is an http(s) string; every other
  path = today's `check(PORT)`. `update.test.mjs` 10/10 (was 7), `routes.test.mjs` 12/12.
  Off-loopback covered by a unit test only (hub binds `ERA_BIND || 127.0.0.1`) —
  adversarial review asked to prove the route wiring empirically on a 0.0.0.0 throwaway.
  Discovery: `server.js:160` app packs still download from `updater.FEED` (push-device
  can't override packs) — accepted, noted in push-device output.
- P2 gate `36a6845`: `write_green_stamp` (summary/head=/at=/hub=) called before the
  byte-identical summary echo; `release.sh --skip-gate` reads the exact-tree stamp, falls
  back to a `head=` differing only under tools/tests-vm/docs; `--gate-check` hidden flag,
  refused without `--skip-gate`. No gate run (P1 held 8410–8412). Stamps dir left empty.
  Follow-up: nothing prunes `/tmp/era-gate-green/`; fallback scan takes first match.
- P3 aac-board-builder `538ead9`: `worktree.sh` open/sync/land/close/list per §3.2–3.3;
  seams `ERA_GATE_STAMPS`, `ERA_LAND_LOCK`; `worktree.test.sh` red-first, `PASS 43/43`.
- Order change vs plan: P4 + P5 dispatched right after P1–P3 reported, concurrently with
  the P1 and P2+P3 reviews (different files; index.lock retries).

### Reviews of Phases 1–3 (9/15 ~20:00 UTC, two Opus reviewers) → fixes `7630804`, `051fcfa`, `6aa28bc`, `7f099b3`
- P1 APPROVED_WITH_COMMENTS. Fixed: the off-loopback path was never exercised → a test
  now boots a throwaway hub with `ERA_NO_UPDATE=1 ERA_BIND=0.0.0.0` on 8412 and proves
  a LAN-socket `{feed}` is ignored (red both ways first); body overflow used to
  `req.destroy()` with no reply → 413; the 4 KB cap was a string-length cap → byte-exact
  `Buffer.concat`. `update.test` 11/11, `routes.test` 12/12. Left: `/settings`
  (`server.js:1317`) still reads its body with the old `body += c` idiom — follow-up.
- P2/P3 CHANGES_REQUESTED, all taken: stamp dir hardcoded → `ERA_GATE_STAMPS` seam; a
  tree with tracked modifications got a clean-looking stamp → gate writes `dirty=1`
  (`--untracked-files=no`) and every reader (release.sh, `land`, push-device) refuses it;
  release.sh fallback took the first glob → newest `at=`; `land` on a detached-HEAD
  worktree silently did nothing → refusal in land/sync/close; uncommitted worktree work at
  `land` → WARNING. `worktree.test.sh` PASS 75/75.

### Phases 4–5 built (9/15 ~20:30 UTC) — `2ed61b2`, `63cb70e`; adversarial review → `ae50ca8`
- P4 `build-dist.sh` grew four modes behind one `build_installer`: `--patch` (no makensis;
  fetches the live `latest.json` `installer` field — fallback `version` — refuses unless
  X.Y matches, `gh release download` of that tag's `New-ERA-Setup.exe`, osslsigncode
  verify), `--unsigned`, default, `--sign-only` (makensis again with `-DSIGN`, asserts the
  tarball sha unchanged, re-copies the stable tarball, verify ok). Every mode writes
  `$DIST/TREE` + `$DIST/HEAD`; `latest.json` gains `"installer":"<tag>"`.
  `release.sh`: signed flow gate → unsigned build → legs A+B → (`--dry-run` stops here) →
  "stage the SimplySign code" + `sign-installer.sh --check` → `--sign-only` → publish →
  `vm-e2e.sh --post-publish` (leg C; red prints PULL THE RELEASE, deletes nothing). Patch
  flow gate → `--patch` build → `--only b` → publish with PATCH notes. `--resume-sign`
  for a dead code. `sign-installer.sh` now hard-fails without `signing.env`.
  Surprise: makensis does NOT propagate a failed `!finalize` — osslsigncode verify and the
  `sign: SIGNED` count are the load-bearing checks, not makensis's exit code.
- P5 `tools/push-device.sh <host> <dist> [--dry-run]` (259 lines): host alias from
  `~/.ssh/config` → six assets → sha → `TREE` == HEAD tree → green stamp → ports; python
  `http.server` on 8480–8499 bound to 127.0.0.1; one `ssh -N -o BatchMode=yes -o
  ExitOnForwardFailure=yes -R <8500+>:127.0.0.1:<P> -L <8500+>:127.0.0.1:8377`; POST
  `{feed}` over the -L leg only; string compare of `YYYYMMDD.HHMM` stamps = no downgrade;
  90 s poll of `/version`. Builder found its own subshell port-picker bug (`printf -v`).
- Adversarial review (P4+P5, one Opus reviewer) found one HIGH: `--resume-sign` could
  publish a dist the VM never drove (a bare `build-dist.sh` dist looks identical to a
  `--dry-run` one). Fix `ae50ca8`: `vm-e2e.sh` writes `$DIST/VM-GREEN` (`legs=`,
  `tarball=<sha>`, `at=`) only on 0 failed, removes it at the start of every non-`--post-
  publish` run; every `gh release create` requires it (signed: `legs=a,b`; patch: legs ∋
  `b`) with the sha matching both the tarball and `latest.json`; `--resume-sign` requires
  `legs=a,b`. Also: a half-signed installer (uninstaller stub unsigned) → assert
  `grep -c '^sign: SIGNED '` == 2; stable tarball re-copied and re-asserted before
  publish; `--only ${2:?}`; DEVBUILD trap fix; dirname check on `<dist>`.
- Discovery (the fixer, running the suite): `tests/vm-e2e.test.mjs` went 0/4 on this
  branch — it parses `tools/vm-e2e.sh` as text and the P4 reshaping indented the banner
  behind `--post-publish` and moved the UNTAGGED mark into a `PREV_NOTE=` line. Test-only
  fix dispatched (Phase 7 cannot start until the gate is green).

### Phase 6 done (9/15 ~21:30 UTC) — docs `d218429` (era-hub), `f184638` + `6d435cb` (aac-board-builder); cleanup by hand
- `docs/dev-flow.md` (115 lines) + `# Flow: docs/dev-flow.md` in era-gate.sh's header;
  aac-board-builder `docs/parallel-worktrees.md` rewritten as the default flow, CLAUDE.md
  "How we work" paragraph, status.md IN FLIGHT block replaced by the 9/15 ruling. Memory
  `dev-flow-worktree-per-feature-2026-09-15` carries dad's verb → command table.
- Cleanup (task 13, done early): 13 merged worktrees closed via `worktree.sh close`
  (era-hub ×7, era-board ×2, era-family, era-gaze, era-making-words, era-website); local
  `feat/install-qa` (an ancestor of master — the plan's "unmerged" guess was wrong, `-d`
  sufficed) and `feat/app-picker` deleted; remote `feat/app-picker`, `feat/clothing-
  migration`, `feat/movie-player` deleted. Left for dad: era-hub's tool-made
  `.claude/worktrees/agent-a5e6cbddb39ac78fd` (one commit `05a17cf`, already on master as
  `b115c2c`, superseded by `3cf0f65`) — needs `-D`, so it waits for his word.

### Phase 7 — behavioral verification (9/15 23:11 → 9/16 00:40 UTC)
- Gate on `e9f948a` (worktree, after the vm-e2e.test fix): `== era-gate: 94 passed, 0
  failed ==`, stamp `/tmp/era-gate-green/f850a54…` clean (no `dirty=1`).
- **Task 14 — first `land`** from the main checkout: `ac6431a land feat/audit-fixes: ==
  era-gate: 94 passed, 0 failed ==`, pushed `45cc0ac..ac6431a master -> master`;
  `git reflog | grep -c rebase` = 0. Master's tree == the branch tip's, so the worktree's
  stamp covered master unchanged — every later `--skip-gate` read it ("gated tree f850a54
  from e9f948a, green 23:11 — gate skipped"). The plan's predicted `close` refusal was
  wrong: `close` reads the branch off the worktree, so the misnamed dir was fine; git
  itself refused — 149 untracked npm files under `vendor/onnxruntime-web/` (only in this
  worktree). Follow-up below. Worktree retired by hand at the end of the session.
- **Task 15 — `release.sh v0.33.3 --patch --dry-run --skip-gate`**: build without makensis,
  `installer: v0.33.2 re-attached, signature ok`, leg B `5 passed, 0 failed`, `VM-GREEN
  legs=b` sha == tarball == latest.json, zero `sign:` lines, stopped at `DRY RUN … not
  tagged, not published`. Then, on dad's "publish v0.33.3" (00:21 UTC): rebuilt
  (`20260916.0021`), leg B 5/0, `RELEASED: v0.33.3`. Verified live: six assets;
  `latest.json` = `{"version":"v0.33.3","build":"20260916.0021","sha256":"22e9a69d…",
  "installer":"v0.33.2"}`; the website's `New-ERA-Setup.exe` sha `dde14cc4eb083301…` ==
  v0.33.2's checksums line; tag `v0.33.3` on `ac6431a`. No SimplySign at any point.
- **Task 16 — i13 takes the patch**: `/version` `20260915.0641` → `POST /update/check` →
  `{"status":"updated","from":"20260915.0641","to":"20260916.0021","version":"v0.33.3",
  "restart":"restarting"}` → `/version` `{"build":"20260916.0021","disk":"20260916.0021",
  "updater":true,"pid":2844}` within 60 s. Tablet unreachable over ssh at 00:40 (asleep);
  it follows on its 6 h tick.
- **Task 18 — `release.sh v0.34.0 --dry-run --skip-gate`**: unsigned build (makensis
  1m50 s, 47.5 MB), leg A 9 + leg B 5 = `14 passed, 0 failed`, `VM-GREEN legs=a,b`,
  stopped at `DRY RUN … UNSIGNED installer — signing not attempted, not published`.
  Operator error on the first attempt: `pgrep` returned the `setsid` wrapper's pid, the
  watcher fired "exited" at once, and the dist was `rm -rf`'d under a live makensis —
  that run then failed leg A on the mangled dist (as it should). Lesson: watch the
  `bash …/release.sh` pid, never the wrapper.
- **Task 17 (push-device) and task 19 (dad's routine) — open**, moved to 9/16: 17 needs
  a `v0.33.4` dry-run dist + the i13 (now on v0.33.3, so eligible); 19 needs the
  Mac-app question below answered first.
- Dad's UX (9/16 00:10): he works from the Claude Mac app over remote-control sessions,
  each pinned to a folder on the build box; "+" opens a chat in that session. Decision: one home
  session "New ERA" in `/home/claude/new-era/era-hub`; `new feature: X` / `new board
  feature: X` / `new fix: X` there. Unverified: whether two "+" chats in one session can
  sit in two worktrees at once; if not, add `worktree.sh open --session` (spawn a named
  `claude-session` in the worktree so it appears in the app). Verify before he relies on
  parallel chats.

### Phase 7, continued (9/16 05:15 → 06:05 UTC) — task 17 done, sessions reshaped
- **Task 17 — push-device end to end.** Worktree `push-e2e` off `72e999d` (tree
  `51f7ecf`). `release.sh v0.33.4 --patch --dry-run`: gate `94 passed, 0 failed` (stamp
  `51f7ecf…` 05:42), build `20260916.0542` with `installer: v0.33.2` re-attached, leg B
  `5 passed, 0 failed`, `VM-GREEN legs=b`, `DRY RUN … not tagged, not published`.
  `push-device.sh i13 dist/release-v0.33.4 --dry-run`: first attempt "no answer from
  i13's hub … after 30 s" — the i13 had rebooted 9/15 19:58 (device time) and nothing
  autostarts the hub (`NewERAHubSvc` task Disabled since the 9/14 wipe; the tile is the
  only launcher). Started the hub alone in her session (one-shot `.vbs` task, no kiosk at
  23:00): `/version` `{"build":"20260916.0021",…,"pid":11544}`. Dry-run then: `device: i13
  on build 20260916.0021 … would push 20260916.0542 (tree 51f7ecf) via -R 8500 ← :8480`.
  Real push: feed `127.0.0.1:8480`, tunnels `-R 8500 / -L 8501`, `POST /update/check
  {"feed":"http://127.0.0.1:8500"}` → `{"status":"updated","from":"20260916.0021","to":
  "20260916.0542","version":"v0.33.4","restart":"restarting","feed":"http://127.0.0.1:
  8500"}` → `pushed: i13 now on 20260916.0542 (v0.33.4)`; device `/version`
  `{"build":"20260916.0542","disk":"20260916.0542","updater":true,"pid":10880}`, hub.log
  `[update] 20260916.0021 -> 20260916.0542 (v0.33.4); restarting`. Public `latest.json`
  still v0.33.3 — **left unpublished**: the i13 sits one unpublished build ahead and takes
  the next published build (a later stamp) as usual. Worktree closed via the new `close`
  (no commits on `fix/push-e2e`; "no remote branch").
- **Follow-ups taken (aac-board-builder `b6fc750`, `d588765`, `worktree.test.sh`
  131/131):** `close` deletes the landed branch with `-D` + `push origin --delete`, lists
  untracked/modified files and wants `--force` (DISCARDED), refuses while a process has the
  dir as cwd (`fuser`, never overridden), kills a `tmux wt-<slug>` it started; `sync`
  ignores untracked files; `land` accepts a docs-only stamp (this very commit); `open
  --session` spawns a named `claude-session` in the worktree.
- **Parallel-chat question answered** (remote-control docs): the installed `claude`
  2.1.251 runs one cwd per `--remote-control` process, so two "+" chats in one session
  share a directory — `EnterWorktree` moves only that chat, which is what dad's routine
  needs. The real fix is server mode (`claude remote-control --spawn=same-dir`, needs
  `claude update` ≥ 2.1.200) — proposed to dad, not done. Sessions reshaped 9/16: "New
  ERA" launched in `/home/claude/new-era/era-hub` (tmux `newera`, keepalive); Music
  Player + Ellie Music Board retired (notes in `~/session-state/retired/`); Install QA
  retired after this record. `~/bin/claude-session` now picks the real 2.1.251 binary
  itself (npm's half-install left a stub on PATH since 9/10).
- New follow-up: the i13 hub has no autostart — a reboot leaves the device dark until
  someone taps the tile (`NewERAHubSvc` Disabled). Decide: re-enable the task (battery
  settings!) or a Startup shortcut to `start-hub.bat`, the way ERAgaze has one.
- Task 19 (dad's routine, his verdict) stays open — it happens in the New ERA session.

## Follow-ups (not in this plan)
- `worktree.sh close` fails on any untracked file in the worktree (git's own refusal) —
  list what would go and take `--force`; every long-lived feature worktree hits this.
- `worktree.sh land` requires the exact-tree stamp; a docs-only commit after a green
  gate needs a full re-gate. Give `land` release.sh's docs/tools/tests-vm-only fallback.
- Closing merged worktrees pulls the floor from any remote-control session still living
  in them (pid 730300 sat in `era-board--wt-music-player`, now `(deleted)`): `close`
  should refuse while a process has the dir as cwd (`fuser`/`lsof`), or say so.
- `server.js:1317` `/settings` still reads its body with the unbounded `body += c` idiom
  — give it the 4 KB `Buffer.concat` + 413 treatment `/update/check` got.
- Nothing prunes `${ERA_GATE_STAMPS:-/tmp/era-gate-green}/` — one file per gated tree,
  forever (tiny, but a `find -mtime +7 -delete` in the gate would do).
- `vm-e2e.sh --only a` writes a `legs=a` VM-GREEN marker no publisher accepts — harmless,
  but the message could say so.
- `/version` returns `{build, disk, updater, pid}` and no `version` key; push-device
  reports the build stamp only.
- App packs still download from the public `updater.FEED` (`server.js:160`) — a
  push-device'd hub fetches packs from the last published release; first delivery of the
  feed override to any device is itself a normal release (v0.33.3).
- `installPack()` fetches the tarball with no checksum (Gap 14, content-
  pipelines plan) — unchanged here.
- `.github/workflows/build-installer.yml` builds an unused unsigned exe on
  every tag — delete or make it the patch builder; decide later.
- `status.md` freshness check in `hygiene-sweep.sh` can't see era-hub
  releases — separate hygiene fix.
