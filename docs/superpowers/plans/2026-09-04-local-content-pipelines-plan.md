# Implementation plan: local content pipelines (books, music, movies)

Date: 2026-09-04. Produced by `rae-flow:planning` (subagent mode, no user
interaction — every unresolved question is written down, not asked).

- **Design source:** `docs/superpowers/specs/2026-09-04-local-content-pipelines-design.md`
- **Repos touched:** `era-hub` (worktree `era-hub--wt-install-qa`, branch
  `feat/audit-fixes`) and `era-board` (currently `master` — needs its own
  branch/worktree; `era-hub/public/board` is a symlink to `era-board/app`,
  gitignored, so board work is a *separate commit in a separate repo*).
- **Preflight verdict:** PASS WITH WARNINGS — 3 near-blockers with agreed
  mitigations, 14 warnings, 9 infos. Full detail in §A below; the mitigations
  are folded into the tasks as constraints.

---

## A. Preflight results (design vs repo reality)

Status: **PASS WITH WARNINGS**. No blocker without a viable resolution path,
so the skeleton is produced. Each gap below carries a task id where it is paid.

### A1. Near-blockers (resolved by a scope constraint, must not be skipped)

**Gap 1 — The hub has no write path into Drive.**
*Category:* Structure. *Design assumes:* outputs land in the family's
`New ERA Content/` folder and reach other devices through the existing mirror
(spec §1, §4 "Once per family"). *Repo reality:* `drive.js:9` — "Read-only
scope; nothing is ever uploaded"; the OAuth scope is
`drive.readonly` (`drive.js:19`); `sync()`/`syncLocal()` only copy
Drive → `<DATA>` (`drive.js:180-210`, `drive.js:308-321`). There is no upload
code anywhere. *Impact:* in **API mode** a built book can never reach the
family's Drive or a second device — the whole "pay once per family" promise
fails silently. *Classification:* Blocker for API mode, Warning for local mode.
*Mitigation (adopted):* **content jobs run only in local mode** — the worker
builds *in place* inside `cfg.folderPath/books/<Title>/` (a real folder that
Google Drive for Windows uploads for us), and the existing mirror copies the
result into `<DATA>` for serving. `content.scan()` returns
`{skipped:"needs-local-drive"}` when `drive.status().mode !== "local"`, and
Settings says so. API-mode building is explicitly out of scope for this plan.
*Paid in:* T2.2, T2.10.

**Gap 2 — `movies/` is not mirrored at all.**
*Category:* Dependency. *Design assumes:* `New ERA Content/movies/` mirrors
like the others (spec §2 folder contract, §2 mirror change 2). *Repo reality:*
`drive.js:22` — `MIRROR_SUBDIRS = ["books", "music", "content", "clothing"]`.
`movies` is absent, so `createContentFolder()` (`drive.js:341-352`) never
creates it and `syncLocal()` never copies it; `<DATA>/movies` (`server.js:72`)
is populated only by the installer/dev tooling today. *Impact:* every movie a
parent adds from the board would live on one device and vanish on reinstall.
*Mitigation:* add `"movies"` to `MIRROR_SUBDIRS`; note it also changes
`contentReady()` (`drive.js:261-270`) and therefore the Settings checklist.
*Paid in:* T1.2.

**Gap 3 — the movies catalog schema in the spec is not the schema the recipe reads.**
*Category:* Structure. *Design assumes:* the writer stores
`{title, year, tmdbId?, link, provider, poster, addedBy}` (spec §6).
*Repo reality:* `moviesRecipe()` requires `id` matching `/^[a-z0-9-]{1,64}$/`
(`server.js:670`), `kind: "movie"|"show"` (`server.js:674,678`),
`launch.url` (`server.js:675`), and sorts by `tier`/`rank`/`comfort`
(`server.js:686-689`); posters are `"movies/" + t.poster` where `poster` is
`"posters/<slug>.jpg"` (`era-family/tools/fetch-posters.mjs:64,76`). A title
written in the spec's shape is silently dropped by the filter at
`server.js:670`. *Impact:* "add a movie" appears to work and nothing shows on
the board. *Mitigation:* the writer emits the **existing** schema and adds the
spec's provenance fields alongside (`tmdbId?`, `addedBy`, `year?`), defaulting
`kind:"movie"`, `tier:"core"`, `rank:` next free. *Paid in:* T5.1.

### A2. Warnings (documented, mitigated, proceed)

| # | Gap | Evidence | Mitigation | Task |
|---|---|---|---|---|
| 4 | `/books/review/` is unreachable — the `/books/` catch-all jail fires first and 404s a extension-less path | `server.js:1453-1456` routes before static `server.js:1761`; `serveMediaJail` 404s ext `""` at `server.js:452` | Serve the page at **`/book-review/`** (`public/book-review/index.html`), a free prefix. If the spec's URL is insisted on, add an explicit `urlPath === "/books/review/"` branch *above* line 1453 plus its own 301. | T3.1 |
| 5 | The serve-side "allowlist" is by **extension**, not by name — `sources/*.jpg` and `.build/*.json` are served today | `BOOK_EXTS` `server.js:439`; `serveMediaJail` `server.js:446-452` | Add a path-segment deny for `sources` and `.build` inside `serveMediaJail` for the books jail only. (`.build/log.jsonl` is already denied — `.jsonl` is not in `BOOK_EXTS`.) | T1.3 |
| 6 | Slugify breaks the slug↔directory identity `serveBook` relies on | `booksIndex()` uses `d.name` verbatim as the slug (`server.js:411-431`); `serveBook` jails `rest` straight into `BOOKS_DIR` (`server.js:445`) | `booksIndex()` returns `{slug, dir}`; `serveBook` resolves the first path segment slug→dir through a memoized index before jailing. Reader reading-position keys are per-slug (`savePos(slug)`, `public/reader/reader.js`) so existing positions reset once — acceptable, note it. | T1.4 |
| 7 | The spec's PowerShell `System.Drawing` / `ffmpeg` resize is a pattern the repo does not use and does not need | the hub already does pure-JS JPEG decode → scale → encode: `ensureCodecs` `clothing-worker.js:129`, `scaleRgba` `:136`, `writeJpg` `:206`, `jpeg.decode` `:194`, vendored `vendor/jpeg-js/lib/{decoder,encoder}.js`; EXIF orientation in `image-orient.js:13,78` | **Do the resize in JS** by extracting the existing helpers into a shared module; no spawn, no platform branch, works identically for the Linux operator. Keep "use the original if resize fails" as the documented fallback (spec §4 step 1). | T2.5 |
| 8 | ElevenLabs key is **not** in `ai-config.json` | key lives in `<DATA>/tts-config.json` (`server.js:864,890-897`), written by `POST /tts-key` (`server.js:1574-1596`); `ai-config.json` is `{provider, apiKey}` only (`server.js:1641`) | The role reader merges both files: `vision` from `ai-config.json` (old flat shape migrated on read), `elevenlabs` from `tts-config.json`, `fal` new. Writers stay where they are so `/tts-key`, `/voices`, `/tts` are untouched. Never rewrite a key file the user did not just save. | T2.1 |
| 9 | There is **no migration hook** in self-update — `<DATA>` is excluded from the overlay and nothing ever touches it | `update.js:97-109` `fs.cpSync` with `rel === "data"` filtered out; no manifest, no deletes | New `<DATA>` files survive updates unconditionally (good), but the role migration must run **at boot, on read, forever tolerant of the old shape**. No "one-shot migration" scripts. | T2.1 |
| 10 | `content-worker.js` would ship broken and the build would not notice | `tools/build-payload.sh:20` is an explicit `cp` list; the guard at `:21-27` only greps literal `require("./x.js")`, and a worker is loaded by **path** (`clothing.js:56`) | Add `content.js` **and** `content-worker.js` to line 20 in the same commit that creates them, and extend the guard to also scan for `new Worker(path.join(__dirname, "…"))`. | T2.4 |
| 11 | The board gates reject *any* `.msgbar` child; a partner button was already built and reverted for this | `board-input.test.mjs:153` `assert.deepEqual(bar.kids, ["barDoor"])`; `board-pixel.test.mjs:131-132,210` `BAR_EXTRAS`; `board-wardrobe-note.test.mjs:53`; `board-splash-door.test.mjs:43`; era-board commits `7e9012f` → `d4a7556` | Dad's 9/4 amendment authorizes the strip. Amend the three assertions to allow exactly one `#partnerStrip` child that carries **no** `.dwell` and keeps the bar ≤ 9.1 % vh (`board-input.test.mjs:155`, `board-pixel.test.mjs:209`); add a positive assertion mirroring `board-wardrobe-note.test.mjs:54`. **Escape hatch:** if the strip cannot fit the 9 % slab, mount it as a *sibling* of `.msgbar` inside `#app` — that dodges all four gates but costs grid height. | T4.4 |
| 12 | Drag-to-reorder will fire a phantom tile activation | `dwell.js:302-312` schedules a 150 ms tap-rescue `el.click()` on `pointerup`; every tile carries `touch-action:none` from `dwell.js:63`; `board-render.js:703` binds `click` → `onTile` | Arrange mode must (a) set a flag `onTile` (`board-render.js:615`) checks first, and (b) cancel the rescue (`preventDefault` on `pointerdown` in arrange mode, or a `data-dwell-disabled` attribute on tiles — `dwell.js:154` honours it). | T4.5 |
| 13 | The gate's headless Chromium cannot decode AAC, so an `.m4a` song is untestable there | `era-family/tools/add-song.sh:37-39` — "mp3 (not m4a): plays everywhere including the gate's test Chromium (no AAC codec there)"; `era-family/test-data/music/*.wav` | The hub *serves* `.m4a` fine (`MUSIC_AV_EXTS` `server.js:440`, MIME `server.js:919`) and real kiosk Edge decodes AAC. Keep `.m4a` for the family (it avoids ffmpeg), but **no gate test may assert playback of an m4a** — assert the manifest entry and a 200 + `Accept-Ranges` instead. Fixtures stay `.wav`. | T4.2 |
| 14 | Pack install downloads the *entire* suite tarball with **no checksum**, unlike self-update | `server.js:124-141` `installPack` (no sha256); contrast `update.js:87-88` | A 17 MB `media-tools` pack costs a full-suite download on enable. Accept for now (same cost as every existing pack); file a follow-up to reuse `latest.json`'s sha256 in `installPack`. | T4.1 + Follow-up |
| 15 | Advertised installer sizes are computed from a **hand-duplicated** copy of the pack path list | `tools/build-dist.sh:39-42` repeats `packs.js:18-21` paths; no test pins the duplication | Update `build-dist.sh` in the same commit as `packs.js`; add an assertion to `tests/packs.test.mjs` that every `PACKS` path appears in `build-dist.sh`. | T4.1 |
| 16 | Free-tier quota shape is per-model-per-day, and the retry ladder already exists but is clothing-specific | `clothing-worker.js:33-47` (`PROVIDERS`, `spentModels`), `:453-476` `askModel`, `:514-534` `callModel`, `clothing.js:125-151` `holdDay`/`tick` | Lift the provider ladder into a shared module rather than re-deriving it; keep the "429 retires *that model*, not the day" rule and the `holdDay` pause. Status must say "waiting for tomorrow's quota" (spec §7 risk). | T2.6 |
| 17 | `drive.onSynced` is a **single-slot** callback already owned by clothing | `server.js:1800` `drive.onSynced = () => clothing.regenerate(true)...` | Replace with a fan-out that calls clothing *and* `content.scan()`; never overwrite the slot from `content.js` itself. | T2.4 |
| 18 | The quiet-period rule is calibrated to the local sync cadence only | local sync = 10 min (`drive.js:365`); API sync = 6 h (`drive.js:368`) | Local mode gives "two consecutive syncs ≥ 10 min" = ~20 min, as intended. Since Gap 1 restricts building to local mode, this is consistent — but the quiet period must be measured on **its own timer**, not on sync count, so a manual `POST /integrations/drive/sync` burst cannot claim a half-uploaded book. | T2.2 |
| 19 | `invariants.mjs` audits a fixed `STATES` list; a new page is not covered unless added | `tests/invariants.mjs:250-270` | The review page is mouse/touch-only (no `.dwell`), so leave it out of `STATES` and say so in its header comment. | T3.2 |
| 20 | **A real, billable ElevenLabs credential sits in the directory the gate uses as `ERA_DATA_DIR`** | `era-family/test-data/tts-config.json` (mode `0600`) is the gate's data dir (`tools/era-gate.sh:9,50`). Nothing spends it *today* only because every browser suite routes `**/tts*` → 503 **before** the request reaches the server (`board-pixel.test.mjs:172-173`, `board-input.test.mjs:26-27`) | **Near-blocker for "no test spends a key".** Every new suite that can reach a narration path MUST set `ERA_ELEVEN_URL` to a local stand-in in its spawn env (`tests/settings-ui.test.mjs:42-52` shows the exact shape) **and** route `**/tts*` in any Playwright context. Add an assertion to the narrate suite that the fake server saw the call — if it saw zero calls, the request went somewhere real. | T2.7, T3.3 |
| 21 | New test suites collide on ports; two tracked suites already share 8423 | `tests/settings-ui.test.mjs:24` and `tests/update-boot.test.mjs:19` both use 8423 (safe only because `era-gate.sh:65-68` runs serially); highest tracked port is 8424; 8425 is held by an ssh tunnel on this box; 8427 is reserved by `tools/vm-e2e.sh:22` | **New suites claim 8428, 8429, 8430… one per suite, recorded in the suite header.** Manual/ad-hoc hub instances use **8450+**. Never touch 8377–8416. | all new suites |
| 22 | `board-routes.test.mjs` resolves the **main** checkout and **live** data, not the worktree | `era-board/tests/board-routes.test.mjs:12-13` (`HUB = resolve(STUDIO,"../era-hub")`); `era-gate.sh:50` sets `ERA_DATA_DIR` on the server command only, not for suite processes | Do not extend that suite for this work; put new board-route coverage in a new suite that spawns its own hub with an explicit `ERA_DATA_DIR=mkdtemp`. | T4.4, T5.4 |

### A3. Info (context for implementers)

- **Module system:** the hub is 100 % CommonJS; there is no `package.json`
  anywhere, so `.js` = CJS and `.mjs` = ESM by extension. The bundled Windows
  runtime is Node **v22.22.2** (`.github/workflows/build-installer.yml:23`,
  `tools/build-payload.sh:59`), and `require()` of a non-TLA `.mjs` was
  **empirically verified to work** on it. But `tools/build-payload.sh:3`
  declares the floor as "Node 18+", where `require(esm)` does *not* exist.
  **Therefore: port bake-off adapters to CommonJS rather than requiring the
  `.mjs` files.** If a dynamic `import()` is ever unavoidable it must use
  `pathToFileURL()` (a bare `C:\…` path throws on Windows) and the file must be
  hand-added to `build-payload.sh:20` (the require-guard cannot see it).
- **Test seams already in the codebase:** `ERA_AI_URL` (`clothing-worker.js:485`,
  used by `tests/clothing.test.mjs:67`), `ERA_ELEVEN_URL` (`server.js:874`),
  `ERA_DRIVE_OAUTH` / `ERA_DRIVE_API` (`drive.js:17-18`), `ERA_UPDATE_URL`
  (`update.js:20`), `ERA_DATA_DIR` (`server.js:19`). A new `ERA_FAL_URL` seam
  follows the same shape. **This is how "no test spends a key" is achieved.**
- **Manifest contract (unchanged, spec §2 is correct):** top-level
  `{schemaVersion:1, id, slug, title, exportedAt, narration{provider,model,voice},
  cover, authored, pages[]}`; page =
  `{index, image, text, audio, words[{word,start,end}], video}`; media paths are
  **zero-padded three digits** (`pages/001.jpg`, `audio/001.mp3`,
  `video/001.mp4`) — verified against
  `era-family/data/books/ellie-and-the-garden-rescue/manifest.json`. The reader
  cache-busts on `m.exportedAt` (`public/reader/reader.js:187`), so **every
  re-publish must bump `exportedAt`** or media stays cached for 24 h.
- **Word grouping to port** (`/home/claude/ellie-this-week/src/ellie/book/audio.py:29-51`,
  `words_from_chars`): a word is a maximal run of non-whitespace characters;
  `start` = first char's start, `end` = last char's end; punctuation stays glued
  to the word; no smoothing, clamping, rounding or epsilon; `zip` truncates to
  the shortest of the three arrays. Whitespace flushes only a non-empty
  accumulator, and a trailing accumulator is flushed after the loop. Zero
  dependencies. Source fields:
  `alignment` (falling back to `normalized_alignment`) →
  `characters`, `character_start_times_seconds`, `character_end_times_seconds`;
  audio arrives as `audio_base64`. Endpoint
  `POST /v1/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128`,
  header `xi-api-key`. Python golden cases:
  `/home/claude/ellie-this-week/tests/book/test_audio.py`.
- **`<DATA>` on Windows** is `C:\Users\<user>\AppData\Local\New ERA\data\`
  (`server.js:19`, `tools/installer.nsi:19`, `tools/build-payload.sh:73`); the
  uninstaller deliberately spares it (`installer.nsi:177-178,206`).
- **PowerShell spawn law** (only if Gap 7's mitigation is ever reversed):
  `server.js:275-281` — copy `appShortcut`'s shape exactly, `-Command`, not
  detached, `windowsHide`, and **no double quotes anywhere in the script**.
  Separately, `tests/start-hub-bat.test.mjs:29-33` fails the build if the word
  `powershell` appears in a generated `.bat` (Defender law) — that applies to
  launchers, not to runtime spawns.
- **Movie launch contract:** the board POSTs to
  `http://127.0.0.1:49155/app/launch` with **no `Content-Type` header**
  (a CORS simple request — adding one triggers a preflight the native listener
  does not answer): `board-render.js:582-600`, ERAgaze side
  `era-gaze/device/ERAgaze.cs:685-697`. Known dead code: `nextEpisodeOf`
  (`board-render.js:568`) reads `EC.session`, which `era-core/lib/contract.js`
  does not define, so `body.next` is never sent — and
  `board-movies.test.mjs:187-190` pins the bug. Out of scope; recorded as a
  follow-up.
- **Splash today** (`era-board/app/board.js:102-176`) only coaches for
  `?recipe=today`; songs/movies get no coach, and there is no book hook at all.
- **Tests are `node:test` `.mjs` files in `tests/`; `gate/` is generated and
  gitignored** (`.gitignore:2`, `tools/era-gate.sh:27`). Never edit `gate/`.

---

## B. Guardrails that apply to every task

1. **TDD (`superpowers:test-driven-development`) is required** for every task
   except the ones marked *scaffolding/config*. Red first, then green.
2. **No test may spend a key.** Every provider call goes through an adapter
   whose base URL comes from an env seam (`ERA_AI_URL`, `ERA_ELEVEN_URL`,
   `ERA_FAL_URL`, `ERA_STREAMING_URL`). Tests stand up a local `http.createServer`
   and point the seam at it, exactly as `tests/clothing.test.mjs:66-121` does.
   A task whose test needs a real key is mis-scoped — STOP and escalate.
   **This is not theoretical:** the gate's `ERA_DATA_DIR`
   (`era-family/test-data`) holds a real ElevenLabs credential (Gap 20). A
   narration test that forgets `ERA_ELEVEN_URL` bills the family. Every such
   suite must (a) set the seam in its spawn env, (b) route `**/tts*` in any
   Playwright context, and (c) **assert the fake server recorded the expected
   call count** — zero recorded calls means the request went somewhere real.
