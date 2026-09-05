// content-animate.test.mjs — step 5 of the book pipeline (plan T6.2, spec §4
// step 5): a page photo in, video/NNN.mp4 out, and the manifest re-published
// after every single clip so a book gains its moving pictures as they arrive.
//
// PORTS: 8441 (the stand-in fal). No hub is spawned — the animate step adds no
// route of its own (POST /content/run already carries {step}), so the module
// and content.js's door are driven in-process and the plan's 8439 slot stays
// with tests/fal-key.test.mjs.
//
// MONEY GUARDRAIL (plan §B.2, Gap 20), and this is the sharpest one in the
// product: fal is the only provider in the suite that bills real dollars per
// press ($0.35 a clip). Every test here points ERA_FAL_URL at the stand-in on
// 8441, builds its books inside a mkdtemp Drive folder, and reads no key file
// on this machine — the two keys below are assembled at runtime and are not
// credentials. The stand-in COUNTS what it was asked, and the counts are
// asserted in both directions: zero on every path that must not spend (no key,
// a book already animated, a scan), and non-zero on the paths that must, so a
// request that escaped the seam could not be read as a pass.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const FAKE = 8441;                       // plan §B: the stand-in fal, never a live hub
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-content-animate-"));
const DATA = path.join(TMP, "data");
const FOLDER = path.join(TMP, "My Drive", "New ERA Content");   // what Drive shows
const BOOKS = path.join(FOLDER, "books");

// Stand-in key material only — never a real credential (plan §B.3). Assembled
// so that nothing in a tracked file reads as a key even by accident.
const KEY = ["fal", "-", "stand", "-", "in", "-", "0".repeat(12)].join("");
const WRONG = ["fal", "-", "typo", "-", "0".repeat(12)].join("");
// "ftyp" + junk: the stand-in's mp4. Never a real clip.
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x21]);

let fake, animate, content, store, publish, encodeJpg;
// One entry per request the stand-in actually saw. Nothing resets it — the
// money guardrails read the whole suite's history off it.
let calls = [];
let mode = "ok";           // ok | queue | fail-one | 422-first | 401 | evil-url
// Called with the request id the instant the stand-in accepts a submit — the
// only moment a test can reach in and break something BETWEEN two clips.
let onSubmit = null;
// Nothing listens here, and nothing may ever ask it anything: it is the origin
// a malicious (or merely wrong) fal answer would name. Port 9 is discard, and
// is not in any range the plan hands out.
const ELSEWHERE = "http://127.0.0.1:9";
// The stand-in numbers the jobs it is given; a test that wants the Nth clip of
// its OWN run to fail resets the counter first.
let reqNo = 0;
let failIndex = 0;         // which numbered request the "fail-one" mode refuses
const seen = new Map();    // request id -> how many status polls it has had

const spent = (from) => calls.slice(from).filter(c => c.kind === "submit").length;
const bookDir = (name) => path.join(BOOKS, name);
const videoOf = (name, i) => path.join(bookDir(name), "video", String(i).padStart(3, "0") + ".mp4");
const manifestOf = (name) => JSON.parse(fs.readFileSync(path.join(bookDir(name), "manifest.json"), "utf8"));
const logOf = (name) => store.readLog(bookDir(name)).map(l => l.msg).join("\n");

// A real (tiny) JPEG per page — the module base64s the page's own bytes into
// the request, so a blob of zeroes would not prove the right file was read.
function jpg(index) {
  const w = 32, h = 40, data = Buffer.alloc(w * h * 4);
  const hue = [[214, 90, 70], [70, 150, 190], [230, 190, 80]][(index - 1) % 3];
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = hue[0]; data[i * 4 + 1] = hue[1]; data[i * 4 + 2] = hue[2]; data[i * 4 + 3] = 255;
  }
  return encodeJpg({ data, width: w, height: h }, 80);
}

// A published book: pages/ on disk, text.json beside it, a manifest. `texts` is
// the reading order, one-based like content-ingest.js numbers the pages. Short
// made-up lines — never real book content.
function book(name, texts, opts) {
  const o = opts || {};
  const dir = bookDir(name);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const pages = texts.map((t, i) => {
    const index = i + 1;
    fs.writeFileSync(path.join(dir, "pages", String(index).padStart(3, "0") + ".jpg"), jpg(index));
    return { index, source: "sources/IMG_000" + index + ".jpg", text: t, flags: [], cover: index === 1 };
  });
  store.writeText(dir, { pages });
  store.writeJob(dir, { ...store.newJob({ claimedBy: "test:1" }), state: o.state || "published" });
  if (o.publish !== false) publish.publishBook(dir, { slug: o.slug, title: name });
  return dir;
}

