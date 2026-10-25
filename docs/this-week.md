# This week (dev note)

Spec: `docs/specs/2026-10-12-weekly-suite-design.md` (§3 Watch, §6 the package, §9 hub changes).
Plan: `docs/plans/2026-10-12-weekly-suite-phase1-plan.md` (Definitions, Phase B).
Where the plan and this note differ, the code is the truth and this note follows the code.

## What it is
A board app, `/board/?recipe=this-week` (`APPS` id `this-week`, installer section "This week", which
shares the board pack with Clothing Picker, Music and Movies). It shows what Ellie's class is learning
this week. The root board is a 2×3 triangle, two doors up and Play below, everything else black:
- **Watch** [1,1] opens a 3×3 ring of the week's videos (3 to 5) around a black centre, one look plays one.
- **Talk** [1,3] opens the week's words on a 3×4 board, 8 a page, More at [3,1] when there is another page.
- **Play** [2,2] opens the Play page when the week fills an engine; [1,2] is always black, and [2,1]
  then [2,3] are the seats for a fourth and fifth door if one ever comes.

The board's spoken title comes from the manifest's `title`: the root board is named after it and its
first button carries `say_on_load: "This week: <title>"`. A missing title, or one over 24 characters,
becomes "This week".

## Files
- `this-week.js`: pure. Finds the newest week, validates the manifest, builds the recipe and ETag.
- `this-week-fetch.js`: the download rail (the only code that ever talks to YouTube).
- `public/watch/index.html` + `watch.js` + `watch.css`: the watch page (a hub app page; imports `public/play/which.js` for `before`).
- `server.js`: `/recipes/this-week.json`, `/this-week/status`, `/this-week/tick`, the `/this-week/` jail,
  the `downloadWeekVideos` setting, the rail's two triggers.
- `drive.js`: `this-week` in `MIRROR_SUBDIRS`, `MIRROR_DELETES`, `ADOPT_ON_FIRST_SYNC` and `SKIP_EMPTY`;
  `mirrorWeek(week_of)`.
- `public/settings/index.html`: the "This week's videos" card.

## The week folder on Drive
`New ERA Content/this-week/<week_of>/` (`week_of` is the ISO Monday, `YYYY-MM-DD`):
- `manifest.json`: the package, written LAST by the engine's delivery.
- `<id>.mp4` + `<id>.<webp|jpg|jpeg|png>`: the video and its thumbnail, written by a hub, never the engine.
- `claim-<id>.json` `{device, started}`: a hub's download lock, deleted when the job ends. Never served.

The mirror copies the folder to `<DATA>/this-week/<week_of>/`. The hub reads the newest `<week_of>` folder
that holds a parseable manifest; a newer one still mid-write is skipped. `manifest.json` never uses the
keys `cover` or `pages`: `drive.js` would hold such a folder back as an unfinished book, so a manifest
carrying them is refused as broken, not skipped. A zero-byte file (Drive's placeholder while bytes
travel) is never copied down (`SKIP_EMPTY`), so a placeholder never reads as a ready video. A week
folder removed in Drive leaves every device on the next sync.

## The recipe (`GET /recipes/this-week.json`)
- Watch (3×3): Back [1,1], videos in seats [1,2] [1,3] [2,1] [2,3] [3,1] in manifest order, [2,2] black. A ready video
  (`<id>.mp4` with bytes) is a `video` tile with its thumbnail (none on disk: the label carries it).
  A video not here yet is a word tile that says "not here yet" with ⏳.
- Talk (3×4): `talk-1`, `talk-2`, ...: Back [1,1], words in seats [1,2] [1,3] [1,4] [2,1] [2,4] [3,2] [3,3] [3,4].
- Root (2×3): Watch [1,1], Talk [1,3], and Play [2,2] — a `link` tile `{type:"link", href:"/play/?w=<week_of>",
  label:"Play", say:"play", glyph:"🎲"}` — only when the validated `play` has at least one Which item, a
  sort or a Play it; otherwise that seat stays black.
- ETag: `"<manifest mtime>-<size>-<ready bits as hex, watch order>-r3"`, so it moves when a video lands
  (`r2` since the Play door, `r3` since the small boards; `THIS_WEEK_REV` in `this-week.js`).
