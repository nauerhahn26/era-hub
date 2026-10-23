# Settings upgrade: research and proposed design

Date: 2026-10-22. Approved for implementation, testing and release on 2026-10-23.

Worktree: `era-hub--wt-settings-upgrade`; branch: `feat/settings-upgrade`.
The maintainer approved the design and requested build, test and release. The standalone
[interactive preview](2026-10-22-settings-upgrade-preview.html) uses invented
content and never connects to a hub. Implementation checklist:
[settings upgrade plan](../plans/2026-10-22-settings-upgrade-plan.md).

## What the current page does

The settings page serves adults using touch or a mouse. It is distinct from the
child's gaze-controlled app grids. Its current title, ERAgaze, understates its
scope: it now manages apps, books, media, writing, services and device preferences.
The proposed title is **Our Era Settings**, with Eye gaze as one section.

An exact inventory of `public/settings/index.html` finds **21 top-level cards**.
They appear in a single column with no section navigation or settings search.
Books and saved writing add rows as content grows. The initial reconnaissance
estimate of 23 cards was corrected by counting the top-level markup and live DOM.

The live family tablet's settings HTML and read endpoints were inspected through
an SSH forward. The actual tablet data was rendered in a separate browser, with
all non-GET requests blocked. The interactive device screen was not captured or
operated: no existing debug browser was available. Its actual browser zoom and
viewport were not established. A remote service session's display dimensions are
not reliable evidence of the interactive display.

At a **1368 × 912 CSS-pixel reference viewport** the live page measured:

| Observation | Measurement |
| --- | --- |
| Entire page | 11,066 pixels tall, about 12 viewport heights |
| Books | 16 rows; card 3,031 pixels tall |
| Books card starts | About 3,357 pixels down |
| Shared app dwell control starts | About 7,783 pixels down |

These are browser-rendering measurements at a stated reference size, not a claim
about the exact number of swipes on the physical tablet. Private captures and
content remain outside this public repository. The preview reproduces the scale
with 16 invented book titles and deliberately varied sample statuses; those
statuses are not a report of the family's live library.

The read-only browser blocked one attempted Drive sync POST from page loading.
This is another reason a design preview must be separate from the live page.

## Research findings and their application

### Shallow navigation with persistent orientation

Windows navigation guidance recommends clear, familiar destinations, avoiding
deep hierarchies, and left navigation for more than five top-level items. It also
supports combining top-level pages with local detail navigation. These principles
support a fixed section list and a separate main pane, with at most one additional
level for things such as book setup. The eight proposed section names below are
our design judgment, not a source-prescribed taxonomy.
[Source: Windows navigation basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics).

Apple's sidebar guidance similarly limits hierarchy and emphasizes the space a
sidebar consumes. We should therefore retain the labeled left sidebar at desktop
and tablet widths, and use an explicitly opened section drawer when it would make
the content too narrow. The preview uses 760 CSS pixels as a provisional
breakpoint, to be checked against the physical device during implementation.
[Source: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars).

### Navigation plus search, rather than navigation alone

