# Book shelf layout — sidebar sections + 3×4 centre-black grid (dad, 2026-09-30)

Status: **approved by dad 9/30** ("This is good … proceed to build. Story books is good.")
**Built 9/30 on feat/book-layout** — hub: `books-shelf.js` (first-seen + favorites
stores in the data dir), `POST /books/<slug>/favorite`, `favorite`/`firstSeen`/`weekOf`
on `/books/index.json`; reader: `public/reader/reader.js` renderShelf (header comment),
`index.html` rail + grid, `reader-share.js` two-choice hold sheet; tests:
`tests/reader-shelf.test.mjs` (the page's laws) + updated reader-ui/sizing/share/strip/books.
Interpretations: "alphabetical" = plain `localeCompare(…, {sensitivity:"base", numeric:true})`,
no article stripping; "remember across a reload" = a navigation of type `reload` restores
section+page, a fresh open lands on This Week (Storybooks when This Week is empty, re-made
while the shelf is untouched and the shown section is empty); All lists books only (cards
still being built live in Storybooks); an import jumps the shelf to its Storybooks page.
Scope: the SHELF screen of the Book Reader (`public/reader/`) plus the small hub
support it needs. The READING screen does not change.

## Why
She has too many books for one scrolling shelf. Dad wants the shelf to look like
her TD Snap board: a left rail of sections, and the books in the same 3×4
centre-black grid her clothing pages use, with More to page through.

## Layout (approved mockup)

```
┌──────────────── door bar (unchanged, top) ────────────────┐
├─────────┬────────┬────────┬────────┬────────┤
│ ◀ Back  │ book   │ book   │ book   │ book   │   row 1
├─────────┤ [1,1]  │ [1,2]  │ [1,3]  │ [1,4]  │
│ ⭐ This  ├────────┼────────┼────────┼────────┤
│   Week  │ book   │ BLACK  │ BLACK  │ book   │   row 2
├─────────┤ [2,1]  │ [2,2]  │ [2,3]  │ [2,4]  │
│ ♥ Favor-├────────┼────────┼────────┼────────┤
│   ites  │ More ▶ │ book   │ book   │ book   │   row 3
├─────────┤ [3,1]  │ [3,2]  │ [3,3]  │ [3,4]  │
│ 📚 Story│        │        │        │        │
│   books │        │        │        │        │
├─────────┤        │        │        │        │
│ All     │        │        │        │        │
└─────────┴────────┴────────┴────────┴────────┘
```

### Rail (left column, TD Snap sidebar idiom — best-practices §1.6: her live rail
top→bottom is Help, **Back**, Core Words, …; ux-contract: **Back top-left**)
Top→bottom, fixed, never moving: **Back**, **This Week**, **Favorites**,
**Storybooks**, **All**. Rail tiles are dwell targets (plain `dwell`, §C), smaller
than book tiles, like TD Snap's rail. The current section's tile is visibly lit.
The rail never scrolls; five tiles fill the grid's height.

- **Back** = one page back in the current section. Dimmed + `data-dwell-disabled`
  on page 1. It is navigation, not an exit — her exit stays the bar's 🚪 door.
- Choosing a section opens its page 1.

### Grid (clothing-worker.js `SLOTS` + [3,4], ux-contract anchors)
- 3 rows × 4 columns right of the rail.
- **[2,2] and [2,3] are ALWAYS black** — inert, no label, no action, no text,
  never a target (board-design law; dad 9/3 in caps).
- **More at [3,1]** (bottom-left — dad's law, same cell as the outfit pages;
  ux-contract "More bottom-LEFT"). Shown only when the section has more than one
  page. On the last page More loops to page 1. When there is only one page,
  [3,1] stays black — cells never move.
- Books fill, in reading order: **[1,1] [1,2] [1,3] [1,4] [2,1] [2,4] [3,2]
  [3,3] [3,4]** → **9 books a page**. A short last page leaves the unfilled cells
  black.
- A book tile = its cover with the title under it (as the shelf shows today),
  keeping the existing coral rim / "…'s story" badge for authored books and the
  "From a friend" badge for imported ones, and the not-yet/building/pile cards.

### Sections and sort
| Section | Holds | Order |
|---|---|---|
| This Week | weekly books: `authored === true` AND not imported | newest week first |
| Favorites | books she has been given a ♥ | alphabetical by title |
| Storybooks | everything else: scanned/hub-built books (`authored !== true`) AND books from a friend (imported, keep the badge) AND cards still being built | alphabetical |
| All | every book | alphabetical |

