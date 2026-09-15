# Dev flow: one worktree per feature, merge-only master, unsigned patch releases, push-to-device

Date: 2026-09-15. Status: design approved in conversation (dad, 9/15); this is
the written record. Implementation plan follows via `superpowers:writing-plans`.

## 1. What dad asked for, and why the last attempt hurt

Dad works one feature at a time three quarters of the time, but ideas for
small side features arrive mid-feature and currently get shelved. He wants to
open a second chat, have it work on the side feature, and close the chat when
it lands — with the merge happening coherently and without the churn he saw the
one time he tried it. Separately, every release today needs him to enter a
SimplySign code, and that manual step discourages him from asking for small
things.

What the 8/29 attempt actually did (reflogs + `aac-board-builder/docs/status.md`
:551, :625): the worktree isolation itself worked, but the house rule said
*rebase onto master before merging* (`docs/parallel-worktrees.md` rule 2) and
two sessions raced master four times in one night — each landing forced the
other to rebase, retest and retry; one rebase stopped on a conflict because both
sessions had made the same `era-gate.sh` fix; one merge "looked green while
master was REV 3". On top of that every session had to write an `IN FLIGHT`
line into one shared `status.md` in a single-checkout repo, and no worktree was
ever closed (nine still exist for branches merged 9/6–9/10; `feat/audit-fixes`
is byte-identical to master).

The rebasing was a policy choice, not something git needs. This design removes
it.

## 2. Decisions (dad, 9/15)

- **A.** Every feature — including the "main" one — lives in its own worktree
  on its own branch. Master is only ever merged into, never edited. Live
  (8377, the main checkout) serves master = the last thing that landed.
- **B.** Patch releases are unsigned: they carry a new tarball for installed
  devices and re-attach the previous *signed* installer for the website.
- **Landing must be quick** — no second gate when nothing moved.
- **Testing on dad's own device** means merging to master and getting that
  build onto the device without signing and, preferably, without every family
  getting it: "push this version to this device" is a literal command.
- **Sign after the VM test, not before.** The SimplySign code is entered once,
  when everything else is already green.

Dad's original pick for the branch base was "the last published release" so a
side feature never sees half-built code. Under A master never holds half-built
code, so branching from master gives the same guarantee with fewer merge
conflicts (a feature merged an hour ago but not yet patched out is included
rather than colliding later). `open` therefore branches from master.

## 3. Branching flow

### 3.1 Vocabulary

- **Main checkout** `/home/claude/new-era/era-hub` — always on `master`, always
  clean. Serves live 8377. The only place merges into master happen.
- **Feature worktree** `/home/claude/new-era/era-hub--wt-<slug>` on branch
  `feat/<slug>` (or `fix/<slug>` — the tool accepts a `--fix` flag; nothing else
  cares which). One chat lives in one worktree.
- **Green stamp** — `era-gate.sh` already records the HEAD it went green on
  (`/tmp/era-release-gate.head` + `/tmp/era-release-gate.txt`). It becomes a
  per-tree record: `/tmp/era-gate-green/<tree-sha>` holding the summary line
  and a timestamp, written on every green run from any checkout. Anything that
  wants "is this tree gated?" (land, release, push-device) reads it by the tree
  sha of the commit in question, so two worktrees no longer overwrite each
  other's proof. `release.sh --skip-gate` reads the same record.

### 3.2 `worktree.sh` (in `aac-board-builder/tools/`, repo-agnostic as today)

```
worktree.sh open  <repo> <slug> [--fix]   branch from master, sibling dir; prints the port ledger
worktree.sh sync  <repo> <slug>           git merge master into the branch (a merge — never a rebase)
worktree.sh land  <repo> <slug>           merge --no-ff into master in the main checkout (§3.3)
worktree.sh close <repo> <slug>           remove worktree + branch; refuses unmerged (as today)
worktree.sh list  <repo>                  git worktree list — this IS the in-flight registry
```

