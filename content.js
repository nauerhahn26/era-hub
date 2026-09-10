// content.js — the shell for content jobs, in the shape clothing.js proved
// (spec §3: "content.js copies its shape so a later merge is mechanical").
// It answers three questions and nothing else:
//
//   1. WHERE do we build?  Only inside the family's local Drive folder. The
//      hub's Drive scope is read-only (drive.js:9) — there is no upload path —
//      so in API mode a finished book could never reach the family's Drive or a
//      second device. scan() therefore refuses anything but local mode
//      ({skipped:"needs-local-drive"}) and Settings says so. The book is built
//      IN PLACE in books/<Title>/ and Google Drive for Windows does the
//      uploading for us.
//   2. WHICH folder is ready?  A folder is a PILE — photos and no
//      .build/job.json and no manifest.json — and a pile builds when a grown-up
//      taps Build on the device that will do it (spec §14, "built here"). The
//      scan starts nothing by itself any more: the ten-minute quiet clock is
//      still measured (a card says how long the photos have been still) but it
//      is no longer a licence, because "the photos stopped arriving" and "make
//      this into a book" are not the same sentence, and the second one costs
//      the family's vision key and their narration allowance.
//      A FOLDER WITH manifest.json IS NEVER AN INBOX AND NEVER A PILE, whatever
//      loose files sit beside it (spec §12, "never twice"): the weekly-book
//      maker — the machine that writes Ellie's weekly story and copies the
//      finished package into this same folder, cover.jpg and all (spec §8) —
//      hands us books that are already made, and a hub that treated one as a
//      pile of photos would read every page again against the vision key and
//      buy the narration a second time.
//   3. MAY WE take it?  Every device in the family sees the same folder, so a
//      job is claimed by writing claimedBy + heartbeat into job.json — and
//      claimedBy names the DEVICE (device-id.js), because this file now reads
//      it back. A claim whose heartbeat stopped more than thirty minutes ago is
//      abandoned — a laptop that was closed mid-book — and may be taken over,
//      keeping the job's state and its error history so it resumes where it
//      fell over. By a SCAN only when the abandoned claim is this device's own;
//      another computer's is handed back to a grown-up, on the card, and taken
//      over only by their tap (build() below).
//
// The building itself is not here: like clothing.js, this shell only tracks
// state and runs ONE job at a time, so /content/status answers instantly while
// a book is being transcribed. The step table lives in content-worker.js and
// is plugged in at runJob() below.
//
// No key is read in this file, and nothing it writes to job.json or log.jsonl
// goes in unredacted — content-store.js owns both of those laws.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const drive = require("./drive.js");
const store = require("./content-store.js");
const booksIndex = require("./books-index.js");
// The pile of photos a parent dropped into books/ without making a folder
// (dad 9/7). Pure disk — no decoder, no network — so requiring it here costs
// the hub's main process nothing (content-ingest.js is kept at arm's length for
// exactly the opposite reason; see photoNames below).
const gatherer = require("./content-gather.js");
const { EXT: PHOTO_EXT } = require("./clothing-photos.js");
// `voiceAllowance` is two numbers and a date off ElevenLabs' subscription
// endpoint — how many characters are left this month and when the counter turns
// over. content-narrate reads the key; nothing key-shaped comes back here, and
// the header's law holds.
const { narrationPath, forgetPage, allowance: voiceAllowance } = require("./content-narrate.js");
const { pagesOf, pauseHolds } = require("./content-providers.js");
// The book's quote, and how much of it is already made. Pure arithmetic and one
// readdir — no key, no network (content-animate.js keeps both).
const { quote, animatedCount } = require("./content-animate.js");
// Booleans only — which roles the family has set up — plus the ONE number the
// cost gate needs (what a clip costs this family). No key is read in this file
// and none ever will be (see the header).
const { haveRoles, falPrice } = require("./ai-config.js");
// One Windows toast, for the one thing a parent cannot see by not looking:
// a book that stopped to wait for more allowance (T6b.3). Takes a title and a
// sentence, both written here; it is a no-op off Windows.
const notify = require("./notify.js");

// A folder must look identical across two observations at least this far apart
// before it is claimed (spec §2 "Quiet period"; the local mirror syncs every
// 10 min, drive.js:494, so this is one sync's worth of silence).
const QUIET_MS = 10 * 60 * 1000;
// A claim nobody has touched for this long is abandoned (spec §2 "Claim").
const STALE_MS = 30 * 60 * 1000;
// …and this long for a book parked on a hold only a PERSON can lift (see
// takeable). Twelve hours, so a family that ticks the box in the evening finds
// the book building in the morning without anyone pressing anything, and a book
// that waits a month costs sixty log lines rather than fifteen hundred.
const SLOW_MS = 12 * 60 * 60 * 1000;
// The two of those, by name. content-ingest.js owns the words (NO_DECODER and
// UNREADABLE) and they are copied here rather than imported for the reason
// SOURCES is below: requiring that module would drag the vendored JPEG decoder
// into the hub's MAIN process for two strings.
const SLOW_HOLDS = new Set(["needs-photo-decoder", "unreadable-photos"]);
// How often we look. Half the quiet period, so a book that stopped changing is
// claimed within about fifteen minutes of the last photo landing.
const SCAN_EVERY = 5 * 60 * 1000;
// The hold content-worker.js parks a gathered book on once the cover has told
// it what the book is called. It is not a failure and not a pause: it is the
// worker saying "the folder is yours to move now" (see begin(), nameBook()).
const NEEDS_TITLE = "needs-title";

let DATA = null;
let DEVICE = null;      // this install's device id, handed over by server.js
let running = null;     // {kind, slug, dir, step} of the job in flight
let inflight = null;    // its promise, for idle()
let queue = [];         // [{job, waiters[]}] — books asked for while one runs
let progress = null;    // {step, state} the running worker last reported
let lastScan = null;    // small JSON-safe summary for status()

// Who holds the claim, written into job.json and read by the other devices —
// and now read back by THIS one, which is the whole reason it is the device id
// and not the machine name (spec §14 "Who this host is"). Two PCs a family
// bought together are both "DESKTOP-7F3K" to os.hostname(), so every claim read
// as our own and "is anyone else already building this?" could not be asked at
// all; device-id.js gives each install one stable slug and server.js hands it
// over at start(). The pid keeps two hubs on one device honest.
// It is never a key and never leaves the family's own folder — and never
// reaches /content/status either (jobFor's law).
function whoami() { return (DEVICE || os.hostname()) + ":" + process.pid; }

// The device half of a claim: everything before the LAST colon, because the pid
// is the only thing that follows one. "" for a claim that names nobody.
function deviceOf(claimedBy) {
  const s = String(claimedBy == null ? "" : claimedBy);
  const at = s.lastIndexOf(":");
  return at < 0 ? s : s.slice(0, at);
}

// Is this name ours? Our own device id — or this machine's HOSTNAME, which is
// what every job.json written before this release is signed with. That fallback
// is the ambiguity above, kept on purpose and only in this direction: without
// it, every book a family started last week reads as a stranger's and their own
// computer tells them "Building on another computer" about the book it is
// building itself. A device id is a slug (device-id.js ID_RE), so it can never
// collide with a hostname that contains a dot or a capital.
function mineName(who) {
  return !!who && (who === (DEVICE || os.hostname()) || who === os.hostname());
}
function isMine(job) { return mineName(deviceOf(job && job.claimedBy)); }

const iso = (now) => new Date(now).toISOString();

// ------------------------------------------------------------- the folder scan

