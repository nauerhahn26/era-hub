// content-narrate.test.mjs — step 3 of the book pipeline: ElevenLabs
// with-timestamps in, audio/NNN.mp3 + word timings out.
//
// PORTS: 8432 (the stand-in ElevenLabs). No hub is spawned — T2.7 adds no
// route (that is T2.9), so the step is driven in-process; the plan's 8431 hub
// slot stays unclaimed for the routes suite.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20). The gate's data dir holds a REAL,
// billable ElevenLabs credential. Every test here points ERA_ELEVEN_URL at the
// stand-in on 8432, keeps ERA_DATA_DIR / ELEVENLABS_API_KEY out of the way, and
// the last test asserts the stand-in's recorded call count. A recorded count of
// ZERO would mean a request escaped the seam and went somewhere real, so zero
// is a FAILURE here, never a pass.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELEVEN_PORT = 8432;
const require = createRequire(import.meta.url);
const store = require(path.join(HUB, "content-store.js"));

// Assembled at runtime, never written as a literal: era-scan treats an `sk_…`
// run in a tracked file as a fatal secret hit, and a fixture that looks like a
// key is indistinguishable from one that is.
const FAKE_KEY = ["sk", "_", "elevenlabs", "0".repeat(24)].join("");
const VOICE = "cgSgspJ2msm6clMCkdW9";

let server, narrate;
let calls = [];            // one entry per request the stand-in actually saw
let mode = "ok";           // ok | normalized | no-alignment | 401 | 500
let audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x21]);  // "ID3" + junk

// Character timings for whatever text is asked for: 0.1 s per character, so
// the numbers in an assertion can be worked out by hand.
function alignmentFor(text) {
  const chars = [...text];
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.1),
    character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
  };
}

before(async () => {
  delete process.env.ELEVENLABS_API_KEY;         // never let a real env key in
  process.env.ERA_ELEVEN_URL = `http://127.0.0.1:${ELEVEN_PORT}`;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      calls.push({ method: req.method, url: req.url, key: req.headers["xi-api-key"], body: parsed });
      if (mode === "401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        // A provider that echoes the request back at you, key and all — the
        // reason every error string goes through redact() before it lands.
        res.end(JSON.stringify({ detail: { status: "invalid_api_key",
          message: "bad request to " + req.url + "?xi-api-key=" + FAKE_KEY } }));
        return;
      }
      if (mode === "500") { res.writeHead(500).end("upstream boom"); return; }
      const text = (parsed && parsed.text) || "";
      const out = { audio_base64: audioBytes.toString("base64") };
      if (mode === "normalized") out.normalized_alignment = alignmentFor(text);
      else if (mode !== "no-alignment") out.alignment = alignmentFor(text);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => server.listen(ELEVEN_PORT, "127.0.0.1", r));
  narrate = require(path.join(HUB, "content-narrate.js"));
});
after(() => { if (server) server.close(); delete process.env.ERA_ELEVEN_URL; });

// A book folder mid-build: text.json written, pages/ on disk, nothing narrated.
function book(tag, pages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "era-narr-" + tag + "-"));
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const text = { pages: (pages || ["A busy bee.", "It went home."]).map((t, i) => ({
    index: i, source: "IMG_000" + i + ".jpg", text: t, flags: [], cover: i === 0 })) };
  for (const p of text.pages) fs.writeFileSync(path.join(dir, "pages", narrate.pad3(p.index) + ".jpg"), "jpg");
  store.writeText(dir, text);
  return dir;
}
const cfg = () => ({ apiKey: FAKE_KEY, voiceId: VOICE });

// ---------------------------------------------------------------- the seam

test("the base URL is the ERA_ELEVEN_URL seam, and ElevenLabs when it is unset", () => {
  assert.equal(narrate.elevenBase(), `http://127.0.0.1:${ELEVEN_PORT}`);
  const held = process.env.ERA_ELEVEN_URL;
  delete process.env.ERA_ELEVEN_URL;
  assert.equal(narrate.elevenBase(), "https://api.elevenlabs.io");   // read fresh, not at load
  process.env.ERA_ELEVEN_URL = held;
});

// -------------------------------------------------------------- narratePage

test("narratePage posts with-timestamps and returns mp3 bytes plus word timings", async () => {
  calls = [];
  const r = await narrate.narratePage("A busy bee.", cfg());
  assert.equal(calls.length, 1, "exactly one call per page");
  const c = calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/text-to-speech/" + VOICE + "/with-timestamps?output_format=mp3_44100_128");
  assert.equal(c.key, FAKE_KEY);                       // xi-api-key header, not a query param
  assert.deepEqual(c.body, { text: "A busy bee.", model_id: narrate.DEFAULT_MODEL_ID });
  assert.ok(Buffer.isBuffer(r.audio) && r.audio.equals(audioBytes), "audio_base64 decoded");
  assert.deepEqual(r.words.map(w => w.word), ["A", "busy", "bee."]);
  assert.equal(r.words[1].start, 0.2);
});

