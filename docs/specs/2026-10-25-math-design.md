# Math exploration proposal

Research completed and first implementation authorized, 2026-10-25. The maintainer requested a school-email
review, first-grade curriculum comparison, accessible mathematics research,
and visual proposals, then approved building the exploration-first experience.
The first delivery includes Numbers and Number partners, using commands for
all movement. Dragging and dropping are unnecessary. Publication remains
subject to the maintainer's explicit word.

Visual review: [four layout sheets](2026-10-25-math-layouts.html).
Delivery plan: [research and implementation stages](../plans/2026-10-25-math-plan.md).
Individual school evidence and education records remain in the private
workspace; this document contains reusable design rationale only.

## Proposed experience

The first build opens to two large choices: Numbers and Number partners.
Stories is added when its instructional examples have been reviewed; it is
absent until available.
The last workspace and its state can be resumed. There is no completion
requirement, unlock sequence, compulsory prompt, score, or time limit.

The child controls a mathematical relationship through large commands.
The application positions the objects precisely. Looking at a numeral,
counter, equation, or frame does not change it. Each operation produces a
consistent state immediately; animation and speech illustrate that state
without locking the next action.

### Numbers

Start with a chosen quantity such as seven. Show its large numeral and
number word beside a structured collection. A two-row ten-frame makes five
and the additional ones visible. The ordinary controls are Pick a number,
One more, One fewer, and Count, plus Back and the shared doors.

One more changes seven to eight by adding exactly one object. One fewer
reverses that change. The corresponding numeral and quantity change together.
At zero the collection is visibly empty and the numeral remains 0; One fewer
keeps its seat and is calmly unavailable. There are no negative quantities
in the initial scope. Range boundaries never wrap silently.

Count is an optional demonstration: highlight each existing object once,
say its number, then emphasize the complete collection and its total.
It does not add objects or require a separate gaze selection for each one.
An action interrupts counting and any queued speech. Do not automatically
enumerate every object after every change: repeated enumeration can obscure
the useful observation that one more changes seven to eight.

Keep numeral range separate from representation density. The initial
browser reaches 0–50 through stable pages of ten full numerals. No screen
contains fifty active targets. Teen numbers can appear as one complete ten
and extra ones; larger quantities use clearly separated groups of ten and
ones, rather than a dense scattered collection. The later curriculum route
can extend beyond 50 without changing the basic access controls.

The picker retains fixed seats for each units digit. A page shows 0–9,
10–19, and so on; the last range offers 50 with unused seats inert. Back
stays top-left. Other numbers, bottom-left, opens six range choices rather
than adding separate Previous and Next commands. There are twelve body
targets at most, plus the two shared doors. Selecting a number returns to
the calling workspace. Cancelling preserves its state. This browsing
interface is not a numeral-identification assessment. A lower-density
alternative remains available for review if ten numeral choices prove tiring.

### Number partners

Pick a whole, initially within 10, and explore two parts of it. For seven,
show a whole numeral 7 connected to two parts, initially 3 and 4. The
objects appear only in the two parts: there is no duplicate seven-object
collection above them that could look like an additional quantity.

Move left transfers exactly one object from the right part to the left:
3 + 4 = 7 becomes 4 + 3 = 7. Move right reverses it. The whole stays seven.
Include 0 + 7 and 7 + 0, with empty parts explicitly numbered zero.
Endpoint controls remain in place and cannot produce negative parts.
The part labels, objects, and equation describe the same state. Location
and labels carry the distinction between parts; color is supplementary.

Count highlights every object once, continuing the count across the left
and right parts, then emphasizing the unchanged whole. A separate optional
explanation can name the two parts and total; it must not silently restart
a whole-set count in the second part.
Examples of spoken feedback are “Four and three make seven” and “Seven
is three and four.” The equals sign means the same quantity on each side,
not a command to produce an answer. The child chooses another partition;
the application does not cycle through answers automatically.

