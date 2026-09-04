// content-transcribe.test.mjs — step 2 of the book pipeline (plan T2.6):
// one vision call per page under the transcription policy, the model's
// {text, uncertain} into .build/text.json, and a free key that runs out of
// requests PAUSES the book instead of failing it.
//
// PORTS: 8430 (the stand-in vision provider). No hub is spawned — T2.6 adds no
// route (that is T2.9) — so the step is driven in-process and through a real
// content-worker.js thread; the plan's 8429 hub slot stays unclaimed.
//
// MONEY GUARDRAIL (plan §B.2). Every call in this suite goes to 127.0.0.1:8430
// through the ERA_AI_URL seam, the data dir is an mkdtemp of our own, and the
// last test asserts the stand-in's own tally. A recorded count of ZERO would
// mean a request escaped the seam and reached a real provider on the family's
// key, so zero is a FAILURE here, never a pass.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AI_PORT = 8430;
const require = createRequire(import.meta.url);
const store = require(path.join(HUB, "content-store.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-transcribe-"));
const DATA = path.join(TMP, "data");
const BOOKS = path.join(TMP, "books");

// Assembled at runtime, never written as a literal: era-scan treats a key-shaped
// run in a tracked file as a fatal hit, and a fixture that looks like a key is
// indistinguishable from one that is.
const FAKE_KEY = ["AIza", "S", "y", "0".repeat(30)].join("");

let providers;
let server;
let calls = [];            // one entry per request the stand-in actually saw
let answers = [];          // queued replies, consumed in order
let throttle = new Set();  // model ids that answer 429 (a spent daily allowance)
let mode = "ok";           // ok | 401 | chatty

// ------------------------------------------------------------- the stand-in

function replyFor(provider, text) {
  if (provider === "google") return { candidates: [{ content: { parts: [{ text }] } }] };
  if (provider === "openai") return { choices: [{ message: { content: text } }] };
  return { content: [{ type: "text", text }] };
}

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      let provider = "anthropic", model = parsed.model, prompt = "", image = "";
      if (req.url.startsWith("/v1beta/models/")) {
        provider = "google";
        model = decodeURIComponent(req.url.slice("/v1beta/models/".length).split(":")[0]);
        for (const p of parsed.contents[0].parts) {
          if (p.text) prompt = p.text;
          if (p.inline_data) image = p.inline_data.data;
        }
      } else if (req.url === "/v1/chat/completions") {
        provider = "openai";
        for (const c of parsed.messages[0].content) {
          if (c.type === "text") prompt = c.text;
          if (c.type === "image_url") image = c.image_url.url;
        }
      } else if (req.url === "/v1/messages") {
        for (const c of parsed.messages[0].content) {
          if (c.type === "text") prompt = c.text;
          if (c.type === "image") image = c.source.data;
        }
      } else { res.writeHead(404).end(); return; }

      calls.push({ url: req.url, provider, model, prompt, image,
                   key: req.headers["x-goog-api-key"] || req.headers["x-api-key"] || req.headers["authorization"] });

      if (mode === "401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":{"message":"API key not valid"}}');
        return;
      }
      if (throttle.has(model)) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}');
        return;
      }
      const next = answers.length > 1 ? answers.shift() : answers[0];
      const payload = typeof next === "function" ? next({ model, calls: calls.length }) : next;
      const text = mode === "chatty"
        ? "Sure! Here is the page:\n```json\n" + JSON.stringify(payload) + "\n```\nHope that helps."
        : JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replyFor(provider, text)));
    });
  });
  await new Promise(r => server.listen(AI_PORT, "127.0.0.1", r));
  fs.mkdirSync(DATA, { recursive: true });
  providers = require(path.join(HUB, "content-providers.js"));
});

