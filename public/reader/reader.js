// Book Reader v2 — the OLD Book-Reader UI (dad: "I like my old layout. Please
// match.") ported from components/reader-client.tsx + library-client.tsx onto
// the hub's LOCAL package data layer (which stays exactly as v1 shipped it):
// /books/index.json + /books/<slug>/manifest.json, recorded mp3 narration with
// manifest words[] word-sync (binary search, MONOTONIC), interpolation
// fallback, /settings dwell knobs, pool /log events, localStorage resume.
// This app NEVER calls speechSynthesis.
//
// THE OLD READER'S RULES (ported 1:1 — the "pauses with the arrow" behavior):
//  * A page auto-reads when it appears (page turns queue auto-play; the very
//    first page reads on open).
//  * When narration ENDS the reader PAUSES ON THE PAGE: the next-arrow grows
//    to the big center-right ready-arrow (pulsing after 5s) and WAITS for
//    her. The page NEVER turns itself. (v1 auto-advanced 600ms after audio —
//    that is the regression dad called out.)
//  * Activating an arrow MID-NARRATION stops the current page's narration
//    before turning — the story never talks across a page turn.
//  * Triggering the ready arrow on a page WITH a video plays the video first
//    (overlaid on the page image, old outro presentation; the big arrow
//    shrinks back to the corner so her gaze on the video can't re-arm it);
//    the video's end turns the page. On the LAST page the video auto-plays
//    when audio ends, since there is no arrow left to trigger it.
//  * End of book: the Library button grows 5x at left-center and pulses —
//    the invitation back to the shelf. No "The End" screen.
//  * A textless/silent page is "finished" the moment it shows (ready arrow
//    immediately) — she is never stuck.
//  * Read/Pause pill: pauses mid-word, resumes in place, restarts after end.
// THE DOOR IS THE SHARED BAR (9/17, spec §6.1): the shelf's "Back to TD Snap"
// tile is gone and both screens sit under era-core's lib/doorbar.js strip —
// 🚪 leave, 💬 pause to talk. The bar owns the holds (2 x her dwell on both
// doors) and the coming-back listener; this file owns only what PAUSING means
// to a book: stop the sound where it is, and pick the page up again.
// Missing index/manifest degrades to an empty shelf / page 1 — never a dead
// app (8/19 law). Every page render suppresses dwell for the settle window
// (D51) — a fresh page never inherits her gaze.
"use strict";

const S = {
  session: "r" + Date.now(),
  childName: "",      // from /settings at boot — the shelf title and the "…'s story" badge
  index: [],          // /books/index.json rows {slug,title,cover,pages,hasVideo,authored}
  building: [],       // /content/status rows for books not on the shelf yet — a
                      // pile of photos nobody has tapped Build on, and a book
                      // being made (spec §13)
  here: [],           // the slugs THIS hub has in hand right now — the book it is
                      // building and the ones queued behind it (/content/status
                      // `job` + `queued`). A card for one of those asks for
                      // nothing: see offersBuild()
  asking: null,       // {slug} while the Build question is open over one card
  drive: null,        // true/false/null — has this computer a Drive folder set up?
  manifest: null,     // the open book's manifest
  slug: null,
  page: 0,
  wordSpans: [],      // current page's word-token <span>s, in reading order
  words: null,        // resolved [{word,start,end}] — manifest's or interpolated
  activeIdx: -1,      // word-sync cursor: NEVER decreases within one playback
  reading: false,     // narration currently playing
  paused: false,      // narration paused mid-page (Read/Pause pill)
  finished: false,    // narration done on this page -> big ready-arrow waits
  bookFinished: false,// last page done -> big pulsing Library button
  playingOutro: false,// page video overlay currently showing
  pulseTimer: null,   // 5s ready -> pulse timer (old reader's nudge)
  ignorePause: null,  // one-tick latch: our own stop must not read as "Paused"
  renderGen: 0,       // bumps per render — stale async media outcomes are ignored
  talkResume: null,   // what 💬 interrupted, decided while it was still true:
                      // "video" | "narration" | null (see onTalkPause)
};

// her dwell out of /settings, in the hub's own band (the board's clampDwell).
// The bar doubles it for its two doors; nothing else in this app carries a
// literal hold at all (dad 9/17: one dwell, and only leaving the screen buys
// extra time).
function clampDwell(n) {
  if (typeof n !== "number" || !isFinite(n)) return 1200;
  return Math.max(600, Math.min(3000, n));
}

const $ = (id) => document.getElementById(id);
// "Maya's story" when Settings knows her name, "My story" until it does
const whose = () => (S.childName ? S.childName + "'s" : "My");
const narration = $("narration");
const video = $("pageVideo");

function log(event, detail) {
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), session: S.session, app: "reader", event, ...detail }) }).catch(() => {});
}
function suppress() { if (window.Dwell && Dwell.suppress) Dwell.suppress(); }

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("show"));
  $(id).classList.add("show");
  document.body.classList.toggle("reading", id === "sRead");
  suppress();                                    // new surface: settle before gaze arms
}

