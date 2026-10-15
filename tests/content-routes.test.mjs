// content-routes.test.mjs — the doors onto the book pipeline (plan T2.9, and
// the tap of plan B1.6): GET /content/status, which the Settings card and the
// board note read; POST /content/run, the manual kick that re-runs one step of
// one book; POST /content/rename; and POST /content/build, which since spec
// §12 is the ONLY way a pile of photos becomes a book — the scan stopped
// starting anything by itself.
//
// PORTS: 8434 (the real server.js). No fake provider is needed and none is
// started — see the money guardrail below.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20): the hub is spawned with its own mkdtemp
// ERA_DATA_DIR, so the gate's real ElevenLabs credential is nowhere near this
// suite, and the only step this suite ASKS for is `publish`, which is pure
// disk. The build door is different: it starts the whole walk behind its 202,
// so both provider seams are pointed at a closed port below and the fixtures
// it walks are 64 bytes of nothing — no photo here decodes, so ingest holds
// the book before a key would be reached at all. The two key files written
// here hold obvious placeholders and exist for exactly one reason: to prove
// /content/status never echoes them back.
//
// WHO THIS HUB IS. The child is given ERA_DEVICE_ID (device-id.js precedence
// 1), because from spec §14 a claim is signed with the device id rather than
// the machine name and this suite has to be able to write a claim that is
// somebody ELSE's. Fixtures below still sign with os.hostname(), which
// content.isMine() forgives on purpose — that is the shape of every job.json
// written before this release.
//
// The clock is left alone: everything here is driven by files on disk, and the
// hub's own scan does not fire for ninety seconds (content.js:start).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const PORT = 8434;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-content-routes-"));
const DATA = path.join(TMP, "data");
// What Google Drive for Windows shows the family; the hub builds in place here.
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");
const BOOKS = path.join(FOLDER, "books");

const store = require("./content-store.js");

// This install, and another computer in the same family. Both are slugs, which
// is what a device id always is (device-id.js ID_RE) and what keeps the second
// one from ever reading as this machine's hostname.
const DEVICE = "kitchen-pc";
const OTHER = "study-pc";

let child;

const driveCfg = (cfg) => fs.writeFileSync(path.join(DATA, "drive.json"), JSON.stringify(cfg));
const jpg = (n) => Buffer.alloc(64, n);

// A book folder in whatever state the test needs. `photos` is the raw pile a
// parent dropped in (an inbox); `sources` is the same pile after ingest has
// moved it aside; `pages`/`job` are what the builder has left behind by now.
// Never real book content — one word per page.
function book(name, o) {
  const opts = o || {};
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of opts.photos || []) fs.writeFileSync(path.join(dir, f), jpg(1));
  if (opts.sources) {
    fs.mkdirSync(path.join(dir, "sources"), { recursive: true });
    for (const f of opts.sources) fs.writeFileSync(path.join(dir, "sources", f), jpg(1));
  }
  if (opts.pages) {
    fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
    const text = [], narr = [];
    opts.pages.forEach((p, i) => {
      const index = i + 1, pad = String(index).padStart(3, "0");
      fs.writeFileSync(path.join(dir, "pages", pad + ".jpg"), jpg(index));
      text.push({ index, source: "sources/IMG_000" + index + ".jpg", text: p.text || "",
                  flags: p.flags || [], cover: index === 1, edited: !!p.edited });
      if (p.audio) {
        fs.mkdirSync(path.join(dir, "audio"), { recursive: true });
        fs.writeFileSync(path.join(dir, "audio", pad + ".mp3"), Buffer.alloc(16, index));
        narr.push({ index, audio: "audio/" + pad + ".mp3",
                    words: [{ word: (p.text || "x").split(/\s+/)[0], start: 0, end: 0.4 }] });
      }
    });
    store.writeText(dir, { pages: text });
    if (narr.length)
      store.writeAtomic(path.join(dir, ".build", "narration.json"),
        { provider: "elevenlabs", model: "eleven_multilingual_v2", voice: "v1", pages: narr });
  }
  if (opts.job) {
    // CLAIMED BY THE HUB UNDER TEST, and it has to be said now that content.js
    // reads claimedBy back (spec §14): /content/run refuses a book another
    // computer is building, and a fixture signed "test:1" is another computer.
    // The hostname form is the one every job.json written before this release
    // carries, and content.isMine() forgives it on purpose.
    const job = { ...store.newJob({ claimedBy: os.hostname() + ":1", now: opts.now }), ...opts.job };
    store.writeJob(dir, job);
  }
  return dir;
}