// The photo files sitting directly in one directory, unsorted, or null if it
// cannot be read. clothing-photos.js owns the "what counts as a photo" list so
// the two pipelines can never disagree; a HEIC counts even though
// content-ingest.js cannot page it yet — it is a page of the book the hub has
// not got, and the ingest log is where that gets explained.
function photoNames(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const out = [];
  for (const e of ents) {
    if (e.name.startsWith(".") || !e.isFile()) continue;
    if (!PHOTO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    out.push(e.name);
  }
  return out;
}

// The one .jpg in a book root that is not a photo a parent dropped in: the
// publish step copies page 1's bytes there as the shelf's cover
// (content-publish.COVER). Ingest skips it by the same name (its OURS list) so
// it never becomes a page, and it must not be counted as one either — a
// finished sixteen-page book said seventeen without this.
//
// IT IS NOT A PILE EITHER (spec §12). Counting it here is how a finished book
// became an inbox: a book still arriving, whose manifest.json has not mirrored
// yet, is a cover, a pages/ folder and nothing else on top, so the cover made it
// "one photo waiting", ten quiet minutes made it claimable, and the walk read
// every page again against the vision key. The manifest rule below is the other
// half of that; this half is what makes a book MID-DOWNLOAD — the manifest not
// there yet — neither a pile nor an inbox.
const NOT_A_PAGE = new Set(["cover.jpg"]);

// The photos a parent dropped in: what photoNames found, less anything of ours.
// One filter, so "is this a pile?", "how many photos is this book?" and the
// quiet clock's signature can never disagree about what counts.
function pilePhotos(names) {
  return (names || []).filter(n => !NOT_A_PAGE.has(n.toLowerCase()));
}

// Top-level photos only, with their sizes: this is the pile the parent dropped
// in, not the pages/ and sources/ the builder makes afterwards (by then
// job.json exists and the folder is no longer an inbox). The signature is what
// the quiet period watches, so it must see the loose files and only those — a
// folder is still changing while photos are landing in IT, never while ingest
// is tidying them away.
//
// `published` travels with the count because a folder holding manifest.json is
// a BOOK: never an inbox, never a pile, whatever is loose beside it (spec §12).
// It is one existsSync per folder per scan, on a path this file already stats
// twice elsewhere.
function listing(dir) {
  const names = photoNames(dir);
  if (!names) return null;
  const parts = pilePhotos(names).map(n => {
    let size = -1;
    try { size = fs.statSync(path.join(dir, n)).size; } catch {}
    return n + ":" + size;
  });
  parts.sort();
  return { count: parts.length, sig: parts.join("\n"),
           published: fs.existsSync(path.join(dir, MANIFEST)) };
}

// Where ingest puts the originals once it has taken them in (content-ingest.js
// owns the name; it is not exported because requiring that module here would
// drag the JPEG decoder into the hub's main process for one string).
const SOURCES = "sources";
// The file that makes a folder a BOOK: content-publish.js writes it last, and
// the weekly-book maker uploads it last for the same reason (spec §8) — no
// device may see a manifest before the files it names. Everything that asks
// "is this finished?" asks for this name.
const MANIFEST = "manifest.json";

// How many photos a book folder holds, WHEREVER THEY SIT. The pile starts
// loose in the folder and ingest MOVES it into sources/ one file at a time, so
// counting only the loose ones made the total fall as the move ran and climb
// back as pages/ filled behind it: live, on the 16-page run of 9/4,
// /content/status said 16 → 3 → 6 → 11 → 15 → 16 while nothing was lost, and a
// parent watching the card saw their book shrink. A photo is one page of the
// book on either side of the move, and every file leaves one side exactly as it
// joins the other, so this sum holds still the whole way across.
//
// THE LOOSE PILE ONLY COUNTS WHILE THE FOLDER IS STILL THE INBOX — the window
// above, where ingest is emptying it (the job is still in `inbox`; the worker
// only moves it on once the step has returned). Counting it forever is a
// promise the hub cannot keep: a photo ingest could not page (a HEIC left
// exactly where the parent put it), or one dropped beside a book that has since
// published, is never ingested again, so the total it inflates never closes —
// a finished fifteen-page book says "15 of 16 pages read" for the rest of its
// life, with nothing that will ever make it sixteen.
function photoCount(dir, job) {
  const inbox = !job || store.owedState(job) === "inbox";
  const loose = inbox ? pilePhotos(photoNames(dir)).length : 0;
  return loose + (photoNames(path.join(dir, SOURCES)) || []).length;
}

// What the last scan saw, per folder: {sig, since}. `since` is the moment the
// CURRENT listing first appeared, so it survives any number of extra scans —
// that is what makes the quiet period a wall clock rather than a sync count.
let seen = new Map();

function observe(dir, sig, now) {
  const prev = seen.get(dir);
  if (!prev || prev.sig !== sig) { seen.set(dir, { sig, since: now }); return 0; }
  return now - prev.since;
}

// IS THERE WORK LEFT ON THIS BOOK, AND HAS WHOEVER HAD IT STOPPED? A claim is
// stale when its heartbeat stopped long enough ago — or when it is unreadable,
// which is the same thing from here.
//
// WHAT THIS FUNCTION IS NOT (spec §14, "built here"). It never says WHOSE the
// book is, and since the scan stopped starting books by itself it is no longer
// anybody's whole licence:
//   • the scan takes a stale claim over only when isMine() as well — another
//     computer's abandoned book is handed back to a grown-up on the card, and
//     no machine in the family ever takes a book off another one;
//   • the Build door (build() below) asks a different question again, because
//     the folders it exists for — a pile of photos nobody has claimed — have no
//     job.json at all, and this returns false for every one of them.
// So: this is "is there work owing, and is the claim cold?", and who holds it
// is isMine()/heldElsewhere()'s to answer.
//
// A book with no work left is NEVER taken over, however old it is. That is the
// difference between a shelf that settles down and one that churns: every
// re-claim rewrites job.json and appends to log.jsonl INSIDE the family's Drive
// folder, which Drive then re-uploads and re-mirrors to every device. Three
// kinds owe nothing —
//   done       the walk finished (content-worker.js settles `published` to it)
//   published  a hub that stopped between the manifest and the settle
//   permanent  a key the provider refused; asking again only buys the same
//              answer (store.owedState returns null for it)
// — and a scan half an hour later must find nothing to do with any of them.
function takeable(job, now) {
  if (!job || job.state === "done" || job.state === "published") return false;
  if (store.owedState(job) === null) return false;
  // A book waiting for a spent allowance keeps its claim but stops beating, so
  // half an hour later it looks exactly like an abandoned one. Taking it over
  // buys nothing — the worker reads the same pause and holds again — and it
  // costs a job.json rewrite and a log line inside the family's Drive folder
  // every thirty minutes until the quota comes back. The pause is a MOMENT
  // (content-providers.js F6), so this wakes the book the first scan after it
  // passes rather than at some local midnight.
  //
  // A PAUSE IS ITS OWN ANSWER, and the heartbeat has nothing to add to it. The
  // book that held wrote a FRESH heartbeat as it held (content-worker.js
  // holdHere) precisely so no other device would treat it as abandoned — so if
  // the stale window still had to pass on top, a 429 answered with "come back
  // in 47 seconds" cost half an hour of waiting instead of a minute, which is
  // most of what the pause was written to recover. A job carrying a pausedUntil
  // is parked by definition (a finished step deletes it, holdHere writes it),
  // so the moment it names is the whole rule for it.
  if (job.pausedUntil != null && job.pausedUntil !== "")
    return !pauseHolds(job.pausedUntil, now);
  const beat = Date.parse(job.heartbeat);
  if (!(beat >= 0)) return true;                    // no readable heartbeat: abandoned
  // A HOLD THAT WAITS ON A PERSON BACKS OFF (review 9/8). The two holds ingest
  // can park a book on wait for something no clock brings: a pack ticked in
  // Settings, or the photos saved again as JPEG. On the half-hourly rule they
  // were re-claimed for ever — a job.json rewrite, a "claim" line in
  // log.jsonl and a worker thread every thirty minutes, inside the family's
  // Drive folder, for Drive to re-upload to every device — which is exactly the
  // churn the rest of this function exists to stop.
  // It is NOT a dead end, because the Settings card promises it is not ("tick
  // it in Apps above and this book carries on by itself"): the book is looked at
  // twice a day instead of forty-eight times, and a parent who does not want to
  // wait has "Try this book again" under the sentence that told them what to fix.
  return now - beat > (SLOW_HOLDS.has(job.held) ? SLOW_MS : STALE_MS);
}

// Every book folder under `<folderPath>/books`, each with the slug it owns.
// books-index.js is the ONE place a slug is assigned — the shelf server.js
// serves calls the same function over its own root — so the URL in a Settings
// link, in the board's review link and in POST /content/run always names the
// book the reader actually serves.
function shelfOf(st) {
  const root = path.join(st.folderPath, "books");
  return { root, list: booksIndex.bookDirs(root).list };
}

// Write the claim. A fresh inbox gets a new job.json; a takeover keeps the
// job exactly as the other device left it (state, startedAt, errors) and only
// changes hands, so the build resumes at the step that fell over.
// `extra` is merged into the job before it is written: the one caller that uses
// it is the loose-photo gather below, which has to mark the folder it just made
// as one nobody has named yet (`autoTitle`). Merged rather than written a second
// time because job.json lives inside the family's Drive folder and every write
// of it is an upload to every device.
function claim(dir, job, now, extra) {
  const me = whoami();
  const next = job
    ? { ...store.transition(job, job.state, { now: iso(now) }), claimedBy: me }
    : store.newJob({ claimedBy: me, now: iso(now) });
  const written = store.writeJob(dir, extra ? { ...next, ...extra } : next);
  // `by` is the same string the claim itself carries, in a FIELD (spec §14 step
  // 1, content-store.appendLog). The other device reads this line when it
  // catches job.json mid-mirror — the worker rewrites it every 60 s while it
  // builds — and reading a device id back out of the sentence would mean
  // parsing prose that belongs to whoever next improves the wording.
  store.appendLog(dir, "claim", job ? "taken over by " + me : "claimed by " + me,
                  { now: iso(now), by: me });
  return written;
}

// The slug the shelf gives a folder that was made a moment ago. books-index
// caches per root on the root's mtime, and creating a directory bumps that — but
// a rename inside the same second may not, so the miss is retried against a
// forced rebuild before anything is run under a slug that names another book.
function slugOf(root, name) {
  return booksIndex.slugFor(root, name) ||
         (booksIndex.bookDirs(root, true).list.find(e => e.dir === name) || {}).slug ||
         null;
}

// ---------------------------------------------- the pile with no folder (9/7)

// "I didn't put into, like, a folder and name it. I think that the system
// should be smart enough to say, okay, these all belong to a single book,
// because I just uploaded a bunch" (dad, 9/7). Photos sitting DIRECTLY in
// `books/` were invisible to everything above: the walk is over books-index's
// DIRECTORY list, so a pile of loose pages was never an inbox, was never
// claimed, never built, and left the Book Reader telling a family with Drive
// set up perfectly to go and set up Drive.
//
// The pile is ONE book, and `force` is a grown-up saying so with their finger
// (spec §14 step 3). The tap on the loose card IS the sentence the quiet clock
// used to have to guess — "I have finished putting the photos in" — so the
// clock is skipped when it comes from there, and the pile becomes a book in the
// second the card was pressed rather than ten minutes later.
//
// Without `force` the ten-minute clock still stands, because the caller then
// has nobody's word for it: `observe()` over the loose listing, ten minutes of
// stillness before anything is moved. That is what makes "the photos are still
// arriving" and "the parent has finished uploading" different things — a phone
// trickles a twenty-photo album in over several minutes, and every arrival
// resets the clock, so every one of them lands in the SAME book. Nothing in the
// hub calls it that way today: the scan stopped gathering when it stopped
// claiming (§12, "built here"), and this is the guard for whatever asks next.
//
// Everything about the move itself — the marker that finishes an interrupted
// one, the placeholder name, never deleting a photo, never creating `books/` —
// is content-gather.js's. This function is only the decision to call it, and
// what to do with the folder afterwards: claim it and start it, with
// `autoTitle` set so the walk knows nobody has named this book yet.
function gatherLoose(root, now, opts) {
  const force = !!(opts && opts.force);
  const list = listing(root);
  if (!list) return null;                          // no books/ at all: nothing to do
  const open = gatherer.pending(root);             // a move a stopped hub left half done
  if (!list.count && !open) { seen.delete(root); return null; }
  // An interrupted move is finished AT ONCE and never re-timed: those photos
  // have already had their quiet ten minutes, and leaving half of them loose is
  // how one book becomes two.
  if (!force && !open && observe(root, list.sig, now) < QUIET_MS) return null;
  seen.delete(root);
  let g = null;
  try { g = gatherer.gather(root, { now }); }
  catch (e) {
    // The photos are exactly where the parent put them. Say so in the hub's own
    // console — never into books/, which is the family's own folder and not a
    // place for our scratch.
    console.error("[content] could not gather the loose photos in books/: " + store.redact(e.message));
    return null;
  }
  if (!g) return null;
  // A PASS THAT MOVED NOTHING IS NOT NEWS. Either every photo is still held by
  // whatever has it open (the marker keeps this folder as the target, so the
  // next look carries the same move on), or the move had already finished — and
  // either way the folder is an ordinary book folder now, which the walk above
  // claims under the ordinary rules. Logging and re-claiming it on every scan
  // would write a "gather" line and a "claim" line into the family's Drive
  // folder every five minutes for as long as the file stayed locked.
  if (!g.moved) return null;
  const slug = slugOf(root, g.name);
  if (!slug) return null;                          // the folder went away under us
  store.appendLog(g.dir, "gather", (g.resumed ? "carried on" : "took in") + " " + g.moved +
    " photo(s) that were loose in books/ — they are one book until a grown-up says otherwise" +
    // Said, because the alternative is a book that is quietly one page short: a
    // photo still open in Drive is left loose and joins THIS book on the next
    // look (content-gather.js keeps the marker until the pile is empty).
    (g.failed ? "; " + g.failed + " could not be moved yet and will join it on the next look" : ""),
    { now: iso(now) });
  const b = { name: g.name, slug, images: g.moved, inbox: true, quiet: true,
              takeable: false, gathered: true, state: null };
  try {
    // `autoTitle` is the whole difference between this folder and one a parent
    // named: it is the note that says the cover, not a person, will name this
    // book (content-worker.js's title hold, and nameBook() below).
    claim(g.dir, store.readJob(g.dir), now, { autoTitle: true });
    run({ kind: "books", slug, name: g.name, dir: g.dir, dataDir: DATA });
  } catch (e) {
    console.error("[content] could not claim " + g.name + ": " + e.message);
    return null;
  }
  return b;
}

// Walks <folderPath>/books/*. Returns a small JSON-safe picture of every book
// folder plus the slugs claimed this time round; the jobs themselves run
// behind it (one at a time — see run()).
//
// WHAT A SCAN MAY START, since "built here" (spec §12): exactly one thing —
// this device's OWN abandoned job. Not a quiet inbox (a pile of photos is a
// grown-up's tap away from being a book, and the tap is the only thing that
// says "yes, make this one"), not the loose pile in books/ (same tap, through
// build()), and never another computer's job, however cold its claim. The
// hub is still the thing that notices a book stopped: it says so on the card
// and hands the decision to a person, which is the difference between a family
// with two computers and a family with two computers arguing.
function scan(opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };

  const { root, list: shelf } = shelfOf(st);
  const books = [], claimed = [];
  for (const { slug, dir: name } of shelf) {
    const dir = path.join(root, name);
    const list = listing(dir);
    if (!list) continue;                      // vanished between readdir and stat
    const job = store.readJob(dir);
    // A book that is waiting for more allowance is told to the family here as
    // well as at the end of a run: this is how a pause another device wrote into
    // the shared folder — or one this hub wrote before it was restarted — gets
    // said out loud. Deduped inside, so a shelf of parked books is silent.
    notePause(slug, name, job, now);
    // A FOLDER WITH A MANIFEST IS A BOOK (spec §12): not an inbox, not a pile,
    // whatever is loose beside it. That is what keeps the weekly book — and any
    // book another device in the family finished — off the walk.
    const inbox = !job && !list.published && list.count > 0;
    // Only an inbox is on the quiet clock; anything else forgets its listing so
    // a shelf of a hundred published books costs us nothing to remember.
    if (!inbox) seen.delete(dir);
    // Still measured, no longer a licence: the card says how long the photos
    // have been still, and a grown-up decides (build()).
    const quiet = inbox && observe(dir, list.sig, now) >= QUIET_MS;
    const stale = takeable(job, now);
    const b = { name, slug, images: list.count, inbox,
                quiet, takeable: stale, state: job ? job.state : null };
    books.push(b);
    // OURS TO RESUME, or nobody's to resume. A claim naming another device is
    // left exactly as it is even when it went cold half an hour ago — the card
    // offers Build to the family instead (§15: "no machine takes over by
    // itself"). A job.json carrying no claim at all is nobody's, so this hub
    // may as well be the one that finishes it.
    const ours = isMine(job) || !deviceOf(job && job.claimedBy);
    if (!stale || !ours) continue;
    try {
      claim(dir, job, now);
      claimed.push(b.slug);
      // dataDir travels with the job: the worker builds in `dir` (the family's
      // Drive folder) but reads its key roles out of <DATA> (ai-config.js).
      run({ kind: "books", slug: b.slug, name, dir, dataDir: DATA });
    } catch (e) {
      console.error("[content] could not claim " + name + ": " + e.message);
    }
  }
  // AND THE PILE IN books/ IS LEFT WHERE IT IS. It used to be gathered here,
  // last of all, the moment its own ten minutes were up — a folder made, named
  // and claimed inside the family's own Drive folder with nobody asked. It is a
  // tap on the loose card now (build({loose:true})), which is the same decision
  // made by the person whose photos they are. `status().loose` still counts
  // them, so both cards can say the photos are there and waiting.
  lastScan = { at: iso(now), books: books.length,
               inboxes: books.filter(b => b.inbox).length, claimed: claimed.slice() };
  return { books, claimed };
}