after(() => {
  if (server) server.close();
  delete process.env.ERA_AI_URL;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// --------------------------------------------------------------- fixtures

function visionKey(provider = "google") {
  fs.writeFileSync(path.join(DATA, "ai-config.json"), JSON.stringify({ vision: { provider, apiKey: FAKE_KEY } }));
}

function contentCfg(cfg) {
  const f = path.join(DATA, "content-config.json");
  if (cfg == null) { try { fs.unlinkSync(f); } catch {} return; }
  fs.writeFileSync(f, JSON.stringify(cfg));
}

// A book that has already been through ingest: pages/NNN.jpg plus the
// .build/ingest.json that names where each page came from.
function book(name, pages = 1) {
  const dir = path.join(BOOKS, name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const list = [];
  for (let i = 1; i <= pages; i++) {
    const p = "pages/" + String(i).padStart(3, "0") + ".jpg";
    fs.writeFileSync(path.join(dir, p), Buffer.alloc(64, i));
    list.push({ index: i, source: "sources/IMG_000" + i + ".jpg", image: p, copied: false });
  }
  store.writeAtomic(path.join(store.buildDir(dir), "ingest.json"), { sig: "x", pages: list });
  return dir;
}

// The single pass is no longer the default (T2.6a adopted the bake-off's
// second-opinion policy), so every test that is about the LADDER rather than
// the policy pins it off and counts calls against that.
const SINGLE = { transcribe: { agreementPass: false } };

function reset(opts = {}) {
  calls = [];
  answers = opts.answers || [{ text: "The cat sat on the mat.", uncertain: [] }];
  throttle = new Set(opts.throttle || []);
  mode = opts.mode || "ok";
  visionKey(opts.provider || "google");
  contentCfg(opts.config === undefined ? null : opts.config);
}

// ---------------------------------------------------------------- the step

test("one page, one call: the printed words and the model's doubts land in text.json", async () => {
  reset({ config: SINGLE, answers: [{ text: "Once upon a time...", uncertain: ["Snufflewump"] }] });
  const dir = book("The Cat");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(r.transcribed, 1);
  assert.equal(calls.length, 1, "exactly one call for one page");
  const t = store.readText(dir);
  assert.equal(t.pages.length, 1);
  assert.equal(t.pages[0].index, 1);
  assert.equal(t.pages[0].source, "sources/IMG_0001.jpg");
  assert.equal(t.pages[0].text, "Once upon a time...");
  // the model's `uncertain` list IS the page's flags (spec §4.2)
  assert.deepEqual(t.pages[0].flags.map(f => f.word), ["Snufflewump"]);
  assert.ok(t.pages[0].flags[0].reason, "a flag says why it is there");
  // page one of a picture book is its cover
  assert.equal(t.pages[0].cover, true);
});

test("the policy the bake-off measured is the policy the family gets", async () => {
  reset();
  await providers.transcribeBook(book("Policy"), { dataDir: DATA });
  const sent = calls[0].prompt;
  assert.match(sent, /VERBATIM PRINTED TEXT ONLY/);
  assert.match(sent, /READING ORDER/);
  assert.match(sent, /ELLIPSES/);
  assert.match(sent, /COVERS/);
  assert.match(sent, /"uncertain"/);
  assert.equal(sent, providers.TRANSCRIBE_PROMPT);
  assert.ok(calls[0].image.length > 0, "the page image travels with the prompt");
  assert.equal(calls[0].key, FAKE_KEY, "the key travels as a header, never in the URL");
  assert.ok(!calls[0].url.includes(FAKE_KEY));
});

test("a page already in text.json is never paid for twice", async () => {
  reset({ config: SINGLE });
  const dir = book("Twice", 2);
  await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(calls.length, 2);
  const again = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(calls.length, 2, "a second run must not spend a thing");
  assert.equal(again.reused, 2);
  // ...unless a parent asks for exactly that page again (the review page's
  // "read this one again")
  const one = await providers.transcribeBook(dir, { dataDir: DATA, only: [2] });
  assert.equal(calls.length, 3);
  assert.equal(one.transcribed, 1);
});

test("no key is a hold, not a failure: the book waits for one", async () => {
  reset();
  try { fs.unlinkSync(path.join(DATA, "ai-config.json")); } catch {}
  const r = await providers.transcribeBook(book("No Key"), { dataDir: DATA });
  assert.equal(r.hold, "no-ai-key");
  assert.equal(calls.length, 0);
  visionKey();
});

// ------------------------------------------------------------- the ladder

test("a 429 retires THAT model, not the day — the next one on the ladder answers", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  assert.ok(ladder.length >= 2, "the ladder needs a second rung to fall to");
  reset({ config: SINGLE, throttle: [ladder[0]] });
  const dir = book("Ladder");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(calls.length, 2, "one refusal, one answer");
  assert.equal(calls[0].model, ladder[0]);
  assert.equal(calls[1].model, ladder[1]);
  assert.equal(store.readText(dir).pages[0].text, "The cat sat on the mat.");
  assert.equal(r.transcribed, 1);
});

test("a model that is spent is not asked again for the rest of the book", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ config: SINGLE, throttle: [ladder[0]] });
  const dir = book("Spent Once", 3);
  await providers.transcribeBook(dir, { dataDir: DATA });
  // 1 refusal + 3 answers, NOT 3 refusals: page two and three skip the retired
  // model outright (clothing-worker.js's rule, dad 9/2)
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(c => c.model === ladder[0]).length, 1);
});

