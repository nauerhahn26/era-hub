# Book sharing — implementation plan

**Spec:** `docs/superpowers/specs/2026-09-22-book-sharing-design.md` (commit `f275b5f`)
**Branch:** `feat/book-sharing` (era-hub, worktree) · **Base:** `ac69eeb`
**Date:** 2026-09-22

## Preflight (run 9/22 against `ac69eeb`) — 1 blocker fixed, 4 findings

| # | Finding | Class | Resolution |
|---|---|---|---|
| 1 | Spec said "nudge the mirror with `drive.sync()`". `sync()` ends in `onSynced`, whose `server.js` fan-out starts `clothing.regenerate(true)` — **a vision spend on every import**. | **Blocker** | Spec amended before coding: use `drive.mirrorBook(dir)` (`drive.js:679`), written for exactly this — one book, manifest last, `.part`-atomic, no prune, ledger kept. |
| 2 | No binary request body anywhere in the hub; every `POST` accumulates a **string** with a 4–64 KB cap. | Warning | T3 writes the first streaming reader (to a temp file, byte-counted). Do not extend the string reader. |
| 3 | No zip library, no `package.json`, no deps. | Info | `zlib.crc32` is available (device node **22.23.2**, build box 22.22.2). Stored entries only ⇒ no deflate. T1 gate-asserts `typeof zlib.crc32 === "function"`. |
| 4 | `build-payload.sh:30` is an **explicit** engine-file list; `public/reader` is copied wholesale (`:119`) and is the `reader` pack's marker. | Warning | `erabook.js` + `books-share.js` must be added to `:30` in the same commit. The require-scan at `:38` fails the build if forgotten — loud, not silent. |
| 5 | `drive.mirrorBook` already answers `{blocked:"needs-local-drive"}` for "no content folder". | Info | Import reuses that word; no second vocabulary for the same state. |

**Ports claimed** — grepped across all five repos' `tests/` **and every open worktree**
(`tunnel-ports-never-test-ports`): 8377–8468 and 8480 are taken, 8469–8479 are free.
**8469** = `reader-share.test.mjs`; **8470** + **8471** = the two-hub e2e. Unit tests
spawn no server.

## Guardrails (every task)

- **TDD, no exceptions** (`superpowers:test-driven-development`): the test is written and
  seen to **fail** before the implementation. This feature's whole risk surface is a file
  from outside the family; a test that never failed proves nothing about a jail.
- **Verification is a command, not a claim** — each task below states the exact command
  and the exact expected output. `superpowers:verification-before-completion` applies:
  paste the output, never assert from intent.
- **Adaptation protocol** — STOP and report rather than improvise if: the format needs a
  third entry, the hold fights `dwell.js` in a way `board-edit.js` did not, or any test
  needs its assertion weakened to pass. A weakened assertion is a design change and comes
  back here.
- **Phase gate** — `bash tools/era-gate.sh` green at every phase boundary, and
  `rae-flow:reviewing` after Phase 2 and Phase 4.

## Phase 1 — the format (`erabook.js`)

*Posture hint: **implementing**. Closed problem, exact spec, no judgment calls.*

- **T1.1** `tests/erabook.test.mjs` first: round-trip byte-for-byte; video page; silent
  page (no audio); CRC mismatch refused; truncated archive refused; `../` entry name;
  absolute entry name; entry-count cap; size caps; symlink entry. Plus the gate assertion
  `typeof require("zlib").crc32 === "function"`.
- **T1.2** `erabook.js`: `pack(dir, manifest)` → a readable stream; `unpack(file, destDir)`
  → `{title, files}`. Stored (method 0) entries, local headers + central directory + EOCD,
  `zlib.crc32`. Declared sizes are **checked against bytes actually written**, never
  trusted.
- **Verify:** `node --test tests/erabook.test.mjs` → all pass, 0 fail. Then, by hand:
  `unzip -l /tmp/x.erabook` lists the entries (proves it is a real zip, not just
  self-consistent).

## Phase 2 — policy + routes (`books-share.js`, `server.js`)

*Posture hint: **implementing** for the routes; **collaborating** for the refusal wording
— parent-facing sentences are dad's voice, and §5.2's table is the draft, not the law.*

- **T2.1** `tests/books-share.test.mjs` first: `sources/` and `.build/` absent from the
  archive; a file the manifest does not name absent; a manifest naming a missing file
  refuses; import lands in `<folderPath>/books/` and **not** `<DATA>`; second import of the
  same book gets `-2` **and the first book's reading position is untouched**; no content
  folder → `needs-local-drive`; every refusal code in spec §5.2 has a test; the Windows
  reserved-name fallback (`CON`, trailing dot, empty-after-clean).