const statusOf = async () => {
  const r = await fetch(`${BASE}/content/status`);
  const raw = await r.text();
  return { r, raw, body: JSON.parse(raw) };
};
const jobOf = (body, slug) => body.jobs.find(j => j.slug === slug);

const run = (body) => fetch(`${BASE}/content/run`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
// "…and let me say otherwise" (dad 9/7): the door that renames the folder a
// gathered pile of loose photos was given.
const rename = (body) => fetch(`${BASE}/content/rename`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    // NOWHERE TO GO (plan §B.2). The status poll asks ElevenLabs how much of
    // the month's voice is left whenever a voice card exists, and this suite
    // writes one (a placeholder, below) to prove status never echoes a key
    // back. Pointed at a closed port, that question is answered by the kernel
    // in a millisecond and never leaves this box.
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_AI_URL: "http://127.0.0.1:1",
           ERA_DEVICE_ID: DEVICE },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/content/status`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); });

// ------------------------------------------------------------------- status

test("an empty shelf answers instantly, with an empty job list and no caching", async () => {
  const { r, body } = await statusOf();
  assert.equal(r.status, 200);
  // The Settings card polls this: a cached answer is a card that lies about a
  // book that finished a minute ago (the /clothing/status rule, server.js:1761).
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(body.jobs, []);
  assert.equal(body.local, true);
});

test("a pile of photos nobody has claimed is a job waiting to start", async () => {
  book("New Book", { photos: ["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg"] });
  const { body } = await statusOf();
  const j = jobOf(body, "new-book");
  assert.ok(j, "the inbox folder should be listed");
  assert.equal(j.kind, "books");
  assert.equal(j.title, "New Book");
  assert.equal(j.state, "inbox");
  assert.equal(j.step, "ingest");
  assert.equal(j.progress.pages, 3);
  assert.equal(j.published, false);
});

// L2, from the 16-page live run of 9/4: ingest MOVES the pile into sources/ one
// photo at a time (content-ingest.js), so counting only the loose files made
// /content/status say 16 → 3 → 6 → 11 → 15 → 16 while nothing was lost — a
// parent watching the card saw their book shrink. A photo is one page of the
// book wherever it sits, so the total must not move while the move runs.
test("the page count does not dip while ingest moves the pile into sources/", async () => {
  const names = ["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg", "IMG_0004.jpg"];
  const dir = book("Moving Book", { photos: names });
  const pagesNow = async () => (jobOf((await statusOf()).body, "moving-book") || {}).progress.pages;
  assert.equal(await pagesNow(), 4, "the pile before ingest touches it");
  fs.mkdirSync(path.join(dir, "sources"), { recursive: true });
  for (const f of names) {
    fs.renameSync(path.join(dir, f), path.join(dir, "sources", f));
    assert.equal(await pagesNow(), 4, "still four pages after " + f + " moved");
  }
  // ...and pages/ filling in behind it changes nothing either.
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  for (let i = 1; i <= names.length; i++) {
    fs.writeFileSync(path.join(dir, "pages", String(i).padStart(3, "0") + ".jpg"), jpg(i));
    assert.equal(await pagesNow(), 4, "still four pages after page " + i + " was built");
  }
  // The publish step drops cover.jpg in the book root from page 1's bytes
  // (content-publish.COVER) — the hub's own output, not a photo the parent put
  // there, and counting it made a finished four-page book claim five. Ingest
  // skips the same file by the same name (content-ingest.OURS).
  fs.writeFileSync(path.join(dir, "cover.jpg"), jpg(1));
  assert.equal(await pagesNow(), 4, "the cover the publish step wrote is not a fifth page");
});

// The other half of "wherever it sits": ingest pages JPEG only and leaves a
// HEIC exactly where the parent put it, naming it in the log
// (content-ingest.OTHER_IMAGE_EXTS). That photo is still a page of the book the
// hub has not got — "15 of 16" with a log line saying which one is the truth a
// parent can act on; dropping it to "15 of 15" hides a lost page.
test("a photo ingest could not page still counts as a page of the book", async () => {
  const dir = book("Phone Book", { sources: ["IMG_0001.jpg", "IMG_0002.jpg"] });
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "001.jpg"), jpg(1));
  fs.writeFileSync(path.join(dir, "pages", "002.jpg"), jpg(2));
  fs.writeFileSync(path.join(dir, "IMG_0003.heic"), jpg(3));
  const j = jobOf((await statusOf()).body, "phone-book");
  assert.equal(j.progress.pages, 3);
});

// ...but only while the folder is still the INBOX, which is the window that
// sentence is true in. Once the book has been built, nothing will ever ingest a
// photo dropped beside it — the job owes no step — so a loose file counted then
// inflates the total for ever: a finished three-page book on the shelf saying
// "3 of 4 pages read", with nothing that could ever make it four.
test("a photo dropped beside a finished book does not add a page it will never get", async () => {
  const dir = book("Finished Book", {
    job: { state: "done" },
    sources: ["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg"],
    pages: [{ text: "one" }, { text: "two" }, { text: "three" }],
  });
  assert.equal(jobOf((await statusOf()).body, "finished-book").progress.pages, 3);
  fs.writeFileSync(path.join(dir, "IMG_9999.jpg"), jpg(9));
  assert.equal(jobOf((await statusOf()).body, "finished-book").progress.pages, 3,
    "a book nothing will ingest again may not grow a page it can never read");
});

test("a book part-way through says which step it owes and how far it has got", async () => {
  book("Tabby McTat", {
    job: { state: "transcribing" },
    pages: [{ text: "one two three", audio: true },
            { text: "four five", flags: [{ word: "five", reason: "smudged" }] },
            { text: "", flags: [{ word: null, reason: "no second model checked this page" }] }],
  });
  const { body } = await statusOf();
  const j = jobOf(body, "tabby-mctat");
  assert.ok(j);
  assert.equal(j.state, "transcribing");
  assert.equal(j.step, "transcribe");
  assert.deepEqual(j.progress, { pages: 3, transcribed: 2, narrated: 1 });
  // Two counts, because there are two kinds of mark: a WORD somebody was unsure
  // of (the review page highlights it), and a whole PAGE nobody could check,
  // which names no word at all. Adding the second to the first told a parent
  // there were words to look at and showed them none (E2).
  assert.equal(j.flags, 1);
  assert.equal(j.pageFlags, 1);
  // The only unit a book's spend can be counted in before the fal card exists:
  // ElevenLabs characters owed, and the ones already paid for.
  assert.equal(j.cost.characters, "one two three".length + "four five".length);
  assert.equal(j.cost.narrated, "one two three".length);
  assert.equal(j.pausedUntil, null);
  assert.equal(j.error, null);
});

// L5, from the 16-page live run of 9/4: `cost.narrated` summed the text on the
// pages that had audio, so a page bought twice was counted once and the card
// said 4614 characters while ElevenLabs had been sent 4986. The narrate step
// now keeps a ledger of what it actually spent, and the card reports THAT.
test("cost.narrated is what was bought, not what is on the pages", async () => {
  book("Bought Twice", {
    job: { state: "narrating", spent: { narrate: { chars: 40, calls: 3 } } },
    pages: [{ text: "one two three", audio: true }, { text: "four five", audio: true }],
  });
  const j = jobOf((await statusOf()).body, "bought-twice");
  assert.equal(j.cost.characters, "one two three".length + "four five".length);   // 22, the book
  assert.equal(j.cost.narrated, 40, "the ledger, not the 22 characters sitting on the pages");
});

// A book narrated before the ledger existed carries none, and one narrated then
// and re-narrated since carries only its latest purchase. Neither may make the
// card claim a whole book cost one page: the pages that DO have audio are the
// floor under the number, exactly as they were before the ledger.
test("a book that predates the ledger still reports the pages it paid for", async () => {
  book("Old Ledger", {
    job: { state: "narrating", spent: { narrate: { chars: 5, calls: 1 } } },
    pages: [{ text: "one two three", audio: true }, { text: "four five", audio: true }],
  });
  const j = jobOf((await statusOf()).body, "old-ledger");
  assert.equal(j.cost.narrated, "one two three".length + "four five".length);
});

// L6, from the same live run: a page a grown-up retyped has its `read` dropped
// (the words are theirs, not a model's), so from outside it was indistinguishable
// from a page nobody ever checked — and `edited` was written on the page and then
// never said anywhere. The count is its own number, and it is NOT a mark to fix:
// it belongs beside the flag counts, never inside them.
test("a page a grown-up typed is counted as theirs, and never as a page nobody checked", async () => {
  book("My Own Words", {
    job: { state: "published" },
    pages: [{ text: "the words I typed", edited: true },
            { text: "off the photo", flags: [{ word: null, reason: "no second model checked this page" }] },
            { text: "off the photo too" }],
  });
  const j = jobOf((await statusOf()).body, "my-own-words");
  assert.equal(j.edited, 1, "one page of this book is in a grown-up's own words");
  assert.equal(j.pageFlags, 1, "and the page nobody could check is still counted, on its own");
  assert.equal(j.flags, 0, "a page somebody typed is not a word the AI was unsure of");
});

test("a book nobody has typed on says so with a zero, never with a missing field", async () => {
  book("Untouched", { job: { state: "published" }, pages: [{ text: "one" }, { text: "two" }] });
  assert.equal(jobOf((await statusOf()).body, "untouched").edited, 0);
});

// The review page paints the badge off THIS payload, so the flag has to reach it.
test("GET /content/text says which pages a grown-up typed", async () => {
  book("Typed Here", {
    job: { state: "published" },
    pages: [{ text: "mine" }, { text: "also mine", edited: true }],
  });
  const r = await fetch(`${BASE}/content/text?slug=typed-here`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.pages.map(p => p.edited), [false, true]);
});

test("a book waiting for tomorrow's free quota is paused, never failed", async () => {
  book("Slow Book", {
    job: { state: "transcribing", pausedUntil: "2026-09-05",
           pausedNote: "waiting for tomorrow's quota" },
    pages: [{ text: "" }],
  });
  const { body } = await statusOf();
  const j = jobOf(body, "slow-book");
  assert.equal(j.state, "transcribing");
  assert.equal(j.pausedUntil, "2026-09-05");
  assert.match(j.note, /tomorrow/);
});

test("a failed book owes the step it fell over on, and says why", async () => {
  const dir = book("Sad Book", { job: { state: "transcribing" }, pages: [{ text: "" }] });
  store.writeJob(dir, store.fail(store.readJob(dir), "the reader could not open page 2"));
  const { body } = await statusOf();
  const j = jobOf(body, "sad-book");
  assert.equal(j.state, "failed");
  assert.equal(j.step, "transcribe");
  assert.match(j.error, /page 2/);
});

test("nothing key-shaped and no folder outside the content folder ever reaches the page", async () => {
  // Placeholders, not keys: they exist only so the assertion below has
  // something to fail on if status ever starts echoing the cards back.
  fs.writeFileSync(path.join(DATA, "ai-config.json"),
    JSON.stringify({ vision: { provider: "google", apiKey: "not-a-real-key-0000" } }));
  fs.writeFileSync(path.join(DATA, "tts-config.json"),
    JSON.stringify({ apiKey: "not-a-real-eleven-0000", voiceId: "v1", keyOk: true }));
  const { raw } = await statusOf();
  assert.ok(!/api[-_]?key/i.test(raw), "status must not carry a key field: " + raw.slice(0, 200));
  assert.ok(!raw.includes("not-a-real-key-0000"));
  assert.ok(!raw.includes("not-a-real-eleven-0000"));
  // No absolute path either: a status page is not a map of the family's disk.
  assert.ok(!raw.includes(TMP), "status must not name a folder outside the content folder");
});

// ---------------------------------------------------------------------- run

test("POST /content/run answers 202 straight away and runs the step behind it", async () => {
  const dir = book("Run Me", { job: { state: "narrating" }, pages: [{ text: "a word" }] });
  const r = await run({ kind: "books", slug: "run-me", step: "publish" });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { started: true });
  // The point of the 202: the answer came back before the work did, and the
  // work still happened.
  const manifest = path.join(dir, "manifest.json");
  for (let i = 0; i < 100 && !fs.existsSync(manifest); i++)
    await new Promise(r2 => setTimeout(r2, 100));
  assert.ok(fs.existsSync(manifest), "the publish step should have run behind the response");
});

test("an unknown kind, book or step is refused rather than guessed at", async () => {
  assert.equal((await run({ kind: "cheese", slug: "run-me", step: "publish" })).status, 400);
  assert.equal((await run({ kind: "books", slug: "no-such-book", step: "publish" })).status, 400);
  assert.equal((await run({ kind: "books", slug: "run-me", step: "juggle" })).status, 400);
  assert.equal((await run("{not json")).status, 400);
});

test("a body far bigger than any run request is dropped on the floor", async () => {
  const huge = JSON.stringify({ kind: "books", slug: "run-me", pad: "x".repeat(8192) });
  await assert.rejects(() => run(huge));
});

test("with Drive not in local mode there is nothing to build and the page says so", async () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  try {
    const { body } = await statusOf();
    assert.equal(body.local, false);
    assert.equal(body.skipped, "needs-local-drive");
    assert.deepEqual(body.jobs, []);
    const r = await run({ kind: "books", slug: "run-me", step: "publish" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "needs-local-drive");
  } finally {
    driveCfg({ mode: "local", folderPath: FOLDER });
  }
});

// ---------------------------------------------------------- rename (dad 9/7)

test("POST /content/rename moves the folder and the book keeps its photos", async () => {
  book("New book 2026-09-07", { sources: ["IMG_0001.HEIC"],
                                job: { state: "inbox", autoTitle: true } });
  const r = await rename({ kind: "books", slug: "new-book-2026-09-07", title: "Sunny Pond" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.renamed, true);
  assert.equal(out.title, "Sunny Pond");
  assert.equal(out.slug, "sunny-pond");
  assert.equal(fs.existsSync(path.join(BOOKS, "Sunny Pond", "sources", "IMG_0001.HEIC")), true);
  assert.equal(fs.existsSync(path.join(BOOKS, "New book 2026-09-07")), false);
  fs.rmSync(path.join(BOOKS, "Sunny Pond"), { recursive: true, force: true });
});

test("a rename never names a folder on the family's disk when it refuses", async () => {
  const r = await rename({ kind: "books", slug: "nothing-here", title: "Sunny Pond" });
  assert.equal(r.status, 400);
  const out = await r.json();
  assert.equal(out.error, "unknown book");
  assert.doesNotMatch(out.error, /[/\\]/);
});

test("with Drive not in local mode nothing can be renamed either", async () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  try {
    const r = await rename({ kind: "books", slug: "x", title: "Sunny Pond" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "needs-local-drive");
  } finally {
    driveCfg({ mode: "local", folderPath: FOLDER });
  }
});

test("/content/status counts photos that are loose in books/, and names the wait", async () => {
  fs.writeFileSync(path.join(BOOKS, "IMG_0900.HEIC"), Buffer.alloc(64, 3));
  try {
    const { body } = await statusOf();
    assert.equal(body.loose, 1, "a photo with no folder is still a book on its way");
    assert.equal(body.quietMs, 10 * 60 * 1000,
      "the quiet period still travels for readers written before 'built here'");
  } finally {
    fs.rmSync(path.join(BOOKS, "IMG_0900.HEIC"), { force: true });
  }
});

// -------------------------------------------------- build: the tap (§13/§14)
//
// The scan no longer claims anything (spec §12 "Built here"), so this door is
// the whole of how a pile of photos becomes a book on THIS computer: a grown-up
// taps Build on the shelf or the Settings card of the machine that will do the
// work. content-build.test.mjs pins every decision content.build() makes; what
// is asked here is the DOOR — /content/run's own guard, a JSON body, 202 with
// the slug, and a 409 that carries `refused` so a card knows which of the three
// answers it was handed.
//
// The code and `refused` are what these tests assert, never the sentence (spec
// §14): the wording is a parent's, content.js owns it, and it must be free to
// improve without a suite going red.

const build = (body, headers) => fetch(`${BASE}/content/build`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(headers || {}) },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

// A claim written by the OTHER computer, in the form this release writes:
// "<device id>:<pid>". `extra` overwrites whatever the test needs (an old
// heartbeat, a finished state).
const foreignJob = (dir, extra) =>
  store.writeJob(dir, { ...store.newJob({ claimedBy: OTHER + ":9" }), ...(extra || {}) });
const minsAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

test("POST /content/build claims the pile for THIS device and starts it", async () => {
  const dir = book("Tap Me", { photos: ["IMG_0001.jpg", "IMG_0002.jpg"] });
  const r = await build({ kind: "books", slug: "tap-me" });
  assert.equal(r.status, 202);
  const out = await r.json();
  assert.equal(out.started, true);
  assert.equal(out.slug, "tap-me", "the card needs the slug back to follow the book");
  const job = store.readJob(dir);
  assert.ok(job, "the tap is what writes job.json — nothing else does any more");
  // THE DEVICE ID REACHED content.js (spec §14 "Who this host is"). Without
  // server.js handing DEVICE_ID to content.start(), this would be the machine
  // name — two PCs a family bought together read as one host and the question
  // "is anyone else already building this?" cannot be asked at all.
  assert.equal(job.claimedBy.slice(0, DEVICE.length + 1), DEVICE + ":",
    "the claim must be signed with this install's device id, got " + job.claimedBy);
});

test("a book another computer is building right now is refused, and says which refusal", async () => {
  const dir = book("Busy Elsewhere", { photos: ["IMG_0001.jpg"] });
  foreignJob(dir, { state: "transcribing", heartbeat: minsAgo(1) });
  const r = await build({ kind: "books", slug: "busy-elsewhere" });
  assert.equal(r.status, 409);
  const out = await r.json();
  assert.equal(out.refused, "elsewhere");
  // The card renders this verbatim, so it has to be there — but which words
  // they are is content.js's business, not this suite's.
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0);
});

test("a job.json caught mid-rewrite is 'checking', never 'nobody has this'", async () => {
  const dir = book("Half Written", { photos: ["IMG_0001.jpg"] });
  fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
  fs.writeFileSync(store.jobPath(dir), '{"state":"transcr');
  const r = await build({ kind: "books", slug: "half-written" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).refused, "checking");
});

test("the other computer's claim LINE holds the book even before its job.json lands", async () => {
  const dir = book("Line Only", { photos: ["IMG_0001.jpg"] });
  // Drive mirrors .build/ in whatever order it likes, and log.jsonl is usually
  // what arrives first (spec §15's residual race, narrowed to this window).
  store.appendLog(dir, "claim", "claimed by " + OTHER + ":9", { by: OTHER + ":9" });
  const r = await build({ kind: "books", slug: "line-only" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).refused, "checking");
});

test("a book that is already made is never made twice", async () => {
  const dir = book("Made Already", { pages: [{ text: "one" }] });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "x", pages: [] }));
  const r = await build({ kind: "books", slug: "made-already" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).refused, "built");
  assert.equal(store.readJob(dir), null, "and no claim was written into a finished book");
});

test("the weekly book's finished job holds even while its manifest is still on its way", async () => {
  // The maker writes job.json `done` BEFORE it uploads manifest.json (spec §8),
  // precisely so a device that sees the folder half-delivered leaves it alone.
  const dir = book("Down The Wire", { pages: [{ text: "one" }] });
  foreignJob(dir, { state: "done", heartbeat: minsAgo(90) });
  const r = await build({ kind: "books", slug: "down-the-wire" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).refused, "built");
});

test("a claim gone cold is a book a grown-up may take over", async () => {
  const dir = book("Cold Claim", { photos: ["IMG_0001.jpg"] });
  foreignJob(dir, { state: "inbox", heartbeat: minsAgo(45) });
  const r = await build({ kind: "books", slug: "cold-claim" });
  assert.equal(r.status, 202);
  const job = store.readJob(dir);
  assert.equal(job.claimedBy.slice(0, DEVICE.length + 1), DEVICE + ":",
    "the takeover re-signs the job with this device");
});

test("loose:true gathers the pile in books/ with no slug and no quiet clock", async () => {
  fs.writeFileSync(path.join(BOOKS, "IMG_0901.jpg"), jpg(4));
  fs.writeFileSync(path.join(BOOKS, "IMG_0902.jpg"), jpg(5));
  const r = await build({ kind: "books", loose: true });
  assert.equal(r.status, 202);
  const out = await r.json();
  assert.equal(out.started, true);
  // The card has no slug to send for this pile (reader.js's old " loose"
  // sentinel is never sent), so the door hands one back.
  assert.equal(typeof out.slug, "string");
  assert.ok(out.slug.length > 0);
  const { body } = await statusOf();
  assert.ok(jobOf(body, out.slug), "the gathered pile is a book on the card now");
  assert.equal(body.loose, 0, "and nothing is left loose in books/");
});

test("the build door is this hub's own pages only, like /content/run", async () => {
  const dir = book("Not From Here", { photos: ["IMG_0001.jpg"] });
  const r = await build({ kind: "books", slug: "not-from-here" },
                        { "sec-fetch-site": "cross-site" });
  assert.equal(r.status, 403);
  assert.equal(store.readJob(dir), null, "a request from somewhere else claims nothing");
});

test("an unknown kind, an unknown book and a body that is not JSON are all refused", async () => {
  assert.equal((await build({ kind: "cheese", slug: "tap-me" })).status, 400);
  assert.equal((await build({ kind: "books", slug: "no-such-book" })).status, 400);
  assert.equal((await build({ kind: "books" })).status, 400);
  assert.equal((await build("{not json")).status, 400);
});

test("a body far bigger than any build request is dropped on the floor", async () => {
  await assert.rejects(() => build(JSON.stringify({ kind: "books", slug: "tap-me",
                                                    pad: "x".repeat(8192) })));
});

test("with Drive not in local mode there is nothing to build here either", async () => {
  driveCfg({ mode: "api", folderId: "F0", token: { refresh_token: "x" } });
  try {
    const r = await build({ kind: "books", slug: "tap-me" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "needs-local-drive");
  } finally {
    driveCfg({ mode: "local", folderPath: FOLDER });
  }
});

// ------------------------------- step 1 on the two older doors (spec §14)
//
// /content/run and /content/rename get the foreign-claim refusal and nothing
// else — never "this book is already made", because every review-page action
// comes back through /content/run on a book that HAS a manifest. Before this
// they could not say why at all: {error} became a 400 and {skipped} a 409 with
// nothing a card could render.

test("/content/run refuses a book another computer is building, in words the card can show", async () => {
  const dir = book("Run Elsewhere", { job: { state: "narrating" }, pages: [{ text: "a word" }] });
  foreignJob(dir, { state: "narrating", heartbeat: minsAgo(2) });
  const r = await run({ kind: "books", slug: "run-elsewhere", step: "publish" });
  assert.equal(r.status, 409);
  const out = await r.json();
  assert.equal(out.refused, "elsewhere");
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0);
});

test("/content/run still runs a book whose claim is this computer's own", async () => {
  book("Run Mine", { job: { state: "narrating" }, pages: [{ text: "a word" }] });
  const r = await run({ kind: "books", slug: "run-mine", step: "publish" });
  assert.equal(r.status, 202);
});

test("a rename with a foreign claim renames the folder and starts nothing", async () => {
  // A grown-up may name their own book whatever is building it — the folder
  // moves inside their own Drive for the other device to see — but the build
  // that would follow is the other computer's to finish (spec §14).
  const dir = book("Their Book", { sources: ["IMG_0001.HEIC"] });
  foreignJob(dir, { state: "transcribing", heartbeat: minsAgo(2) });
  // A title of its own: the earlier rename test's book was still being walked
  // when its folder was deleted, so the walk put "Sunny Pond" back, and
  // freeDirName would hand this one "Sunny Pond (2)".
  const r = await rename({ kind: "books", slug: "their-book", title: "Quiet Pond" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).renamed, true);
  const moved = path.join(BOOKS, "Quiet Pond");
  assert.equal(fs.existsSync(path.join(moved, "sources", "IMG_0001.HEIC")), true);
  await new Promise(r2 => setTimeout(r2, 300));
  assert.equal(store.readJob(moved).claimedBy, OTHER + ":9",
    "nothing here may take the book off the computer that holds it");
  assert.equal(fs.existsSync(path.join(moved, "manifest.json")), false);
  fs.rmSync(moved, { recursive: true, force: true });
});

// ------------------------------- what the card may offer (spec §14, §13)
//
// Three derived answers on every row, and no device name behind any of them:
// the shelf draws a Build card over `waiting`, Settings says "N photos —
// waiting for a grown-up to tap Build", and `elsewhere` is the one time a card
// says why there is no button at all.

test("a pile nobody has claimed is waiting for a tap, and says it is buildable", async () => {
  book("Waiting Pile", { photos: ["IMG_0001.jpg", "IMG_0002.jpg"] });
  const j = jobOf((await statusOf()).body, "waiting-pile");
  assert.equal(j.waiting, "pile");
  assert.equal(j.buildable, true);
  assert.equal(j.elsewhere, false);
});

test("a book another computer holds is not buildable, and the card is told which", async () => {
  const dir = book("Held There", { photos: ["IMG_0001.jpg"] });
  foreignJob(dir, { state: "transcribing", heartbeat: minsAgo(1) });
  const j = jobOf((await statusOf()).body, "held-there");
  assert.equal(j.elsewhere, true);
  assert.equal(j.buildable, false);
  assert.equal(j.waiting, null, "a claimed book is not a pile waiting for a tap");
  const raw = (await statusOf()).raw;
  assert.ok(!raw.includes(OTHER), "and the other computer is never named to the page");
});

test("a finished book offers no Build at all", async () => {
  const dir = book("All Done", { pages: [{ text: "one" }] });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "y", pages: [] }));
  const j = jobOf((await statusOf()).body, "all-done");
  assert.equal(j.buildable, false);
  assert.equal(j.waiting, null);
});