`open` no longer tells the session to write an `IN FLIGHT` line into
`status.md`; `git worktree list` cannot go stale, and the ports rule
(`ERA_TEST_PORT` 8380-8389 for manual servers; scratch hubs 8480+, tunnels
8500+ per the 9/15 port memory) is printed instead. `open` also runs
`tools/assemble.sh` against test-data so the worktree's `public/` is usable
immediately (the gate does this lazily today; doing it at open makes the first
manual test faster).

### 3.3 `land` — the merge, and why it is quick

Preconditions, all checked before anything is written:

1. Main checkout is on master with a clean tree (`git status --porcelain`
   empty) — otherwise refuse with the offending paths. Nobody edits there.
2. `feat/<slug>` contains master's tip (`git merge-base --is-ancestor master
   feat/<slug>`). If master moved since the branch last synced: refuse with
   "master moved — run `worktree.sh sync`, gate, then land". The gate on the
   synced branch *is* the gate on the merge result, so master never needs a
   second one.
3. The branch's tree has a green stamp under 2 h old (§3.1). No stamp: refuse
   ("gate the branch first").
4. Machine-wide lock `/tmp/era-land.lock` (flock, waits) — two chats landing at
   once queue instead of racing.

Then: `git merge --no-ff feat/<slug>` (merge commit message names the feature
and the green stamp), `git push origin master`. Ten seconds. It prints the next
steps rather than doing them: restart live if the change matters on 8377
(`worktree.sh` never restarts live — that stays an explicit act in the main
checkout, as today), `close` when done, `release.sh … --patch` when dad says.

No history is ever rewritten. Master is a chain of merge commits; feature
branches keep their own commits. Rule 2 of `parallel-worktrees.md` ("rebase
onto master before merging") and the close-out's "rebase-then-ff preferred"
are deleted.

### 3.4 Policy text that changes

- `aac-board-builder/docs/parallel-worktrees.md` is rewritten as the **default**
  flow (no longer opt-in), keeping rules 1, 3, 4, 5 (frozen main checkout,
  gates serialize, unique ports, live data only in main) and replacing rule 2
  and the close-out with §3.3. The `IN FLIGHT` announcement goes.
- `aac-board-builder/CLAUDE.md` "How we work": "One active session per repo at
  a time" becomes "one active session per *worktree*; `worktree.sh list` shows
  what is in flight"; the PARALLEL EXCEPTION paragraph becomes the one-line
  default.
- `era-hub/tools/era-gate.sh` header comment keeps pointing at the
  aac-board-builder doc (that repo is the house-law home); a one-paragraph
  `docs/dev-flow.md` in era-hub summarises the flow and links there, so a fresh
  era-hub session isn't blind to it.

### 3.5 Cleanup landing with this feature

- `close` the eight merged worktrees (`books-loose`, `built-once`, `clothing`,
  `launcher`, `movie-player`, `reader`, `smartscreen`, and the tool-made
  `.claude/worktrees/agent-*`); delete the dead unmerged `feat/install-qa`
  (297 behind, never pushed) and `feat/app-picker` on origin after confirming
  they are ancestors of master.
- `feat/audit-fixes` / `era-hub--wt-install-qa` is where this spec is written.
  It lands by the new `land` (first use), then is closed. From then on there is
  no "trunk alias" branch.
- Remove the stale 8/28 `IN FLIGHT (worktree): install-qa` block from
  `status.md`.

## 4. Release shapes

### 4.1 Today, and the two facts that make patches possible

Signing touches exactly two artifacts: the uninstaller stub and
`New-ERA-Setup.exe` (`installer.nsi:15-18`). Installed devices never see an
installer: `update.js` fetches `latest.json` and `new-era-suite.tar.gz` from
GitHub's `releases/latest/download/` alias, checks the sha256 from
`latest.json`, and overlays the files. The website's download button points at
the same alias for `New-ERA-Setup.exe`. So a release *must* carry a
`New-ERA-Setup.exe` (or the website 404s), but that exe does not have to be
new.

### 4.2 Version numbers

- **Signed release** — `vX.Y.0`: new installer, new tarball. Cut when something
  the tarball overlay cannot deliver changed (`installer.nsi`, the bundled node
  runtime, the pack layout `update.js` excludes), or whenever dad wants the
  download page refreshed.
- **Patch release** — `vX.Y.Z`, Z ≥ 1: new tarball, previous signed installer
  re-attached. `release.sh` enforces that a `--patch` version shares `X.Y` with
  the installer it carries; a signed cut may use any number (a re-cut after a
  bad installer is `vX.Y.1` signed, and the next patch is `vX.Y.2`).

`latest.json` gains one field: `"installer":"vX.Y.0"` — the tag whose
`New-ERA-Setup.exe` this release serves. A signed release writes its own tag
there. This is how the next patch finds the exe to re-attach (fetch the current
`latest.json`, read `installer`, `gh release download <tag> -p
New-ERA-Setup.exe`), how `vm-e2e.sh` picks the previous installer in patch mode,
and how the release notes say truthfully what the installer is.

### 4.3 `release.sh vX.Y.Z --patch`

```
1/4 gate        era-gate (or --skip-gate against the green stamp, as today)
2/4 build       build-dist.sh --patch: payload, tarball, zip, checksums, latest.json;
                NO makensis. Downloads the installer named by the live latest.json's
                `installer`, verifies its Authenticode signature with osslsigncode
                (refuses on anything but "Signature verification: ok"), places it
                in $DIST as New-ERA-Setup.exe, records `installer` in latest.json.