3. **Never write a secret value anywhere** — not in `job.json`, not in
   `log.jsonl`, not in a status payload, not in a test fixture, not in a commit
   message. Keys are referenced by file/env-var name only.
4. **Repo commit scan.** `.github/workflows/scan.yml` runs
   `.github/era-scan.sh` with a denylist on every push and PR, plus
   `node --check` over every tracked `.js`/`.mjs`. Keep prose free of
   family-identifying and denylisted terms (this plan says "Linux box" and "QA
   host" deliberately).
5. **Verification sequence** for every task: `node --check` on changed files →
   the task's own targeted `node --test` → the full `bash tools/era-gate.sh` at
   the phase boundary.
6. **Adaptation protocol (STOP)** is stated per task. The generic rule: an
   unexpected finding stops execution; triage blocker / warning / discovery;
   document in the workpad Outbox; only proceed on a documented, in-scope
   adaptation.
7. **Code-review gate at every phase boundary:** invoke `rae-flow:reviewing`
   (or `superpowers:requesting-code-review`) against the design spec section the
   phase implements. Loop until APPROVED before starting the next phase.
8. **Phase retrospective** after every phase: decisions made, observations,
   adaptations, follow-ups, confidence + risks.
9. **Design for the FREE Google tier** (spec §4 "Design target", dad 9/4). The
   family never adds a card to Google: 500 requests a day per model, pauses
   that end when the quota does, books that may span days. Nothing may depend
   on the paid tier; every Google-touching change is tested against a fake
   429 with `RetryInfo`. The Google credit on the family's *test* key (9/4)
   exists so the E2E runs finish the same day — a testing convenience, never a
   product assumption. A live run on the paid tier is not evidence for the
   free-tier path.

### Standing verification commands

| What | Command (cwd = era-hub worktree unless noted) | Expected |
|---|---|---|
| Syntax (what CI actually runs) | `for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f"; done` | no output, exit 0 |
| One suite | `node --test tests/<name>.test.mjs` | `# fail 0` |
| Full gate (era-core + era-making-words + era-pencil + era-board + this worktree) | `bash tools/era-gate.sh` | final line `== era-gate: N passed, 0 failed ==`, exit 0 |
| Board gates only | `bash tools/era-gate.sh`, then read `gate/board-input.test.out` and `gate/board-pixel.test.out` | both `# fail 0` |
| Payload builds | `bash tools/build-payload.sh /tmp/era-payload-check` | exit 0; no "required by the hub but not in the payload" |

**Never use `bash tests/all.sh`.** It is a stale copy from era-making-words —
its loop names `.js` files that do not exist in `tests/`, and it points at 8377.

**`gate/` is generated and gitignored** (`.gitignore:2`; `tools/era-gate.sh:27`
does `rm -rf "$GATE"` every run). Author tests in `tests/` (hub) or
`era-board/tests/` (board) — **never** in `gate/`. The gate collects from this
worktree (`era-gate.sh:31-42`), so a new suite on this branch does run.

**CI runs no tests** — `.github/workflows/scan.yml` is a denylist scan plus
`node --check` only. The gate is local and is enforced by `tools/release.sh:21-22`,
which refuses to publish unless the last gate line contains `" 0 failed"`.
There is no `gh act` step to validate.

**Port hygiene (memory: tunnel ports are never test ports).** Never bind or
assert against `8377`–`8416` — an ssh tunnel to a family device answers HTTP as
that device's live hub and silently poisons the gate (and three tracked suites —
`icons`, `invariants`, `predict` — plus every era-board suite target 8377 until
the gate's `sed` re-points them). `tools/era-gate.sh` keeps its default `8378`.
**New suites claim 8428, 8429, 8430… one per suite, stated in the suite header**
(8423 is already double-booked by `settings-ui` and `update-boot`; 8425 is held
by an ssh tunnel on this box; 8427 is reserved by `tools/vm-e2e.sh:22`).
Ad-hoc/manual hub instances use **8450+**. Check first:
`ss -ltnp | grep -E ':(83[7-9][0-9]|84[0-4][0-9])'`.

**Port allocation for the new suites in this plan** (claim exactly one, and put
it in the suite header comment):

| Suite | Port |
|---|---|
| `tests/ai-config.test.mjs` | in-process, none |
| `tests/content-claim.test.mjs`, `tests/content-store.test.mjs`, `tests/words.test.mjs`, `tests/image-util.test.mjs` | in-process, none |
| `tests/content-worker.test.mjs` | 8428 |
| `tests/content-transcribe.test.mjs` | 8429 (hub) + 8430 (fake AI) |
| `tests/content-narrate.test.mjs` | 8431 (hub) + 8432 (fake ElevenLabs) |
| `tests/content-publish.test.mjs` | 8433 |
| `tests/content-routes.test.mjs` | 8434 |
| `tests/book-review-ui.test.mjs` | 8435 |
| `tests/music-add.test.mjs` | 8436 |
| `tests/movies-add.test.mjs` | 8437 |
| `tests/movies-lookup.test.mjs` | 8438 (fake provider) |
| `tests/fal-key.test.mjs`, `tests/content-animate.test.mjs` | 8439 (hub) + 8441 (fake fal) |
| `tests/drive-localfolder.test.mjs` (Phase E) | 8442 |
| `tests/content-allowance.test.mjs` (Phase 6b) | 8443 (hub) + 8444 (fake ElevenLabs) + 8445 (fake AI) |

---

## C. Task skeleton

Phases follow the spec's migration sequence (§7). Every task is sized for one
fresh subagent context: one module or one endpoint plus its test.

---

### Phase 1: Mirror fixes and slugify
**Posture hint:** implementing.
**Rationale:** four numbered, mechanical changes to code that already has a
test suite (`tests/drive-mirror.test.mjs`, `tests/books.test.mjs`); tests are
writable before the change; no interpretation needed. Ambiguity 1/5.
**Spec section:** §2 "Mirror changes", §2 "Build in place".

**T1.1 — `copyTreeLocal` / `mirrorDir` copy manifests last**
- **Acceptance:** in every directory, `manifest.json` and `catalog.json` are
  copied *after* all other entries (files and subdirectories), in both local
  mode (`drive.js:294-306`) and API mode (`drive.js:156-176`). Existing copy
  semantics (size-equal skip, error collection) unchanged.
- **Files:** `drive.js`; `tests/drive-mirror.test.mjs`.
- **TDD:** required. Red test: a source dir with `manifest.json` + `a.jpg`
  where the fs is instrumented (wrap `fs.copyFileSync` / record order) asserts
  the manifest lands last; also assert a *nested* dir's manifest lands after
  that dir's media.
- **Verification:** `node --test tests/drive-mirror.test.mjs` → `# fail 0`.
- **Adaptation:** if `readdirSync` order already happens to pass on this fs,
  the test is not proving anything — assert the recorded order explicitly, do
  not rely on incidental ordering. If instrumenting `fs` proves brittle, STOP
  and instead export a pure `orderEntries(entries)` helper and test that.
- **Gate:** rolls into the phase gate.

**T1.2 — mirror deletes for books/music/movies; add `movies` to the mirror set**
- **Acceptance:** `MIRROR_SUBDIRS` (`drive.js:22`) becomes
  `["books","music","movies","content","clothing"]`; `MIRROR_DELETES`
  (`drive.js:133`) becomes `["clothing","books","music","movies"]`;
  `createContentFolder()` creates a `movies/` subfolder; `contentReady()`
  reports it. A file removed from the Drive folder disappears from `<DATA>` for
  all four libraries; dotfiles are still never pruned (`drive.js:145`); an
  offline/absent source still never prunes (`drive.js:312`).
- **Files:** `drive.js`; `tests/drive-mirror.test.mjs`.
- **TDD:** required. Tests: (a) a book folder deleted in Drive is deleted in
  `<DATA>`; (b) a song file deleted is deleted; (c) `movies/catalog.json`
  mirrors; (d) an *absent* source dir prunes nothing; (e) `.build/` survives
  pruning because dotfiles are skipped.
- **Verification:** `node --test tests/drive-mirror.test.mjs`; then
  `node --test tests/books.test.mjs tests/music.test.mjs tests/movies.test.mjs`
  → all `# fail 0`.
- **Adaptation:** if adding `movies` to `MIRROR_SUBDIRS` makes an existing
  Settings-checklist test fail, that is expected — update the assertion and note
  it. If pruning `books` would delete a package a family built *before* the
  folder existed in Drive, STOP: that is data loss; escalate before shipping.
- **Gate:** phase gate.

**T1.3 — serve-side deny of `sources/` and `.build/`**
- **Acceptance:** `GET /books/<slug>/sources/IMG_0001.jpg` → 404;
  `GET /books/<slug>/.build/job.json` → 404;
  `GET /books/<slug>/.build/text.json` → 404; normal package files unaffected;
  jail-escape behaviour (403) unchanged (`server.js:448-450`).
- **Files:** `server.js` (`serveMediaJail` / `serveBook`, ~`:434-498`);
  `tests/books.test.mjs`.
- **TDD:** required. Add cases to the existing books route suite, including a
  raw-path request (the suite already has `rawGet`, `tests/books.test.mjs:17-30`).
- **Verification:** `node --test tests/books.test.mjs` → `# fail 0`.
- **Adaptation:** the deny must apply to the **books** jail only — music and
  movies have no such folders and must not gain a shared restriction. If the
  cleanest implementation is a shared `denySegments` parameter, that is fine;
  do not hard-code names inside `serveMediaJail`'s generic body.
- **Gate:** phase gate.

**T1.4 — `booksIndex` slugify + slug→directory resolution**
- **Acceptance:** a folder `Tabby McTat` is indexed as slug `tabby-mctat` and
  `GET /books/tabby-mctat/manifest.json` serves
  `<DATA>/books/Tabby McTat/manifest.json`. Slugify is one exported function
  used by both `booksIndex()` and the future worker (parity is testable).
  Collisions (two folders slugifying the same) are resolved deterministically
  and logged. A folder whose name is already a slug behaves exactly as today.
- **Files:** `server.js` (`booksIndex` `:411`, `serveBook` `:445`); a small
  shared `slugify` (new module or an export from `content.js` if it exists yet —
  in this phase put it in `server.js` and re-export later);
  `tests/books.test.mjs`.
- **TDD:** required. Cases: spaces, punctuation, accents, leading/trailing
  dashes, case, a collision pair, an already-slug folder, and a
  **slugify-parity** test asserting index slug === the slug the resolver accepts.
- **Verification:** `node --test tests/books.test.mjs` → `# fail 0`.
- **Adaptation:** the reader stores reading position per slug, so existing
  positions reset once. That is acceptable (document it), **but** if any current
  package's directory name would slugify to a *different* existing package's
  slug, STOP — silently merging two books is data loss.
- **Gate:** **`rae-flow:reviewing` against spec §2.** Scope: `drive.js` +
  books routing. Pass criteria: mirror ordering and deletes proven by test; no
  `.build`/`sources` reachable over HTTP; slug parity proven; full gate green.
- **Phase retrospective:** decisions (slug collision rule, where `slugify`
  lives), observations (did instrumenting copy order work?), adaptations,
  follow-ups, confidence.

**Phase 1 exit verification:** `bash tools/era-gate.sh` →
`== era-gate: N passed, 0 failed ==`.

---

### Phase 2: Content rails, book builder (text + narration), key roles, Settings card, splash
**Posture hint:** implementing, with one collaborating escape hatch (T2.6).
**Rationale:** `clothing.js` / `clothing-worker.js` are a complete reference
implementation of every rail (worker spawn, single-flight, status shape, key
read, provider ladder, quota pause) — spec §3 is explicitly "copy its shape".
Acceptance criteria are numbered and testable. Ambiguity 2/5, except the
transcription policy, which is decided by data (T2.6a).
**Spec sections:** §3, §4 steps 1–4, §7 keys.

**T2.1 — key roles: a read-only `aiRoles()` with forever-tolerant migration**
- **Acceptance:** one exported function returns
  `{vision:{provider,apiKey}|null, elevenlabs:{apiKey,voiceId}|null, fal:{apiKey}|null}`.
  It reads the **new** role-keyed `<DATA>/ai-config.json` if present; falls back
  to the legacy flat `{provider, apiKey}` (`server.js:1641-1642`) for `vision`;
  reads `elevenlabs` from `<DATA>/tts-config.json` (`server.js:864,890`);
  returns `null` for a role with no usable key. It **never writes** and **never
  logs a key**. `clothing.js:22-28` and `clothing-worker.js:70-75` are switched
  to it with identical behaviour.
- **Files:** new `ai-config.js`; `clothing.js`; `clothing-worker.js`; new
  `tests/ai-config.test.mjs`.
- **TDD:** required. Cases: legacy-only file; role file; both; missing file;
  empty `apiKey`; unknown provider falls back to `google`
  (`clothing.js:26`); tts key present but `keyOk === false`; assert that no
  function in the module calls `fs.writeFileSync`.
- **Verification:** `node --test tests/ai-config.test.mjs tests/clothing.test.mjs`
  → `# fail 0`.
- **Adaptation:** if switching `clothing-worker.js` changes clothing behaviour
  in any test, STOP — the migration must be behaviour-preserving. Do **not**
  change `POST /ai-key` or `POST /tts-key` in this task.
- **Guardrails:** never write a secret; never echo a key back over HTTP.

**T2.2 — `content.js` shell: scan, inbox test, quiet period, claim/stale**
- **Acceptance:** `content.scan()` walks `<folderPath>/books/*` (local Drive
  mode only — returns `{skipped:"needs-local-drive"}` otherwise, per Gap 1);
  a folder is an **inbox** when it holds images and no `.build/job.json`; a
  folder is **claimable** only when its listing (names + sizes) is unchanged
  across two observations ≥ 10 min apart, measured on `content.js`'s own timer
  (Gap 18); claiming writes `job.json` `{state,claimedBy,heartbeat,startedAt,
  steps{},errors[]}` atomically; a claim whose `heartbeat` is older than 30 min
  may be taken over; one job at a time (single-flight, queued follow-up), copied
  from `clothing.js:47-85`.
- **Files:** new `content.js`; new `tests/content-claim.test.mjs`.
- **TDD:** required. Cases: images + no job.json = inbox; job.json present = not
  inbox; listing changed between observations = not claimable; unchanged and
  ≥ 10 min = claimable; fresh heartbeat = not takeable; 31-min heartbeat =
  takeable; two `scan()` calls do not double-claim; non-local drive mode skips.
  Use a fake clock (inject `now()`), never real sleeps.
- **Verification:** `node --test tests/content-claim.test.mjs` → `# fail 0`;
  the whole suite must finish in seconds (no real 10-minute waits).
- **Adaptation:** if a fake clock cannot be injected cleanly, STOP and refactor
  the timing into a pure predicate `isQuiet(prevListing, nowListing, elapsedMs)`
  before writing more code.

**T2.3 — `text.json` / `job.json` schemas + `log.jsonl` writer + atomic write helper**
- **Acceptance:** one module owns the three artefacts:
  `text.json = {pages:[{index, source, text, flags:[{word,reason}], cover:bool}]}`,
  round-trips losslessly; `job.json` state machine
  `inbox → transcribing → reviewing → narrating → published → animating → done`
  with `failed` reachable from any state and errors retained; illegal
  transitions throw; `log.jsonl` appends one JSON object per line with
  `{t, step, msg}` and **never** a key or a URL containing one; `writeAtomic()`
  writes `<name>.tmp` then `fs.renameSync` (used for `job.json`, `text.json`,
  `manifest.json`, `catalog.json`, `music/manifest.json`).
- **Files:** new `content-store.js` (or a section of `content.js`); new
  `tests/content-store.test.mjs`.
- **TDD:** required. Cases: round trip with flags and unicode; every legal
  transition; two illegal transitions; `failed` from mid-state keeps prior
  errors; atomic write leaves no `.tmp` behind on success and does not clobber
  the target on a write failure; a log line containing a key-looking string is
  rejected/redacted.
- **Verification:** `node --test tests/content-store.test.mjs` → `# fail 0`.

**T2.4 — `content-worker.js` spawn wiring, `onSynced` fan-out, payload shipping**
- **Acceptance:** `content.js` spawns `content-worker.js` in a
  `worker_threads` Worker exactly as `clothing.js:56-84` does (progress via
  `postMessage`, one worker at a time, `error`/`exit` handled, promise
  resolution for mid-run callers); `server.js:1800`'s single-slot
  `drive.onSynced` becomes a fan-out that calls **both** `clothing.regenerate`
  and `content.scan()`; `content.start(DATA)` is called from
  `server.js` "listening" beside `clothing.start(DATA)`;
  `tools/build-payload.sh:20` lists `content.js` and `content-worker.js`, and
  the guard at `:21-27` also detects `new Worker(path.join(__dirname, "…"))`.
- **Files:** `content.js`; new `content-worker.js` (skeleton: receives
  `workerData {dataDir, folderPath, slug, step}`, runs a step table, posts
  progress); `server.js`; `tools/build-payload.sh`; `tests/content-worker.test.mjs`;
  `tests/update.test.mjs` / `tests/reconcile.test.mjs` / `tests/update-boot.test.mjs`
  hub-module lists.
- **TDD:** required for the shell and the payload guard; *scaffolding* for the
  empty step table (note it).
- **Verification:**
  1. `node --test tests/content-worker.test.mjs` → `# fail 0`
  2. `bash tools/build-payload.sh /tmp/era-payload-check` → exit 0
  3. deliberately remove `content-worker.js` from line 20, re-run (2) → the
     guard must **fail**; restore it. (Prove the guard, don't assume it.)
- **Adaptation:** if the payload guard cannot be extended without false
  positives, STOP and instead add an explicit list assertion to
  `tests/packs.test.mjs`-style unit test that every `new Worker(...)` target is
  in the `cp` line. Do not ship without one of the two.

**T2.5 — ingest step: order, EXIF orientation, downscale (pure JS)**
- **Acceptance:** originals move to `sources/`; page order comes from EXIF
  `DateTimeOriginal`, falling back to filename natural sort; each page is
  written as `pages/NNN.jpg` (zero-padded three digits, long edge ≤ 2048, EXIF
  orientation applied) using the **existing** vendored JPEG path
  (`clothing-worker.js:129-206`, `image-orient.js`) extracted into a shared
  module — **no process spawn** (Gap 7); if decoding or encoding throws, the
  original is copied to `pages/NNN.jpg` unchanged and `log.jsonl` records why;
  re-running the step with unchanged inputs is a no-op.
- **Files:** new `image-util.js` (extracted `ensureCodecs`/`scaleRgba`/
  `writeJpg`/`readJpg`); `clothing-worker.js` (use the extraction — behaviour
  must not change); `content-worker.js`; `tests/image-util.test.mjs`;
  `tests/content-ingest.test.mjs`.
- **TDD:** required. Cases: a 1×1 synthetic JPEG survives; a wide image is
  scaled to long-edge 2048; orientation 6 is rotated (reuse
  `tests/image-orient.test.mjs` fixtures); a corrupt JPEG falls back to a copy
  and logs; ordering by EXIF beats filename; missing EXIF falls back to
  filename; the step is idempotent.
- **Verification:** `node --test tests/image-util.test.mjs tests/content-ingest.test.mjs tests/clothing.test.mjs tests/image-orient.test.mjs`
  → all `# fail 0` (the clothing suite proves the extraction was behaviour-preserving).
- **Adaptation:** if pure-JS decode of a real 12 MP photo is unacceptably slow
  on the hardware floor, that is a *discovery*, not a blocker — the fallback
  ("serve the originals; nothing downstream depends on `pages/`", spec §7
  risks) already exists. Record a timing measurement in the workpad; only then
  consider the spec's spawn. Do **not** add a spawn on speculation.

**T2.6 — transcribe step behind a provider adapter interface**
- **Acceptance:** one interface `transcribePage({imagePath, policy, cfg}) →
  {text, uncertain[]}`; adapters for `google` / `anthropic` / `openai` reuse the
  shape and model ladder of `clothing-worker.js:478-541` (base URL from
  `ERA_AI_URL`; 429 retires *that model*, not the day; `permanent:` on 401/403);
  a daily-quota exhaustion sets a `pausedUntil` day on the job and leaves state
  `transcribing` with `heartbeat` ticking — **never** `failed` (spec §4 step 2);
  the transcription policy prompt is a named constant (verbatim printed text,
  narrative reading order, `...` for ellipses, quotes as printed, drop
  illustration junk and page numbers, cover = title/author/illustrator);
  the model's `uncertain[]` becomes `flags[]` in `text.json`;
  **which provider is the default and whether an agreement pass runs are
  config values**, not code (`<DATA>/content-config.json`, defaults in one
  place).
- **Files:** new `content-providers.js`; `content-worker.js`;
  `tests/content-transcribe.test.mjs`.
- **TDD:** required. Fake provider server per `tests/clothing.test.mjs:66-121`.
  Cases: happy path text+uncertain → `text.json`; 429 on model A falls through
  to model B; all models 429 → job paused, not failed, status says "waiting for
  tomorrow's quota"; 401 → permanent failure with a human message; malformed
  JSON reply is tolerated (the `replace(/^[^{]*/…)` salvage at
  `clothing-worker.js:509`); agreement pass **on** → two cheap calls, a
  disagreement escalates to the strongest configured model and adds a flag;
  agreement pass **off** → exactly one call per page.
- **Verification:** `node --test tests/content-transcribe.test.mjs` → `# fail 0`;
  assert the fake server saw the expected number of calls (proves no key spend
  and no accidental extra passes).
- **Posture:** implementing, **escape hatch → collaborating** if the bake-off's
  chosen provider needs a request shape none of the three existing adapters
  cover (e.g. a batch or files API).

**T2.6a — adopt the OCR bake-off decision** *(consumes an in-flight input; do not wait on it)*
- **Acceptance:** `<DATA>/content-config.json` defaults are set from
  `era-family/data/ocr-bakeoff/results/2026-09-04/DECISION.md` —
  `{transcribe:{provider, model, agreementPass:bool, escalateTo}}` — and a short
  note in the module header cites the decision date and the re-run instructions
  (`tools/ocr-bakeoff/README.md`, re-runnable in six months). **As of
  2026-09-04 the results directory did not exist yet** (the bake-off harness is
  still being written under `tools/ocr-bakeoff/`). If the decision file is still
  absent when this task runs, ship the spec's stated policy as the default
  (cheapest model within 0.1 pp of best on loose WER; agreement pass **off**)
  and leave the config value and this task's checkbox open.
- **Files:** `content-providers.js` (defaults only); `tests/content-transcribe.test.mjs`
  (a test that the defaults parse and are honoured).
- **TDD:** *config* — no new behaviour, but a test must assert the default
  object shape and that a config file overrides it.
- **Verification:** `node --test tests/content-transcribe.test.mjs` → `# fail 0`.
- **Adaptation:** the decision file is **private** (`era-family/data/...`) —
  read the chosen provider/model names from it, copy **no** measurements,
  **no** page content, and **no** keys into this repo. If the decision names a
  provider with no adapter, STOP and escalate (that is a T2.6 scope change).

**T2.7 — narrate step: ElevenLabs with-timestamps + word grouping port**
- **Acceptance:** `narratePage(text, cfg)` calls
  `POST {ELEVEN_URL}/v1/text-to-speech/{voiceId}/with-timestamps?output_format=mp3_44100_128`
  with header `xi-api-key` and body `{text, model_id}`; writes
  `audio/NNN.mp3` from `audio_base64`; groups `alignment` (falling back to
  `normalized_alignment`) into `words[{word,start,end}]` by a **faithful port**
  of `words_from_chars` (see §A3 for the exact algorithm); voice comes from the
  ElevenLabs card (`loadTtsCfg().voiceId`, `server.js:890-896`); base URL from
  the existing `ERA_ELEVEN_URL` seam (`server.js:874`); a missing ElevenLabs key
  is **not** an error — the book publishes with text and no audio (spec §4
  table, free-Google row).
- **Files:** new `words.js` (pure, dependency-free); `content-worker.js`;
  `tests/words.test.mjs`; `tests/content-narrate.test.mjs`.
- **TDD:** required. `tests/words.test.mjs` ports the two Python golden cases
  (`"A busy bee."` at 0.1 s/char → `["A","busy","bee."]` with
  `words[1].start === 0.2` and `words[2].end === ends[-1]`; and
  `[" ","h","i"," "," ","y","o"]` → `["hi","yo"]` with starts `0.1`/`0.5`) plus:
  trailing text with no final whitespace is flushed; arrays of unequal length
  truncate to the shortest; punctuation stays glued; empty input → `[]`.
  Add a **round-trip fixture test** against a recorded (synthetic) alignment
  payload asserting the output matches the on-disk manifest shape.
- **Verification:** `node --test tests/words.test.mjs tests/content-narrate.test.mjs`
  → `# fail 0`; the fake ElevenLabs server must record **exactly one call per
  page** — assert the count.
- **Guardrails (money):** `tests/content-narrate.test.mjs` MUST spawn the hub
  with `ERA_ELEVEN_URL` pointed at its own stand-in and `ERA_DATA_DIR` at a
  `mkdtemp` dir (`tests/settings-ui.test.mjs:42-52` is the template). Gap 20:
  the gate's default data dir holds a real, billable ElevenLabs credential. A
  recorded call count of **zero** is a test failure, not a pass — it means the
  request escaped the seam.
- **Adaptation:** if a real ElevenLabs response ever contains multi-codepoint
  entries in `characters`, treat each entry as an opaque string and concatenate
  (do not split into code points) — the Python source does the same.

**T2.8 — publish step: `manifest.json` last, atomic, flagged pages included**
- **Acceptance:** once every page has text (audio optional), write
  `manifest.json` via `writeAtomic` with
  `{schemaVersion:1, id, slug, title, exportedAt:<new ISO>, narration{provider,
  model, voice}, cover, authored:false, pages:[{index, image, text, audio,
  words, video}]}`, paths zero-padded three digits; **flagged pages publish**
  (ruling 9/4) and their flags remain in `text.json` and in `/content/status`;
  every re-publish bumps `exportedAt` (reader cache-bust,
  `public/reader/reader.js:187`); job state moves to `published`.
- **Files:** `content-worker.js`; `tests/content-publish.test.mjs`.
- **TDD:** required. Cases: a 3-page book publishes and `booksIndex()` lists it
  with the right slug and page count; a flagged page still appears; no
  `manifest.tmp` remains; a second publish bumps `exportedAt`; a book with text
  but no audio publishes (pages have no `audio` key) and the reader's
  "textless/silent page" path is satisfied; `manifest.json` is written *after*
  all media exist on disk.
- **Verification:** `node --test tests/content-publish.test.mjs tests/books.test.mjs`
  → `# fail 0`.

**T2.9 — `GET /content/status` and `POST /content/run`**
- **Acceptance:** `GET /content/status` returns
  `{jobs:[{kind, slug, state, step, progress, cost, flags, pausedUntil}]}`
  with `Cache-Control: no-store`, mirroring `/clothing/status`
  (`server.js:1661-1665`); it **never** includes a key, a folder path outside
  the content folder, or PII beyond the book title.
  `POST /content/run {kind, slug, step}` validates its body (≤ 4 KB cap +
  `req.destroy()`, the `server.js:1307-1308` pattern), replies `202
  {"started":true}` like `/clothing/regenerate` (`server.js:1654-1660`), and
  runs the named step behind the response. Unknown `kind`/`slug`/`step` → 400.
- **Files:** `server.js`; `content.js`; `tests/content-routes.test.mjs`.
- **TDD:** required. Cases: status shape with zero jobs; with one running job;
  202 on a valid run; 400 on each invalid field; oversized body is destroyed;
  status contains no `apiKey`-like field (assert by scanning the serialized
  JSON); `no-store` header present.
- **Verification:** `node --test tests/content-routes.test.mjs` → `# fail 0`.
- **Adaptation:** `/content` is a free namespace today (no route matches it in
  `server.js`) — if that changes, STOP rather than shadowing an existing route.

**T2.10 — Settings "Your books" content card**
- **Acceptance:** a new `<div class="card" id="content">` in
  `public/settings/index.html` matching the existing card anatomy (h2, `p.hint`,
  `.row` of buttons, `.status` div — see `#voice` `:101-119` and `#ai`
  `:161-181`): shows per-book state from `/content/status`, a "Review this book"
  link to the review page (Phase 3), a plain-language line for
  `needs-local-drive` (Gap 1) and for "waiting for tomorrow's quota", and the
  recommended-tier explanation from spec §4. **No new key card here** — fal is
  Phase 6. Reuses `pasteInto`/`toast` (`:591-598`).
- **Files:** `public/settings/index.html`; `tests/settings-ui.test.mjs`.
- **TDD:** required (UI assertions, not screenshots). Cases: the card renders
  with zero jobs; renders a running job's progress; renders the
  `needs-local-drive` guidance; the card's id is `#content` (Settings deep-links
  by fragment, per VM QA practice).
- **Verification:** `node --test tests/settings-ui.test.mjs` → `# fail 0`.
- **Browser verification:** required at the phase gate — **video/gif, not a
  screenshot** — of the card moving through at least two states.

**T2.11 — board splash + footer note for book jobs** *(era-board repo)*
- **Acceptance:** `showSplash()`'s coach (`era-board/app/board.js:121-176`) and
  `startWardrobeWatch()` (`:215-249`) are generalized so a **book** job in
  progress produces a note, without changing any clothing behaviour; the note is
  touch-only, carries no `.dwell`, and is a sibling of the existing
  `#wardrobeNote` pattern (`era-board/app/index.html:26`,
  `board.css:125-135`); when a job finishes **with flags**, the note links to
  the review page.
- **Files:** `era-board/app/board.js`, `era-board/app/board.css`;
  `era-board/tests/board-clothing-coach.test.mjs` (extend) or a new
  `board-content-note.test.mjs`.
- **TDD:** required. Cases: a content job in progress shows the note; the note
  has no `.dwell` class (clone `board-wardrobe-note.test.mjs:54`); the bar still
  has exactly one child (`board-wardrobe-note.test.mjs:53` must still pass —
  this task adds **no** header element).
- **Verification:** `bash tools/era-gate.sh` (collects era-board/tests) →
  `0 failed`.
- **Adaptation:** this task must **not** touch `.msgbar`. If the note cannot be
  placed without a header change, defer that to T4.4 where the gates are amended.

- **Gate (Phase 2):** **`rae-flow:reviewing` against spec §3, §4 steps 1–4, §7
  keys.** Scope: `content.js`, `content-worker.js`, `content-providers.js`,
  `words.js`, `ai-config.js`, `image-util.js`, the two new routes, the Settings
  card, the board note. Pass criteria: a book builds end-to-end against **fake**
  providers in a test; no key appears in any artefact; `bash tools/era-gate.sh`
  green; payload guard proven.
- **Phase 2 retrospective:** decisions (adapter interface shape, where the
  quota pause lives), observations (how close the clothing rails actually were),
  adaptations, follow-ups, confidence.

---

### Phase 3: Review-and-reorder page
**Posture hint:** implementing.
**Rationale:** spec §5 enumerates every control and every write target; the page
is mouse/touch-only so it inherits no gaze contract; DOM assertions are writable
first. Ambiguity 2/5 (only the URL choice, settled by Gap 4).
**Spec section:** §5.

**T3.1 — route and page shell at `/book-review/`**
- **Acceptance:** `GET /book-review/` serves
  `public/book-review/index.html` through the existing static handler
  (`server.js:1761-1782`), `/book-review` 301s to it with the query preserved
  (`server.js:1765-1771`), and `?slug=…` is read client-side. The page is **not**
  added to `tests/invariants.mjs`'s `STATES` (Gap 19) and its header comment says
  why. `tools/build-payload.sh` copies `public/book-review` (a **core**
  directory, so **no** `/x` exclusion in `installer.nsi` — `tests/packs.test.mjs:30-31`
  asserts every `/x` belongs to a pack).
- **Files:** new `public/book-review/index.html`; `tools/build-payload.sh`;
  `tests/routes.test.mjs`.
- **TDD:** required (route tests); *scaffolding* for the empty page body.
- **Verification:** `node --test tests/routes.test.mjs` → `# fail 0`;
  `bash tools/build-payload.sh /tmp/era-payload-check && ls /tmp/era-payload-check/public/book-review/index.html`
  → the file exists.
- **Adaptation:** if the spec's `/books/review/` URL is required by a
  stakeholder, add an explicit branch **above** `server.js:1453` and a matching
  301 — do not reorder the whole route table.

**T3.2 — page strip: order, drag-to-reorder, cover marking**
- **Acceptance:** pages render in `text.json` order with image + text; drag
  reorders and writes the new order back to `text.json` via `POST /content/run`
  (or a dedicated `POST /content/text`); tap marks the cover (`cover:true` on
  exactly one page); a reorder followed by a reload shows the new order.
  Pointer-only: no `.dwell` classes anywhere on the page.
- **Files:** `public/book-review/index.html`; `server.js` (write endpoint);
  `tests/book-review-ui.test.mjs`.
- **TDD:** required. Cases: renders N pages in order; a simulated drag writes
  the expected `text.json`; exactly one cover; a malformed write is rejected 400;
  `document.querySelectorAll(".dwell").length === 0`.
- **Verification:** `node --test tests/book-review-ui.test.mjs` → `# fail 0`.
- **Browser verification:** required — **video/gif** of a drag-reorder.

**T3.3 — per-page controls: inline edit, re-narrate, clear flag**
- **Acceptance:** flagged words are highlighted; an inline field edits page
  text into `text.json`; "Re-narrate this page" calls
  `POST /content/run {kind:"book", slug, step:"narrate", page:N}` and the page's
  audio + `words` are replaced and the book re-published with a bumped
  `exportedAt`; "Clear flag" removes the flag without touching text.
- **Files:** `public/book-review/index.html`; `content.js`/`content-worker.js`
  (single-page step); `tests/book-review-ui.test.mjs`,
  `tests/content-narrate.test.mjs`.
- **TDD:** required. Cases: edit persists; re-narrate replaces only page N's
  audio/words; re-narrate bumps `exportedAt`; clear-flag leaves text intact;
  re-narrate with no ElevenLabs key returns a human message, not a 500.
- **Verification:** `node --test tests/book-review-ui.test.mjs tests/content-narrate.test.mjs`
  → `# fail 0`.
- **Guardrails (money):** re-narrate is a second path to ElevenLabs — the suite
  must set `ERA_ELEVEN_URL` and assert the stand-in's call count (Gap 20).

**T3.4 — book-level actions: rebuild text, remove book, animate placeholder**
- **Acceptance:** "Rebuild text" re-runs step 2 with a "keep my edits" checkbox
  (default **on**); "Remove book" deletes the folder in the Drive content folder
  and relies on the Phase 1 mirror deletes to clear `<DATA>` (confirm dialog
  required); "Animate this book (≈ $x)" is present but **disabled** with a
  "needs a fal key" hint until Phase 6.
- **Files:** `public/book-review/index.html`; `server.js`; `content.js`;
  `tests/book-review-ui.test.mjs`.
- **TDD:** required. Cases: rebuild with keep-edits preserves edited text;
  rebuild without it overwrites; remove requires confirmation and deletes the
  source folder; remove is refused for a slug outside the content folder (path
  jail); the animate button is disabled with no fal key.
- **Verification:** `node --test tests/book-review-ui.test.mjs` → `# fail 0`.
- **Adaptation:** "Remove book" deletes family data. If the deletion cannot be
  jailed to `<folderPath>/books/<dir>` with certainty, STOP — ship the page
  without the button rather than risk a wider delete.

- **Gate (Phase 3):** **`rae-flow:reviewing` against spec §5.** Pass criteria:
  every §5 control exists and writes only `text.json`/`job.json`; no `.dwell` on
  the page; delete is jailed; full gate green; drag recording attached.
- **Phase 3 retrospective.**

---

### Phase 4: Music strip, `media-tools` pack, `POST /music/add`
**Posture hint:** implementing. T4.4's placement is decided (inside `.msgbar`,
pointer-only; gates amended under dad's 9/4 amendment; sibling placement is the
escape hatch, not a question).
**Spec sections:** §6 Music, §7 packs.

