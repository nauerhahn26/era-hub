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
// Step 3 reads what step 2 wrote: a page nobody could check has to reach the
// manifest's `flagged` count, which is what /content/status and the Settings
// card show the parent.
const publish = require(path.join(HUB, "content-publish.js"));

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
// The per-test tally above is cleared by reset() at the head of nearly every
// test, so it can only ever prove the LAST test made a call. `total` is the
// suite's own running count and NOTHING resets it: it is what the closing money
// guardrail asserts on.
let total = 0;
let answers = [];          // queued replies, consumed in order
let throttle = new Set();  // model ids that answer 429 (a spent daily allowance)
// What a live 429 carries when Google feels like saying so: the
// google.rpc.RetryInfo `retryDelay` ("47s"), alongside the QuotaFailure whose
// quotaId names WHICH limit was hit. null = a bare 429 that says nothing.
let retryDelay = null;
// The quotaId in that QuotaFailure. A free key has both limits and they are not
// the same news: the per-day one means the book sleeps until California's
// midnight, the per-minute one means it sleeps for the delay and carries on.
const PER_DAY = "GenerateRequestsPerDayPerProjectPerModel-FreeTier";
const PER_MINUTE = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
let quotaId = PER_DAY;
// A 400 INVALID_ARGUMENT that has NOTHING to do with the thinking knob (a
// corrupt image, an oversized payload, a field Google stopped taking): the
// count of leading calls that are refused that way, whatever they contain.
let bad400 = 0;
// Google's newer 400s name the offending field, which puts "INVALID_ARGUMENT"
// — the last key in the envelope — well past the 160 characters the log keeps.
let wordy400 = false;
let broken = new Set();    // model ids that answer 500 (a rung that is simply down)
// The live 9/4 failure: gemini-3.5 replaced thinkingBudget with thinkingLevel and
// answers the old numeric knob with a flat 400 INVALID_ARGUMENT. With this on,
// the stand-in is that model: it refuses the budget shape and answers the level.
let budget400 = false;
let mode = "ok";           // ok | 401 | chatty
// The kill switch (L3): the Nth call and everything after it is taken and never
// answered. `parked` holds those responses so they can be let go at the end.
let gateAt = 0;
let parked = [];

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

      total++;
      calls.push({ url: req.url, provider, model, prompt, image, body: parsed,
                   key: req.headers["x-goog-api-key"] || req.headers["x-api-key"] || req.headers["authorization"] });

      // THE CALL THE PASS IS INSIDE WHEN IT DIES (L3). From `gateAt` on, the
      // stand-in takes the request and never answers it: the step is left
      // half way through a book, exactly as a throttled free key leaves it for
      // hours, and whatever is on disk at that moment is what a killed worker
      // would have kept. Released by reset()/after(), which destroy the socket.
      if (gateAt && calls.length >= gateAt) { parked.push(res); return; }

      if (mode === "401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":{"message":"API key not valid"}}');
        return;
      }
      // A 400 that is not about thinking at all, and does not know what the
      // request contained: it refuses the first `bad400` calls whatever they
      // are. Nothing in the body says "thinking", because nothing in a live
      // one does either.
      if (bad400 > 0) {
        bad400--;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 400,
          message: "Provided image is not valid.", status: "INVALID_ARGUMENT" } }, null, 2));
        return;
      }
      const thinking = (parsed.generationConfig || {}).thinkingConfig;
      if (budget400 && provider === "google" && thinking && thinking.thinkingBudget !== undefined) {
        // The terse body is the one the family's own run collected (9/4); the
        // wordy one is what Google's newer 400s look like — they name the
        // offending field, and "status" is the LAST key in the envelope.
        const message = wordy400
          ? "Unable to submit request because thinking_budget is not supported by this model. " +
            "Learn more: https://ai.google.dev/gemini-api/docs/thinking"
          : "Request contains an invalid argument.";
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 400, message, status: "INVALID_ARGUMENT" } }, null, 2));
        return;
      }
      if (broken.has(model)) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":{"code":500,"message":"The model is overloaded."}}');
        return;
      }
      if (throttle.has(model)) {
        // The live body (9/4), not a tidy one: the details array is long enough
        // that the 160 characters content-providers keeps for the log cut the
        // RetryInfo clean off the end, so a pause that believes it has to read
        // the WHOLE body, before any truncation.
        const details = retryDelay ? [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                           quotaId }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
        ] : undefined;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
                                          message: "You exceeded your current quota, please check your plan and billing details.",
                                          details } }));
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
  release();
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

// A pinned clock for the quota tests: 11:20 in the morning in California, and
// the same instant is already the AFTERNOON of the same day in UTC — so this
// box's own midnight and the allowance's are seven hours apart, which is the
// gap F6 exists to close.
const NOW = Date.parse("2026-09-04T18:20:00.000Z");
const MIN = 60 * 1000;

// The wall clock in California at an instant, through Intl itself — never
// through a hard-coded offset, because it is 7 hours in summer and 8 in winter.
function laParts(d) {
  const out = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d)) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

// The single pass is no longer the default (T2.6a adopted the bake-off's
// second-opinion policy), so every test that is about the LADDER rather than
// the policy pins it off and counts calls against that.
const SINGLE = { transcribe: { agreementPass: false } };

// Let every held request go (the caller's fetch sees a dropped socket) and stop
// holding new ones. A parked response left behind would keep a later test — or
// the suite's own exit — waiting on an answer that never comes.
function release() {
  gateAt = 0;
  for (const res of parked) { try { res.destroy(); } catch {} }
  parked = [];
}

// Poll until the pass has written what it should have written. The failure
// message IS the finding: with the one-write-at-the-end step, text.json is
// still absent when the book is three pages in.
async function until(fn, what, ms = 8000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("waited " + ms + "ms: " + what);
}

