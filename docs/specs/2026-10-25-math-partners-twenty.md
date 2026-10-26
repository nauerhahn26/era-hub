# Number partners picker through twenty

The maintainer's first installed trial worked. The picker made ten needlessly
difficult to reach: the first page offered 0–9, while Other numbers eventually
offered ten alone. Put ten on the first page and use the next page for 11–20.

Number partners now offers whole quantities 0–20. The first picker page contains
0–10 inclusive, using eleven numeral seats in the existing sixteen-seat grid.
Back stays top-left and Other numbers stays bottom-left. The literal bottom-right
seat stays black and inert. Other numbers switches directly between 0–10 and
11–20; there is no intermediate range chooser for these two pages. Pick a number
opens the page containing the current whole. Back returns to the workspace and
preserves its existing partition. Selecting a new whole retains the predictable
initial partition used by the first release.

The Numbers workspace retains its 0–50 range and existing decade picker.
Number partners still shows a single inventory divided between two parts.
A part above ten uses two structured frames, so 0 + 20 and 20 + 0 show every
counter. Counting continues across the full inventory without duplicate indexes.
Command positions, dwell rearming, the shared doors and speech interruption
remain part of the existing interaction contract.

Keep saved state version 1 compatible. In the old partner picker, range start
ten meant a page containing only ten; restore it on the new first page. An old
partner range-chooser view becomes a picker rather than reviving a removed
screen. Preserve valid quantities and partitions during this normalization.

Validation covers every partition through twenty, both direct picker pages,
reload and cancellation, saved-state compatibility, and visible counters at
1920×1080 and 1280×720, including both extreme partitions of twenty. Ship through
the existing suite patch process after a fresh green gate and Windows update leg.