test("every model spent: the book PAUSES until tomorrow and is never failed", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ throttle: ladder });
  const dir = book("Out Of Quota", 2);
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(calls.length, ladder.length, "every rung tried exactly once, then stop");
  assert.equal(r.pausedUntil, providers.tomorrow());
  assert.equal(r.note, providers.QUOTA_NOTE);
  assert.match(providers.QUOTA_NOTE, /waiting for tomorrow's quota/);
  assert.ok(!r.failed, "a spent allowance is not a failure");

  // and a re-run on the same day spends NOTHING at all
  const before = calls.length;
  const again = await providers.transcribeBook(dir, { dataDir: DATA, job: { pausedUntil: providers.tomorrow() } });
  assert.equal(calls.length, before, "a paused book must not knock on the door again today");
  assert.equal(again.pausedUntil, providers.tomorrow());
});

test("the worker leaves a paused book claimed, transcribing, and saying why", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ throttle: ladder });
  const dir = book("Paused Worker");
  store.writeJob(dir, store.transition(store.newJob({ claimedBy: "test" }), "transcribing"));
  const done = await new Promise((resolve, reject) => {
    const w = new Worker(path.join(HUB, "content-worker.js"),
      { workerData: { dataDir: DATA, dir, kind: "books", slug: "paused-worker" } });
    w.on("message", (m) => { if (m.done) resolve(m.done); });
    w.on("error", reject);
    w.on("exit", () => resolve(null));
  });
  const job = store.readJob(dir);
  assert.equal(job.state, "transcribing", "never 'failed'");
  assert.equal(job.pausedUntil, providers.tomorrow());
  assert.equal(job.pausedNote, providers.QUOTA_NOTE);
  assert.ok(job.claimedBy, "the claim is kept");
  assert.equal(done.pausedUntil, providers.tomorrow());
  assert.ok(store.readLog(dir).some(l => l.msg.includes("quota")), "the log says why it stopped");
});

test("a refused key is permanent, and says so in words a parent can read", async () => {
  reset({ mode: "401" });
  const dir = book("Bad Key");
  await assert.rejects(
    () => providers.transcribeBook(dir, { dataDir: DATA }),
    (e) => {
      assert.match(e.message, /^permanent:/);
      assert.match(e.message, /did not accept that key/);
      assert.ok(!e.message.includes(FAKE_KEY), "an error may never carry the key");
      return true;
    });
  // one refusal is enough: walking the rest of the ladder would only be told
  // the same thing four more times
  assert.equal(calls.length, 1);
});

test("a chatty model that fences its JSON in prose is still understood", async () => {
  reset({ mode: "chatty", answers: [{ text: "\"Hello!\" said the mole.", uncertain: [] }] });
  const dir = book("Chatty");
  await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(store.readText(dir).pages[0].text, "\"Hello!\" said the mole.");
});

// ------------------------------------------------------- config, not code

test("the defaults are one object, and <DATA>/content-config.json overrides them", () => {
  assert.ok("agreementPass" in providers.DEFAULTS.transcribe);
  assert.ok("provider" in providers.DEFAULTS.transcribe);
  assert.ok("model" in providers.DEFAULTS.transcribe);
  assert.ok("escalateTo" in providers.DEFAULTS.transcribe);

  contentCfg(null);
  assert.deepEqual(providers.loadConfig(DATA).transcribe, providers.DEFAULTS.transcribe);

  contentCfg({ transcribe: { agreementPass: true, model: "gemini-3.5-flash" } });
  const c = providers.loadConfig(DATA);
  assert.equal(c.transcribe.agreementPass, true);
  assert.equal(c.transcribe.model, "gemini-3.5-flash");
  assert.equal(c.transcribe.provider, providers.DEFAULTS.transcribe.provider, "an unset field keeps its default");
  // a configured model leads the ladder
  assert.equal(providers.ladderFor({ provider: "google" }, c)[0], "gemini-3.5-flash");
  contentCfg(null);
});

test("agreement pass OFF: exactly one call per page", async () => {
  reset({ config: SINGLE });
  const dir = book("Single Pass", 3);
  await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(calls.length, 3);
});

test("agreement pass ON: two cheap models that agree cost two calls and no more", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ config: { transcribe: { agreementPass: true } },
          answers: [{ text: "The owl and the pussy-cat went to sea.", uncertain: [] }] });
  const dir = book("Agree");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.model), [ladder[0], ladder[1]]);
  assert.equal(store.readText(dir).pages[0].text, "The owl and the pussy-cat went to sea.");
  assert.equal(store.readText(dir).pages[0].flags.length, 0);
  assert.equal(r.escalated, 0);
});

