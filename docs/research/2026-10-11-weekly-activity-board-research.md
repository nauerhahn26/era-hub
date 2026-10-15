# Weekly activity board — research record (2026-10-11)

Status: research, not a design. Six parallel recon passes (class corpus, the
district's published curriculum, Ellie's learning profile + Rett pedagogy, the
house rails, the weekly engine's data, activity formats + open tooling), run
after dad's brief of 10/11: "a weekly activity board based on what she's
learning — YouTube videos as one feature, quizzes, sorting, games; dynamic
things in our custom boards, long-lived topics (planets) on TD Snap; test it
on past weeks the model did not see." This supersedes nothing; it feeds the
design that `docs/specs/2026-09-23-weekly-bundle-parked.md`
(the same idea, parked 9/23) was waiting for.

The private half of this record — the week-by-week class table from the
teacher's newsletters and the district curriculum links — lives in the
private weekly-book repo (`ellie-this-week/docs/research/`), never here.

## 1. What the class is doing (shape, not names)

- Eight teacher newsletters since the first week of school, plus a weekly
  message from the special-day-class teacher, principal bulletins and the
  aide's daily forms. The weekly-book engine already ingests the newsletter;
  its `inbox.json` carries the full text, its `recipe.json` only slot labels.
- Science Aug 28 → Oct 9 was ONE unit: sound. Vibration → loud/soft →
  indoor/outdoor sounds → volume and pitch → sound travels (spoon gongs) →
  harmonicas. This is the FOSS grade-1 module "Sound and Light", Investigation
  1 (Sound and Vibrations) then 2 (Changing Sound); Investigations 3–4 are
  light, shadows and mirrors, so light is the likely next science theme.
  Source: FOSS Next Generation module brochure
  (fossnextgeneration.com, PreK-5 module descriptions) and a public district
  pacing plan of the same module (10 weeks).
- Social studies: an inquiry unit on families (near and far → traditions →
  food traditions → family roles → "diversity strengthens a community").
- Phonics: short vowels in order a, i, o, e, u (one a week); 30-lesson
  grade-1 scope after that: blends, digraphs, silent-e, word families, vowel
  teams. Writing: personal narrative all fall. Reading: a Julia Donaldson
  author study (the teacher's choice, not a district unit).
- Math: number partners to 10 → add/subtract strategies → subtraction
  (math mountains, circle drawings). The district publishes a month-by-month
  math map with standards, so math can be scheduled a year ahead.
- Rituals the board can lean on: Hero of the Week (absent some weeks), Star
  of the Week, third-grade buddies, book bags, a class "toolbox" of
  regulation tools, a character trait of the month.
- The newsletter gives topics, never content: no vocabulary lists, no lesson
  sequence, and "planned" (Friday preview) sometimes differs from "done".

## 2. Standards the board keys to (grade 1, California)

NGSS 1-PS4-1..4 (sound/light), 1-LS1-1/2, 1-LS3-1 (plants/animals),
1-ESS1-1/2 (sun, moon, stars, seasons). ELA foundational RF.1.2–RF.1.4,
RL.1.2 retell, RI.1.2 main topic. Math essentials 1.OA.1/6/7, 1.NBT.1/2/5,
1.MD.4, 1.G.1. History-social science grade 1 "A Child's Place in Time and
Space" 1.1–1.6. FOSS "big ideas" for sound, usable as quiz facts: vibration is
a fast back-and-forth; volume is loud or soft; pitch is high or low; fast
vibration = high pitch; big things vibrate slower than small things.

## 3. How Ellie learns — the rules a designer must obey

From `aac-board-builder/knowledge/*` (ellie-profile, rett-communication,
ux-contract, callie-method, literacy-theory, iep-evidence-map) and the D-log.

- **Never a test.** D18 + ux-contract §15–16: she never sees a score; wrong
  answers re-prompt warmly; celebrations name what she DID. The IEP records
  the parents' rule "AAC is for communication, not for quizzing". So every
  "quiz" is comment-and-choice, logged silently (POST /log) — the log can
  still be IEP evidence (goals 1, 2, 4, 5 are already "find X from 3–4").
- **Never wrong** (§14): first miss = encouragement + hint, second miss =
  the model answer; neutral teal, no buzzer, no red X.
- **Choices:** 2 is ideal, 12 comfortable, 16 never (Rett visual search is
  ~half of typical). Fixed seats: once learned, buttons never move (D26).
- **Timing:** dwell 600–3000 ms (default 1200), doors 2× dwell, nothing
  auto-advances (§18), 20 s+ response time, latency is motor not cognitive.
- **Session:** ~15 min at home before fatigue; a sentence takes 15–20 min.
- **Vision:** high contrast, black behind cards, text ≥ 32 pt, real photos
  over line drawings, text first with the symbol beside it (D4).
- **House grid:** 3×4, centre pair black, door top-left in the message bar
  (2× dwell), More bottom-left, yes/no pinned top corners (D5), no empty
  bottom row (D37). Partner strip is touch-only, never gaze-reachable.
- **Media:** one pick = one item, end = silence, no queue, no autoplay (D56,
  D56a); watch mode = clean screen + corner wake + overlay strip (D57/57c);
  streaming is HOME ONLY (D57) and nothing in code enforces that today.
- **Motivators:** fashion/colour, Julia Donaldson, music, Disney, maths ("we
  love this maths lesson"), Nat Geo-style nature; the learning-forward bar is
  Ada Twist (D57a). She asked for a game: "find and look after a baby".

Literature that agrees (URLs in the private appendix): Comprehensive
Literacy for All ("teach, don't test", Anchor–Read–Apply, comment-and-wait),
Ward/Chiat/Townend 2021 (informal embedded gaze tasks beat formal tests in
Rett), Urbanowicz 2018 (82.8% of 64 girls chose by gaze when given time),
Rett visual-search studies (small arrays, fixed positions), eye-tracking
pilots (faces and salient novelty hold attention → prefer a presenter talking
to camera), gamified gaze tasks raise motivation.

## 4. Activity formats ranked for her

| Format | Choices | Fit | Why |
|---|---|---|---|
| Watch, then comment (2 tiles), optional yes/no | 2 | high | CLfA + Tar Heel Shared Reader shape; obeys never-a-test |
| Find the one… (receptive ID) | 2→4 | high | the IEP goal format; only if errorless and silent |
| Sound → source match (hear a clip, pick what made it) | 2–3 | high | sound unit's own skill; CC0 clips |
| Predict, then watch | 2 | high | no wrong answer; the clip reveals |
| Two-bin sort by one attribute (loud/quiet, high/low, living/not) | 2 bins | high | Making Words already sorts to a column, no answer reveal |
| Topic vocabulary board (comment in class) | 12 | high | D46 weekly board, SLP goal on communicative functions |
| Sequence 3 pictures as "what came first?" | 2 per step | medium | three ordered picks is heavy |
| Hotspot "point to the part" | 2–4 regions | medium | regions must be tile-sized |
| Memory pairs | 4–6 | low | working memory + long dwell |
| Free yes/no streams | 2 | low | her yes/no is still under construction |

Avoid: timed rounds, stars for correctness, autoplay chains, symbol-heavy
worksheets, any check delivered as a standardized test on the device.

## 5. Video sourcing — what is true

- SciShow Kids (the one dad called perfect) ended in 2021: 422 episodes, an
  archive to mine, not a feed. "What is Sound?" is ~4 min.
- YouTube Data API v3: free key, 10 000 units/day, a separate ~100/day
  search bucket; `search.list` filters safeSearch, duration, captions,
  embeddable, channel; `madeForKids` is a read-only field, not a filter.
  Crawling an allowlist's uploads costs ~1 unit per 50 videos.
- yt-dlp `ytsearchN:` + `--dump-single-json` returns the same metadata with
  no key (the hub already does a no-download lookup in music-add.js), but
  YouTube bot-blocks this build box's IP (D56) — search runs on a device or via
  the SOCKS tunnel, or the Friday session uses WebSearch as hero research
  does.
- Embeds and watch pages can both show ads; creators cannot turn ads off on
  embeds; made-for-kids content still gets contextual ads. The ad-free
  "Player for Education" is partner-only. `youtube-nocookie` embeds opened as
  a whole page may fail on YouTube's 2025 Referer rule — untested.
- Candidate channels pitched at K–2: SciShow Kids archive, PBS KIDS, Peekaboo
  Kidz/Dr Binocs (vet per video, some episodes dark), Homeschool Pop, Smile and
  Learn, National Geographic Kids. Crash Course Kids is grade 5. Mystery
  Science and Generation Genius are paywalled. FOSSweb has the unit's own
  videos and a "Sorting Sounds" card sort, licensed to the district.

## 6. The rails that exist (file:line as of master 1214280)

- **A YouTube link already plays end to end** through the Movies board:
  tile → `launchMovie` (era-board `board-render.js:621-645`) → ERAgaze
  `/app/launch` (any http(s) URL, `ERAgaze.cs:741-788`) → Chrome `--kiosk`
  with autoplay (`:1563-1580`) → watch mode overlay with exit, play/pause
  (media key), louder/softer, restart, next. `movies-add.js:92-93` and the
  Settings copy already name YouTube. Media lock covers launch tiles.
  Known holes: `/movie-event` only accepts disney/netflix/prime
  (`server.js:1991`), `isPhoto` would shrink a new thumbnail path
  (`board-render.js:157-165`), empty-board and partner-strip code key on the
  names "songs"/"movies" (`board.js:100,212`, `board-partner.js:580`).
- **Recipe boards:** any `?recipe=<name>` fetches `/recipes/<name>.json`
  (`board.js:56-63`); `moviesRecipe` (`server.js:935-1071`) is the mould:
  fixed cells, ETag = mtime+size+REV, valid-empty on a missing file. Tile
  types `word` (speaks), `show`/`load:` (door), `movie`/`episode` (launch),
  `exit`. Home tile = an `APPS` entry (`server.js:120-135`); TD Snap tile =
  a `.bat` launcher + one editor-harness edit (dad-gated).
- **New interactive app precedent:** `public/drawing/` — doorbar, dwell.js,
  speech.js, Drive save with `.local` fallback, tests on scratch ports;
  Making Words' sort-to-column (`era-making-words/app/studio.js:174-229`) and
  encourage catalogue are an off-the-shelf errorless game; celebrate.js in
  era-core.
- **Drive mirror:** `MIRROR_SUBDIRS`/`MIRROR_DELETES` (`drive.js:40,190`), 10
  min local / 6 h API; same-size edits are NOT re-copied except for
  `manifest.json`-class files (`drive.js:292,312,672`) — name the week file
  `manifest.json` or add it to the byte-compare list.
- **Weekly engine:** Friday `ai-run` session (`runner/friday-task.md`)
  with brief → hero card → premises/drafts → build → preview → mail;
  weekend approval + `deliver.py` (rclone, manifest last); dad's reply →
  feedback tiers and a plan menu (merged b1de9fb). The engine is model-free;
  a generator = a runner prompt + a deterministic validator in `src/ellie/`.
  An `activities` stage would sit after §5b (text only, zero image spend).
- **TD Snap write path:** spec-gen page → self-QA → dad review →
  compile-page → qahelper harness (Match Page Set OFF) → qa-db → cloud
  checkpoint → prompt dad → board-sync-all. ~1–2 min per page in the editor,
  ~200k tokens per 2 pages, and dad's wait. Never from cron.

## 7. Eval corpus (the "weeks it did not see")

| Week | Theme | Richness | Proposed role |
|---|---|---|---|
| 2026-09-14 | apples (hero John Chapman) | medium | golden |
| 2026-09-28 | spoon gongs + traditions (hero Frida Kahlo) | rich | golden |
| 2026-10-05 | harmonicas, no hero person | rich | golden |
| 2026-09-07 | indoor/outdoor sounds (hero Emmanuel Yeboah) | medium | held out |
| 2026-09-21 | changing volume (hero Sonia Sotomayor) | rich | held out |
| 2026-10-12 | fallback theme (parser missed the newsletter) | rich input, thin brief | held out, hardest |
| 2026-06-08 | pollinators (summer, old shape) | different format | robustness |
| 8/21, 8/28 fixtures | Louis Braille / Mary Anning, sounds | newsletter only | held out, no gold |

Automatable rubric: every activity names a concept from the brief, hero card
or newsletter; no concept from outside them; family denylist and
`config/family.md` constraints (no Christmas); activity-type mix; ≤ 4
choices; no timers; first-grade level; every video has id, channel, duration
within the cap, allowlisted or flagged "new channel?"; hero facts carry a
source URL; a fallback-theme week is flagged, not silently seasonal.

## 8. Open questions this research leaves for dad

1. **Video playback.** D56 rules "NO YouTube at runtime, ever" for songs; the
   same reasoning (ads, up-next, end-screen rabbit hole) applies to video,
   and the Movies path plays YouTube live today. Pre-fetch with yt-dlp
   (muxed mp4 ≤ 720p needs no ffmpeg; same personal-use ruling as songs),
   live in the kiosk, or an embed URL (needs a VM test)?
2. **Home only.** D57 is a convention, not code; a mixed "This week" board
   with video tiles would reach the school i13 through the mirror.
3. **Who designs the golden weeks.** The research proposes the session drafts
   them and dad approves, three weeks' worth.
4. **The record.** Logged answers as IEP evidence — the current goals are due
   10/20 and the annual IEP is 10/15.