// ------------------------------------------------------------- one at a time

// The step table lives in content-worker.js and runs in a WORKER THREAD, for
// the reason clothing.js:56 spawns one: the build reads and re-encodes whole
// photo albums, and on the main thread that froze every hub page for minutes
// (dad 8/31). The shell only relays progress and the final result, so
// /content/status answers instantly while a book is being built.
// Assigned onto module.exports so the tests can replace it in one place.
function runJob(job) {
  return new Promise((resolve) => {
    let result = null;
    const w = new Worker(path.join(__dirname, "content-worker.js"), {
      workerData: { dataDir: job.dataDir || DATA, dir: job.dir, kind: job.kind,
                    slug: job.slug, name: job.name || null, step: job.step || null,
                    // One page, for the review page's "Re-narrate this page".
                    // Null (the normal case) means the whole book.
                    page: Number.isInteger(job.page) ? job.page : null,
                    // The pages the review page's "Read the photos again" wants
                    // read AGAIN (spec §5). Null means "whatever the step owes",
                    // which for the transcriber is every page with no words yet.
                    pages: Array.isArray(job.pages) ? job.pages.slice() : null },
    });
    w.on("message", (m) => {
      if (m && m.step) progress = { step: m.step, state: m.state || null };
      if (m && m.done) result = m.done;
    });
    // The worker already turned a step's own failure into a {done:{error}}; an
    // error HERE is the thread itself dying, which the exit handler answers for.
    w.on("error", (e) => console.error("[content] " + job.slug + " worker: " + e.message));
    w.on("exit", (code) => {
      progress = null;
      resolve(result || { slug: job.slug,
        error: "the builder stopped before it finished (exit " + code + ")" });
    });
  });
}

// Two runs are the same run when they are the same step of the same book — and
// the pages count: re-narrating page four is not the run that re-narrates page
// seven, and reading two pages again is not the run that reads one of them, so
// joining either to the other would leave a parent's second press silently
// unanswered.
const keyOf = (job) => job.dir + "|" + (job.step || "") + "|" +
                       (Number.isInteger(job.page) ? job.page : "") + "|" +
                       (Array.isArray(job.pages) ? job.pages.join(",") : "");

// One job at a time, and a caller that arrives mid-build gets the result of the
// run it asked for rather than a bare {busy} it would have to poll for — the
// same deal clothing.js:47-53 makes. Asking for the book that is ALREADY
// running joins that run instead of queueing a second one.
function run(job) {
  if (running) {
    if (keyOf(running) === keyOf(job)) return inflight;
    const waiting = queue.find(q => keyOf(q.job) === keyOf(job));
    if (waiting) return new Promise((resolve) => { waiting.waiters.push(resolve); });
    return new Promise((resolve) => { queue.push({ job, waiters: [resolve] }); });
  }
  return begin(job);
}

function begin(job) {
  running = job;
  // Started here and now, not on the next tick: clothing.js spawns its worker
  // the moment regenerate() is called, and a caller that gets the promise back
  // expects the work to already be under way.
  let step;
  try { step = Promise.resolve(module.exports.runJob(job)); }
  catch (e) { step = Promise.reject(e); }
  const p = step
    // A book that fell over must not wedge the queue behind it: the error is
    // this run's result, and the next book starts anyway.
    .catch((e) => {
      console.error("[content] " + job.slug + ": " + e.message);
      return { slug: job.slug, error: store.redact(e.message) };
    })
    .then((result) => {
      running = null; inflight = null;
      // Before the next book in the queue starts (a transcription is minutes
      // long, and this book is finished now).
      announce(job, result);
      // A run that ended in a pause says so NOW, rather than at whichever scan
      // in the next five minutes happens to notice. The worker thread does not
      // raise this itself: a toast is a spawn, and the hub process is where
      // every other one in this suite of programs lives (server.js). The hold's
      // own shape (content-worker.js holdHere) is enough to say it — no second
      // read of a job.json the worker has just written.
      if (result && result.held && result.pausedUntil)
        notePause(job.slug, job.name || path.basename(job.dir),
                  { pausedUntil: result.pausedUntil, pausedProvider: result.provider || null,
                    pausedNote: result.note || null });
      // THE BOOK THE COVER JUST NAMED (dad 9/7). The worker parked here rather
      // than renaming its own folder out from under itself; the thread has
      // exited by the time this line runs, so the move is safe to make now.
      // Whatever comes back — a renamed folder or the placeholder it kept —
      // carries `autoTitle` cleared, so the book is asked exactly once.
      const named = result && result.held === NEEDS_TITLE
        ? nameBook(job, result.title) : null;
      const next = queue.shift();
      if (next) begin(next.job).then(r => next.waiters.forEach(w => w(r)));
      // AFTER the queue, never in front of it: begin() has just taken the one
      // slot, and starting a second run here would have two workers writing
      // into two book folders at once. run() queues it behind them.
      if (named) run(named).catch(() => {});
      return result;
    });
  inflight = p;
  return p;
}

// A BOOK THAT PUBLISHED IS NOT YET ON THE SHELF (F5, 9/4). The walk writes
// manifest.json inside the family's Drive folder; the Reader serves
// <DATA>/books, and the only thing that carried a package across was the
// ten-minute mirror or a hand on "Sync now" — a parent watched the card say
// "finished", opened the Reader, and the book was not there.
//
// So a run that published says so, once, through the same one-property shape
// drive.onSynced uses: server.js hangs the copy off it (drive.mirrorBook — that
// book and no more; a whole sync would fire onSynced's clothing leg and spend
// vision quota on every publish), and nothing in this file has to know that the
// mirror exists. Unset — every test that drives content.js directly — it is a
// no-op, and a hook that throws is the hook's problem, never the book's.
function announce(job, result) {
  const steps = result && Array.isArray(result.steps) ? result.steps : [];
  if (!steps.some(s => s && s.published)) return;
  const hook = module.exports.onPublished;
  if (typeof hook !== "function") return;
  try {
    hook({ kind: job.kind, slug: job.slug, dir: job.dir,
           name: job.name || path.basename(job.dir) });
  } catch (e) {
    console.error("[content] " + job.slug + ": " + store.redact(e.message));
  }
}

function isBuilding() { return !!running; }

// Resolves when nothing is running and nothing is queued. Used by the tests and
// by anything that wants to let a book finish before it looks at the folder.
function idle() { return inflight ? inflight.then(idle) : Promise.resolve(); }

// The heartbeat a step refreshes as it works, so the other devices can see the
// claim is alive. Same-state transitions are exactly that (content-store.js).
function beat(dir, now) {
  const job = store.readJob(dir);
  if (!job) return null;
  const next = store.transition(job, job.state, { now: iso(now == null ? Date.now() : now) });
  return store.writeJob(dir, next);
}

// --------------------------------------------------------------- the job list

// The kinds /content/run will act on. Music and movies are catalogue writes,
// not folder builds, and get their own routes in Phases 4 and 5 — an unknown
// kind is refused here rather than quietly treated as a book.
const KINDS = ["books"];

