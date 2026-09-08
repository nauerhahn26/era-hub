# Local content pipelines: books, music, movies after install

Date: 2026-09-04. Status: design approved in conversation (dad, 9/4); this is
the written record. Implementation plan follows via `rae-flow:planning`.

## 1. Goals and non-goals

**Goal.** A family that installs New ERA on a Windows device and drops photos
of a picture book into their own Google Drive gets a narrated, word-highlighted
book on every one of their devices — with no developer, no dev-machine script,
no Supabase, no GitHub Actions, and no key of ours. The same holds for adding a
song or a movie: done from the board, by the parent, on the device.

**Principles (all previously ruled, restated so nothing here drifts):**

- **Local-first after install.** Every step runs in the hub (Node 18+ stdlib,
  `server.js`) or in a worker thread beside it. The only network calls are to
  the family's chosen AI providers and to Drive.
- **Bring your own key.** Keys live in `<DATA>/ai-config.json` on the device
  and travel only to the provider that issued them. There is no ERA account, no
  ERA server, no relay.
- **Drive is the family's data store.** Outputs land in the family's
  `New ERA Content/` folder and reach every device through the existing mirror
  (`drive.js`). A book's AI costs are paid once, then shared.
- **No book sharing, ever.** Book packages are photos of copyrighted books plus
  family PII. Nothing in this design moves a package outside the family's Drive
  (D55).
- **Two operators, one contract.** The hub is the default worker. Dad (a power
  user) can point Claude Code at the same Drive folder on a Linux box and let it
  run the same steps by hand — because the contract is files, not an API. Power
  mode is not a second pipeline; it is a second pair of hands on the same
  folder.

**Non-goals.** No cloud queue, no web dashboard, no multi-family anything, no
video editing UI, no ffmpeg dependency, no on-device inference (the Tobii I-13
floor is an i5-7300U with no GPU; all AI stays remote).

## 2. Folder contract (approved 9/4)

```
New ERA Content/
  books/<Title>/                ← parent drops photos here (the inbox)
    IMG_0001.jpg …              ← originals as uploaded (any name, any order)
    .build/job.json             ← claim + state machine (see below)
    .build/text.json            ← page order + transcribed text + flags (interop point)
    .build/log.jsonl            ← one line per step, human-readable
    sources/                    ← originals moved here once claimed
    pages/<n>.jpg               ← downscaled reader images (long edge 2048)
    audio/<n>.mp3               ← ElevenLabs narration per page
    video/<n>.mp4               ← optional fal animation per page
    cover.jpg
    manifest.json               ← written LAST (tmp + rename); its presence = published
  music/
    manifest.json               ← hub-written {schemaVersion 1, songs[...]}
    <slug>.m4a, <slug>.webp     ← audio + thumbnail (no ffmpeg needed)
  movies/
    catalog.json                ← hub-written {schemaVersion 1, titles[...]}
    posters/<slug>.jpg
  clothing/                     ← unchanged (already on these rails)
```

**Rules.**

- **Inbox test.** A `books/<Title>/` folder is an inbox when it contains images
  and no `.build/job.json`. Nothing else is required of the parent.
- **Quiet period.** A folder is only claimed after its listing (names + sizes)
  is unchanged across two consecutive syncs (≥ 10 min). Half-uploaded books do
  not start.
- **Build in place.** Slug = slugified folder name; `booksIndex()`
  (`server.js:411`) gains the same slugify so a folder called `Tabby McTat`
  serves as `/books/tabby-mctat/`. Package layout stays schemaVersion 1
  (`pages[{index,image,text,audio,words,video}]`, `cover`, `narration`), so the
  reader does not change.
- **Claim.** `job.json = {state, claimedBy, heartbeat, startedAt, steps{…},
  errors[]}`. A worker (any hub instance, or Claude Code) claims by writing
  `claimedBy` + `heartbeat`; it refreshes `heartbeat` each step. A claim older
  than 30 min is stale and may be taken over. States:
  `inbox → transcribing → reviewing → narrating → published → animating →
  done`, with `failed` reachable from any step (errors kept, re-runnable).
- **`text.json` is the interop point.** `{pages[{index, source, text,
  flags[{word, reason}], cover:bool}]}`. Everything before it is "get the
  words right"; everything after it is deterministic from it. Power mode
  = Claude Code writes `text.json` by reading the photos itself, then lets
  either operator continue.
