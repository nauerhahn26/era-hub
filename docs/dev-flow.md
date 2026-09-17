# era-hub dev flow — worktrees, releases, push-to-device

House law lives in `aac-board-builder/docs/parallel-worktrees.md`; this page is
the era-hub half, so a fresh session here isn't blind to it. Design record:
`docs/superpowers/specs/2026-09-15-dev-flow-worktrees-and-patch-releases-design.md`.

## The routine

Every feature gets its own worktree on its own branch; master is only ever
merged into, never edited. Dad says **"new feature: <name>"** in a chat opened in
the main checkout `/home/claude/new-era/era-hub`, and the session runs
(`W=/home/claude/aac-board-builder/tools/worktree.sh`):

```
bash $W open /home/claude/new-era/era-hub <slug> [--fix]
EnterWorktree path=/home/claude/new-era/era-hub--wt-<slug>
```

Then `bash $W sync|land|close /home/claude/new-era/era-hub <slug>` for "sync" /
"land it" / "close it". `land` wants a green era-gate stamp for the branch's tree
(`$ERA_GATE_STAMPS/<tree-sha>`, default `/tmp/era-gate-green/`, under 2 h old, no
`dirty=1`) — run `bash tools/era-gate.sh` in the worktree first. It never
restarts live 8377; that stays an explicit act in the main checkout.
Ports: `ERA_TEST_PORT` 8380-8389 for manual hubs, 8480+ scratch, 8500+ tunnels,
never 8377/8378/8425/8427/8450-8462. Refusal messages → fixes are tabled in the
aac-board-builder doc.

A feature that spans repos keeps one worktree per repo, all on the same slug
(`<repo>--wt-<slug>`), and `ERA_WT_SUFFIX=--wt-<slug>` is what makes
`assemble.sh`, `era-gate.sh` and `build-payload.sh` reach into them instead of
the main checkouts — per repo, falling back to `$ROOT/<repo>` for any repo the
feature doesn't touch. A green gate then stamps the hub's tree **and** every
sibling worktree tree it sourced (each with its own `dirty=1` verdict), so
`worktree.sh land` accepts each repo in turn; land in dependency order, in one
sitting while the 2 h stamps hold: era-core → era-board → era-making-words →
era-pencil → era-hub, and never restart the live 8377 hub in between.

## The three release shapes

A dist lives at `/home/claude/new-era/dist/release-<V>/` (sibling of the
checkout) — that is also where a `--dry-run` leaves its artefacts.

### Patch — `bash tools/release.sh vX.Y.Z --patch` (Z ≥ 1)

No SimplySign, nothing for dad to type. Four steps:

```
1/4 gate     era-gate fully green
2/4 build    build-dist.sh --patch: payload, tarball, zip, checksums, latest.json.
             NO makensis — the signed New-ERA-Setup.exe named by the LIVE
             latest.json's `installer` field is downloaded and re-attached, its
             Authenticode signature verified with osslsigncode first.
             X.Y must match that installer's ("patch $V cannot carry installer
             $TAG — cut a signed ${V%.*}.0 first").
3/4 VM e2e   vm-e2e.sh $DIST --only b — that installer fresh on the VM, self-
             updating to the candidate tarball: the only path a patch takes on
             any device.
4/4 publish  tag + gh release create with the six assets; the notes name the
             installer's tag.
```

The website keeps serving the previous signed installer; installed copies pick
up the new tarball on their next check.

### Signed — `bash tools/release.sh vX.Y.0`

```
1/5 gate
2/5 build    build-dist.sh --unsigned: same payload, plus an UNSIGNED Setup.exe
3/5 VM e2e   legs A + B on those very files (neither leg reads a signature)
4/5 sign     "VM green — ready for the SimplySign code (stage it now)."
             sign-installer.sh --check must pass, then build-dist.sh --sign-only
             re-cuts the installer WITH -DSIGN over the same payload and verifies
5/5 publish  tag + release, THEN leg C (vm-e2e.sh --post-publish) against the
             real download URL
```

A red leg C prints `LEG C RED — PULL THE RELEASE: gh release delete $V --repo
$REPO --yes` (re-attach the previous installer first if the website must stay
up) and exits 1. It deletes nothing itself — a pulled release 404s the website,
so a human decides.

### Flags

- `--dry-run` — both shapes: stop after the VM, publish nothing. Signed stops
  before the code is ever wanted, leaving an unsigned exe in `$DIST`.
- `--skip-gate` — re-cut past a green gate (lapsed login, starved VM host). Reads
  the same green stamp as `land`; a `dirty=1` stamp is refused outright. It skips
  the gate and nothing else — the build and the VM legs run again (~15 min).
- `--resume-sign` — signed only, when the SimplySign code died under you:
  re-enters at 4/5 over the dist the VM already drove (checks the stamp, that
  `$DIST/TREE` is this HEAD's tree, and that the tarball still matches
  latest.json's sha256).
- `--prerelease` — hidden from the website and the updater; legal with `--patch`.

## Push to one device

```
bash tools/push-device.sh <host> <dist-dir> [--dry-run]
```

`<host>` is an ssh alias (`i13`, `tablet`, `school-i13`). It serves `<dist-dir>`
on a loopback-only `python3 -m http.server`, opens ONE ssh session with `-R` (so
the device can fetch our feed) and `-L` (so we can reach the device's hub on
127.0.0.1:8377), POSTs `{"feed":"http://127.0.0.1:<R>"}` to `/update/check`, and
polls `/version` until the new build is live (90 s). Nothing is published.

It refuses before opening anything when: the ssh alias is unknown; the dist lacks
`latest.json` / `new-era-suite.tar.gz` / `checksums.txt`; the tarball's sha256
does not match `latest.json`; the dist's tree has no green stamp under 2 h (or it
is `dirty=1`); no free port in 8480-8499 / 8500-8599 outside the forbidden
8377-8462 band; the device can't reach the feed through `-R`; or the device is
already on a build ≥ the dist's — **the device never downgrades** (the updater
only moves when the feed's `build` stamp sorts strictly after the installed one).

**Loopback rule:** the hub honours a `{feed}` override only when the request's
socket peer is the machine itself, which is why the POST goes through `-L`. The
route is ungated and reachable on the LAN; an unrestricted override would let
anyone on a school network install code on the Tobii. Never loosen it.

**Chicken-and-egg:** a device honours the override only once it runs a hub
carrying that change, so the first delivery of it is a normal release (patch or
signed); an older hub ignores the body and the script says so plainly.
**App packs still come from the public feed** (`server.js` downloads packs from
`updater.FEED`) — only the suite tarball comes from the pushed dist.