// The fal card as a parent leaves it (POST /fal-key), or no card at all.
function falCard(on, price) {
  const file = path.join(DATA, "ai-config.json");
  const cfg = on ? { fal: { apiKey: KEY, keyOk: true, ...(price ? { perClipPrice: price } : {}) } } : {};
  fs.writeFileSync(file, JSON.stringify(cfg));
}

before(async () => {
  fs.mkdirSync(BOOKS, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));
  process.env.ERA_FAL_URL = `http://127.0.0.1:${FAKE}`;

  // The stand-in fal queue: submit -> status -> response -> the mp4 itself,
  // the same four hops the real one makes you walk. Every reply hands back the
  // URLs the next hop must use, because using fal's own URLs verbatim (rather
  // than hand-building paths) is a rule of this step.
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const auth = String(req.headers.authorization || "");
      const kind = req.method === "POST" ? "submit"
                 : /\/status$/.test(req.url) ? "status"
                 : /^\/files\//.test(req.url) ? "file" : "response";
      calls.push({ kind, method: req.method, url: req.url, auth, body: parsed });
      const json = (code, obj) => {
        // A pause on every hop: two clips that published in the same
        // millisecond would make the exportedAt assertions unfalsifiable.
        setTimeout(() => res.writeHead(code, { "Content-Type": "application/json" })
          .end(JSON.stringify(obj)), 3);
      };
      if (kind === "file") { res.writeHead(200, { "Content-Type": "video/mp4" }).end(MP4); return; }
      if (auth !== "Key " + KEY || mode === "401") {
        // fal echoes the request back at you, key and all — the reason every
        // message from this module goes through redact() first.
        json(401, { error: { message: "unauthorized: Key " + (auth.slice(4) || WRONG) } });
        return;
      }
      if (kind === "submit") {
        if (mode === "422-first" && parsed && parsed.duration === "5") {
          json(422, { detail: [{ msg: "duration must be one of 5s, 10s" }] });
          return;
        }
        const id = "req-" + (++reqNo);
        seen.set(id, 0);
        if (onSubmit) onSubmit(id);
        const base = `http://127.0.0.1:${FAKE}`;
        // A body that names somewhere else entirely. fal's own answer is used
        // verbatim (a model with subpaths in its name cannot have its queue URL
        // hand-built), so "verbatim" must stop at fal's own origin — this key is
        // billable and travels in the Authorization header.
        if (mode === "evil-url") {
          json(200, { request_id: id, status_url: `${ELSEWHERE}/steal/${id}/status`,
                      response_url: `${ELSEWHERE}/steal/${id}` });
          return;
        }
        // Deliberately NOT the path a caller could build from the model name:
        // a module that guessed the URL instead of reading it would 404 here.
        json(200, { request_id: id, status_url: `${base}/q/${id}/status`,
                    response_url: `${base}/q/${id}` });
        return;
      }
      // …except when the caller fell back to the path it can build itself,
      // which is fal's own documented queue path and lands here too.
      const id = (req.url.match(/\/q\/([^/]+)/) || req.url.match(/\/requests\/([^/?]+)/) || [])[1] || "";
      const wanted = Number((seen.has(id) ? id : "").replace("req-", "")) || 0;
      if (kind === "status") {
        const polls = (seen.get(id) || 0) + 1;
        seen.set(id, polls);
        if (mode === "fail-one" && wanted === failIndex)
          return json(200, { status: "FAILED", error: "the model could not finish this one" });
        // "queue" mode makes the caller poll twice, which is the loop's own
        // contract: a clip is not ready the instant it is asked for.
        json(200, { status: mode === "queue" && polls < 2 ? "IN_QUEUE" : "COMPLETED" });
        return;
      }
      json(200, { video: { url: `http://127.0.0.1:${FAKE}/files/${id}.mp4` } });
    });
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));

  ({ encodeJpg } = require("./image-util.js"));
  store = require("./content-store.js");
  publish = require("./content-publish.js");
  animate = require("./content-animate.js");
  const drive = require("./drive.js");
  drive.start(DATA);
  content = require("./content.js");
  content.start(DATA);
});
after(() => { if (fake) fake.close(); });