This is a way to experience composition and decomposition. It does not
cover every addition or subtraction situation. Initially its picker offers
only 0–10, preserving numeral seats and leaving unused seats inert. Numbers
still offers 0–50. The chosen whole can later grow, with representation
changes reviewed for visual load; the initial representation scope is not
an assertion about ability.

### Stories and comparison, after the first pilot

Use a small reviewed set of local examples: three objects with two joining;
five with two taken away; two collections to compare; a whole with one
part unknown. A familiar context can be selected without making decoration
the main event. Introduce one relationship and one visual representation
at a time. Narration can be replayed, interrupted, or skipped.

Keep exploration and an invited teaching prompt distinct. An exploration
has no incorrect action. A prompted activity can neutrally describe the
chosen result, offer a useful hint and another opportunity, then model the
relationship on request or through an agreed teaching sequence. Do not
copy automatic answer reveals or timed advancement from another activity.
The current weekly Which-one component is a reference, not an unmodified
engine for this workspace: it reveals an answer after misses and advances
on timers. The math proposal requires explicit decisions about those behaviors.

Later additions can cover comparison, a command-controlled number line,
tallies and simple graphs, measurement, and composing shapes. These are
curricular extensions, not prerequisites for enjoying the first workspace.

## Curriculum and evidence

As a curriculum comparison, Common Core grade-one standards include
addition and subtraction within 20, with
fluency within 10; story problems; missing quantities and equality;
counting to 120; and tens/ones. The wider year also covers measurement,
time, data and geometry. These are year-level expectations, not a required
starting screen or a reason to restrict access until a score is achieved.
A number workspace supports part of that curriculum, rather than replacing
it. The current classroom's adopted program was not verified.
[Official grade-one standards](https://www.cde.ca.gov/be/st/ss/documents/ccssmathstandardaug2013.pdf#page=21),
[operations](https://www.thecorestandards.org/Math/Content/1/OA/),
[place value](https://www.thecorestandards.org/Math/Content/1/NBT/).

Federal elementary-intervention guidance gives strong evidence ratings to
systematic instruction, clear mathematical language, selected representations,
number lines, and deliberate word-problem instruction. Its timed-fluency
recommendation does not establish that gaze-selection speed measures
mathematical fluency. Use these teaching principles while keeping exploration
unhurried. [Elementary practice guide](https://ies.ed.gov/ncee/wwc/PracticeGuide/26).
The early-childhood guide supports a developmental progression for number
and operations with a moderate evidence rating; its population is preschool
through kindergarten. [Early-math guide](https://ies.ed.gov/ncee/wwc/PracticeGuide/18).

Primary teaching guidance illustrates a fixed whole through objects moving
between two groups, and connects five-based structure to quantities six
through nine. This supports the mathematical choice of number partners;
it does not validate the proposed gaze interface.
[Composition guidance](https://www.ncetm.org.uk/features/exploring-the-composition-of-number/),
[whole-and-parts guidance](https://www.ncetm.org.uk/classroom-resources/primm-102-introducing-whole-and-parts-part-part-whole/).

The most relevant disability evidence needs careful boundaries:

| Evidence | What was studied | Implication and limit |
|---|---|---|
| [Eye-pointing mathematics assessment](https://repository.up.ac.za/bitstreams/99b4e215-72e4-4ed0-8c0d-b72febf472a5/download) | 42 older primary pupils with severe physical impairments; low-tech eye pointing versus oral answers | Higher scores with eye pointing suggest response format matters. Visible fixed choices differed from oral recall; this was neither an electronic dwell study nor a teaching trial. |
| [Virtual manipulatives](https://doi.org/10.1177/215416472005500104) | Two elementary pupils with autism and moderate intellectual disability; instructional package including stories and virtual objects | Promising numeracy results with maintenance/generalization. Cannot isolate the software from instruction or transfer the result directly to gaze access. Publisher abstract reviewed; full text restricted. |
| [Physical-manipulative survey](https://scholarworks.iu.edu/journals/index.php/pders/article/view/22172) | 86 teachers reported motor and attention barriers | Supports investigating accessible manipulation. Teacher reports do not demonstrate that a particular interface teaches better. |
| [Adapted numeracy instruction](https://link.springer.com/article/10.1007/s10882-015-9451-3) | Three pupils with severe multiple disabilities and complex communication needs; an instructional package with adapted response methods | Relevant to accessible participation; not evidence of an isolated gaze mechanism or independent free exploration. Publisher abstract reviewed. |

Rett communication guidance supports maintaining full communication access
and informal, meaningful opportunities to communicate. Its recommendations
come from evidence review and consensus, not a math-app efficacy trial.
[Guideline development paper](https://www.tandfonline.com/doi/full/10.1080/07434618.2020.1785009),
[foundation overview](https://www.rettsyndrome.org/healthcare-providers/communication-in-rett-syndrome/).

No controlled study of this proposed electronic gaze mathematics experience
for children with Rett was identified in this review. Published gaze-analysis
studies that observe students' eyes are not automatically studies of gaze
as an input method. Practitioner numeracy materials were located, but their
unavailable interiors and webinars are not treated as reviewed evidence.

The resulting design is a reasoned proposal: mathematical content is grounded
in curriculum and teaching research; large-command access and the specific
layout remain hypotheses to examine with the child.

## Access contract

- Reuse the actual shared door bar: Exit top-left, Talk centered. Both retain
  twice the user's dwell. Back and ordinary controls use the user's normal dwell.
- Keep a black, inert rest region that includes the literal bottom-right
  corner. It has no label, event handler, or mathematical meaning.
- Keep edge controls, counter order, part locations and number seats stable.
  Suppress fresh-page dwell arming using the shared settle behavior.
- Reuse the shared engine's look-away grace, tracking-loss freeze, hysteresis
  and move-to-rearm. A stationary gaze must never add multiple objects.
- Body selectable text targets 74 px at the native layout; use stacked
  labels. Shared door chrome retains its existing exception. Use the
  established palette and 14 px grid gaps. Validate actual device layouts;
  scaling a design preview is not proof of runtime readability.
- Every gaze action also works by touch. Precise object placement and dragging
  are unnecessary. Adult settings are not dwell targets.
- Speech stops at the start of any action. Models are interruptible and
  require no response deadline. Do not add beeps, mandatory celebration,
  negative feedback, correctness colors, or automatic progression.
- Talk leaves the exact mathematical state available for return. Navigation,
  window visibility and voice failure cannot discard an exploration. Preserve
  state locally; no network or configured external service is needed for math.

## What observations would justify changes

The first observation is about access and interest: can the child inspect
the collection without changing it, deliberately add and reverse a unit,
transfer between parts, take a break, and return from Talk? Can she find a
chosen numeral without excessive navigation? Do ten-frames clarify the
quantity or increase visual search? Compare with a simple ordered row if
needed, retaining the same action seats.

Record independent, prompted, modeled, and partner actions separately.
Choosing a visible numeral, requesting a spoken count, identifying an
unlabelled quantity, and finding a sum are different performances.
Do not label dwell count, time in the app, a modeled answer, or a software
demonstration as mastery. Raw gaze coordinates are unnecessary for these
math observations. Any individual school evidence stays private.

## Integration boundaries

A later build can be a plain local `/math/` application in the hub, reusing
shared speech, dwell, doors and settings. It needs registry, home/shortcut,
payload and gate coverage. The payload takes shared runtime files from the
core repository, so improvements there require a matching feature worktree;
editing an assembled copy in the hub is insufficient.

Check open worktrees again before implementation. The pictures and drawing
workstreams can share navigation, registry or recipe surfaces; settings
changes can share preferences and the app list. Older weekly-work branches
touch Play/Watch and their build/gate integration. Current cleanliness or
an already merged branch is not evidence that its session is inactive.
Keep the initial math surface independent of the board recipe renderer
unless a later reviewed requirement needs that integration.