// books/<Title> for a slug, or null. books-index.js owns the translation
// between what a URL says and what is on disk — the same function server.js's
// serveBook resolves through — so a slug can never name one folder here and
// another one on the shelf. A slug that matches no folder is refused; nothing
// is created from a URL.
function bookFor(slug, st) {
  const root = path.join(st.folderPath, "books");
  const name = booksIndex.dirFor(root, slug);
  return name ? { name, dir: path.join(root, name) } : null;
}

// WHERE A FAMILY ADDS MORE ALLOWANCE, per provider (T6b.1, spec §4 "Design
// target"). The pause is the normal path for a slow book on a free key, and the
// two honest choices are "wait — it carries on by itself" and "add credit and
// press Try again now". The second one is only honest if the card can say
// WHERE, so the address travels with the status rather than being written into
// three different pages. A provider we have no page for gets null, and the card
// simply offers the waiting half.
const ADD_URL = {
  google: "https://aistudio.google.com/apikey",
  elevenlabs: "https://elevenlabs.io/app/subscription",
};

// The pause a book is under RIGHT NOW, or null. Derived — job.json keeps the
// pause itself (pausedUntil/pausedNote/pausedProvider, written by
// content-worker's holdHere) and the raw `pausedUntil` stays on the payload for
// the readers that already have it.
//
// A pause whose moment has passed is not a pause: the book is simply waiting
// for the next scan to pick it up, and a card still saying "out of allowance
// until 3 o'clock" at half past three is a card nobody believes.
//
// A job.json written before this task carries a pause and no provider. Those
// can only be Google's — nothing else could pause a book until now — so that is
// what an unnamed pause reads as, rather than a book that says nothing.
function pausedOf(job, now) {
  if (!job || !pauseHolds(job.pausedUntil, now)) return null;
  const provider = typeof job.pausedProvider === "string" && job.pausedProvider
    ? job.pausedProvider : "google";
  return { provider, reason: job.pausedNote || null, until: job.pausedUntil,
           addUrl: ADD_URL[provider] || null };
}

// ------------------------------------------------ telling the family, once

// What each provider is called on the cards (public/settings/index.html
// CT_PROVIDER, public/book-review/index.html). The toast is the same sentence
// arriving somewhere else, so it must use the same words: a parent told
// "ElevenLabs" by a toast and "the voice service" by Settings has been told
// about two different problems.
const PROVIDER_NAME = { google: "Google AI Studio", elevenlabs: "ElevenLabs" };

// The moment, in the clock on the wall in front of the parent. Never the ISO
// stamp the payload carries: "2026-10-01T00:00:00Z" is a machine talking to
// itself, and a parent reading it cannot tell whether that is tonight or next
// week. Mirrors ctWhen() in the two pages, for the same reason as above.
function whenWords(until, now) {
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at), n = new Date(now == null ? Date.now() : now);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
                            a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tom = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay(d, n)) return "today at " + clock;
  if (sameDay(d, tom)) return "tomorrow at " + clock;
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) + " at " + clock;
}

// The pause we have already told the family about, per slug. In memory on
// purpose: the alternative is a flag written into job.json, which lives inside
// the family's Drive folder and would hand Drive a fresh upload and every other
// device a fresh mirror for the sake of a notification nobody can see twice
// anyway. A hub that restarts mid-pause therefore says it once more, which is
// the right way round — a machine that has just come back up telling a parent
// what it is still waiting on is useful; one that has silently forgotten is not.
let told = new Map();

// ONE TOAST WHEN A BOOK ENTERS A PAUSE, and nothing at all otherwise (T6b.3).
//
// Called from the two places the hub itself learns of a pause: the result of a
// run it just finished (content-worker's holdHere shape, which is the same
// moment the pause is written to disk) and the scan, which is how a pause
// another device wrote — or one this hub wrote before it restarted — is noticed.
// Both go through here so the two can never double up on the same wait.
//
// Deduped on (slug, pausedUntil), so:
//   • the same book still waiting on the same moment is told once, however many
//     scans and re-runs pass over it — "Try again now" included, which lifts the
//     pause and, if the allowance is still spent, lands on the same moment;
//   • a NEW moment (tomorrow's quota, next month's characters) is news again;
//   • a pause that has ended is forgotten, so a book that stops a second time
//     for a genuinely new reason is not silently swallowed.
//
// THE MEMORY OUTLIVES THE PAUSE ITSELF (review 9/5), because "Try again now"
// deletes the pause from job.json and the run that follows takes minutes: a scan
// landing in that window sees a book with no pause on it at all, and forgetting
// there gave the identical moment coming straight back a second toast. So an
// entry is dropped when the MOMENT it names has passed, not when a scan happens
// to look between the two halves of a retry.
function notePause(slug, title, job, now) {
  const t = now == null ? Date.now() : now;
  const p = pausedOf(job, t);
  const had = told.get(slug);
  if (had && Date.parse(had) <= t) told.delete(slug);
  if (!p) return null;
  if (told.get(slug) === p.until) return null;
  // A WAIT NOBODY WOULD OTHERWISE NOTICE IS NOT WORTH A NOTIFICATION. A 429 is
  // not always the day being over: a free Google key limits requests per MINUTE
  // too, and that pause is over in seconds (content-providers pausedUntilFor).
  // The book is picked up by the next scan and parks again on a fresh moment, so
  // telling the family about a pause shorter than the gap between two looks
  // would be a toast every five minutes for as long as the throttle lasted —
  // which is the repeat notification this whole thing exists to prevent.
  if (Date.parse(p.until) - t < SCAN_EVERY) return null;
  told.set(slug, p.until);
  const who = PROVIDER_NAME[p.provider] || "the AI service";
  const when = whenWords(p.until, t);
  notify.toast(
    (title || slug) + " is waiting",
    "Out of " + who + " allowance" + (when ? " until " + when : "") +
    ". Nothing is broken. Open Settings to add credit, or leave it — it carries on by itself.");
  return p;
}

// What one book folder looks like from outside, and NOTHING else: no absolute
// path (a status page is not a map of the family's disk), no claimedBy device
// name, no key — content.js never reads one and this payload is public.
// The book's title is the one identifying thing in here, and it is the one
// thing a parent needs to recognise their own book.
function jobFor(name, dir, slug, perClip) {
  const job = store.readJob(dir);
  const text = store.readText(dir);
  const narr = store.readJson(narrationPath(dir));
  const narrated = new Set(((narr && narr.pages) || []).map(p => p.index));
  const pages = (text && text.pages) || [];
  // How many pages the BOOK has, which is not how many have been read yet: the
  // card renders "N of M pages read" and the board "page N of M", so counting
  // only text.json's entries makes M chase N and a twelve-page book part-way
  // through says "4 of 4" — finished, when it is a third done. The built pages
  // are the honest total (ingest's own record, or pages/ for a folder built by
  // hand); before ingest has run, and while it is running, the pile of photos is
  // — counted on both sides of the move it is half way through (photoCount).
  let built = [];
  try { built = pagesOf(dir); } catch {}
  // The loose pile, counted once: it is both the honest floor under `count`
  // below and the whole of "is this folder a pile waiting for a tap?".
  const photos = photoCount(dir, job);
  const count = Math.max(built.length, pages.length, photos);
  // TWO COUNTS, because there are two kinds of mark and they are not the same
  // sentence to a parent. `flags` is WORDS somebody was unsure of, the ones the
  // review page highlights inside the page's own text; `pageFlags` is whole
  // PAGES to come and look at (a page nobody could check, a disagreement with
  // no word to point at) and those name no word at all. Counting the second as
  // the first told a parent "30 words the AI was unsure of" and then showed
  // them a book with nothing highlighted anywhere in it (E2, 9/4).
  // AND A THIRD COUNT, WHICH IS NOT A MARK (L6, the 16-page live run of 9/4).
  // A page a grown-up retyped has its `read` dropped — the words are theirs, and
  // naming a model as their author would be a lie — so from out here it was
  // indistinguishable from a page nobody ever checked, when it is the opposite:
  // it is the most checked page in the book. `edited` is that page counted, and
  // it is deliberately its own number rather than a flag: there is nothing to go
  // and fix, and it is what the next "Read the photos again" will keep.
  let characters = 0, spent = 0, transcribed = 0, flags = 0, pageFlags = 0, edited = 0;
  for (const p of pages) {
    const n = p.text.length;
    characters += n;
    if (n) transcribed++;
    if (narrated.has(p.index)) spent += n;
    if (p.edited) edited++;
    for (const f of p.flags) { if (f && f.word) flags++; else pageFlags++; }
  }
  // WHAT WAS BOUGHT, not what is on the pages (L5, the 16-page live run of 9/4).
  // `spent` above adds up the CURRENT text of every page that has audio, so a
  // page a grown-up corrected and had read again — bought twice, sitting on
  // disk once — was counted once, and at its new length: the card said 4614
  // characters while ElevenLabs had been sent 4986. The narrate step keeps its
  // own running ledger as it spends (content-store.addSpend), and that is the
  // number a parent is owed.
  //
  // The page sum stays as the FLOOR under it. A book narrated before the ledger
  // existed carries none at all, and one narrated then and re-narrated since
  // carries only its latest purchase; reporting either at face value would tell
  // a family a whole book had cost them one page. So: the ledger when it is
  // ahead (the re-narrate case, which is the whole point), the pages that
  // demonstrably have audio when it is behind, and never less than before.
  const ledger = Number(job && job.spent && job.spent.narrate && job.spent.narrate.chars) || 0;
  const owed = job ? store.owedState(job) : "inbox";
  const last = job && (job.errors || [])[job.errors.length - 1];
  // Worth showing while the book is stopped for good, and while the step it is
  // ON gave up part-way (job.held === "retry", written by content-worker.js for
  // a page the provider would not read). A finished step clears the hold, so a
  // book that has since moved on stops showing it — a card that keeps printing
  // yesterday's error under a book that has since published is a card nobody
  // believes. A quota pause is not this: it has its own sentence and nothing to
  // press.
  const stuck = !!last && (job.state === "failed" || job.held === "retry");
  // THE COST GATE (spec §4 step 5, T6.2). Animation is the one thing in the
  // product that spends dollars, so the review page may only enable its button
  // when this hub can say what the book will cost — pages × the price of one
  // clip, off the fal card. No key, no price, no quote, and `ready:false` keeps
  // the button disabled; a book that has not published yet is not quoted either,
  // because animating a half-built book would freeze it onto Ellie's shelf.
  // `done` is how many pages already have their clip, which is the only way a
  // parent can see that a run did anything (an optional step never marks a
  // finished book failed — content-worker.js).
  const price = perClip === undefined ? (DATA ? falPrice(DATA) : null) : perClip;
  const clips = Number(job && job.spent && job.spent.animate && job.spent.animate.calls) || 0;
  const published = fs.existsSync(path.join(dir, MANIFEST));
  const q = published ? quote(count, price) : null;
  // WHAT THE CARD MAY OFFER (spec §14, §13). Three derived answers, and no
  // device name behind any of them: `waiting` is a pile of photos nobody has
  // claimed — no job, no manifest — which the shelf draws a Build card over and
  // Settings says "N photos, waiting for a grown-up to tap Build"; `elsewhere`
  // is another computer's warm claim, which is the one time the card says why
  // there is no button; `buildable` is simply "this door would say yes", asked
  // of the door's own two steps rather than guessed at again in two pages.
  const held = heldElsewhere(dir, Date.now(), job);
  const finished = alreadyBuilt(dir, job);
  return {
    kind: "books",
    slug: slug || booksIndex.slugFor(path.dirname(dir), name) || "book",
    title: name,
    // A folder nobody has claimed is still a job — it is a pile of photos
    // waiting for a tap, and the Settings card must be able to say so.
    state: job ? job.state : "inbox",
    waiting: !job && !published && photos > 0 ? "pile" : null,
    buildable: !held && !finished,
    elsewhere: !!held && held.refused === "elsewhere",
    step: store.stepOwed(owed),
    progress: { pages: count, transcribed, narrated: narrated.size },
    // The narration side of the bill: ElevenLabs characters owed, and the ones
    // already paid for. What the moving pictures cost is its own count below,
    // in its own unit (clips), because the two are bought from different
    // providers in different units and adding them would be a made-up number.
    cost: { characters, narrated: Math.max(spent, ledger) },
    flags,
    pageFlags,
    edited,
    // `done` is the clips that ARRIVED (a readdir of video/); `clips` is the
    // clips fal was PAID for. They differ whenever a page was charged and then
    // lost — fal bills the moment it accepts a job, so a render that failed, a
    // queue that timed out or a CDN that would not hand the bytes over is money
    // spent with nothing on disk to show for it. Only the ledger knows, so it
    // is said out loud rather than left in job.json (review 9/5).
    animate: { ready: !!q, pages: count, perClip: q ? q.perClip : null,
               total: q ? q.total : null, done: animatedCount(dir),
               clips, spent: price ? Math.round(clips * price * 100) / 100 : null },
    // NOBODY HAS NAMED THIS BOOK YET (dad 9/7). True for a pile of loose photos
    // the hub gathered and gave a placeholder name to, until the cover names it
    // or a grown-up does. Two readers: the Settings card, which offers the
    // rename button under it, and the Book Reader's shelf, which is careful not
    // to announce a placeholder as if it were a title.
    autoTitle: !!(job && job.autoTitle),
    // WHAT IT IS WAITING FOR, when that is neither a pause nor a failure. The
    // holds content-worker.js parks a book on: "no-ai-key" (there is nothing to
    // spend yet), "retry" (a page the provider lost), "no-pages", "needs-title".
    // A book with no key used to be indistinguishable from one that was working
    // — the card said "Reading the words off the photos…" for ever, and the
    // Reader's shelf said "Add books with Google Drive" at a family whose Drive
    // was set up (dad 9/7). A hold is not an error, so it is its own field.
    held: (job && typeof job.held === "string" && job.held) || null,
    pausedUntil: (job && job.pausedUntil) || null,
    note: (job && job.pausedNote) || null,
    // The same pause, said in full: which allowance ran out, when it comes
    // back, and where more is added. The two fields above are what older
    // readers of this payload use and they do not move.
    paused: pausedOf(job),
    published,
    // job.errors is a history kept on purpose (a book that fell over twice for
    // two reasons is the one a parent needs the whole story of); `error` is only
    // the current one. Settings turns it into a sentence — the raw provider
    // text stays in log.jsonl, where it is for us and not for the family.
    error: stuck ? last.msg : null,
  };
}

