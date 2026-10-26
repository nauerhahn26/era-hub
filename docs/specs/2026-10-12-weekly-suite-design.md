# The weekly suite: Watch, Talk, Play — design (2026-10-12)

Dad's brief (10/11) and rulings (10/11–10/12), which this spec builds on and
does not reopen:

- A **weekly activity board** built from what her first-grade class is learning,
  so she gets more colour on the week's topic and can take part in the lesson.
- **Videos are downloaded and played offline, with the picture.** Not the music
  model (audio only). No YouTube at runtime, which keeps D56's reasons (ads,
  up-next, chrome) and drops the live-playback path the Movies board uses.
- **Games are fun, not assessment.** A game is a question she answers because
  the answer does something. The never-a-test law (D18, ux-contract §14–16)
  only shapes how a miss sounds; the record is kept silently for dad.
- **Questions are pitched at her grade**, not below it. "Which one is loud?"
  is a toddler question. The bar is the grade-1 investigation itself: predict,
  compare, explain a cause, sort by a property you cannot see (§5.3).
- **No extra book.** The weekly story book is enough books.
- The three doors, Watch / Talk / Play, were approved as the design 10/12.

Research record: `docs/research/2026-10-11-weekly-activity-board-research.md`.
This spec replaces the parked 9/23 weekly bundle
(`2026-09-23-weekly-bundle-parked.md`) for everything but the book, which
already ships.

## 1. What she sees

A **This week** tile on the hub home page and, through a launcher `.bat` like
the other apps, on her TD Snap dashboard. It opens
`/board/?recipe=this-week`: a 3×4 recipe board (era-board, same mould as the
Movies board) whose title row says the topic in her words ("Harmonicas!") and
whose cells are three doors with one picture each:

| seat | door | what it is |
|---|---|---|
| [1,1] | 🎬 Watch | three to five downloaded videos about the unit |
| [1,4] | 💬 Talk | the week's words as a board she speaks with |
| [3,4] | 🎲 Play | three game engines filled with the week's content |

Everything else in the grid is black (board law: centre cells black, door
top-left in the message bar, More bottom-left when a page overflows). The
same board laws as every other board: dwell 1200 ms default, doors 2×, fixed
seats (D26), text first (D4), ≥32 pt, nothing auto-advances, ~15 minutes is a
long session.

**Amended 2026-10-25 — the small board.** Dad, after assessing phase 2: "the
grid of 4x3 feels wrong for watch, play, talk. I could see us adding 1-2 more
but not 6 more so maybe a different layout that works with fewer options." The
root is now a **2×3 board, the triangle**: two doors up, one down, black in
every other cell, so each door has a black neighbour and the centre-top cell
is a rest spot that never fills.

| seat | door |
|---|---|
| [1,1] | 🎬 Watch |
| [1,3] | 💬 Talk |
| [2,2] | 🎲 Play (absent when the week fills no engine; the cell is black) |
| [2,1], [2,3] | a fourth and a fifth door, in that order, when one day there is one |
| [1,2] | always black |

The Watch grid becomes a 3×3 ring (§3.4). Talk keeps the full 3×4 board (eight
words a page). The three-answer question pages share the triangle (§5.6).

Behind each door she is one look from the content. Nothing on any page scores,
counts down, or says "wrong".

## 2. Where the week comes from

The weekly-book engine (`ellie-this-week`) already reads the class newsletter on
Friday, writes `recipe.json` with `coming_week{hero, science, social_studies,
phonics, writing, math, also}`, and mails dad for approval on the weekend. The
suite is **one more stage of that Friday session** (§7) that writes a **week
package** next to the book, and **one more section of the same approval mail**.
On approval the weekend delivery copies the package into the Drive folder the
hubs mirror (§6). No new cron, no new mail, no new approval grammar beyond a
few words (§7.4).

The content is **dynamic by default**: every week's package lives in the
family's custom boards and is replaced the next week. A topic that runs for
weeks (sound runs ten; planets would) can have its Talk page **promoted into TD
Snap by hand** (§4.3). That is the dad-ruled split: truly dynamic things in our
boards, long-lived topics in TD Snap.

