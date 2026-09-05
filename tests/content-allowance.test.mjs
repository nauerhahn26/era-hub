// content-allowance.test.mjs — "out of allowance" is a PAUSE, never a dead end
// (plan T6b.1, spec §4 "Design target"). The family never adds a card to
// Google, so a book that runs out of free requests — or out of this month's
// ElevenLabs characters — is the NORMAL path for a slow book, not an edge case.
//
// Three things are proved here:
//   1. ElevenLabs' spent-allowance answer (401 with {detail:{status:
//      "quota_exceeded"}}) becomes a hold, not a permanent refusal, and a plain
//      401 stays a dead key.
//   2. /content/status names the provider a paused book is waiting on, when it
//      wakes and where credit is added — and carries what is left of the
//      month's characters.
//   3. "Try again now" (POST /content/run {retry:true}) lifts a pause and the
//      provider really is called again.
//   4. A book ENTERING a pause raises exactly one Windows toast that names the
//      provider (T6b.3) — a parent who is not looking at Settings is told once,
//      and never told the same thing twice.
//
// PORTS: 8443 (the real server.js), 8444 (the stand-in ElevenLabs), 8445 (the
// stand-in vision provider).
//
// MONEY GUARDRAIL (plan §B.2, Gap 20). The gate's data dir holds a REAL,
// billable ElevenLabs credential, so this suite gives the hub an mkdtemp data
// dir of its own, points ERA_ELEVEN_URL / ERA_AI_URL at the stand-ins on 8444
// and 8445 in BOTH processes, and keeps ELEVENLABS_API_KEY out of the way. The
// closing test asserts each stand-in's own tally: a recorded count of ZERO
// would mean a request escaped the seam and reached a real provider on the
// family's key, so zero is a FAILURE here, never a pass.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8443;
const ELEVEN_PORT = 8444;
const AI_PORT = 8445;
const BASE = `http://127.0.0.1:${PORT}`;
const require = createRequire(import.meta.url);
const store = require(path.join(HUB, "content-store.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-allowance-"));
const DATA = path.join(TMP, "data");
// What Google Drive for Windows shows the family; the hub builds in place here.
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");
const BOOKS = path.join(FOLDER, "books");
// A second shelf, for the steps this suite drives in-process (no hub, no scan).
const LOOSE = path.join(TMP, "loose");
// A THIRD shelf with a data dir of its own, for the toast tests (T6b.3): those
// drive content.js's own scan() in this process, and a scan claims and builds.
// Pointed at the hub child's folder it would race the child for the very books
// the tests above are asserting on.
const DATA2 = path.join(TMP, "data-toast");
const FOLDER2 = path.join(TMP, "My Drive", "Toast Content");
const BOOKS2 = path.join(FOLDER2, "books");
// Where a toast goes instead of the Windows shell. ERA_TOAST_CMD is notify.js's
// seam: the command is spawned with the toast's two lines as its arguments, so
// the test sees exactly what a parent would have been shown without PowerShell
// existing. Split on spaces by notify.js, hence a tmp path with none in it.
const TOAST_LOG = path.join(TMP, "toasts.jsonl");
const TOAST_SEAM = path.join(TMP, "toast-seam.js");

// Assembled at runtime, never written as a literal: era-scan treats a key-shaped
// run in a tracked file as a fatal hit, and a fixture that looks like a key is
// indistinguishable from one that is.
const FAKE_VOICE_KEY = ["sk", "_", "elevenlabs", "0".repeat(24)].join("");
const FAKE_VISION_KEY = ["AIza", "S", "y", "0".repeat(30)].join("");
const VOICE = "cgSgspJ2msm6clMCkdW9";

// The month turns over at a fixed, obviously-not-now moment, so an assertion
// can name it exactly.
const RESET_UNIX = Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000);
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-05T18:20:00.000Z");

let eleven, ai, child, narrate, providers, content, drive, notify;
// One entry per request each stand-in actually saw. Cleared per test; `total`
// is the suite's running count and nothing resets it — that is what the closing
// money guardrail asserts on.
let elevenCalls = [], aiCalls = [];
let elevenTotal = 0, aiTotal = 0;
// ok | quota (401 quota_exceeded, a spent MONTH) | badkey (a plain 401)
let voiceMode = "ok";
// ok | down (the subscription endpoint answers 500) | off (no such endpoint)
let subMode = "ok";
let charactersUsed = 9000;
const CHARACTER_LIMIT = 10000;