// Every book folder, cheapest-first: three small reads per book and no walk of
// pages/. The running job's live step wins over the one job.json owes, so the
// card follows the work rather than lagging a whole step behind it.
function jobs() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return [];
  const { root, list: shelf } = shelfOf(st);
  const out = [];
  // One read of the fal card for the whole shelf, not one per book: every book
  // is quoted at the same price, and this file is on the path of a status poll.
  const perClip = DATA ? falPrice(DATA) : null;
  for (const { slug, dir: name } of shelf) {
    const dir = path.join(root, name);
    let j;
    // A folder that vanished mid-read, or a hand-edited text.json the schema
    // refuses: one bad book must never blank the whole card.
    try { j = jobFor(name, dir, slug, perClip); } catch { continue; }
    if (running && running.dir === dir && progress && progress.step) j.step = progress.step;
    out.push(j);
  }
  return out;
}

// The sentence a parent meets when they press "Re-narrate this page" on a hub
// that has never been given a voice. Words, not a status code and not a step
// name: the Voice card is where the fix is, so the message points at it.
const NO_VOICE = "New ERA has no voice yet — add an ElevenLabs key to the Voice card in Settings, then ask for this page again.";
// The same deal for "Read the photos again": reading a page costs a vision
// call, and a hub with no AI helper key would simply hold and change nothing.
const NO_VISION = "New ERA cannot read pages yet — add a key to the AI helper card in Settings, then ask for this book again.";
// And the one case where the button is right to do nothing: every page of the
// book is a page a grown-up typed, and they asked us to keep those.
const ALL_EDITED = "Every page of this book has words you typed yourself, and you asked to keep them — so there is nothing to read again.";
// The one button in the product that spends dollars, pressed on a hub that has
// no fal card. Said before a thread is spawned, because after that the family
// is billed — and said in words that name where the fix is.
const NO_FAL = "New ERA cannot make moving pictures yet — add a fal key to the Moving pages card in Settings, then ask for this book again.";
// And the one case where the press is right to do nothing: animating a book
// that has not published would write a manifest over a half-built book and put
// it on Ellie's shelf before it is ready (content-worker.js's republish law).
const NOT_FINISHED = "New ERA makes the moving pictures once a book is finished — this one is still being built.";

// WHICH PAGES "Read the photos again" ASKS FOR (spec §5 "Rebuild text", T3.4).
// The transcriber never re-reads a page that already has words — that rule is
// what makes a book resumable over several days on a free key — so a re-read
// has to name the pages it wants read a second time.
//
// `keepEdits` (the tick, on by default) leaves out every page a grown-up typed
// themselves: their words are the whole point of this page, and a button that
// threw them away next to the button that saved them would be a trap. Unticked,
// the photos win everywhere and the parent's words go with the rest.
//
// The list is the union of the pages that were BUILT and the pages text.json
// knows about, so a photo that was never read (a book that ran out of free
// quota half way) is picked up by the same press.
function rebuildPages(dir, keepEdits) {
  let text = null;
  try { text = store.readText(dir); } catch { return null; }
  const pages = (text && text.pages) || [];
  // Nothing has been read yet: the ordinary step does exactly the right thing,
  // so it is asked for nothing in particular.
  if (!pages.length) return null;
  let built = [];
  try { built = pagesOf(dir); } catch {}
  const keep = new Set(keepEdits ? pages.filter(p => p.edited).map(p => p.index) : []);
  const all = new Set([...built.map(p => p.index), ...pages.map(p => p.index)]);
  return [...all].filter(i => !keep.has(i)).sort((a, b) => a - b);
}

// POST /content/run's whole decision, kept here so the route stays four lines
// and so the same validation is available to anything else that kicks a build.
// Returns {started:true}, {skipped:"needs-local-drive"} (409) or {error} (400).
// An omitted step means "carry on from wherever this book is"; `page` names one
// page for a step that can do one (narrate — the review page's button, spec §5).
function runStep(o) {
  const req = o || {};
  const step = req.step == null || req.step === "" ? null : req.step;
  if (!KINDS.includes(req.kind)) return { error: "unknown kind" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  if (step !== null && !store.STEP_NAMES.includes(step)) return { error: "unknown step" };
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  // NOT WHILE ANOTHER COMPUTER HAS IT (spec §14: this door gets step 1, and
  // step 1 only). Two hubs running the same book's step both write text.json,
  // job.json and the narration ledger into one folder inside the family's Drive,
  // and the loser's minutes of work — and whatever they were billed for — are
  // simply overwritten. Never step 2: every write on the review page comes back
  // through here on a book that HAS a manifest, and animate REQUIRES one, so a
  // "this is already built" refusal here would lock a family out of the book
  // that just arrived.
  const elsewhere = heldElsewhere(found.dir, Date.now());
  if (elsewhere) return elsewhere;

  // ONE PAGE. Checked here rather than inside the worker for one reason: every
  // refusal has to happen before a thread is spawned and a provider is called,
  // because by then the family has already been billed for whatever it did.
  const page = req.page == null ? null : req.page;
  if (page !== null) {
    // Narration is the only step that can be done to one page: ingest,
    // transcribe and publish all read the whole folder. A page handed to one of
    // those would be silently ignored, and a parent would be left watching a
    // button that did nothing.
    if (step !== store.STEP_OWED.reviewing)
      return { error: "that step works on the whole book, not one page" };
    let text;
    try { text = store.readText(found.dir); }
    catch { return { error: "this book's text.json needs fixing by hand" }; }
    const pages = (text && text.pages) || [];
    if (!Number.isInteger(page) || !pages.some(p => p.index === page))
      return { error: "that is not a page of this book" };
  }
  // Nothing to record with. A step the WALK reaches with no key is a deliberate
  // empty outcome (the book publishes with text and no audio, spec §4), but a
  // parent who has just pressed a button is owed an answer instead of a book
  // that quietly does not change.
  if (step === store.STEP_OWED.reviewing && !(DATA && haveRoles(DATA).elevenlabs))
    return { error: NO_VOICE };

  // ANIMATION, THE ONE STEP THAT SPENDS DOLLARS (T6.2, spec §4 step 5). Both
  // refusals happen HERE, before a worker thread exists: a key fal has already
  // turned down buys nothing but a refusal, and a book that has not published
  // must not gain a manifest — with or without clips — from this door. The
  // review page keeps the button disabled in both cases; this is the same rule
  // said again where it cannot be bypassed by anything that posts.
  if (step === store.STEP_ANIMATE) {
    if (!(DATA && haveRoles(DATA).fal)) return { error: NO_FAL };
    if (!fs.existsSync(path.join(found.dir, "manifest.json"))) return { error: NOT_FINISHED };
  }

  // "READ THE PHOTOS AGAIN" (spec §5). Only the reading step can be asked to go
  // over pages it has already read — every other step either has nothing to
  // re-do or does the whole book anyway — and every refusal happens here, before
  // a thread is spawned, for the reason above: after that the family is billed.
  let pages = null;
  if (req.rebuild) {
    if (step !== store.STEP_OWED.transcribing)
      return { error: "only the reading step can be run again over pages it has already read" };
    if (page !== null) return { error: "reading the photos again is done to the whole book" };
    if (!(DATA && haveRoles(DATA).vision)) return { error: NO_VISION };
    pages = rebuildPages(found.dir, req.keepEdits !== false);
    if (pages && !pages.length) return { error: ALL_EDITED };
  }
  // A parent pressing "start this book" must not have to wait for the quiet
  // period they have just decided is over: an unclaimed folder is claimed here
  // and then built, exactly as scan() would have done in its own time.
  let job = store.readJob(found.dir);
  if (!job) claim(found.dir, null, Date.now());
  // "TRY AGAIN NOW" IS THE PRESS, and nothing else is. Every accepted write on
  // the review page re-publishes the book through this same door, so without the
  // flag a parent fixing one typo would put a refused book back on the
  // half-hourly walk against the key the provider had already turned down — for
  // ever, and started by somebody who never asked for it. A scan never does
  // either of the two things below.
  //
  // BOTH of them, on the same press, and not one else-if apart (review 9/5): a
  // book can be parked on a spent allowance AND then refused outright by a key
  // rotated under it, and a chain that took the failure alone left the pause
  // sitting on the job — the card went on telling the family to wait, and the
  // resumed step held on it again the instant it started.
  else if (req.retry === true) {
    // A BOOK THAT IS MERELY WAITING, AND A PARENT WHO WILL NOT (T6b.1). Out of
    // allowance is a pause, not a failure, and the steps honour it: the reading
    // step refuses to knock while one of its own pauses is recorded (that is
    // what saves a free key's requests) and would hold again the instant this
    // run started, so the press would buy nothing. This is the family saying
    // they have added credit — or simply that they would rather find out — so
    // the pause is lifted here, where the press is, and nowhere else.
    if (job.pausedUntil) job = store.writeJob(found.dir, store.unpause(job));
    // And the ONLY thing that lifts a permanent failure. A scan never retries
    // one — asking a key the provider refused only buys the same refusal — but
    // by the time a parent presses this they have usually just fixed the key the
    // card told them about, so the job goes back on the step it fell over on.
    if (job.state === "failed" && store.owedState(job) === null)
      store.writeJob(found.dir, store.transition(job, job.failedFrom || "inbox"));
  }
  run({ kind: req.kind, slug: req.slug, name: found.name, dir: found.dir,
        dataDir: DATA, step, page, pages }).catch(() => {});
  return { started: true };
}

// ------------------------------------------- BUILD THIS ONE, HERE (spec §14)

// THE THREE REFUSALS, IN A PARENT'S OWN WORDS. Every door below answers
// {refused, error} and the card renders the sentence verbatim: only the hub
// knows WHY, and a bare code would have three pages inventing three wordings
// for the same thing (server.js's two older doors could not say why at all —
// {error} became 400 and {skipped} became 409 with nothing to render).
const ELSEWHERE = "Another computer in the family is making this book. It will "
  + "appear here when it is finished.";
const CHECKING = "New ERA is checking whether another computer has already "
  + "started this book. Try again in a minute.";
const BUILT = "This book is already made — you can read it in Book Reader.";
// The tap landed while the photos were still being copied onto this computer
// (Drive holds a handle open on a file it is still writing, and content-gather
// leaves it exactly where it is). Nothing was made, and the next tap will work.
const STILL_ARRIVING = "Those photos are still arriving on this computer. Try "
  + "again in a minute.";

// The claim line the OTHER hub left, or null. `by` is a field on lines written
// by this release (content-store.appendLog); the two literal prefixes are what
// a line from an older hub has instead, and they are read rather than dropped
// because a family updates one computer at a time.
const CLAIM_PROSE = /^(?:claimed by|taken over by)\s+(\S+)/;
function lastClaim(dir) {
  const lines = store.readLog(dir);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l.step !== "claim") continue;
    if (l.by != null && String(l.by) !== "") return { who: deviceOf(l.by), t: l.t };
    const m = CLAIM_PROSE.exec(String(l.msg || ""));
    if (m) return { who: deviceOf(m[1]), t: l.t };
    return null;                       // a claim line that names nobody at all
  }
  return null;
}