function reset(opts = {}) {
  calls = [];
  answers = opts.answers || [{ text: "The cat sat on the mat.", uncertain: [] }];
  throttle = new Set(opts.throttle || []);
  retryDelay = opts.retryDelay || null;
  quotaId = opts.quotaId || PER_DAY;
  broken = new Set(opts.broken || []);
  budget400 = !!opts.budget400;
  bad400 = opts.bad400 || 0;
  wordy400 = !!opts.wordy400;
  mode = opts.mode || "ok";
  release();
  gateAt = opts.gateAt || 0;
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

test("a re-read leaves the book in the order a grown-up dragged it into", async () => {
  reset({ config: SINGLE });
  const dir = book("Dragged", 3);
  await providers.transcribeBook(dir, { dataDir: DATA });
  // A grown-up puts the last page first on the review page (content.saveOrder
  // writes the ARRAY in reading order; the index stays welded to the photo).
  const pages = store.readText(dir).pages;
  store.writeText(dir, { pages: [pages[2], pages[0], pages[1]] });
  // …and then asks for the photos to be read again (plan T3.4).
  await providers.transcribeBook(dir, { dataDir: DATA, only: [1, 2, 3] });
  assert.deepEqual(store.readText(dir).pages.map(p => p.index), [3, 1, 2],
    "a re-read must not shuffle the book back to the order the camera numbered it in");
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

test("every model spent: the book PAUSES until the allowance comes back and is never failed", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ throttle: ladder });
  const dir = book("Out Of Quota", 2);
  const r = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW });

  assert.equal(calls.length, ladder.length, "every rung tried exactly once, then stop");
  assert.equal(r.pausedUntil, providers.pausedUntilFor(NOW), "a MOMENT, not a day (F6)");
  assert.equal(r.note, providers.QUOTA_NOTE);
  assert.match(providers.QUOTA_NOTE, /waiting for tomorrow's quota/);
  assert.ok(!r.failed, "a spent allowance is not a failure");

  // and a re-run while the pause is still running spends NOTHING at all
  const before = calls.length;
  const again = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW + MIN,
                                                     job: { pausedUntil: r.pausedUntil } });
  assert.equal(calls.length, before, "a paused book must not knock on the door again");
  assert.equal(again.pausedUntil, r.pausedUntil);
  assert.equal(again.hold, "quota");
});

// F6, the bug this closes: the pause used to be a LOCAL calendar day, and this
// box runs on UTC. Google's free-tier daily allowance resets at midnight
// Pacific, so a book that woke at 00:00 UTC — five o'clock the previous
// afternoon in California — collected a fresh 429 and paused itself for a whole
// extra day.
test("a 429 that says WHEN is believed: the pause ends when Google says the allowance does", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  // The PER-MINUTE limit: a throttle, not the day being over.
  reset({ throttle: ladder, retryDelay: "47s", quotaId: PER_MINUTE });
  const dir = book("Retry Info");
  const r = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW });

  assert.equal(r.hold, "quota");
  assert.equal(r.pausedUntil, new Date(NOW + 47000).toISOString(),
    "RetryInfo.retryDelay is the provider's own answer to 'when?' - take it");
  // …and the book is awake again the moment it passes, without waiting for any
  // midnight at all: a per-minute limit costs a minute, not a day.
  reset({ retryDelay: "47s", quotaId: PER_MINUTE });
  const back = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW + 48000,
                                                    job: { pausedUntil: r.pausedUntil } });
  assert.equal(back.hold, undefined, "the pause ended when the quota did");
  assert.equal(back.transcribed, 1);
});

// The live 9/4 body pairs the two: a QuotaFailure naming the PER-DAY limit and
// a RetryInfo of a few seconds. Believing the delay on its own woke the book
// seconds later to be refused again, all day: ~48 wakes, five refused requests
// each, and a job.json + log.jsonl rewrite INSIDE the family's Drive folder
// every time, for Drive to re-upload to every device. The QuotaFailure says
// which limit it is, so there is nothing to guess at.
test("a per-DAY 429 sleeps until California's midnight, whatever short delay comes with it", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ throttle: ladder, retryDelay: "47s", quotaId: PER_DAY });
  const r = await providers.transcribeBook(book("Day Is Over"), { dataDir: DATA, now: NOW });

  assert.equal(r.hold, "quota");
  assert.ok(Date.parse(r.pausedUntil) > NOW + 47000,
    "the day being over is not a forty-seven second throttle");
  const p = laParts(new Date(r.pausedUntil));
  assert.equal(p.hour + ":" + p.minute + ":" + p.second, "00:00:00",
    "a spent DAY comes back when the day does, where the allowance is counted");
  assert.equal(Number(p.day), Number(laParts(new Date(NOW)).day) + 1);
  // and the book stays asleep through the whole afternoon it used to spend
  // knocking every half hour
  assert.equal(providers.pauseHolds(r.pausedUntil, NOW + 6 * 60 * MIN), true);
});

test("a 429 that says nothing waits for the ALLOWANCE's midnight, not this computer's", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ throttle: ladder });                       // a bare 429: no RetryInfo
  const r = await providers.transcribeBook(book("Pacific Midnight"), { dataDir: DATA, now: NOW });

  const at = new Date(r.pausedUntil);
  assert.ok(at.getTime() > NOW, "a pause that has already passed is not a pause");
  // Asserted through Intl itself rather than against a hard-coded offset: the
  // Pacific offset is 7 or 8 hours depending on the date, and pinning either
  // number here would make this test wrong for half the year.
  const p = laParts(at);
  assert.equal(p.hour + ":" + p.minute + ":" + p.second, "00:00:00",
    "the pause ends at midnight where the allowance is counted");
  assert.equal(Number(p.day), Number(laParts(new Date(NOW)).day) + 1, "the NEXT Californian day");
  // On this QA box (UTC) the old rule's answer is seven hours early, which is
  // the whole bug: 00:00 UTC is five in the afternoon in California.
  if (new Date(NOW).getTimezoneOffset() === 0)
    assert.notEqual(r.pausedUntil, new Date(Date.UTC(2026, 8, 5)).toISOString(),
      "the host's own midnight is not the quota's midnight");
});

