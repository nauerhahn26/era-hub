# The weekly suite, phase 1 — Watch + Talk + the engine stage — Implementation Plan

> **For agentic workers:** REQUIRED WORKFLOW: subagent-driven development (one fresh-context builder per task, the overseer reviews between tasks) or executing the plan inline. Steps use `- [ ]` checkboxes. TDD on every task: the test is written and SEEN red before the code.

**Goal:** Every week her class's newsletter becomes a "This week" board on her device: a Watch door with three to five downloaded videos that play full screen with the picture, and a Talk door with the week's words she can speak. The weekly-book engine writes the week package on Friday, dad approves it in the mail he already gets, the weekend delivery puts it on Drive, the hubs mirror it and download the videos. An eval script proves the engine stage on weeks the model never saw.

**Architecture:** Four repos, one slug. *Engine* (`ellie-this-week`, private, Python): a new stage `activities` (prompt → the Friday session writes `activities.json` → validate + rubric → write the package) plus strip-first approval phrases, a second rclone delivery to `this-week/<week_of>/`, an eval harness and three golden weeks. *Hub* (`era-hub`): `this-week.js` turns the newest mirrored week into a recipe board (`/recipes/this-week.json`), serves the week folder through the media jail, hosts the `/watch/` player page, and runs a download rail (`this-week-fetch.js`) that pulls each approved video with the media-tools yt-dlp into a local temp folder and moves the finished mp4 into the Drive folder for every device. *Board* (`era-board`): a `video` tile type that launches the hub's player through ERAgaze watch mode and logs to `/log`. *Engine on the device* (`era-gaze`): return-to-picker recognises the hub's own kiosk so the end of a video lands her back on the board.

**Tech stack:** Node 22 hub (no deps), plain browser JS, node:test + Playwright from `~/new-era/node_modules`; Python 3.12 + pydantic 2 + pytest under `uv` in the engine (no new deps; no network in the engine); C# `ERAgaze.cs` compiled on the device (no compiler on the build box); yt-dlp pinned by `tools/yt-dlp.pin`.

**Spec:** `docs/specs/2026-10-12-weekly-suite-design.md` (commit `1083ead`, dad-approved 10/12). Phase 1 = spec §11 row 1. Play (§5) and the Sunday note (§8) are later plans; the package schema already carries `play` so golden sets can be written at the bar now (§5.3) and the hub ignores it.