Alphabetical = case-insensitive, locale compare on the displayed title
(`localeCompare(…, undefined, {sensitivity:"base", numeric:true})`), ignoring a
leading "The "/"A "/"An " is NOT required (keep it simple, plain title order).

**"Newest week" needs a stable date.** A manifest's `exportedAt` moves every time
the hub re-publishes a book (review edit, rename, every Animate clip —
content-publish.js), and the weekly maker (ellie-this-week `book/assemble.py`)
writes no week field. So the hub keeps its OWN first-seen record: a map
slug → ISO timestamp of the first time the shelf index saw that package, stored
in the hub's data dir (NOT under `<DATA>/books`, which is the Drive mirror's).
Seed on first sight with the manifest's `exportedAt` when present (so today's
existing books order sensibly), else now. Never rewritten afterwards. Expose it
on `/books/index.json` as a field (e.g. `firstSeen`). If a manifest ever carries
an explicit `weekOf`, prefer it (forward-compatible; the maker may add it later —
not in this feature's scope).

### publishedAt (dad 9/30)

Every manifest, of any type, carries `publishedAt` (ISO 8601 UTC): when the book
was FIRST published. `content-publish.js` writes it once and never rewrites it
(`exportedAt`, by contrast, moves on every re-publish). It is read back from the
manifest being replaced; a manifest from before the field seeds it from its own
`exportedAt`; only a book with no history is dated by the publish itself.
`weekOf` (optional "YYYY-MM-DD") is written by the weekly maker only; the hub
carries it through a re-publish and never invents it. Imported `.erabook`
manifests travel byte for byte, so the sender's values ride along.

`/books/index.json` rows carry `publishedAt` (null when absent). **This Week
sorts by `weekOf` desc, then `publishedAt` desc, then the hub's `firstSeen` desc
(old manifests with neither), ties alphabetical.** The first-seen store stays as
that fallback.

Default on opening the reader: **This Week, page 1** — the newest weekly book
at [1,1]. If This Week is empty, open Storybooks.

### Favorites
- Toggled by the grown-up **finger hold on a cover** — touch-only, never a gaze
  target, never a dwell element (board-design law amendment 9/4). The hold
  already opens book sharing's "Send" sheet (reader-share.js, spec 2026-09-22):
  that ONE hold now opens ONE sheet with two touch buttons — **"♥ Add to
  Favorites" / "♥ Remove from Favorites"** and **"Send to a friend"** (which
  continues into the existing send flow unchanged). Finger-hold laws from
  v0.36.1 stand (tile gets `touch-action:none`; ux-contract §A; the drift tests
  in reader-share must stay green).
- A favorited cover shows a small ♥ badge (corner that no other badge uses).
- Stored on the HUB (survives a browser reset), keyed by slug (slugs are stable
  for life — books-index.js), in the hub data dir, not the Drive-mirrored books
  dir. A slug whose book is gone is simply ignored. Route shape follows the
  existing book routes' conventions and guards (see how `/books/import` is
  guarded). `/books/index.json` carries `favorite: true|false` per book.
- Empty Favorites: grid cells all black except what the rules above place; a
  muted, inert, non-dwell one-line note OUTSIDE the grid cells (never in the
  black centre) says "Hold a book's cover to add it to Favorites."

### Returning from a book
The reader's Library button returns to the SAME section and page she opened the
book from. Remember section+page across a reload (localStorage, try/catch).

## Out of scope
The reading screen; the weekly maker (no ellie-this-week change); cross-device
favorite sync; TD Snap.

## Tests (must land with the change; gate green)
- Section membership + sort (incl. first-seen stable across a re-publish that
  bumps exportedAt).
- Grid geometry: 9 book cells in the listed order, [2,2][2,3] black and inert on
  every page, More only at [3,1] and only when >1 page, looping.
- Rail order Back/This Week/Favorites/Storybooks/All; Back dimmed on page 1.
- Favorite toggle via the hold sheet; badge; persisted on the hub; survives reload.
- Library returns to the same section/page.
- Existing reader-ui / reader-sizing / reader-share / reader-strip / books suites
  updated where the old one-grid shelf is asserted, never weakened.
- Doc nearest the change (reader docs / ux-contract pointer) updated in the same
  commit.