**T4.1 — declare and ship the `media-tools` pack**
- **Acceptance:** `packs.js:17-21` gains
  `"media-tools": ["vendor/yt-dlp"]` (first entry = the presence marker);
  `tools/installer.nsi:56` gains `/x yt-dlp` and a dedicated `Section` that lays
  it down exactly once (`tests/packs.test.mjs:26-27` asserts `laid.length === 1`);
  `MUI_DESCRIPTION_TEXT` hover text names the MB;
  `tools/build-dist.sh:39-42` gains an `SZ_MEDIA` term subtracted from
  `SZ_CORE`; `tools/build-payload.sh` copies the pack payload;
  `packs.packInstalled(root,"media-tools")` answers correctly.
- **Files:** `packs.js`, `tools/installer.nsi`, `tools/build-dist.sh`,
  `tools/build-payload.sh`, `tests/packs.test.mjs`, `tests/update.test.mjs`
  (`PACK_FILES`).
- **TDD:** required. New assertion: **every path in `PACKS` appears in
  `build-dist.sh`'s size computation** (Gap 15) — this closes the hand-duplication
  hole. Plus the existing `/x`-belongs-to-a-pack and laid-once assertions.
- **Verification:** `node --test tests/packs.test.mjs tests/update.test.mjs` →
  `# fail 0`; `bash tools/build-payload.sh /tmp/era-payload-check` → exit 0.
- **Adaptation:** yt-dlp is a **binary blob**. It is a new file for Defender to
  flag (spec §7 risk) — it must be re-verified on the VM in Phase 7, and the
  release notes must say a pack binary was added. If the binary cannot be
  vendored under an acceptable licence/provenance, STOP and escalate.