// ------------------------------------------------------------- no key, no spend

test("no fal key is an empty outcome, not a failure — and asks fal nothing", async () => {
  const at = calls.length;
  falCard(false);
  book("No Key Yet", ["one", "two"]);
  const r = await animate.animateBook(bookDir("No Key Yet"), { dataDir: DATA, slug: "no-key-yet" });
  assert.equal(r.skipped, "no-fal-key");
  assert.equal(r.animated, 0);
  assert.equal(spent(at), 0, "nothing was asked of fal");
  assert.equal(fs.existsSync(path.join(bookDir("No Key Yet"), "video")), false);
});

test("the door refuses a press with no key in words, before any thread is spawned", async () => {
  const at = calls.length;
  falCard(false);
  book("Ask Without A Key", ["one", "two"]);
  const out = content.runStep({ kind: "books", slug: "ask-without-a-key", step: "animate" });
  assert.equal(out.started, undefined);
  assert.match(out.error, /fal/i, "the sentence names the card the fix is on: " + out.error);
  assert.ok(!/\d{3}/.test(out.error), "a parent gets words, not a status code: " + out.error);
  await content.idle();
  assert.equal(spent(at), 0, "a refusal spends nothing");
});

// ------------------------------------------------------------------ the cost gate

test("a book is quoted pages x the price of one clip, and never quoted without one", () => {
  assert.deepEqual(animate.quote(16, 0.35), { pages: 16, perClip: 0.35, total: 5.6 });
  // The gate is mandatory (spec §4 step 5): no price, no pages, no quote — and
  // the review page keeps the button disabled on exactly this null.
  assert.equal(animate.quote(16, 0), null);
  assert.equal(animate.quote(16, null), null);
  assert.equal(animate.quote(0, 0.35), null);
});

test("/content/status carries the quote, and only once a fal key is saved", async () => {
  falCard(false);
  book("Quote Me", ["one", "two", "three"]);
  let j = content.status().jobs.find(b => b.slug === "quote-me");
  assert.equal(j.animate.ready, false);
  assert.equal(j.animate.total, null, "no key is no quote, so the button cannot be enabled");
  falCard(true);
  j = content.status().jobs.find(b => b.slug === "quote-me");
  assert.equal(j.animate.ready, true);
  assert.equal(j.animate.pages, 3);
  assert.equal(j.animate.perClip, 0.35);
  assert.equal(j.animate.total, 1.05, "three pages at 35 cents");
  // A price a family was quoted when they saved the key wins over the default.
  falCard(true, 0.5);
  j = content.status().jobs.find(b => b.slug === "quote-me");
  assert.equal(j.animate.total, 1.5);
  assert.ok(!JSON.stringify(j).includes(KEY), "no key ever reaches a status payload");
  falCard(true);
});

// --------------------------------------------------------------- one whole book

test("every page gets a clip, and the manifest is re-published after each one", async () => {
  const at = calls.length;
  falCard(true);
  mode = "queue";
  book("Moving Pictures", ["the mouse ran", "the moon was quiet"]);
  const before_ = manifestOf("Moving Pictures").exportedAt;
  const r = await animate.animateBook(bookDir("Moving Pictures"),
    { dataDir: DATA, slug: "moving-pictures", name: "Moving Pictures", pollMs: 5 });
  mode = "ok";
  assert.equal(r.animated, 2);
  assert.equal(r.errors.length, 0);
  assert.equal(spent(at), 2, "one submit per page, and not one more");
  for (const i of [1, 2]) assert.ok(fs.statSync(videoOf("Moving Pictures", i)).size > 0);
  // The manifest names both clips and was stamped again on the way (spec §4
  // step 5: pages gain video as it arrives, not once at the end).
  const m = manifestOf("Moving Pictures");
  assert.deepEqual(m.pages.map(p => p.video), ["video/001.mp4", "video/002.mp4"]);
  assert.ok(m.exportedAt > before_, "a re-publish must bump exportedAt");
  assert.equal(r.publishes, 2, "one re-publish per clip");
  // The clip really was polled rather than assumed ready.
  assert.ok(calls.slice(at).filter(c => c.kind === "status").length >= 4);
});

