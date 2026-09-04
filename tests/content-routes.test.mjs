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
// parent dropped in (an inbox); `pages`/`job` are what the builder has left
// behind by now. Never real book content — one word per page.
function book(name, o) {
  const opts = o || {};
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of opts.photos || []) fs.writeFileSync(path.join(dir, f), jpg(1));
  if (opts.pages) {
    fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
    const text = [], narr = [];
    opts.pages.forEach((p, i) => {
      const index = i + 1, pad = String(index).padStart(3, "0");
      fs.writeFileSync(path.join(dir, "pages", pad + ".jpg"), jpg(index));
      text.push({ index, source: "sources/IMG_000" + index + ".jpg", text: p.text || "",
                  flags: p.flags || [], cover: index === 1 });
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

test("a book part-way through says which step it owes and how far it has got", async () => {
  book("Tabby McTat", {
    job: { state: "transcribing" },
    pages: [{ text: "one two three", audio: true },
            { text: "four five", flags: [{ word: "five", reason: "smudged" }] },
            { text: "" }],
  });
  const { body } = await statusOf();
  const j = jobOf(body, "tabby-mctat");
  assert.ok(j);
  assert.equal(j.state, "transcribing");
  assert.equal(j.step, "transcribe");
  assert.deepEqual(j.progress, { pages: 3, transcribed: 2, narrated: 1 });
  assert.equal(j.flags, 1);
  // The only unit a book's spend can be counted in before the fal card exists:
  // ElevenLabs characters owed, and the ones already paid for.
  assert.equal(j.cost.characters, "one two three".length + "four five".length);
  assert.equal(j.cost.narrated, "one two three".length);
  assert.equal(j.pausedUntil, null);
  assert.equal(j.error, null);
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
