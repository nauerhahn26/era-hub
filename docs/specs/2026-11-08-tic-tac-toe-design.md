# Tic-tac-toe in Games

The maintainer requested a complete tic-tac-toe game on 2026-11-08 and
authorized testing and production publication with the existing Games app.

Tic-tac-toe is the first of four choices in `/games/`. The menu keeps Fashion
Studio, Four in a Row and Number Tiles available. A fixed three-by-three grid
contains nine large square commands. Empty squares show numbers 1–9 in reading
order. A completed selection places X or O. Occupied squares retain their
position and show their mark. This game's squares are direct commands, an
exception to the passive boards of the other two board games.

Two players alternate X and O. A computer mode lets the player place X first
and the computer place O. The computer takes a winning square, blocks an
immediate loss, then prefers the centre, a corner and another available square.
All eight three-in-a-row lines win. A full board without a winner draws.
The result remains until an explicit action. Undo restores the previous turn,
including both moves of a completed computer round. Restart and changing
opponents during a game ask before clearing it.

Use the existing dwell engine, doubled-duration Exit and Talk doors, black
rest area, move-to-rearm and page-settle rules. Touch uses the same actions.
Command elements remain stable through moves. Occupied squares, a pending
computer turn and a finished board disable placement. Talk, hiding, app lock
and navigation suspend computer activity. No response deadline or new audio
is introduced. Verify readable 74-pixel command marks, 14-pixel gaps and
unobscured controls at 1280×720, 1280×800 and 1920×1080.

Tic-tac-toe has an independent workspace in the version-one Games save.
Older valid saves that lack it receive an empty game while retaining all
existing workspaces. A malformed supplied game uses the existing protected
recovery flow. Saving uses the real hub endpoint and truthful acknowledgement.
Whole-browser restart must restore the saved game and existing progress.

Acceptance includes exhaustive legal rule coverage, old-save migration,
browser journeys with actual shared dwell, the complete integration gate,
and Windows patch self-update followed by installed Games acceptance on the
same payload. Publication must preserve the exact tested artifact bytes.