test("the request is the documented one: the model, five seconds, the standing negatives", async () => {
  const at = calls.length;
  falCard(true);
  book("One Page", ["a quiet page"]);
  await animate.animateBook(bookDir("One Page"), { dataDir: DATA, slug: "one-page", pollMs: 5 });
  const sub = calls.slice(at).find(c => c.kind === "submit");
  assert.equal(sub.url, "/" + animate.MODEL, "kling 2.5 turbo pro image-to-video");
  assert.equal(sub.body.duration, "5", "the $0.35 clip the bake-off picked");
  assert.match(sub.body.negative_prompt, /characters disappearing/);
  assert.match(sub.body.negative_prompt, /style change/);
  // The page's own photo travels with it, as bytes: this hub has no public URL
  // to hand fal, so the image goes as a data URI.
  assert.match(sub.body.image_url, /^data:image\/jpeg;base64,/);
  const sent = Buffer.from(sub.body.image_url.split(",")[1], "base64");
  assert.ok(sent.equals(fs.readFileSync(path.join(bookDir("One Page"), "pages", "001.jpg"))),
            "the page's own bytes, not another page's");
  // Motion only, and never the family's own words: the book's text is not the
  // prompt and must not leak into it.
  assert.ok(sub.body.prompt.length <= 900, "≤900 chars, as the scripting rules ask");
  assert.ok(!sub.body.prompt.includes("a quiet page"), "the book's words are not sent to fal");
});

// THE ONE PLACE ONE PAGE IS SUBMITTED TWICE (review 9/5). Some fal models want
// "5s" where others want "5", and this module retries once with the suffix
// rather than losing the page. It is the sharpest money path in the file — a
// retry that slipped below the ledger, or looped, would bill a family twice for
// one page — so both halves are pinned: two submits, one charge.
test("a model that wants '5s' is asked again — and the retry is not a second charge", async () => {
  const at = calls.length;
  falCard(true);
  mode = "422-first";
  book("Fussy Duration", ["one"]);
  const r = await animate.animateBook(bookDir("Fussy Duration"),
    { dataDir: DATA, slug: "fussy-duration", name: "Fussy Duration", pollMs: 5 });
  mode = "ok";
  assert.equal(r.animated, 1, "the page survived the 422");
  assert.equal(spent(at), 2, "asked twice, and twice only");
  assert.deepEqual(calls.slice(at).filter(c => c.kind === "submit").map(c => c.body.duration),
                   ["5", "5s"], "the plain seconds first, the suffix as the retry");
  assert.equal(fs.readdirSync(path.join(bookDir("Fussy Duration"), "video")).length, 1,
               "one page, one clip");
  // A 422 is a REFUSAL: fal never took the job, so it never billed for it. The
  // ledger must count what was accepted, not what was asked.
  assert.equal(store.readJob(bookDir("Fussy Duration")).spent.animate.calls, 1);
});

// The key travels as a header, and a header goes wherever the URL says. fal's
// own answer names the next two URLs, so an answer that named somewhere else
// would hand the family's billable key to it. The guard is an origin check, and
// the fallback is the path this module can build for itself.
test("a queue URL that is not fal's own is never asked, and the clip still lands", async () => {
  const at = calls.length;
  falCard(true);
  mode = "evil-url";
  book("Somewhere Else", ["one"]);
  const r = await animate.animateBook(bookDir("Somewhere Else"),
    { dataDir: DATA, slug: "somewhere-else", name: "Somewhere Else", pollMs: 5 });
  mode = "ok";
  assert.equal(r.animated, 1, "the page was not lost to the guard");
  assert.ok(fs.statSync(videoOf("Somewhere Else", 1)).size > 0);
  const urls = calls.slice(at).map(c => c.url);
  assert.equal(urls.some(u => /steal/.test(u)), false, "the named URL was not followed");
  assert.ok(urls.some(u => /\/requests\/[^/]+\/status$/.test(u)),
            "fal's own documented queue path was used instead: " + urls.join(" "));
});