// Is the claim still warm? Not the heartbeat alone: a book that held for a spent
// allowance wrote a fresh heartbeat as it held and then stopped beating
// (content-worker.js holdHere), so on the heartbeat alone a second device walks
// in the moment `pausedUntil` passes — before the owner's own scan has had its
// turn at the book it is waiting on. The later of the two is the moment the
// claim starts going cold, and STALE_MS is the same half hour everywhere else.
function claimWarm(job, now) {
  const beat = Date.parse(job && job.heartbeat);
  const wake = Date.parse(job && job.pausedUntil);
  const last = Math.max(Number.isFinite(beat) ? beat : -Infinity,
                        Number.isFinite(wake) ? wake : -Infinity);
  return Number.isFinite(last) && now - last < STALE_MS;
}

// A book with no work left is not "being built somewhere else": its claim is a
// record of who built it, not a hand on the wheel. takeable() has said the same
// since the first release, and this door must agree with it — the weekly book
// arrives signed with a claim whose heartbeat is minutes old (spec §8), and
// every review-page action on that book comes through the two doors that get
// step 1.
function owesWork(job) {
  return !!job && job.state !== "done" && job.state !== "published" &&
         store.owedState(job) !== null;
}

// WHO HOLDS THIS BOOK (spec §14 step 1), or null when nobody else does.
//
// job.json is the answer when there is one to read, and there often is not:
// the worker rewrites it every 60 s while it builds (content-worker.js), Drive
// mirrors .build/ in whatever order it likes, and a file caught mid-mirror
// parses as nothing. So an unreadable job.json is "checking" rather than "free"
// — the difference between the two answers is a second copy of a build the
// family has already paid for — and a folder with NO job.json is asked of
// log.jsonl instead, where the other hub's claim line usually lands first.
// `known` is the job.json the caller has already read (jobFor reads one per
// book on every status poll); leave it out and this reads its own.
function heldElsewhere(dir, now, known) {
  const job = known === undefined ? store.readJob(dir) : known;
  if (job) {
    if (!owesWork(job)) return null;
    // A claim that names nobody (a job.json written by hand in power mode) is
    // not another computer's.
    const who = deviceOf(job.claimedBy);
    if (!who || mineName(who)) return null;
    return claimWarm(job, now) ? { refused: "elsewhere", error: ELSEWHERE } : null;
  }
  if (fs.existsSync(store.jobPath(dir))) return { refused: "checking", error: CHECKING };
  const line = lastClaim(dir);
  if (!line || !line.who || mineName(line.who)) return null;
  const at = Date.parse(line.t);
  if (!Number.isFinite(at) || now - at >= STALE_MS) return null;
  return { refused: "checking", error: CHECKING };
}

// NEVER TWICE (spec §14 step 2). A manifest is a finished book; `done` and
// `published` are the two states the walk owes nothing from — and the weekly
// book's job.json says `done` BEFORE its manifest is uploaded (spec §8),
// precisely so a hub that sees the folder half-delivered leaves it alone.
function alreadyBuilt(dir, job) {
  const done = job && (job.state === "done" || job.state === "published");
  return done || fs.existsSync(path.join(dir, MANIFEST))
    ? { refused: "built", error: BUILT } : null;
}

// POST /content/build's whole decision: the tap on a Build card (spec §13, §14).
// "The 'build' for local button is simply to make sure that when users upload a
// book multiple devices don't build the same book. You should have logic to
// make sure that once a book is built in drive it is not built again too"
// (dad, 9/9). Everything the scan stopped doing happens here, once, because a
// person asked for it on the computer that will do the work:
//
//   {kind:"books", slug}       a pile folder, or a job this hub may take over
//   {kind:"books", loose:true} the pile in books/ itself, which has no slug
//                              until it is gathered
//
// Returns {started, slug}, {refused, error} (409), {error} (400) or
// {skipped:"needs-local-drive"} (409).
function build(o) {
  const req = o || {};
  if (!KINDS.includes(req.kind)) return { error: "unknown kind" };
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  const now = Date.now();
  const root = path.join(st.folderPath, "books");

  // THE PILE WITH NO FOLDER. Nothing to refuse it with: it has no folder, so no
  // job.json, no claim line and no manifest — which is why the card sends
  // `loose:true` rather than a slug (reader.js's old " loose" sentinel is never
  // sent). The gather makes the folder, names it after today, claims it with
  // `autoTitle` and starts it, all inside gatherLoose().
  if (req.loose === true) {
    let pile = null;
    try { pile = gatherLoose(root, now, { force: true }); }
    catch (e) {
      console.error("[content] could not gather the loose photos: " + store.redact(e.message));
      return { refused: "checking", error: STILL_ARRIVING };
    }
    // Nothing moved: either there was no pile left (another device gathered it
    // and Drive has already told us), or every photo is still held open by
    // whatever is copying it in. Both are "try again in a minute", and neither
    // leaves anything behind.
    if (!pile) return { refused: "checking", error: STILL_ARRIVING };
    return { started: true, slug: pile.slug };
  }

  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  const job = store.readJob(found.dir);

  // Step 2 before step 1 in ONE case, deliberately: when both would refuse, the
  // true sentence is "this book is already made", not "another computer is
  // making it". The weekly book arrives finished AND with a claim minutes old,
  // and a card that told a family to wait for a book that is already on their
  // shelf would be a card nobody believes.
  const built = alreadyBuilt(found.dir, job);
  if (built) return built;
  const held = heldElsewhere(found.dir, now);
  if (held) return held;

  try {
    // A pile folder is claimed at `inbox`; another device's job is taken over
    // exactly as a scan used to do it, keeping its state and its errors so it
    // resumes where it fell over. A job that is ALREADY ours and still warm is
    // neither: it is running or about to, and run() below joins it rather than
    // writing job.json out from under the worker that holds the folder.
    //
    // WHOEVER THE DOOR LETS BUILD, SIGNS (review 9/10). The test is "is this
    // claim ours?", NOT takeable() — the two questions disagree in a window
    // wide enough to matter. A job held for something no clock brings backs off
    // to the twelve-hour look (SLOW_HOLDS in takeable), so between half an hour
    // and twelve hours the claim is cold to the door above (which let this tap
    // through) and still not takeable to the scan. Claiming only on takeable()
    // ran the book HERE while job.json went on naming the other computer: no
    // claim line for it to read, and its own next scan saw a claim naming ITSELF
    // go warm again and could resume the same book — the double build §14 is
    // written to prevent. takeable() stays in the test for the one case isMine()
    // cannot see: OUR OWN job gone stale, which is a resume and wants the fresh
    // heartbeat and the line that says so.
    if (!job) claim(found.dir, null, now);
    else if (!isMine(job) || takeable(job, now)) claim(found.dir, job, now);
  } catch (e) {
    console.error("[content] could not claim " + found.name + ": " + store.redact(e.message));
    return { refused: "checking", error: CHECKING };
  }
  run({ kind: "books", slug: req.slug, name: found.name, dir: found.dir,
        dataDir: DATA }).catch(() => {});
  return { started: true, slug: req.slug };
}

// ---------------------------------------- "not while it is being built" (§5)

