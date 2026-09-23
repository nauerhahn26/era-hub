# One wardrobe, two computers (design)

**Date:** 2026-09-23 · **Branch:** `fix/weather` (era-hub only) · **Unit C of three**
**Origin:** dad, 9/23:

> *"if I upload to G Drive, and there are two computers that are synced to it and both
> have access, then in theory both could run the clothing through the AI in parallel and
> not know about the other. So I'm wondering, one, how do we resolve that? … once you do
> one photo, clothing, you should freeze it. The other should understand that someone's
> processing. … so maybe timestamp and after some point in time is still not resolved,
> then the other one can pick it up."*

**Sequencing: this unit lands before unit B's re-describe pass.** That pass spends one
vision call per garment; without this unit both devices spend it and produce two
different wardrobes.

## 1. It already happened, and here is the receipt

On **2026-09-21 between 00:50:57 and 00:56:13** both devices described the same twelve
garments, two minutes apart, neither aware of the other:

```
i13     00:50:57  Striped knit top          tablet  00:53:07  Striped sweater
        00:51:24  Printed cardigan   warm=cool     00:53:26  Printed cardigan  warm=warm
        00:53:06  Leopard print sweater             00:54:36  Cheetah long sleeve
        00:55:23  Patterned leggings                00:55:39  Textured pink leggings
        …twelve in all, 24 vision calls for 12 photos…
```

Those twelve **are** the divergence: every name, warmth, palette, pattern, colour and
crop difference between the two live wardrobes was created in that six-minute window.

### What is NOT broken (verified, and it narrows the fix)

The dedup works. Both model call sites consult the shared log *before* spending —
`namePhotos` (`clothing-worker.js:832` before `:849`) and `describeCatalogued`
(`:699` before `:717`) — keyed on the photo's path-derived id and falling back to its
content hash (`clothing-log.js:293-298`). The mirror carries `.era` correctly and
byte-compares it (`drive.js:331-332`, `:624-626`). Item ids are `md5(relative path)`
(`clothing-worker.js:817`), identical on every device including a fresh install.

Proof it works: after the 9/14 wipe the tablet re-ingested all 57 photos and published
only **12** tag lines. For the other ~45 it found the i13's answers and paid nothing.

So the hole is narrow and specific: **two devices reaching a genuinely new photo before
either has published.** Everything else in the sharing design is sound.

### The second, quieter hole

Nothing ever reconciles. `needsAttributes` returns false the instant `attrsAt` exists
(`clothing-worker.js:630`) and nothing anywhere reopens that door. A device that
described a garment first is right forever on that device and wrong forever on the
other. The twelve above will stay split until something adopts a winner.

## 2. Why a claim file is the wrong primitive here

Dad's proposal is the textbook answer and it is what the **book** pipeline does —
`job.json` with `claimedBy`, a 30-minute TTL, a 60-second heartbeat, a second answer
from the log when the file is caught mid-mirror, and `drive.js:270` byte-comparing
that one file so a same-length heartbeat actually propagates. It works there.

It does not transfer, for two reasons:

1. **The claim travels through the same sync as the work.** A device writes a claim
   locally; Drive for Desktop uploads it on its own schedule; the other device pulls it
   on its own ~10-minute timer (`drive.js:535`). Round trip: tens of minutes. The 9/21
   collision resolved in **two minutes and ten seconds**. A lock that slow cannot
   arbitrate a race that fast — it would cost files and prevent nothing.
2. **The unit of work is tiny and there are dozens of them.** A book is one large,
   long-running job; a claim file per book is proportionate. 57 claim files churning
   through a mirrored folder is not.

## 3. Ownership, decided by the photo

No negotiation, so no race:

```
roster = sorted(device ids that have a tags/<id>.jsonl, plus this device)
owner(photo) = roster[ bigintFromHex(photo.sha256) mod roster.length ]
```

Every device computes the same answer at the same instant from data it already has —
the hash is already on the entry (`clothing-worker.js:802`, before any branch) and the
roster is already discoverable (`clothing-log.js sharedWriters`, `:345-368`). A device
that is not the owner skips the call and waits for the tag line.

It also **splits the bill**: with two devices each pays for about half the new photos,
instead of one paying for all or both paying for all.

### The takeover, which is dad's timestamp rule

A non-owner may take a photo when it has been undescribed for `TAKEOVER = 45 min` of
*this device's own uptime* since it first saw the photo. First-seen is recorded locally
beside the existing photo-set memory (`.clothing-photoset`, I23) — no new shared file.

Uptime, not wall clock, so a device that was asleep for a day does not wake up and
immediately seize every photo its partner legitimately owns.

45 minutes is comfortably longer than a full mirror round trip and shorter than a school
day. It covers the cases dad named: the owner is at school, powered off, or wedged
mid-process.

### One more cheap win

`shared()` is memoised for the whole worker run (`clothing-worker.js:77-80`), and a
57-photo ingest takes ~5 minutes at its 5 s spacing (`:917`). So the map is read once,
at the start, and a tag line arriving mid-run is invisible. Re-read the merged map
before each `askModel`. It is a local file read; it costs nothing and closes several
minutes of the window on its own.

## 4. The heal — free, and it fixes the twelve

A per-build **convergence sweep**, modelled exactly on `applyManual`
(`clothing-worker.js:989-1018`) which already does this shape for manual lines: walk the
merged tag map, adopt the winner, write only what changed.