3/4 VM e2e      vm-e2e.sh $DIST --only b — the previous release (that same signed
                installer, fresh on the VM) self-updating to the candidate tarball.
                That is the only path a patch takes on any device; leg A's fresh-
                install coverage of the installer bytes was earned when they were cut.
4/4 publish     tag + gh release create with the six assets; notes say
                "Installer: vX.Y.0 (code-signed, Certum). Installed copies update
                themselves to vX.Y.Z on first run."
```

No SimplySign preflight, no code, nothing for dad to type. A fresh install from
the website gets `vX.Y.0`, boots, checks the feed 90 s later and updates itself
— the normal "there's an update" experience. `checksums.txt` lists the
re-attached exe's real hash.

### 4.4 `release.sh vX.Y.0` (signed) — reordered

```
1/5 gate
2/5 build       build-dist.sh: payload, tarball, zip, checksums, latest.json,
                and an UNSIGNED New-ERA-Setup.exe (makensis without -DSIGN)
3/5 VM e2e      legs A + B on the unsigned exe (neither leg reads a signature)
4/5 sign        "VM green — ready for the SimplySign code." Dad stages the code;
                sign-installer.sh --check must say the login is live; makensis
                runs again WITH -DSIGN (same payload; only the NSIS wrapper and its
                uninstaller stub are rebuilt, both signed), osslsigncode verify
                must say ok. --dry-run stops before this step.
5/5 publish     as today, then run leg C (tests-vm/leg-c-smartscreen.e2e.mjs,
                written but never wired) against the real download URL; a red
                leg C prints "PULL THE RELEASE" and exits 1 — the release stays
                up until a human acts, because pulling it silently would 404 the
                website.
```

The signed exe is not byte-identical to the one the VM drove (that was already
true of leg C's job, and is why it exists); the tarball — what every installed
device receives — is the same file through all five steps.

Safety fix riding along: `sign-installer.sh` today exits 0 with "UNSIGNED" when
`signing.env` is absent and `build-dist.sh` skips verification, so a signed
release can silently ship unsigned while the notes claim a signature. In signed
mode a missing `signing.env` or a failed sign is a hard stop. The unsigned build
in step 2 is requested explicitly (no `-DSIGN`), never by a missing file.

### 4.5 Recorded where

The publish record keeps going into the feature's plan file as today; the
`installer` field in `latest.json` on GitHub is the machine-readable truth.

## 5. Push to one device

### 5.1 Why

A patch on GitHub reaches every family within 6 h. Dad wants to test a landed
build on his own device first, and it is acceptable — but not preferred — that
another family gets it early. Pushing directly to a device satisfies the
preference: nothing is published until he says "patch it".

### 5.2 `tools/push-device.sh <host> <dist-dir>`

`<host>` is an ssh alias (`i13`, `tablet`, `school-i13` — Tailscale, user
`claude`). Steps:

1. Refuse unless `<dist-dir>/latest.json` and `new-era-suite.tar.gz` exist and
   the build's tree has a green stamp (§3.1) — the era-gate, not the VM: dad
   accepts a bug on his own device, and the VM leg is available when wanted
   (`release.sh --patch --dry-run` produces a dist that passed leg B).
2. Serve `<dist-dir>` on a local port (8480+ range; python `http.server`) and
   open one ssh session with `-R <8500+>:127.0.0.1:<local>` (feed reaches the
   device) and `-L <8500+>:127.0.0.1:8377` (the device's hub reaches us).
3. `POST http://127.0.0.1:<L>/update/check` with body
   `{"feed":"http://127.0.0.1:<R>"}`; print the result (`updated`/`up-to-date`/
   `bad-checksum`…); poll `/version` until `build` equals the pushed build or
   90 s pass; report.