test("a confrontation page gets the duel template, a quiet one does not", () => {
  const duel = animate.scriptFor({ text: "the crab chased the fish and they fought" });
  const calm = animate.scriptFor({ text: "the moon came up over the sleeping town" });
  assert.equal(duel.energy, "duel");
  assert.match(duel.prompt, /winner/i, "challenge -> struggle -> a clear winner");
  assert.match(duel.negative, /out of frame/i, "the duel's own negative additions");
  assert.equal(calm.energy, "ambient");
  assert.doesNotMatch(calm.prompt, /winner/i);
  // Both keep the standing clauses, whatever the page is doing.
  for (const s of [duel, calm]) {
    assert.match(s.negative, /characters disappearing/);
    assert.match(s.prompt, /still/i, "everyone not acting holds still");
    assert.ok(s.prompt.length <= 900);
  }
});

// ------------------------------------------------------------- never pay twice

test("a page that already has its clip is never bought again", async () => {
  const at = calls.length;
  falCard(true);
  const r = await animate.animateBook(bookDir("Moving Pictures"),
    { dataDir: DATA, slug: "moving-pictures", pollMs: 5 });
  assert.equal(r.animated, 0);
  assert.equal(r.reused, 2);
  assert.equal(spent(at), 0, "a second press on a finished book costs nothing");
});

// ---------------------------------------------------------- one clip, not the book

test("a clip that fails is logged and the book carries on", async () => {
  const at = calls.length;
  falCard(true);
  mode = "fail-one"; reqNo = 0; failIndex = 1;   // the FIRST clip of this run refuses
  book("Half Lucky", ["one", "two"]);
  const r = await animate.animateBook(bookDir("Half Lucky"),
    { dataDir: DATA, slug: "half-lucky", name: "Half Lucky", pollMs: 5 });
  mode = "ok";
  assert.equal(r.animated, 1, "the page after the failure was still animated");
  assert.equal(r.errors.length, 1);
  assert.equal(r.permanent, undefined, "one bad clip is not a refused key");
  assert.equal(fs.existsSync(videoOf("Half Lucky", 1)), false);
  assert.ok(fs.statSync(videoOf("Half Lucky", 2)).size > 0);
  assert.equal(spent(at), 2, "both pages were tried");
  assert.match(logOf("Half Lucky"), /page 1/, "the loss is written down where a parent can be told");
  // …and the book still publishes, with the clip it did get.
  assert.deepEqual(manifestOf("Half Lucky").pages.map(p => p.video || null), [null, "video/002.mp4"]);
});

test("a key fal refuses stops the book at once, without trying every page", async () => {
  const at = calls.length;
  falCard(true);
  mode = "401";
  book("Refused", ["one", "two", "three"]);
  const r = await animate.animateBook(bookDir("Refused"),
    { dataDir: DATA, slug: "refused", pollMs: 5 });
  mode = "ok";
  assert.equal(r.animated, 0);
  assert.equal(r.permanent, true);
  assert.equal(spent(at), 1, "one refusal is enough — the other two pages are not paid for");
  assert.match(r.errors[0], /^permanent:/);
});

// ------------------------------------------------------------ the door and the walk

test("POST /content/run {step:'animate'} is the only thing that starts a clip", async () => {
  const at = calls.length;
  falCard(true);
  book("By Hand", ["one"]);
  // A scan claims nothing here: a published book owes no step, so nothing in
  // the half-hourly walk can ever reach fal on its own (the whole point of
  // "off by default").
  content.scan();
  await content.idle();
  assert.equal(spent(at), 0, "a scan never animates a book");
  const out = content.runStep({ kind: "books", slug: "by-hand", step: "animate" });
  assert.equal(out.started, true);
  await content.idle();
  assert.equal(spent(at), 1, "the press, and only the press, bought the clip");
  assert.ok(fs.statSync(videoOf("By Hand", 1)).size > 0);
  assert.equal(manifestOf("By Hand").pages[0].video, "video/001.mp4");
  // What it cost, on the job, in the step's own unit: clips.
  const job = store.readJob(bookDir("By Hand"));
  assert.equal(job.spent.animate.calls, 1);
  // A book that was already on the shelf stays on it — animation moves nothing
  // backwards.
  assert.ok(["published", "done"].includes(job.state));
});

