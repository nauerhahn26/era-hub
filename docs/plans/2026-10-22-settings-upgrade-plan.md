# Settings upgrade plan

Date: 2026-10-22. Branch: `feat/settings-upgrade`.
Status: implemented, tested, landed and released as v1.0.9 on 2026-10-23.

Design and evidence: [settings upgrade proposal](../specs/2026-10-22-settings-upgrade-design.md).
Interactive artifact: [standalone preview](../specs/2026-10-22-settings-upgrade-preview.html).

## Completed preparation

- [x] Read workspace instructions, dev flow and relevant settings code.
- [x] Use parallel reconnaissance for code inventory and primary design sources.
- [x] Inspect the live tablet settings payload through a read-only browser relay.
- [x] Count current cards and quantify the library's contribution to page length.
- [x] Verify local-setting scope, fragment links and position-dependent copy.
- [x] Map every existing card to a proposed destination.
- [x] Build a standalone interactive proposal with synthetic content.
- [x] Complete prototype browser walkthrough and record the result below.
- [x] Obtain maintainer approval of section names, grouping and Books approach.
  Maintainer instruction: “Looks good, please build, test release.”

## Approved implementation

### 1. Add a navigation shell without changing save behavior

- [x] Recheck sibling worktree changes and recent master changes; sync through the
  documented worktree flow if needed. Do not overwrite other feature work.
- [x] Write failing tests for section navigation, browser history, direct links,
  legacy fragments, search results, visible focus and keyboard entry points.
- [x] Add a small destination registry and section shell around stable existing
  controls. Keep each handler attached once. Use logical headings, real links,
  `aria-current`, focus management and a responsive section drawer.
- [x] Preserve local engine requests, setting validation, update timing and APIs.
- [x] Test form and confirmation preservation across navigation and status polls.

Acceptance: every existing control remains reachable; no unintended save,
sync, paid action or engine command occurs solely from selecting a section.

### 2. Separate mixed tasks and connection setup

- [x] Write behavior tests before splitting mixed cards.
- [x] Move weather, wardrobe status and new-photo action beside Clothing.
- [x] Put service credentials in Connections with direct contextual links.
- [x] Keep saved writing in Writing & media and email setup in Connections.
- [x] Keep temporary pause in Eye gaze and complete stop in System; preserve
  existing confirmation and restart guidance.
- [x] Replace positional copy with named destinations; retain relevant price,
  data-use, verification and unavailable-engine information.

Acceptance: all 21 original cards are represented by the design mapping; each
setting has one authoritative form and its real persistence scope is clear.

### 3. Make Books manageable with a growing library

- [x] Write tests with 0, 1, 16 and 100 synthetic books, including readable books
  with uncertain words, active/queued builds, allowances and failed work.
- [x] Implement title search, useful derived filters, sorting, pagination and
  selected-book details. Preserve filters and position when returning from review
  or Connections. Keep empty/no-match states clear.
- [x] Keep build activity and setup separate from library rows.
- [x] Preserve Build confirmation, the single-builder rule, rename, review,
  corrections, partial progress and provider-specific recovery actions.
- [x] Keep stable row identity through polling so focus and active input survive.
- [x] Bound saved-writing lists too; do not create a new endless content section.

Acceptance: a library of 100 books does not extend unrelated settings or require
scrolling through the complete library to find a device preference.

### 4. Verify, document and return for review

- [x] Run targeted settings UI, device-volume, navigation and library suites;
  the full gate below also covers route and reader/book regressions.
- [x] Verify desktop, reference tablet and narrow/zoom-equivalent layouts;
  test keyboard focus, semantic labels and touch target sizes.
- [ ] Verify the real tablet layout through its interactive browser; use an
  isolated test hub or approved preview and do not restart the live hub.
  Physical interaction is deferred: no interactive QA helper is registered on the
  family tablet. A read-only rendering of its actual 16-book payload passed: eight
  destinations, six visible rows, no overflow, zero writes and zero runtime errors.
  Installed Windows browser behavior is checked in the release leg below.