- **T2.2** `books-share.js` — policy only: what may be shared, where a share goes, what an
  import may be, where it lands, `mirrorBook` after. `BOOK_EXTS`/`BOOK_DENY_DIRS` move here
  and `server.js` imports them back (the one targeted refactor; nothing else moves).
- **T2.3** `server.js`: `GET /books/<slug>.erabook` (**matched before** the `/books/`
  static route at `:2091`, else the jail 403s the extension), `POST
  /books/<slug>/share-to-drive`, `POST /books/import?source=file` with the new streaming
  body reader.
- **Verify:** `node --test tests/books-share.test.mjs` → all pass. Then on a scratch hub:
  `curl -sS -o /tmp/b.erabook -D- localhost:8469/books/<slug>.erabook` → 200 +
  `Content-Disposition`; `curl -sS -X POST --data-binary @/tmp/b.erabook -H 'Content-Type:
  application/octet-stream' localhost:8470/books/import?source=file` → `{"ok":true,...}`.
- **Gate:** `bash tools/era-gate.sh` green, then `rae-flow:reviewing` on the diff.

## Phase 3 — send (`public/reader/reader-share.js`)

*Posture hint: **implementing**, against `board-edit.js` as the reference.*

- **T3.1** `tests/reader-share.test.mjs` first (harness copied from `reader-ui.test.mjs`:
  real `server.js`, scratch port **8469**, throwaway `ERA_DATA_DIR`, the synthetic "Luna
  the Fox" fixture — never real book content; Playwright context with **`hasTouch: true`**).
  Asserts: touch hold opens the sheet; **mouse hold does nothing**; short touch still opens
  the book; card is not `.dwell` while armed and is again after; unfinished card says "not
  finished yet"; the sheet freezes the bar's doors; "Send it now" absent when
  `navigator.canShare` is stubbed false.
- **T3.2** the hold + sheet per spec §4: 1600 ms twin of `board-edit.js`'s `HOLD_MS`,
  `pointerType === "touch"` as the entire filter, `contextmenu` suppressed, `.dwell`
  dropped while armed (the `dwell.js` 150 ms tap-rescue), the three outs in spec order.
- **Verify:** `node --test tests/reader-share.test.mjs` → all pass.

## Phase 4 — receive (`public/reader/reader-strip.js`)

*Posture hint: **implementing**.*

- **T4.1** Tests first, same harness: the strip mounts on the shelf screen only; its button
  has **no `.dwell` and no `data-dwell-*`**; **the 🚪's centre does not move when the strip
  mounts** (spec §5.1 — `doorbar.js`'s standing warning about her motor plan); the add
  sheet lists one source; a chosen file posts and the shelf repaints with the book on it;
  each refusal renders its sentence.
- **T4.2** the strip + add sheet per spec §5.1–5.2, `source` on the wire from the first
  commit.
- **Verify:** `node --test tests/reader-strip.test.mjs` → all pass.
- **Gate:** `bash tools/era-gate.sh` green, then `rae-flow:reviewing` on the full diff.

## Phase 5 — behavioural verification (the feature, not the units)

*Posture hint: **collaborating**. This is where a human reads the result.*

Unit tests prove the parts; this proves the feature. Two real hubs, a real book, no mocks:

- **T5.1** `tests/book-sharing-e2e.test.mjs` — hub A on **8470** with the fixture book, hub
  B on **8471** with an empty shelf and a temp content folder. Export from A over HTTP,
  import into B over HTTP, then assert against **B**: `/books/index.json` has the book; its
  cover and first mp3 both `GET` 200; the package on disk is in B's **content folder**, and
  `<DATA>` got its copy via `mirrorBook`.
- **T5.2** By hand on a scratch hub, with Playwright driving a touch context: hold a book →
  "Put it in my Drive" → the `.erabook` is on disk where the sheet says it is → feed that
  same file to a second hub's "+ Add a book" → **screenshot the book open on the second
  shelf.** That screenshot is the acceptance evidence, not a passing test count.
- **T5.3** Full gate: `bash tools/era-gate.sh` → `== era-gate: N passed, 0 failed ==`.

## Out of scope (spec §9)

Other import sources; a hosted link; sharing a reading position. The `source` parameter is
the only seam left behind, and nothing is stubbed for the others.

## Landing

`bash /home/claude/aac-board-builder/tools/worktree.sh land /home/claude/new-era/era-hub
book-sharing` once the gate is green and stamped. Release only on dad's word; this is a
patch-shaped change (`--patch`, no signing) if he wants it on the devices.
