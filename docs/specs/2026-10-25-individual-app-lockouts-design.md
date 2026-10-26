# Individual app lockouts — proposed design

Date: 2026-10-25. Status: implementation authorized; code prepared in isolated feature worktrees.
Testing and release are explicitly on hold.
Request: every app can be locked individually, using the same shared code and
interaction as Music. This supersedes the media-only scope of the September
media-lock design when approved.

## Behavior

Each app has its own lock. Locking Music does not lock Movies, and locking any
app does not lock another. The default duration remains 45 minutes; Until
unlocked and the existing shared four-digit passcode remain available. A
passcode is recommended in the Settings explanation because a hold alone is
repeatable by someone watching. Do not silently set or change a passcode.

A grown-up holds the touch-only lock button for 1600 ms to lock the current
app. The same hold unlocks it, asking for the configured passcode if set.
Short taps, mouse movement and gaze cannot toggle the lock. Reuse the current
progress indicator, masked keypad and wrong-code behavior. No attempt penalty.

Settings → Apps & navigation provides one row per app, with lock status and
explicit Lock / Unlock actions. This lets a grown-up lock an app without first
opening it and provides a mouse/keyboard management route. Unlock uses the
same shared passcode flow. Keep the duration and passcode settings shared for
this first version; actual lock state and expiry are always per app. Opening
Settings does not change any lock. All apps support locking by default; no
extra opt-in switch is required to use their lock button.

A locked app shows a clear locked message and expiry time, stops its current
activity, and prevents further activity through gaze, touch, keyboard and
programmatic activation handlers. Keep exit and communication doors usable,
in their existing positions. Keep work intact: text, drawings, reading
position, lesson state and game progress are not reset. Unlock makes the app
available without automatically resuming speech, playback, recording or a
pending action. Apply the normal dwell suppression on return.

Locks survive reload, back/forward navigation and reopening in the same
browser profile. Tabs on that origin update immediately through storage events;
the initiating document also updates synchronously. Check expiry on boot,
focus/visibility return and before actions, as well as using a timer. A direct
link to a child page must honor its owning app's lock before starting activity.

This retains Music's device/browser-local deterrent model. Other devices and
separate browser profiles do not share locks. An externally launched movie
cannot be stopped by the web page: locking prevents new launches; closing an
already external player remains a grown-up action. Settings, the home shell,
the gaze engine and the external communication program remain accessible.

## App coverage and ownership

| Lock ID | App and all included surfaces | Source owner |
|---|---|---|
| making-words | Making Words, lesson and practice screens | era-making-words |
| pencil | The Pencil, predictions and saved-writing views | era-pencil |
| board | Clothing Picker, full wardrobe and accessories | era-board |
| music | Songs chooser, player and full-song actions | era-board |
| movies | Movies, shows, episodes and launch actions | era-board |
| this-week | Weekly board, /play/ activities and /watch/ video | era-board + era-hub |
| reader | Reader shelf, open-book and reading screens | era-hub |
| drawing | Drawing, scene editing and partner interactions | era-hub |
| math | Math menus, Numbers and Number partners | era-hub |
| games | Games menu and each game | era-hub, integration branch |
| chat | Chat, capture, choices and speech | era-hub, integration branch |

Resolve board identity from the recipe/root ownership, not the current tile
or page name. Carry This week ownership to activity and video deep links.
Encoded entry paths and malformed recipe names follow the runtime’s own
normalization; unsupported recipe names do not identify a supported app. Test
all supported entry routes against a central identity table.

## Shared implementation

Put the browser lock controller, state validation, expiry, hold gesture, keypad,
banner and styling in era-core/lib/app-lock.js and a companion stylesheet.
Expose a small instance API: read/isLocked, lock, requestUnlock, subscribe,
mountControl and dispose. Use the same module from Settings and all apps;
plain-script apps can use their existing module-to-window boot pattern.
The door bar supplies a partner-strip mounting seam, preserving door geometry.
Board-specific code becomes an adapter; remove its duplicate state/keypad logic.

App adapters provide synchronous action guards and lifecycle callbacks to stop
activity and invalidate outstanding asynchronous work. A visual overlay alone
is insufficient. Locks must compose with pause, partner sheets and arrange
mode: releasing one reason must never release another. Prefer recomputing
interaction availability from all active reasons over restoring stale classes.
The shared module must not import an app's renderer or global player.

Use one versioned localStorage key per app, for example era.app-lock.v1.music,
with validated {until} values. Separate keys avoid concurrent writes losing
another app's lock. Unknown versions and malformed records get defined,
tested recovery behavior; failed storage writes must report that persistence
failed rather than claim a durable lock. Preserve the active in-page block.
Do not persist passcode digits or log passcode entries.

Migrate the legacy era.lock once to Music, Movies and This week with exactly
its existing expiry, preserving any stronger existing lock. Keep the legacy
key until all replacement records are successfully written, then remove it.
All new consumers ignore the legacy key after successful migration. Cover
expired, indefinite, malformed and partially written migrations. This preserves
existing restrictions while allowing subsequent independent unlocks.

Keep existing lockMinutes and lockPasscodeHash settings compatible. Changes to
settings refresh controller configuration on Settings return/focus before an
unlock; use the existing four-digit runtime behavior, not the older 4–6 digit
proposal. New locks use the latest duration; active expiry does not change.

## Coordination and limits

Implementation is authorized in isolated feature worktrees. No tests, live
restart, landing, device delivery or publishing may run until further instruction. Chat/Games integration gates freeze shared
sources. Testing suite must coordinate the baseline, gate slot and any shared
file changes before implementation touches those sources or any landing.
Relevant overlaps: server.js, docs/dev-flow.md, payload and gate tooling,
app registry tests; era-core also overlaps Chat/Games/Math/Speech readiness;
era-board overlaps Chat/Games/Testing suite/Clothing/Music; Pencil overlaps
its dwell work. Check current committed AND uncommitted sibling diffs again
at implementation kickoff. Do not alter sibling worktrees.

Implementation detail: cached duration and passcode hash support offline use.
Interrupted transitions can register an explicit Continue action with the shared
controller; unlocking alone never invokes that action.