- **Guardrails:** *config/scaffolding* for the NSIS sections (no TDD on
  installer text), TDD required for `packs.js` and the size assertion.

**T4.2 — `POST /music/add` (resolve, download, append)**
- **Acceptance:** accepts `{url}` or `{query}`; without the pack it replies a
  structured "pack missing" answer the sheet can render (never a 500); with the
  pack it spawns `yt-dlp --js-runtimes node` (node is on the box) with
  `-f "ba[ext=m4a]/ba"` and **no `-x` / no `--convert-thumbnails`** so **ffmpeg
  is never required** (spec §6), writes `<slug>.m4a` and `<slug>.webp` into the
  Drive content folder's `music/`, and appends to `music/manifest.json` with the
  next free `rank` via `writeAtomic`. Slug is `[a-z0-9-]` only. Replies `202`
  and does the work behind it (`/clothing/regenerate` pattern). Retires
  `era-family/tools/add-song.sh` as the only writer.
- **Files:** new `music-add.js`; `server.js`; `tests/music-add.test.mjs`.
- **TDD:** required, with `yt-dlp` **mocked** (inject the binary path /
  spawn function; never invoke the real one, never hit YouTube in a test).
  Cases: pack-missing answer; a successful add appends one entry with the next
  rank; a duplicate slug replaces in place; a non-`[a-z0-9-]` slug is rejected;
  a yt-dlp non-zero exit surfaces a human message; manifest is written atomically;
  **no test asserts audio playback of an `.m4a`** (Gap 13) — assert the manifest
  entry plus `GET /music/<slug>.m4a` → 200 with `Accept-Ranges`.
- **Verification:** `node --test tests/music-add.test.mjs tests/music.test.mjs`
  → `# fail 0`.
- **Adaptation:** if `songsRecipe()` (`server.js:540-604`) drops the new entry
  (it skips songs whose audio file is missing, `:548-549`), the add wrote to the
  wrong directory — STOP and re-check whether the write target is the Drive
  content folder or `<DATA>` (Gap 1: build in the Drive folder, serve from
  `<DATA>` after the mirror).

**T4.3 — reorder endpoint (writes `rank`)**
- **Acceptance:** `POST /music/order {ids:[…]}` rewrites `rank` in
  `music/manifest.json` atomically, preserving every other field; unknown ids
  are rejected 400; the recipe's ETag changes so boards refresh
  (`server.js:602`).
- **Files:** `music-add.js`/`server.js`; `tests/music-add.test.mjs`.
- **TDD:** required. Cases: reorder changes ranks and only ranks; partial id
  list is rejected; the recipe ETag differs before/after.
- **Verification:** `node --test tests/music-add.test.mjs tests/music.test.mjs`
  → `# fail 0`.

**T4.4 — the partner strip in the board header** *(era-board repo; posture: implementing — placement decided 9/4, see below)*
- **Acceptance:** a `#partnerStrip` with `+ Add` and `⇅ Arrange` renders on
  `?recipe=songs` and `?recipe=movies` only; it carries **no** `.dwell` class and
  **no** gaze handlers; the door stays the msgbar's only dwell target; the bar
  stays ≤ 9.1 % of viewport height; centre cells `[2,2][2,3]` stay black. The
  four gate assertions are **amended, not deleted**, to allow exactly this one
  extra child and to assert positively that it is not a dwell target:
  `board-input.test.mjs:153`, `board-pixel.test.mjs:131-132`+`:210`,
  `board-wardrobe-note.test.mjs:53`, `board-splash-door.test.mjs:43`.
- **Files:** `era-board/app/index.html`, `board-render.js` (`mountDoorBar`
  `:125-157`), `board.css`; `era-board/tests/board-input.test.mjs`,
  `board-pixel.test.mjs`, `board-wardrobe-note.test.mjs`,
  `board-splash-door.test.mjs`.
- **Placement (decided by the orchestrator 9/4, under dad's 9/4 amendment):**
  inside `.msgbar`, at the end opposite the door, sized to the existing bar
  height; the four gates are amended to allow exactly one `#partnerStrip`
  child that carries no `.dwell`. The 9/3 revert (`7e9012f` → `d4a7556`) was a
  *dwell-reachable* button — the amendment authorizes only a pointer-only strip,
  which is what this task builds. The sibling-of-`.msgbar` placement is the
  escape hatch below, not a choice to bring back to dad.
- **TDD:** required — write the amended gate assertions **first**, watch them
  fail against the current board, then build the strip.
- **Verification:** `bash tools/era-gate.sh`; then
  `gate/board-input.test.out` and `gate/board-pixel.test.out` both `# fail 0`.
  Also confirm `board-pixel` still reports zero `BAR_TOO_TALL`.
- **Browser verification:** required — **video/gif** showing (a) a mouse
  reaching the strip and (b) the gaze/dwell path never firing on it.
- **Adaptation:** if the strip cannot fit inside the 9 % bar without shrinking
  the door, STOP and take the sibling-of-`.msgbar` placement (it dodges all four
  gates at the cost of grid height) — and record that the spec's "in the header"
  wording was satisfied by position, not by DOM parentage.
- **Guardrails:** the board's gates are law (memory: *board design rules are
  law*); amending them is authorized **only** for a non-`.dwell` strip. Never
  weaken the centre-cell or door assertions.

**T4.5 — arrange mode: drag tiles, cancel the dwell tap-rescue**
- **Acceptance:** `⇅ Arrange` toggles a mode in which a pointer drag reorders
  tiles and, on release, `POST /music/order` persists it; `onTile`
  (`board-render.js:615`) does **not** activate during a drag; `dwell.js`'s
  150 ms tap-rescue (`dwell.js:302-312`) never synthesizes a click at the end of
  a drag (use `data-dwell-disabled`, which `dwell.js:154` honours, or
  `preventDefault` on `pointerdown` in arrange mode); leaving arrange mode
  restores normal activation.
- **Files:** new `era-board/app/board-arrange.js`; `board-render.js`
  (`mountBoard` API `:720-727`, `onTile` `:615`); `board.css`;
  new `era-board/tests/board-arrange.test.mjs`.
- **TDD:** required. Cases: a drag reorders the DOM; the dragged tile does not
  activate; no synthetic click fires within 300 ms of release; the POST body
  matches the new order; exiting arrange mode re-enables activation; arrange
  mode is unreachable by gaze.
- **Verification:** `bash tools/era-gate.sh` → `0 failed`.
- **Adaptation:** if suppressing the tap-rescue proves impossible without
  editing `era-core/dwell.js`, that is a **third-repo** change — STOP, document
  the blast radius (dwell.js is shared by every app), and escalate before editing.

- **Gate (Phase 4):** **`rae-flow:reviewing` against spec §6 Music and §7 packs.**
  Pass criteria: pack ships and installs; add/reorder write atomically to the
  Drive content folder; the strip passes the amended gates and is provably
  gaze-unreachable; recordings attached.
- **Phase 4 retrospective.**

---

### Phase 5: Movies strip, catalog writer, posters, availability adapter
**Posture hint:** implementing.
**Spec section:** §6 Movies.

**T5.1 — catalog writer against the real schema**
- **Acceptance:** `POST /movies/add {url}` writes a `titles[]` entry that
  `moviesRecipe()` actually renders: `{id:<slug matching /^[a-z0-9-]{1,64}$/>,
  kind:"movie"|"show", title, say, service, tier:"core", rank:<next free>,
  poster, launch:{url}}` **plus** provenance `{year?, tmdbId?, addedBy:"url"|"search"}`
  (Gap 3). Written atomically to `movies/catalog.json` in the Drive content
  folder; a duplicate id updates in place; the recipe's ETag changes.
- **Files:** new `movies-add.js`; `server.js`; `tests/movies-add.test.mjs`.
- **TDD:** required. Cases: an added title **appears in `/recipes/movies.json`**
  (this is the assertion that would have caught Gap 3); an entry missing
  `launch.url` counts toward `meta.pendingCount` and does not render; an invalid
  id is rejected; rank is the next free; `(2,2)`/`(2,3)` stay unpinned after the
  add (clone `tests/movies.test.mjs:167-168`).
- **Verification:** `node --test tests/movies-add.test.mjs tests/movies.test.mjs`
  → `# fail 0`.

**T5.2 — poster fetch (`og:image`, TMDB fallback)**
- **Acceptance:** on add, a poster is fetched from the deep link's `og:image`
  or from TMDB when a key is configured, saved as
  `movies/posters/<slug>.jpg`, and the entry's `poster` field is set to
  `"posters/<slug>.jpg"` — matching `era-family/tools/fetch-posters.mjs:64,76`
  and the `"movies/" + t.poster` join at `server.js:701`. Failure is silent:
  the title is added with `poster:null` and still renders.
- **Files:** `movies-add.js`; `tests/movies-add.test.mjs`.
- **TDD:** required, with a **local fake** page/TMDB server (`ERA_STREAMING_URL`
  or a dedicated seam). Cases: `og:image` found; no `og:image` and no key →
  `poster:null`; a non-image body is rejected; the saved path is the one the
  recipe joins.
- **Adaptation:** TMDB terms require attribution (see
  `era-family/tools/fetch-posters.mjs:8-9`). If a poster source's terms forbid
  local caching, STOP and link instead of caching.

**T5.3 — streaming-availability adapter behind an interface** *(posture: implementing — provider decided 9/4: TMDB + Watchmode, spec §6 and `docs/research/2026-09-04-streaming-availability.md`)*
- **Acceptance:** one interface
  `lookupTitle(query, region) → [{title, year, tmdbId?, providers:[{name, deepLink}], poster, similar?[]}]`
  with (a) a **null adapter** that returns `[]` so URL-paste works with no key
  configured, and (b) at least one real adapter selected by
  `<DATA>/content-config.json` `{movies:{provider, region}}`. The provider name
  is a **config value, not code** (spec §7 "provider drift"). Base URL from an
  `ERA_STREAMING_URL` seam; a missing key degrades to the null adapter with a
  Settings hint, never an error.