`ssh -R` on Windows OpenSSH server works with the existing `claude` user; the
tunnel ports follow the 9/15 rule (tunnels 8500+, never a suite port). No
PowerShell is involved (memory: PS 5.1 `Invoke-WebRequest` hangs on hub routes).

### 5.3 Hub change (the only code change on the device side)

`POST /update/check` accepts an optional JSON body `{feed}`. The override is
honoured **only when the request arrives from loopback** (`req.socket.
remoteAddress` ∈ 127.0.0.1 / ::1 / ::ffff:127.0.0.1); from any other address
the body is ignored and the default feed is used, exactly as today. The
endpoint is reachable on the LAN and ungated; an unrestricted feed override
would let anyone on a school network install code on the Tobii. `updater.
check(port, feed)` takes the feed as a parameter; the boot and 6-hourly ticks
keep using the default. `/version` is unchanged.

Consequences that need no code: the device's `VERSION` becomes the pushed build
stamp, which is newer than the public `latest.json`, so the 6-hourly tick
reports `up-to-date` (the updater never moves backwards). When the patch is
later published from a fresh `build-dist`, its stamp is newer still and the
device moves to it — a no-op overlay if the tree was the same.

Chicken-and-egg: devices only honour the override once they run a hub that has
this change, so the first delivery of it is a normal release (patch or signed).
`tests-vm/lib/vm.mjs` already sets `ERA_UPDATE_URL` for the VM; that stays.

## 6. Testing

- `tests/update.test.mjs` (existing suite): `check(port, feed)` uses the
  override; the server route honours `{feed}` from loopback and ignores it
  from a non-loopback socket (mock `remoteAddress`).
- `worktree.sh`: `aac-board-builder/tools/worktree.test.sh` (that repo has no
  tests/ dir; the gate does not collect it — it runs by hand and from the
  plan) builds a throwaway repo and exercises open → commit → sync (after a master move) →
  land (refuses without stamp, refuses when master moved, succeeds after sync
  + stamp) → close; asserts master is a `--no-ff` merge and no rebase reflog
  entry exists.
- `release.sh --patch --dry-run` on the real tree: gate, build without
  makensis, installer re-attached and signature-verified, leg B green.
- `release.sh --dry-run` (signed shape) stops after leg A/B with an unsigned
  exe and never asks for a code.
- First real use is this feature itself: land via `land`, `release.sh v0.33.3
  --patch` carrying the v0.33.2 installer (the current `latest.json` has no
  `installer` field — the script falls back to `version` for that first
  patch), then `push-device.sh i13` is exercised on the *following* patch, once
  the i13 runs a hub with §5.3.

## 7. Non-goals

No separate update channel or second feed URL; no per-family targeting beyond
push-to-device; no change to the 6-hour cadence; no Authenticode verification
of the tarball on devices (a sha256 from the same host is what it is — noted,
not fixed here; Gap 14 in the content-pipelines plan covers `installPack()`);
no changes to `era-board`, `era-core`, or the CI `build-installer.yml` (which
builds an unused unsigned exe on every tag — left alone, out of scope).