// A worker owns a book's folder outright while it has it: content-providers.js
// reads the whole of text.json into memory at the top of a transcription and
// writes the whole array back from that snapshot minutes later. So a write that
// lands in between is not a write at all — it is thrown away silently, and the
// parent who made it was told "Saved ✓".
//
// Every door that writes into a book folder asks this first, and they all say
// the same two sentences, because to a parent "it is building" and "it is about
// to build" are the same answer: come back in a minute.
// Returns {error} for a folder that is spoken for, or null.
function busyWith(dir) {
  const at = path.resolve(dir);
  if (running && path.resolve(running.dir) === at)
    return { error: "New ERA is working on this book right now — try again in a minute." };
  if (queue.some(q => path.resolve(q.job.dir) === at))
    return { error: "New ERA is about to work on this book — try again in a minute." };
  return null;
}

// ------------------------------------------------------- naming a book (9/7)

// The other half of content-worker.js's `needs-title` hold: the worker has
// exited, so the folder is free to move. Called from begin() and from nowhere
// else. Returns the job to run the book under next — the SAME book, at the step
// it was already on — or null if it can no longer be found.
//
// Nothing here is allowed to be a reason a book stops. A title that turns into
// nothing usable, a rename Windows refuses because Drive has the folder open, a
// job.json that will not take a write: every one of them ends the same way, with
// the book carrying on under the placeholder name it was born with and a parent
// able to rename it in Settings. The ONE thing that must happen is that
// `autoTitle` goes, because that is what stops the book being asked twice.
function nameBook(job, title) {
  const root = path.dirname(job.dir);
  const was = path.basename(job.dir);
  let out = { name: was, dir: job.dir, renamed: false };
  try { out = gatherer.rename(root, was, title); }
  catch (e) { console.error("[content] could not name " + was + ": " + store.redact(e.message)); }
  const j = store.readJob(out.dir);
  if (j) {
    const next = { ...j };
    delete next.autoTitle;
    delete next.held;                  // the hold is answered; nothing is waiting
    try { store.writeJob(out.dir, next); }
    catch (e) { console.error("[content] could not clear the name note: " + store.redact(e.message)); }
  }
  if (out.renamed) {
    seen.delete(job.dir);
    store.appendLog(out.dir, "title", "the cover names this book: " + out.name);
    console.log("[content] the gathered book is called " + out.name);
  }
  const slug = slugOf(root, out.name);
  if (!slug) return null;
  return { kind: "books", slug, name: out.name, dir: out.dir, dataDir: job.dataDir || DATA };
}

// "…and let me say otherwise" (dad, 9/7). The hub's guess is a guess: the cover
// may be an inside page, the pile may have been two books, and a parent must be
// able to put it right without opening a file browser. POST /content/rename is
// that, and it is deliberately the same three guards "Remove this book" has —
// a slug is never a path, not while it is being built, and nothing is said back
// that names a folder on the family's disk.
//
// Renaming a book that is ALREADY ON THE SHELF is allowed and is followed by a
// publish, because manifest.json is the only thing the Reader ever reads and it
// carries the title. The package's URL changes with its folder (books-index.js
// assigns slugs from folder names), so the shelf shows the new book and the
// mirror takes the old copy away on its next sync — the same way it does for a
// book renamed by hand in Google Drive, which has always been possible.
//
// Returns {renamed, slug, title, was}, {skipped:"needs-local-drive"} (409) or
// {error} (400).
function renameBook(o) {
  const req = o || {};
  if (!KINDS.includes(req.kind)) return { error: "unknown kind" };
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const want = gatherer.safeTitle(req.title);
  if (!want) return { error: "That name will not work as a folder name — letters, numbers and spaces are safest." };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  const root = path.resolve(st.folderPath, "books");
  const dir = path.resolve(root, found.name);
  if (path.dirname(dir) !== root || dir === root) return { error: "unknown book" };
  const busy = busyWith(dir);
  if (busy) return busy;
  if (want === found.name) return { renamed: false, slug: req.slug, title: found.name };
  let res;
  try { res = gatherer.rename(root, found.name, want); }
  catch (e) {
    console.error("[content] could not rename " + found.name + ": " + store.redact(e.message));
    return { error: "That book could not be renamed — close anything that has its "
                  + "folder open on this computer and try again." };
  }
  seen.delete(dir);
  const slug = slugOf(root, res.name) || req.slug;
  // A GROWN-UP HAS NAMED IT, so the cover never gets to overrule them: a book
  // renamed while it was still waiting for its title keeps the name they typed.
  const j = store.readJob(res.dir);
  if (j && j.autoTitle) {
    const next = { ...j };
    delete next.autoTitle;
    try { store.writeJob(res.dir, next); } catch {}
  }
  // Already on the shelf: publish again, so the manifest (and with it the
  // Reader's shelf card) carries the name a parent just typed. Not on the shelf
  // yet: carry on with whatever step it owed.
  //
  // THERE IS NOTHING TO RUN ON A BOOK NOBODY HAS CLAIMED. A folder still inside
  // its quiet ten minutes has no job.json, and the worker's first act is to read
  // one: it throws "no job.json in <folder>", and the catch around it writes
  // that line into .build/log.jsonl INSIDE the family's Drive folder — making a
  // .build/ directory, for Drive to upload to every device, under a folder the
  // parent has only just made. The next scan picks the folder up under its new
  // name anyway (its quiet clock was reset by the seen.delete above), which is
  // the same minute it would have started in had nobody renamed it.
  //
  // AND NOTHING RUNS WHILE ANOTHER COMPUTER HAS THE BOOK (spec §14: this door
  // gets step 1 too). The rename itself always happens — a grown-up may name
  // their own book whatever is building it, and the folder moves inside their
  // own Drive for the other device to see — but the build that would follow is
  // the other computer's to finish, and two hubs on one folder is exactly what
  // step 1 exists to prevent.
  const published = fs.existsSync(path.join(res.dir, MANIFEST));
  if (j && !heldElsewhere(res.dir, Date.now()))
    run({ kind: "books", slug, name: res.name, dir: res.dir, dataDir: DATA,
          step: published ? store.STEP_OWED.narrating : null }).catch(() => {});
  console.log("[content] a grown-up renamed a book folder");
  return { renamed: true, slug, title: res.name, was: found.name };
}

// ------------------------------------------------------- "Remove this book"

// THE ONE DOOR IN THE SUITE THAT DELETES A FAMILY'S OWN FILES (spec §5). It
// removes the book's folder inside the family's Drive folder; the Phase 1 mirror
// then takes the copy in <DATA> away on its next pass, so there is exactly one
// delete and it happens where the parent can see it in their own Drive.
//
// Three rules, and the button does not ship without all three:
//   1. A SLUG IS NEVER A PATH. bookFor() answers only with a directory NAME
//      books-index.js read off the disk, so "../.." names no book at all. The
//      resolved path is re-checked below anyway: the whole licence to delete
//      rests on that one property, and a jail worth having is one that does not
//      depend on a function three modules away staying the way it is today.
//   2. NOT WHILE IT IS BEING BUILT. A worker with the folder open would write
//      job.json back underneath us and leave half a book behind.
//   3. NOTHING IS LOGGED INTO THE FOLDER. It is about to go; the record goes to
//      the hub's own console (and never names anything but the book's title).
//
// Returns {removed, slug, title}, {skipped:"needs-local-drive"} (409) or
// {error} (400).
function removeBook(o) {
  const req = o || {};
  if (!KINDS.includes(req.kind)) return { error: "unknown kind" };
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  const root = path.resolve(st.folderPath, "books");
  const dir = path.resolve(root, found.name);
  // A DIRECT CHILD of books/, and nothing else: not books/ itself, not a
  // grandchild, not a sideways step out of it.
  if (path.dirname(dir) !== root || dir === root) return { error: "unknown book" };
  const busy = busyWith(dir);
  if (busy) return busy;
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) {
    // The reason belongs in the hub's own console, not in the answer: rmSync's
    // message carries the whole path it fell over on, and store.redact only
    // takes out things that look like keys. A status page is not a map of the
    // family's disk (jobFor's law, six lines above it), and this door is the
    // one place that had been handing one out.
    console.error("[content] could not remove " + found.name + ": " + store.redact(e.message));
    return { error: "That book could not be removed — close anything that has its "
                  + "folder open on this computer and try again." };
  }
  seen.delete(found.dir);                       // no quiet clock for a folder that is gone
  console.log("[content] removed the book folder " + found.name + " (a grown-up asked)");
  return { removed: true, slug: req.slug, title: found.name };
}

// ------------------------------------------------------- the review page (§5)

// THE ORDER OF A BOOK. text.json's ARRAY order is the reading order; a page's
// `index` is its identity — the photo it was made from, and the audio, the
// flags and the characters already bought for it. A parent dragging page four
// to the front permutes the array and touches nothing else, so nothing that
// was paid for is lost and no file is renamed inside the family's Drive folder
// (which would hand Drive every page to re-upload). content-publish.js reads
// the same array order, so the shelf follows the drag.

// Every page of one book, for the strip the review page draws. Same law as
// jobFor(): no absolute path, no claim, nothing key-shaped — the photo comes
// back as a URL onto the route below, never as a path on the family's disk.
function pagesFor(slug) {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof slug !== "string" || !slug) return { error: "unknown book" };
  const found = bookFor(slug, st);
  if (!found) return { error: "unknown book" };
  // A hand-edited text.json the schema refuses must say so plainly, not 500:
  // the parent who broke it in power mode is the one reading this page.
  let text;
  try { text = store.readText(found.dir) || { pages: [] }; }
  catch { return { error: "this book's text.json needs fixing by hand" }; }
  let built = new Map();
  try { built = new Map(pagesOf(found.dir).map(p => [p.index, p])); } catch {}
  const job = store.readJob(found.dir);
  return {
    slug, title: found.name,
    state: job ? job.state : "inbox",
    published: fs.existsSync(path.join(found.dir, "manifest.json")),
    pages: text.pages.map(p => ({
      index: p.index, text: p.text, flags: p.flags, cover: p.cover,
      // WHOSE WORDS THESE ARE (L6). The words a grown-up typed have no `read`
      // and never will, so this is the only thing that can tell the review page
      // "you wrote this page" instead of leaving it looking unread. `read`
      // itself stays off this payload: a model name is provenance for the log,
      // not a sentence for a parent.
      edited: !!p.edited,
      // Null for a page text.json knows about but no photo was built for — the
      // card draws its own empty frame rather than an <img> onto a 404.
      image: built.has(p.index)
        ? "/content/page?slug=" + encodeURIComponent(slug) + "&index=" + p.index : null,
    })),
  };
}

// The file behind one page's photo. The path NEVER comes from the URL: the
// index is looked up in ingest's own record (content-providers.pagesOf) and the
// answer is re-checked to be inside this book's pages/ before it is served.
// Straight from the build folder rather than through /books/<slug>/, because
// the Drive mirror runs every ten minutes and a book being reviewed is nearly
// always newer than the mirror's copy.
function pageFile(slug, index) {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof slug !== "string" || !slug) return { error: "unknown book" };
  if (!Number.isInteger(index)) return { error: "unknown page" };
  const found = bookFor(slug, st);
  if (!found) return { error: "unknown book" };
  let page = null;
  try { page = pagesOf(found.dir).find(p => p.index === index) || null; } catch {}
  if (!page) return { error: "unknown page" };
  const file = path.resolve(found.dir, page.image);
  const jail = path.resolve(found.dir, "pages") + path.sep;
  if (!file.startsWith(jail)) return { error: "unknown page" };
  try { if (!fs.statSync(file).size) return { error: "unknown page" }; }
  catch { return { error: "unknown page" }; }
  return { file };
}