// ---------- old DwellButton ring: mirror the engine's fill into the conic
// progress ring (--dwell-progress, 0..360deg — dwell.js stays untouched) ----
new MutationObserver((muts) => {
  for (const mu of muts) {
    const el = mu.target;
    if (!el.classList || !el.classList.contains("dwell-fill")) continue;
    // :not(.bardoor) — the shared bar keeps era-core's feedback, not ours
    // (index.html's two .dwell-fill/.dwell-ring rules are scoped the same way).
    // Mirroring the fill into the conic ring on a door would paint the Reader's
    // coral progress on it from the first frame, past doorbar.css's ~200ms
    // onset gate — the one thing the 🚪 and the 💬 must never do.
    const host = el.closest(".dwell:not(.bardoor)");
    if (!host) continue;
    const pct = parseFloat(el.style.height) || 0;
    host.style.setProperty("--dwell-progress", (pct * 3.6).toFixed(1) + "deg");
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });

// ---------- progress (pool event + local mirror for resume) ----------
const posKey = (slug) => "era-reader:pos:" + slug;
function savePos(slug, page) {
  try { localStorage.setItem(posKey(slug), String(page)); } catch {}
  log("book-progress", { slug, page });          // the durable record (merged pool)
}
function loadPos(slug, maxPage) {
  try {
    const n = parseInt(localStorage.getItem(posKey(slug)), 10);
    if (isFinite(n) && n >= 0 && n <= maxPage) return n;
  } catch {}
  return 0;   // nothing available client-side -> page 1 (resume-from-pool = follow-up)
}
function clearPos(slug) { try { localStorage.removeItem(posKey(slug)); } catch {} }

// ---------- shelf (old library-client structure: shelf-card grid, coral rim
// on authored books; the exit affordance is the bar's 🚪 since 9/17) ---------
// ---------- books that are still being made (dad 9/7) ----------
// A pile of photos dropped into the Drive folder is a book minutes later, and
// until then the shelf said "No books yet — set up Google Drive" at a family
// whose Drive was set up. These four sentences are what it says instead. Every
// one of them is the REAL reason: a book waiting for a key says so, a book that
// stopped says so, and the Drive prompt is never one of the answers.
const HELD_WORDS = {
  "no-ai-key": { head: "Waiting for a key", note: "A grown-up adds an AI helper key in Settings." },
  "needs-photo-decoder": { head: "Waiting for iPhone photos",
    note: "A grown-up ticks Clothing Picker in Settings, or saves the photos as JPEG." },
  "unreadable-photos": { head: "These photos will not open",
    note: "Pages have to be JPEG photos or iPhone photos." },
};

// A STOPPED BOOK IN HER WORDS, NEVER THE PROVIDER'S. `j.error` is the raw
// string off job.errors — "ai(google/gemini-3-flash-preview) 500 boom" — and
// the Settings card is forbidden to print it (public/settings/index.html
// ctSorry: "it names nothing a parent can act on and reads like a crash").
// This shelf is the one screen a six-year-old looks at, so it is the last place
// it belongs; and there is nothing here she can act on either, so it says less
// than Settings does — that the book stopped, and who can help.
function sorry(msg) {
  const m = String(msg || "");
  if (/\b429\b|quota|allowance|RESOURCE_EXHAUSTED/i.test(m))
    return "It carries on by itself when there is more room.";
  return "A grown-up can start it again in Settings.";
}

// THE PILE IN books/ ITSELF, which has no folder and no slug until the hub
// gathers it. It is one of this file's own grid rows rather than one of the
// hub's, so it carries a slug nothing else can collide with — and that slug is
// a marker for THIS page only: the tap sends `loose:true` (spec §14), never
// this string. Nothing outside startBuild() has to know that, which is exactly
// why the sentinel is safe to keep.
const LOOSE = "\u0000loose";

// A pile of photos and a book being made are the same box with different words
// in it, and the hub says which is which: `waiting:"pile"` is a folder with
// photos and no job.json (nobody has claimed it), and the loose pile is the
// same thing without a folder. Everything else has a job behind it.
const isPile = (j) => j.waiting === "pile" || !!j.loose;
// The photo count, wherever it lives: the loose pile carries its own, a pile
// folder arrives with the same `progress.pages` every other row has.
const photosIn = (j) => Number(j.loose) || Number(j.progress && j.progress.pages) || 0;
// What a pile says: how many photos are in it. It does NOT say when the book
// will start, because since "built here" nothing starts until a grown-up taps
// Build — the card's own button is the honest end of that sentence.
function pileWords(j) {
  const n = photosIn(j);
  return { head: n + " photo" + (n === 1 ? "" : "s"), note: "" };
}

// DOES THIS CARD OFFER A BUILD? A pile is always ours to start. A job is offered
// when the build door would say yes to it — no manifest, no other computer's warm
// claim — MINUS the one book the door would say yes to for the opposite reason.
//
// `buildable` cannot tell those two apart, and is right not to: a job already
// ours is one the door admits precisely so run() can JOIN the build in flight
// (content.js step 3). But on a card that is exactly the both-at-once oddity
// this shelf must never show — "Making this book… 4 of 16 pages read" with
// "Build a book" laid over the same photo, on the one screen in the product that
// cannot ask a grown-up what it means. So the hub's own answer to "what have I
// got in hand?" (`building` + `job.slug`, and `queued` for the book waiting its
// turn) suppresses the press, and nothing new had to be added to say it.
const offersBuild = (j) => j.loose ? true
  : j.buildable === true && !S.here.includes(j.slug);

function buildingWords(j) {
  // ANOTHER COMPUTER IS MAKING THIS ONE (spec §13, §15). First of all the
  // answers because it is the only one that is about WHERE the work is: the
  // job's own state is the other device's news, and repeating it here would
  // have this shelf counting up pages nothing on this computer is turning.
  // Build comes back on its own when their heartbeat is half an hour old —
  // `elsewhere` goes false, `buildable` goes true, and nobody has to be told.
  if (j.elsewhere) return { head: "Building on another computer", note: "" };
  if (j.paused || j.pausedUntil)
    return { head: "Waiting its turn", note: "It carries on by itself when there is more room today." };
  // ONLY A BOOK THAT REALLY STOPPED SAYS IT STOPPED, and after that the HOLD
  // decides — never the presence of an error. A book holding on "retry" carries
  // one too (content.js sets both), and it has not stopped at all: it is waiting
  // for its next look and will carry on by itself. Saying "This book stopped"
  // over it was wrong on the one shelf that cannot ask anybody.
  // `failed` comes first of the two because a hold is not cleared when a book
  // falls over (content-store.fail keeps it), so the last word is the failure.
  if (j.state === "failed") return { head: "This book stopped", note: sorry(j.error) };
  if (HELD_WORDS[j.held]) return HELD_WORDS[j.held];
  // A job at `inbox` has been CLAIMED — a grown-up tapped Build, or this
  // computer picked its own job back up after a restart. The old sentence here
  // ("Building starts about ten minutes after the last photo arrives") was the
  // hub promising a start it stopped making: the scan claims nothing now.
  if (j.state === "inbox")
    return { head: "Getting ready…", note: "New ERA has started on this book." };
  if (j.state === "published" || j.state === "animating" || j.state === "done")
    return { head: "Nearly ready", note: "This book is on its way to the shelf." };
  const p = j.progress || {};
  return { head: "Making this book…",
           note: p.pages ? p.transcribed + " of " + p.pages + " pages read" : "Reading the photos." };
}

// The picture where the cover goes. A book already being made has pages/ on
// disk, so the hub can hand its first photo over (/content/page reads straight
// out of the book folder, ahead of the ten-minute mirror); a pile has its
// photos loose at the top of the folder and no page record yet, and the pile in
// books/ has no folder at all. Both of those answer 404 and fall back to the
// mark — the same shape the real card's cover uses when its image will not
// load, so a card that cannot show a picture is still a card.
function coverInto(cover, j) {
  const mark = () => {
    const m = document.createElement("span");
    m.className = "shelf-waiting-mark";
    m.setAttribute("aria-hidden", "true");
    m.textContent = "📖";
    cover.appendChild(m);
  };
  if (j.loose || !j.slug) { mark(); return; }
  const img = document.createElement("img");
  img.alt = "";
  img.onerror = () => { img.remove(); mark(); };
  img.src = "/content/page?slug=" + encodeURIComponent(j.slug) + "&index=0";
  cover.appendChild(img);
}

// THE TWO CARDS THAT ARE NOT A BOOK YET (spec §13). Both keep EXACTLY a real
// card's box — the picture where the cover goes, the title under it, "Build a
// book" laid over the bottom of the picture — so her shelf does not reflow the
// moment the built book takes the slot.
//
// GAZE SAFETY, and it is deliberately not "no class" the way the old waiting
// card was. `class="dwell" data-dwell-disabled` on the card AND on its button:
// dwell.js's targetAt() skips [data-dwell-disabled], so her gaze can never arm
// on either of them, but the tap-parity long-press rescue and the context-menu
// suppression match on `.dwell` ALONE — without the class a slow press on
// Windows is dead and a long press opens the right-click menu on her shelf.
// Building is a grown-up's press, made with a finger, and this is the reader's
// own setDisabled() idiom said once at build time.
//
// Returns the card, its box and the row it was drawn from, because the ask has
// to be able to find its way back to all three after a repaint.
function notYetCard(j) {
  const pile = isPile(j);
  const words = pile ? pileWords(j) : buildingWords(j);
  const canBuild = offersBuild(j);
  const card = document.createElement("div");
  card.className = "shelf-card dwell " + (pile ? "is-pile" : "is-building");
  card.setAttribute("data-dwell-disabled", "");
  card.dataset.slug = j.slug;
  const box = document.createElement("div");
  box.className = "dwell dwell-button shelf-card-box"
    + (canBuild ? " shelf-build-button" : "");
  box.setAttribute("data-dwell-disabled", "");
  const label = document.createElement("span");   // the old DwellButton wrapper (see renderShelf)
  label.className = "dwell-label";
  const cover = document.createElement("span");
  cover.className = "shelf-cover";
  coverInto(cover, j);
  if (canBuild) {
    const tag = document.createElement("span");
    tag.className = "shelf-build-tag";
    tag.textContent = "Build a book";
    cover.appendChild(tag);
  }
  const name = document.createElement("span");
  name.className = "shelf-title";
  name.textContent = j.title || "A new book";
  const note = document.createElement("span");
  note.className = "shelf-waiting-note muted";
  note.textContent = words.head + (words.note ? " " + words.note : "");
  label.appendChild(cover); label.appendChild(name); label.appendChild(note);
  box.appendChild(label);
  card.appendChild(box);
  if (canBuild) box.addEventListener("click", () => openAsk(j, card, box));
  return { j, card, box };
}

// What the shelf says when there is nothing on it. THE DRIVE PROMPT IS ONLY
// TRUE IN ONE STATE — no Drive folder on this computer — and it was shown in
// all of them. `drive === null` means the hub did not answer; the prompt is the
// safest guess then, because a hub that cannot say has usually not been set up.
function paintEmpty() {
  const nothing = !S.index.length && !S.building.length;
  $("shelfEmpty").hidden = !nothing;
  if (!nothing) return;
  const set = S.drive === true;
  // …and the second half of that sentence is no longer "New ERA makes the book
  // by itself", because it does not: a pile of photos waits on this shelf until
  // a grown-up taps Build on the computer that will do the work (spec §12).
  $("shelfEmptyLine").textContent = set
    ? "No books yet. Put the photos of one book in the books folder in your Google Drive, then a grown-up taps Build a book here."
    : "No books yet.";
  $("shelfEmptyLink").hidden = set;
}

// ---------- the ask (spec §13) ----------
// PRESSING BUILD DOES NOT BUILD. It turns the card into the review page's ask
// shape — the question, then "Build it" and "Not now" as two different buttons
// in two different places, so the press that spends a family's allowance can
// never be the second half of the press that asked about it.
//
// While the question is up the shelf beneath it is asleep, the way the board is
// under its partner sheet (board-partner.js freezeBoard): a full-screen
// backdrop would hide nothing, because dwell.js's targetAt() walks the whole
// elementsFromPoint stack for the first `.dwell:not([data-dwell-disabled])` and
// steps straight over anything without the class. So both halves go — the
// attribute stops the gaze fill, dropping the class stops the 150 ms
// long-press tap-rescue. Unlike the board, the way out is NOT kept awake: both
// of the bar's doors sleep with everything else, because a question this small
// has an answer on it and fifteen seconds to live.
//
// Only LIVE targets are put to sleep, which is what makes the thaw safe: the
// pile cards were born asleep, and waking everything the shelf holds would hand
// her gaze the Build button the freeze exists to keep away from her.
let frozen = [];
let askTimer = null;

function suppressFor(ms) {
  try { if (window.Dwell && Dwell.suppress) Dwell.suppress(ms); } catch {}
}

// The shelf AND the bar above it (9/17). The doors are no longer drawn inside
// #sShelf, and the rule they were written for is unchanged: while the question
// is up, nothing on this screen is a live gaze target — the 🚪 and the 💬
// included, exactly as the exit TILE slept under it before.
const LIVE_TARGETS =
  "#sShelf .dwell:not([data-dwell-disabled]), .msgbar .dwell:not([data-dwell-disabled])";

// APPENDS, because the two lists have different lifetimes: a repaint throws the
// shelf's frozen nodes away and makes fresh ones (renderShelf's tail asks for
// the freeze a second time), while the bar is mounted once and lives through
// every repaint. A plain re-assignment would lose the doors — they are already
// stamped disabled, so the second freeze cannot find them again — and thaw
// would hand her back a shelf with two dead doors on it.
function freezeShelf(except) {
  const live = [...document.querySelectorAll(LIVE_TARGETS)].filter(el => !except.contains(el));
  for (const el of live) {
    el.classList.remove("dwell");
    el.setAttribute("data-dwell-disabled", "");
  }
  frozen = frozen.concat(live);
}
function thawShelf() {
  for (const el of frozen) {
    el.classList.add("dwell");
    el.removeAttribute("data-dwell-disabled");
  }
  frozen = [];
}

// The question names the number, because that is the one thing a grown-up
// standing at the screen can check before they spend anything.
function askWords(j) {
  const n = photosIn(j);
  return (n ? "Build a book from these " + n + " photo" + (n === 1 ? "" : "s") + "?"
            : "Build a book from these photos?")
    + " A grown-up should do this.";
}

// The ask lives INSIDE the card, in place of its box, so the slot keeps its
// place in the grid and the shelf around it does not move under her.
function paintAsk(j, card, box) {
  box.hidden = true;
  const ask = document.createElement("div");
  ask.className = "shelf-ask";
  ask.id = "shelfAsk";
  const q = document.createElement("p");
  q.className = "shelf-ask-q";
  q.textContent = askWords(j);
  const row = document.createElement("div");
  row.className = "shelf-ask-actions";
  const yes = document.createElement("div");
  yes.id = "shelfAskYes";
  yes.className = "dwell dwell-button shelf-ask-yes";
  yes.setAttribute("data-dwell-disabled", "");
  yes.textContent = "Build it";
  const no = document.createElement("div");
  no.id = "shelfAskNo";
  no.className = "dwell dwell-button shelf-ask-no";
  no.setAttribute("data-dwell-disabled", "");
  no.textContent = "Not now";
  yes.addEventListener("click", () => { closeAsk(); startBuild(j); });
  no.addEventListener("click", () => closeAsk());
  row.appendChild(yes); row.appendChild(no);
  ask.appendChild(q); ask.appendChild(row);
  card.appendChild(ask);
  freezeShelf(ask);
  suppressFor(600);
}

function openAsk(j, card, box) {
  if (S.asking) closeAsk();
  S.asking = { slug: j.slug };
  paintAsk(j, card, box);
  // Fifteen seconds untouched and the question goes away by itself. A grown-up
  // walks off mid-thought more often than they answer, and a modal left on a
  // six-year-old's bookshelf is a shelf she cannot use.
  askTimer = setTimeout(() => { askTimer = null; closeAsk(); }, 15000);
  log("build-ask", { loose: !!j.loose });
}

function closeAsk() {
  if (askTimer) { clearTimeout(askTimer); askTimer = null; }
  S.asking = null;
  const ask = $("shelfAsk");
  if (ask) {
    const card = ask.parentNode;
    ask.remove();
    const box = card && card.querySelector(".shelf-card-box");
    if (box) box.hidden = false;
  }
  thawShelf();
  suppressFor(600);                              // the pointer may be parked on a tile
}

// The one press in this app that spends a family's allowance. The pile in
// books/ has no slug until the hub gathers it, so it sends `loose:true` and the
// hub hands the new slug back (spec §14); LOOSE is this file's own grid marker
// and never goes near the wire.
//
// Whatever the hub answers, the shelf's next look is the honest report: a claim
// it took shows as a book being made, a refusal leaves the card saying what it
// said before, or "Building on another computer" the moment the other claim
// lands. No refusal sentence is printed here — Settings is where a grown-up
// reads those, and this is the one screen a six-year-old looks at.
async function startBuild(j) {
  const body = j.loose ? { kind: "books", loose: true } : { kind: "books", slug: j.slug };
  log("build", { loose: !!j.loose });
  try {
    await fetch("/content/build", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {}
  await refreshShelf();
  painted = shelfSig();
  renderShelf();
  suppress();
}

function renderShelf() {
  const grid = $("shelfGrid");
  grid.innerHTML = "";
  paintEmpty();
  for (const b of S.index) {
    const card = document.createElement("div");
    card.className = b.authored === true ? "shelf-card is-authored" : "shelf-card";
    // The slug on the CARD, the way notYetCard() already stamps its own. A
    // grown-up's finger hold (reader-share.js) starts at the card and has to
    // know which book it is holding without a second lookup — and the add
    // sheet finds the book it just imported by the same key.
    card.dataset.slug = b.slug;
    const btn = document.createElement("div");
    btn.className = "dwell dwell-button shelf-card-button";
    btn.setAttribute("data-dwell-say", b.title);
    btn.setAttribute("aria-label",
      b.authored === true ? "Read " + b.title + " — " + whose() + " story" : "Read " + b.title);
    const cover = document.createElement("span");
    cover.className = "shelf-cover";
    const img = document.createElement("img");
    img.alt = "";
    img.onerror = () => {
      img.remove();
      const fb = document.createElement("span");
      fb.className = "shelf-cover-fallback muted";
      fb.textContent = "No cover";
      cover.appendChild(fb);
    };
    img.src = b.cover;
    cover.appendChild(img);
    const name = document.createElement("span");
    name.className = "shelf-title";
    name.textContent = b.title;
    // The old DwellButton wrapped its children in <span class="dwell-label">;
    // the card grid therefore holds ONE stretched item and the title stays an
    // inline box (no 10px grid gap under the cover, 30px line box). Appending
    // cover+title straight to the button made them two blockified grid items
    // and grew every card by ~14px. Keep the wrapper — it is load-bearing.
    const label = document.createElement("span");
    label.className = "dwell-label";
    label.appendChild(cover);
    label.appendChild(name);
    btn.appendChild(label);
    btn.addEventListener("click", () => openBook(b.slug));
    card.appendChild(btn);
    if (b.authored === true) {
      const badge = document.createElement("span");
      badge.className = "shelf-authored-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 2.5l2.1 5.6 5.9.3-4.6 3.7 1.6 5.7L12 14.6 6.9 17.8l1.6-5.7L3.9 8.4l5.9-.3Z"/></svg>' +
        whose() + " story";   // her name from Settings, not ours (QA 9/2)
      card.appendChild(badge);
    }
    grid.appendChild(card);
  }
  // …then the ones that are not books yet — a pile waiting for a tap, a book
  // being made — after the ones she can actually read.
  const notYet = S.building.map(notYetCard);
  for (const c of notYet) grid.appendChild(c.card);
  // NO exit tile on the shelf any more (9/17): the 🚪 lives in the bar above,
  // where every other app of hers keeps it, and it is never rebuilt under her
  // gaze by a poll the way a grid tile was.

  // THE ASK IS NOT IN shelfSig(), ON PURPOSE. A full grid rebuild is what the
  // poll was fixed to avoid, and putting an open question into the signature
  // would make every repaint an argument about which of the two wins. So the
  // question is a local DOM change and this is where it comes back: the row it
  // belongs to is found again by slug and the ask is re-painted over the FRESH
  // card, with the freeze asked for a second time — every node the old list
  // held went out with the old grid, exactly as board-partner's
  // refreezeIfOpen() has to do when a board arrives under an open sheet.
  // Its fifteen seconds keep running; a repaint is not an answer.
  if (S.asking) {
    const hit = notYet.find(c => c.j.slug === S.asking.slug);
    // …keeping the nodes that SURVIVED the repaint (the bar's two doors) on the
    // frozen list: they are still asleep, the second freeze cannot find them
    // again, and the thaw that ends the question has to wake them.
    if (hit) { frozen = frozen.filter(el => el.isConnected); paintAsk(hit.j, hit.card, hit.box); }
    // The pile became a book, or another computer took it: the question has no
    // card left to stand on. It has to be CLOSED, not merely forgotten —
    // closeAsk() is the only thing that THAWS. Dropping S.asking on the floor
    // was invisible while every frozen node was a shelf node the repaint
    // destroyed; since the bar (9/17) the two doors survive the repaint frozen,
    // and a build finishing under an open ask left 🚪 and 💬 stamped
    // data-dwell-disabled with .dwell gone FOR EVER — she is on the shelf with
    // no way off it and no way to ask to talk. closeAsk() clears askTimer,
    // clears S.asking, takes the (already destroyed) ask node out, thaws and
    // re-suppresses.
    else closeAsk();
  }
}

// Everything the shelf PAINTS, in one string — the covers she can open, the
// sentence under each book on its way, and whether the card offers a Build.
// Two polls that would draw the same shelf have the same signature, and the
// second one draws nothing (see boot). S.asking is deliberately NOT in here:
// see renderShelf's tail.
function shelfSig() {
  return JSON.stringify([
    S.drive, S.childName,
    S.index.map(b => [b.slug, b.title, b.cover, b.authored]),
    S.building.map(j => {
      const w = isPile(j) ? pileWords(j) : buildingWords(j);
      return [j.slug, j.title, w.head, w.note, isPile(j), offersBuild(j)];
    }),
  ]);
}

// ---------- the two doors (era-core lib/doorbar.js) ----------
// The round trip itself is the BAR's — it POSTs /kiosk/exit and /kiosk/pause
// and follows the hub's answer. These are the three things only a book knows.

// 🚪 leaving: the story stops dead, because she is not coming back to it.
function onDoorLeave() {
  log("door", {});
  stopMedia();
}

// 💬 stepping out to TALK: pause IN PLACE. stopMedia() zeroes the narration and
// tears the video down, which is right for the 🚪 and wrong here — she comes
// back to this same page and must find it where she left it.
function pauseMedia() {
  clearPulse();                                  // no arrow pulsing at an empty screen
  // the stopIgnorePause latch (stopMedia's): our own pause() must not flip the
  // pill into "Paused" — give the pause event a tick, then unlatch.
  S.ignorePause = true;
  try { narration.pause(); } catch {}
  setTimeout(() => { S.ignorePause = false; }, 0);
  try { video.pause(); } catch {}                // src + onended KEPT: the outro
                                                 // still has a page to turn
}

function onTalkPause() {
  // what to pick up when she comes back, decided while it is still true
  // "paused" is the third answer: she had ALREADY stopped the story herself
  // (the Read/Pause pill) before she stepped out. Nothing to restart — but the
  // page must come back exactly as she left it, which is not the same as the
  // idle `null` (see onTalkResume).
  S.talkResume = video.getAttribute("src") ? "video"
    : (S.reading && !S.paused) ? "narration"
    : S.paused ? "paused" : null;
  pauseMedia();
  S.paused = true;
  updateUi();
}

// Back from TD Snap (the bar's visibilitychange, only after a pause it made).
// A clip carries on from its own currentTime; narration starts the PAGE again
// from the top — a half-read sentence is not a place a child wants to resume
// at (spec §6).
function onTalkResume() {
  const what = S.talkResume;
  S.talkResume = null;
  // "paused" hands her own pause BACK to her. Clearing S.paused there flipped
  // the pill to "Ready to read" over narration still sitting at t>0, and
  // toggleRead's resume branch (it wants S.paused) stopped matching — the next
  // Read started the page again from the top and threw away the place she
  // stopped at on purpose. Every other answer means she was not stopped.
  S.paused = what === "paused";
  if (what === "video") {
    video.play().catch(() => {});
  } else if (what === "narration") {
    resetHighlight();
    try { narration.currentTime = 0; } catch {}
    narration.play().catch(() => {});
  } else if (what === null && S.finished && !S.playingOutro) {
    // She stepped out with the big ready-arrow waiting for her. pauseMedia()
    // cleared its pulse (no arrow pulsing at a screen she isn't looking at) and
    // nothing re-armed it, so the page she had finished came back with a still
    // arrow and the nudge never returned. markReadyForNext() is the arm.
    markReadyForNext();
  }
  updateUi();
}

async function openBook(slug) {
  stopMedia();
  let m;
  try { m = await (await fetch("/books/" + slug + "/manifest.json")).json(); }
  catch { log("book-open-failed", { slug }); return; }   // stay on the shelf, never break
  if (!m || !Array.isArray(m.pages) || !m.pages.length) { log("book-open-failed", { slug }); return; }
  S.manifest = m; S.slug = slug;
  // ?v= cache-bust: media is served immutable, so a re-exported package must
  // change its URLs (exportedAt = the package version)
  S.vq = m.exportedAt ? "?v=" + encodeURIComponent(m.exportedAt) : "";
  S.page = loadPos(slug, m.pages.length - 1);
  log("book-open", { slug, page: S.page });
  show("sRead");
  renderPage();
}

// ---------- reading ----------
function clearPulse() {
  if (S.pulseTimer) { clearTimeout(S.pulseTimer); S.pulseTimer = null; }
  $("btnNext").classList.remove("reader-next-button-pulse");
}

function stopMedia() {
  clearPulse();
  // stopIgnorePause latch (old reader): our own pause() must not flip the UI
  // into "Paused" — give the synchronous pause event a tick, then unlatch.
  S.ignorePause = true;
  try { narration.pause(); narration.currentTime = 0; } catch {}
  setTimeout(() => { S.ignorePause = false; }, 0);
  S.playingOutro = false;
  video.onended = video.onerror = null;
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  video.classList.remove("reader-outro-video-playing");
}

function setDisabled(el, disabled) {
  el.classList.toggle("is-disabled", disabled);
  if (disabled) el.setAttribute("data-dwell-disabled", "");
  else el.removeAttribute("data-dwell-disabled");
}

// Old reader's status line: "Page 3 of 16 · Reading aloud"
function updateUi() {
  const m = S.manifest;
  if (!m) return;
  const p = m.pages[S.page];
  const label = S.reading && !S.paused ? "Reading aloud"
    : S.paused ? "Paused"
    : !p.audio ? "No voice for this page yet"
    : "Ready to read";
  $("pageMeta").textContent = "Page " + (S.page + 1) + " of " + m.pages.length + " · " + label;
  $("btnReadLabel").textContent = S.reading && !S.paused ? "Pause" : "Read";
  setDisabled($("btnRead"), !p.audio);
  setDisabled($("btnPrev"), S.page === 0);
  setDisabled($("btnNext"), S.page >= m.pages.length - 1);
  // Once she triggers the ready arrow (starting the video), it shrinks back
  // to the corner so her gaze on the video can't re-arm it (old reader).
  const ready = S.finished && !S.playingOutro && !S.bookFinished;
  $("btnNext").classList.toggle("reader-next-button-ready", ready);
  if (!ready) $("btnNext").classList.remove("reader-next-button-pulse");
  $("btnLibrary").classList.toggle("reader-library-button-finished", S.bookFinished);
}

function resetHighlight() {
  S.activeIdx = -1;
  for (const el of S.wordSpans) el.classList.remove("active");
}

function renderTokens(text) {
  const holder = $("pageText");
  holder.innerHTML = "";
  S.wordSpans = [];
  const parts = (text || "").split(/(\s+)/);
  let any = false;
  for (const part of parts) {
    if (!part) continue;
    any = true;
    const isWord = /[\p{L}\p{N}]/u.test(part);
    const s = document.createElement("span");
    s.className = isWord ? "reader-token" : "reader-token-gap";
    if (!isWord) s.setAttribute("aria-hidden", "true");
    s.textContent = part;
    holder.appendChild(s);
    if (isWord) S.wordSpans.push(s);
  }
  if (!any) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "No page text yet.";
    holder.appendChild(empty);
  }
}

function renderPage() {
  stopMedia();
  const gen = ++S.renderGen;      // a fast page turn aborts the old play(); its
                                  // rejection must not mark THIS page ready
  const m = S.manifest, p = m.pages[S.page];
  const base = "/books/" + S.slug + "/";
  S.reading = false; S.paused = false; S.finished = false;
  S.bookFinished = false; S.playingOutro = false;
  $("bookTitle").textContent = m.title;

  // Page image — robust both ways (the old layout's guarantee): the image
  // frame owns its grid row, so a missing/failed image shows the fallback
  // card and the text panel NEVER swallows the page (the v1 collapse that
  // left a broken-image glyph with text filling the screen).
  const img = $("pageImg"), fallback = $("imgFallback");
  if (p.image) {
    img.hidden = false; fallback.hidden = true;
    img.onerror = () => { if (gen !== S.renderGen) return; img.hidden = true; fallback.hidden = false; };
    img.src = base + p.image + S.vq;
  } else {
    img.removeAttribute("src");
    img.hidden = true; fallback.hidden = false;
  }

  renderTokens(p.text);
  S.activeIdx = -1;
  S.words = (Array.isArray(p.words) && p.words.length)
    ? p.words.slice().sort((a, b) => a.start - b.start)
    : null;                                    // may be interpolated on loadedmetadata

  if (p.audio) {
    narration.src = base + p.audio + S.vq;     // auto-read: the page reads as it appears
    narration.play().catch(() => {
      // autoplay blocked: show the way forward (ready arrow) instead of a stuck page
      if (gen === S.renderGen) markReadyForNext();
    });
  } else {
    narration.removeAttribute("src");
    markReadyForNext();                        // textless/silent page: ready NOW (old law)
  }

  updateUi();
  savePos(S.slug, S.page);
  suppress();                                  // page-settle: fresh page never inherits her gaze
}

// Narration done on this page. NOT last page: the big ready-arrow waits for
// her (pulse after 5s — the old reader's gentle nudge). LAST page: the outro
// video auto-plays if there is one (no arrow left to trigger it), otherwise
// the book is finished and the Library button becomes the invitation.
function markReadyForNext() {
  clearPulse();
  const m = S.manifest;
  if (!m) return;
  const p = m.pages[S.page];
  if (S.page >= m.pages.length - 1) {
    if (p.video && !S.playingOutro) { startOutro(p); return; }
    setBookFinished();
    return;
  }
  S.finished = true;
  S.pulseTimer = setTimeout(() => {
    if (S.finished && !S.playingOutro) $("btnNext").classList.add("reader-next-button-pulse");
  }, 5000);
  updateUi();
}

function setBookFinished() {
  S.finished = false;
  S.playingOutro = false;
  S.bookFinished = true;
  clearPos(S.slug);                            // next open starts fresh
  log("book-done", { slug: S.slug });
  updateUi();
}

// interpolation fallback: audio but no word timings -> spread the words evenly
narration.addEventListener("loadedmetadata", () => {
  if (S.words || !S.wordSpans.length) return;
  const dur = narration.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const n = S.wordSpans.length;
  S.words = S.wordSpans.map((el, i) =>
    ({ word: el.textContent, start: i * dur / n, end: (i + 1) * dur / n }));
});

// word sync: binary search for the last word started by t; MONOTONIC —
// the active index never decreases within a playback (repeat/page reset it).
// Visual = the old reader's yellow token highlight.
function syncWords(t) {
  const words = S.words;
  if (!words || !words.length || !S.wordSpans.length) return;
  let lo = 0, hi = words.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit <= S.activeIdx) return;
  S.activeIdx = hit;
  const spanIdx = Math.min(hit, S.wordSpans.length - 1);
  for (let i = 0; i < S.wordSpans.length; i++)
    S.wordSpans[i].classList.toggle("active", i === spanIdx);
  const active = S.wordSpans[spanIdx];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (window.__testHooks)
    (window.__hlSeq = window.__hlSeq || []).push({ page: S.page, idx: hit });
}
narration.addEventListener("timeupdate", () => syncWords(narration.currentTime));

narration.addEventListener("play", () => {
  S.reading = true; S.paused = false;
  updateUi();
});
narration.addEventListener("pause", () => {
  if (S.ignorePause) return;
  if (narration.ended || !narration.src) return;
  S.paused = true; S.reading = false;          // Read/Pause pill paused mid-page
  updateUi();
});
narration.addEventListener("ended", () => {
  S.reading = false; S.paused = false;
  // old reader clears the highlight when the page finishes reading
  for (const el of S.wordSpans) el.classList.remove("active");
  markReadyForNext();
  updateUi();
});

// ---------- controls (old reader semantics) ----------
function advance() {
  if (!S.manifest || S.page >= S.manifest.pages.length - 1) return;
  S.page++;
  renderPage();                                // stops old narration; new page auto-reads
}
function goNext() {
  const m = S.manifest;
  if (!m || S.page >= m.pages.length - 1) return;   // last page: Library finishes the book
  const p = m.pages[S.page];
  // Ready arrow on a page WITH a video: play the video first (old outro
  // behavior); its end turns the page.
  if (S.finished && p.video && !S.playingOutro) { startOutro(p); return; }
  advance();                                   // mid-narration: the arrow PAUSES the story
}
function goPrev() {
  if (!S.manifest || S.page === 0) return;
  S.page--;
  renderPage();
}
function toggleRead() {
  const p = S.manifest && S.manifest.pages[S.page];
  if (!p || !p.audio) return;
  if (S.reading && !S.paused) { narration.pause(); return; }
  clearPulse();
  S.finished = false;
  if (S.paused && narration.src && !narration.ended && narration.currentTime > 0) {
    narration.play().catch(() => {});          // resume exactly where she paused
  } else {
    resetHighlight();                          // read it again from the top
    try { narration.currentTime = 0; } catch {}
    narration.play().catch(() => {});
    log("repeat", { slug: S.slug, page: S.page });
  }
  updateUi();
}
function goLibrary() {
  stopMedia();
  S.manifest = null; S.slug = null;
  S.finished = false; S.bookFinished = false;
  show("sShelf"); renderShelf(); log("shelf", {});
}

// ---------- per-page video (old outro presentation: overlaid on the page
// image inside the frame; the video's end turns the page) ----------
function startOutro(p) {
  S.playingOutro = true;
  clearPulse();
  updateUi();                                  // big arrow shrinks back to the corner
  suppress();
  const gen = S.renderGen;
  const done = () => {
    if (gen !== S.renderGen) return;           // page changed under the video
    S.playingOutro = false;
    video.onended = video.onerror = null;
    try { video.pause(); } catch {}
    video.removeAttribute("src");
    video.classList.remove("reader-outro-video-playing");
    if (S.page >= S.manifest.pages.length - 1) setBookFinished();
    else advance();
  };
  video.onended = done;
  video.onerror = done;                        // a broken video never strands her
  video.src = "/books/" + S.slug + "/" + p.video + S.vq;
  video.classList.add("reader-outro-video-playing");
  video.play().catch(done);
  log("video", { slug: S.slug, page: S.page });
}

// ---------- boot ----------

// The shelf is TWO answers now: the packages the reader can open
// (/books/index.json, served out of <DATA>) and the books still being built in
// the family's Drive folder (/content/status, which is the Settings card's own
// payload). A book appears in both for the ten minutes between publishing and
// the mirror carrying it across, so the second list is always minus the first.
// Neither fetch may be a reason the app does not start: a hub that will not
// answer leaves an empty shelf and a living reader (the 8/19 law).
async function refreshShelf() {
  try {
    const idx = await (await fetch("/books/index.json")).json();
    S.index = Array.isArray(idx) ? idx : [];
  } catch { S.index = []; }
  try {
    const s = await (await fetch("/content/status", { cache: "no-store" })).json();
    S.drive = !!s.local;
    const have = new Set(S.index.map(b => b.slug));
    S.building = (Array.isArray(s.jobs) ? s.jobs : []).filter(j => j && !have.has(j.slug));
    // What this hub has in hand, for offersBuild(). The running job and the ones
    // queued behind it are the same answer to a family — content.js's own
    // busyWith() says both in the same two sentences — and both are books this
    // shelf must describe rather than ask about.
    S.here = [].concat(s.building && s.job && s.job.slug ? [s.job.slug] : [],
                       Array.isArray(s.queued) ? s.queued : []);
    // Photos dropped straight into books/ have no folder at all, so no row of
    // the hub's own describes them. They are still a book waiting to happen, and
    // saying so is the whole difference between this shelf and the one that told
    // a family with seventeen photos in Drive to go and set up Drive (dad 9/7).
    // It is a pile like any other now: it says how many photos there are, and it
    // carries the tap that turns them into a book.
    const loose = Number(s.loose) || 0;
    if (loose) S.building.push({ slug: LOOSE, title: "A new book", loose, waiting: "pile" });
  } catch { S.drive = null; S.building = []; S.here = []; }
}

// ---------- the shelf keeps looking (spec §13) ----------
// It used to stop the moment there was a book on the shelf and nothing being
// made — so a pile of photos dropped into Drive at teatime sat there unnoticed
// until somebody relaunched the app. Now the poll runs for as long as the shelf
// is up, on the faster of two clocks while something is actually in flight and
// the slower one when nothing is: a pile changes only when a grown-up walks
// over and taps it, and a shelf that has finished changing does not need to ask
// three times a minute what it already knows.
const POLL_FAST = 20000, POLL_SLOW = 60000;
let pollTimer = null, pollMs = 0, painted = "";
const inFlight = () => S.building.some(j => !isPile(j));

function schedulePoll() {
  const want = inFlight() ? POLL_FAST : POLL_SLOW;
  if (pollTimer && pollMs === want) return;
  if (pollTimer) clearInterval(pollTimer);
  pollMs = want;
  pollTimer = setInterval(pollShelf, want);
}

// ONLY WHEN SOMETHING ACTUALLY CHANGED. renderShelf() empties the grid and
// builds every card again — every book she could have been about to open — and
// era-core/dwell.js tracks the ELEMENT under the gaze, so a
// rebuild throws away an in-flight dwell (clear() + begin() on a node it has
// not seen before). Re-rendering on every tick because SOMETHING is building
// tore the shelf out from under her every twenty seconds, for as long as a book
// stayed unbuildable — which for a family that has not added an AI key yet is
// the whole session. The signature is what the cards actually say, so a page
// count ticking up still repaints and nothing else does; and a repaint
// suppresses dwell for the settle window, like every other render here (D51).
async function pollShelf() {
  await refreshShelf();
  schedulePoll();                  // what is on the shelf now decides the next clock
  const fresh = shelfSig();
  if (fresh === painted) return;
  painted = fresh;
  if (S.slug) return;              // she is inside a book; goLibrary() repaints
  renderShelf();
  suppress();
}

// The strip, mounted once for BOTH screens. doorbar.js publishes --bar-h on the
// element it is mounted in; the shelf and the page are that element's SIBLINGS
// (two fixed panels), and a custom property only travels downwards — so the
// height is mirrored onto <html>, which every one of them inherits from.
function mountBar() {
  const DB = window.DoorBar, mount = $("bar");
  if (!DB || !mount) return { setDwell() {}, setPause() {} };   // never a dead app (8/19)
  const door = DB.mountDoorBar(mount, {
    onLeave: onDoorLeave, onPause: onTalkPause, onResume: onTalkResume,
  });
  const size = () => {
    document.documentElement.style.setProperty("--bar-h", door.sizeBar() + "px");
  };
  size();
  window.addEventListener("resize", size);
  return door;
}

async function boot() {
  // THE DOOR IS UP BEFORE THE FETCH (the board's splash rule, dad 9/3): a hub
  // that will not answer /settings must never leave her on a screen she cannot
  // leave. Her real dwell and the 💬 land on it the moment settings do.
  const door = mountBar();

  try {
    const st = await (await fetch("/settings")).json();
    if (window.Dwell) {
      if (typeof st.dwellMs === "number" && isFinite(st.dwellMs))
        Dwell.setMs(clampDwell(st.dwellMs));   // the same number the doors double
      if (typeof st.settleMs === "number" && isFinite(st.settleMs))
        Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
    }
    // her name only once the family has given one: the hub answers "friend"
    // before setup, and "friend's story" is nobody's (QA 9/2: every book was
    // "Ellie's story" for every family)
    if (st.hasProfile && st.childName) { S.childName = st.childName; $("shelfTitle").textContent = st.childName + "'s Bookshelf"; }
    // her dwell, doubled by the bar onto its two doors (dad 9/17) — and the 💬,
    // which only exists where there is a talker to step out TO. pauseGoes is
    // the hub's own answer to that (spec §3.3): an older hub omits the key, and
    // a missing key is never "tdsnap", so no 💬 is mounted against a hub that
    // could not honour it.
    door.setDwell(clampDwell(st.dwellMs));
    door.setPause(st.pauseGoes === "tdsnap");
  } catch { /* defaults stand — never block the shelf on settings */ }

  await refreshShelf();
  renderShelf();
  suppress();
  // The shelf keeps looking, and now it never stops. An empty one has to notice
  // the first Drive book without a relaunch (VM QA 9/2); a book being made has
  // to count its pages up in front of whoever is watching; and a FULL shelf has
  // to notice a pile of photos landing in Drive, which is the one the old
  // "stop once there are books and nothing is building" rule got wrong — since
  // §13 that pile is the whole start of a book and it waits on a card she
  // cannot see until somebody relaunches the app. schedulePoll() picks the
  // clock (see above).
  painted = shelfSig();
  schedulePoll();

  $("btnNext").addEventListener("click", goNext);
  $("btnPrev").addEventListener("click", goPrev);
  $("btnRead").addEventListener("click", toggleRead);
  $("btnLibrary").addEventListener("click", goLibrary);

  log("boot", { books: S.index.length });
}
boot();

// introspection surface (mirrors window.Board) — tests + field debugging
window.Reader = {
  version: "2.0-old-ui",
  state: () => ({
    screen: (document.querySelector(".screen.show") || {}).id || null,
    slug: S.slug, page: S.page,
    activeIdx: S.activeIdx,
    words: S.words ? S.words.length : 0,
    audio: narration.paused ? "paused" : "playing",
    audioTime: narration.currentTime,
    arrow: S.finished && !S.playingOutro && !S.bookFinished,  // the big ready-arrow
    finished: S.finished,
    bookFinished: S.bookFinished,
    videoShowing: S.playingOutro,
    shelfCount: S.index.length,
    buildingCount: S.building.length,
    asking: S.asking ? S.asking.slug : null,
    pollMs,                                                   // 20 s in flight, 60 s idle
    drive: S.drive,
  }),
  open: openBook,

  // ---- LENT TO THE GROWN-UPS' SHEETS (reader-share.js, reader-strip.js) ----
  // Book sharing added two more sheets over this same shelf, and both need
  // exactly what the Build ask needs: everything asleep while they are up. They
  // borrow THIS switch rather than growing one each, because three switches
  // over one list of nodes means the last one to close wakes what the other two
  // put to sleep (board-edit.js learned that on the board, the hard way). The
  // list, the doors' exemption-that-isn't, and the thaw all stay here.
  freezeShelf, thawShelf,
  // …and the two questions a sheet has to be able to ask before it opens or
  // after it lands: is the Build ask already up (its own freeze is in flight),
  // and would the shelf please repaint NOW — an imported book is on disk and
  // mirrored, and waiting a minute for the poll to notice is not "arrive on
  // their bookshelf ready to read". `painted` is updated with it so the next
  // tick does not draw the same shelf a second time under an open sheet.
  isAsking: () => !!S.asking,
  repaintShelf: async () => {
    await refreshShelf();
    painted = shelfSig();
    if (S.slug) return;                          // she is inside a book; goLibrary() repaints
    renderShelf();
    suppress();
  },
};