test("a pause an older hub wrote as a DAY is still a pause", async () => {
  // job.json files written before F6 hold "YYYY-MM-DD". A hub that updates must
  // read them as the local day they meant, not as a broken timestamp that lets
  // it knock on a door it was told this morning was shut.
  reset({ throttle: providers.ladderFor({ provider: "google" }) });
  const dir = book("Old Shape");
  const r = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW,
                                                  job: { pausedUntil: providers.tomorrow(NOW) } });
  assert.equal(r.hold, "quota");
  assert.equal(r.pausedUntil, providers.tomorrow(NOW), "echoed back exactly as it was written");
  assert.equal(calls.length, 0, "not one request spent to be told the same thing");
  // and yesterday's day string does not hold anything back
  assert.equal(providers.pauseHolds(providers.dayOf(NOW), NOW), false);
  assert.equal(providers.pauseHolds(providers.tomorrow(NOW), NOW), true);
  assert.equal(providers.pauseHolds(null, NOW), false);
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
  // The moment the allowance is expected back (F6) — kept on the job so the
  // next scan can leave the book alone until then.
  assert.ok(Date.parse(job.pausedUntil) > Date.now(), "a pause that has not passed yet");
  assert.equal(job.pausedNote, providers.QUOTA_NOTE);
  assert.ok(job.claimedBy, "the claim is kept");
  assert.equal(done.pausedUntil, job.pausedUntil);
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

// --------------------------------------------- the pinned prompt pair (E3)

// The bake-off did not measure two models asked the SAME question: it measured
// the transcriber under the older v2 wording and the partner under v3, because
// a shared wording correlates two models' mistakes as surely as a shared model
// does (Addendum §6; README "v3 is not an upgrade - it is a trade": each of the
// two reads better under its own version).
//
// AND THE TWO PASSES SEND DIFFERENT WORDINGS, because that is how the pair was
// measured: the transcriber under v2, its partner under v3. v2 was recovered
// (L7) from a worktree snapshot taken inside the window its cached records span
// and now lives in the harness as a second exported wording, so the hub PORTS
// both rather than paraphrasing either. These tests guard both halves: each
// wording really is the harness's, byte for byte, and re-pinning a pass stays a
// one-line config change.
const V3_ONLY = "PART OF THE STORY";

test("the passes are named, and the wording they send is the harness's own, byte for byte", async () => {
  contentCfg(null);
  assert.deepEqual(providers.PASSES, ["transcribe", "second-opinion"]);
  assert.equal(providers.DEFAULT_PROMPTS.transcribe, "v2",
    "the transcriber sends the wording the bake-off measured IT under");
  assert.equal(providers.DEFAULT_PROMPTS["second-opinion"], "v3");
  const two = providers.PROMPT_TEXT;
  assert.deepEqual(Object.keys(two).sort(), ["v2", "v3"],
    "both measured wordings, and only those two");
  assert.ok(two.v3.includes(V3_ONLY));
  assert.ok(!two.v2.includes(V3_ONLY), "v2 is the wording BEFORE rule 5 grew its keep clause");
  for (const v of ["v2", "v3"]) {
    assert.match(two[v], /VERBATIM PRINTED TEXT ONLY/);
    assert.match(two[v], /9\. FLAG, DO NOT GUESS/);
    assert.match(two[v], /Use "uncertain": \[\] when you are confident about every word\./);
  }
  // PORTED VERBATIM, and provably so: the harness the numbers came from is ESM
  // and cannot be require()d by the hub (Node 18 floor), but a test can import
  // it. If a re-run bumps that file's wording, this fails and the pinning is a
  // DECISION again instead of a drift.
  const bakeoff = await import(path.join(HUB, "tools/ocr-bakeoff/lib/prompts.mjs"));
  assert.equal(bakeoff.PROMPT_VERSION, "v3", "the harness still holds v3");
  assert.equal(two.v3, bakeoff.transcribePrompt(), "the wording is the harness's, byte for byte");
  assert.equal(two.v2, bakeoff.transcribePromptV2(), "and so is v2, byte for byte");
  assert.notEqual(two.v2, two.v3, "two wordings, or the pair decorrelates by model alone");
  assert.equal(providers.promptFor(providers.loadConfig(DATA), "transcribe"), two.v2);
  assert.equal(providers.promptFor(providers.loadConfig(DATA), "second-opinion"), two.v3);
  assert.equal(providers.TRANSCRIBE_PROMPT, two.v2);
});