// POST /content/text's whole decision: the new reading order and which page
// wears the cover. Refused outright unless `order` names every page of THIS
// book exactly once — a half-applied order would lose a page out of the book,
// and the parent's only sign of it would be a shorter shelf entry.
// Returns {saved}, {skipped:"needs-local-drive"} (409) or {error} (400).
function saveOrder(o) {
  const req = o || {};
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  // The same rule the remove door has, and for the same reason: a drag made
  // while "Read the photos again" is running is a drag the transcriber writes
  // back over without either of them noticing.
  const busy = busyWith(found.dir);
  if (busy) return busy;
  let text;
  try { text = store.readText(found.dir); }
  catch { return { error: "this book's text.json needs fixing by hand" }; }
  const pages = (text && text.pages) || [];
  if (!pages.length) return { error: "no pages yet" };

  const by = new Map(pages.map(p => [p.index, p]));
  const order = req.order == null ? pages.map(p => p.index) : req.order;
  if (!Array.isArray(order)) return { error: "the new order must be a list of pages" };
  if (order.length !== pages.length || new Set(order).size !== order.length
      || !order.every(i => Number.isInteger(i) && by.has(i)))
    return { error: "the new order must name every page of this book, once" };

  // An omitted cover keeps whichever page has it (the first page if none does);
  // an explicit null means the same thing. content-publish.writeCover() reads
  // exactly one `cover:true`, so exactly one is what is written.
  const keep = pages.find(p => p.cover);
  let cover = req.cover === undefined || req.cover === null
    ? (keep ? keep.index : order[0]) : req.cover;
  if (!Number.isInteger(cover) || !by.has(cover)) return { error: "unknown cover page" };

  const next = order.map(i => ({ ...by.get(i), cover: i === cover }));
  store.writeText(found.dir, { pages: next });
  store.appendLog(found.dir, "review",
    "a grown-up set the page order and the cover (" + next.length + " page(s), cover " + cover + ")");
  return { saved: true, pages: next.length, cover,
           published: fs.existsSync(path.join(found.dir, "manifest.json")) };
}

// A page of a picture book is a sentence or two. This is a sanity bound on what
// arrives over HTTP, not a rule about writing — the route's own body cap is the
// other half of it.
const MAX_PAGE_TEXT = 4000;

// POST /content/text's other half (T3.3, spec §5): ONE page's own words, and
// the flags on it. The order and the cover are saveOrder's; this touches
// neither, so a parent fixing a word cannot lose their page order to a race
// with their own drag.
//
// FLAGS ARE ANSWERED HERE, NEVER AUTHORED. A flag says "the model was not sure
// of this word", and only the transcriber may say that — a door that could
// invent one could put a mark under any word in the family's own book. So the
// only list this takes is the empty one.
//
// Returns {saved}, {skipped:"needs-local-drive"} (409) or {error} (400).
function savePage(o) {
  const req = o || {};
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return { skipped: "needs-local-drive" };
  if (typeof req.slug !== "string" || !req.slug) return { error: "unknown book" };
  const found = bookFor(req.slug, st);
  if (!found) return { error: "unknown book" };
  if (!Number.isInteger(req.page)) return { error: "the page must be a whole number" };
  // As above: the words a parent types while the transcriber holds this book
  // are words the transcriber writes back over.
  const busy = busyWith(found.dir);
  if (busy) return busy;
  let text;
  try { text = store.readText(found.dir); }
  catch { return { error: "this book's text.json needs fixing by hand" }; }
  const pages = (text && text.pages) || [];
  const at = pages.findIndex(p => p.index === req.page);
  if (at < 0) return { error: "that is not a page of this book" };

  const words = req.text !== undefined, flags = req.flags !== undefined;
  if (!words && !flags) return { error: "nothing to change on that page" };
  if (words && typeof req.text !== "string") return { error: "a page's words must be text" };
  if (words && req.text.length > MAX_PAGE_TEXT)
    return { error: "that is more words than a page of a picture book holds" };
  if (flags && !(Array.isArray(req.flags) && req.flags.length === 0))
    return { error: "flags can only be cleared here" };

  const next = pages.slice();
  const p = { ...next[at] };
  if (words) {
    // THE AUDIO NO LONGER SAYS WHAT THE PAGE SAYS. Narration is bought per page
    // and never re-checked against the words it was bought for (content-narrate
    // rule 2), so a page republished now would SHOW the corrected line and SPEAK
    // — and highlight — the misread one, for ever: the next narrate walk would
    // reuse the mp3 too. The entry goes, the page publishes silent, and the walk
    // (or the Re-narrate button beside this one) buys the right recording.
    // Only when the words actually changed: a parent who opened the field and
    // typed nothing must not be charged for the page a second time — and must
    // not have the page's authorship rewritten either. The review page posts the
    // textarea verbatim on every Save press, with no equality check of its own,
    // so "opened the editor, pressed Save" is an ordinary thing to do and it
    // used to cost the page its provenance: the model that read it forgotten,
    // the page badged "Edited by you", and "Read the photos again" told to keep
    // words nobody typed, for ever.
    const changed = req.text !== p.text;
    if (changed) forgetPage(found.dir, req.page);
    p.text = req.text;
    if (changed) {
      // WHOSE WORDS THESE ARE. The button next to this one reads the photos
      // again, and it keeps the pages a grown-up typed themselves (spec §5, the
      // "keep my edits" tick) — so the page has to remember that it was typed.
      p.edited = true;
      // And these are nobody's reading: `read` says which model produced the
      // words and who checked them (F7), and the words are now the parent's own.
      // `edited` is the provenance of a typed page.
      delete p.read;
    }
    // Cleared either way. A flag is a question ("did I read this word right?")
    // and a parent who pressed Save on the line has answered it, whether or not
    // they changed a letter. Left behind, the Settings card would go on counting
    // words the model was unsure of under words a grown-up has looked at.
    p.flags = [];
  }
  if (flags) p.flags = [];
  next[at] = p;
  store.writeText(found.dir, { pages: next });
  store.appendLog(found.dir, "review", words
    ? "a grown-up rewrote page " + req.page + " (" + p.text.length + " character(s))"
    : "a grown-up cleared the flags on page " + req.page);
  // `edited` comes back with the words so the card can wear its badge there and
  // then (L6): a parent who has just typed a page must not have to reload the
  // book to see that it is now theirs.
  return { saved: true, page: req.page, text: p.text, flags: p.flags, edited: !!p.edited,
           published: fs.existsSync(path.join(found.dir, "manifest.json")) };
}

// The one door the review page writes through. Which half of it a request means
// is decided by whether it names a page — a whole-book write (the drag, the
// cover) never names one, and a per-page write always does.
function saveText(o) {
  const req = o || {};
  return req.page == null ? saveOrder(req) : savePage(req);
}

// ------------------------------------------------------------------- status

// Deliberately thin, and deliberately free of the claim's device name and of
// anything key-shaped: /content/status is public.
function status() {
  const st = drive.status();
  const local = st.mode === "local" && !!st.folderPath;
  return {
    mode: st.mode,
    local,
    // Why there is nothing to show, in the one word Settings turns into a
    // sentence: the hub's Drive scope is read-only, so a book built in API mode
    // could never reach the family's Drive (Gap 1).
    skipped: local ? null : "needs-local-drive",
    // THE PILE THAT IS NOT A BOOK YET (dad 9/7). Photos sitting loose in
    // books/, counted so both cards can say "seventeen photos are waiting"
    // rather than "no books yet" — which is what the Book Reader said to a
    // family whose seventeen photos were sitting right there. `quietMs` travels
    // with it so neither page has to hard-code the ten minutes: the card's
    // promise ("building starts about ten minutes after the last photo") is
    // then the same number this module actually waits.
    loose: local ? gatherer.looseNames(path.join(st.folderPath, "books")).length : 0,
    quietMs: QUIET_MS,
    building: !!running,
    job: running ? { kind: running.kind, slug: running.slug,
                     step: (progress && progress.step) || running.step || null } : null,
    queued: queue.map(q => q.job.slug),
    jobs: jobs(),
    // HOW MUCH MONTH IS LEFT (T6b.1). Characters, not money: it is what
    // ElevenLabs counts and what the Voice card can turn into "about K pages".
    // null whenever we cannot say — no voice card, an answer that has not come
    // back yet, a provider that would not answer — because a made-up allowance
    // is worse than none. Cached for ten minutes inside content-narrate, so
    // this poll never becomes a call.
    narration: DATA ? voiceAllowance(DATA) : null,
    lastScan,
  };
}

function tick(reason) {
  const res = scan();
  if (res.skipped || !res.claimed.length) return res;
  console.log("[content] claimed " + res.claimed.join(", ") + " (" + reason + ")");
  return res;
}

// `deviceId` is server.js's DEVICE_ID (device-id.js), and it is what every
// claim this hub writes is signed with from here on. Absent — a test, or a
// caller written before spec §14 — the claim falls back to the machine name it
// has always used, which is exactly what isMine() forgives on the way back in.
function start(dataDir, opts) {
  DATA = dataDir;
  DEVICE = (opts && opts.deviceId) || null;
  // Late enough that the first local sync (drive.js:493) has had its go, so a
  // fresh install does not spend its first scan on a half-copied folder.
  setTimeout(() => tick("startup"), 90 * 1000).unref();
  setInterval(() => tick("scan"), SCAN_EVERY).unref();
}

module.exports = {
  // Set by server.js: {kind, slug, name, dir} for a book that just published.
  // One property, one owner — the same shape (and the same warning about a slot
  // with two owners) as drive.onSynced.
  onPublished: null,
  start, scan, tick, run, runJob, runStep, build, isBuilding, idle, status, beat, claim,
  jobs, jobFor, bookFor, pagesFor, pageFile, saveOrder, savePage, saveText,
  rebuildPages, removeBook, renameBook, gatherLoose, isMine,
  KINDS, QUIET_MS, STALE_MS, MAX_PAGE_TEXT, NO_VOICE, NO_VISION, ALL_EDITED,
  NO_FAL, NOT_FINISHED, ELSEWHERE, CHECKING, BUILT,
  // `deviceId` is set only when it is given, and left alone otherwise: a suite
  // that named this device at start() gets it back on every reset without
  // having to say so twice (clothing.js's _testReset takes its options the same
  // way).
  _testReset: (opts) => {
    running = null; inflight = null; queue = []; seen = new Map();
    progress = null; lastScan = null; told = new Map();
    if (opts && "deviceId" in opts) DEVICE = opts.deviceId || null;
    module.exports.runJob = runJob;
    module.exports.onPublished = null;
  },
};