**Worktrees (all open, all on `feat/youtube-videos`):** `~/new-era/era-hub--wt-youtube-videos` (this file), `~/new-era/era-board--wt-youtube-videos`, `~/ellie-this-week--wt-youtube-videos`. era-gaze has no feature worktrees in the gate (`era-gate.sh:18`); its one change is made in a plain `git worktree add ~/new-era/era-gaze--wt-youtube-videos -b feat/youtube-videos` and fast-forwarded into era-gaze master by the overseer after review. Never edit any main checkout. Gate and scratch hubs need `ERA_WT_SUFFIX=--wt-youtube-videos` (the hub's `public/board` symlink points at era-board MASTER until `assemble.sh` re-links it).

**Discipline:** TDD every task. A fresh builder per task. No "while I'm here". STOP and report instead of improvising when: a test outside this plan starts failing; an assertion would have to be weakened; a change would touch `public/dwell.js`, `public/lib/*` (era-core's files, mirrored), TD Snap, or the hub's `/movie-event`; the gaze change needs more than the three edits in G1; a yt-dlp flag that needs ffmpeg looks necessary; the engine would need a network call; a new dependency looks necessary.

**Commits:** house style `this-week: <what> — <why> (spec 2026-10-12 §N)` in the hub and board, `activities: <what> — <why>` in the engine, `gaze: <what> — <why>` in era-gaze; add your session's attribution trailers. `git add` exact paths, never `-A`. The pre-commit era-scan runs in the public repos: no family names but Ellie, no infra terms, no IPs but loopback, no school, teacher, town or classmate names. Fixtures use a fake week (`2026-01-05`, topic "shadows") and ids like `aBcDeFgHiJk`; a classmate or hero name from a real newsletter never enters a public repo. The engine repo is private: real weeks are fine there, but still by role.

---

## Spec deviations (each is the nearest faithful thing; reason given)

1. **No title row.** `board.name` is never rendered and the message bar may hold only 🚪 and 💬 (ux-contract §B; `board-pixel` `barExtras`). The root board carries `say_on_load: "This week: <title>"` instead, as the outfit board voices itself; the title is also the Watch grid's `name` so the ETag poll and logs name the week.
2. **A Talk page holds 8 words, not 12.** Back [1,1], More [3,1] and the black centre leave 8 seats. Talk pages overflow through More; the manifest orders words, the hub pages them 8 at a time.
3. **Play's door is not on the phase-1 board.** No `link` tile type is added until Play exists (phase 2). The root has Watch [1,1], Talk [1,4], everything else black.
4. **Video pictures are glyphs and symbols, not files.** At §5c the week's book does not exist yet (§6–§7 run later), and the engine has no symbol code. Talk tiles are `{type:"word", label, say, glyph}` (one emoji grapheme) or `{..., symbol}` (an ARASAAC name the hub already serves at `/symbol/<name>`). No `talk/*.png` in phase 1.
5. **Downloads stage in `<DATA>/this-week/.tmp/`, not in the Drive folder.** `copyTreeLocal` copies dotfiles and `pruneTree` never deletes them, and Drive would re-upload a growing partial. Only the finished mp4 and thumbnail move into the Drive week folder (`drive.atomically`). The "someone is on it" signal is a small `claim-<id>.json` in the Drive week folder (the `content.js` `job.json` precedent).
6. **`DEVICE_ID`, never the hostname** (two PCs can share a hostname; `content.js:111`). Claims and later logs are keyed by `DEVICE_ID`.
7. **The recipe ETag covers the files.** Manifest mtime+size+REV alone would leave a "not here yet" tile cached after the mp4 lands; the ETag adds each video's `ready` state (size > 0; Drive drops zero-byte placeholders first).
8. **Expect 360p.** Without ffmpeg the only single-file mp4 YouTube reliably offers is format 18 (360p). Format string `b[ext=mp4][height<=720]/b[ext=mp4]/18`; anything that is not `.mp4` is refused. The chosen height is recorded in status so dad can see it. Shipping ffmpeg in the media-tools pack is a follow-up for dad, not this plan.
9. **The thumbnail may be `.webp`**; the hub accepts `.webp .jpg .jpeg .png` like `COVER_EXT`.
10. **The engine does no network.** The Friday session confirms each video through YouTube oEmbed with `curl` (the exact command is in the prompt) and writes the answer into `activities.json`; the engine checks the shape (`oembed.title`, `oembed.author_name`, `oembed.thumbnail_url` present). Duration is checked on the device before download (`--dump-single-json`, cap 15 min).
11. **The approval phrases are strip-first side words**, like `hero yes` (`approval.py:329`): removed before the book words are matched, recorded separately, printed as a third stdout line. Otherwise every phrase would turn the reply into `feedback` or hold the book. The id in `swap video N for <url|id>` is read from the original-case text.
12. **Activities have their own state file**, `weeks/<w>/activities-state.json`, because the week's one `status` is the book's. `activities go` after the book shipped cannot be heard by the weekend cron (`approval.sh` excludes delivered weeks); the interactive runbook gives dad's helper the hand command (`deliver-activities`).
13. **The mail section comes from one sanctioned file.** Friday §8 forbids reading anything but the five `preview` keys; §9 gains one step that pastes `weeks/<w>/activities-summary.txt` verbatim (written by the `activities` stage). `selfcheck.sh` is amended only if check 10 trips on it.
14. **Fallback briefs still get a week.** `_write_recipe` writes an empty `coming_week` on a fallback (10/12 did), so the stage parses the digest itself (`latest_digest` + `parse_coming_week`) and the rubric scores against that.
15. **The watch page takes `?w=<week_of>&v=<id>`** so the hub never has to guess which week a video belongs to.
16. **Release shape is signed** (`v0.39.0`): a new installer Section is required for a core app (`packs.test.mjs:214-228`).
17. **The gaze fix is a bug fix, not a feature.** The reason string in the code is `exit-to-picker`; the picker search just never knew the hub's kiosk profile. `--hide-crash-restore-bubble` joins the spawn because the kiosk is always killed hard.
18. **Play items in the schema, rubric and golden sets now; the hub ignores `play`** until phase 2. Dad calibrates the difficulty bar on the golden sets early.

## Preflight (verified 10/12 against hub `1083ead`, board `2b659db`, engine `8f74e42`, gaze `484beda`; line numbers are anchors — grep the quoted identifier if they drifted)

| Fact | Where |
|---|---|
| `MIRROR_SUBDIRS` / `MIRROR_DELETES` / `ADOPT_ON_FIRST_SYNC` / `MANIFEST_NAMES` / `BYTE_COMPARE` | `drive.js:40, 190, 212, 293, 312` |
| `isBookManifest` holds back any `manifest.json` naming `cover` / `pages[].image|audio|video` until those files exist — the week manifest must not use those keys | `drive.js:333-356, 651-655` |
| `onSynced` runs synchronously inside sync (`drive.sync()` from it returns `busy`); server chain `drive.onSynced = () => { clothing.tick; content.tick }` | `drive.js:673, 425`; `server.js:3630-3651` |
| `drive.atomically(dest, write)`, `drive.localFolder()`, narrow mirrors `mirrorBook` / `mirrorDrawing` (no prune, no onSynced) — `mirrorWeek` copies their shape | `drive.js:383-387, 88-93, 695-720, 749-767` |
| `drive-mirror.test.mjs:202-203` pins the seven content keys | must gain `this-week` |
| `serveMediaJail(req,res,jailDir,rest,allowedExts,avExts,denyDirs,resolveDir,cacheControl)`; `avExts` get range requests; `.json` no-cache | `server.js:688-756`, example `:2306-2307` |
| `MIME` has `.mp4`, `.webp`, `.jpg`, `.json` | `server.js:1262-1268` |
| `moviesRecipe()` output `{recipe:{locale,root,home_label,boards:[{id,name,rows:3,columns:4,buttons}]}, etag}`; Back `{label:"Back",say:"back",type:"back",glyph:"←",load,row:1,col:1}`; More `{label:"More",type:"control",symbol:"more",load,row:3,col:1}`; `show` door `{type:"show",board}`; (2,2)(2,3) unpinned = black; valid-empty degrade in `serveMoviesRecipe` | `server.js:935-1090` |
| Recipe routes are one explicit `if` per name; unknown → static 404 | `server.js:2037-2045` |
| `/log` 64 KB JSON → `LOGS/<day>.jsonl` + `pool.append("app-log")`, 204 | `server.js:2006-2018` |
| `/movie-event` 400 unless service ∈ disney/netflix/prime | `server.js:1984-1992` |
| Settings: `GET /settings` defaults `:1596-1611`; `POST /settings` field-by-field `:1671-1730` (`exitTo` at `:1685`); readers re-read the file (`exitTarget()` `:1421`); UI `seg("exitTo","exit",…)` `settings/index.html:319-327, 645-670`; test `routes.test.mjs:108-118` (8409), `settings-ui.test.mjs` (8475) | — |
| `APPS` `:120-134`; `/apps` `:2606`; `appIcon` reads `public/icons/<id>.png|.ico` `:523`; home tiles `public/home/index.html:91-113` (no `installed` check; music/movies empty-state wording only); `apps.json` filter `:213-222` → a new app is OFF on existing devices until toggled | — |
| `icons.test.mjs:19-32` requires a real `.ico` + `.png` > 1000 B; `packs.test.mjs:214-228` requires an installer `Section "<Title>" Sec<X>` + a `-writeApps` line in APPS order | `tools/installer.nsi:98-154` |
| `build-payload.sh`: explicit module list `:30, 38-41`; explicit `public/` dirs `:117-129`; `vendor/yt-dlp` from `era-family/cache` after a sha check `:78-100`; ERAgaze.cs copied `:114` | — |
| `music-add.js`: `running`/`last` state `:65-66`; `tool()` with `ERA_YTDLP` / `ERA_PACK_ROOT` `:74-81`; `run()` argv, `KILL_MS` 10 min `:63, 93-111`; lookup args `:196-206`; download args `:208-215`; staging `"."+slug+".add"` + `sweep` + `pickExt` `:227-253, 334-353`; writes only to `drive.status().folderPath + "/music"` in local mode `:85-89`; `status()` `:504-511`; test `music-add.test.mjs:29-125` (8436) with the fake `yt-dlp` Node script driven by `FAKE_YTDLP_CTL` and `ERA_DRIVE_LOCAL_ROOTS` | — |
| `packs.js`: `"media-tools": ["vendor/yt-dlp"]` `:26`; `ytDlp(root)` → `{bin, args:["--js-runtimes","node:"+process.execPath]}` `:43-60`; installed on demand via `POST /packs/install` `server.js:2654-2688`; installer section `/o` (off) | — |
| `pool.append(kind,obj)` adds `{t, device, kind}`; `DEVICE_ID` slug `server.js:81`; `DATA` `:38`; `LOGS` `:39` | — |
| Board: `onTile` branches `board-render.js:693-739`; `LAUNCH_TYPES` `:114`; `launchMovie` `:621-642` (absolute url required by the engine; no Content-Type → simple CORS request); `postMovieEvent` `:541-550`; `launchKey`/`movieEls`/`applyWatching` `:530-537, 789-797`; `isPhoto` `:157-165`; `imageSrc` root-relative `:143-151`; glyph path `:340-360`; word tiles speak via `session.activate` → `say ?? label` (`board-model.js:87-101`) | — |
| Board: `RECIPE_NAME` regex already admits `this-week` `board.js:56-61`; `hasTiles` splash is `movies`-only `:100`; partner strip `songs|movies` only `board-partner.js:579-581`; lock `MEDIA_TYPES` `board-lock.js:55`; `launchWarn` text is movie-worded `index.html:30` | — |
| Board tests: browser suites hard-code `localhost:8377`, the gate rewrites to its port and copies every repo's `tests/*` FLAT (unique names!); stubs `**/log` 204; `window.__speechLog`; pixel audit states are `today`'s only (`board-pixel.test.mjs:30-44`) | `era-gate.sh:136-148` |
| Free test ports across all five repos: **8427, 8456, 8457** only (8481-8498 scratch, 8500+ tunnels) | grep 10/12 |
| Gaze: `/app/launch` reads `url, watch, titleId, profile, next.url/label`; url must be http(s), no `"`/space; replies 200 before spawning; CORS `*` | `ERAgaze.cs:741-793` |
| Gaze spawn flags `--force-device-scale-factor=1 --no-first-run --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --kiosk --user-data-dir=<StreamingDir>` (no `--hide-crash-restore-bubble`) | `ERAgaze.cs:1563-1580` |
| Gaze strip: exit → `EndAndClose(true,"exit-to-picker")`; pause = `VK_MEDIA_PLAY_PAUSE` via SendInput (media session, not space); louder/softer = Windows master volume | `ERAgaze.cs:1221-1245` |
| `/app/watch-end {reason?}` → `EndAndClose` → kills the streaming profile's chrome → `ForegroundPickerKiosk` matches only command lines with `ERAgaze|RaeGaze` + `-profile`; else `ExitKiosks()` kills every `kiosk-profile` chrome/msedge (the hub's board!) and foregrounds TD Snap | `ERAgaze.cs:814-840, 1077-1082, 1511-1524, 1586-1611` |
| Hub board kiosk = `--user-data-dir="%~dp0data\kiosk-profile"`, Chrome preferred, Edge fallback | `tools/build-payload.sh:187-190, 222` |
| Hub recompiles the engine when `ERAgaze.cs`'s sha differs from `ERAgaze.exe.src-sha256` (boot pass) | `server.js:158-166, 236-251` |
| Tile launchers: `Drawing.bat` ≡ `EllieMovies.bat` but for the comment and `set OPEN=` | `aac-board-builder/tools/tile-launchers/` |
| Engine: argparse `_parser()` + hand-kept metavar `orchestrate.py:1333-1363`; `_main` dispatch chain `:1548-1589`; `brief` always exits 0, fallback warning on stderr `:662-668`; `_write_recipe` empties `coming_week` on fallback `:421-431`; optional-file pattern `_read_hero_card` `:210-250`; `KEPT_NOTES` `:1204-1214` | — |
| Engine: `ComingWeek{hero,science,social_studies,phonics,writing,math,also}` + `named_items()` `signal/newsletter.py:115-147`; `latest_digest` `recipe.py:168`, `parse_coming_week` `:273`; `pick_theme` raises with no hero/science `:53-79` | — |
| Engine: `EngineConfig` and sub-tables `extra="forbid"` `config.py:121-160`; tests load the REAL `config/engine.toml` | — |
| Engine: `_APPROVE_WORDS` / `_HOLD_WORDS` / `_HERO_RE` strip-first + `record_hero_yes` + 2nd stdout line `approval.py:310-357, 386-409, 691-735`; `orchestrate.py:1845-1847`; `decide` `:471-556`; `tier()` any leftover word → `feedback` | — |
| Engine: feedback `Step` union + `_shape_refusal` ("approve combines with nothing but remember") `feedback.py:83-140, 216-233`; `STASH_GLOBS` `:63-76`; `load_denylist` `:163-190` | — |
| Engine: `deliver.py` `REMOTE="family-drive"`, `BOOKS_ROOT="New ERA Content/books"`, `book_dest` refuses non-books, two-pass rclone, `_already_there` no-op, `Runner` injection, tests with `CompletedProcess` fakes | `deliver.py:62-70, 115-138, 213-284`; `tests/book/test_deliver.py:100-106` |
| Engine: statuses lowercase in `publish.py:30-46`; `approval.sh` PENDING = awaiting-approval/approved/redo/asked; the approval REQUEST mail is Friday §9 (`friday-task.md:695-800`); §8 "five keys are the whole mail"; §5b ends line 278, §6 starts 280 (§5c at 279); `selfcheck.sh` check 10 (json blocks), 11 ("stop"/"exit" in any `##` that runs orchestrate), 11c (seven first lines) `:232-365` | — |
| Engine: `friday.sh` `ai-run --tier agent --tools …`, 7200 s, `ELLIE_WEEK_OF` refused on the main checkout; `ELLIE_STORY_ONLY=1` stops after §6 | `friday.sh:59-96, 206-291` |
| Engine: weeks on disk — 09-07, 09-14, 10-05 tracked; 09-21, 09-28, 10-12 UNTRACKED (all have `inbox.json`); 08-21/08-28 exist only as `tests/fixtures/newsletters/*` single `RawEmail` fixtures; 10-12's `recipe.json` is a fallback with 4 parsed slots | probe 10/12 |
| Engine: `config/interests.yaml` `core` = I, see, like, want, more, go, stop, help, friend, happy; `config/approved-books.md` is the allowlist model; pytest 1099 passed on master | — |
| No C# compiler on the build box (`mcs`/`csc`/`dotnet`/`mono` absent); the VM legs and the devices compile | `which` 10/12 |

## Global constraints

- Laws: D4 text first, D5 yes/no corners (unused here), D18 never a test, D26 fixed seats, D56 (amended: no YouTube at runtime, downloaded video with picture), D57a learning-forward, ux-contract §B board layout (centre black, Back [1,1], More [3,1], bar = 🚪💬 only), ≥32 pt text, dwell 1200 default.
- The hub never contacts YouTube except through the media-tools yt-dlp on a device whose switch is on. The engine never contacts the network. The build box never downloads media.
- No new dependencies anywhere. No ffmpeg. No edits to era-core files mirrored into the hub (`public/dwell.js`, `public/lib/*`, `public/speech.js`).
- `manifest.json` in the week folder never uses the keys `cover` or `pages`.
- Any test spawning a hub uses only 8427, 8456, 8457. Test files have unique names across all five repos.

## Review focus (what the overseer checks between tasks)

Never-a-test (no score, no "wrong"); the two-dwell / fixed-seat laws on every new board; path jails (`..`, `\0`, outside-jail, wrong ext); the fetch rail's refusal ladder (switch off, pack missing, folder missing, claim fresh, too long, not mp4, zero bytes); the ETag changes when a file lands; the approval phrases never change the book's verdict; the engine stays network-free; nothing private in the public repos.

## Definitions (every task uses these names and numbers)

### Files

Hub (`era-hub--wt-youtube-videos`): `this-week.js` (recipe + manifest validation + status, pure, exported for in-process tests), `this-week-fetch.js` (the rail), `public/watch/index.html` + `public/watch/watch.js`, `public/icons/this-week.png` + `.ico`, `docs/this-week.md`, tests `tests/this-week-recipe.test.mjs` (in-process + hub on **8456**), `tests/this-week-fetch.test.mjs` (**8457**), `tests/watch-ui.test.mjs` (**8427**). Edits: `server.js`, `drive.js`, `movies-add.js` (comment), `public/settings/index.html`, `public/home/index.html`, `tools/build-payload.sh`, `tools/installer.nsi`, `tests/drive-mirror.test.mjs`, `tests/routes.test.mjs`, `tests/packs.test.mjs` (only if its generic checks need the new app listed).

Board (`era-board--wt-youtube-videos`): `app/board-render.js`, `app/board.js`, `app/board-lock.js`, `app/index.html` (banner text), test `tests/board-this-week.test.mjs`.

Gaze (`era-gaze--wt-youtube-videos`): `device/ERAgaze.cs` only.

Engine (`ellie-this-week--wt-youtube-videos`): `src/ellie/activities/__init__.py`, `schema.py`, `rubric.py`, `package.py`, `prompt.py`, `approval.py`, `deliver.py`; `config/engine.toml` `[activities]` + `config.py` model; `config/video-channels.md`; `runner/friday-task.md` §5c + §9 step; `runner/approval-task.md` §4 + §5b′ + §6; `runner/feedback-task.md` note; `runner/weekly-task.md` hand command; `runner/activities-eval-task.md`; `tools/eval-activities.sh`; `eval/golden/<week_of>/activities.json` ×3; tests `tests/activities/test_schema.py`, `test_rubric.py`, `test_package.py`, `test_approval_phrases.py`, `test_deliver_week.py`, `test_eval_fixtures.py`.

Launcher (`aac-board-builder/tools/tile-launchers/ThisWeek.bat`): `EllieMovies.bat` with `ThisWeek -> /board/?recipe=this-week` and `set OPEN=/board/?recipe=this-week`, LF endings.

### `activities.json` (the session writes it; `schema.py` is the law, pydantic, `extra="forbid"`)

```json
{
  "week_of": "2026-01-05",
  "title": "Shadows!",
  "topic": {"science": "light and shadows", "social_studies": "our special place",
            "phonics": "short e", "math": "make ten", "hero": null},
  "watch": [
    {"id": "aBcDeFgHiJk", "title": "Light and Shadows for Kids", "channel": "Homeschool Pop",
     "minutes": 6, "why": "a presenter shows shadows change with the lamp",
     "oembed": {"title": "Light and Shadows for Kids", "author_name": "Homeschool Pop",
                "thumbnail_url": "https://i.ytimg.com/vi/aBcDeFgHiJk/hqdefault.jpg"},
     "before": null}
  ],
  "talk": [
    {"word": "shadow", "say": "shadow", "group": "science", "glyph": "🌑"},
    {"word": "more", "say": "more", "group": "core", "symbol": "more"}
  ],
  "play": {
    "which": [{"id": "w1", "skill": "predict", "q": "Move the lamp closer. Does the shadow get bigger or smaller?",
               "choices": [{"label": "bigger", "glyph": "🐘", "sound": "whoosh-up", "right": true},
                           {"label": "smaller", "glyph": "🐜", "sound": "whoosh-down"}]}],
    "sort": {"bins": [{"label": "makes its own light", "glyph": "💡"}, {"label": "needs light to be seen", "glyph": "🌙"}],
             "skill": "classify",
             "items": [{"label": "the sun", "glyph": "☀️", "bin": 0}, {"label": "the moon", "glyph": "🌙", "bin": 1}]},
    "playit": {"instrument": "shadow-puppet", "q": "Which way do you move the puppet to make the shadow tall?", "answer": 0}
  }
}
```

Rules (`schema.py`): `week_of` ISO Monday; `title` ≤ 24 chars; `watch` 3–5 items, `id` `^[A-Za-z0-9_-]{11}$`, `minutes` 1–15, `oembed` present with the three fields, `channel` a string; `talk` 6–16 items, `word` ≤ 16 chars, exactly one of `glyph` (one emoji grapheme: a single extended grapheme cluster whose first code point is in the emoji ranges) or `symbol` (`^[a-z0-9-]{1,32}$`), `group` ∈ science/social_studies/hero/describing/core; `play.which` 0–10 items, 2–3 choices, exactly one `right`, `skill` ∈ predict/compare/cause/classify/sequence/true-false/count/add/subtract/decode/rhyme/vocabulary; `play.sort` 2 bins and 4–10 items each pointing at a bin; `play.playit.instrument` ∈ harmonica/xylophone/string-telephone/shadow-puppet (the phase-2 app ships exactly these); `play` as a whole optional. `before` on a video is one `which` item or null.

### `manifest.json` (the package, written by `package.py`; the hub reads it)

`activities.json` plus `"approved": <ISO datetime>` and `"schema": 1`, nothing removed. The hub validates again on read (same rules, in JS) and drops any item that fails, never the page.

### The week folder on Drive (`New ERA Content/this-week/<week_of>/`)

`manifest.json` (written LAST), `<id>.mp4` + `<id>.<webp|jpg|jpeg|png>` (by a hub), `claim-<id>.json` `{device, started}` (by a hub, deleted when done). Mirrored to `<DATA>/this-week/<week_of>/`. The hub reads the newest `<week_of>` folder that holds a parseable manifest.

### The recipe (`this-week.js` → `/recipes/this-week.json`), 3×4, cell contract

- `root` board `this-week`: `name: <title>`, `say_on_load: "This week: <title>"` on the first button; **Watch** `{type:"show", board:"watch", label:"Watch", say:"watch", glyph:"🎬", row:1, col:1}`; **Talk** `{type:"show", board:"talk-1", label:"Talk", say:"talk", glyph:"💬", row:1, col:4}`; nothing else (black).
- `watch` board: Back [1,1] (`load:"this-week"`), videos in seats `[1,2] [1,3] [1,4] [2,1] [2,4]` in manifest order. Ready video: `{type:"video", id, week_of, label:<title>, image:"this-week/<week_of>/<id>.<ext>", row, col}`. Not ready: `{type:"word", label:<title>, say:"not here yet", glyph:"⏳", row, col}`.
- `talk-N` boards (N from 1): Back [1,1] → `this-week`; words 8 per page in seats `[1,2] [1,3] [1,4] [2,1] [2,4] [3,2] [3,3] [3,4]`, manifest order; More [3,1] → `talk-N+1` when another page exists. Word cell `{type:"word", label:<word>, say:<say>, glyph|symbol, row, col}`.
- ETag: `"<manifest mtime>-<size>-<ready bits as a hex string in watch order>-r<THIS_WEEK_REV>"`, `THIS_WEEK_REV = 1`. No week on disk → a valid board with the root only and `etag "none-r1"`; a broken manifest → the same with `"err-<Date.now()>"` (as `serveMoviesRecipe`).
- `GET /this-week/status` (no-store): `{week_of|null, switch:bool, pack:{id:"media-tools",installed}, folder:bool, running:{id,phase}|null, videos:{<id>:{state, height?, error?}}}` with `state` ∈ `ready|coming|claimed|too-long|not-mp4|failed|pack-missing|switch-off|no-folder`.

### The download rail (`this-week-fetch.js`)

Trigger: `drive.onSynced` (appended to the chain) and a 20-minute timer. `tick()`: if `settings.downloadWeekVideos !== true` → every missing video `switch-off`, stop. If `!tool()` → `pack-missing`. If `!drive.localFolder()` → `no-folder`. Newest week; for each `watch[].id` in order with no `ready` mp4 in the Drive week folder: skip if a `claim-<id>.json` by another device is < 30 min old (`claimed`); else run ONE job (`running`), sequentially:

1. write `claim-<id>.json` `{device: DEVICE_ID, started}` via `drive.atomically`;
2. lookup: `[...t.args, "--no-playlist", "--no-warnings", "--skip-download", "--dump-single-json", "https://www.youtube.com/watch?v=<id>"]` → `duration` > 900 s → `too-long`, delete claim, next;
3. download into `<DATA>/this-week/.tmp/<id>/`: `[...t.args, "--no-playlist", "--no-warnings", "--no-progress", "--retries", "3", "-f", "b[ext=mp4][height<=720]/b[ext=mp4]/18", "--write-thumbnail", "-o", "<tmp>/<id>.%(ext)s", "https://www.youtube.com/watch?v=<id>"]`, `KILL_MS` 20 min;
4. the result must be `<id>.mp4` with size > 0 (else `not-mp4` / `failed`); thumbnail = first of `.webp .jpg .jpeg .png`;
5. move both into the Drive week folder with `drive.atomically` (copy then rename; the tmp dir is removed), delete the claim, `drive.mirrorWeek(week_of)`, record `height` from the JSON (`height` of the chosen format when present);
6. `pool.append("this-week-fetch", {id, state, height, ms})`.

Any failure sets `videos[id].state` + `error` (OwnWords-style plain message), deletes the claim, and the rail moves on; a later tick retries `failed` once per hour at most. `ERA_YTDLP` and `ERA_PACK_ROOT` seams exactly as music-add.

### The watch page (`/watch/?w=<week_of>&v=<id>`)

Black page, one `<video autoplay playsinline>` sized 100vw×100vh (`object-fit: contain`), `src="/this-week/<w>/<v>.mp4"`; both params validated (`^\d{4}-\d{2}-\d{2}$`, the id regex) else a blank page that posts `watch-end` after 1 s. `navigator.mediaSession.setActionHandler("play"/"pause")` → `video.play()/pause()`. On `ended` or `error`: `fetch("/log", {method:"POST", headers:{"Content-Type":"application/json"}, body: {app:"this-week", door:"watch", week_of, id, event:"ended"|"error", ms:<played ms>}, keepalive:true})` then `fetch("http://127.0.0.1:49155/app/watch-end", {method:"POST", body: JSON.stringify({reason:"video-ended"})})` (no headers). Nothing else on the page; no `requestFullscreen`.

### Board additions (`board-render.js`)

`video` tile: painted like a photo tile (thumbnail fills, plate carries the label) — `isPhoto` returns true when `btn.type === "video"`; one look → `launchVideo(btn, el)`: `fetch("http://127.0.0.1:49155/app/launch", {method:"POST", body: JSON.stringify({url: location.origin + "/watch/?w=" + btn.week_of + "&v=" + btn.id, watch: true}), signal: AbortSignal.timeout(4000)})`; on ok → marker `.watching` keyed `"video:" + id` and `fetch("/log", …{app:"this-week", door:"watch", week_of, id, event:"launch"})`; on failure → `.launch-failed` 2 s + `#launchWarn` (its text made generic: "Not now — try again in a moment"). `video` joins the media-lock refusal in `onTile` AND `MEDIA_TYPES` in `board-lock.js` (a lock taken on Movies dims videos here too). `board.js`: the `hasTiles` empty-state splash also fires for `this-week` with the words "Nothing this week yet".

### Settings

Key `downloadWeekVideos` (boolean, default `true`) in `GET /settings` defaults; `POST /settings` accepts `typeof === "boolean"`; a `seg` card "This device downloads the week's videos" with Yes / No in `settings/index.html`, painted like `exitTo`.

### Engine stdout and phrases

`python -m ellie.orchestrate approval …` prints line 1 (the seven existing), line 2 (hero), **line 3**: `activities: approved` | `activities: held` | `activities: edited <op>[; <op>]` | `activities: none` (no package this week). Phrases, each stripped first with a case-insensitive regex over the quote-stripped reply and recorded in `activities-state.json`:

| phrase | regex (over lowercased text; the url/id is taken from the original) | effect |
|---|---|---|
| `hold activities` | `\bhold\s+activit(y|ies)\b` | state `held`; the book's verdict is unaffected |
| `activities go` | `\bactivit(y|ies)\s+go\b` | state `approved` (only heard while the week is still pending) |
| `no video N` / `drop video N` | `\b(no|drop)\s+video\s+(\d)\b` | remove `watch[N-1]` (1-based, the mail's numbering) |
| `drop game N` | `\bdrop\s+game\s+(\d)\b` | remove `play.which[N-1]` |
| `swap video N for <url or id>` | `\bswap\s+video\s+(\d)\s+for\s+(\S+)` | replace `watch[N-1].id` with the id parsed from the url (`v=`, `youtu.be/`, or a bare id); the item's `oembed` is cleared and the manifest marks it `unconfirmed: true` (the hub still downloads it; the mail's next week notes it) |
| `snap yes` | `\bsnap\s+yes\b` | state note `snap: yes` (a human session promotes Talk, §4.3) |

Bare approve/hold words still decide the book exactly as today; `approve` with no activity phrase also approves the package. After edits, the engine re-runs validation + rubric on the edited `activities.json` and rewrites the package; a package that fails validation after an edit is `held` with the reason in `activities-state.json`.

### Eval

`tools/eval-activities.sh <week_of>|fixture:<name>` → `runs/eval/<week_of>/`: copies `weeks/<w>/inbox.json` (or wraps `tests/fixtures/newsletters/<name>` as `[digest]`), runs `brief` there, then `ai-run --tier agent --tools Bash,Read,Write,WebSearch,WebFetch` on `runner/activities-eval-task.md` (= §5c alone, parameterised by `ELLIE_WEEK_DIR`), then `activities` with `--rubric-report`, and prints the scorecard; exit 1 on any automatable fail. Never writes under `weeks/`. Golden weeks: `eval/golden/2026-09-14`, `2026-09-28`, `2026-10-05` (`activities.json` each); held out: `2026-09-07`, `2026-09-21`, `2026-10-12`, `fixture:2026-08-21-braille`, `fixture:2026-08-28-…` (names as in `tests/fixtures/newsletters/`).

Automatable rubric lines (`rubric.py`, each `pass|fail` with a reason): (1) every `watch`/`talk`/`play` item names ≥ 1 concept from the week (`ComingWeek.named_items()` parsed from the digest, plus the title); (2) no concept from a denylisted or non-week source (the family constraints in `config/family.md` as a term list: Christmas, Easter, Santa… — the builder derives the list from the file's own words); (3) `vocabulary` ≤ 1 per `which` set; (4) ≥ 1 `decode|rhyme` and ≥ 1 `count|add|subtract` item when `phonics`/`math` are named; (5) 2–3 choices, exactly one right; (6) 3–5 videos, every channel in `config/video-channels.md` or the item carries `"off_allowlist": true`; (7) `oembed.title` present for every video; (8) `talk` has ≥ 2 `science` (or `social_studies` when science is empty) words and ≥ 2 `core`; (9) a fallback brief (`recipe.json` `source == "fallback"`) is named in `activities-summary.txt`.

### Ports and test names

Hub 8456 (`this-week-recipe`), 8457 (`this-week-fetch`), 8427 (`watch-ui`); board `board-this-week` through the gate hub; engine pytest needs none.

## How to run things

```bash
# hub unit + ui suites, in the worktree (node_modules resolve from ~/new-era)
cd ~/new-era/era-hub--wt-youtube-videos && node --test tests/this-week-recipe.test.mjs
# the board suite ONLY through the gate (a bare run tests master's front end)
cd ~/new-era/era-hub--wt-youtube-videos && ERA_WT_SUFFIX=--wt-youtube-videos bash tools/era-gate.sh
# a scratch hub over the worktree board (port from the 8481-8498 band)
ERA_WT_SUFFIX=--wt-youtube-videos bash tools/assemble.sh && ERA_DATA_DIR=<scratch>/tw-data ERA_TEST_PORT=8481 node server.js
# engine
cd ~/ellie-this-week--wt-youtube-videos && uv run pytest -q && bash runner/selfcheck.sh
uv run python -m ellie.orchestrate activities-prompt weeks/2026-10-05 --config config/engine.toml
uv run python -m ellie.orchestrate activities weeks/2026-10-05 --config config/engine.toml --rubric-report
bash tools/eval-activities.sh 2026-09-21
```

---

## Task skeleton

Phases A (engine) and B–D (hub, board, gaze) are independent repos and may run in parallel with separate builders; E needs A; F needs everything. Every task: red test first, then code, then the verification line, then a one-paragraph report to the overseer (what changed, what was seen red→green, anything adapted). **Adaptation protocol for every task:** a finding that contradicts the Preflight table → STOP and report (the overseer re-anchors); a test outside this plan goes red → STOP; a smaller-than-planned change suffices → do the smaller one and say so.

### Phase A — the engine stage (`ellie-this-week--wt-youtube-videos`)
**Posture hint:** implementing (A1–A5), collaborating (A6: prose a cron reads unattended)

- [ ] **A1. Schema and config** — `src/ellie/activities/schema.py` (pydantic models `Activities`, `Video`, `Oembed`, `TalkWord`, `WhichItem`, `Choice`, `SortSet`, `PlayIt`, `Play`, with every rule under Definitions, `extra="forbid"`), `config.py` gains `ActivitiesConfig{channels_path="config/video-channels.md", video_minutes_max=15, videos_min=3, videos_max=5, talk_min=6, talk_max=16}` wired as `EngineConfig.activities` with a default so an engine.toml WITHOUT the table still loads; `config/engine.toml` gains `[activities]` with those keys; `config/video-channels.md` in the `approved-books.md` shape (`## <channel>` sections, a line of why) seeded with PBS KIDS, SciShow Kids, Nat Geo Kids, Homeschool Pop, Smile and Learn, Peekaboo Kidz, Free School, Crash Course Kids.
  - **Acceptance:** the Definitions example parses; each rule has a failing fixture (`tests/activities/test_schema.py`: 11-char id, minutes 16, two `right`, glyph of two graphemes, `glyph` AND `symbol`, 2 videos, 17 words, unknown skill, unknown instrument, extra key); the emoji-grapheme check uses the stdlib only (`unicodedata` + a hand-rolled extended-grapheme walk is fine; no new dep); `load_config("config/engine.toml")` still passes every existing test.
  - **Verification:** `uv run pytest -q tests/activities/test_schema.py tests/test_config.py` (or the suite that covers `load_config`) green; `uv run pytest -q` green.
  - **Guardrails:** TDD; no new dependency; STOP if `extra="forbid"` on `EngineConfig` cannot take a defaulted sub-model (it can — `feedback` does it).

- [ ] **A2. Rubric** — `src/ellie/activities/rubric.py`: `week_concepts(week_dir) -> list[str]` (from `inbox.json` via `latest_digest` + `parse_coming_week`, falling back to `recipe.json`'s `coming_week`; plus the title; lower-cased, split into content words with a small stop list), `family_terms(family_md) -> list[str]` (the words after "no"/"never"/"not" in `config/family.md`, lower-cased; a test pins Christmas and Easter from the live file), `score(activities, week_dir, cfg) -> list[RubricLine{code, ok, why}]` implementing lines (1)–(9) under Definitions, and `report(lines) -> str` (one line each, `PASS`/`FAIL`).
  - **Acceptance:** `tests/activities/test_rubric.py`: a golden-shaped fixture passes all nine; one fixture per line fails exactly that line; line (1) passes on a fallback week whose digest parsed slots (a copy of the 10/12 shape built in-test); the channel check reads `config/video-channels.md`.
  - **Verification:** `uv run pytest -q tests/activities/test_rubric.py`.
  - **Guardrails:** TDD; the rubric never reads the network; no real newsletter text in test fixtures (write synthetic digests).

- [ ] **A3. The two subcommands and the package** — `src/ellie/activities/prompt.py` (`build_prompt(week_dir, cfg) -> str`: the week's `ComingWeek.named_items()` and the teacher's own coming-week lines from the digest, the hero card if any, `config/ellie-story.md` verbatim, `config/family.md` verbatim, the channel allowlist, the skill list + bar + banned questions (spec §5.3, quoted), counts, the schema example, the oEmbed `curl -s "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json"` instruction, last week's `activities.json` titles if present "do not repeat", and the rule "write `weeks/<w>/activities.json`; omit `play` only if you cannot meet the bar"); `src/ellie/activities/package.py` (`write_package(week_dir, cfg, now) -> PackageResult`: load + validate `activities.json`, run the rubric, write `weeks/<w>/this-week/manifest.json` (`activities` + `approved: null` until approval + `schema: 1`), write `weeks/<w>/activities-summary.txt` (the mail section: title; `Watch:` numbered lines `1. <title> — <channel>, <minutes> min[ — off allowlist]`; `Talk:` the words in order, grouped; `Play:` one line per which item `<skill>: <q> — <right>* / <others>`, the sort bins and item count, the instrument + question; flags: rubric FAILs, fallback brief); write `activities-state.json` `{status:"staged", edits:[], rubric:[...]}`); `orchestrate.py`: `activities-prompt` (prints the prompt; exit 0; exit 2 with a one-line reason if `inbox.json` is missing) and `activities [--rubric-report]` (exit 0 = package written, rubric may have FAILs which are in the summary; exit 3 = `activities.json` missing or invalid, reason on stderr, nothing written; `--rubric-report` prints the report); metavar updated.
  - **Acceptance:** `tests/activities/test_package.py` drives `_main([...])` in process on a tmp week: prompt contains the skill list, the allowlist names and the oEmbed command; a valid `activities.json` → manifest + summary + state written, idempotent on a second run (same bytes but `rubric`); an invalid file → exit 3, no files; the manifest never contains the keys `cover` or `pages`; the summary names a fallback brief.
  - **Verification:** `uv run pytest -q tests/activities/` ; `uv run python -m ellie.orchestrate activities-prompt weeks/2026-10-05 --config config/engine.toml | head -40` shows the prompt.
  - **Guardrails:** TDD; no network; `KEPT_NOTES` untouched (state lives in its own file); STOP if the prompt would need anything §8 forbids the mail to read (it does not — the summary is the mail's one source).

- [ ] **A4. Approval phrases and activities state** — `src/ellie/activities/approval.py`: `PHRASES` (the regex table under Definitions), `strip_phrases(text) -> (clean_text, ops)`, `apply_ops(week_dir, ops, cfg, now) -> ActivitiesDecision{status, line}` (edits `activities.json`, re-runs `write_package`, sets `activities-state.json` status: `held` / `approved` / `edited` then approved; `approved` is also set by a bare approve of the book; `swap` parses `v=`, `youtu.be/`, or a bare id from the ORIGINAL text); `book/approval.py`: `_own_words`/`_matched`/`tier` strip the phrases first exactly where `_HERO_RE` is stripped; `decide` records the ops; `orchestrate.py` prints line 3 `activities: …` after the hero line (`activities: none` when the week has no `this-week/manifest.json`).
  - **Acceptance:** `tests/activities/test_approval_phrases.py`: "approve" alone → book approved, activities approved; "approve, no video 2, swap video 1 for https://youtu.be/XyZ-12_abcD" → book approved (not `feedback`), watch[1] removed, watch[0].id = `XyZ-12_abcD` (case kept) with `unconfirmed: true`; "hold activities, approve" → book approved, activities held; "hold" → book held, activities untouched (still `staged`); an id containing `-no-` never holds the book; a REDO week ignores the phrases like every non-bare-hold reply; the existing `test_approval.py` stays green unchanged.
  - **Verification:** `uv run pytest -q tests/activities/test_approval_phrases.py tests/book/test_approval.py`.
  - **Guardrails:** TDD; the seven first-line verdicts are unchanged (selfcheck 11c); STOP if making a phrase work requires touching `_APPROVE_WORDS`/`_HOLD_WORDS` or `_shape_refusal`.

- [ ] **A5. Deliver the package** — `src/ellie/activities/deliver.py`: `THIS_WEEK_ROOT = "New ERA Content/this-week"`, `week_dest(week_of)` (refuses anything not `<ROOT>/<YYYY-MM-DD>`), `deliver_week(week_dir, cfg, run, *, dry_run)` → requires `activities-state.json` status `approved`; stamps `approved` into the manifest; pass 1 `rclone copy <week_dir>/this-week <dest> --exclude manifest.json`; pass 2 `rclone copyto manifest.json`; OVERWRITES (a re-delivery after edits replaces the manifest; no `_already_there` no-op); records `delivered_at` + sets status `delivered`; reuses `rclone_runner`, `DRY_RUN`, the disk floor; `orchestrate.py`: `deliver-activities <week_dir> [--dry-run]` (exit 0 delivered / dry-run listing; exit 2 not approved or held, one line).
  - **Acceptance:** `tests/activities/test_deliver_week.py` with a fake `Runner` recording argv: two passes in order, manifest last, dest exact; held → exit 2 and no rclone call; dry-run reaches rclone with `--dry-run`; a second delivery after an edit runs both passes again.
  - **Verification:** `uv run pytest -q tests/activities/test_deliver_week.py`; `uv run python -m ellie.orchestrate deliver-activities weeks/2026-10-05 --dry-run` prints the listing (rclone is configured on the build box) — read-only.
  - **Guardrails:** TDD; never touch `book/deliver.py`'s `book_dest`; STOP before any non-dry-run delivery (the overseer runs the first real one, F3).

- [ ] **A6. The runner prose** — `runner/friday-task.md`: insert `## 5c — Activities (the week package)` at line 279 (after §5b, before §6): run `activities-prompt`, write `activities.json` (Write), confirm each video with the oEmbed curl, run `activities`, "if it exits 3 fix the file once and run it again; still 3 → say so in §9 and carry on: the book never waits for the package", "a file already on disk is used as is" (idempotent re-runs), and the word "stop" (selfcheck 11); §9 gains step 6: "paste `weeks/$week_of/activities-summary.txt` verbatim under a line `This week on her board:`, then the fixed line `Reply approve / hold for the book; add "hold activities", "no video 2", "drop game 3", "swap video 2 for <link>", "snap yes" for the board.`"; `runner/approval-task.md`: §4 names the third stdout line and the five phrases; §5b′ "after `deliver`, run `deliver-activities`; exit 2 is fine (held) — say which"; §6 the tablet reply gains a 4th line `This week's board: delivered | held | none`; `runner/feedback-task.md` §6 `new_story`: one sentence — the package is NOT rebuilt by a new story (it keys on the newsletter, not the book); `runner/weekly-task.md`: the hand commands for a held package (`activities go` by hand = `deliver-activities` after editing `activities-state.json` status to `approved`); `runner/selfcheck.sh` amended only if a check trips; `tests/activities/test_eval_fixtures.py` placeholder is NOT here (see E2).
  - **Acceptance:** `bash runner/selfcheck.sh` passes; the §5c section contains "stop"; §9's new step names only `activities-summary.txt`; `grep -c` for each phrase in approval-task.md = 1+.
  - **Verification:** `bash runner/selfcheck.sh && uv run pytest -q`.
  - **Guardrails:** prose a cron reads unattended — short sentences, one action per line, the engine's exact commands; the four rules of the run stay first; STOP if §8's "five keys" sentence would have to be weakened (add a sixth source sentence instead, naming the summary file).
  - **Gate (end of Phase A):** overseer review of A1–A6 against spec §6–§7 and the Definitions; `uv run pytest -q` and `selfcheck.sh` green; retrospective paragraph in the worklog.

### Phase B — the hub (`era-hub--wt-youtube-videos`)
**Posture hint:** implementing

- [ ] **B1. `this-week.js`: manifest → recipe, status, media route** — pure module exporting `readWeek(dataDir) -> {week_of, manifest, dir}|null` (newest parseable), `validate(manifest) -> {manifest, dropped[]}` (the Definitions rules in JS), `recipe(week, ready) -> {recipe, etag}` (the cell contract), `videoState(dir, id)`; `server.js`: `const THIS_WEEK_DIR = path.join(DATA, "this-week")`, `GET/HEAD /recipes/this-week.json` (ETag, 304, valid-empty degrade, `Cache-Control: no-cache`), `GET/HEAD /this-week/<week_of>/<file>` via `serveMediaJail(req,res,THIS_WEEK_DIR, rest, [".json",".mp4",".webp",".jpg",".jpeg",".png"], [".mp4"])` with `claim-*.json` denied (404), `GET /this-week/status` (stub `running:null`, `videos` states from files only until B3 fills them); the `movies-add.js:~15` / `server.js:667` "hub NEVER serves video" comments amended to "streaming services never; downloaded week videos are served from `this-week/`".
  - **Acceptance:** `tests/this-week-recipe.test.mjs` in-process: fixture week `2026-01-05` (3 videos: one with mp4+webp, one with a zero-byte mp4, one absent; 10 talk words; a `play` block) → root has exactly Watch [1,1] + Talk [1,4] + `say_on_load`; `watch` board has Back + 1 `video` cell (image path `this-week/2026-01-05/aBcDeFgHiJk.webp`) + 2 `word` "not here yet" cells in the right seats; `talk-1` has 8 words + More → `talk-2` with 2 words + Back, no More; an item with a bad id is dropped and listed in `dropped`; ETag changes when the zero-byte mp4 gains bytes and is stable otherwise; two week folders → newest; no folder → root-only + `"none-r1"`; a manifest with `pages` is refused (dropped whole, err etag). Hub on **8456**: 200 + ETag, 304 on `If-None-Match`, `/this-week/2026-01-05/x.mp4` 206 on a range, `..` → 403, `claim-a.json` → 404, `/recipes/nope.json` → 404.
  - **Verification:** `node --test tests/this-week-recipe.test.mjs`.
  - **Guardrails:** TDD; follow `moviesRecipe`'s cell shapes exactly (Back/More/show); no `pages`/`cover` keys anywhere; STOP if the Back/More seats conflict with the board laws table.

- [ ] **B2. The mirror** — `drive.js`: `this-week` in `MIRROR_SUBDIRS`, `MIRROR_DELETES`, `ADOPT_ON_FIRST_SYNC`; `mirrorWeek(week_of)` in the `mirrorBook`/`mirrorDrawing` shape (one week folder, no prune, no onSynced, ledger merged; skips zero-byte files); `createContentFolder` therefore makes `this-week/` (test pins it); `drive-mirror.test.mjs:203` key list gains `this-week`; `drive.status().content["this-week"]`.
  - **Acceptance:** `tests/drive-mirror.test.mjs` extended: a fixture Drive root with `this-week/2026-01-05/{manifest.json, a.mp4(0 B), b.webp}` mirrors manifest + b.webp, skips the 0-byte mp4, and after the mp4 gains bytes a `mirrorWeek` brings it over without touching other dirs; deleting the week on Drive removes it locally on the next full sync.
  - **Verification:** `node --test tests/drive-mirror.test.mjs tests/drive-localfolder.test.mjs`.
  - **Guardrails:** TDD; never change `BYTE_COMPARE` semantics for other dirs; STOP if `mirrorWeek` would need `sync()`.

- [ ] **B3. The download rail** — `this-week-fetch.js` per Definitions (state, `tick()`, one job at a time, claims, lookup → cap → download → verify → move → `mirrorWeek` → status; `tool()` and `run()` copied from music-add's shape with `KILL_MS = 20*60*1000`; `OwnWords`-style messages); `server.js`: `drive.onSynced` chain gains `thisWeekFetch.tick("drive sync")`, a 20-min `setInterval` (unref'd), `/this-week/status` now reports `running` and `videos`; `GET /settings` default `downloadWeekVideos: true`, `POST /settings` boolean guard.
  - **Acceptance:** `tests/this-week-fetch.test.mjs` on **8457** with the music-add fake yt-dlp pattern (`ERA_YTDLP`, `FAKE_YTDLP_CTL`, `ERA_DRIVE_LOCAL_ROOTS`): (a) switch off → every state `switch-off`, no spawn; (b) `ERA_PACK_ROOT` without the pack → `pack-missing`; (c) happy path: lookup argv then download argv recorded exactly (format string, `-o` into `<DATA>/this-week/.tmp/<id>/`), the fake writes `<id>.mp4` (1 KB) + `<id>.webp`, both land in `<Drive>/this-week/<w>/`, the claim is gone, the tmp dir is gone, `/recipes/this-week.json` ETag changed and the tile is now `video`, status `ready` with `height`; (d) fake `duration: 1000` → `too-long`, no download argv; (e) fake writes `.webm` → `not-mp4`, nothing moved; (f) a fresh `claim-<id>.json` by `other-device` → `claimed`, no spawn; a 31-min-old one → proceeds; (g) two missing videos → two jobs in order, never concurrent (the fake records timestamps); (h) `POST /settings {downloadWeekVideos:false}` round-trips and junk is rejected (extend `routes.test.mjs` or here).
  - **Verification:** `node --test tests/this-week-fetch.test.mjs tests/routes.test.mjs tests/music-add.test.mjs`.
  - **Guardrails:** TDD; argv arrays only, never a shell string; the url form `https://www.youtube.com/watch?v=<id>` always (an id may start with `-`); STOP if any step seems to need ffmpeg or a flag not in Definitions.

- [ ] **B4. The watch page, Settings UI, app registration** — `public/watch/index.html` + `watch.js` per Definitions; `settings/index.html` the `seg` card; `APPS` gains `{ id: "this-week", title: "This week", sub: "what her class is learning", path: "/board/?recipe=this-week", pack: "board" }` after `movies`; `public/icons/this-week.png` (≥ 1000 B, a calendar-page glyph rendered from Fluent Emoji "Calendar" 3D PNG, MIT, pinned sha in `SOURCE.md` next to the other icons' notes) + `this-week.ico`; `tools/installer.nsi` `Section "This week" SecThisWeek` + description + `-writeApps` line in APPS order; `tools/build-payload.sh` copies `public/watch` and lists `this-week.js`, `this-week-fetch.js`; `public/home/index.html` empty-state wording for `this-week` ("Nothing this week yet").
  - **Acceptance:** `tests/watch-ui.test.mjs` on **8427** (Playwright, a stub engine on a free loopback port is NOT needed: route `**/app/watch-end` and `**/log` in the page context): a 1-second fixture mp4 (generated bytes are fine if Chromium plays them; else a tiny real mp4 committed under `tests/fixtures/`, < 50 KB) plays, `ended` posts `/log` with `event:"ended"` then `/app/watch-end` with `reason:"video-ended"`; bad params → blank + `watch-end` after 1 s; `mediaSession` handlers registered (`navigator.mediaSession.setActionHandler` spied); `settings-ui.test.mjs` extended: the card toggles and POSTs; `icons.test.mjs`, `packs.test.mjs`, `apps.test.mjs`, `home-tiles.test.mjs` green with the new app.
  - **Verification:** `node --test tests/watch-ui.test.mjs tests/settings-ui.test.mjs tests/icons.test.mjs tests/packs.test.mjs tests/apps.test.mjs tests/home-tiles.test.mjs`.
  - **Guardrails:** TDD; no `requestFullscreen`; the page has no dwell targets; STOP if Chromium in Playwright cannot play the fixture (then test `ended` by dispatching the event on a `<video>` with a data: src and say so).

- [ ] **B5. `docs/this-week.md`** — what the board is, the week folder contract, the rail's refusal ladder and status words, the switch, the 360p note, how to push a week by hand (`rclone copy` of a package into `New ERA Content/this-week/<week_of>/`, manifest last), how to read `/this-week/status`; `docs/dev-flow.md` untouched.
  - **Acceptance / Verification:** `bash ~/new-era/era-family/tools/era-scan.sh` (pre-commit) passes; the doc names every status word that `this-week-fetch.js` can emit (a grep in the test for B3 pins the list; the doc is checked by eye).
  - **Gate (end of Phase B):** overseer review against spec §3, §6, §9, §10; `node --test tests/*.test.mjs` for the touched suites green; retrospective.

### Phase C — the board (`era-board--wt-youtube-videos`)
**Posture hint:** implementing

- [ ] **C1. The `video` tile, lock, empty state, banner** — `board-render.js`: `isPhoto` true for `type === "video"`; `launchVideo` per Definitions; `onTile`: `video` → lock check (refuse silently when locked) → `launchVideo`; marker keyed `"video:"+id`; `board-lock.js` `MEDIA_TYPES` gains `video`; `board.js:100` `hasTiles` splash for `this-week` with "Nothing this week yet"; `index.html:30` `#launchWarn` text generic; `tests/board-this-week.test.mjs`: routes `**/recipes/this-week.json` to an inline fixture (the B1 fixture's shape), `**/app/launch` to a stub recording the body, `**/log` recording; asserts: the root shows two doors and speaks `say_on_load`; Watch shows a photo-styled `video` tile and two "not here yet" word tiles; dwell on the video tile posts `{url: "http://localhost:<port>/watch/?w=2026-01-05&v=aBcDeFgHiJk", watch: true}` then `/log` `{event:"launch"}`, and the `.watching` class appears; a 500 from the stub → `.launch-failed` + the banner; with `era.lock` set, the dwell does nothing; Talk page speaks a word (`window.__speechLog`); More → `talk-2`; Back → root; the pixel audit's invariants over the three states (reuse `board-pixel`'s MEASURE if exported, else assert the floors directly: every `.dwell` ≥ 90 px-at-1920, no bar extras, gaps ≥ 14).
  - **Acceptance:** the suite green under the gate; `board-movies`, `board-lock`, `board-pixel`, `board-partner-strip` unchanged and green.
  - **Verification:** `cd ~/new-era/era-hub--wt-youtube-videos && ERA_WT_SUFFIX=--wt-youtube-videos bash tools/era-gate.sh` (the only way this suite sees the worktree's front end).
  - **Guardrails:** TDD; do not add `video` to `LAUNCH_TYPES` (its `launchMovie` would 400 on `/movie-event`); no `link` type; STOP if the pixel floors fail for the 5-seat Watch page (report sizes; the overseer decides seats).
  - **Gate:** overseer review against spec §3.3 and the board laws; retrospective.

### Phase D — the engine on the device (`era-gaze--wt-youtube-videos`, plain `git worktree add`)
**Posture hint:** implementing (three edits, no compiler)

- [ ] **D1. Return to the picker finds the hub's kiosk** — `device/ERAgaze.cs`: (1) `ForegroundPickerKiosk` (~`:1601-1611`) also accepts a `chrome.exe` or `msedge.exe` whose command line contains `kiosk-profile` (ordinal, case-insensitive) — the hub's board kiosk; (2) `CloseStreamingKiosk` / `EndAndClose` (~`:1077-1082, 1584-1596`) never falls through to `ExitKiosks()` when such a kiosk exists (it foregrounds it; if `SetForegroundWindow` fails it logs and leaves the kiosk alive rather than killing it); (3) the spawn (~`:1570-1573`) gains `--hide-crash-restore-bubble`; header comment adds a `v2.6` line and `/status` version → `"2.6"`.
  - **Acceptance:** `git diff --stat` shows one file; the diff touches only the three sites + header + version; no behaviour change when no `kiosk-profile` chrome exists (TD Snap path unchanged — read the diff twice); C# syntax checked by eye against the surrounding code (no compiler here).
  - **Verification:** the VM leg of the release (F2) compiles it on Windows; the home i13's boot pass recompiles (`ERAgaze.exe.src-sha256` changes) — F4 checks `/status` reports `2.6`.
  - **Guardrails:** exactly three edits; STOP if the fix seems to need a new config key or more than ~25 lines.
  - **Gate:** overseer reads the diff; fast-forwards era-gaze master only together with F2.

### Phase E — golden weeks, the eval, the launcher
**Posture hint:** collaborating (E1: content at the bar, dad reads it), implementing (E2–E3)

- [ ] **E1. Three golden weeks** — `eval/golden/2026-09-14/activities.json`, `2026-09-28/…`, `2026-10-05/…` written from those weeks' `inbox.json` + `recipe.json` at the spec §5.3 bar: 3–5 videos each confirmed with the oEmbed curl (real ids, allowlisted channels; SciShow Kids "What is Sound?" belongs in 09-28 or 10-05), 8–16 Talk words, 6–10 `which` items with a skill mix (≤ 1 vocabulary), a sort set that is the class's real sort (apples: "grows on a tree / in the ground"; spoon gongs: "vibrating / not vibrating"; harmonicas: "need / want" from social studies), an instrument question; every file passes `schema` + all nine rubric lines; a `README.md` in `eval/golden/` with the bar and the banned questions, quoted from the spec.
  - **Acceptance:** `tests/activities/test_eval_fixtures.py` loads each golden file through `schema` and `rubric` against its week dir → all PASS; the overseer reads all three; **dad reads them before E2 runs** (the overseer mails or shows them).
  - **Verification:** `uv run pytest -q tests/activities/test_eval_fixtures.py`.
  - **Guardrails:** the builder may use WebSearch and the oEmbed curl (no downloads); real classmate names from newsletters never appear in any golden file; a hero is a public figure; STOP if a week cannot reach 3 allowlisted videos (report the candidates).

- [ ] **E2. The eval harness** — `tools/eval-activities.sh` and `runner/activities-eval-task.md` per Definitions; `activities --rubric-report` exit code semantics; `runs/eval/` gitignored.
  - **Acceptance:** `bash tools/eval-activities.sh 2026-09-21` (held out) runs end to end on the build box (`ai-run` at the agent tier), prints the scorecard, writes nothing under `weeks/`; then 2026-09-07, 2026-10-12 (fallback: the summary names it), `fixture:2026-08-21-braille` and the 08-28 fixture. The overseer reads the five outputs against the golden bar and records pass/fail by hand in the worklog.
  - **Verification:** the five scorecards; `git status` clean of `weeks/` changes.
  - **Guardrails:** the eval task md is the §5c text with paths parameterised, nothing more; the session's tools are Bash, Read, Write, WebSearch, WebFetch only; STOP if a held-out run exceeds 20 minutes (report).

- [ ] **E3. The TD Snap tile launcher** — `aac-board-builder/tools/tile-launchers/ThisWeek.bat` per Definitions (that repo is private; commit there).
  - **Acceptance / Verification:** `diff <(sed 's#/board/?recipe=movies#/board/?recipe=this-week#; s#EllieMovies#ThisWeek#' EllieMovies.bat) ThisWeek.bat` is empty; `file ThisWeek.bat` reports LF.
  - **Gate (end of Phase E):** overseer review; dad's reading of the golden sets recorded; retrospective.

### Phase F — gate, release, device (behavioral verification; the overseer drives, builders assist)
**Posture hint:** collaborating

- [ ] **F1. Gate green across the worktrees** — `ERA_WT_SUFFIX=--wt-youtube-videos bash tools/era-gate.sh` in the hub worktree: all suites green, stamps for hub + board trees; engine `uv run pytest -q` + `selfcheck.sh` green; era-scan clean on every public commit.
  - **Verification:** `== era-gate: N passed, 0 failed ==` with N ≥ 116 + the new suites; stamp files under `/tmp/era-gate-green/`.
- [ ] **F2. Scratch end-to-end on the build box** — a scratch hub (8481, `ERA_WT_SUFFIX` assemble) over a fake Drive root holding the **real 2026-10-05 golden package** (built by `activities` in the engine worktree from `eval/golden/2026-10-05/activities.json` copied into a scratch week dir) with the fake yt-dlp writing a real small mp4; Playwright screenshots of root, Watch, Talk pages at 1920×1080 saved to the scratchpad for the overseer; `curl /this-week/status` shows `ready`; `curl -I /recipes/this-week.json` ETag changes after the mp4 lands.
  - **Verification:** the three screenshots + the two curl outputs pasted into the worklog.
- [ ] **F3. Land, release, deliver** — land in dependency order (`worktree.sh land` era-board → era-hub) while the stamps hold; fast-forward era-gaze master to D1; signed release `bash tools/release.sh v0.39.0` (installer Section → signed shape; VM legs compile the engine; dad stages the SimplySign code); land the engine worktree (`worktree.sh land ~/ellie-this-week youtube-videos`) and commit the untracked weeks it needs; **only after the hub is on the devices**: `uv run python -m ellie.orchestrate deliver-activities <scratch week from F2 or the real 2026-10-05 golden> --dry-run`, then real.
  - **Verification:** `gh release view v0.39.0`; `/version` on the tablet and home i13 report `0.39.0`; `/status` on each engine reports `2.6`; `rclone lsf "family-drive:New ERA Content/this-week/"` lists the week.
- [ ] **F4. On her device** — on the tablet (switch on, media-tools pack installed via Settings if `/music/add/status` says not): `GET /this-week/status` moves `coming` → `ready` for every video within ~10 minutes at home; `/recipes/this-week.json` shows `video` tiles; **dad opens This week on the tablet**: the root speaks the title, Watch shows thumbnails, one look plays the video full screen with sound, the corner wake target brings the strip, pause pauses, the video's end returns to the Watch page (not TD Snap); Talk speaks words; the home i13 mirrors the mp4s without downloading again (status `ready`, no `running`); the school device has the switch OFF and still plays once Drive syncs. The TD Snap tile is added by hand by dad from `ThisWeek.bat`.
  - **Verification:** dad's words in the chat + `logs/<day>.jsonl` on the tablet holding `launch` and `ended` lines for one id; a `this-week-fetch` pool line with `height`.
  - **Gate (final):** the Friday fire of the following week (10/23 at the earliest; 10/16 only if F3 lands before Thursday) produces a package in the mail without a hand step; the overseer watches `runs/friday.log` that morning.

## Risks and unknowns

- 360p (deviation 8). If dad finds it too soft, the follow-up is ffmpeg in the media-tools pack (a house-law change) or a second yt-dlp pass with `-f 22` where it exists.
- `SetForegroundWindow` from a background process can fail on Windows; D1 logs and leaves the kiosk alive, so the worst case is the board behind a dead black window until the 🚪 — F4 checks this on the real device.
- Chrome media session: pause through `VK_MEDIA_PLAY_PAUSE` needs an audible track; a silent video will not pause from the strip (cosmetic; the exit tile still works).
- The school device's Drive sync has been unreliable (10/8); the package may arrive late there. Nothing in phase 1 depends on it.
- The Friday session's 7200 s budget now carries §5c; the stage is text-only and should cost minutes, but E2 measures it.
- `apps.json` on existing devices keeps the new app OFF until a grown-up toggles it in Settings (as Drawing was).
- The free-port set is three; a fourth hub-spawning suite has nowhere to go without the port map being redrawn.

## Not verified (and what WAS)

Verified by reading on 10/12: every line in the Preflight table. Not verified: that Chromium in Playwright plays a generated mp4 (B4 has the fallback); that yt-dlp 2026.08.19 still offers format 18 for the chosen videos (B3's fake does not test YouTube; F4 does); C# compiles (no compiler here; the VM does).

## Spec coverage (self-review)

§1 the tile and doors → B1, B4, C1 (Play door deferred, deviation 3). §2 where the week comes from → A3, A6. §3.1 content → A1 (schema), E1 (golden), prompt (A3). §3.2 download rail → B2, B3 (deviations 5–9). §3.3 playback → B4, C1, D1. §4.1 Talk page → B1, C1 (8 per page, glyph/symbol — deviations 2, 4). §4.3 TD Snap promotion → `snap yes` (A4) + a human session; E3 launcher. §5 Play → schema + rubric + golden only (deviation 18); the app is phase 2. §6 package → A3/A5 + B1 (manifest rules). §7.1–7.4 → A3, A4, A6. §7.5 eval → E1, E2. §8 Sunday note → phase 3 (not here). §9 hub changes → B1–B5, C1, E3. §10 testing → each task's Acceptance. §11 phase 1 → this plan. §13 open questions: Q1 answered by the switch (download per device, playback anywhere); Q2 answered (the `interests.yaml` core list); Q3 open (Play, phase 2).
