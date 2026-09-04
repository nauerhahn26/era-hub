// content-routes.test.mjs — the two doors onto the book pipeline (plan T2.9):
// GET /content/status, which the Settings card and the board note read, and
// POST /content/run, the manual kick that re-runs one step of one book.
//
// PORTS: 8434 (the real server.js). No fake provider is needed and none is
// started — see the money guardrail below.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20): the hub is spawned with its own mkdtemp
// ERA_DATA_DIR, so the gate's real ElevenLabs credential is nowhere near this
// suite, and the only step this suite actually runs is `publish`, which is pure
// disk — no provider is called, so no seam is needed. The two key files written
// here hold obvious placeholders and exist for exactly one reason: to prove
// /content/status never echoes them back.
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
    const job = { ...store.newJob({ claimedBy: "test:1", now: opts.now }), ...opts.job };
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

before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  driveCfg({ mode: "local", folderPath: FOLDER });
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1" },
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
