# Games and Fashion Studio

The maintainer approved both implementation tracks on 2026-10-25 after
reviewing the research and seven fashion layout sheets. Finished fashion art
should be polished illustrated 2D. The first delivery is a local Games app,
with adapted 2048, Four in a Row, and the first complete Fashion Studio loop.
Publication and device delivery remain separate maintainer decisions.

## Play

Games opens at `/games/` and rides with the core payload. Its three large
choices are Fashion Studio, Four in a Row, and Number Tiles (2048). A separate
partner-only area links to the researched hosted games and explains their
setup. Hosted canvas games do not inherit the hub's HTML dwell. No hosted
game is labelled gaze-verified from a successful mouse action alone.

Four in a Row has seven fixed column commands and a passive board. Support
local turn-taking and a computer opponent, legal gravity, four directions of
winning, draws, Undo, and confirmed restart. The computer's pending turn
cannot fire while hidden or paused for communication.

Number Tiles adapts the original MIT-licensed 2048 movement rules. Its board
is passive and four fixed direction controls replace mandatory swiping.
Preserve the upstream attribution and license. Undo restores the board and
random state; an ineffective move neither spawns a tile nor consumes a turn.
Restart is confirmed. Winning permits continued play. No response deadline.

Fashion Studio supports the complete create-to-show loop:

1. Studio: resume the draft, make clothes, style a model, or open the collection.
2. Workbench: independently choose garment shape/sleeves, color, pattern and
   detail. The character is a passive preview. Edits are reversible.
3. Options: four large choices with stable paging, Back and Undo. A completed
   choice applies the edit and returns predictably; looking never previews an
   unselected option. Decoration uses prepared positions, without dragging.
4. Styling: choose bottoms, shoes, hair and model variation through large
   cards. Clothing layers fit automatically. Start with one coherent body rig.
5. Collection: keep three editable outfit snapshots. Editing starts a copy.
   Replacement or removal is explicit and confirmed; recovery has no timeout.
   Selecting and ordering looks uses commands, never small drag handles.
6. Stage setup: select a venue, optional original music and model order.
7. Show: a short entrance and pose using the chosen outfit. Next model, Pose,
   Encore and Pause are deliberate commands. A completed pose holds for the
   next choice. Talk preserves the exact outfit, lineup and position.

Drafts, completed looks and game progress persist locally. No account,
network, external generation key or subscription is needed in local play.
The local save lives in the hub's `ERA_DATA_DIR/games/state.json`, beyond the
kiosk browser's InPrivate lifetime. `GET /games/state` reads it before Games
becomes ready; `PUT /games/state` accepts only a bounded, valid versioned model
from the hub's own page and atomically replaces the file. A missing file permits
one migration of a valid older browser save. An unreadable durable file remains
untouched and can be exported for recovery; Games stays usable without claiming
new work was saved. The visible save status says Saved only after the latest
write is acknowledged. Exit waits briefly for an in-flight write, then leaves
even if the hub cannot answer. Talk still takes the immediate communication path.
New wardrobes, pets, larger collections and richer choreography follow the
first complete loop rather than appearing as unavailable child choices.

## Access and presentation

Reuse the actual shared doorbar and dwell engine. Exit is top-left and Talk
is centered; both use twice the user's dwell. Ordinary commands use the
user's normal dwell, with tracking-loss freeze, grace, move-to-rearm and
page-settle suppression. Touch and gaze reach the same action handlers.
Partner setup never has `.dwell` activation. A literal inert black region
includes the bottom-right corner in every child view.

Keep learned commands stationary. Update passive game content without
recreating unchanged command elements after every move. Body command labels
target 74 logical pixels, gaps are at least 14 pixels, and required text is
never hidden by clipping. Validate at 1920×1080 and 1280×720, including zoom
and reduced motion. Any smaller passive board numerals need an explicit
fit exception and must stay readable. There is no blanket sixteen-target
board: cells, clothing and characters are passive.

Speech is interruptible and never locks input. No confirmation beeps or
automatic narration of every board cell. Game outcomes are calmly described;
there are no buzzers, correctness colors, compulsory celebrations or timers.
Music starts only through the selected show action and stops/pauses on
navigation, Talk and hiding. Reduced motion preserves every decision.

The original character rig and garment masks must support independent edits
and consistent poses. Illustrative raster backgrounds may support the studio
and stage; no important command is baked into an image. Public artifacts
contain no private profile, family images or copied commercial game art.

## Module contract

`public/games/state.js` exports `STORAGE_KEY`, `CATALOG`, `createState()`,
`restoreState(raw)`, `serializeState(state)` and immutable `reduce(state,
action)`. Actions are objects with a `type` string and catalog-bounded data.
The state has `version: 1`, top-level `view` (`menu`, `fashion`, `connect4`,
`tiles`, `credits`) and independent `fashion`, `connect4` and `tiles` state.
Fashion has its own `view`, `draft`, `looks`, `selectedLookId`, `lineup`,
`show` and bounded recovery history. No renderer depends on arbitrary URLs or
saved markup. The model owner coordinates detailed action names with the UI
and browser-test owners before implementation.

The child UI uses stable `data-action` attributes and catalog `data-value`
attributes. `window.GamesApp.state()` exposes a defensive readback for
regression checks; mutation hooks exist only when `window.__testHooks` is set.

## Evidence and limits

Research established a complete ordinary-pointer turn in the public
[Four in a Row client](https://prod.games.eyegazegames.com/?game=connect4).
Its standalone gaze setting was off and the official parent supplied setup.
The hosted [Golf controls](https://gameaccess.info/gazey-golf-eye-control-options/)
document Classic selection, but its Demo is a video. These are partner setup
references, not locally redistributed games.

[Pinkamagine Fashion](https://pbskids.org/games/play/pinkalicious-fashion-game/66548)
accepted clothing, length, color, pattern, decoration, crown and background
choices with ordinary clicks and pointer movement. Its decoration behavior
depends on touch detection. Photo setup was observed; final photo payoff was
source-reviewed only. No open redistribution license was established for its
code or artwork. Do not copy it into this app.

Reusable sources include [2048](https://github.com/gabrielecirulli/2048),
[MIT dress-up layering](https://github.com/gamelab/Zoe-Dress-up-Blueprint),
and [modular character art](https://kenney.nl/assets/modular-characters).
License each incorporated source separately. A successful browser test does
not establish actual device access, enjoyment or independent use.