// THE SAFETY NET (content-worker.js, the optional step). A clip re-publishes
// the manifest the moment it lands, so a book gains its moving pictures page by
// page — but a publish can fail on its own (Google Drive holding manifest.json
// open on Windows is the whole reason content-publish writes tmp+rename), and a
// clip that is on disk and paid for but absent from the manifest is invisible:
// nothing re-publishes a finished book, and "N of M pages have one" counts the
// disk, not the manifest. So the walk re-publishes whenever fewer clips reached
// the manifest than were made.
test("a clip whose own publish failed is put on the shelf by the walk, not left paid for and hidden", async () => {
  const at = calls.length;
  falCard(true);
  book("Half Published", ["one", "two"]);
  const dir = bookDir("Half Published");
  // Page 2's publish, and only page 2's: a dangling symlink where
  // content-store writes its .tmp makes that one write throw, and writeAtomic's
  // own sweep clears the symlink again — so the next publish works. Set as the
  // stand-in accepts the SECOND submit, which is after page 1 published and
  // before page 2 does.
  let n = 0;
  onSubmit = () => { if (++n === 2)
    fs.symlinkSync(path.join(TMP, "nowhere", "x"), path.join(dir, "manifest.tmp")); };
  const out = content.runStep({ kind: "books", slug: "half-published", step: "animate" });
  assert.equal(out.started, true);
  await content.idle();
  onSubmit = null;
  assert.equal(spent(at), 2, "both pages were bought");
  for (const i of [1, 2]) assert.ok(fs.statSync(videoOf("Half Published", i)).size > 0);
  assert.match(logOf("Half Published"), /manifest was not rewritten/,
               "page 2's own publish really did fail");
  assert.deepEqual(manifestOf("Half Published").pages.map(p => p.video),
                   ["video/001.mp4", "video/002.mp4"],
                   "the walk re-published what the clip could not");
});

// WHAT WAS ACTUALLY SPENT, not what arrived. fal bills the moment it accepts a
// clip, so every path that loses the page afterwards (a render that failed, a
// queue that never finished, a CDN that would not hand the bytes over) is money
// the family spent with nothing to show for it. Before this, the only fal number
// on the payload was `done` — a count of the files on disk — so a charged clip
// that never arrived was invisible everywhere in the product.
test("the clips fal was paid for are on the status payload, arrived or not", () => {
  falCard(true);
  const j = content.status().jobs.find(b => b.slug === "half-lucky");
  assert.equal(j.animate.done, 1, "one clip landed");
  assert.equal(j.animate.clips, 2, "two were charged for — the failed one billed too");
  assert.equal(j.animate.spent, 0.7, "two clips at 35 cents");
  // A book nobody has animated says zero rather than nothing at all.
  const q = content.status().jobs.find(b => b.slug === "quote-me");
  assert.equal(q.animate.clips, 0);
  assert.equal(q.animate.spent, 0);
});

test("a book that is still being built is not animated", async () => {
  const at = calls.length;
  falCard(true);
  book("Still Reading", ["one"], { state: "transcribing", publish: false });
  const out = content.runStep({ kind: "books", slug: "still-reading", step: "animate" });
  assert.equal(out.started, undefined);
  assert.ok(out.error && !/\d{3}/.test(out.error), "words, not a status code: " + out.error);
  await content.idle();
  assert.equal(spent(at), 0);
});

// --------------------------------------------------------------- no key on disk

test("no key the family typed ever reached a log line, a job or a manifest", async () => {
  for (const name of ["Moving Pictures", "Half Lucky", "Refused", "By Hand"]) {
    const dir = bookDir(name);
    assert.equal(logOf(name).includes(KEY), false, name + ": a key reached log.jsonl");
    assert.equal(JSON.stringify(store.readJob(dir)).includes(KEY), false, name + ": a key reached job.json");
    if (fs.existsSync(path.join(dir, "manifest.json")))
      assert.equal(JSON.stringify(manifestOf(name)).includes(KEY), false, name + ": a key reached the manifest");
  }
  // And it never travelled in a URL either — only ever in the Authorization
  // header, because a URL ends up in logs and this one is billable.
  for (const c of calls) assert.equal(c.url.includes(KEY), false, "a key travelled in a URL");
  assert.ok(calls.some(c => c.auth === "Key " + KEY), "…it did travel, in the header fal documents");
});