**What it adopts:** the descriptive fields only — `name`, `coverage`, `weight`, the
legacy `warmth`, `colors`, `pattern`, `palette`, `vibe`, `occasion`.

**What it never adopts:** `crop` and `rotate_deg`. The reason at
`clothing-worker.js:701-706` stands — taking a foreign geometry without redrawing the
tile turns a correct tile wrong. Geometry stays with the device that drew the picture.

**The winner rule**, deterministic so every device agrees without talking:

1. a `manual: true` line beats any model line (unchanged, `clothing-log.js:256-261`);
2. among manual lines, newest `t` (unchanged);
3. among model lines, **earliest `t`** — the family paid for that answer first.

Point 3 is a change from today's newest-wins, and it is the point of the whole sweep:
newest-wins oscillates, because each device's own later answer would keep winning back.
Earliest-wins is stable, converges, and makes the merged map a pure function of the log.

This costs **zero AI calls** — it reads a file both devices already have.

## 5. Three bugs found on the way

**5.1 A parent's correction can silently never leave the device.** `appendTag` returns
`false` (never throws) when there is no Drive folder or `<folder>/clothing` is not yet a
directory (`clothing-log.js:131-163`). `server.js:2874-2882` **ignores the return
value** and answers `200 {ok:true}`. The parent is told the correction shipped; it is
device-local forever, with one console line as the only trace. The route must report it:
`{ok:true, shared:false}`, and the sheet says *"Saved on this device — not shared yet."*

**5.2 A manual edit to anything but category, occasion or hidden is silently dropped.**
`manualFields` (`clothing-worker.js:982-988`) whitelists three fields and `applyManual`
skips a line whose fields all fall outside it (`:1007`) — without even stamping
`manualAt`. Meanwhile the route copies `name`, `warmth`, `colors`, `pattern`, `palette`,
`vibe`, `rotate_deg` and `crop` onto the shared line (`server.js:2876-2880`), and a
device that has *not* yet ingested the photo **does** honour them at first ingest
(`:839-843`). Same line, two different behaviours. Unit B needs `coverage` and `weight`
on this list; this unit makes the wire format and the whitelist agree.

**5.3 Saving an AI key starts a build without syncing first.** `server.js:2735` fires
`clothing.regenerate(true)` 500 ms later with no `drive.sync()`, unlike
`POST /clothing/regenerate` (`:2744-2746`) which syncs first. On a fresh install the
natural order — install, point at Drive, paste key — hits exactly that door and ingests
against a folder the mirror has not filled. Add the sync.

## 6. Known, documented, not fixed here

**The device id changes on a wipe.** It is `slug(hostname) + "-" + 4 hex`
(`device-id.js:65-66`) stored in `<DATA>/device-id`; a wipe regenerates the tail. The
tablet's 9/14 wipe gave it a new writer name. Consequences: its orphaned `picks/`
directory is read back as a stranger's and double-counts its own history
(`clothing-log.js:305`), and "Shared with: N devices" inflates permanently because
nothing garbage-collects `.era`. Worth a follow-up; not on the path to the 9/21 bug.

**Reads and writes use different roots.** Reads come from `<DATA>/clothing/.era`
(`clothing-log.js:177`), writes go to `<Drive folder>/clothing/.era` (`:147`), and
`drive.js` is read-only by design. A file placed by hand in the DATA copy works
perfectly on that device and is invisible everywhere else, forever. Worth a one-line
startup warning when a tags file exists in DATA with no counterpart upstream.

## 7. Testing

New `tests/clothing-ownership.test.mjs`:

1. Two devices, same roster, same photo hash → the same owner. Deterministic across runs.
2. A non-owner does not call the model and writes no tag line.
3. Ownership splits a set of photos roughly evenly across two devices.
4. A non-owner takes a photo after `TAKEOVER` of its own uptime, not before.
5. Uptime, not wall clock: a device idle for a day does not immediately seize on wake.
6. A roster of one (a single-device family) owns everything — no regression.
7. The merged map is re-read between calls: a tag line written mid-run is honoured.

New `tests/clothing-converge.test.mjs`:

8. Two devices with conflicting model lines converge on the **earliest**, from both
   directions, and converge to the *same* answer.
9. A manual line still beats an earlier model line.
10. `crop` and `rotate_deg` are never adopted from another device.
11. The sweep spends no AI call and is idempotent — a second build changes nothing.
12. Replaying the 9/21 log fixture heals all twelve garments.

Plus: `appendTag` returning false surfaces as `shared:false` (5.1); a manual `weight`
edit reaches the catalogue (5.2); saving an AI key syncs before it builds (5.3).

## 8. Does this belong to books too?

No. Books are already safe, for a structural reason worth writing down: they are built
**in place inside the Drive folder**, so every marker they use to avoid redoing work —
`.build/text.json`, `narration.json`, the manifest, the spend ledger — is shared for
free. Clothing stamps `attrsAt` into the **device-local** data directory, which is
exactly why it cannot see what the other device has done.

The one thing worth borrowing back from books is discipline, not code: books put
`job.json` in `drive.js`'s byte-compare list so a small file propagates promptly. If a
future unit ever does add a shared clothing marker, it belongs on that list.

(Five stale comments in the book pipeline claim the mirrorBook rule exists to avoid
"an AI vision spend on every import" — `books-share.js:21`, `drive.js:663`,
`content.js:629`, `server.js:3297`, `tests/books-share.test.mjs:20`. The rule is right;
the reason has been wrong since `2ce7459`. Separate cleanup, noted so it is not lost.)