## 3. Watch

### 3.1 Content

Three to five videos, each 3–10 minutes (hard cap 15), chosen for the unit and
for her: a presenter talking to camera and showing the thing is what held her
("What is Sound?", SciShow Kids), animated explainers second, songs last. Age
6–7, learning-forward (D57a, the Ada Twist bar). A hero-of-the-week biography
for children is a fine fourth video when the newsletter names a hero.

The Friday session picks candidates from a **channel allowlist** kept in the
private repo (`config/video-channels.md`; starts with PBS KIDS, SciShow Kids
archive, Nat Geo Kids, Homeschool Pop, Smile and Learn, Peekaboo Kidz) and
confirms each pick's title, channel and thumbnail through YouTube's oEmbed
endpoint, which answers from the build box. A pick off the allowlist is allowed
but flagged in the mail. The session never downloads anything: the build box
is bot-blocked by YouTube and should not carry media anyway.

Each video may carry an optional **before** question (§5.4, "predict then
watch"): one line and two picture answers shown before the video starts. The
video is the answer. Dad's approval mail shows the question with the video.

### 3.2 The download rail (hub, on the device)

The package names videos by YouTube id. The hub fetches the file:

1. When a Drive sync lands a `this-week/<week_of>/manifest.json` whose videos
   lack files, the hub (`drive.onSynced`, next to `clothing.tick`) queues a
   fetch job per missing id, **on devices whose Settings say so** (a per-device
   switch, "This device downloads the week's videos", on by default; dad turns
   it off on the school device, whose network blocks YouTube anyway). The hub
   cannot tell home from school on its own, so this is a switch, not a guess.
2. The fetch is the media-tools pack's pinned yt-dlp (`packs.js` →
   `vendor/yt-dlp`, `tools/yt-dlp.pin`), as `music-add.js` runs it, with a
   **muxed mp4 at ≤720p** so no ffmpeg is needed:
   `-f "b[ext=mp4][height<=720]/b[height<=720]/b"` plus `--write-thumbnail`.
   The pack may be absent: then the Watch tiles show the thumbnail with a
   "coming" plate and the hub says `pack-missing` in `/this-week/status`, as
   `/music/add/status` does.
3. The file is written **into the Drive folder** (`this-week/<week_of>/<id>.mp4`)
   under a staging name first (`.<id>.part-<hostname>`), renamed when complete;
   Drive for Desktop uploads it and every other hub mirrors it. A hub that sees
   another device's staging file younger than 30 minutes waits instead of
   starting its own download. Thumbnails ride the same way.
4. The hub refuses a file longer than the cap or whose id is not in the
   manifest, and never fetches outside `this-week/`.

The mirror gains `this-week` in `MIRROR_SUBDIRS` and `MIRROR_DELETES`
(`drive.js:40,190`), so last week's folder leaves the device when the engine
removes it from Drive. The week file is named `manifest.json` because the
mirror re-copies manifest-class files even when the size does not change
(the same-size-edit trap).

### 3.3 Playback (amended 2026-10-21)

> Dad 10/13, after the first week on the tablet: "it launched in another
> Chrome window … the best experience should resemble the music player: you
> take yourself to another screen and there you see the video, with the same
> tooling to pause it. Not the little button in the corner — that is for a
> movie you watch for an hour." The tablet's gaze log for that test shows the
> video tile asking ERAgaze to launch four times in four seconds (the tile
> stays under the gaze ring until the new kiosk covers it, so the dwell keeps
> re-firing) and two windows playing at once. Phase 1's launch path is retired.

A Watch tile is a `video` tile (thumbnail as the picture, title as the label).
One look takes the **same kiosk window** to the hub's own watch page,
`/watch/?w=<week_of>&v=<id>`, the way Drawing and the Book Reader are their own
screens. Nothing is launched: no ERAgaze watch mode, no second Chrome, no corner
wake target, nothing that can fire twice. (The gaze engine's v2.6
return-to-picker fix stays; this door no longer needs it.)