const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x21]);   // "ID3" + junk
function alignmentFor(text) {
  const chars = [...text];
  return { characters: chars,
           character_start_times_seconds: chars.map((_, i) => i * 0.1),
           character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) };
}

before(async () => {
  delete process.env.ELEVENLABS_API_KEY;               // never let a real env key in
  process.env.ERA_ELEVEN_URL = `http://127.0.0.1:${ELEVEN_PORT}`;
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;

  // -------------------------------------------------- the stand-in ElevenLabs
  eleven = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      elevenTotal++;
      elevenCalls.push({ method: req.method, url: req.url,
                         key: req.headers["xi-api-key"], body: parsed });
      if (req.method === "GET" && req.url === "/v1/user/subscription") {
        if (subMode === "off") { res.writeHead(404).end(); return; }
        if (subMode === "down") { res.writeHead(500).end("nope"); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tier: "free", character_count: charactersUsed,
                                 character_limit: CHARACTER_LIMIT,
                                 next_character_count_reset_unix: RESET_UNIX }));
        return;
      }
      if (voiceMode === "quota") {
        // THE SHAPE THAT MATTERS: a spent monthly allowance is a 401 whose body
        // names the status. Anything less and this is just a bad key.
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: { status: "quota_exceeded",
          message: "This request exceeds your quota of 10000 characters." } }));
        return;
      }
      if (voiceMode === "badkey") {
        res.writeHead(401, { "Content-Type": "application/json" });
        // A provider that echoes the request back at you, key and all — the
        // reason every error string goes through redact() before it lands.
        res.end(JSON.stringify({ detail: { status: "invalid_api_key",
          message: "bad key " + FAKE_VOICE_KEY } }));
        return;
      }
      const text = (parsed && parsed.text) || "";
      charactersUsed += text.length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ audio_base64: audioBytes.toString("base64"),
                               alignment: alignmentFor(text) }));
    });
  });
  await new Promise(r => eleven.listen(ELEVEN_PORT, "127.0.0.1", r));

  // ------------------------------------------ the stand-in vision provider
  // Every model answers 429 with the live body's shape: a QuotaFailure naming
  // the PER-DAY limit beside a RetryInfo, which is what a free Google key sends
  // when the day is gone.
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      aiTotal++;
      aiCalls.push({ url: req.url });
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota, please check your plan and billing details.",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                           quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "47s" },
        ] } }));
    });
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));

  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(BOOKS, { recursive: true });
  fs.mkdirSync(LOOSE, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));
  // Both cards, both obvious placeholders: the hub needs a voice key to have an
  // allowance at all, and the vision key is what the paused-on-Google book was
  // reading with.
  fs.writeFileSync(path.join(DATA, "tts-config.json"),
    JSON.stringify({ apiKey: FAKE_VOICE_KEY, voiceId: VOICE, keyOk: true }));
  fs.writeFileSync(path.join(DATA, "ai-config.json"),
    JSON.stringify({ vision: { provider: "google", apiKey: FAKE_VISION_KEY } }));

  narrate = require(path.join(HUB, "content-narrate.js"));
  providers = require(path.join(HUB, "content-providers.js"));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_ELEVEN_URL: `http://127.0.0.1:${ELEVEN_PORT}`,
           ERA_AI_URL: `http://127.0.0.1:${AI_PORT}` },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/content/status`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");

  // ------------------------------------------------ the toast seam (T6b.3)
  // Set AFTER the hub child is spawned, on purpose: the child inherited an
  // environment without it, so the only toasts that reach the log below are the
  // ones this process raised, and a stray one from the child's own startup scan
  // cannot be miscounted as ours.
  fs.writeFileSync(TOAST_SEAM,
    'require("fs").appendFileSync(process.env.ERA_TOAST_FILE,\n' +
    '  JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  process.env.ERA_TOAST_FILE = TOAST_LOG;
  process.env.ERA_TOAST_CMD = "node " + TOAST_SEAM;

  fs.mkdirSync(BOOKS2, { recursive: true });
  fs.mkdirSync(DATA2, { recursive: true });
  fs.writeFileSync(path.join(DATA2, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER2 }));
  notify = require(path.join(HUB, "notify.js"));
  drive = require(path.join(HUB, "drive.js"));
  drive.start(DATA2);
  content = require(path.join(HUB, "content.js"));
  content.start(DATA2);
  // No scan in this suite may spawn a real build: the toast tests are about
  // what the family is TOLD, and a real worker thread would spend the stand-ins'
  // time writing into folders the next test rewrites.
  content.runJob = () => Promise.resolve({ ok: true });
});

after(() => {
  if (child) child.kill("SIGKILL");
  if (eleven) eleven.close();
  if (ai) ai.close();
  delete process.env.ERA_ELEVEN_URL;
  delete process.env.ERA_AI_URL;
  delete process.env.ERA_TOAST_CMD;
  delete process.env.ERA_TOAST_FILE;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// --------------------------------------------------------------- fixtures

const cfg = () => ({ apiKey: FAKE_VOICE_KEY, voiceId: VOICE });

// A book part-way through: text.json written, pages on disk, nothing narrated.
function book(root, name, pages) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const list = (pages || ["A busy bee.", "It went home."]);
  const text = { pages: list.map((t, i) => ({ index: i + 1, source: "IMG_000" + i + ".jpg",
                                              text: t, flags: [], cover: i === 0 })) };
  for (const p of text.pages)
    fs.writeFileSync(path.join(dir, "pages", String(p.index).padStart(3, "0") + ".jpg"), "jpg");
  store.writeText(dir, text);
  return dir;
}

// The same, plus the .build/ingest.json the transcriber reads.
function unread(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "001.jpg"), Buffer.alloc(64, 1));
  store.writeAtomic(path.join(store.buildDir(dir), "ingest.json"),
    { sig: "x", pages: [{ index: 1, source: "sources/IMG_0001.jpg", image: "pages/001.jpg", copied: false }] });
  return dir;
}

function job(dir, extra) {
  const base = store.newJob({ claimedBy: "test:1" });
  store.writeJob(dir, { ...base, ...extra });
}

const statusOf = async () => {
  const r = await fetch(`${BASE}/content/status`);
  const raw = await r.text();
  return { raw, body: JSON.parse(raw) };
};
const jobNamed = (body, title) => body.jobs.find(j => j.title === title);

async function until(fn, what, ms = 8000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error("waited " + ms + "ms: " + what);
    await new Promise(r => setTimeout(r, 50));
  }
}

// ------------------------------------------------ a spent allowance, one page

test("a spent monthly allowance is a PAUSE, not a dead key", async () => {
  elevenCalls = [];
  voiceMode = "quota";
  await assert.rejects(() => narrate.narratePage("A busy bee.", cfg()), (e) => {
    assert.equal(e.quota, true, "the ladder's own pause flag, as transcribe uses");
    assert.ok(!/^permanent:/.test(e.message), "a month that ran out is not a refused key");
    return true;
  });
  voiceMode = "ok";
});

test("a 401 that is NOT about the allowance is still a dead key", async () => {
  elevenCalls = [];
  voiceMode = "badkey";
  await assert.rejects(() => narrate.narratePage("A busy bee.", cfg()), (e) => {
    assert.ok(/^permanent:/.test(e.message), e.message);
    assert.ok(/did not accept that key/.test(e.message), e.message);
    assert.ok(!e.quota, "not a pause");
    assert.ok(!e.message.includes(FAKE_VOICE_KEY), "the echoed key is redacted");
    return true;
  });
  voiceMode = "ok";
});

// ------------------------------------------------- a spent allowance, a book

test("the book keeps the pages it has already paid for and waits for the month", async () => {
  elevenCalls = [];
  const dir = book(LOOSE, "Bee", ["A busy bee.", "It went home.", "Goodnight."]);
  // Page one is bought; the month runs out on page two.
  const r0 = await narrate.narrateBook(dir, { cfg: cfg(), only: [1], now: NOW });
  assert.equal(r0.narrated, 1);
  voiceMode = "quota";
  const r = await narrate.narrateBook(dir, { cfg: cfg(), now: NOW });
  voiceMode = "ok";

  assert.equal(r.hold, "quota", "a hold, exactly as the transcriber's spent ladder is");
  assert.equal(r.provider, "elevenlabs", "which allowance ran out");
  assert.equal(r.pausedUntil, new Date(RESET_UNIX * 1000).toISOString(),
               "the month's own reset moment, off /v1/user/subscription");
  assert.ok(r.note && typeof r.note === "string", "a sentence for the card");
  assert.deepEqual(r.errors, [], "an allowance that ran out is not an error");
  assert.ok(!r.permanent, "and never a permanent refusal");

  // The page that was paid for is still there, on disk and in the record.
  assert.ok(fs.existsSync(path.join(dir, "audio", "001.mp3")), "page one's mp3 survives");
  const kept = narrate.readNarration(dir).pages.map(p => p.index);
  assert.deepEqual(kept, [1], "and its timings, so nothing is bought twice");
  assert.ok(elevenCalls.some(c => c.url === "/v1/user/subscription"),
            "the reset moment is asked for, not guessed");
});

test("when ElevenLabs will not say when the month turns over, the book waits a day", async () => {
  const dir = book(LOOSE, "Quiet", ["A busy bee."]);
  voiceMode = "quota"; subMode = "down";
  const r = await narrate.narrateBook(dir, { cfg: cfg(), now: NOW });
  voiceMode = "ok"; subMode = "ok";
  assert.equal(r.hold, "quota");
  assert.equal(r.pausedUntil, new Date(NOW + DAY_MS).toISOString(),
               "unreachable is 24 hours, never for ever and never a failure");
});

// ------------------------------------------------------- what is left of it

test("the voice allowance is read once and cached, and never carries the key", async () => {
  elevenCalls = [];
  narrate._resetAllowance();
  assert.equal(narrate.allowance(DATA, { now: NOW }), null, "nothing known on the first ask");
  const v = await until(() => narrate.allowance(DATA, { now: NOW }), "the allowance to arrive");
  assert.equal(v.charactersLeft, CHARACTER_LIMIT - charactersUsed);
  assert.equal(v.resetsAt, new Date(RESET_UNIX * 1000).toISOString());
  assert.ok(!JSON.stringify(v).includes(FAKE_VOICE_KEY), "counts only, never the key");
  // Asked again inside the ten minutes: the cached answer, and no second call.
  const before = elevenCalls.filter(c => c.url === "/v1/user/subscription").length;
  narrate.allowance(DATA, { now: NOW + 60 * 1000 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(elevenCalls.filter(c => c.url === "/v1/user/subscription").length, before,
               "one subscription call per ten minutes, not one per poll");
});

// ------------------------------------------------------ the Google side too

test("a free Google key that has spent its day names its provider too", async () => {
  aiCalls = [];
  const dir = unread(LOOSE, "Unread");
  const r = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW,
                                                  config: { transcribe: { agreementPass: false } } });
  assert.equal(r.hold, "quota");
  assert.equal(r.provider, "google", "the card's own provider, named for the family");
  assert.ok(Date.parse(r.pausedUntil) > NOW, "and a moment to wake at");
  assert.ok(aiCalls.length > 0, "the stand-in saw the call");
});

// -------------------------------------------------- the worker writes it down

test("a paused narration keeps the claim, the state and the provider on the job", async () => {
  const dir = book(BOOKS, "Waiting Book", ["A busy bee.", "It went home."]);
  job(dir, { state: "reviewing" });
  voiceMode = "quota";
  const done = await new Promise((resolve, reject) => {
    const w = new Worker(path.join(HUB, "content-worker.js"), {
      workerData: { dataDir: DATA, dir, kind: "books", slug: "waiting-book", name: "Waiting Book" },
    });
    w.on("message", (m) => { if (m && m.done) resolve(m.done); });
    w.on("error", reject);
  });
  voiceMode = "ok";
  assert.equal(done.held, "quota");
  const j = store.readJob(dir);
  assert.equal(j.state, "reviewing", "the state it owes, untouched");
  assert.equal(j.held, "quota");
  assert.equal(j.pausedProvider, "elevenlabs");
  assert.ok(Date.parse(j.pausedUntil) > NOW);
  assert.equal((j.errors || []).length, 0, "a book waiting for its allowance has not failed");
});

// ------------------------------------------------------------ /content/status

test("a paused book says which allowance, until when, and where credit is added", async () => {
  const dirG = book(BOOKS, "Paused On Google");
  job(dirG, { state: "transcribing", held: "quota", pausedProvider: "google",
              pausedNote: "waiting for tomorrow's quota",
              pausedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() });
  const dirE = book(BOOKS, "Paused On Voice");
  job(dirE, { state: "reviewing", held: "quota", pausedProvider: "elevenlabs",
              pausedNote: "waiting for this month's voice allowance",
              pausedUntil: new Date(RESET_UNIX * 1000).toISOString() });
  const dirNone = book(BOOKS, "Busy Book");
  job(dirNone, { state: "reviewing" });
  const dirOld = book(BOOKS, "Old Pause");
  job(dirOld, { state: "transcribing", held: "quota",
                pausedUntil: new Date(Date.now() - 60 * 1000).toISOString() });

  const { body, raw } = await statusOf();
  const g = jobNamed(body, "Paused On Google");
  assert.deepEqual(g.paused, { provider: "google", reason: "waiting for tomorrow's quota",
                               until: g.pausedUntil,
                               addUrl: "https://aistudio.google.com/apikey" });
  assert.ok(g.pausedUntil, "the old field stays for the readers that have it");

  const e = jobNamed(body, "Paused On Voice");
  assert.equal(e.paused.provider, "elevenlabs");
  assert.equal(e.paused.addUrl, "https://elevenlabs.io/app/subscription");
  assert.equal(e.paused.until, new Date(RESET_UNIX * 1000).toISOString());

  assert.equal(jobNamed(body, "Busy Book").paused, null, "a book that is simply working");
  assert.equal(jobNamed(body, "Old Pause").paused, null, "a pause that is over is not a pause");
  assert.ok(!raw.includes(FAKE_VOICE_KEY) && !raw.includes(FAKE_VISION_KEY),
            "no key ever reaches a status payload");
});

test("/content/status says what is left of this month's voice", async () => {
  const n = await until(async () => (await statusOf()).body.narration, "the narration allowance");
  assert.ok(Number.isFinite(n.charactersLeft), "characters left this month");
  assert.equal(n.resetsAt, new Date(RESET_UNIX * 1000).toISOString());
  const { raw } = await statusOf();
  assert.ok(!raw.includes(FAKE_VOICE_KEY), "and never the key it was asked with");
});

// ---------------------------------------------------------- "Try again now"

test("try again now lifts the pause and the provider really is called", async () => {
  const dir = book(BOOKS, "Try Again Book", ["A busy bee."]);
  job(dir, { state: "reviewing", held: "quota", pausedProvider: "elevenlabs",
             pausedNote: "waiting for this month's voice allowance",
             pausedUntil: new Date(RESET_UNIX * 1000).toISOString() });
  const { body } = await statusOf();
  const slug = jobNamed(body, "Try Again Book").slug;
  elevenCalls = [];

  const r = await fetch(`${BASE}/content/run`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "books", slug, retry: true }),
  });
  assert.equal(r.status, 202);
  await until(() => {
    const j = store.readJob(dir);
    return j && !j.pausedUntil;
  }, "the pause to be lifted");
  await until(() => fs.existsSync(path.join(dir, "audio", "001.mp3")),
              "the page to be narrated now rather than next month");
});

test("try again now lifts a GOOGLE pause too, rather than holding on it again", async () => {
  const dir = unread(BOOKS, "Google Retry Book");
  job(dir, { state: "transcribing", held: "quota", pausedProvider: "google",
             pausedNote: "waiting for tomorrow's quota",
             pausedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() });
  const { body } = await statusOf();
  const slug = jobNamed(body, "Google Retry Book").slug;
  aiCalls = [];

  const r = await fetch(`${BASE}/content/run`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "books", slug, retry: true }),
  });
  assert.equal(r.status, 202);
  // The transcriber refuses to knock while a pause is recorded (that is what
  // saves a free key's requests), so a press that does not LIFT the pause buys
  // the family nothing at all.
  await until(() => aiCalls.length > 0, "the vision provider to be asked again now");
});

// ------------------------------------------------------- one toast per pause

// Every toast the seam has been handed, oldest first, as [title, body].
function toasts() {
  try {
    return fs.readFileSync(TOAST_LOG, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const RESET_ISO = new Date(RESET_UNIX * 1000).toISOString();
// Long enough for a spawned seam to have written, when the point of the
// assertion is that NOTHING was written.
const settle = () => new Promise(r => setTimeout(r, 400));

test("a book entering a pause is one toast, and it says whose allowance ran out", async () => {
  const dir = book(BOOKS2, "Toast Book");
  job(dir, { state: "reviewing", held: "quota", pausedProvider: "elevenlabs",
             pausedNote: "waiting for this month's voice allowance",
             pausedUntil: RESET_ISO });
  content.scan({ now: NOW });
  const seen = await until(() => { const l = toasts(); return l.length ? l : null; }, "the toast");
  assert.equal(seen.length, 1, "one pause, one toast");
  const [title, body] = seen[0];
  assert.match(title, /Toast Book/, "a parent recognises their own book");
  assert.match(body, /ElevenLabs/, "and where the allowance ran out");
  assert.ok(!body.includes(RESET_ISO), "the clock on the wall, never the stamp");
  assert.match(body, /Settings/, "and the place the two choices live");
});

test("the same pause on the next scan is not a second toast", async () => {
  content.scan({ now: NOW + 5 * 60 * 1000 });
  await settle();
  assert.equal(toasts().length, 1, "a book still waiting is not news");
});

test("a NEW pause on the same book IS told", async () => {
  const dir = path.join(BOOKS2, "Toast Book");
  store.writeJob(dir, { ...store.readJob(dir),
    pausedUntil: new Date(Date.parse(RESET_ISO) + 60 * 60 * 1000).toISOString() });
  content.scan({ now: NOW });
  await until(() => toasts().length === 2, "the second toast");
});

test("a Google pause names Google — the two are mended in different places", async () => {
  const dir = book(BOOKS2, "Google Toast");
  job(dir, { state: "transcribing", held: "quota", pausedProvider: "google",
             pausedNote: "waiting for tomorrow's quota",
             pausedUntil: new Date(NOW + 3 * 60 * 60 * 1000).toISOString() });
  content.scan({ now: NOW });
  const t = await until(() => toasts().find(x => /Google Toast/.test(x[0])), "the Google toast");
  assert.match(t[1], /Google/);
});

test("a run that ends in a hold tells the family without waiting for a scan", async () => {
  const dir = book(BOOKS2, "Held Book");
  const held = { slug: "held-book", held: "quota", provider: "elevenlabs",
                 pausedUntil: RESET_ISO, note: "waiting for this month's voice allowance" };
  content.runJob = () => Promise.resolve(held);
  const before = toasts().length;
  await content.run({ kind: "books", slug: "held-book", name: "Held Book", dir });
  await content.idle();
  const t = await until(() => toasts().find(x => /Held Book/.test(x[0])), "the worker's own toast");
  assert.match(t[1], /ElevenLabs/);
  assert.equal(toasts().length, before + 1);

  // The same wait, hit again — a retry that holds on the same moment, a second
  // scan, the hub's own re-run — says nothing new.
  await content.run({ kind: "books", slug: "held-book", name: "Held Book", dir });
  await content.idle();
  await settle();
  assert.equal(toasts().length, before + 1, "the same pause is told once, not once a run");
  content.runJob = () => Promise.resolve({ ok: true });
});

test("nothing is raised off Windows, and no toast ever carries a key", () => {
  const before = toasts().length;
  assert.equal(notify.toast("Toast Book is waiting", "out of allowance",
                            { cmd: "", platform: "linux" }), false,
               "no toast shell on Ellie's Linux hub — and nothing spawned to find out");
  assert.equal(toasts().length, before, "and the seam saw nothing either");
  const all = JSON.stringify(toasts());
  assert.ok(!all.includes(FAKE_VOICE_KEY) && !all.includes(FAKE_VISION_KEY),
            "a toast is a sentence for a parent, never a credential");
});

// ------------------------------------------------------------ money guardrail

test("every call this suite made went to the stand-ins", () => {
  assert.ok(elevenTotal > 0, "zero recorded ElevenLabs calls means one escaped the seam");
  assert.ok(aiTotal > 0, "zero recorded vision calls means one escaped the seam");
});
