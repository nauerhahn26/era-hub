# Music: section rail and play-count order

Requested by the maintainer on 2026-10-31, who approved this description in
chat ("That sounds good. Go for it. Build and publish."). Work spans matching
`fix/music-layout-fixes` worktrees in era-hub and era-board.

## Why

The songs board is one ranked list paged nine at a time, ordered by hand with
Arrange. The library keeps growing. The maintainer wants the book shelf's
shape: a left rail of sections and a 3 x 4 grid, with songs she plays most
moving forward by themselves. Nobody should have to arrange songs by hand.

## Layout

The songs grid takes the book shelf layout
(`docs/specs/2026-09-30-book-shelf-layout-design.md`).

- **Rail**, left column, fixed top to bottom: Back, Favorites, New, Top hits,
  Disney, All. Six dwell tiles fill the grid's height; the current section is
  lit. Back is one page back in the current section, dimmed and dwell-disabled
  on page 1. Choosing a section opens its page 1. The bar's door stays the exit.
- **Grid**, right of the rail, 3 rows x 4 columns. [2,2] and [2,3] are always
  black and inert. More sits at [3,1] when the section has more than one page;
  on the last page it loops to page 1; with one page [3,1] stays black. Songs
  fill [1,1] [1,2] [1,3] [1,4] [2,1] [2,4] [3,2] [3,3] [3,4]: nine a page. A
  short page leaves the unfilled cells black.
- **Song page** is unchanged: picture across three columns, Back / Stop /
  Full song in column four, no rest cells. Its Back returns to the section page
  she came from.
- Contract floors from era-core `lib/contract.js` hold everywhere: gap 14,
  side pad 28, vertical pad 12, text-tile font floor 74 (44 only when
  fit-impossible, marked), dwell = her Settings dwell for every rail and grid
  tile.

## Sections

| Section | Holds | Order |
|---|---|---|
| Favorites | songs with a score above zero | score, high first |
| New | every song | added time, newest first |
| Top hits | `category: "top-hits"` | score |
| Disney | `category: "disney"` | score |
| All | every song | score |

Score order ties break newest added first, then the old manifest `rank`. A song
with no category appears in Favorites, New and All only. An empty section shows
one page of black cells.

## Score

Every pick counts once. A partial play scores 1 and a full play scores 3.

- A pick is a play start: a grid door, a hero replay, or Full song from silence.
- A pick is full when Full song is authorized during it, or when the song ends
  naturally while capped (a song shorter than the clip). Otherwise partial,
  including the 40-second clip running out, Stop and leaving the page.
- Existing history counts: past `music-play` / `music-full` pool events score
  by the same rule where they can be read.

## Sharing across devices

Scores merge across every device the way clothing picks do
(`clothing-log.js`): each hub appends its own pick lines, one writer per file,
under the shared content folder's `music/.era/plays/<device-id>/<YYYY-MM-DD>.jsonl`.
The existing Drive mirror carries them to every device's `<DATA>/music/.era`.
The local canonical copy of this device's own lines stays in `<DATA>`; own lines
coming back through the mirror are skipped on read. A missing mount, read-only
volume or torn line degrades to local-only scores and never breaks the board.
The `music/` mirror must carry and never prune `.era`.

## New songs

- `addedAt` (ISO time) is written into the manifest entry when a song is added.
  An existing song without one uses its audio file's modification time.
- At add time the configured AI helper (`ai-config.js` roles, the same transport
  picture screening uses) classifies the song from its title and source title as
  `top-hits`, `disney` or none. A missing helper or an unclear answer leaves no
  category; the add still succeeds.
- `POST /music/category {id, category}` sets or clears a category under the
  manifest writer lock. The touch-only parent sheet offers it per song.

### Initial categories (the agent's call, for the maintainer to check)

- Disney: How Far I'll Go, You're Welcome, Do You Want to Build a Snowman?,
  Let It Go, Surface Pressure, The Family Madrigal, Into the Unknown, Arabian
  Nights, Show Yourself, I Always Wanted a Brother, Speechless, Hakuna Matata,
  Under the Sea, Beyond, Along the Way, I'm A Star.
- Top hits: Roar, Firework, Golden, Heat Waves, The Fate of Ophelia, Shake It
  Off, Stronger, Broken & Beautiful, Your Song.
- Neither (All, New, Favorites only): Tabby McTat; "Mod case ITX Cougar QBX
  custom liquid cooling 4 Radiators", which looks like a mistaken add.

## Calls made by the agent

- Arrange (manual order) leaves the songs board; usage order replaces it.
- The order is computed when Music opens or its recipe reloads, never while she
  is looking at a page, so tiles do not move under her gaze.
- Full play is "Full song authorized or natural end", as played back to the
  maintainer.

## Non-goals

Genre categories beyond these two, hand ordering, and any change to playback,
clip length, pictures or the song page.