// The KNOWN GAP, stated as a test so it cannot be forgotten quietly: nothing in
// the hub may invent a wording. Every string a model is sent is one of the
// versions in PROMPT_TEXT, and every one of those is the harness's.
test("no wording the bake-off never measured is ever sent", async () => {
  const bakeoff = await import(path.join(HUB, "tools/ocr-bakeoff/lib/prompts.mjs"));
  const measured = [bakeoff.transcribePromptV2(), bakeoff.transcribePrompt()];
  for (const [v, text] of Object.entries(providers.PROMPT_TEXT))
    assert.ok(measured.includes(text), `PROMPT_TEXT.${v} is not one of the harness's own wordings`);

  reset({ answers: [{ text: "Nine mice on the ice.", uncertain: [] }] });
  await providers.transcribeBook(book("Only Measured Wordings"), { dataDir: DATA });
  assert.equal(calls.length, 2, "two models still read the page");
  const known = Object.values(providers.PROMPT_TEXT);
  for (const c of calls)
    assert.ok(known.includes(c.prompt), "a model was sent a wording that is not in PROMPT_TEXT");
  assert.notEqual(calls[0].prompt, calls[1].prompt,
    "the pair decorrelates by WORDING as well as by model - that is the measured configuration");
  assert.equal(calls[0].prompt, providers.PROMPT_TEXT.v2, "the transcriber reads under v2");
  assert.equal(calls[1].prompt, providers.PROMPT_TEXT.v3, "its partner reads under v3");
});

test("the escalation call speaks with the second opinion's wording", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  const STRONG = ladder[3];
  reset({ config: { transcribe: { agreementPass: true, escalateTo: STRONG } },
          answers: [
            ({ model }) => model === ladder[0] ? { text: "Nine mice on the ice.", uncertain: [] }
                         : model === ladder[1] ? { text: "Nine mice on the rice.", uncertain: [] }
                         : { text: "Nine mice on the ice.", uncertain: [] },
          ] });
  await providers.transcribeBook(book("Decider Wording"), { dataDir: DATA });

  assert.equal(calls.length, 3);
  assert.equal(calls[2].model, STRONG);
  assert.equal(calls[2].prompt, providers.promptFor(providers.loadConfig(DATA), "second-opinion"),
    "the decider is asked the second opinion's question, whatever that pass is pinned to");
  assert.ok(calls[2].prompt.includes(V3_ONLY));
});

test("which wording each pass sends is config, not code", async () => {
  // Re-pinning a pass is one line in the config - never an edit at the five call
  // sites. Here both passes are pinned to v3, which is exactly the move the
  // module header forbids doing by accident and allows on purpose: a pass asks
  // by NAME, and the name is looked up per call.
  reset({ config: { transcribe: { prompts: { transcribe: "v3", "second-opinion": "v3" } } },
          answers: [{ text: "Nine mice on the ice.", uncertain: [] }] });
  await providers.transcribeBook(book("Repinned"), { dataDir: DATA });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.prompt, providers.PROMPT_TEXT.v3);

  // A version this hub does not hold is not a wordless page, and it is NOT an
  // invented one either: the pinned default stands. That is what keeps a config
  // written for a newer hub safe on one that has not been updated yet.
  contentCfg({ transcribe: { prompts: { "second-opinion": "v2" } } });
  assert.equal(providers.promptFor(providers.loadConfig(DATA), "second-opinion"), providers.PROMPT_TEXT.v2,
    "a version this hub DOES hold is honoured");
  contentCfg({ transcribe: { prompts: { transcribe: "v99" } } });
  assert.equal(providers.promptFor(providers.loadConfig(DATA), "transcribe"), providers.PROMPT_TEXT.v2,
    "and one it does not falls back to the pinned default, never to an invented string");
  contentCfg(null);
});

test("nothing the book writes down carries the prompt", async () => {
  // log.jsonl and text.json live INSIDE the family's Drive folder and mirror to
  // every device; a page's words belong there, a kilobyte of policy does not.
  reset({ answers: [
    ({ model }) => model === "gemini-3.1-flash-lite"
      ? { text: "Nine mice on the ice.", uncertain: [] }
      : { text: "Nine mice on the rice.", uncertain: [] },
  ] });
  const dir = book("Quiet Log");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const written = fs.readFileSync(path.join(store.buildDir(dir), "log.jsonl"), "utf8") +
                  fs.readFileSync(path.join(store.buildDir(dir), "text.json"), "utf8");
  assert.ok(written.includes("Nine mice"), "the page's own words ARE written down");
  for (const phrase of [V3_ONLY, "VERBATIM PRINTED TEXT ONLY", "JUNK REMOVAL",
                        "Reply with a single JSON object"])
    assert.ok(!written.includes(phrase), "the build must not write the prompt down: " + phrase);
});

// ------------------------------------------------- what the live run found

// e2e 9/4, the first real book: every agreement-pass call to
// gemini-3.5-flash-lite came back 400 INVALID_ARGUMENT because that generation
// wants thinkingLevel where 3.1 wants thinkingBudget, and every page published
// with ONE reading and NO flag. Two separate failures, one silent book: the
// partner rung never answered, and nothing said so.

test("a model that refuses the thinking knob is asked again in the shape it takes - once, and remembered", async () => {
  reset({ config: SINGLE, budget400: true,
          answers: [{ text: "Ten green bottles on the wall.", uncertain: [] }] });
  const dir = book("Thinking Knob", 2);
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(r.transcribed, 2, "a refused REQUEST SHAPE is not a model that cannot read");
  assert.equal(store.readText(dir).pages[0].text, "Ten green bottles on the wall.");
  // page one costs two requests (the refusal and the re-shape), page two costs
  // one: the shape this model takes is remembered for the rest of the run.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.model),
    ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
    "the ladder is never walked - the rung answered, it just wanted a different word");
  const knob = (c) => c.body.generationConfig.thinkingConfig;
  assert.equal(knob(calls[0]).thinkingBudget, 0,
    "the first call is the exact request the bake-off measured the transcriber under");
  assert.equal(knob(calls[1]).thinkingLevel, "minimal");
  assert.equal(knob(calls[1]).thinkingBudget, undefined, "the refused field is gone, not sent alongside");
  assert.equal(knob(calls[2]).thinkingLevel, "minimal", "page two starts in the shape that worked");
  // and the ceiling that stops a model hallucinating a novel travelled with it:
  // a transcription must not spend its token budget deliberating (QA 9/1).
  assert.equal(calls[2].body.generationConfig.maxOutputTokens, providers.MAX_TOKENS);
});