test("agreement pass ON: a disagreement goes to the strongest configured model, and the page is flagged", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  const STRONG = ladder[3];
  reset({ config: { transcribe: { agreementPass: true, escalateTo: STRONG } },
          answers: [
            ({ model }) => model === ladder[0] ? { text: "The owl and the pussycat went to sea.", uncertain: [] }
                         : model === ladder[1] ? { text: "The owl and the puddycat went to sea.", uncertain: [] }
                         : { text: "The owl and the pussy-cat went to sea.", uncertain: [] },
          ] });
  const dir = book("Disagree");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(calls.length, 3, "two cheap readings, then the decider");
  assert.equal(calls[2].model, STRONG);
  assert.equal(r.escalated, 1);
  const page = store.readText(dir).pages[0];
  // the strongest model's reading is the one that is kept...
  assert.equal(page.text, "The owl and the pussy-cat went to sea.");
  // ...and the page carries the disagreement so the review page can show it
  assert.equal(page.flags.length, 1);
  assert.match(page.flags[0].reason, /differently/);
});

test("agreement pass ON with nothing to escalate to: the page is still flagged, not lost", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ config: { transcribe: { agreementPass: true, model: ladder[0] } },
          throttle: ladder.slice(2),
          answers: [
            ({ model }) => model === ladder[0] ? { text: "Nine mice on the ice.", uncertain: [] }
                                               : { text: "Nine mice on the rice.", uncertain: [] },
          ] });
  const dir = book("No Decider");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "Nine mice on the ice.", "the first reading is kept");
  assert.equal(page.flags.length, 1);
});

// ------------------------------------------------- the bake-off's decision

// T2.6a. The 2026-09-04 bake-off picked the transcriber, its partner and the
// policy; these tests are the guard that the pick is what the family actually
// gets. They name the two model ids on purpose — a rename that quietly drops
// the decorrelating partner is the failure worth catching (see the module
// header in content-providers.js for why the pair must not become a pair of
// the same model).
test("the defaults are the pick of the 2026-09-04 OCR bake-off", () => {
  contentCfg(null);
  const d = providers.DEFAULTS.transcribe;
  assert.equal(d.provider, "google", "a free AI Studio key, no card, two minutes");
  assert.equal(d.model, "gemini-3.1-flash-lite", "the transcriber the bake-off chose");
  assert.equal(d.agreementPass, true, "the second opinion is the safety net (it never flags itself)");
  assert.equal(d.escalateTo, null, "no third model by default - a disagreement is the parent's to settle");

  // the partner is the SECOND rung, and it is a different model
  const ladder = providers.ladderFor({ provider: "google" }, providers.loadConfig(DATA));
  assert.equal(ladder[0], "gemini-3.1-flash-lite");
  assert.equal(ladder[1], "gemini-3.5-flash-lite", "the partner that decorrelates, not the same model twice");
  assert.notEqual(ladder[0], ladder[1]);
});

test("the defaults end to end: two named models read the page, agree, and it publishes clean", async () => {
  reset();                                     // no config file at all
  const dir = book("Bake Off Defaults");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.deepEqual(calls.map(c => c.model), ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
  assert.equal(r.transcribed, 1);
  assert.equal(r.escalated, 0);
  assert.equal(store.readText(dir).pages[0].flags.length, 0, "an agreed page is not flagged");
});

test("by default a disagreement asks no third model - it goes to the parent", async () => {
  reset({ answers: [
    ({ model }) => model === "gemini-3.1-flash-lite"
      ? { text: "Nine mice on the ice.", uncertain: [] }
      : { text: "Nine mice on the rice.", uncertain: [] },
  ] });
  const dir = book("Parent Settles It");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(calls.length, 2, "two readings and no more: nothing unmeasured pre-fills the answer");
  assert.equal(r.escalated, 0);
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "Nine mice on the ice.", "the transcriber's reading is kept");
  assert.equal(page.flags.length, 1);
  assert.match(page.flags[0].reason, /differently/);
});

test("the pick is a google model, so a key for another provider gets its OWN ladder", async () => {
  reset({ provider: "openai" });               // defaults, but the card holds an OpenAI key
  assert.deepEqual(providers.ladderFor({ provider: "openai" }, providers.loadConfig(DATA)),
                   providers.PROVIDERS.openai.models,
                   "a Gemini id must never lead OpenAI's ladder");
  const dir = book("Other Key");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(r.transcribed, 1);
  assert.ok(calls.every(c => c.provider === "openai"), "every call went to the key's own provider");
  assert.deepEqual(calls.map(c => c.model), providers.PROVIDERS.openai.models.slice(0, 2),
                   "no page pays for a call that cannot succeed");
});

// --------------------------------------------------------------- the tally

test("the stand-in saw every call this suite made, and the family paid for none", () => {
  assert.ok(calls.length > 0,
    "ZERO recorded calls would mean a request escaped ERA_AI_URL and reached a real provider");
  for (const c of calls) {
    assert.ok(["/v1/messages", "/v1/chat/completions"].includes(c.url) || c.url.startsWith("/v1beta/models/"),
      "unexpected provider path " + c.url);
  }
});