The watch page wears the shared door bar on top (🚪 leaves as everywhere; 💬
pauses the video in place and goes to talk, resume picks it up). Below the bar,
a **left rail of two tiles** at board size — **Back** (to
`/board/?recipe=this-week&board=watch`) and **Pause / Play** (one tile whose
label and glyph follow the state) — and the video filling the rest, letterboxed
on black, its volume capped by the family's `musicVolCap`. When the video ends
the page returns to the Watch page by itself; a video that cannot play does the
same after a second, so a broken file never strands her. A video with a
`before` question (§5.4) shows that one Which-one item first, in the Play app's
dress, and plays as its answer. Every step is logged to `/log` as
`{app:"this-week", door:"watch", week_of, id, event, ms}` with `event` ∈
`open|ended|error|paused|resumed|before`.

The mp4 and thumbnails are served through the existing path-jailed media
helper (`serveMediaJail`, as `/movies/`) under `/this-week/`, extension
allowlist `.mp4 .jpg .jpeg .webp .png .json`. The old "the hub never serves
video" line in `movies-add.js` is about streaming services (D57) and says so.

Downloaded videos play anywhere, home or school. That is the point of offline.

### 3.4 The Watch grid (amended 2026-10-25)

Back plus up to five videos is six cells, so the Watch grid is a **3×3 ring
around a black centre** (the Drawing sticker ring's shape): Back [1,1], then
videos in reading order around the centre — [1,2], [1,3], [2,1], [2,3], [3,1]
— and every unused ring cell black. [2,2] is always black. A wide ring tile
suits a landscape thumbnail; the picture and the title read as before.

```
│  Back   │  video  │  video  │
│  video  │   ■■■   │  video  │
│  video  │   ■■■   │   ■■■   │
```

## 4. Talk

### 4.1 The page

The word board dad decided on 8/2 (D46) and nobody built. A 3×4 recipe board
(sub-board of `this-week`, type `word` tiles, which `board-render.js` already
paints light-background) that speaks each word through `speech.js` on dwell.
Words come from the package, in this order of seats: the week's **science words**
(vibrate, pitch, high, low, travel), the **social-studies words** (need, want),
the **hero** when there is one, four **describing words** from the book, and the
core she always has (more, again, I like it, I don't like it). Twelve cells is
the comfortable maximum; a second page behind More when the package has more.

Pictures: a picture from the week's book where a word has one (the book's
pages are on Drive already), else Fluent Emoji (MIT, already shipped), else
ARASAAC through `/symbol/` (already wired). The engine resolves the picture per
word and records the source in the package, so the device never searches.

### 4.2 Why it is here

The book gives her the story of the week; Talk gives her the **words of the
lesson**, which is the piece that lets her say something in class on Tuesday.
It is the lowest-cost door and the highest-value one for school.

### 4.3 Promotion to TD Snap

When dad answers `snap yes` to a week (or any later week of the same unit),
a human session builds the same page in TD Snap through the editor harness
(aac-board-builder law 1: the live board is edited only through the editor via
the QA harness; prompt dad, then `board-sync-all.sh`). The engine helps by
writing `talk-tdsnap.json`, the harness's page shape, with the same words and
pictures. Nothing in code touches TD Snap; the law stands.

## 5. Play

### 5.1 One app, three engines

`/play/` is a hub core app like Drawing (`public/play/`, plain DOM on the
Pencil shim: `dwell.js`, `speech.js`, `lib/celebrate.js`, `lib/doorbar`,
`contract.js`), reached from the Play door by a `link` tile (new, navigates the
kiosk window; its own door bar returns to `/board/?recipe=this-week`). It reads
`/this-week/<week_of>/manifest.json` and offers three tiles, one per engine, each
holding the week's items:

**Which one?** A question at the top (text first, spoken once on entry and
again on a long idle), two or three big picture answers in fixed seats
(left/right, or left/middle/right), yes/no items use the top corners (D5). She
looks at one; **the answer comes alive**: the right one plays its sound and
animates (the string vibrates, the sun glows and says "sun", the ten frame
fills). Then the next item. A set is six to ten items.

**Sort it.** One thing at a time appears in the middle; two bins left and
right, named by the property. She looks at a bin and the thing slides into it.
Six to ten things; a full bin celebrates. The bins are the real card sorts her
class does, not look-alike piles (§5.3).

**Play it.** The week's thing as an instrument she plays with her eyes, no
question at first: a harmonica whose holes play their notes and whose reed
shakes; a xylophone with long and short bars; a string telephone; next unit a
shadow puppet and a lamp. After a minute of free play one line appears, the
week's question ("Which bar makes the lowest sound?"), and she shows the answer
on the instrument itself. Cause and effect is the whole mechanic. This is the
one she will ask for.

### 5.2 Never wrong, still fun

Ux-contract §14, errorless two-strike, applied as play:

- First miss: the picked thing does its own small thing (the drum thumps),
  the question is said again with a hint ("Listen for the *low* one"), both
  stay lit.
- Second miss: the right one comes alive by itself with the cheer; she moves
  on. No "no", no buzzer, no red.
- Celebration is `celebrate.js` confetti plus the item's own sound. A set that
  ends gets a bigger one.
- Nothing is scored on screen. Every pick is logged silently (§8).

### 5.3 The difficulty bar

Items are written to the **grade-1 standard the class is actually working
toward**, not to the vocabulary of the unit. Each item carries a `skill` tag
from a fixed list, and the rubric (§7.5) refuses a set that is mostly naming.

| skill | what she does | sound unit example |
|---|---|---|
| predict | says what will happen before it does | "Pluck the tight string or the loose string: which sounds higher?" |
| compare | orders two things by a property | "Which drum makes the lower sound, big or small?" |
| cause | names what makes it happen | "What is shaking when a guitar plays? (string / wood / the air)" |
| classify | sorts by a property you cannot see | Sort it: "vibrating / not vibrating", "made by people / made by nature" |
| sequence | first, next, last | "Sound starts at the bell. Where does it go next? (air / your ear)" |
| true-false | yes/no on a claim | "Sound can travel through a string. Yes or no?" |
| count / add / subtract | the week's math with the week's objects | "Seven leaves and three more. How many?" (make ten) |
| decode / rhyme | the week's phonics | "Which word has the short u sound: bus, bike, boat?" |
| vocabulary | naming | "Which one is a harmonica?" — allowed once per set, as the warm-up |

Not allowed as items: loud/quiet by itself, big/small, colour, "find the
animal". Those are the pictures' job, not the question's. The golden weeks
(§7.5) are hand-written at this bar and dad reads them; that is where the bar
gets calibrated, and the model's held-out weeks are judged against it.

Social studies gets its own classify item when the unit has one (needs/wants;
"a family tradition / a school rule"). Phonics and math each get at least one
item per week because they are weekly in the newsletter.

### 5.4 Predict then watch

A Watch tile with a `before` question shows that one Which-one item first; the
video plays as its answer. Logged with the video id.

### 5.5 Media for items

Pictures: Fluent Emoji first (already shipped, consistent), the book's own
pictures where they fit, ARASAAC via `/symbol/` for AAC words, a real photo
only when an emoji would lie (a harmonica reed). Sounds: a small CC0 library
in `public/play/sounds/` (Freesound CC0, licence file beside it) keyed by name
(`drum-low`, `bell-high`, `string-pluck`); an item names its sounds and the
engine refuses an item whose sound is not in the library. Animations are CSS
on the tile (shake, glow, slide, fill). No AI images in Play.

### 5.6 The app's pages, the instruments, the sounds (phase 2, 2026-10-21)

Dad 10/21: "do all plays so I can assess". The three engines ship together.

**Pages.** `/play/?w=<week_of>` opens the **menu**: the shared door bar, a
Back tile (to `/board/?recipe=this-week`) and up to three tiles in fixed seats
— *Which one?*, *Sort it*, *Play it* — one per engine the week's manifest
fills; an engine with no content this week has no tile. Every page below keeps
the door bar and a Back tile (to the menu). Tiles are board-sized dwell
targets; the two doors hold 2× her dwell, everything else 1× (contract).

**Which one?** The question across the top (text first, ≥32 pt), spoken on
entry and again after 20 s with no pick. Two or three answer tiles in fixed
seats: left / right, or left / middle / right. For a yes-or-no item **yes is
always the left seat and no the right one**, whatever order the manifest lists
them (D5 in app form). Two-strike per §5.2.

*Amended 2026-10-25 (dad, after assessing):* "While I was waiting for the
question and if there were 3 options I would start selecting things. I think
the spacing is perfect when you have 2 options with the black in the middle."
Two changes, both to Which one? wherever it is mounted (the Play page and a
video's `before` question):

- **Three answers sit in the triangle**, not three across: the first answer
  top-left, the second top-right, the third bottom-centre, black in the other
  three cells, so every tile has a black neighbour and the eye crosses only
  black on its way down from the question. Two answers keep the single tall
  row with the black middle, unchanged.
- **Answers arm when the question has been read.** The tiles are painted at
  once but inert and visibly muted while the first reading of the question
  plays; the moment that reading ends they come alive together, with no added
  beat beyond what the dwell engine needs to notice them (dad: "release arm as
  rapidly as practical"). If speech is off or fails they arm at once; a reading
  that never reports its end arms them after a short cap. The re-reading after
  a miss and the idle re-reading do not disarm anything. A pick before arming
  does nothing and logs nothing.

The Play **menu** uses the same triangle for its three engines: Which one?
top-left, Sort it top-right, Play it bottom-centre; an engine the week does
not fill leaves its cell black. After the right answer comes alive
and the cheer, the next item appears by itself; after the last, the bigger
cheer and back to the menu. Which-one items that a video carries as `before`
are not in this set; they belong to the watch page (§3.3).

**Sort it.** One thing in the middle, two bins left and right named by the
property (label + glyph). A look at a bin slides the thing in. First miss: the
thing wobbles back to the middle and the question is said again with both bin
names ("Is water a need or a want?"). Second miss: it slides into the right bin
by itself with the cheer. A full set celebrates and returns to the menu.

**Play it.** Each instrument is an **ordered list of positions** she can look
at; the manifest's `answer` is an index into that list. The lists are fixed
here and the engine's prompt names them, so the model and the app agree:

| instrument | positions (index 0 first) | what happens |
|---|---|---|
| `harmonica` | 10 holes, left → right, blow notes ascending C4 … E5 | a hole sounds its note and the reed strip above it shakes while it plays |
| `xylophone` | 10 bars, longest → shortest, left → right, C4 … E5 | the bar rings and bounces |
| `string-telephone` | `[tight, loose]` | two cups and a string; she picks tight or loose, then looks at her cup to "talk": a wave runs the string and the far cup plays the voice clear (tight) or faint and muffled (loose) |
| `shadow-puppet` | `[closer to the lamp, farther from it]` | a lamp, a puppet, a wall; tiles for a few puppet shapes (bat, bird, rabbit, dog); the wall's shadow grows as the puppet moves closer |

Free play first. After 60 s the week's question appears and is spoken; her next
pick on the instrument answers it: first miss → the position does its own thing
and the question repeats with a hint; second miss → the right position lights
and sounds by itself with the cheer. Free play continues; the question does not
come back.

**Sounds.** Synthesised with Web Audio in `public/play/sounds.js` — no files, no
licence file, works offline, and the instruments need pitched notes anyway. A
small voice library by name (`drum-low`, `drum-high`, `bell-low`, `bell-high`,
`string-pluck`, `whoosh-up`, `whoosh-down`, `pop`, `cheer`) plus `note(midi)`
for the instruments. A manifest `sound` name the library lacks is ignored.
Volume follows `musicVolCap`. This replaces §5.5's CC0 file library (the build
box downloads no media).

**Never a test, logged silently.** Nothing on screen scores. Every pick posts
`/log` `{app:"this-week", door:"play", week_of, engine, item, pick, right, strike}`.

**The door.** The root board's Play door is a `link` tile —
`{type:"link", href:"/play/?w=<week_of>", label:"Play", say:"play", glyph:"🎲",
row:3, col:4}` — a new board tile type that navigates the kiosk window to a
same-origin path. The board treats `video` tiles the same way (§3.3).

## 6. The week package (data contract)

On Drive, in the mirrored folder:

```
this-week/
  <week_of>/
    manifest.json        written LAST by the delivery (as books do)
    talk/<word>.png      pictures the engine resolved (emoji / book / symbol)
    play/<item-id>.png   pictures per item where not an emoji glyph
    <id>.mp4             written by a hub (§3.2), never by the engine
    <id>.jpg             thumbnail, by the hub
    talk-tdsnap.json     for the human session, §4.3
    log-<hostname>.jsonl appended by each hub, §8
```

`manifest.json` (one week; the hub reads only the newest `<week_of>`):

```json
{
  "week_of": "2026-10-05",
  "title": "Harmonicas!",
  "topic": {"science": "harmonicas: vibration, volume, pitch, travel",
            "social_studies": "needs and wants", "phonics": "short u",
            "math": "add and subtract within 10", "hero": null},
  "watch": [
    {"id": "aBcDeFgHiJk", "title": "What is Sound?",
     "channel": "SciShow Kids", "minutes": 4,
     "before": {"q": "Will the big drum or the small drum sound lower?",
                "choices": [{"label": "big drum", "pic": "emoji:🥁", "sound": "drum-low", "right": true},
                            {"label": "small drum", "pic": "emoji:🪘", "sound": "drum-high"}]}}
  ],
  "talk": [
    {"word": "vibrate", "say": "vibrate", "pic": "talk/vibrate.png", "group": "science"},
    {"word": "more", "say": "more", "pic": "emoji:➕", "group": "core"}
  ],
  "play": {
    "which": [{"id": "w1", "skill": "compare", "q": "Which drum makes the lower sound?",
               "choices": [ … 2–3, one right, fixed order … ]}],
    "sort":  {"bins": [{"label": "vibrating", "pic": "…"}, {"label": "not vibrating", "pic": "…"}],
              "skill": "classify",
              "items": [{"label": "guitar string", "pic": "…", "bin": 0, "sound": "string-pluck"}]},
    "playit": {"instrument": "harmonica", "q": "Which hole makes the lowest note?",
               "answer": 0}
  },
  "approved": "2026-10-04T18:02:00-07:00"
}
```

Rules the hub enforces on read (valid-empty degrade, as `moviesRecipe` does):
ids match `^[A-Za-z0-9_-]{11}$`; ≤5 videos; ≤3 choices; exactly one `right`
per Which item; every `pic` is an `emoji:` glyph or a path inside the week
folder; every `sound` is in the library; `playit.instrument` is one the app
ships. Anything else drops that item, never the page.

## 7. The engine stage (ellie-this-week)

### 7.1 Where it sits

After §5b (hero card) and before §6 (story drafts) in `runner/friday-task.md`:
a new **§5c — activities**. It is text only and costs no images, so it can run
every week even when the book is held. Like `brief`, the engine prints a prompt
and the Friday agent session is the model:

```
uv run python -m ellie.orchestrate activities-prompt weeks/$week_of
   → prints the prompt: coming_week, the newsletter's own lines, the
     hero card, last week's package, the skill list and bar (§5.3),
     the channel allowlist, the sound library index, the item schema
(the session writes weeks/$week_of/activities.json)
uv run python -m ellie.orchestrate activities weeks/$week_of
   → validates activities.json against §6 and §7.5's automatable rubric,
     resolves pictures (emoji / book page / ARASAAC), confirms each video
     through oEmbed, writes the week package under weeks/$week_of/this-week/
     and a one-paragraph summary for the mail; non-zero = the package is
     held and the mail says why, the book is unaffected
```

Model-free Python in `src/ellie/activities/` (schema, rubric, pictures,
oembed, package writer), tests beside the existing ones.

### 7.2 Sourcing videos without downloading

The session has web search and oEmbed. It searches the allowlisted channels
for the unit's concepts, reads titles and descriptions, prefers the archive it
knows (SciShow Kids ended 2021; its 422 episodes cover most of grade-1
science), and writes id, title, channel, expected minutes, one line on why.
Duration is checked for real on the device at download; a file over the cap
is refused there and the tile shows "coming" until dad swaps it.

### 7.3 The mail

The weekend approval mail gains a **This week** section after the book pages:
the title, the three to five videos (title, channel, minutes, the before
question), the Talk words in seat order, every Play item as one line each
(`compare: Which drum makes the lower sound? big drum* / small drum`), the
instrument and its question, and any flags (off-allowlist channel, a held
package, a parser fallback on the brief).

### 7.4 Approval words

The existing approve/hold words approve the whole mail. New words, same
free-text grammar as the 10/7 feedback tier: `hold activities` (book ships,
package waits), `no video 2`, `drop game 3`, `swap video 2 for <url or id>`,
`snap yes` (§4.3). Anything else about the package goes to the feedback plan
menu as the book's does. A package the mail flagged as held needs an explicit
`activities go` after a fix.

### 7.5 Evaluation on held-out weeks

Golden weeks, **hand-designed in this session and read by dad before the model
sees them**: 9/14 (apples, listening tool), 9/28 (spoon gongs, Frida Kahlo),
10/5 (harmonicas, needs and wants, fall leaves). Held out: 9/7, 9/21, 10/12
(the brief parser fell back to season; the package must still be sane) and the
8/21 and 8/28 fixtures.

`tools/eval-activities.sh <week_of>` runs the Friday session's §5c alone
(`ai-run` on a cut of `friday-task.md`) over a held-out week and scores:

- automatable: every item cites ≥1 concept in `coming_week`; no concept from
  outside the week's newsletter; `vocabulary` ≤ 1 per set; ≥1 phonics and ≥1
  math item; 2–3 choices; exactly one right; video count 3–5, all on the
  allowlist or flagged, titles confirmed by oEmbed; family constraints from
  `config/family.md` (no Christmas, etc.) not violated; a fallback brief is
  flagged in the summary;
- by hand (dad or this session): would a first-grade teacher ask this; is
  the instrument the right one; does the set feel like a game.

A week scores pass/fail per line; the plan's exit gate for phase 1 is the
automatable set green on all held-out weeks and dad's yes on one.

## 8. The Sunday note

Each hub appends `log-<hostname>.jsonl` in the week's Drive folder as she
plays: `{t, door, id, skill, pick, strike, ms}`. The next weekend session reads
them with rclone and opens the approval mail with four lines: what she watched
(and finished), which words she said and how often, which games she played and
how many first-look answers, what she asked for again. No percentages, no
grades: dad reads it as a parent. Whether a line of it ever goes to school or
the IEP is dad's call per week, not the system's.

## 9. Hub changes (era-hub, with era-board as sibling worktree)

| where | change |
|---|---|
| `drive.js:40,190` | `this-week` joins `MIRROR_SUBDIRS` and `MIRROR_DELETES` |
| `server.js` APPS `:120` | `{ id: "this-week", title: "This week", path: "/board/?recipe=this-week", pack: "board" }` |
| `server.js` | `thisWeekRecipe()` next to `moviesRecipe` (`:935`): reads the newest week's `manifest.json`, builds the three-door board + Watch grid + Talk grid, ETag = manifest mtime/size + a REV, valid-empty degrade; served at `/recipes/this-week.json` |
| `server.js` | `/this-week/` media jail (`serveMediaJail`), `/this-week/status`, `/watch/` page |
| `server.js` + new `this-week-fetch.js` | the download rail (§3.2) hung on `drive.onSynced`, yt-dlp through `packs.js`, per-device switch |
| `public/play/` | the Play app, three engines, sounds library with licence |
| `public/watch/` | the full-screen player page |
| `public/home` | the tile |
| era-board `board-render.js` | `video` tile type in `LAUNCH_TYPES` (launches the hub page, logs instead of `/movie-event`); `link` tile type; `word` tiles speak on dwell if they do not already |
| era-board `board.js:56–63`, `board-partner.js:19` | `this-week` is a legal recipe name; the partner strip stays off it |
| `aac-board-builder/tools/tile-launchers/` | `ThisWeek.bat` (same shape as `Drawing.bat`) |
| `docs/` | `this-week.md` next to `drawing.md`; D56 and D57 amended in the D-log |
| **phase 2 (2026-10-21)** | `public/watch/` reworked per §3.3 (door bar, rail, no engine call); `public/play/` + `tools/build-payload.sh` ships it; `this-week.js` validates `play` and adds the `link` door; era-board `link` tile + `video` navigation (no `/app/launch`); the engine's prompt names the instrument positions (§5.6) |

Known traps carried from the research: `isPhoto` (`board-render.js:153`)
decides from the path, so thumbnails live under a path it treats as a photo;
board tests run only through the gate with `ERA_WT_SUFFIX=--wt-youtube-videos`
(a bare `node --test` on era-board tests master's front end); the first
delivery of the hub change is a release, so **no week package reaches Drive
before the hub that reads it is on the devices**, or the mirror copies a folder
nothing serves (harmless) and the engine must not delete it before then.

## 10. Testing

- era-hub unit: `thisWeekRecipe` from fixtures (full week, empty folder,
  malformed items, two weeks present → newest), the media jail, the fetch
  rail with `ERA_YTDLP` pointed at a stub that writes a fake mp4 (as the music
  tests do), staging-name contention, cap refusal, pack-missing status,
  the per-device switch.
- Play UI (Playwright, as Drawing's): the two-strike path per engine, fixed
  seats, yes/no corners, the `/log` lines, the before question before a video,
  door bar returns to the week board.
- era-board (gate, `ERA_WT_SUFFIX`): `video` and `link` tiles, Watch and Talk
  grids from a fixture recipe, partner strip absent.
- Engine: schema + rubric unit tests on the golden weeks (pass) and on
  deliberately bad packages (every rubric line fails once); the eval script
  on held-out weeks; the mail section rendered from a fixture.
- Device: one week pushed to the tablet by hand before any cron touches it.

## 11. Phases and repos

| phase | delivers | repo / worktree |
|---|---|---|
| 1 | §7 engine stage + eval harness on held-out weeks; §3 Watch (download rail, player, tiles); §4 Talk page; the mail section and words; hub release | `ellie-this-week--wt-youtube-videos` (engine), `era-hub--wt-youtube-videos` + `era-board--wt-youtube-videos` (hub) |
| 2 | §5 Play, all three engines, synthesised sounds (§5.6), before-questions; §3.3 playback rework; `link`/`video` navigation | era-hub + era-board (+ one prompt line in ellie-this-week) — plan `docs/plans/2026-10-21-weekly-suite-phase2-plan.md` |
| 2b | the small boards (§1 amended, §3.4) and the three-answer triangle + arming (§5.6 amended 2026-10-25); patch release | era-hub — plan `docs/plans/2026-10-25-weekly-suite-small-boards-plan.md` |
| 3 | §8 the Sunday note | ellie-this-week |
| any | a Talk page into TD Snap on `snap yes` | human session, editor harness |

Phase 1 ships to her only after the eval gate (§7.5) and one hand-pushed week.
Building is delegated to agent-tier builders per house rule; this session scopes, reviews and
decides.

## 12. Not in this spec

- A weekly fact book (dad 10/12: enough books).
- Any score, star, streak or level visible to her.
- Live YouTube, embeds, or any network at play time. The device plays files.
- Automatic writes to TD Snap. Promotion is by hand through the harness.
- Sharing the log with school. Dad decides per week, outside the system.
- A hero when the newsletter names none; the week stands without one.

## 13. Open questions for dad (none block phase 1)

1. Downloading is a per-device switch. Should *playback* of downloaded videos
   also be switchable per device, or is school always fine? (Spec says anywhere.)
2. The Talk page's core words: the four above, or the same core row the book
   board uses?
3. `snap yes` promotes only Talk. Should a long unit's Play sets also be kept
   as a second board the next week, or always replaced?