// The memo is a MEASUREMENT of what a model accepted, so it may only be written
// down when the re-shaped request was actually accepted. Google answers 400
// INVALID_ARGUMENT for plenty of things that are not the thinking knob — a
// corrupt photo, an oversized page, a field it stopped taking — and the live
// body says only "Request contains an invalid argument", so the refusal cannot
// be read. Adopting the re-shape on the strength of ANY 400 quietly re-shapes
// every page after it, and the transcriber stops sending the request the
// bake-off measured its accuracy under.
test("a 400 that was never about thinking does not re-shape the pages after it", async () => {
  // Its OWN model id: what a model accepts is remembered for the life of the
  // process (that is the point of it), so a test about the memo must not read
  // the one an earlier test taught.
  const transcriber = "gemini-flash-latest";
  reset({ config: { transcribe: { agreementPass: false, model: transcriber } },
          bad400: 2,                            // both attempts of page one refused
          answers: [{ text: "Ten green bottles on the wall.", uncertain: [] }] });
  const dir = book("Not The Knob", 2);
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  const knob = (c) => c.body.generationConfig.thinkingConfig;
  const its = calls.filter(c => c.model === transcriber);
  assert.equal(knob(its[0]).thinkingBudget, 0, "the first call is the measured request");
  assert.equal(knob(its[1]).thinkingLevel, "minimal", "one re-shape is worth trying");
  // Page one's re-shape was refused too, so nothing was learned from it: page
  // two is sent the request this model's accuracy was measured under.
  assert.equal(its.length, 3, "page two knocks on the transcriber's door again");
  assert.equal(knob(its[2]).thinkingBudget, 0,
    "a 400 nobody could read must not re-pin the transcriber's request for the whole run");
  assert.equal(knob(its[2]).thinkingLevel, undefined);
  assert.equal(r.transcribed, 2, "and both pages are still read");
});

// Google's newer 400s name the offending field, which pushes "INVALID_ARGUMENT"
// — the last key in the envelope — past the 160 characters kept for the log.
// The re-shape used to be decided on that truncated line, so a wordier refusal
// escaped it entirely: the partner rung 400s on every page, silently, which is
// the exact failure this was written to end.
test("a WORDY invalid-argument refusal is still recognised: the raw body is what is read", async () => {
  reset({ config: { transcribe: { agreementPass: false, model: "gemini-3.5-flash" } },
          budget400: true, wordy400: true,
          answers: [{ text: "Ten green bottles on the wall.", uncertain: [] }] });
  const dir = book("Wordy Refusal");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(r.transcribed, 1);
  assert.equal(calls.length, 2, "refused once, re-shaped once, answered");
  assert.deepEqual(calls.map(c => c.model), ["gemini-3.5-flash", "gemini-3.5-flash"],
    "the ladder is never walked: the rung answered, it just wanted a different word");
  assert.equal(calls[1].body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  // and the log still keeps only its 160 characters of it
  const log = store.readLog(dir).map(l => l.msg).join("\n");
  assert.ok(!log.includes("ai.google.dev"), "the log line is short, and stays short");
  // L4: a re-shape is a thing that HAPPENED to the request the transcriber's
  // accuracy was measured under, and the ledger now says so — once, on the page
  // it happened on, because the shape is remembered for the rest of the process.
  const retunes = store.readLog(dir).filter(l => l.msg.includes("re-shaped the thinking knob"));
  assert.equal(retunes.length, 1, "one line per re-shape, not one per page");
  assert.ok(retunes[0].msg.startsWith("gemini-3.5-flash:"), "and it names the model that asked for it");
  assert.ok(retunes[0].msg.includes("thinkingLevel"), "and the shape it took");
});

test("the thinking knob is a google field: the other two providers' requests are untouched", async () => {
  for (const provider of ["openai", "anthropic"]) {
    reset({ provider, config: SINGLE, budget400: true });
    const r = await providers.transcribeBook(book("Untouched " + provider), { dataDir: DATA });
    assert.equal(r.transcribed, 1);
    assert.equal(calls.length, 1, provider + ": one page, one call");
    assert.equal(calls[0].provider, provider);
    assert.equal(calls[0].body.generationConfig, undefined,
      provider + " has no generationConfig, and must never grow one");
    assert.ok(!JSON.stringify(calls[0].body).includes("thinking"),
      provider + ": no thinking knob of any shape travels to a provider that has none");
  }
});

test("a page the partner could not read is published WITH A MARK ON IT, not as an agreed page", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ broken: [ladder[1]],               // the partner rung is simply down
          answers: [{ text: "The moon came out, round and white.", uncertain: [] }] });
  const dir = book("Nobody Checked");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(r.transcribed, 1, "the reading we already paid for is never thrown away");
  assert.equal(r.escalated, 0);
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "The moon came out, round and white.");
  assert.equal(page.flags.length, 1, "one reading is not a checked page");
  assert.match(page.flags[0].reason, /no second model checked this page/);
  // A MARK ON THE PAGE, NOT ON A WORD. The review page highlights a flag's
  // `word` where it finds it in the page's own text, so a whole-page mark
  // carrying the literal word "page" told a parent there was a word to look at,
  // highlighted nothing (or worse, highlighted the word "page" on a page that
  // happened to use it) and counted itself as a doubtful word in the Settings
  // card. No word means no word.
  assert.equal(page.flags[0].word, null, "nobody was unsure of a WORD - nobody read the page twice");
  assert.ok(store.readLog(dir).some(l => l.msg.includes("no second opinion")),
    "the log still says why the second opinion could not be bought");

  // and the mark travels: the manifest is where the parent's 'come and look'
  // count comes from (content.js /content/status, the Settings books card).
  const p = publish.publishBook(dir, { slug: "nobody-checked", now: "2026-09-04T12:00:00.000Z" });
  assert.equal(p.published, true, "a flagged page still publishes - the ruling of 9/4");
  assert.equal(p.pages.length, 1);
  assert.equal(p.flagged, 1);
});