The VS Code settings editor combines grouped settings with search and links to
specific settings. Applying those ideas here means a simple search box for words
such as volume, weather, dwell, books, email or passcode. Results show both the
control name and its section. This does not require developer-style search syntax,
scope tabs, or a new settings service.
[Source: User and workspace settings](https://code.visualstudio.com/docs/configure/settings).

### Keep lists manageable and reveal detail on demand

Windows describes a list/details pattern for browsing items and taking actions on
them. This suits the existing book library: show a title, brief status and next
action, then reveal the current review, rename, build or recovery actions for the
selected book. Setup explanations and service keys should not repeat between book
rows. Search, status filters and pagination are our application of this pattern.
[Source: List/details guidance within navigation basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics#listdetails).

### Preserve adult touch and keyboard access

WCAG 2.2's minimum pointer-target criterion is 24 × 24 CSS pixels, with specified
exceptions. For this adult-facing tablet interface we propose at least 44-pixel
controls, readable labels, visible keyboard focus, semantic navigation and main
landmarks, and a skip link. This is a design target above the minimum, not a claim
that every control must meet a child gaze-grid specification.
[Source: Target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum),
[Source: Focus visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible),
[Source: Landmarks and headings](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/landmarks-and-headings).

## Proposed section map

The sidebar has three small, noninteractive group labels and eight destinations.
Books is a first-class destination because it is already a substantial manager.
No app, book, provider or individual preference becomes another top-level sidebar
item. Always expose the same sections; explain an unavailable feature within its
section instead of making its destination move or disappear.

| Sidebar group | Destination | Contents |
| --- | --- | --- |
| Comfort & control | Eye gaze | Dwell, Pencil dwell, page-change pause, cursor feel, look-away forgiveness, cursor visibility, temporary pause |
| Comfort & control | Voice & sound | Speaking voice, speaker cap, music volume cap; link to voice connection |
| Comfort & control | Apps & navigation | App visibility and shortcuts, exit/talk destination, media lock duration and passcode |
| Content | Books | Searchable library, build activity, book setup and explanatory help |
| Content | Clothing & weather | Outfit preparation, favourites/accessories status, clothing-photo action, weather place and hours |
| Content | Writing & media | Saved Pencil writing, film/show guidance, weekly-video download preference; links to related services |
| This computer | Connections | Drive, AI helper, recorded voice, writing email, moving pages, film lookup and region |
| This computer | System | Updates and version, complete gaze-engine stop with restart guidance |

There is no new overview dashboard in this proposal. It would repeat information
without yet demonstrating a useful task. The normal initial page can be Eye gaze;
explicit fragments and the remembered last section take precedence. The preview
starts at Books to show the motivating problem. A final initial-page policy is an
implementation detail to confirm with the maintainer.

### Every existing card accounted for

| Current card or nested region | Destination after reorganization |
| --- | --- |
| Apps | Apps & navigation; destructive file removal remains deliberate and separate from hiding an app |
| Updates | System |
| Voice | Voice choice in Voice & sound; key and allowance in Connections, with useful status/link beside voice choice |
| Her writing from The Pencil | Writing list in Writing & media; email setup in Connections |
| Add content with Drive | Folder and sync in Connections; clothing-photo action and weather controls in Clothing & weather |
| AI helper | Key, provider and data-use explanation in Connections; clothing progress, picks and accessories in Clothing & weather |
| Your books | Books |
| Moving pages | Connection in Connections, with contextual entry from Books / Book setup |
| Films and shows | Feature explanation in Writing & media; keys and region in Connections |
| Where the door goes | Apps & navigation |
| This week's videos | Writing & media |
| Dwell time | Eye gaze |
| Alternative Pencil dwell time | Eye gaze |
| Page-change pause | Eye gaze |
| Cursor feel | Eye gaze |
| Look-away forgiveness | Eye gaze |
| Cursor visible? | Eye gaze |
| Volume cap for this device | Voice & sound |
| Music volume cap | Voice & sound |
| Lock | Apps & navigation |
| Pause eye-gaze (testing) | Temporary pause in Eye gaze; complete stop and restart guidance in System |

### Books has three local views

**Library** opens with a title search, sort, meaningful status filters and a bounded
list. Six rows per page is the preview value; keep it configurable by layout rather
than making a new server requirement. Results show total matches and clear
previous/next controls. Avoid a small nested scroll box inside the main pane.
Each book's detail contains its existing actions and recovery explanation.
Show progress and failures in text as well as colour. A book can be readable and
still have uncertain words, so Ready and Needs review are not mutually exclusive
backend states. Filters should be derived from the existing payload accordingly.

**Build activity** shows active, queued and waiting work and identifies which
computer is doing it when the existing payload establishes that. Preserve partial
work, user corrections, cloud claims and the single-builder rule. Never imply that
opening the section starts a paid build. Existing armed/two-step Build behavior
remains intact, and money-related explanations remain adjacent to the action.

**Book setup** holds short instructions, useful connection status and links to the
authoritative setup form. Detailed costs and preparation explanations can be
expanded when needed. A connection failure links directly to the service that
needs attention, replacing references to a card above.

The working assumption is library management inside Books, rather than a separate
application. The maintainer approved the integrated Books approach with the overall design.

## Behavior and scope that must survive

- **Setting scope is factual.** `app-settings.json` belongs to each hub's local
  data directory (`server.js:1701,1789,1849`). Drive mirrors content, not that file.
  Shared across apps does not mean shared across computers. Speaker cap talks to
  the browser's local gaze engine. Existing dwell changes also attempt a separate
  Book Reader profile mirror (`server.js:1453–1477,1859`). This redesign must not
  change that behavior or invent a family-wide preferences layer.
- **One authoritative form per setting or key.** A feature shows meaningful status
  and a link to its connection. Do not maintain duplicate key inputs on multiple
  pages. Keep verification, provider data-use explanations and applicable costs.
- **Keep existing URLs working.** Preserve fragment entry points, especially
  `#content` and `#integrations`, used by reader and import flows. Resolve old
  fragments to a section and its control before moving focus. New canonical
  fragments may coexist with aliases. The preview demonstrates aliases for all
  existing top-level card IDs.
- **Keep browser history useful.** Section and subview navigation support Back,
  Forward, reload and direct links. Preserve list filters, pagination, scroll and
  unsaved forms when visiting a related connection and returning. The preview
  demonstrates navigation, but not production form persistence.
- **Do not recreate live controls on every status poll.** Keep stable DOM nodes,
  focus, in-progress key checks, pending inputs and confirmation state. Section
  changes must not cancel book work. Fetch/poll expensive detail only when its
  section needs it, while keeping active-job summaries accurate.
- **No position-dependent directions.** Replace user-facing references to cards
  above/below at `public/settings/index.html:341,1209,1236,1243,1611` with named
  links or accurate same-section copy. Preserve short inline explanations.
- **Failure and empty states remain reachable.** No engine, old engine, no Drive,
  missing key, disconnected network, waiting allowance, a building book, an empty
  library, and no saved writing each need a helpful action or explanation.
- **No server migration required for the proposed shell.** Reuse existing APIs and
  save behavior. No release, tablet installation, live hub restart or backend
  rework is part of approving this research artifact.

## Overlap and implementation risks

Sibling feature branches for Alternative Pencil dwell and volume control touched
the settings page and settings routes; update cadence touched routes and updater
behavior. Relevant changes appear in the starting branch, but recheck git state
before implementation. Other content branches can add controls or fragments.
Reconcile current changes rather than copying an old settings file wholesale.

The main risk is losing behavior while splitting the large inline script. Land
the navigation shell and stable destination registry first, with the original
controls preserved, then separate mixed cards and improve the book list behind
behavioral tests. The public source and tablet payload can differ, so validate
against both the checkout and a rendered live-data view. Existing exact-text UI
tests require deliberate updates when explanatory copy moves.

## Preview boundary and validation

The standalone preview shows all eight destinations, global search, book title
search, filters, pagination, book details, setup links, editable sample controls,
old Books links and narrow-screen navigation. It contains no real book titles,
account details, credentials, locations or device identifiers. Changing sample
values has no effect on a running product. It does not implement real builds,
review, narration, sync, updates or device control.

The browser walkthrough covers these journeys at desktop, 1024-pixel tablet and
390-pixel phone widths. A preview check is not the product gate. The full gate,
physical-device browser check and regression states are required later for the
implementation, after design approval.

## Implementation record (2026-10-23)

The implementation retains the original controls and their event handlers.
`public/settings/settings-layout.js` moves those DOM nodes into the eight
sections; its stylesheet supplies the approved sidebar and responsive drawer.
`settings-books.js` wraps the existing book action renderer with bounded browsing
and stable detail nodes. Book and writing data remain on existing endpoints.

Book sorting uses **Folder order** and **Title A–Z**. The current status payload
has no trustworthy date-added field, so the UI does not promise recency sorting.

The initial configuration read now paints a hidden cursor ring without clicking
its save handler. Opening Drive setup no longer fires a content-sync POST; the
Sync now button and normal background sync remain. Periodic detail reads are
limited to their relevant visible sections; navigation refreshes the destination.
The existing allowance, data-use, confirmation and recovery messages remain with
their forms or selected-book details.

Validation before publication: all101 targeted settings/browser tests and all128
full-gate suites passed. A read-only rendering with the live tablet's16 books
showed six rows per page, eight destinations, no horizontal overflow and no
runtime errors or writes. The physical tablet's touch/zoom setting remains a
maintainer acceptance check; the release pipeline additionally exercises the
installed page in a Windows kiosk after self-update.