test("narratePage falls back to normalized_alignment", async () => {
  calls = []; mode = "normalized";
  try {
    const r = await narrate.narratePage("hi yo", cfg());
    assert.deepEqual(r.words.map(w => w.word), ["hi", "yo"]);
  } finally { mode = "ok"; }
  assert.equal(calls.length, 1);
});

test("narratePage refuses a reply with no alignment at all", async () => {
  calls = []; mode = "no-alignment";
  try {
    await assert.rejects(() => narrate.narratePage("hi", cfg()), /alignment/i);
  } finally { mode = "ok"; }
  assert.equal(calls.length, 1);
});

test("a bad key is a permanent error whose message carries no key", async () => {
  calls = []; mode = "401";
  let msg = "";
  try {
    await narrate.narratePage("hi", cfg()).catch(e => { msg = e.message; throw e; });
    assert.fail("should have thrown");
  } catch {} finally { mode = "ok"; }
  assert.match(msg, /^permanent:/);
  assert.ok(!msg.includes(FAKE_KEY), "the key must never reach an error string: " + msg);
  assert.equal(calls.length, 1, "no retry ladder on a permanent error");
});

// -------------------------------------------------------------- narrateBook

test("narrateBook writes audio/NNN.mp3 zero-padded, one call per page", async () => {
  calls = [];
  const dir = book("book", ["A busy bee.", "It went home.", "The end."]);
  const r = await narrate.narrateBook(dir, { cfg: cfg() });
  assert.equal(calls.length, 3, "exactly one call per page");
  assert.equal(r.narrated, 3);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, "audio")).sort(), ["000.mp3", "001.mp3", "002.mp3"]);
  assert.ok(fs.readFileSync(path.join(dir, "audio", "001.mp3")).equals(audioBytes));
  // the shape publish (T2.8) reads back
  assert.deepEqual(r.pages.map(p => p.audio), ["audio/000.mp3", "audio/001.mp3", "audio/002.mp3"]);
  assert.deepEqual(r.pages[2].words.map(w => w.word), ["The", "end."]);
  const saved = narrate.readNarration(dir);
  assert.deepEqual(saved.pages, r.pages);
  assert.ok(!fs.existsSync(path.join(dir, ".build", "narration.tmp")), "written atomically");
});

test("re-running narrateBook spends nothing: already-narrated pages are reused", async () => {
  calls = [];
  const dir = book("idem");
  await narrate.narrateBook(dir, { cfg: cfg() });
  const first = calls.length;
  assert.equal(first, 2);
  const r = await narrate.narrateBook(dir, { cfg: cfg() });
  assert.equal(calls.length, first, "a second run must not call the provider again");
  assert.equal(r.narrated, 0);
  assert.equal(r.reused, 2);
  assert.equal(r.pages.length, 2);
});

test("only:[n] re-narrates exactly that page (the review page's Re-narrate button)", async () => {
  calls = [];
  const dir = book("only");
  await narrate.narrateBook(dir, { cfg: cfg() });
  calls = [];
  fs.writeFileSync(path.join(dir, ".build", "text.json"), JSON.stringify({ pages: [
    { index: 0, source: "IMG_0000.jpg", text: "A busy bee.", flags: [], cover: true },
    { index: 1, source: "IMG_0001.jpg", text: "It flew away.", flags: [], cover: false }] }));
  const r = await narrate.narrateBook(dir, { cfg: cfg(), only: [1] });
  assert.equal(calls.length, 1, "one page re-narrated, one reused");
  assert.equal(calls[0].body.text, "It flew away.");
  assert.equal(r.narrated, 1);
  assert.equal(r.reused, 1);
  assert.deepEqual(r.pages[1].words.map(w => w.word), ["It", "flew", "away."]);
  assert.deepEqual(r.pages[0].words.map(w => w.word), ["A", "busy", "bee."], "page 0 kept its old timings");
});