// --------------------------------------------------- who read this page (F7)

// A page's words used to arrive with no record of WHICH rung produced them or
// whether anybody checked. The flag said "come and look"; it never said who
// looked. `read` is that record, written per page, and it is OPTIONAL — an
// older text.json, or one a parent wrote by hand in power mode, simply has none.

test("an agreed page names the model that read it and the model that checked it", async () => {
  reset();                                       // the bake-off's own defaults
  const dir = book("Who Read This");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.deepEqual(page.read, { model: "gemini-3.1-flash-lite",
                                checkedBy: "gemini-3.5-flash-lite", agreed: true });
  assert.equal(page.flags.length, 0, "an agreed page is still not flagged");
});

test("a page the two models read differently says so, and names them both", async () => {
  reset({ answers: [
    ({ model }) => model === "gemini-3.1-flash-lite"
      ? { text: "Nine mice on the ice.", uncertain: [] }
      : { text: "Nine mice on the rice.", uncertain: [] },
  ] });
  const dir = book("Read Differently");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "Nine mice on the ice.", "the transcriber's reading stands");
  assert.equal(page.read.model, "gemini-3.1-flash-lite");
  assert.equal(page.read.checkedBy, "gemini-3.5-flash-lite");
  assert.equal(page.read.agreed, false);
});

test("the PARTNER reads the page when the transcriber's allowance is gone, and the page says so", async () => {
  // The live shape of a free key part-way through a book: the transcriber's
  // rung is spent, the partner answers instead — so the words on this page came
  // from the model the review page would otherwise call the checker, and
  // nobody checked them at all.
  const ladder = providers.ladderFor({ provider: "google" });
  reset({ throttle: ladder.filter(m => m !== ladder[1]),
          answers: [{ text: "The moon came out, round and white.", uncertain: [] }] });
  const dir = book("Partner Read It");
  const r = await providers.transcribeBook(dir, { dataDir: DATA, now: NOW });

  assert.equal(r.transcribed, 1);
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "The moon came out, round and white.");
  assert.equal(page.read.model, ladder[1], "the words came from the PARTNER, not the transcriber");
  assert.equal(page.read.checkedBy, null, "and there was nobody left to check them");
  assert.equal(page.read.agreed, null);
  assert.equal(page.flags.length, 1, "a page one model read alone goes to the parent");
  assert.match(page.flags[0].reason, /no second model checked this page/);
});

test("the escalated page names the DECIDER as its reader", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  const STRONG = ladder[3];
  reset({ config: { transcribe: { agreementPass: true, escalateTo: STRONG } },
          answers: [
            ({ model }) => model === ladder[0] ? { text: "The owl and the pussycat went to sea.", uncertain: [] }
                         : model === ladder[1] ? { text: "The owl and the puddycat went to sea.", uncertain: [] }
                         : { text: "The owl and the pussy-cat went to sea.", uncertain: [] },
          ] });
  const dir = book("Decider Read It");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "The owl and the pussy-cat went to sea.");
  assert.equal(page.read.model, STRONG, "`model` is whichever rung produced the WORDS");
  assert.equal(page.read.checkedBy, ladder[1]);
  assert.equal(page.read.agreed, false);
});

// -------------------------------------------- the publisher's own lines (E5)

// content-imprint.js is tested on its own (tests/content-imprint.test.mjs);
// these are about the WIRING — both readings stripped, before the agreement
// comparison and before anything is stored. Every line below is invented: a
// fake publisher (Puddleduck Press), a fake book and a fake ISBN, never a page
// of anybody's real one.

test("the publisher's own lines never reach text.json, and the log says how many went", async () => {
  reset({ config: SINGLE, answers: [{ text: [
    "The Bramblewick Bus",
    "First published in Wobblonia in 2019 by Puddleduck Press.",
    "Text copyright © 2019 Ada Bramblewick",
    "ISBN 978-1-00000-000-0",
    "The bus was old, and it was red.",
  ].join("\n"), uncertain: [] }] });
  const dir = book("Imprint");
  await providers.transcribeBook(dir, { dataDir: DATA });

  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "The Bramblewick Bus\nThe bus was old, and it was red.");
  assert.ok(!/ISBN|copyright|Puddleduck/i.test(page.text), "nothing the publisher said is left");
  // the count is a line in the log and NOWHERE in text.json - that file's
  // schema is fixed and hand-editable
  assert.ok(store.readLog(dir).some(l => l.msg.includes("imprint lines removed: 3")),
    "the log has to say how many lines went: " + JSON.stringify(store.readLog(dir).map(l => l.msg)));
  assert.ok(!JSON.stringify(store.readText(dir)).includes("imprint"),
    "the count never lands in text.json");
});

test("a page that is nothing but the publisher's furniture comes out EMPTY, not flagged", async () => {
  reset({ config: SINGLE, answers: [{ text: [
    "Puddleduck Press Ltd, 12 Marigold Lane, Fakebury, FK1 2ZZ",
    "All rights reserved.",
    "www.puddleduckpress.example",
    "A CIP catalogue record for this book is available from the National Library.",
  ].join("\n"), uncertain: [] }] });
  const dir = book("All Imprint");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "", "a copyright page has no words a reader should say out loud");
  assert.ok(store.readLog(dir).some(l => l.msg.includes("imprint lines removed: 4")));
});