- [x] Run the full gate detached with a PID and sentinel, observing the host-wide
  process safety rules. Address failures before requesting land/release.
- [x] Update the docs nearest changed behavior and the private workspace status
  in the same completion unit. Record concrete screenshots and test evidence.
- [x] Complete the authorized release after the full gate and Windows self-update
  leg pass. The maintainer explicitly requested release on 2026-10-23.

## Research retrospective and current limits

The most useful live evidence was the relationship between the 16-row library
and the controls below it. A sidebar by itself would not make the book workflow
manageable; the library also needs bounded browsing and detail disclosure.
The initial recon overcount of 23 cards was corrected to 21 by the source and
rendered DOM. Scope checking also corrected the tempting but inaccurate claim
that app preferences synchronize with family content.

Actual on-device browser zoom and physical touch navigation remain unverified.
The live-data inspection used a separate browser at a stated reference viewport,
not a physical-screen capture. The original proposal remains a visual decision aid with sample state. The
approved implementation now lives under `public/settings/` and retains the
existing APIs and action handlers.

Prototype verification: the standalone browser walkthrough passed all eight
sections, title search and status filters, six-row pagination, detail dialogs,
global settings search, browser Back, the legacy Books fragment, and layouts at
1368 × 912, 1024 × 768 and 390 × 844. There were zero runtime errors and zero
external requests. The full product gate was not run because production code
was not changed. Research artifact whitespace checks passed.

Implementation checks before the full gate: existing settings UI and device
volume suites 76/76, library 16/16, navigation 9/9: 101/101 together. A separate review found that
Retry stayed disabled in the cached detail after a request settled; a failing
regression was added before repairing the handler. Actual implementation screens
were checked at1368 ×912,1024 ×768 and390 ×844. All eight sections fit the
narrow width without horizontal overflow. Syntax, whitespace and privacy scans
passed. Full-gate and release evidence will be recorded after they complete.

Release preparation: a read-only Settings smoke case was added to Windows leg B.
After self-update it checks the installed layout/styles, eight destinations,
Books setup, volume search, System controls and the legacy Drive link, then
returns to the launcher. No setting is saved and no build is started by it.

Final review also repaired detached Build confirmation labels and retained
library filters/page plus section scroll across full returns from book review.
The new browser regressions failed before the respective fixes and passed after.

Full gate result: **128 suites passed, 0 failed**, over committed implementation
`371b0b7`. The stamp is clean. Targeted settings tests passed **101/101**.
The family tablet live-data check also passed with16 books, six visible per page,
no horizontal overflow, no runtime errors and no write requests. Its private
captures remain outside the repository.

Release authorization is the maintainer's 2026-10-23 request to build, test and
release. Completed patch: **v1.0.9**. Windows self-update/Settings smoke passed and the
release is published.

## Release receipt

- Published [v1.0.9](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.0.9),
  build `20261023.1934`, as a normal patch release.
- Source implementation `371b0b7`; landed as `2d79e9c`.
- Targeted settings tests **101/101**; full gate **128 suites, 0 failures**.
- Windows leg B **6/6**, including the installed Settings navigation/search/legacy
  link smoke case and an actual kiosk screenshot. Self-update preserved the
  profile and chosen packs; the kiosk stayed open.
- All five packaged Settings files match the tested source. The published
  manifest matches the local tested manifest; all six expected assets exist.
- Payload SHA-256:
  `d4160cb5f99669fe9dff42c01fc38f211e9557c1d4205dbd559a244f26296caa`.
- Retained installer `v1.0.0`, `Our-Era-Comms-Setup.exe`, signature verified.
- The release's temporary QA machine was destroyed after publication.
- No manual restart of the live hub was performed. Family-device physical touch
  and zoom acceptance remain a maintainer check; the live-data rendering and
  installed Windows kiosk checks are recorded above.