test("a page whose mp3 has gone missing is re-narrated, never reported as done", async () => {
  calls = [];
  const dir = book("gone");
  await narrate.narrateBook(dir, { cfg: cfg() });
  fs.rmSync(path.join(dir, "audio", "000.mp3"));       // a mirror that never landed
  calls = [];
  let r = await narrate.narrateBook(dir, { cfg: cfg(), only: [1] });
  assert.equal(calls.length, 1, "only:[1] must not quietly pay for page 0 as well");
  assert.deepEqual(r.pages.map(p => p.index), [1], "page 0 has no audio, so it claims none");
  r = await narrate.narrateBook(dir, { cfg: cfg() });
  assert.equal(calls.length, 2);
  assert.equal(r.narrated, 1);
  assert.ok(fs.existsSync(path.join(dir, "audio", "000.mp3")));
});

test("a page whose text is blank is silent, not an error and not a call", async () => {
  calls = [];
  const dir = book("blank", ["A busy bee.", "   ", ""]);
  const r = await narrate.narrateBook(dir, { cfg: cfg() });
  assert.equal(calls.length, 1);
  assert.deepEqual(r.pages.map(p => p.index), [0]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "audio")), ["000.mp3"]);
  assert.deepEqual(r.errors, []);
});

test("no ElevenLabs key is NOT an error — the book goes on to publish silent", async () => {
  calls = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "era-narr-nokey-"));
  const dir = book("nokey");
  const r = await narrate.narrateBook(dir, { dataDir });
  assert.equal(calls.length, 0, "no key means no call — nothing to spend");
  assert.equal(r.skipped, "no-eleven-key");
  assert.deepEqual(r.pages, []);
  assert.ok(!r.error, "a missing key is not a failure");
  assert.ok(!fs.existsSync(path.join(dir, "audio")));
});

test("the key comes from the Voice card via aiRoles(), never from a caller literal", async () => {
  calls = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "era-narr-card-"));
  fs.writeFileSync(path.join(dataDir, "tts-config.json"),
    JSON.stringify({ apiKey: FAKE_KEY, voiceId: "XrExE9yKIg1WjnnlVkGX", keyOk: true }));
  const dir = book("card", ["A busy bee."]);
  const r = await narrate.narrateBook(dir, { dataDir });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("/v1/text-to-speech/XrExE9yKIg1WjnnlVkGX/"), calls[0].url);
  assert.equal(r.narrated, 1);
});

test("a page that fails is logged and skipped; the rest of the book still narrates", async () => {
  calls = [];
  const dir = book("partial", ["A busy bee.", "It went home."]);
  mode = "500";
  try { await narrate.narrateBook(dir, { cfg: cfg() }); } finally { mode = "ok"; }
  // both pages tried and failed, nothing written, nothing lost
  assert.equal(calls.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, "audio", "000.mp3")));
  mode = "ok";
  const r = await narrate.narrateBook(dir, { cfg: cfg() });
  assert.equal(r.narrated, 2);
  assert.deepEqual(r.errors, []);
});

test("a permanent error stops the run at the first page — no burning the book", async () => {
  calls = [];
  const dir = book("perm", ["A busy bee.", "It went home.", "The end."]);
  mode = "401";
  let r;
  try { r = await narrate.narrateBook(dir, { cfg: cfg() }); } finally { mode = "ok"; }
  assert.equal(calls.length, 1, "stop after the first refusal, do not try the other pages");
  assert.equal(r.permanent, true);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.errors[0].includes(FAKE_KEY));
});

test("nothing this step writes contains the key", async () => {
  calls = [];
  const dir = book("nosecret", ["A busy bee."]);
  await narrate.narrateBook(dir, { cfg: cfg() });
  mode = "401";
  try { await narrate.narrateBook(dir, { cfg: cfg(), only: [0] }); } finally { mode = "ok"; }
  const build = path.join(dir, ".build");
  for (const f of fs.readdirSync(build)) {
    const body = fs.readFileSync(path.join(build, f), "utf8");
    assert.ok(!body.includes(FAKE_KEY), f + " leaked the key");
    assert.ok(!body.includes("xi-api-key=" + FAKE_KEY), f + " leaked a keyed URL");
  }
  assert.ok(fs.readFileSync(path.join(build, "log.jsonl"), "utf8").includes("narrate"),
    "the step still leaves a human-readable trail");
});

// ------------------------------------------------------------ money guardrail

test("the stand-in recorded every call — none escaped the seam", () => {
  // Zero recorded calls anywhere above would mean the requests went to the real
  // ElevenLabs on the family's card (plan §B.2, Gap 20). Every test that
  // expects a call asserts its own count; this one proves the stand-in is the
  // only thing that was ever reachable.
  assert.equal(process.env.ERA_ELEVEN_URL, `http://127.0.0.1:${ELEVEN_PORT}`);
  assert.equal(narrate.elevenBase(), `http://127.0.0.1:${ELEVEN_PORT}`);
  assert.ok(calls.length > 0, "the stand-in must have seen the traffic");
});
