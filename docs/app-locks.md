# Individual app locks

Released in v1.0.24. Validation and release receipts are recorded in the linked
implementation plan.

Hold the lock in an app's top bar with a finger for 1.6 seconds to lock that
app. Hold it again to unlock. Settings → Apps & navigation → App locks also
provides a separate Lock/Unlock button for each installed app, including mouse
and keyboard access for grown-ups. A short tap or gaze does not toggle the
in-app control.

Music, Movies, Clothing Picker, This week, Reader, Drawing, Math, Games, Chat,
Making Words and The Pencil each have an independent lock. Weekly activities
and videos belong to This week. One app's lock does not prevent using another.
Exit and communication doors remain available, and keep their existing positions.

Duration and the optional four-digit passcode are shared settings. Duration
changes apply to new locks. The default is 45 minutes; Until unlocked has no
time limit. A passcode is recommended when someone can copy the hold. Opening
Settings does not lock or unlock an app.

Locking stops current app activity and blocks new input. Work is retained.
Unlocking does not restart playback, recording or speech. Interrupted lesson
transitions and Reader videos may show Continue; that explicit action resumes
the interrupted transition. Other activity remains available through its usual
controls. Partner pauses remain separate from locks.

Locks survive reopening and reload in the same browser profile. Open tabs on
the same origin update together. Other devices and browser profiles have their
own state. The most recently loaded duration and passcode hash are cached for
offline use; no passcode digits are stored. A profile with no cached settings
must load Settings successfully before it can verify an unlock.

A storage failure is reported. An in-memory lock can still block the current
window, but cannot promise to survive closing it. This is the same browser-local
deterrent model as the original Music lock. An already external movie player
must be closed separately; its locked chooser cannot launch another movie.

An old combined media lock migrates to separate Music, Movies and This week
locks with its existing expiry. Unlocking one of those new locks leaves the
others locked. Existing longer or indefinite locks are preserved.

Shared mechanics live in era-core's `lib/app-lock.js`, `app-lock-state.js` and
`app-lock.css`. Every app uses the shared door bar; app-specific hooks only
stop its activity and guard its action handlers. Settings uses the same
controller. Shared files are included through the existing core payload copy.

Design and implementation record: [design](specs/2026-10-25-individual-app-lockouts-design.md)
and [plan](plans/2026-10-25-individual-app-lockouts-plan.md).