test("an imprint line only ONE model read never flags the page", async () => {
  // The live shape this exists for: the transcriber narrates the copyright
  // block off a title page and the partner does not (or reads three of the
  // ISBN's digits differently). The STORY is the same in both readings, so the
  // page is agreed - before this, it went to a grown-up over a line neither
  // reading was ever going to keep.
  reset({ answers: [
    ({ model }) => model === "gemini-3.1-flash-lite"
      ? { text: "The bus was old, and it was red.\n© 2019 Puddleduck Press\nISBN 978-1-00000-000-0", uncertain: [] }
      : { text: "ISBN 978-1-OOOOO-OOO-O\nThe bus was old, and it was red.", uncertain: [] },
  ] });
  const dir = book("Furniture Disagreement");
  const r = await providers.transcribeBook(dir, { dataDir: DATA });

  assert.equal(calls.length, 2, "two cheap readings and NO decider - they agree");
  assert.equal(r.escalated, 0);
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "The bus was old, and it was red.");
  assert.equal(page.flags.length, 0, "an imprint difference is not a disagreement");
  assert.equal(page.read.agreed, true);
});

test("two models that really do read the STORY differently are still caught", async () => {
  // The other half of the same rule: stripping furniture must not quietly
  // strip the disagreement with it.
  reset({ answers: [
    ({ model }) => model === "gemini-3.1-flash-lite"
      ? { text: "© 2019 Puddleduck Press\nNine mice on the ice.", uncertain: [] }
      : { text: "Nine mice on the rice.", uncertain: [] },
  ] });
  const dir = book("Real Disagreement");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "Nine mice on the ice.");
  assert.equal(page.flags.length, 1);
  assert.equal(page.flags[0].word, "ice", "the first word they part company on, furniture aside");
  assert.equal(page.read.agreed, false);
});

test("the DECIDER's reading is stripped too, on its way to the page", async () => {
  const ladder = providers.ladderFor({ provider: "google" });
  const STRONG = ladder[3];
  reset({ config: { transcribe: { agreementPass: true, escalateTo: STRONG } },
          answers: [
            ({ model }) => model === ladder[0] ? { text: "Nine mice on the ice.", uncertain: [] }
                         : model === ladder[1] ? { text: "Nine mice on the rice.", uncertain: [] }
                         : { text: "Nine mice on the ice.\nAll rights reserved.", uncertain: [] },
          ] });
  const dir = book("Decider Imprint");
  await providers.transcribeBook(dir, { dataDir: DATA });
  const page = store.readText(dir).pages[0];
  assert.equal(page.text, "Nine mice on the ice.", "the decider does not get to add furniture");
  assert.equal(page.read.model, STRONG);
});

test("a page with no furniture on it is never logged as having had some", async () => {
  reset({ config: SINGLE, answers: [{ text: "The bus published a great grey cloud of steam.", uncertain: [] }] });
  const dir = book("Clean Page");
  await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(store.readText(dir).pages[0].text, "The bus published a great grey cloud of steam.");
  assert.ok(!store.readLog(dir).some(l => l.msg.includes("imprint lines removed")),
    "a sentence containing 'published' is a sentence");
});

// ------------------------------------- progress a free key already paid for

// e2e 9/4: text.json was written ONCE, after the whole loop, so
// /content/status said "0 of 16 read" for the entire step — and on a throttled
// free key that step is hours long. A worker killed in the middle of it (a
// reboot, a hub restart, the daily allowance running out on the next page) took
// every page it had already bought with it, and the next run bought them again.
// L3: one atomic write per page.