- **Publish = `manifest.json` exists.** Written via `manifest.tmp` + rename so a
  device never mirrors a half-written manifest. `sources/` and `.build/` are
  never served (`server.js:434` allowlist gains a deny for those names).

**Mirror changes (`drive.js`).** These fix latent bugs the audit found:

1. `copyTreeLocal` (`drive.js:294`) copies in `readdir` order, so a manifest can
   land before its media. Fix: copy `manifest.json` / `catalog.json` last in
   every directory.
2. `MIRROR_DELETES` (`drive.js:133`) is `['clothing']` only, so a book or song
   removed from Drive lingers on every device. Extend to
   `['clothing','books','music','movies']`.
3. Skip `sources/` and `.build/` on the *serve* side only — they still mirror
   (they are the claim and the interop point; every operator needs them).

## 3. Shared rails: content jobs

Generalize what clothing already proved (`clothing.js`, `clothing-worker.js`):

| Rail | Clothing today | Content jobs |
|---|---|---|
| Trigger | `drive.onSynced` (`server.js:1800`) → `clothing.regenerate` | `drive.onSynced` → `content.scan()` finds inboxes / dirty catalogues |
| Worker | one `worker_threads` worker, one at a time | `content-worker.js`, one job at a time, steps as functions over the folder |
| Status | `GET /clothing/status` (`server.js:1661`) | `GET /content/status` → `{jobs[{kind, slug, state, step, progress, cost, flags}]}` |
| Surfaces | Settings card + board splash + touch-only `#wardrobeNote` | same three, plus the review page (§5) |
| Idempotence | `wardrobe.json` catalogue | `job.json` per book; `manifest.json` / `catalog.json` for music/movies |
| Manual kick | `POST /clothing/regenerate` (`server.js:1654`) | `POST /content/run {kind, slug, step}` (re-run one step, e.g. re-narrate page 7) |

`clothing.js` keeps its own module; it is not rewritten onto the new rails in
this pass (YAGNI), but `content.js` copies its shape so a later merge is
mechanical.

**Keys.** `<DATA>/ai-config.json` today is `{provider, apiKey}` (written by
`POST /ai-key`, `server.js:1633`). It becomes keyed by role, with the old shape
migrated on read:

```json
{ "vision":     { "provider": "google" | "anthropic" | "openai", "apiKey": "…" },
  "elevenlabs": { "apiKey": "…", "voiceId": "…" },
  "fal":        { "apiKey": "…" } }
```

The vision key card and the ElevenLabs card already exist in Settings
(`/ai-key`, `/tts-key` at `server.js:1574`); only the fal card is new. Every
card proves its key with one real call, as `/tts-key` does. Keys are read by
the worker at job start and never logged, never mirrored, never left in
`job.json`.

## 4. Book builder

Steps run by `content-worker.js` over `books/<Title>/`, each idempotent (skips
if its outputs exist and inputs are unchanged):

1. **Ingest.** Move originals to `sources/`; order by EXIF `DateTimeOriginal`,
   falling back to filename; downscale to `pages/<n>.jpg` (long edge 2048,
   EXIF orientation applied) with the pure-JS JPEG path the hub already ships
   for clothing (`clothing-worker.js` `ensureCodecs`/`scaleRgba`/`writeJpg`
   over `vendor/jpeg-js`, orientation from `image-orient.js`), extracted into a
   shared module. No spawn, no native dep, identical on the Linux operator. If
   a decode fails the original is used as the page image and the log says so;
   the vision providers downscale server-side, so transcription never depends
   on this step.
2. **Transcribe → `text.json`.** Per page, one vision call under the
   transcription policy (verbatim printed text, narrative reading order, `...`
   for ellipses, quotes as printed, drop illustration junk and page numbers,
   cover = title/author/illustrator as printed). The model returns
   `{text, uncertain[]}`; `uncertain` becomes `flags`.
   *Which provider and whether a second pass pays for itself is decided by
   data:* `tools/ocr-bakeoff/README.md` is the validation pipe (120 verified
   pages, WER/CER/perfect-page/cost/latency, re-runnable in six months). The
   policy this spec commits to is:
   - default: single pass with the cheapest model the bake-off shows within
     0.1 pp of the best on loose WER;
   - optional agreement pass: a second cheap model; pages where the two
     disagree (loose-normalized) go to the strongest configured model;
   - every page keeps `flags` from the model's own `uncertain` list plus any
     disagreement.
   Free Google keys are rate-limited per day; the worker treats a daily-quota
   429 as "pause until tomorrow" (job stays claimed, `heartbeat` keeps ticking,
   status says so), never as an error.