- **Input (landed 9/4):** `docs/research/2026-09-04-streaming-availability.md`.
  Real adapters: **TMDB** (`/search/multi` → title/year/tmdbId/poster/age
  certification; `/watch/providers` → provider flags) and **Watchmode**
  (`/search` by TMDB id → `web_url` deep link per source, `us_rating`,
  `similar_titles`). TMDB `provider_id` == Watchmode `packageId` (Netflix 8,
  Prime 9, Disney+ 337, Apple TV 350) — one provider table. Without a Watchmode
  key the result carries `providers[].name` but no `deepLink` ("found on
  Netflix"), and the sheet falls back to URL paste. Link shapes to pin in a
  test: Netflix `/watch/{id}`, Disney+ `/browse/entity-{uuid}`, Prime
  `primevideo.com/detail/{ASIN}` (never `watch.amazon.com?gti=`). The first
  implementation step is to obtain a Watchmode key and confirm the literal
  `web_url` strings — the memo could not verify them without signing the family
  up. Keys: `TMDB_API_KEY` exists in `era-family/data/tmdb.env`; Watchmode key
  is new (Settings card, optional).
- **Files:** new `movies-lookup.js`; `movies-add.js`; `server.js`;
  `tests/movies-lookup.test.mjs`.
- **Classification rationale (implementing):** provider, request shapes and
  fallback are decided and documented; JustWatch is excluded by ToS (dev
  reference only).
- **TDD:** required for the interface and the null adapter; the real adapter is
  tested against a recorded fake response only.
- **Verification:** `node --test tests/movies-lookup.test.mjs` → `# fail 0`; the
  fake server records exactly the calls expected (no key spend).
- **Adaptation:** if the memo's chosen provider needs a paid key a parent
  cannot get "in minutes" (spec §6 requirement), STOP and escalate — that is a
  requirement violation, not an implementation detail.

**T5.4 — the movies sheet: URL paste and search-result grid** *(era-board repo)*
- **Acceptance:** `+ Add` on `?recipe=movies` opens the same sheet shape as
  music: paste a deep link (Netflix / Disney+ / Prime / Apple TV / YouTube) →
  `POST /movies/add`; type a name → results render as a selection grid (poster,
  title, year, "on <service>"); picking one adds it. The hub still never serves
  video (D57) — playback stays with the ERAgaze launch
  (`board-render.js:582-600`, **no `Content-Type` header**). Arrange mode from
  T4.5 is reused, writing `rank` back.
- **Files:** `era-board/app/` (sheet module), `board.css`;
  `era-board/tests/board-movies.test.mjs` (extend).
- **TDD:** required. Cases: paste posts the right body; search renders N result
  cells; picking posts the right body; the sheet is pointer-only (no `.dwell`);
  the launch payload is unchanged by this work.
- **Verification:** `bash tools/era-gate.sh` → `0 failed`.
- **Browser verification:** required — **video/gif** of a paste-add and a
  search-add.

- **Gate (Phase 5):** **`rae-flow:reviewing` against spec §6 Movies.** Pass
  criteria: an added title renders on the board; posters resolve or degrade
  cleanly; the availability provider is a config value with a null default;
  full gate green.
- **Phase 5 retrospective.**

---

### Phase 6: Animate (fal card + cost gate)
**Posture hint:** implementing.
**Rationale:** the prompting approach, model, duration and negative prompt are
already decided and documented (`/home/claude/Book-Reader/docs/book-ingest-policies.md`,
`ellie-this-week/src/ellie/book/{animate,prompts}.py`); the only new UI is one
Settings card cloned from `#voice`. Ambiguity 2/5.
**Spec section:** §4 step 5, §7 keys.

**T6.1 — fal key card + `POST /fal-key` + probe**
- **Acceptance:** a new `<div class="card" id="fal">` cloned from `#voice`
  (`public/settings/index.html:101-119`) with a password input, `📋 Paste`
  (reusing `pasteInto`, `:594-598`) and Save; `POST /fal-key` stores the key
  under the `fal` role, **never echoes it back**, and proves it with **one real
  call** exactly as `/tts-key` does (`server.js:1574-1596`, `verifyTtsKey`
  `:876-888`), returning `{ok, error?, perClipPrice?}`. Base URL from a new
  `ERA_FAL_URL` seam.
- **Files:** `server.js`; `public/settings/index.html`; `ai-config.js`;
  `tests/settings-ui.test.mjs`, new `tests/fal-key.test.mjs`.
- **TDD:** required, against a **fake fal server**. Cases: a good key → `{ok:true}`;
  401 → a human message; unreachable → "could not reach fal"; the key is never
  in any response body; the card shows the saved state without the key.
- **Verification:** `node --test tests/fal-key.test.mjs tests/settings-ui.test.mjs`
  → `# fail 0`.

**T6.2 — animate step, cost gate, incremental re-publish**
- **Acceptance:** off by default; `/content/status` reports an estimated book
  cost (`pages × perClipPrice` from the T6.1 probe) and the review page's
  "Animate this book (≈ $x)" button is enabled only with a fal key; a click
  posts `POST /content/run {step:"animate"}`; the worker generates
  `video/NNN.mp4` per page using the documented prompting (per-book style bible;
  action-cam duel template for confrontation pages; the standing negative
  prompt; duration `"5"`; poll fal's returned `status_url`/`response_url`
  verbatim, never hand-built paths); after **each** clip the manifest is
  re-published with a bumped `exportedAt` so pages gain video as it arrives; a
  clip failure logs and continues.
- **Files:** new `content-animate.js`; `content-worker.js`;
  `public/book-review/index.html`; `tests/content-animate.test.mjs`.
- **TDD:** required, against a fake fal server. Cases: no key → the step refuses
  with a human message and the button stays disabled; the cost estimate matches
  pages × price; each clip triggers a re-publish with a new `exportedAt`; a
  failed clip does not abort the book; the request never contains the key in a
  URL or a log line.
- **Verification:** `node --test tests/content-animate.test.mjs tests/books.test.mjs`
  → `# fail 0`.
- **Adaptation:** fal spends real money. The cost gate is **mandatory** — if the
  estimate cannot be computed, the button stays disabled. Never auto-start
  animation from `scan()`.

- **Gate (Phase 6):** **`rae-flow:reviewing` against spec §4 step 5 and §7.**
  Pass criteria: cost gate enforced; no auto-spend path exists; keys never
  logged; full gate green.
- **Phase 6 retrospective.**

---

### Phase 6b: Out of allowance (dad 9/4 — "notify the user they are out of credits")
**Posture hint:** implementing.
**Rationale:** the pause already exists for Google (E4: `job.pausedUntil` from
the 429's `RetryInfo`, `content-worker.js` `holdHere` `{hold:"quota"}`); what is
missing is the same shape for ElevenLabs, a status field that names the
provider, and the UI telling the family in the places they look. Guardrail 9:
the family never pays Google, so this path is the NORMAL path for a slow book,
not an edge case. Ambiguity 2/5.
**Spec section:** §4 "Design target", §7 risks.

**T6b.1 — ElevenLabs runs out too: a pause, not a dead key**
- **Acceptance:** `content-narrate.js:102` today turns EVERY 401 into
  `permanent: ElevenLabs did not accept that key`. ElevenLabs answers a spent
  monthly allowance with 401 and a body `{detail:{status:"quota_exceeded",
  message:…}}` — that must become a **pause**, the way transcribe's spent
  ladder is (`content-providers.js` `.quota = true`): the narrate step returns
  `{hold:"quota", pausedUntil, note}` where `pausedUntil` is the subscription's
  `next_character_count_reset_unix` (one `GET /v1/user/subscription` through
  `ERA_ELEVEN_URL`; unreachable → now + 24 h) and the pages already narrated
  are kept. A 401 **without** the quota status stays permanent. `/content/status`
  jobs gain `paused: {provider:"google"|"elevenlabs", reason, until, addUrl}`
  (derived; `pausedUntil` stays for the existing readers), with `addUrl` =
  `https://aistudio.google.com/apikey` / `https://elevenlabs.io/app/subscription`.
  `/content/status` also carries `narration: {charactersLeft, resetsAt}` when a
  voice key exists (subscription endpoint, cached 10 min, null on any error,
  never the key). `POST /content/run {kind, slug, retry:true}` on a paused job
  runs it NOW (already true for permanent failures — pin it for pauses).
- **Files:** `content-narrate.js`; `content-worker.js`; `content.js`;
  `server.js`; new `tests/content-allowance.test.mjs` (**8443 hub + 8444 fake
  ElevenLabs + 8445 fake AI**).
- **TDD:** required, against fakes. Cases: fake ElevenLabs 401 `quota_exceeded`
  → state stays `narrating`, `paused.provider === "elevenlabs"`, `until` equals
  the fake's reset, narrated pages survive; 401 plain → permanent with the old
  message; fake AI 429 with `RetryInfo` → `paused.provider === "google"`;
  `retry:true` re-runs at once and the fake sees the call; the fake recorded
  every call it should have (zero recorded = a real key was spent).
- **Verification:** `node --test tests/content-allowance.test.mjs tests/content-narrate.test.mjs tests/content-worker.test.mjs` → `# fail 0`.

**T6b.2 — the two honest choices, where the family looks**
- **Acceptance:** the Settings books card (`public/settings/index.html` ~`:760`)
  and the review page (`public/book-review/`) show, for a paused book, one
  plain sentence naming the provider and the local resume time, and the two
  choices: *wait — it carries on by itself* or *add credit at <addUrl> and press*
  **Try again now** (posts `retry:true`). The voice card shows "≈ N characters
  left this month, about K pages (resets <date>)" when `narration` is known.
  Nothing new is dwell-able (review page and Settings are pointer-only already).
- **Files:** `public/settings/index.html`; `public/book-review/index.html`;
  `tests/settings-ui.test.mjs`; `tests/book-review-ui.test.mjs`.
- **TDD:** required, browser suites against a fake `/content/status`. Cases:
  paused google → sentence + AI Studio link + button; paused elevenlabs →
  ElevenLabs link; not paused → nothing; the button posts `retry:true` once.
- **Verification:** `node --test tests/settings-ui.test.mjs tests/book-review-ui.test.mjs` → `# fail 0`.

**T6b.3 — one Windows toast per pause**
- **Acceptance:** when a job ENTERS a pause (a new `pausedUntil` for that slug)
  the hub raises one Windows toast — "<Book> is waiting: out of <provider>
  allowance until <time>. Open Settings to add credit or let it wait." — via the
  proven powershell spawn shape (`server.js:275-290`); never twice for the same
  `(slug, pausedUntil)`; nothing on `retry`; no-op off `win32`. The spawn goes
  through a seam (`ERA_TOAST_CMD` or an injected function) so the test can see
  it without PowerShell.
- **Files:** `content.js` (or a small `notify.js` added to `tools/build-payload.sh`);
  `tests/content-allowance.test.mjs`.
- **TDD:** required. Cases: entering a pause → exactly one toast with the
  provider named; the same pause seen again on the next scan → none; a
  different `pausedUntil` → one more; Linux → none.
- **Verification:** `node --test tests/content-allowance.test.mjs` → `# fail 0`.
- **Adaptation:** toasts from a scheduled-task session need an AppId — use
  PowerShell's own; if the VM shows no toast in Phase 7, log it as a follow-up,
  do not block the phase.

- **Gate (Phase 6b):** review against spec §4 "Design target". Pass criteria:
  no allowance answer from any provider is a dead end; the key never appears in
  status, log or toast; full gate green.
- **Phase 6b retrospective.**

---

### Phase L: follow-ups from the 16-page live run (9/4, commit 0822ebd, port 8453)
**Posture hint:** implementing.
**Rationale:** the one full live build (16 pages, two models a page, 17
narrations, publish, shelf mirror: 111 s; 15/16 pages loose-perfect, the one
page with real errors flagged, zero silent errors) worked end to end; what it
surfaced is status/log truthfulness, not pipeline correctness. Each item is
small and has a reproducer in the run's artefacts. Ambiguity 1/5.
**Spec section:** §4, §7 risks ("the parent must be able to trust the card").

**L1 — `skipped` is a count AND a reason** — **LANDED in `c8909ce` (Phase E
review fixes, finding 6)**: `mirrorBook` now returns `blocked` (string reason)
beside `skipped` (count); `server.js` logs "built but not shelved" only on
`error || blocked`; pinned in `tests/drive-localfolder.test.mjs` (blocked vs
skipped count, re-publish, unknown book) and `tests/content-worker.test.mjs`
(the spawned hub's shelving line, from piped stdout). Nothing left to do.

**L2 — the page count shrinks and grows back during ingest** — `content.js`
~`:360-362` `jobFor` takes `max(built, text.pages, listing(dir).count)` and
`listing()` counts LOOSE photos, which `content-ingest.js` ~`:139-147` moves into
`sources/` one by one. Live: `/content/status` said 16 → 3 → 6 → 11 → 15 → 16.
Fix: count `sources/` + loose together (a photo is one page wherever it sits);
test with a half-ingested folder in `tests/content-routes.test.mjs` or
`tests/content-worker.test.mjs`.

**L3 — transcribe progress is invisible and a killed worker loses the pass** —
`content-providers.js` ~`:856` writes `text.json` once after the whole loop;
`progress.transcribed` stayed 0 for the whole step (on a throttled free key,
for hours). The comment at ~`:846` promises "half a book of text is progress a
free key paid for" — make it true: write `text.json` (tmp + rename) after each
page, so `progress.transcribed` climbs and a restart resumes from the pages
already read (the existing per-page skip must honour them). Test: fake AI
answers 3 pages then the worker is stopped → `text.json` has 3; the re-run asks
only for the rest (fake call count).

**L4 — the thinking-shape retune is silent** — **LANDED in `c8909ce` (Phase E
review fixes, finding 2)**: the retune (`content-providers.js` `retune()`,
`thinkingShape` map) now happens only on a 400 that names the thinking field,
the memo is written only when the re-shaped call is ACCEPTED, and the refusal
is read off the whole body. Pinned in `tests/content-transcribe.test.mjs`
("400-that-was-never-about-thinking", "wordy INVALID_ARGUMENT past 160
chars"). The one thing that commit did NOT add is the `log.jsonl` line per
retune — fold it into L3's per-page write if it is a one-liner there,
otherwise leave it: the memo is now deterministic, so the ledger reconciles.

**L5 — `cost.narrated` counts pages, not purchases** — `content.js` ~`:363-370`
sums CURRENT text lengths, so a re-narrated page is counted once (card said
4614, ElevenLabs saw 4986). Keep a small `spent` ledger on the job (chars sent
per narrate call, appended by the narrate step) and sum it. Test: narrate, edit,
re-narrate one page → ledger = book + that page.

**L6 — an edited page reads as "nobody checked it"** — `content.js` ~`:791`
drops `read` on a parent edit (right), so `checkedBy` is null afterwards, and
the Phase 3 follow-up "`edited` is per page, never surfaced" compounds it. The
review page and `/content/status` say **"edited by you"** for such a page (and
never "unchecked"); the rebuild-with-edits path keeps the badge. Test in
`tests/book-review-ui.test.mjs` with a fake status carrying `edited:true`.

**L7 — re-pin the transcriber to the RECOVERED v2 wording (closes the KNOWN GAP
in `content-providers.js` ~`:84-116`)** — the Phase E review found E3's v2 was
a hand-reconstruction (a third wording nobody measured) and, unable to find the
real text, pinned both passes to v3 (`c8909ce`). The real v2 has since been
recovered: `tools/ocr-bakeoff/lib/prompts.mjs` as it stood in a stale worktree
snapshot of this repo (`PROMPT_VERSION = 'v2'`, mtime 2026-09-04 06:33 UTC).
Provenance: the private cache's 3,120 v2 records span **06:33–07:26 UTC** — the
first is stamped the same minute as that file — the snapshot was taken at 07:11
(inside the window), and v3's records start 08:37; the file differs from v3
ONLY in `PROMPT_VERSION` and rules 5 and 6, exactly as v3's changelog says. So
this is the string the 89.2% "v2 two-pass" row was measured under, not a
paraphrase. The workflow passes its path as `args.v2File` (sha256 prefix
`738e2355f1ab0527`); copy, never retype.
Do exactly what `content-providers.js:104-110` asks: (1) land it in the harness
as a second exported wording — `POLICY_V2` + `export function
transcribePromptV2()` composed like `transcribePrompt()`, `PROMPT_VERSION` stays
`'v3'` (the cache keys on it), changelog line under v3 saying v2 is kept
exported because the hub's transcriber pins it; harness test: `transcribePromptV2()`
differs from `transcribePrompt()` only in rules 5 and 6 (reuse the rule-splitting
in `tools/ocr-bakeoff/test/prompts.test.mjs`) and equals the recovered file's
string byte for byte; (2) `PROMPT_TEXT.v2 = POLICY_V2 + "\n\n" + OUTPUT_CONTRACT`
in the hub, `DEFAULT_PROMPTS.transcribe = "v2"`, second-opinion stays v3;
(3) in `tests/content-transcribe.test.mjs` a byte-for-byte assertion of `two.v2`
against `bakeoff.transcribePromptV2()` beside the v3 one, and "no wording the
bake-off never measured is ever sent" extended to the v2 entry; (4) rewrite the
KNOWN GAP block as CLOSED (keep the "never upgrade both in one move" rule, drop
the "not recoverable" paragraphs, keep one sentence on why the reconstruction
was wrong). The `tools/ocr-bakeoff/` read-only rule is LIFTED for this task
only, for `lib/prompts.mjs` and `test/prompts.test.mjs`; the bake-off cache,
dataset and README numbers are untouched.

- **Gate (Phase L):** the four content suites + the review-page suite +
  `tools/ocr-bakeoff/test` green; full gate at the phase boundary.
- **Phase L retrospective.**

---

### Phase 7 (FINAL, MANDATORY): Behavioral verification, including Windows VM QA
**Posture hint:** implementing.
**Rationale:** every step is a concrete command with a concrete expected output.
The judgement is only in reading the result. Ambiguity 1/5.
**Spec section:** §7 "Testing" — *"End: front-end QA on the Windows VM per dad's
directive"*.

> Unit and integration tests are necessary but **not sufficient**. This phase
> verifies the feature as the family experiences it, with real files and a real
> installer, not mocks.

**T7.1 — full workspace gate, green**
- **Acceptance:** every suite in era-core, era-making-words, era-pencil,
  era-board and this era-hub worktree passes.
- **Verification:** `bash tools/era-gate.sh` (from the era-hub worktree).
  **Expected output:** final line `== era-gate: N passed, 0 failed ==`, exit 0.
  Before running: `ss -ltnp | grep -E ':(83[7-9][0-9]|84[01][0-9])'` returns
  nothing that is an ssh tunnel to a family device (a tunnel answers as that
  device's live hub and poisons the gate).
- **Evidence:** paste the final line and the per-suite PASS list into the workpad.

**T7.2 — board gates, explicitly**
- **Acceptance:** `board-input`, `board-pixel`, `board-wardrobe-note` and
  `board-splash-door` pass with the amended strip assertions, and `board-pixel`
  reports zero `BAR_EXTRAS` beyond `#partnerStrip` and zero `BAR_TOO_TALL`.
- **Verification:** after T7.1, read `gate/board-input.test.out`,
  `gate/board-pixel.test.out`, `gate/board-wardrobe-note.test.out`,
  `gate/board-splash-door.test.out`. **Expected:** `# fail 0` in each.
- **Evidence:** the four `# fail 0` lines in the workpad.

**T7.3 — the payload actually ships every new file**
- **Acceptance:** `content.js`, `content-worker.js`, `content-providers.js`,
  `words.js`, `ai-config.js`, `image-util.js`, `music-add.js`, `movies-add.js`,
  `movies-lookup.js`, `content-animate.js` and `public/book-review/` are all in
  the built payload, and the built hub boots.
- **Verification:**
  1. `bash tools/build-payload.sh /tmp/era-payload-final` → exit 0
  2. `ls /tmp/era-payload-final/*.js /tmp/era-payload-final/public/book-review/index.html`
     → every file listed above present
  3. `ERA_DATA_DIR=/tmp/era-payload-data ERA_NO_UPDATE=1 node /tmp/era-payload-final/server.js 8450`
     run **in the foreground** (a `start /min`-style launch hides a crash) →
     logs `era-hub on http://127.0.0.1:8450`; then
     `curl -sf http://127.0.0.1:8450/content/status` → valid JSON.
- **Evidence:** the boot line and the JSON body.

**T7.4 — a real book, end to end, from photos on disk**
- **Acceptance:** starting from a folder of real page photos in a local
  Drive-shaped folder, the hub claims it, transcribes (against the configured
  provider — this is the **one** place a real key may be used, by a human, never
  by a test), narrates, publishes, and the reader plays it with word highlighting.
- **Verification (Linux box, before the VM):**
  1. `mkdir -p /tmp/era-content/books/"Test Book"` and drop 3 page images in
  2. `printf '%s' '{"mode":"local","folderPath":"/tmp/era-content"}' > /tmp/era-data/drive.json`
  3. start the hub on **8450** with `ERA_DATA_DIR=/tmp/era-data`
  4. `curl -sX POST localhost:8450/integrations/drive/sync` then poll
     `curl -s localhost:8450/content/status` until `state` reaches `published`
  5. `curl -s localhost:8450/books/index.json` → the book appears with the right
     slug and page count
  6. `curl -sI "localhost:8450/books/test-book/audio/001.mp3"` → `200` with
     `Accept-Ranges: bytes`
  7. `curl -s localhost:8450/books/test-book/manifest.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(m.pages.every(p=>Array.isArray(p.words)&&p.words.length))})'`
     → `true`
  8. `curl -sI "localhost:8450/books/test-book/.build/job.json"` → `404`;
     `curl -sI "localhost:8450/books/test-book/sources/IMG_0001.jpg"` → `404`
- **Evidence:** the status transitions, the index entry, and the two 404s.
- **Guardrails:** use throwaway images, never real family book photos, and
  never commit any of it.

**T7.5 — Windows VM QA (unattended legs first)**
- **Acceptance:** the candidate installs on the pristine VM, the hub boots, the
  new pack installs on demand, and nothing regressed in legs A and B.
- **Verification:**
  1. Build the release: `bash tools/release.sh` (it refuses to cut with < 2 GB
     free and keeps `makensis.log`; prune `dist/release-*` first — memory:
     *disk full → makensis SIGBUS*).
  2. `bash tools/vm-e2e.sh <dist dir>` → legs A and B, `0 failed`; artefacts in
     `gate/vm-e2e/`.
  3. **Defender FastPath re-verify** the freshly cut installer by downloading it
     through Edge **on the VM** (memory: *Defender FastPath* — a hash-flag on an
     unsigned re-cut is normal; a re-cut clears it). The new yt-dlp binary is an
     extra file to watch (spec §7 risk).
- **Evidence:** the leg A/B summary lines and the Edge download screenshot.

**T7.6 — Windows VM QA (driven by hand, the parts no harness covers)**
- **Acceptance:** a person can, on the VM, drop a book into the Drive folder and
  watch it publish; add a song and a movie from the board **with a mouse**; and
  confirm gaze cannot reach the strip.
- **Concrete driving steps** (from the VM driving lessons memory; drivers live
  in `era-family/tools/vm/`, creds in `era-family/data/vm.env`):
  1. Revert to `pristine2` (`/root/vm-revert.sh`). **After a revert, qemu
     restarts and the VNC agent writes "ok" into a dead socket** — send
     `reconnect` (or restart `vmagent.py` with a *separate* ssh call) before
     believing any click.
  2. `warmEdge()` from `tests-vm/lib/vm.mjs` (~60 s) before opening the kiosk —
     a cold Edge on the emulated disk loses its first navigation.
  3. Install the candidate: Edge download → hover → the **right** "…" (the left
     button is the trash) → Keep → "Delete ▾" → Keep anyway → SmartScreen More
     info → Run anyway. **The installer opens BEHIND Edge.** Never send `esc`
     while an NSIS window exists — it cancels the install silently.
  4. Launch the hub in her session with the schtasks pattern
     (`schtasks /create … /it /rl highest /f` then `/run`); a `schtasks`-created
     task **will not start on battery** — `Set-ScheduledTask` to clear that
     first (memory: *schtasks battery default*).
  5. Drive: sign in, let `New ERA Content` appear, then ship the page photos with
     `ship.sh` and move them into `books\Test Book\` via a **`.ps1`** (paths with
     spaces mangle through `vm.sh guest`).
  6. Watch it publish: `vm.sh guest 'curl -s http://127.0.0.1:8377/content/status'`
     (guest `curl` through `vm.sh guest` works for hub JSON; PowerShell pipelines
     do not — .ps1 only). Poll with one Bash call ≤ 9 min
     (`for … sleep 15` with a break condition).
  7. Open the Book Reader from its desktop icon (Book Reader 38,630; New ERA
     38,235) and confirm the book reads with highlighting.
  8. Open the board on `?recipe=songs`, click `+ Add` **with the mouse**, paste a
     URL via `clip.sh` (wait ≥ 3 s, click the field, `ctrl-v`, **screenshot
     before Enter** — a paste has landed empty and has pasted stale clipboard).
     First 📋 Paste triggers Edge's clipboard prompt in the kiosk's **top-left**
     (Allow at ~299,132). Confirm the tile appears.
  9. Repeat on `?recipe=movies` with a deep link; confirm the tile launches
     through ERAgaze.
  10. **Gaze cannot reach the strip:** with the engine running, dwell on the
      strip's buttons for ≥ 3× the dwell time and confirm nothing fires; then
      confirm the door still fires. Record it.
  11. Screenshots: `vm.sh shot` writes `/tmp/era-vm-claude/vm.png` and
      **overwrites** it — copy each shot to a named file. A 190-byte PNG means a
      blank display; `vm.sh wake` (QEMU monitor `sendkey ctrl`) wakes it —
      VNC input does not.
- **Evidence required in the workpad:** named screenshots for steps 3, 7, 8, 9;
  a **video/gif** for step 10; the `/content/status` transitions from step 6.
- **Adaptation:** if the VM stalls, check
  `wmic path Win32_PerfFormattedData_PerfProc_Process get Name,PercentProcessorTime`
  for `MsMpEng` / `MpSigStub` / `TiWorker` / `System` **before** calling it a
  hang — servicing starvation has cost hours twice.

**T7.7 — device restore note (not a code task)**
- **Acceptance:** if the family device was used for testing, the restore is done
  per `/home/claude/aac-board-builder/docs/i13-qa-cycle.md` (the three parked
  keeps: `ellie-data-keep`, `raegaze-keep`, `gdrive-clothing-keep`; restores
  **move** them back). Device tunnels use `ssh -f -N -L 8425:127.0.0.1:8377 i13`
  — port **8425+**, never 8377–8416. A reboot may need a hand wake.
- **Verification:** the verify script (`tools/i13-verify-zero.ps1` for a
  teardown) or a manual check that TD Snap tiles launch again.

- **Gate (Phase 7):** **`rae-flow:reviewing` final pass against the whole spec.**
  Pass criteria: every §7 "Testing" bullet has evidence in the workpad — unit
  tests per rail, mocked adapters with no key spend, board gates green, and the
  VM walkthrough (install → drop a book → watch it publish → add a song and a
  movie with a mouse → gaze cannot reach the strip).
- **Phase 7 retrospective:** decisions, observations (what the VM found that the
  gate did not), adaptations, follow-ups, confidence + residual risks.

---

## D. Posture summary

| Task | Posture hint | Confidence | Rationale |
|---|---|---|---|
| T1.1–T1.4 | implementing | High | Mechanical, existing suites, tests writable first |
| T2.1–T2.5 | implementing | High | `clothing.js`/`clothing-worker.js` are a working reference for every rail |
| T2.6 | implementing + escape hatch | Medium | Adapter shape is known; a bake-off winner outside the big three would change it |
| T2.6a | implementing (config) | Medium | Trivial once the decision lands; may ship with the spec's default |
| T2.7–T2.9 | implementing | High | Algorithm and route patterns are fully specified |
| T2.10–T2.11 | implementing | High | Clone existing card / note patterns |
| T3.1–T3.4 | implementing | High | §5 enumerates every control |
| T4.1–T4.3 | implementing | High | Pack + endpoint patterns exist |
| T4.4 | implementing | Medium | Placement decided (inside `.msgbar`, pointer-only, gates amended per dad's 9/4 amendment); escape hatch documented |
| T4.5 | implementing | Medium | Greenfield drag code in a codebase with none, plus a known dwell landmine |
| T5.1–T5.2 | implementing | High | Schema and poster conventions are pinned by existing code |
| T5.3 | implementing | High | Provider decided 9/4: TMDB (search/poster/discover) + Watchmode (deep links), Watchmode optional with TMDB-only fallback |
| T5.4 | implementing | Medium | Reuses T4.4/T4.5 once those settle |
| T6.1–T6.2 | implementing | High | Prompting, model and duration already decided and documented |
| T7.1–T7.7 | implementing | High | Concrete commands with concrete expected output |

---

## E. Execution readiness

- **Ready:** Phases 1, 2 (except T2.6a's default), 3, 4, 5, 6, 7.
- **Ready with a stated default:** T2.6a (ship the spec's policy if the
  decision file is absent). T5.3's provider is decided (TMDB + Watchmode).
- **Needs a call during execution:** none. Open questions below were answered
  by the orchestrator on 9/4 (answers inline).
- **Out of scope, recorded:** API-mode Drive upload (Gap 1); merging
  `clothing.js` onto the new rails (spec §3 says YAGNI); the recommendation
  engine (spec §6 "Long term"); `installPack` checksum verification (Gap 14);
  the `EC.session` / `body.next` dead code in `board-render.js:568`.

## F. Open questions (documented, not asked — subagent mode)

1. **Strip placement** (T4.4) — **answered:** inside `.msgbar`, gates amended
   for one pointer-only child; sibling placement only as the escape hatch.
2. **API-mode building** (Gap 1) — **answered:** local Drive mode only for v1.
   API mode is dormant and has no Settings UI; an upload path is a later scope.
3. **Review-page URL** (Gap 4) — **answered:** `/book-review/`.
4. **Book removal** (T3.4) — **answered:** delete the Drive folder (lands in
   the family's Google trash for 30 days) behind a confirm; mirror deletes follow.
5. **`media-tools` pack checksum** (Gap 14) — **answered:** accept for now;
   follow-up filed to reuse `latest.json`'s sha256 in `installPack`.

---

## Retrospective: Phase 1

Five commits on `feat/audit-fixes` (`7d81f77`, `d3e8785`, `315c6e2`, `6fc0a84`,
`04906b1`) covering T1.1–T1.4 plus one review-fix pass. Touched `drive.js`,
`server.js`, new `slug.js`, `public/settings/index.html`, `tools/build-payload.sh`,
and the suites `tests/drive-mirror.test.mjs`, `tests/books.test.mjs`,
`tests/reconcile.test.mjs`, `tests/update.test.mjs`, `tests/update-boot.test.mjs`.

### Decisions
- **Manifests mirror last.** One shared `manifestsLast()` ordering rule drives both
  `copyTreeLocal` and `mirrorDir`: a directory's plain files, then its subfolders,
  then `manifest.json` / `catalog.json`. The reader treats the manifest's existence
  as "the book is here", so ordering is the whole safety property.
- **`movies` joins the mirror set**, and books/music/movies join `MIRROR_DELETES`
  now that books are *built in place* in Drive — the shelf a parent tidies must be
  the shelf the tablet shows. `content/` stays copy-only (lesson overrides, not a
  library).
- **Deny is 404, not 403.** `sources/` and `.build/` are denied by path segment
  inside `serveMediaJail` (books jail only; music/movies must not inherit it), and a
  denied name looks exactly like a name that is not there. Segments are lower-cased
  because the family's Windows filesystem opens `SOURCES/` as the same directory.
- **Slug identity is first-come.** `slug.js` (shipped in the payload) is the single
  slugify; the hub keeps a slug→directory map cached on the books-dir mtime. A folder
  already named as its own slug keeps that slug whatever else wants it, collisions get
  `-2`/`-3` and a log line, and an unknown slug is 404 even when a literal directory of
  that name exists — one package, one URL.

### Observations
- The audit's blocker was real and reachable by one tap: with books/music/movies in
  `MIRROR_DELETES`, "✨ Create it for me" makes five *empty* subfolders and Settings
  syncs the moment it returns, deleting a family's pre-existing books, music and
  `movies/catalog.json`. Fixed with a provenance ledger (`<DATA>/<sub>/.mirrored.json`,
  a dotfile the prune skips): the mirror prunes only what the mirror wrote. Skipping
  the prune for an empty source would have been both insufficient and wrong — dad's 9/2
  rule means an emptied wardrobe folder really does empty the wardrobe.
- Manifests compared by **size** were the quiet one: a re-publish that only bumps
  `exportedAt` keeps the same byte length, and `exportedAt` is the reader's cache-bust
  key — so every fix after the first was stranded on the device that built it. Now bytes
  (local) / md5 (API).
- Copying onto a live manifest truncates it first; a shelf load mid-copy read half a
  book. Manifests now land via a `.part` sibling + rename.
- Reading positions are per-slug in the reader's `localStorage`; the first-come rule
  is what keeps today's shelf from resetting.

### Adaptations
- Added `slug.js` to `tools/build-payload.sh` and to the three payload-list suites; the
  require-guard was proven to fail before the entry was added.
- Ordering tests force the bad listing order rather than trusting filesystem readdir
  order — otherwise they pass for the wrong reason.
- Prune safety rules from clothing were carried over *and pinned by tests*: an absent
  source prunes nothing (an offline Drive is not an empty Drive), dotfiles are never
  pruned (that is what keeps a half-built package's `.build/` claim alive), and only a
  listing that succeeded may prune at all.
- `clothing` adopts what it already mirrored (a true mirror since 9/2), so a photo
  deleted while the hub was down still goes on the next sync.

### Follow-ups
- `installPack` still does not verify the pack checksum (Gap 14) — reuse `latest.json`'s
  sha256.
- Slug collisions only log; no Settings-visible signal that two folders fought for a name.
- The `.mirrored.json` ledger has no compaction or repair path if it is lost or corrupted
  (today: a lost ledger means the mirror prunes nothing, which is the safe direction).
- Phase 1 is unit-verified only; the VM walkthrough (install → drop a book → watch it
  publish) is Phase 7's gate and has not run against these changes.

### Confidence and risks
Confidence **high** on T1.1–T1.4 as specified — all mechanical, all covered by tests
written before the change. Residual risk sits in the delete semantics: `MIRROR_DELETES`
now points at three libraries a family may have filled before ever seeing this hub, and
the ledger is the only thing standing between them and a prune. Second risk is Windows
filesystem behaviour (name resolution of trailing dots/spaces, case folding) — handled
where it was found, but this is the only platform that ships and the suites run on Linux.

---

## Retrospective: Phase 2

Eleven hub commits on `feat/audit-fixes` (`e410e21`, `405bb29`, `f2f506a`,
`f173b83`, `e50b2b9`, `c3e9976`, `93eb11c`, `d3e7810`, `01ea63c`, `5358200`,
`05d942a`, `c374180`, `ba82a5f`) plus one review-fix pass (`fb8e854`), and one
board commit on `feat/content-strip` (`bb5cfbe`, T2.11). New hub modules:
`ai-config.js`, `content.js`, `content-store.js`, `content-worker.js`,
`content-providers.js`, `content-narrate.js`, `content-publish.js`,
`content-ingest.js`, `image-util.js`, `books-index.js`, plus
`tools/ocr-bakeoff/`. New suites: `ai-config`, `content-claim`, `content-store`,
`content-worker`, `content-ingest`, `content-transcribe`, `content-narrate`,
`content-publish`, `content-routes`, `image-util`, and additions to
`settings-ui`, `reconcile`, `update`, `update-boot`.

### Decisions
- **A job's state names the step it still owes.** One `STEP_OWED` table in
  `content-store.js` is read by the worker, by `/content/status` and by
  `POST /content/run`'s validation, so the three cannot drift. `reviewing` owes
  narration — review never blocks a book (ruling 9/4).
- **HOLD is a third outcome, beside advance and fail.** A step that ran but
  still owes its state (no key yet, a spent free allowance, a transient page
  loss) stops the walk where it is, refreshes the heartbeat and keeps the claim
  and every byte already built. A book is never marked failed for running out of
  a free tier; it gains `pausedUntil` and resumes tomorrow on the pages already
  paid for.
- **Two free readings, and only a disagreement reaches dad.** The 9/4 OCR
  bake-off (109 scored pages, 8 books) picked `gemini-3.1-flash-lite` +
  `gemini-3.5-flash-lite` on deliberately different prompt versions: 89.2% of
  pages auto-publish with zero measured silent errors, ~11% go to a parent and
  contain 100% of the errors, $0 and no credit card in the default path.
  `escalateTo: null` now asks **nobody** rather than falling to the next rung —
  an unmeasured adjudicator must not overwrite a good reading. A named model
  only leads the ladder of its own provider.
- **`manifest.json` is written last, atomically, and never names a byte that is
  not beside it.** Its existence is what makes `booksIndex()` see a package, so
  ordering is the whole safety property on the device Drive mirrors to. A page
  with no mp3 publishes silent; a page never transcribed publishes as a picture;
  only a folder with no pages at all holds.
- **A status page is not a map of the family's disk.** `/content/status` carries
  no key, no claiming device name, no absolute path, and the suite asserts it by
  scanning the serialized JSON. `POST /content/run` answers 202 and builds
  behind it (a transcription takes minutes), 400s an unknown kind/book/step, and
  409s outside local Drive mode.
- **One function assigns every slug.** `books-index.js` moved the sticky,
  collision-resolving map out of `server.js` so the shelf and the builder agree.

### Observations
- The nine confirmed review findings clustered on **what happens after a step
  goes wrong**: `errors[]` and `permanent:true` were written and never read, so a
  page whose provider call 500'd left the book wordless and the walk continued;
  and `published` never settled to `done`, so every finished book looked
  claimable again half an hour later — each re-claim rewriting `job.json` and
  appending to `log.jsonl` *inside the family's Drive folder*, for Drive to
  re-upload, for ever. Build artefacts living in the synced folder turns any
  idle-loop bug into unbounded network traffic.
- The publish step's `cover.jpg` was being swallowed by ingest into `sources/`,
  becoming page 1 and shifting every page index by one — orphaning every
  `text.json` entry and every mp3. Two steps sharing a directory need an
  explicit contract about which filenames are inputs.
- The money guardrails were passing for the wrong reason: the per-test call
  array was reset between tests, so "no test spends a key" only ever proved it
  of the last test. They now count the whole suite.
- Three suites kept a fourth hand-written copy of the installed-file list;
  `content.js` grew two requires that copy did not have, so the installed hub
  died on its first line and only the gate caught it. They now read
  `tools/build-payload.sh`.
- A worker is loaded by *path*, so the payload require-guard could never see it —
  `clothing-worker.js` had been one grep away from shipping missing since 8/31.

### Adaptations
- `prompts.mjs` v3 was ported from the ESM bake-off harness to CommonJS: the
  harness is ESM but the Windows floor is Node 18 and the hub is CommonJS.
- The bake-off's measured asymmetry (two passes, two prompt wordings) is **not**
  yet reproduced in the hub — both passes send v3. Noted in code at
  `PROMPT_VERSION` rather than silently diverging from the measurement.
- `drive.onSynced` was a single property clothing already owned; a second owner
  would have silently replaced it. The fan-out moved to `server.js` so neither
  module knows about the other.
- Settings gained a per-book "Try this book again" (`POST /content/run`) because
  the only other door was a sync that cannot re-claim for 30 minutes; a parent's
  press is also the one thing that lifts a permanent failure, since by then they
  have usually fixed the key.
- `redact()` was extended to the `AQ.` AI Studio key form the Settings card tells
  families to paste today, not only the older `AIza` one.
- Board T2.11 landed as a footer strip on `feat/content-strip`, obeying the
  amended design rules: touch-only, never a gaze target, door stays the only
  dwell target in the msgbar.

### Follow-ups
- Ship the bake-off's prompt asymmetry (pass B on v2) — the agreement rate was
  measured with it and the code does not yet have it.
- No compaction for `log.jsonl`; it grows forever inside the Drive folder.
- Slug collisions still only log; nothing in Settings says two folders fought.
- `installPack` checksum (Gap 14) still open from Phase 1.
- Re-validate the bake-off in ~6 months; models, prices and free-tier limits move
  fastest, and an unpriced candidate cannot be cost-capped.
- Phase 2 is unit-verified only; no real key has ever been spent by a test, which
  also means the three provider adapters' *real* request shapes are proven only
  by their similarity to `clothing-worker.js`.

### Confidence and risks
Confidence **high** on the rails (T2.1–T2.5, T2.8–T2.10): they copy a shape
`clothing.js` has run in a family's house since 8/31, and every one was written
test-first. Confidence **medium** on the transcribe and narrate steps — the
policy is backed by real measurement, but the adapters have never spoken to a
live endpoint from this code path, and quota/refusal handling is exactly the
behaviour that only shows up on a real key. Chief residual risk is the Drive
folder doubling as the build directory: `job.json` and `log.jsonl` mirror to
every device, so any write-loop is a bandwidth bug as well as a logic bug — the
`done` fix closes the one we found, not the class. Second risk is the free-tier
pause path: a family whose first book arrives on a spent day sees a book sitting
still, and their whole impression of the product rests on the Settings card
saying so in words. Phase 7's VM walkthrough has not run against any of this.

## Retrospective: Phase 3

Phase 3 is the grown-up's review page — `/book-review/` — and the five doors behind
it. Five commits: `c9e601b` (T3.1 front door), `75a00bc` (T3.2 order + cover),
`7e9ba69` (T3.3 fix a word, re-narrate a page), `124b4f8` (T3.4 re-read, remove,
disabled animate) and `8440984` (review fixes). Every task was written test-first;
`tests/book-review-ui.test.mjs` grew from nothing to the phase's largest suite.

### Decisions
- **`text.json`'s array IS the book's order.** The drag does not write a separate
  order file; publish walks the array. One representation, so the shelf can never
  disagree with the page the parent just dragged.
- **A page is not a step.** Re-narrating one page never ticks the book's narrate
  step off — otherwise a parent who re-recorded page one would publish a book with
  every other page silent for ever. A named step on an already-published book is
  followed by a publish, so the correction reaches the manifest with a fresh
  `exportedAt`; a book that has not published yet is left alone.
- **Flags are cleared over HTTP, never authored.** Only the transcriber may say it
  was unsure. An edit clears that page's flags — a parent who retyped the line has
  answered the question.
- **`edited` is set only by the inline field.** "Read the photos again" keeps
  hand-typed pages by default, and the tick that spends money names exactly the
  pages it will pay for (`only`), so no page is bought twice.
- **The words are rendered as nodes, never assembled HTML.** It is the family's
  text going back onto the family's screen.
- **Refusals in words, before a worker is spawned.** No ElevenLabs key, no AI key,
  every page typed by hand — each is a sentence a parent can act on, not a 500.

### Observations
- The correction path had a silent, permanent bug: a fixed page republished the
  book *showing* the new line and *speaking* the old one, for ever, because the
  narrate walk reuses any page whose mp3 exists. `forgetPage` now drops the
  narration entry when the words actually changed — the page publishes silent
  until the walk buys the right recording. Costs nothing on its own.
- Every accepted write on the review page re-publishes through `runStep`, so a
  parent fixing a typo was quietly lifting a PERMANENT failure and putting a
  refused key back on the half-hourly walk. `runStep` now lifts one only on
  `retry:true` — Settings' "try this book again" is the single press that says it.
- `saveOrder`/`savePage` needed the "not while it is being built" guard `removeBook`
  already had: the transcriber holds `text.json` for minutes and writes the whole
  array back from its snapshot, so an edit made during a re-read was thrown away
  under a "Saved ✓".
- `POST /content/remove`, `/content/text` and `/content/run` accepted a
  cross-origin `enctype="text/plain"` form — any page open on the family PC could
  delete a book folder, rewrite the words, or spend. They now require
  `application/json` and refuse a cross-site `Sec-Fetch-Site`.
- The delete is jailed to a direct child of `<folderPath>/books`, resolved off the
  disk and re-checked after resolution, and refused mid-build. A failed remove no
  longer hands the browser an absolute path — `jobFor`'s law: a status page is not
  a map of the family's disk.
- `content-claim.test.mjs` was flaky about one run in four until `beforeEach` waited
  for the previous test's build and stubbed the worker; a real thread was writing
  into a folder the next test had deleted.
- Money guardrails held: the browser suite points every provider seam at one
  stand-in and asserts the whole suite made exactly one narrate call and three page
  reads, key in the header and never in a URL. No key file on this box was read.

### Adaptations
- `tools/era-gate.sh` per-suite timeout raised 600 s → 900 s. `clothing.test.mjs`
  takes ~607 s here and was being cut mid-subtest — a red gate with no assertion in
  it. Timeout raised, not the suite split; splitting is a follow-up.
- A re-read no longer reshuffles pages into camera order; the existing array order
  is kept, so a parent's drag survives the button. Found only because T3.2 landed
  before T3.4.
- The star the server picks for a book nobody has starred is painted back onto the
  strip, so the shelf never shows a cover the parent was not shown.
- "Animate this book" ships present-and-disabled, saying it needs a fal key
  (Phase 6), rather than being left out of the page — the strip's shape is then
  final for the VM walkthrough.

### Follow-ups
- Split `clothing.test.mjs`; a 10-minute suite inside a 15-minute ceiling is a gate
  that will go red again on a slower box.
- Nothing in the UI says a book is paused on a spent free tier — the Settings card
  says it, the review page does not.
- No undo on "Remove this book"; the Drive folder is the only copy the mirror
  restores from.
- `edited` is per page, never surfaced — a parent cannot see which pages the
  re-read will skip until they untick.
- Concurrency is guarded by refusal, not queueing: a parent who presses during a
  build is told no rather than having the write applied after.
- Phase 1's `installPack` checksum (Gap 14) and `log.jsonl` compaction still open.

### Confidence and risks
Confidence **high** on the page and its doors: every control was written test-first
against a browser suite that drives the real HTML, and the review fixes commit was a
genuine adversarial pass that found four real defects (the speaking-the-old-word bug
chief among them). Confidence **medium** on the correction *loop end-to-end* — the
re-narrate and re-read paths are proven against stand-ins only; a real key has still
never been spent from this code path, so quota, refusal and partial-failure
behaviour is the untested half. Chief residual risk is the mid-build write: the
guard refuses cleanly, but a parent who fixes three typos while a re-read runs sees
three refusals and no queue, and the shape of that failure has not been in front of
a real parent. Second risk is that the whole phase is unverified on Windows —
Phase 7's VM walkthrough has not run against any of it.

---

## Retrospective: Phase E (fixes from the 3-page live run)

Twelve commits on `feat/audit-fixes` (`84ba1e1` … `11b735b`), eight of them code:
E1 `84ba1e1`, E8 `043b314`, E6 `38ea6e6`, E2 `eb89f3d`, E3 `c5c54ae`, E4 `8399387`,
E5 `dbc28cf`, E7 `8c84fe8`, plus the adversarial review pass `c8909ce` and three
doc commits (`0822ebd` free-tier design, `0c32ab8` Phase L, `11b735b` Phase L
re-cut). 27 files, +2847/−166. Touched `drive.js`, `content.js`,
`content-providers.js`, `content-narrate.js`, `content-publish.js`,
`content-store.js`, `ai-config.js`, `server.js`, new `content-imprint.js`,
`public/settings/index.html`, `public/book-review/index.html`,
`tools/build-payload.sh`, and eleven suites under `tests/`.

### What the 3-page live run found
The pipeline ran end to end and still shipped four kinds of lie:
- **The second opinion was never asked.** The agreement pass existed but did not
  fire, so a page read once was presented as a page two models agreed on. A page
  nobody checked now says so — as a mark on the *page*, not a fake word-level flag.
- **The audio did not have to say the words.** No fingerprint tied an mp3 to the
  text it spoke, so an edited page kept reading the sentence it replaced. And the
  module's own `eleven_multilingual_v2` default silently beat the family's Voice
  card; the default now lives once, in `ai-config.js`.
- **The book never reached the shelf.** The worker publishes into Drive, the Reader
  serves `<DATA>/books`; only the ten-minute mirror crossed. `content.onPublished`
  → `drive.mirrorBook(name)` closes it *without* touching `onSynced`, whose
  clothing leg would have spent vision quota on the wardrobe every publish.
- **Publisher furniture was read as story.** ISBNs, imprints and FSC codes reached
  the page and were stripped from neither reading, so both readings agreed on the
  junk. `content-imprint.js` is a pure, anchored, English-only stripper applied to
  *both* readings before comparison.
Plus: the quota pause always slept until "tomorrow" whatever the 429 said; and the
local-folder Drive door was unreachable off Windows, which is why QA could not
drive it at all (`ERA_DRIVE_LOCAL_ROOTS`, env-only so no request can widen the jail).

### Decisions
- **Pause until the quota returns, not until tomorrow.** `pausedUntil` is an ISO
  instant read from the 429's RetryInfo, but believed *only* for a per-minute
  throttle; a spent **day** waits for midnight in the zone the allowance counts in
  (verified over 14,206 instants of 2026, both DST changes, zero bad).
- **Repair pays for exactly what moved.** A re-read narrates only the pages whose
  fingerprint changed in that run — never the whole book, which would buy a shelf
  of audio because someone pressed a button about the photos.
- **Ship only wording this repo can prove.** E3 pinned transcribe=v2 /
  second-opinion=v3, but the v2 text was reconstructed, not recovered; the review
  reversed that half and pinned both passes to v3 (asserted byte-for-byte against
  the harness) with the gap written in the header. `11b735b` then recut Phase L
  around the **recovered** v2 found in a 06:33 worktree snapshot — L7 re-pins it.
- **Counts are two numbers, not one.** "Words the AI was unsure of" and "pages to
  check" are different questions; conflating them printed "30 words" over a book
  with no highlight in it.
- **Settings tells the truth about free.** The AI card now says what the free
  Google key costs and steers to it; a paid key buys speed, not better words.

### Adaptations
- E1's patch was **not** applied verbatim: `path.normalize` keeps a trailing
  separator that `browseLocal`'s prefix test would never match, so the seam would
  have failed shut — the exact bug it exists to fix. Trailing separators are
  trimmed down to `path.parse(n).root`.
- E3's patch 03 was a truncated fragment; the intended shape was ported from the
  frozen snapshot and the brace bookkeeping redone.
- `content-imprint.js` was added to `tools/build-payload.sh` in the same commit
  that created it (plan Gap 10 — an unshipped require dies on the hub's first line).
- Two existing assertions were changed because the behaviour they pinned *was* the
  bug (`pausedUntil === tomorrow()`); `content.savePage` now deletes `read` so a
  page never claims a model produced the parent's own words.
- No agent ran the full `tools/era-gate.sh` mid-phase (three agents editing one
  worktree, and the sequential suites exceed the tool ceiling); the review commit
  did: **67 passed, 0 failed**.

### Follow-ups
- **L7: re-pin the transcriber to the recovered v2.** Until then the hub sends one
  wording, and the memo's headline (89.2%, best row v2 two-pass) describes a
  configuration this hub is not sending.
- `QUOTA_NOTE` and Settings still say "carries on tomorrow morning" for what may be
  a 47-second throttle; `tests/settings-ui.test.mjs` pins `/tomorrow/i`.
- Nothing reads `page.read` yet — the review page could name who read a page.
- `clothing-worker.js:42` is now the only place asserting the stale "20 requests
  per day per model".
- The Voice card offers no model picker, so every family gets `eleven_flash_v2_5`.
- Flags can still name a word the stripper removed; `^Printed in the sand …` is
  still eaten by the imprint anchors.
- `tests/icons.test.mjs` fails on this box (targets `:8377`, here an ssh tunnel).
- `gate/` holds a stale untracked copy of `content-transcribe.test.mjs`.

### Confidence and risks
Confidence **high** on the defects themselves: every one was found by a real
3-page run, fixed test-first, and the adversarial pass on top produced ten more
confirmed findings — the counting-book strip ("3 BEARS" eaten as a code), the
thinking-knob memo written on a *refusal*, the per-day 429 waking in 47 seconds.
Confidence **medium** on the pipeline end to end: every provider is a stand-in
behind an env-URL seam, so quota, refusal and partial-failure shapes are proven
only against fakes. Chief residual risk is prompt fidelity — the hub currently
sends a decorrelation by model alone, so live accuracy should not be assumed to
match the bake-off until L7 lands. Second risk: none of Phase E has run on
Windows; the Phase 7 VM walkthrough is still the first real test of the local-roots
seam, the shelf hook and the imprint stripper on a family's own box.

---

## Retrospective: Phase L

Follow-ups from the one full live run (16 pages, 9/4, commit `0822ebd`, port
8453). L1 and L4 had already landed in the Phase E review commit `c8909ce`, so
this phase ran L2, L3, L5, L6, L7 and then a review pass over all five.

### What landed
- `e3c4f13` **L2 — the page count holds still.** `photoCount()` counts loose
  photos and `sources/` together, so ingest moving the pile one file at a time
  can no longer make a card read 16 → 3 → 6 → 11 → 15 → 16. `cover.jpg` is the
  one non-page kept out (a finished 16-page book was saying seventeen);
  `listing()` still watches the loose pile alone, because the quiet period must
  see a folder as changing while photos land and *not* while ingest tidies.
- `df47f00` **L3 — every page is written down the moment it is read.**
  `text.json` is written per page (tmp + rename), so `progress.transcribed`
  climbs and a killed worker resumes instead of re-buying pages a free key
  already paid for. Pages the walk has not reached ride along in each write;
  only the final write may prune. L4's leftover `log.jsonl` line for the
  thinking re-shape folded in here.
- `5937cd0` **L5 — `cost.narrated` counts purchases, not pages.** A per-job
  ledger (`content-store.addSpend` → `job.spent.narrate {chars, calls}`,
  counters not a list, because `job.json` re-uploads to every device on every
  write) is billed per accepted call. The page sum stays as the floor so books
  narrated before the ledger existed never under-report to one page.
- `ee4b94c` **L6 — a page you typed says "Edited by you".** `edited` per page on
  `/content/text` and back with a save, plus its own count on `/content/status`
  (never folded into flags — there is nothing to fix on such a page); a
  pointer-only badge on the review card and one sentence in Settings.
- `e37a361` **L7 — the transcriber sends the RECOVERED v2.** v2 was found in a
  07:11 worktree snapshot (inside the cache's 06:33–07:26 v2 window, v3's start
  08:37) and differs from v3 only in `PROMPT_VERSION` and rules 5 and 6, as v3's
  changelog says. It lands in the harness as `POLICY_V2` /
  `transcribePromptV2()` (`PROMPT_VERSION` stays `v3` — it keys the cache) and is
  copied byte for byte into the hub; `DEFAULT_PROMPTS.transcribe = "v2"`,
  second-opinion stays v3, KNOWN GAP rewritten as closed.
- `983b680` **review fixes.** Five confirmed findings: the final write pruned on
  a permanent refusal that never reached the end of the book (deleting paid-for
  pages below it); the thinking memo was written on only one of three exits, and
  it seeds the next run for the life of the process; a loose photo counted as a
  page for ever, so a published 15-page book said "15 of 16"; Save without
  typing badged a page "Edited by you" and threw away the model that read it;
  and the narrate ledger sat outside the call, so a 200 with no alignment was a
  page ElevenLabs charged for and nothing recorded.

### Decisions
- **A page is a page wherever it sits.** Counting is by identity, not by folder,
  and only the two files that are provably not pages (`cover.jpg`) are excluded —
  a HEIC ingest could not convert still counts, because it *is* a page of the
  book the hub has not got.
- **A write may only delete what the writer has actually seen.** Per-page writes
  never prune; the final write prunes only when the walk reached the end.
- **Money is recorded at the instant it is spent**, inside the call, not by
  summing state afterwards — the same rule for `job.spent` as for `text.json`.
- **Two counts, never one**, again: `edited` is its own number beside flags,
  because "check this" and "you wrote this" are different questions.
- **Ship only wording this repo can prove** — now satisfied rather than deferred:
  the pair the hub sends is the pair the 89.2% row measured.

### Adaptations
- L4's `log.jsonl` line was folded into L3 rather than left, as the plan allowed:
  it was a one-liner once the per-page write existed.
- `job.spent` is counters, not a list of calls, because `job.json` re-uploads to
  every device on every write.
- The Phase L review pass was run and its findings fixed in-phase (`983b680`)
  rather than deferred to Phase 7 — four of the five were data-loss or
  money-truth bugs in code written this same phase.

### Verification
Phase L gate, re-run at the phase boundary: the four content suites +
`content-store` + the review-page and Settings UI suites — **163 pass, 0 fail**;
`tools/ocr-bakeoff/test/prompts.test.mjs` — **10 pass, 0 fail**.

### Follow-ups
- `QUOTA_NOTE` and Settings still say "carries on tomorrow morning" for what may
  be a 47-second throttle; `tests/settings-ui.test.mjs` pins `/tomorrow/i`.
- Nothing reads `page.read` on the review page yet — it could name who read a page.
- `clothing-worker.js:42` still asserts the stale "20 requests per day per model".
- The Voice card offers no model picker; every family gets `eleven_flash_v2_5`.
- Flags can still name a word the stripper removed; `^Printed in the sand …` is
  still eaten by the imprint anchors.
- `tests/icons.test.mjs` fails on this box (targets `:8377`, an ssh tunnel here).
- `gate/` still holds a stale untracked copy of `content-transcribe.test.mjs`.
- The page-sum floor for `cost.narrated` means a pre-ledger book still reports a
  number that is too low by every re-narration it has had; it self-heals only on
  the next narrate.

### Confidence and risks
Confidence **high** on the five defects and the review's five on top: each came
from artefacts of a real 16-page run or from reading the code that run exposed,
each was fixed test-first, and the gate is green. Confidence **medium** on the
pipeline end to end, unchanged from Phase E: every provider is still a stand-in
behind an env-URL seam, so quota, refusal and partial-failure shapes are proven
against fakes only. L7 removes the prompt-fidelity risk — the hub now sends the
measured pair — leaving the chief residual risk with **Phase 7**: none of Phase
E or L has run on Windows, and the VM walkthrough is still the first real test
of the local-roots seam, the shelf hook and the imprint stripper on a family's
own box. Second risk: the per-page `text.json` write multiplies small writes on
a Drive-synced folder; the 16-page run predates it, so its cost is unmeasured.

## Retrospective: Phase 4

Music, end to end: a grown-up can now put a song on Ellie's board from the
board itself. Five tasks (T4.1–T4.5) plus a review pass in each repo — four hub
commits (`1a423f9..1f8540a`) and three board commits (`bb5cfbe..8c2f7ef`, branch
`feat/content-strip`).

### What landed
- `bb892b8` **T4.1 — `media-tools` is its own pack.** yt-dlp is one ~18 MB
  standalone Windows binary and it is *not* in the repo: `tools/yt-dlp.pin` names
  a release and its sha256, `build-payload.sh` downloads exactly that, verifies,
  and only then lays it in the payload; a wrong hash stops the build. Unticked in
  the installer with its own MB in the hover text, measured by `build-dist.sh` —
  and a new `packs.test.mjs` assertion pins that every `PACKS` path is measured
  there, closing Gap 15's hand-kept second copy. `packs.ytDlp()` settles the
  runtime too: `node:<process.execPath>`, unquoted (yt-dlp splits on the first
  colon), safe with the space in "New ERA" because we spawn argv, never a shell.
- `7a982cc` **T4.2 — `POST /music/add`.** Paste a link or type a name. Four laws
  and `music-add.js` is nothing but them: the song is written to the family's
  **Drive** folder (`drive.status().folderPath + "/music"`), never `<DATA>`;
  **no ffmpeg** (`-f "ba[ext=m4a]/ba" --write-thumbnail`, never `-x` /
  `--audio-format` / `--convert-thumbnails`); a slug is a name, not a path; and a
  missing pack answers `{error:"pack-missing"}` the sheet can act on, never a 500.
  202 + `GET /music/add/status`, the `/clothing/regenerate` shape. Both doors sit
  **above** the `/music/` media jail.
- `8bce888` **T4.3 — `POST /music/order`.** The whole running order in one shot,
  `rank` only. A partial list, an unknown id or a duplicate is a 400 that changed
  nothing; an add in flight takes a 409. Atomic write to Drive, then a sync so the
  songs recipe's ETag moves and every board drops its 304.
- `a7dbc79` **T4.4 — the partner strip** (board). `#partnerStrip` at the far end
  of `.msgbar`, opposite the door, on `?recipe=songs` and `?recipe=movies` only —
  her outfit board untouched. Nothing in it carries `.dwell` or `data-dwell-*`;
  it tracks `--bar-inner` so it cannot make the ≤9 % slab taller. The four gates
  were **amended, not weakened**: each now tolerates exactly one `#partnerStrip`
  child *and* asserts positively that the door is the bar's only dwell target — a
  stronger claim than the child count it replaced.
- `3672aa4` **T4.5 — arrange mode.** Drag one song onto another, post the whole
  order. Gap 12's landmine handled with two guards for two paths: `.dwell` comes
  **off** every tile (what the 150 ms tap-rescue reads) *and*
  `data-dwell-disabled` goes on (what the gaze path reads), so shared
  `era-core/dwell.js` is not touched; a probe run confirmed the rescue really does
  fire without the fix.
- `1f8540a` + `8c2f7ef` **review fixes**, ten confirmed findings — the ones worth
  naming: a re-add deleted the old audio *before* the download, so a failed re-add
  destroyed a song for good (it now stages and replaces); `readManifest` swallowed
  every read error, so one locked or half-synced `manifest.json` read as "no songs
  yet" and was written back with a single song in it; the sheet's full-screen
  backdrop stopped **nothing**, because `targetAt()` walks the whole
  `elementsFromPoint` stack past an overlay with no `.dwell` — the board is now
  put to sleep the way arrange mode does it; arrange mode swallowed the page
  doors, so a song added today (last page) was unreachable from page one; and
  `build-payload.sh`'s blanket vendor copy ran *before* the pinned fetch, so an
  unverified local `vendor/yt-dlp` could ship as the pack.

### Decisions
- **Truth about the mirror travels with the answer.** `drive.sync()` reports
  failure by answering, not throwing, so `add()`/`order()` now return `mirrored`
  and the strip says "the board will catch up" instead of "the songs are in their
  new order" over a board that has not moved.
- **Only ENOENT is an empty library.** Any other read error refuses the write in
  words a parent can act on. (Same shape as Phase L's "a write may only delete
  what the writer has seen".)
- **A dead end is a bug.** "Install it and try again" got a button:
  `media-tools` belongs to no app, so `POST /packs/install` is keyed off
  `packs.PACKS`, not the app list — the next pack cannot fall down the same hole.
- **A pack is opt-in and honestly measured**; the binary never enters the repo,
  only a pin and a hash.
- **Gates get stronger when amended.** The 9/4 amendment cost the child-count
  assertion and bought a positive "the door is the only dwell target" one.

### Adaptations
- T4.4's escape hatch (mount as a sibling of `.msgbar`) was **not** needed —
  `--bar-inner` kept the strip inside the 9 % slab.
- Both review passes were run and fixed **in-phase** rather than deferred: six of
  the ten were data-loss, gaze-safety or supply-chain bugs in code written this
  same phase.
- Gap 13 honoured: nothing asserts `.m4a` playback; a song is proven by its
  manifest entry, the generated recipe, and a 200 + `Accept-Ranges`.
- Gap 22 honoured: no new coverage went into `board-routes.test.mjs`.

### Verification
Hub, re-run at the phase boundary: `music-add` + `music` + `packs` —
**38 pass, 0 fail**. Board: `board-partner-strip.test.mjs` — **8 pass, 0 fail**.
`board-arrange.test.mjs` must be run **under `era-gate.sh`** (it borrows the
gate's hub on 8377 and its 12 fixture songs); run bare on this box it times out
on `.tile[data-arrange-id="test-song-1"]` — the same 8377 hazard the Phase L
retrospective notes for `icons.test.mjs`. Its green run is the one recorded in
`3672aa4` (era-gate 70 passed, 0 failed; browser video recorded).

### Follow-ups
- Gap 14 still open: `installPack` (`server.js`) downloads the whole suite
  tarball with **no checksum**, unlike `update.js` — reuse `latest.json`'s sha256.
- Movies still say "the add is not built yet" — honest, and T5.4's job.
- `board-arrange.test.mjs` hard-codes `http://localhost:8377`; it cannot be run
  outside the gate and gives a bare timeout rather than a diagnosis when it is.
- Nothing re-verifies the pinned yt-dlp hash **after** install on the device; the
  guarantee ends at the payload.
- `mirrored:false` is reported but nothing retries the mirror; the family waits
  for the ten-minute pass.
- A rank collision between two devices adding at once is still last-writer-wins.

### Confidence and risks
Confidence **high** on the hub half: the write path is small, every law has a
test, the seams (`ERA_YTDLP`, `ERA_PACK_ROOT`) are proven by construction rather
than by the accident of an empty worktree, and no test spends a key or touches
YouTube. Confidence **medium-high** on the board half — the gaze-safety claims are
asserted from the capture phase with a real touch drag and a probe that showed
the rescue firing without the fix, but the pixel budget and the drag ergonomics
have only been seen at 1280×720 headless, not on the kiosk. Chief residual risk
is unchanged and belongs to **Phase 7**: yt-dlp has never been run on Windows
here — the pack, the `node:` runtime hand-off and the Drive-folder write are all
proven against a stand-in script, and a family's own PC (antivirus on the fresh
binary, a Drive folder mid-sync, YouTube answering 403) is the first real test.
Second risk: `POST /music/add` is a door a browser on the home LAN can reach; it
refuses a slug that is a path, but nothing rate-limits it.

## Retrospective: Phase 5

Five hub commits (`5deb992`, `27c9d82`, `1d9ff55`, `8723687`, `10a0fbc`) and one
board commit (`5e45729`) turned "the add is not built yet" — the honest sentence
Phase 4 left on the movies board — into a working "+ Add": paste a Netflix link,
or type "ada twist" and pick the film you meant.

### Decisions
- **The catalog has exactly one writer.** `POST /movies/add` (T5.1) is it;
  `/movies/lookup` writes nothing and a grown-up's pick is what lands. Same law
  as `music-add.js`, and it is what made the Phase 5 review fixes small.
- **A typed name is a question, a pasted link is an answer.** Songs take the
  first hit; films get a grid, because the wrong "peter rabbit" on a six-year-old's
  board is worse than one more tap.
- **Three behaviours, chosen by which keys a family typed, never by code:**
  `none` (paste box only, nothing spent), `tmdb` (title/year/poster and *where*
  it streams, no deep links — TMDB has none), `watchmode` (one extra free key,
  2,500/month, turns "on Netflix" into a link and brings the age rating).
  `<DATA>/content-config.json {movies:{provider,region}}` pins the choice per
  spec §7; absent means the keys decide, and a pinned provider still degrades
  rather than promising a key the machine does not hold.
- **Link shapes are pinned in the suite** (research memo §5.3, probed live):
  Netflix `/watch/{id}`, Disney+ `/browse/entity-{uuid}`, Prime
  `primevideo.com/detail/{ASIN}` rebuilt from the Roku link and never
  `watch.amazon.com?gti=`. Affiliate tags are stripped before a link goes near a
  child's board; rent and buy are not tiles. A provider changing a shape must
  fail a test rather than fail a six-year-old.
- **Watchmode's source ids are not TMDB's** (its Netflix is 203, TMDB's is 8), so
  the one service table is matched by id for TMDB and by name for Watchmode.
- **Attribution travels with the pixels.** TMDB's credit is sourced from
  `moviesAdd.TMDB_ATTRIBUTION` and sent by `/movies/lookup` with the rows; the
  board keeps no copy to drift, and no key means `attribution:null` rather than a
  credit for art nobody fetched.
- **⇅ Arrange is deliberately NOT claimed for movies.** It assumes the order the
  board *shows* is the order the hub *ranks* — true of songs, false of films
  (`moviesRecipe` ranks the exploration tile separately and the catalog holds
  titles drawn nowhere). `board-arrange.js` now says so instead of moving a tile
  that would snap back.

### Observations
- **The phase's whole bug class was one shape:** the hub said a thing was done
  and Ellie's board disagreed. All seven confirmed review findings were that.
  The worst was structural, not incidental: a show is drawn from its *episodes*,
  so a series written with `seasons:[]` was reported as drawn, counted as
  pending, and never appeared — while the sheet told the parent "<Title> is on
  the board". Most of what a six-year-old watches is a series, so that was the
  **normal** path, not an edge case. A show with one deep link and no harvested
  episodes now carries that link as its first episode, and `pending` means "the
  board will not draw this", not "there is no `launch.url`".
- **Phase 4's data-loss fix had to be made again, verbatim.** A re-add with no
  url of its own blanked `launch.url` and `service` — and the board's own search
  sheet posts exactly that body when a family has only a TMDB key, so re-picking
  a film you already had took it off the board. Same rule and same words as
  `music-add.js`'s Phase 4 fix. A law fixed in one writer does not propagate to
  the next writer by itself.
- **Slug collisions are real at family scale:** two "Cinderella"s replaced each
  other, the survivor wearing the loser's poster. 2015 takes the year as its
  surname; 1950 keeps its tile.
- **The board reads links aloud.** The canonical Disney+ form put "Entity 4e2c9f1a
  8b2c 4d5e 9f01 1234567890ab" on the board, spoken. A link's dash-words are
  judged now, not just the whole segment.
- **Two supply-chain holes came in with the poster hunt**, both from fetching on
  a family's behalf: `og:image` followed redirects to whatever a stranger's page
  named (now SSRF-judged before *every* hop — loopback, private, link-local,
  `.local` — redirects walked by hand, three at most), and the Watchmode key rode
  an `X-API-Key` header through `redirect:"follow"`, which undici re-sends to
  whatever answers (the keyed call no longer follows one).
- **The "add a key in Settings" dead end repeated too.** The hint named a
  Settings card that did not exist; the only way in was hand-editing JSON — the
  same shape as Phase 4's "Install it and try again". New **Films and shows**
  card, `POST /movies-key` + `GET /movies/keys` (booleans, never a key), and
  `/ai-key` now merges instead of rewriting the file those keys share.
- The Phase 4 amendment's price was paid again rather than assumed: nothing in
  the grid carries `.dwell` or `data-dwell-*`, a pointer parked on a poster past
  the door's 2400 ms hold fills nothing, the board sleeps while the sheet is up,
  and the door keeps its dwell throughout.

### Adaptations
- Gap 22 honoured: the board's new coverage went into a fresh
  `tests/board-movies.test.mjs` (10 cases, 6 new) that spawns its own hub, not
  into `board-routes.test.mjs`.
- D57 is asserted **byte for byte**, `Content-Type` included, because a preflight
  the native ERAgaze listener does not answer would stop every film opening.
- The lookup suite's closing guardrail was upgraded from decorative to an
  invariant it can actually fail: every request the stand-in saw is one it
  serves, on one of the two fake keys.
- Both review passes were run and fixed **in-phase** again; six of the seven
  findings were data-loss, read-aloud or supply-chain bugs in code written this
  same phase.
- No test spends a key or touches the network: TMDB and Watchmode go through the
  `ERA_STREAMING_URL`-style seams at a local fake, and `era-family/data/tmdb.env`
  is never read.

### Verification
`node --test tests/movies-add.test.mjs tests/movies-lookup.test.mjs
tests/settings-ui.test.mjs` → **50 pass, 0 fail**; clothing, movies, music,
music-add, routes, packs, ai-config, content-routes and setup all green.
Board: `era-gate 72 passed, 0 failed`; `board-movies.test.mjs` 10 cases, with a
browser video recorded against a real hub, a temp Drive folder and loopback
provider seams — a paste-add, a search-add, and a pick with no link.

### Follow-ups
- Phase 4's follow-ups are all still open: Gap 14 (`installPack` downloads the
  suite tarball with no checksum), the pinned yt-dlp hash never re-verified on
  the device, `mirrored:false` never retried, `board-arrange.test.mjs` hard-coded
  to `http://localhost:8377`, last-writer-wins rank collisions.
- **⇅ Arrange for movies needs a product decision** before it can be built: what
  does dragging a film onto the exploration tile mean?
- Nothing re-checks a deep link after it is written. A title pulled from Netflix
  leaves a tile that opens onto an error, silently, until a parent sees it.
- Watchmode's 2,500/month has no counter and no warning; the family finds out by
  the grid going empty.
- `POST /movies/add` and `/movies/lookup` are doors any browser on the home LAN
  can reach, rate-limited by nothing — same residual as `/music/add`.

### Confidence and risks
Confidence **high** on the writer: one writer, every law under test, the
provider seams proven by construction, and the review found its bugs where the
hub and the board disagreed rather than where the code was wrong in isolation.
Confidence **medium** on the availability data itself — the link shapes were
probed live on 9/4 and are pinned, but they are a third party's private URL
scheme and the pinning only converts a silent breakage into a red test *here*,
not on a family's machine. Chief residual risk is the same as Phase 4's and
belongs to **Phase 7**: none of this has run on Windows, against a real TMDB or
Watchmode key, on a kiosk screen, with a Drive folder mid-sync.

## Retrospective: Phase 6

Four commits, hub only — the board did not move this phase (`era-board` is still
at `5e45729`, T5.4). `123c977` (fal key card + `POST /fal-key`), `6eb040e` (the
gate fix that followed it), `2f7dd35` (T6.2: the animate step), `e32dac0` (the
in-phase review fixes).

### Decisions
- **fal is proved on save, like `/tts-key` and unlike the film keys.** It is the
  only key in New ERA that spends money per press, so a wrong key must be caught
  before a family is quoted a price for a book, not halfway through one they
  already agreed to pay for. The probe is one cheap read of the account billing
  row through the new `ERA_FAL_URL` seam; it generates nothing.
- **`perClipPrice` lives on the fal role.** fal publishes no price API and the
  cost gate is mandatory (spec §4 step 5), so the number recorded when the key
  was saved is the number the card quotes and the worker spends. A price a
  family was already quoted survives a re-save; a key fal refused (`keyOk:false`)
  is no key, exactly as the Voice card's rule.
- **The button may not be pressed until the hub can say how many dollars.**
  `/content/status` quotes every published book (pages × `perClipPrice`) and the
  review page puts that number *on* the button, disabled without it — no key, a
  refused key, or a book still being built.
- **Off by default, and it cannot be otherwise.** No state owes `animate`, so
  neither the walk nor the half-hourly scan can reach it; `content.js` refuses
  the press without a key or before the book has published and a thread exists.
- **Nothing is bought twice, and every accepted submission is billed onto the
  job the moment fal takes it** — fal charges on acceptance, so a clip that then
  failed to render is money that must still appear somewhere.
- **The manifest is re-published after every clip**, so a sixteen-page book gains
  its moving pictures as they arrive rather than in one lump at the end.

### Observations
- The one gate red line of the phase was not the money path at all: the "Open my
  fal API keys page" button was missing from `/open-url`'s allowlist, so the one
  card in the product that spends money would have opened *inside* the kiosk —
  the exact trap dad hit on Resend 9/3. `tests/setup.test.mjs` scrapes every
  "open site" URL out of Settings for this reason and caught it (`6eb040e`).
- The review's six confirmed findings were again bugs where two honest pieces
  disagreed, not code wrong in isolation:
  - the review page waited on the animate press with `settled()`, which gives up
    after five minutes. Sixteen clips at a couple of minutes each is an ordinary
    half-hour run, so the give-up path printed *"nothing was made… try again"*
    over a run fal was still rendering and still billing. The press now has its
    own uncapped wait that repaints every second.
  - the walk's safety re-publish fired only when **zero** clips published, so a
    clip whose own publish threw (Drive holding `manifest.json` open on Windows)
    was on disk, billed, and absent from the only file the reader reads —
    permanently, since a finished book owes no further step. Counts, not
    truthiness.
  - what fal actually charged was nowhere in the product; it is now on
    `/content/status` and on the review page whenever it leads what arrived.
  - fal's `status_url`/`response_url` are still followed verbatim (this model's
    name has subpaths), but only when they name fal's own origin — that key
    travels in an `Authorization` header.
  - `ai-config.json` now holds four cards' keys, so every writer goes through
    `content-store.writeAtomic` rather than rewriting in place (9/3: a full disk).
  - the 422 duration-suffix retry — the one path that submits a page twice — had
    no test; two submits, one charge, both now pinned.

### Adaptations
- The motion script per page is classified **on this computer** from the page's
  own words (ambient / story-beat / hero / the action-cam duel template for a
  confrontation). Nothing about the story is sent anywhere to decide it.
- The photo travels to fal as a data URI: a hub on a home network has no signed
  URL to hand out.
- A clip that fails is one page's loss — logged, book carries on — and a refused
  key can never mark a finished book failed.
- No test spends a key or touches the network: `ERA_FAL_URL` points at a local
  stand-in on 8441 (hub on 8439), stdout is piped so "no key ever reached a log
  line" is *checked* rather than hoped for, and both suites count the stand-in's
  calls so a probe that escaped to fal itself fails the suite.

### Verification
`node --test tests/fal-key.test.mjs tests/content-animate.test.mjs
tests/book-review-ui.test.mjs tests/settings-ui.test.mjs` → **75 pass, 0 fail**.
`node --check` clean on every changed file; `tools/build-payload.sh` carries the
new `content-animate.js`.

### Follow-ups
- **Nothing has ever been animated with a real fal key.** The price, the model
  id, the 422 duration-suffix retry and the poll shape are all pinned against a
  stand-in built from the documented behaviour; the first real run belongs to
  Phase 7 and may move any of them.
- No cap and no confirmation beyond the quote: a parent who presses twice on two
  devices pays twice. The "already has a clip" skip narrows but does not close it.
- The ledger is per-job; there is no running monthly total anywhere, so a family
  learns what they have spent only by adding books up themselves.
- Phase 4/5 follow-ups all remain open (Gap 14 checksum-less `installPack`,
  unverified pinned yt-dlp hash on-device, `mirrored:false` never retried,
  `board-arrange.test.mjs` hard-coded to 8377, last-writer-wins rank collisions,
  ⇅ Arrange for movies needing a product decision, unrechecked deep links,
  Watchmode's uncounted 2,500/month, unauthenticated LAN doors).

### Confidence and risks
Confidence **high** on the refusals and the accounting: the step cannot be
reached by any automatic path, every accepted submission is billed at
acceptance, and the review's worst two findings (a still-spending run called a
failure, a paid-for clip missing from the manifest for ever) were both found and
fixed in-phase with tests. Confidence **medium** on fal itself — every byte of
its behaviour here is a stand-in's, and the model id, the per-clip price and the
duration retry are the three places a live run is most likely to disagree.
Chief residual risk is unchanged and belongs to **Phase 7**: none of this has
run on Windows, against a real key, on a kiosk screen, with a Drive folder
mid-sync — and here that risk has a dollar figure attached to it.

## Retrospective: Phase 6b

Four commits, hub only — the board did not move this phase either (`era-board`
is still at `5e45729`, T5.4). `0d80dd5` (T6b.1: a spent ElevenLabs month becomes
a pause with a provider's name on it), `571ce5d` (T6b.2: that pause reaching
Settings and the review page), `cbb01a2` (T6b.3: one Windows toast per pause),
`8469b50` (the in-phase review fixes).

### Decisions
- **Running out is the normal path, not a fault.** The family never adds a card
  to Google and buys ElevenLabs by the month (spec §4 "Design target"), so the
  transcriber's E4 hold shape — `{hold, pausedUntil, note}` — now covers the
  voice too. Only a 401 whose *body* says `quota_exceeded` is a hold; any other
  401 still stops the book, because a genuinely wrong key must not be nursed for
  a month.
- **The hold carries WHICH allowance ran out.** Google's day returns by itself;
  ElevenLabs' month has to be topped up, and the two are mended in different
  places. `pausedProvider` is written onto the job (never cleared by a re-hold)
  and `/content/status` derives `paused:{provider, reason, until, addUrl}`
  beside the `pausedUntil` its existing readers already use.
- **The moment is the clock on the wall, never the ISO stamp.** "today at
  5:12 pm" / "tomorrow at 1:00 am" / "Saturday, 3 October at 9:00 am", worded
  identically in Settings, on the review card and in the toast — a parent told
  "ElevenLabs" by one and "the voice service" by another has been told about two
  different problems.
- **Both choices are pressable, and waiting is named out loud.** A card that
  offers only a button reads as "broken until you act". "Open my <provider>
  page" follows the `addUrl` that travels with the status and goes through
  `/open-url`, so a login lands in a real browser rather than trapping a novice
  in the kiosk (dad 8/29; the fal card's 9/5 gate finding).
- **"Try again now" is the only thing that lifts a pause.** The steps refuse to
  knock while one is recorded — that is what saves a free key's requests — so
  `runStep` lifts it where the press is, and a scan never does.
- **The toast is said once per (slug, pausedUntil), from the hub process.** A
  notification that repeats itself is one a family turns off, after which the
  next one — which mattered — is gone too. The dedup record is in memory on
  purpose: a flag inside `job.json` would buy every other device a fresh Drive
  mirror for the sake of a notification nobody can see twice.

### Observations
- The review's six confirmed findings were, again, two honest pieces disagreeing:
  a **re-read** that ran out of voice threw the hold away and published those
  pages SILENT into a book that owes no further step — permanently unnarratable;
  an ElevenLabs pause blocked the **reader**, which spends nobody's characters,
  so "Read the photos again" read nothing for a month and said "Read again ✓";
  "Try again now" on a book both paused *and* permanently failed took the failure
  branch alone and re-held at once; the toast dedup forgot a wait the instant a
  scan saw the book un-paused — which is exactly what the retry press writes — so
  the same moment was announced twice; a per-**minute** 429 parks a book for
  seconds and every five-minute scan toasted it; and the Settings fallback for a
  provider-less pause claimed Google, and only for a pause already elapsed.
- The Voice card now says what is left of the month in two units — characters and
  *about* how many picture-book pages — because a parent thinks in books and
  ElevenLabs bills in characters. The line is hidden whenever the hub cannot say:
  no key, no answer yet, provider refused. Nought would be a lie.
- The allowance cache is keyed to the key it was fetched with, so a parent who
  replaces the ElevenLabs key stops reading the previous account's counters.

### Adaptations
- `content-store` gained `unpause()` because there are now two lifters.
- `content-routes` and `era-gate.sh`'s shared hub (whose data dir holds a real
  credential) point `ERA_ELEVEN_URL` at a **closed port**, so no gate run can ask
  a provider anything on the family's key. `book-review-ui`'s stand-in answers
  the subscription poll and counts it apart from the calls that spend.
- `notify.js` uses the one PowerShell shape proven from the production
  console-less hub (`-Command`, `windowsHide`, no double quote anywhere) and
  borrows PowerShell's own AppId, because Windows silently drops a toast from an
  application it does not know. Off Windows it does nothing and says so;
  `ERA_TOAST_CMD` is the seam the suite watches, so a Linux box sees exactly the
  two lines a parent would have been shown. `notify.js` is in
  `tools/build-payload.sh`'s cp list.
- The suite's closing money guardrail now asserts the **key** on every recorded
  call, not merely that some call arrived.

### Verification
`node --test tests/content-allowance.test.mjs tests/book-review-ui.test.mjs
tests/settings-ui.test.mjs tests/content-worker.test.mjs
tests/content-routes.test.mjs` → **121 pass, 0 fail**. `node --check` clean on
every changed file. No test spent a key or touched the network.

### Follow-ups
- **No pause has ever been produced by a real provider.** Every 401 body, the
  `next_character_count_reset_unix` field and the subscription counters are a
  stand-in's, built from documented behaviour; the first real spent month may
  move any of them.
- The toast dedup is per-process: a hub restart re-announces a wait that is still
  in force. Judged the right trade against a Drive-mirrored flag, but it is real.
- Nothing tells a parent when a pause has **ended** — the book simply carries on.
  A "back to work" toast was considered and left out as noise; revisit if dad
  asks where the book went.
- Windows toasts remain untested on Windows (Phase 7, with the kiosk, the real
  keys and a Drive folder mid-sync). All Phase 4/5/6 follow-ups stay open.

### Confidence and risks
Confidence **high** on the refusals and the wording: a spent allowance can no
longer be mistaken for a dead key, the two suites pin the sentence each surface
says, and the review's worst finding — a re-read publishing silent pages into a
book that would never narrate them again — was found and fixed in-phase with a
test. Confidence **medium** on the provider details, which are all a stand-in's,
and on the toast, which no Windows machine has yet raised. Chief residual risk is
Phase 7's unchanged one: none of this has run on the kiosk, on real keys, with
Drive syncing underneath.