test("a killed worker keeps every page it already paid for, and the re-run buys only the rest", async () => {
  // The default config, i.e. the one the live run used: two models a page, so
  // page four's FIRST reading is the seventh call — the one the stand-in takes
  // and never answers.
  reset({ gateAt: 7, answers: [{ text: "The mole put on his hat and went out.", uncertain: [] }] });
  const dir = book("Killed Mid-Book", 6);
  store.writeJob(dir, store.transition(store.newJob({ claimedBy: "test" }), "transcribing"));

  const w = new Worker(path.join(HUB, "content-worker.js"),
    { workerData: { dataDir: DATA, dir, kind: "books", slug: "killed-mid-book" } });
  w.on("error", () => {});                 // a terminated worker is not a failure here
  try {
    await until(() => (store.readText(dir) || { pages: [] }).pages.length >= 3,
      "three pages read, and text.json still does not have them: a free key's work is only on disk when the whole book is");
  } finally { await w.terminate(); }

  const half = store.readText(dir);
  assert.deepEqual(half.pages.map(p => p.index), [1, 2, 3],
    "what was read is what is written - and nothing the pass never reached");
  for (const p of half.pages) {
    assert.equal(p.text, "The mole put on his hat and went out.");
    // THE SECOND OPINION SURVIVES THE PARTIAL FILE (E2/E4). A half-written
    // book whose pages forgot who checked them would come back from the kill
    // looking like a book nobody checked, and every page would carry the mark.
    assert.equal(p.read.model, "gemini-3.1-flash-lite");
    assert.equal(p.read.checkedBy, "gemini-3.5-flash-lite", "the partner that read it is remembered");
    assert.equal(p.read.agreed, true);
    assert.equal(p.flags.length, 0, "a checked page is not marked");
  }

  release();
  calls = [];
  const r = await providers.transcribeBook(dir, { dataDir: DATA });
  assert.equal(r.reused, 3, "the pages the killed pass paid for are never bought again");
  assert.equal(r.transcribed, 3, "and the three it never reached are read now");
  assert.equal(calls.length, 6, "three pages, two models each - not one request for a page already read");
  const done = store.readText(dir);
  assert.deepEqual(done.pages.map(p => p.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(done.pages[0].read.checkedBy, "gemini-3.5-flash-lite", "and page one still knows who checked it");
});

test("a partial write never drops a page the pass has not reached yet", async () => {
  // The re-read of one page (the review page's "read the photos again") walks
  // the whole book but only pays for the pages it was asked for. Writing just
  // the pages the walk has DECIDED so far would, halfway down, hand a killed
  // worker a text.json missing every page below it - text somebody paid for.
  reset({ config: SINGLE, answers: [{ text: "Nine mice on the ice.", uncertain: [] }] });
  const dir = book("Half Read", 3);
  await providers.transcribeBook(dir, { dataDir: DATA, only: [3] });
  assert.deepEqual(store.readText(dir).pages.map(p => p.index), [3], "only page three is read so far");

  gateAt = 2;                              // page one answers; page two never comes back
  calls = [];
  const run = providers.transcribeBook(dir, { dataDir: DATA }).catch(() => {});
  await until(() => (store.readText(dir) || { pages: [] }).pages.length >= 2,
    "page one was read and never written down");
  // The book's own order, kept: pages text.json already had keep their places
  // (a grown-up may have dragged them) and a new page lands after them.
  assert.deepEqual(store.readText(dir).pages.map(p => p.index), [3, 1],
    "page three is still there, and page one landed after it");
  assert.equal(store.readText(dir).pages.find(p => p.index === 3).text, "Nine mice on the ice.");

  release();                               // page two's retry gets its answer
  await run;
  assert.deepEqual(store.readText(dir).pages.map(p => p.index), [3, 1, 2]);
});

// A book stops dead on a refused key, and the pages BELOW the one that met it
// were never looked at. The final write is the only one that prunes, and it used
// to prune to whatever the walk happened to be holding — so a refusal on page
// three deleted page four's words, which a free key had already paid for. The
// half-way writes keep everything they have not reached for exactly this reason;
// the last one has to as well.
test("a refusal part-way down keeps the words of every page below it", async () => {
  reset({ config: SINGLE, mode: "401" });
  const dir = book("Refused Mid-Book", 4);
  // Pages one, two and four already have words — a gap in the middle is what
  // yesterday's transient failure leaves behind, and what a re-read of one early
  // page walks past. Page three is the one that owes a reading.
  store.writeText(dir, { pages: [1, 2, 4].map(i => ({
    index: i, source: "sources/IMG_000" + i + ".jpg", flags: [], cover: i === 1,
    text: "page " + i + ", in words somebody already paid for" })) });

  await assert.rejects(() => providers.transcribeBook(dir, { dataDir: DATA }), /permanent/);
  const after = store.readText(dir);
  assert.deepEqual(after.pages.map(p => p.index), [1, 2, 4],
    "a book that stopped may lose nothing: text.json is " + JSON.stringify(after.pages.map(p => p.index)));
  for (const p of after.pages)
    assert.match(p.text, /already paid for/, "page " + p.index + " lost its words");
  mode = "ok";
});

// The re-shape memo is remembered for the LIFE OF THE PROCESS, and the next pass
// seeds itself from it — so a line skipped on the way out of a page is a
// re-shape nobody ever writes down, in this run or any run after it. It used to
// be skipped on exactly the two exits a throttled free key takes: the quota
// `continue` and the permanent `break`.
test("a re-shape on the page that then meets a refused key is still written down", async () => {
  // Its OWN model id, for the same reason the 400 tests above pin theirs: what a
  // model accepts is remembered across the whole suite.
  const transcriber = "gemini-3-flash-preview";
  reset({ config: { transcribe: { model: transcriber } }, budget400: true,
          // The transcriber re-shapes and is answered; the key is refused from
          // the very next request on, which is the partner rung's.
          answers: [() => { mode = "401"; return { text: "Ten green bottles on the wall.", uncertain: [] }; }] });
  const dir = book("Refused After Re-shape");
  try {
    await assert.rejects(() => providers.transcribeBook(dir, { dataDir: DATA }), /permanent/);
  } finally { mode = "ok"; }

  assert.deepEqual(calls.map(c => c.model), [transcriber, transcriber, "gemini-3.1-flash-lite"],
    "refused once, re-shaped once, answered - and then the partner met the refused key");
  assert.equal(calls[1].body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  const retunes = store.readLog(dir).filter(l => l.msg.includes("re-shaped the thinking knob"));
  assert.equal(retunes.length, 1,
    "the re-shape happened and the ledger has to say so: " + JSON.stringify(store.readLog(dir).map(l => l.msg)));
  assert.ok(retunes[0].msg.startsWith(transcriber + ":"), "and it names the model that asked for it");
});

// --------------------------------------------------------------- the tally

test("the stand-in saw every call this suite made, and the family paid for none", () => {
  // `total` counts the WHOLE suite (reset() clears `calls`, never this), so a
  // request that escaped ERA_AI_URL in any test above shows up here as a total
  // lower than the calls those tests each asserted for themselves.
  assert.ok(total >= 25,
    "the stand-in only recorded " + total + " calls for the whole suite — a request escaped ERA_AI_URL");
  assert.ok(calls.length > 0,
    "ZERO recorded calls would mean a request escaped ERA_AI_URL and reached a real provider");
  for (const c of calls) {
    assert.ok(["/v1/messages", "/v1/chat/completions"].includes(c.url) || c.url.startsWith("/v1beta/models/"),
      "unexpected provider path " + c.url);
  }
});