3. **Narrate → `audio/<n>.mp3` + `words`.** ElevenLabs
   `text-to-speech/{voice}/with-timestamps` returns audio and per-character
   timings in one call; group characters into `words[{word,start,end}]` by
   porting `ellie-this-week/src/ellie/book/audio.py`. This replaces the
   OpenAI-TTS + Whisper pair (D55). Voice comes from the ElevenLabs card.
4. **Publish.** Once every page has text and audio, write `manifest.json` (tmp
   + rename). **Flagged pages publish too** (ruling 9/4: a small mistake is
   tolerable; a book that never appears is not). Flags stay in `text.json` and
   in `/content/status`, and the review page (§5) shows them until a parent
   clears or fixes them. Fixing a page re-runs step 3 for that page and
   re-publishes.
5. **Animate (optional) → `video/<n>.mp4`.** Off by default. Before the first
   fal call the status shows the estimated cost for the book (pages × per-clip
   price from the fal card's probe) and waits for a click on the review page.
   Prompting reuses the proven Kling scripting: style bible once per book,
   action-cam duel template for confrontation pages, standing negative prompt
   (`Book-Reader/docs/book-ingest-policies.md` §"Hero pages",
   `ellie-this-week/src/ellie/book/{animate,prompts}.py`). Re-publish after each
   clip so pages gain video as it arrives.

**Once per family.** Because `pages/`, `audio/`, `video/`, `manifest.json` all
land in Drive, a second device mirrors the finished book and pays nothing.
Only the device that claimed the job spends.

**What each setup gets.**

| Setup | Text | Narration | Video | Cost per 16-page book |
|---|---|---|---|---|
| Free Google AI Studio key only | yes (rate-limited, may span days) | **no** — reader plays silent pages with text | no | $0 |
| Free Google key + ElevenLabs | yes | yes | no | cents (ElevenLabs characters) |
| **Recommended:** paid LLM key (Anthropic/OpenAI/Google paid) + ElevenLabs | yes, same day | yes | optional | cents without video; ≈ $5 with |
| Recommended + fal | yes | yes | yes | ≈ $5 |

"Recommended" is what Settings labels it; nothing is gated. ElevenLabs is
required for narration because it is the only step with no free equivalent that
meets the word-timing bar.

**Design target (dad, 9/4): the family never adds a card to Google.** We design
for row 2 — a *free* Google AI Studio key plus ElevenLabs. Every step that
touches Google must be right on the free tier's shape: 500 requests a day per
model, a pause that ends when the quota does (never a failure), a book that may
take more than one day, and nothing that only works on a paid tier. The Google
credit on the family's test key (9/4, for the same-day E2E runs) is a **testing
convenience, not a product assumption**; a live run that happens to be on the
paid tier proves nothing about the free-tier path, which the tests cover with a
fake 429. When a family is out of allowance the hub says so, in the places they
look, with the two honest choices — wait (it resumes by itself) or add credit
and press *Try again now* — never a quiet stall.

## 5. Review-and-reorder page

The only builder UI. Served by the hub at `/book-review/?slug=…` (a free prefix; `/books/` is the media jail), linked from
the Settings content card and from the board splash when a job finishes with
flags. Mouse/touch only.

- Page strip in current order; drag to reorder; tap to mark the cover.
- Per page: image, text with flagged words highlighted, an inline text field,
  "Re-narrate this page" (re-runs step 3 for one page), "Clear flag".
- Book-level: "Animate this book (≈ $x)" (step 5), "Rebuild text" (step 2 again,
  keeping edits unless the parent unchecks "keep my edits"), "Remove book"
  (deletes the Drive folder; mirror deletes follow).
- Writes go to `text.json` and `job.json`, then `POST /content/run` to
  re-publish. No other editor exists; the old big Next editor retires (D55).

## 6. Music and movies from the board

**Board rule, as amended 9/4.** Grown-up controls may live on the board in a
**touch/click-only partner strip in the header** — the same class as the
touch-only `#wardrobeNote` footer (`era-board/app/index.html:26`). The strip has
no `.dwell` class and no gaze handlers; Ellie cannot reach it by gaze. The door
remains the message bar's only dwell target; the centre cells `[2,2][2,3]`
stay black. The gates `board-input` and `board-pixel` are updated to allow the
strip explicitly (they currently reject any header/bar addition) and must pass
before a board change is called done.

**Strip contents (both recipes).** `+ Add` and `⇅ Arrange`, visible only when
a pointer is present (hover/touch, not gaze).

- **Music (`recipe=songs`, `server.js:519`).** `+ Add` opens a small sheet:
  paste a URL, or type a name and take the first YouTube hit. The hub
  (`POST /music/add {url|query}`) resolves it with `yt-dlp` from the optional
  `media-tools` pack (`packs.js`; ~17 MB, standalone binary, no ffmpeg — m4a
  audio and webp thumbnail are already servable), writes `<slug>.m4a`,
  `<slug>.webp`, appends to `music/manifest.json` (next free `rank`), and the
  tile appears on the next recipe render. Without the pack the sheet says so and
  offers the one-click install. This retires `era-family/tools/add-song.sh` as
  the only writer.
- **Movies (`recipe=movies`, `server.js:617`).** `+ Add` opens the same sheet:
  paste any deep link (Netflix, Disney+, Prime, Apple TV, YouTube) or type a
  name. A name becomes a search whose results appear as a selection grid
  (poster, title, year, "on Netflix / Disney+ / …"); picking one writes a
  `titles[]` entry to `movies/catalog.json` with the deep link and a poster
  fetched from the page's `og:image` or TMDB. The hub still never serves video
  (D57); playback stays with ERAgaze's kiosk Chrome.
- **Arrange.** Drag-and-drop tiles to reorder (writes `rank` / order back to
  the catalogue). Otherwise new items append to the next free tile; page 2+
  follows the existing 9-then-8 layout.

**Streaming availability ("ada twist → on Netflix").** Requirement: given a
title, return where it streams in the family's region with a deep link that
opens the player, from a free or cheap key a parent can obtain in minutes, and
with enough "similar titles" signal to seed the long-term recommendation
engine. **Resolved 9/4** by `docs/research/2026-09-04-streaming-availability.md`:

- **TMDB** (key the family already needs for posters; free) for search, poster,
  `tmdbId`, age certification, and the future recommendation engine
  (`/discover` with `with_watch_providers` + `certification.lte`, and
  `/recommendations` — never `/similar`). TMDB's watch/providers says *where* a
  title streams but gives no deep link, and its JustWatch-sourced data may not
  be cached longer than six months.
- **Watchmode** (free 2,500 req/month, web-form signup, no card) for the deep
  link per service (`web_url`), `us_rating`, and `similar_titles[]` as backup.
  TMDB `provider_id` equals JustWatch/Watchmode `packageId`, so one provider
  table serves both.
- JustWatch's keyless GraphQL has the best data but its ToS forbid this use;
  it stays a developer reference, never the shipped default.
- Fallback without a Watchmode key: TMDB-only ("found on Netflix", no link)
  plus the URL-paste path.

The catalog writer is provider-agnostic behind an `availability` interface and
stores `{title, year, tmdbId?, providerRef?, link, provider, poster, ageRating,
addedBy:'search'|'url', availabilityCheckedAt}`. A background job re-checks
active titles weekly (≈ 10 % of the free Watchmode tier) and marks moved titles
"ask a grown-up" rather than deleting them.

**Long term.** The recommendation engine (not in this spec) runs on these same
rails: a periodic content job that proposes titles/songs into a "suggested"
list the parent approves from the same strip. The catalogue formats above leave
room for `suggested[]` without a schema bump.

## 7. Keys, migration, testing, risks

**Keys and tiers.**

| Role | Provider options | Card | Required for |
|---|---|---|---|
| vision / LLM | Google AI Studio (free default), Anthropic, OpenAI | exists (`/ai-key`) | book text, clothing |
| voice | ElevenLabs | exists (`/tts-key`) | narration |
| video | fal | **new** | optional animation |
| (none) | yt-dlp pack | pack install | music add |
| streaming lookup | TMDB (search, posters, recommendations) + Watchmode (deep links) | new, optional | movie search (URL paste works without them) |

**Migration sequence (ships in this order).**

1. Mirror fixes (manifest-last, deletes for books/music/movies, serve-side deny
   of `sources/` + `.build/`) and `booksIndex` slugify. Zero UI change; the 8
   existing books, 20 songs and the movie catalog are already in package form
   and keep working untouched.
2. Content rails + book builder steps 1–4 (text + narration), Settings content
   card, key roles migration, board splash. First family-buildable book.
3. Review-and-reorder page.
4. Music strip + `media-tools` pack + `/music/add`.
5. Movies strip + catalog writer + poster fetch; availability provider slotted
   in when the research task lands.
6. Animate step (fal card + cost gate).

**Testing.**

- Unit tests per rail with `node:test` (already the hub's pattern): inbox
  detection and quiet period, claim/stale takeover, `text.json` round trip,
  manifest-last copy order, deletes, slugify parity between folder and index,
  word grouping from ElevenLabs timings against a recorded fixture, catalogue
  append/reorder.
- Provider adapters are exercised by the bake-off harness and mocked in unit
  tests; no test spends a key.
- Board gates (`board-input`, `board-pixel`) run on every board change.
- End: front-end QA on the Windows VM per dad's directive — install, drop a
  book into Drive, watch it publish, add a song and a movie from the board with
  a mouse, confirm gaze cannot reach the strip.

**Risks.**

- **Hardware floor.** I-13 has no GPU and a 2C/4T CPU: all AI remote; local
  work limited to the pure-JS JPEG resize (already proven on the I-13 by the
  clothing worker) and file moves. If it proves slow for 24-megapixel photos,
  the reader can serve the originals — nothing downstream depends on `pages/`.
- **Drive write path.** The hub's Drive API mode is read-only (`drive.js:19`,
  `drive.readonly`), so content jobs run only in local mode (Google Drive for
  Desktop mount), building in place inside the mounted folder. API-mode
  building is out of scope; Settings says "needs Google Drive for desktop".
- **Free-tier quotas.** A free Google key transcribes ~20 pages/day/model; the
  worker must pause, not fail, and Settings must say "waiting for tomorrow's
  quota". The bake-off records the exact limits.
- **Unsigned installer / Defender.** Every re-cut of the installer must be
  re-verified via Edge on the VM (FastPath hash flags); adding a pack binary
  (yt-dlp) is a new file to watch.
- **Provider drift.** Models and prices change; the bake-off is re-run every
  six months and the default provider is a config value, not code.
- **Copyright.** Packages never leave the family's Drive; the review page and
  the strip offer no share or export.

---

## 8. Amendment, 9/7: a pile of photos with no folder

Dad, after setting Drive up and going to Ellie's bookshelf: *"I still get to add
books with Google Drive set up in settings when I go to Ellie's bookshelf. But
the piece there, I didn't put into, like, a folder and name it. I think that the
system should be smart enough to say, okay, these all belong to a single book,
because I just uploaded a bunch — you should assume they are, and let me say
otherwise — and then it should build the book and put everything into a single
folder for that book."*

What he actually had in `books/`: **seventeen loose `.HEIC` files**, no
subfolder, all landed within five seconds. Nothing happened, and the Book Reader
told him to go and set up Google Drive.

**Three separate faults, all of which had to be fixed for the pile to become a
book.**

1. **Loose photos were invisible.** `content.scan()` walks
   `books-index.bookDirs()`, which is a list of DIRECTORIES. A file sitting in
   `books/` was in nobody's list, so no folder was an inbox, no job was claimed
   and nothing was ever built.
2. **HEIC was claimed and could not be paged.** `content.photoNames()` uses
   `clothing-photos.EXT`, which has counted `.heic` since 8/31;
   `content-ingest.PAGE_EXTS` was `[".jpg", ".jpeg"]`. So a `books/<Title>/` of
   iPhone photos WAS claimed, a `job.json` WAS written — and ingest then built
   zero pages and walked on. A silent dead end with a card that said it was
   reading the photos.
3. **The empty-shelf prompt was wrong in every state but one.**
   `reader.js` showed "📚 Add books with Google Drive — set it up in Settings"
   whenever `/books/index.json` was empty, including to a family whose Drive was
   set up and whose photos were four minutes from being a book.

### 8.1 The pile is one book

- Photos DIRECTLY in `books/` are one pending book, on the SAME ten-minute quiet
  clock a book folder is on (`content.gatherLoose` → `observe()` over the loose
  listing). Every new arrival resets it, so a phone trickling an album in over
  several minutes lands every photo in the same book.
- `content-gather.gather()` then creates `books/New book <YYYY-MM-DD>` and MOVES
  the pile into it. Rules: a photo is moved, never deleted or converted; the hub
  never creates `books/` itself (the rule `clothing-log.js` keeps for
  `clothing/`); and the target folder is written into `books/.gather.json`
  BEFORE the first file moves, so a hub that dies half way FINISHES that move
  instead of making the eight files still loose into a second book.
  `.gather.json` is a dotfile in the directory `books-index` already keeps
  `.slugs.json` in — copied by the mirror, never pruned.
- The folder is claimed and started in the same scan, so the shelf says
  "building" straight away rather than five minutes later.

### 8.2 The cover names it

- `job.autoTitle: true` is the note that nobody has named this book.
- `content-worker`'s walk, at the top of its loop, once `pages/001.jpg` exists
  (i.e. after ingest, before the transcribe pass that costs pages of a free
  key), calls `content-providers.titleOf()`: ONE call on page 1, the
  transcriber's own ladder and key, the transcriber's own `{"text": …}` output
  contract. No key or a spent allowance are the transcribe step's own two holds
  and are taken as such.
- The worker cannot rename its own folder (`DIR` is fixed for the life of the
  thread), so it parks on `{hold:"needs-title", title}`. `content.js` — which
  knows the thread has exited, because it is holding its exit — renames and
  starts the book again under its real name. `autoTitle` is cleared either way,
  so the question is asked exactly once.
- A title the model cannot give, or one that is not a folder name Windows will
  take (`content-gather.safeTitle`: NTFS characters, reserved device names, a
  trailing dot, a LEADING dot — which would make the finished book invisible to
  `books-index`), keeps the placeholder. That is never a failure.

### 8.3 "…and let me say otherwise"

- `POST /content/rename {kind, slug, title}` — same three guards as
  `/content/remove` (a slug is never a path, not while it is being built, no
  path on the family's disk is ever quoted back). A book already on the shelf is
  re-published so the manifest carries the new title.
- Settings' book card: a plain **✏️ Rename** button and a text box. Touch only,
  no dwell, no confirm dialog. A book the hub named itself says so and says the
  other fix in the same breath: if the pile was really two books, make a folder
  for one of them in Drive.
- Splitting inside the app is NOT built. The honest escape hatch is the folder
  the parent can make in their own Drive, which has always worked; the card
  names it.

### 8.4 iPhone photos

- `content-ingest` pages `.heic`/`.heif` through clothing-worker's decoder
  (`vendor/libheif.js`), which rides in the **board** pack.
- No decoder + HEIC present ⇒ `{hold:"needs-photo-decoder"}`. The whole book
  waits, keeping every photo, rather than building the JPEGs and freezing a book
  with pages missing into the manifest. The card names the fix: tick Clothing
  Picker, or save the photos as JPEG.
- Files nothing can open (PNG, WebP, …) and no pages at all ⇒
  `{hold:"unreadable-photos"}`, never a folder recorded as "built, nothing in
  it".
- A HEIC that will not decode is NOT copied through as its page (the JPEG
  copy-through law does not survive a format no browser and no provider takes):
  it is counted in `lost`, logged, and the rest of the book is built.
- `ingest()` is async from here: libheif answers through a callback.

### 8.5 What the shelf says

`/content/status` gains `loose` (photos with no folder yet), `quietMs` (so no
page hard-codes the ten minutes), `held` (the hold a book is parked on) and
`autoTitle`. The Book Reader's shelf reads the same payload the Settings card
does, so the two can never tell a family two different stories, and shows a
card — not a dwell target, never openable — for every book that is on its way.
The Drive prompt is shown in ONE state: this computer has no Drive folder.