- No week on disk: a valid root-only 2×3 board, ETag `"none-r3"`. A broken manifest: the same board,
  ETag `"err-<now>"`, and the reason on the console.
- The hub re-checks the engine's rules and drops a failing ITEM (a bad id, minutes outside 1-15, a word
  with no glyph or symbol, more than 5 videos or 16 words), never the page.
- `GET /this-week/<week_of>/play.json` (no-store): that week's Play content, validated by
  `validatePlay()` — `{week_of, title, play: {which[], sort|null, playit|null}, before: {<video id>: item},
  dropped[]}`. Which items: ≤10, unique `id`, `skill` one of the engine's twelve, `q` ≤160, 2-3 choices
  (label ≤40, one emoji glyph, `sound` a string or absent), exactly one `right`. Sort: 2 bins, 4-10 items
  with `bin` 0 or 1. Play it: `answer` an index into the instrument's positions (harmonica and xylophone
  10, string-telephone and shadow-puppet 2). A video's `before` is a Which item. A failing item goes to
  `dropped` with a reason, never the page; no `play` gives empty engines. 404 when there is no such
  week, 400 when `<week_of>` is not `YYYY-MM-DD`. Served above the media jail, which never hands out a
  raw file of that name.

## The download rail (`this-week-fetch.js`)
Triggers: every Drive sync (`drive.onSynced`) and a 20-minute timer. One pass at a time; a tick during a
pass answers `busy`. A pass looks only at the newest week and at videos with no `<id>.mp4` in the Drive
week folder yet. The refusal ladder, in order:

1. `switch-off`: this device's Settings say no. Every missing video gets it.
2. `pack-missing`: no media-tools yt-dlp on this device. Every missing video gets it.
3. `no-folder`: no local Drive folder, or no `this-week/<week_of>` in it. Every missing video gets it.
4. Per video, in manifest order, one job at a time:
   - a video that ended `failed`, `too-long` or `not-mp4` is retried at most once an hour (`RETRY_MS`);
   - `claimed`: another device's `claim-<id>.json` is under 30 minutes old (the newer of its `started`
     and the file's mtime). A claim with this device's own id is a crash leftover and is taken over;
   - otherwise write the claim (keyed by this device's id), look the video up, refuse `too-long` when
     the duration is over 900 seconds (the 15-minute cap), download into `<DATA>/this-week/.tmp/<id>/`
     (killed after 20 minutes), refuse `not-mp4` when it came back in another container, `failed` when yt-dlp
     fails or leaves no bytes;
   - then the thumbnail and the mp4 are copied into the Drive week folder (each through
     `drive.atomically`: a `.part` sibling, then a rename; the mp4 last, since it is the ready signal),
     the claim and the tmp folder are removed, and `mirrorWeek(week_of)` brings it to this device now.

The state words in `/this-week/status`, with the sentence a parent reads in `error`:

| state | means / message |
|---|---|
| `ready` | the mp4 is here with bytes (the files are the truth, whatever the rail last said) |
| `coming` | not here yet and no refusal: waiting for a pass, or downloading right now |
| `claimed` | "Another device is downloading this video right now." |
| `too-long` | "This video is longer than 15 minutes, so it was not downloaded." |
| `not-mp4` | "This video did not come as an MP4, so it cannot play here." |
| `failed` | one of the rail's own sentences, e.g. "YouTube would not let this device fetch that video. It will be tried again later." or "This video could not be downloaded. It will be tried again later." |
| `pack-missing` | "The media tools are not installed on this device, so it cannot download the week's videos." |
| `switch-off` | "This device is set not to download the week's videos." |
| `no-folder` | "This device has no family Drive folder with this week in it, so there is nowhere to save the videos." |

yt-dlp's own words go to the console only. Only a device with the switch on ever contacts YouTube, and
only through the media-tools pack's pinned yt-dlp (argv arrays, the full `watch?v=<id>` url). The board,
the watch page and every other device play the file from the week folder; nothing touches YouTube at
playback.

### Expect 360p
There is no ffmpeg, so the format is `b[ext=mp4][height<=720]/b[ext=mp4]/18`: a single file that already
has picture and sound. YouTube usually offers that only as format 18, 360p. The chosen `height` is
recorded in status and in the pool line. Shipping ffmpeg in the media-tools pack is the follow-up if
360p is too soft.

## The switch
Settings card "This week's videos": "This device downloads the week's videos", Yes / No. Key
`downloadWeekVideos` in `app-settings.json`, default on (only an explicit `false` turns it off). Every
device plays what any device downloaded. Typical setup: home devices on, the school device off (its
network blocks YouTube anyway).

## The watch page (`/watch/?w=<week_of>&v=<id>`)
A hub app page in the same kiosk window (spec §3.3, amended 10/21: "like the music player — another
screen, with pause and back"). A `video` tile navigates here; nothing is launched, nothing can fire
twice, and the page never calls the gaze engine. It wears the shared door bar (🚪 leaves as everywhere;
💬 pauses the video in place, posts `/kiosk/pause` with `/watch/`, and coming back plays it on). Under
the bar a left rail one board cell wide: **Back** (← , to `/board/?recipe=this-week&board=watch`) on top,
**Pause / Play** (⏸ "Pause" while playing, ▶ "Play" while paused) below it, a black rest box; the
`<video playsinline>` fills the rest, `object-fit: contain` on black, `volume = musicVolCap / 100`.
`/settings` sets the dwell (the two doors hold 2×, Back and Pause her dwell), the settle and the 💬.

The mp4 is `/this-week/<w>/<v>.mp4`. When it ends the page logs `ended` and goes to the Watch grid; a
file that cannot play logs `error` and goes there after a second; bad params (`w` not `YYYY-MM-DD`, `v`
not 11 of `[A-Za-z0-9_-]`) go there after a second with nothing logged.

`before` (§5.4): the page reads `play.json`; when `before[<v>]` holds a Which-one item, the Play app's
`which.js` shows it over the video area first (the video loaded, paused and hidden, the Pause tile a rest
box): the question spoken, two-strike and never wrong, the cheer; then the question clears and the video
plays.

Every step POSTs `/log` `{app:"this-week", door:"watch", week_of, id, event, ms}` (`ms` = video played),
`event` ∈ `open|paused|resumed|before|ended|error`; `before` adds `{item, pick, right, strike}`; the lines
that precede a navigation (`ended`, `error`, the 💬's `paused`) go `keepalive`.

## Push a week by hand
From a package folder holding `manifest.json` (and any pictures), files first, the manifest LAST:

```bash
rclone copy ./this-week "family-drive:New ERA Content/this-week/2026-10-12" --exclude manifest.json
rclone copyto ./this-week/manifest.json "family-drive:New ERA Content/this-week/2026-10-12/manifest.json"
```

The next sync on each device mirrors it; a device with the switch on starts downloading.

## Status and a pass now
```bash
curl -s http://127.0.0.1:8377/this-week/status
```
```json
{"week_of":"2026-10-12","switch":true,"pack":{"id":"media-tools","installed":true},"folder":true,
 "running":{"id":"aBcDeFgHiJk","phase":"downloading"},
 "videos":{"aBcDeFgHiJk":{"state":"coming"},
           "bCdEfGhIjKl":{"state":"ready","height":360},
           "cDeFgHiJkLm":{"state":"too-long","error":"This video is longer than 15 minutes, so it was not downloaded."}}}
```
`running.phase` is "looking it up", "downloading" or "saving". `height` shows only on a video this hub
downloaded since it started. To run a pass now instead of at the next sync or timer (loopback only,
403 from any other machine; 202 `{"tick":"started"}`, 200 `{"tick":"busy"}`):

```bash
curl -s -X POST http://127.0.0.1:8377/this-week/tick
```

## Logs
- `<DATA>/logs/<day>.jsonl`: the watch page's lines, `app:"this-week"`, `door:"watch"`, `event`
  `open` / `paused` / `resumed` / `before` / `ended` / `error` (also in the pool as kind `app-log`).
- `<DATA>/pool/events/<device>/<day>.jsonl`: one line per job, kind `this-week-fetch`
  `{id, state, height, ms}` (`height` on `ready` only).
- The console: `[this-week]` lines, with yt-dlp's last stderr line on a failure.
