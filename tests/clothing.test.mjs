// clothing.test.mjs — Ellie-system port contract (dad 8/29: "exactly like
// that"). With an AI key, photos are cataloged through one vision call each
// (faked here via ERA_AI_URL) into named, categorized, cropped item tiles,
// and the daily board comes out in her exact graph: today -> confirm_N with
// Yes / Change top / Change bottoms -> choose_bottom -> cat_* -> build.
// Without a key, plain photo tiles still appear (v1 fallback).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 8391-8415 are held by sibling suites. The port is a SEAM because 8416 is
// inside the range this repo's port rule tells a reviewer never to bind, and
// a sibling worktree's hub does sometimes hold it — without the seam the
// Phase-2 evidence for this suite could not be reproduced by anyone (r2).
const AI_PORT = Number(process.env.ERA_TEST_AI_PORT) || 8416;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-"));
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey, yesterdayOf } = require("./clothing-rank.js");
// ONE clock for the suite: every "today"/"yesterday" key here is derived over
// ZONE and the module is started with the same zone (plan T2.1/T2.4) — never
// an OS-zone toLocaleDateString, never now − n×86400e3 in a DST zone (I6).
//
// And ZONE is deliberately NEITHER of the two wrong answers a worker can give:
// not this box's own zone (Etc/UTC) and not the module's default
// (America/Los_Angeles). It used to be "UTC", which IS this box's zone, so a
// worker that ignored workerData.tz and read the OS clock dealt byte-identical
// seeds, byte-identical days keys and byte-identical boards — the plumbing
// T2.1 exists to add had no test at all (review r4). +14 and −12 are the two
// ends of the world's calendar dates; between 00:00 and ~07:00 UTC only two
// dates exist anywhere and the box and the module hold one each, so in those
// hours NO zone can differ from both and the second clause keeps the OS-clock
// half pinned. The module-default half is then not pinned here at all — it is
// tests/clothing-weather.test.mjs's "start() without a zone …" case that holds
// it, and no zone this picker could choose would do better (review r5).
const ZONE = (() => {
  const now = Date.now();
  const box = dayKey(now, "UTC"), mod = dayKey(now, "America/Los_Angeles");
  const ends = ["Pacific/Kiritimati", "Etc/GMT+12"];
  return ends.find(z => dayKey(now, z) !== box && dayKey(now, z) !== mod)
      || ends.find(z => dayKey(now, z) !== box) || ends[0];
})();
let ai, clothing;

// tiny solid-color JPEGs stand in for phone photos
function makeJpg(file, r, g, b) {
  const jpeg = require("./vendor/jpeg-js");
  const w = 320, h = 480;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, jpeg.encode({ data, width: w, height: h }, 85).data);
}

// A phone photo: top half red, bottom half blue, plus an EXIF Orientation
// tag that every viewer honours (3 = shown turned 180, so blue on top).
function makeTurnedJpg(file, orientation) {
  const jpeg = require("./vendor/jpeg-js");
  const w = 320, h = 480;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const top = Math.floor(i / w) < h / 2;
    data[i * 4] = top ? 230 : 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = top ? 20 : 230; data[i * 4 + 3] = 255;
  }
  const jpg = jpeg.encode({ data, width: w, height: h }, 90).data;
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write("II", 0, "latin1"); tiff.writeUInt16LE(0x2A, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                       // one IFD0 entry
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from("Exif\0\0", "latin1"), tiff]);
  app1.writeUInt16BE(app1.length - 2, 2);
  fs.writeFileSync(file, Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));
}

const ANSWERS = [
  { name: "Heart print tee", category: "top", warmth: "warm", rotate_deg: 90, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  { name: "Pink leggings", category: "pants", warmth: "any", rotate_deg: 0, crop: { x: 0, y: 0, w: 1, h: 1 } },
  { name: "Sunflower dress", category: "dress", warmth: "warm", rotate_deg: 0, crop: { x: 0.2, y: 0, w: 0.6, h: 1 } },
];
let calls = 0;
let forceAnswer = null;         // when set, every photo is described this way (label tests)
let flaky = 0;                  // >0 = answer this many calls with a 503 first
let hangups = 0;                // >0 = drop this many connections mid-request (a transport error)
let throttleModel = "";         // a model id that always answers 429
let throttleAfter = 0;          // ...but only once `calls` passes this (a quota that runs out mid-build)
const wire = [];   // {path, auth} per request — proves each provider's format
const wireErrors = [];   // wire-format complaints, RECORDED not thrown (see below)
const hits = [];   // every request path, 429s included
// Requests this fake accepted and then never ANSWERED. `spent()` — the counter
// every AI-spend pin below reads — is `calls` minus these: a connection the
// provider drops mid-flight is one the worker silently retries with the same
// picture (callModel), so the server counts two requests for one ask and the
// raw counter used to fail "already-cataloged photos are never re-sent" about
// one run in three (review r4). Discounting the DROPPED half absorbs exactly
// that retry and nothing else: a fresh ask is always answered, so it always
// counts — where de-duplicating PICTURES also swallowed a photo genuinely sent
// a second time, which is the very regression those pins are named for
// (review r5). `calls` stays raw for the pins that really are about request
// counts (the 503 and 429 ladders, and the drop case's own two requests).
let aborted = 0;
const spent = () => calls - aborted;
let lastProbe = ""; // base64 of the last picture a Google call was shown

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  // Every build reads the weather. Until the 9/5 window work there was no seam
  // for it, so this suite really did reach for the two public IP lookups on
  // each run; a dead loopback port keeps it local (and fast). The weather tile
  // itself is covered by tests/clothing-weather.test.mjs.
  process.env.ERA_GEO_URL = "http://127.0.0.1:1/geo";
  process.env.ERA_WEATHER_URL = "http://127.0.0.1:1";
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      // A body that never finished arriving is answered, never thrown on: this
      // handler lives in the before hook's async graph, where a throw becomes
      // an uncaughtException and fails the whole FILE after every case has
      // passed (r3).
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      calls++;
      hits.push(req.url);
      // A response that closes without finishing is a request the client never
      // got an answer to — the dropped half of a transport retry (below), or a
      // connection that went away on its own. Counted here, subtracted there.
      res.on("close", () => { if (!res.writableFinished) aborted++; });
      // A provider that accepts the request and then drops the connection: the
      // client sees a transport error, the server has already counted the
      // request, and callModel sends the very same picture again 3 s later.
      if (hangups > 0) { hangups--; req.destroy(); return; }
      if (throttleModel && req.url.includes(throttleModel) && calls > throttleAfter) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end('{"error":{"code":429,"message":"Resource exhausted"}}');
        return;
      }
      if (flaky > 0) {
        flaky--;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
        return;
      }
      // answer by PHOTO, not call index: retries and later tests must not
      // shift which garment the fake describes (test-order pollution, 9/1)
      const answer = forceAnswer || ANSWERS[wire.length % ANSWERS.length];
      const text = "Here you go:\n" + JSON.stringify(answer);
      let out;
      // A wire-format complaint is RECORDED, never thrown: this handler lives
      // in the before hook's async graph, where a throw is an uncaughtException
      // and a FILE-level failure with no case name on it — the same shape r3
      // removed from the JSON.parse above. The cases that care read wireErrors.
      if (req.url === "/v1/messages") {                       // anthropic
        if (parsed.messages[0].content[0].type !== "image")
          wireErrors.push("anthropic content[0] was " + parsed.messages[0].content[0].type);
        wire.push({ path: req.url, auth: req.headers["x-api-key"] });
        out = { content: [{ type: "text", text }] };
      } else if (req.url === "/v1/chat/completions") {        // openai
        if (parsed.messages[0].content[0].type !== "image_url")
          wireErrors.push("openai content[0] was " + parsed.messages[0].content[0].type);
        wire.push({ path: req.url, auth: req.headers["authorization"] });
        out = { choices: [{ message: { content: text } }] };
      } else if (req.url.startsWith("/v1beta/models/")) {     // google
        if (!(parsed.contents[0].parts[0].inline_data || {}).data)
          wireErrors.push("google parts[0] carried no inline_data");
        lastProbe = parsed.contents[0].parts[0].inline_data.data;
        wire.push({ path: req.url, auth: req.headers["x-goog-api-key"] });
        out = { candidates: [{ content: { parts: [{ text }] } }] };
      } else { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));

  fs.mkdirSync(path.join(TMP, "clothing"), { recursive: true });
  makeJpg(path.join(TMP, "clothing", "photo_a.jpg"), 220, 60, 90);
  makeJpg(path.join(TMP, "clothing", "photo_b.jpg"), 240, 170, 200);
  // one photo inside an album folder: families drop folders into Drive's
  // clothing/, and a folder must count exactly like loose files (QA 9/2)
  fs.mkdirSync(path.join(TMP, "clothing", "album"), { recursive: true });
  makeJpg(path.join(TMP, "clothing", "album", "photo_c.jpg"), 250, 210, 60);
  clothing = require("./clothing.js");
  // No schedule: this suite drives regenerate()/tick() itself. unref() only
  // stops a timer from holding the loop open — it still FIRES, and this file
  // runs ~500 s, so the 20 s startup tick and the 15-minute one really did
  // start builds nobody awaited (r3), exactly as clothing-weather.test.mjs
  // avoids. The zone is the suite's: the module otherwise defaults to LA and
  // this box is UTC (plan T2.1/T2.4).
  clothing.start(TMP, { noTimers: true, tz: () => ZONE });
});
after(() => { if (ai) ai.close(); delete process.env.ERA_AI_URL;
  delete process.env.ERA_GEO_URL; delete process.env.ERA_WEATHER_URL; });

// The fake above is created INSIDE the before hook, so every request it serves
// belongs to that hook's async graph: a body it could not parse threw there,
// and node:test turns a throw after the hook has ended into an uncaught
// exception and a FILE-level failure — 32 green cases and exit 1, which is
// exactly what the gate reads (seen twice at r3, once in ~500 s). A body can
// be empty or half-written whenever a client goes away mid-POST (the ingest
// posts a base64 JPEG under AbortSignal.timeout), so the fake answers 400.
test("the fake AI answers a body it cannot parse instead of throwing", async () => {
  const before = calls;
  const r = await fetch(`http://127.0.0.1:${AI_PORT}/v1/messages`,
    { method: "POST", body: "", signal: AbortSignal.timeout(5000) });   // a throw answers nothing at all
  assert.equal(r.status, 400, "an unparsable body gets an answer, not a throw");
  assert.equal(calls, before, "...and is not counted as a model call");
});

test("photos but no AI key: no board, a no-key guidance state (dad 8/31: coach, don't dump raw tiles)", async () => {
  const r = await clothing.regenerate(true);
  assert.equal(r.guidance, "no-key");
  assert.equal(r.photos, 3);
  assert.ok(!fs.existsSync(path.join(TMP, "recipes", "today.json")), "no recipe written");
  const s = clothing.status();
  assert.equal(s.photos, 3);
  assert.equal(s.aiConfigured, false);
  assert.equal(s.cataloged, 0);
});

test("a stale v1 plain recipe is cleared so the splash can coach", async () => {
  fs.mkdirSync(path.join(TMP, "recipes"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "recipes", "today.json"), JSON.stringify({
    home_label: "Clothing", root: "today",
    boards: [{ id: "today", buttons: [{ label: "This one" }] }] }));
  await clothing.regenerate(true);
  assert.ok(!fs.existsSync(path.join(TMP, "recipes", "today.json")), "plain recipe removed");
});

test("with a key: photos are cataloged and the board is her exact graph", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  const r = await clothing.regenerate(true);
  assert.equal(r.mode, "cataloged");
  assert.equal(calls, 3, "one vision call per photo");

  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const items = Object.values(cat.items);
  assert.equal(items.length, 3);
  assert.ok(cat.items["album/photo_c.jpg"] && cat.items["album/photo_c.jpg"].ok, "the album-folder photo was cataloged too");
  assert.deepEqual(items.map(i => i.category).sort(), ["dress", "pants", "top"]);
  for (const i of items)
    assert.ok(fs.existsSync(path.join(TMP, "wardrobe-items", i.id + ".jpg")), "item tile " + i.name);
  // the 90°-rotated crop really rotated: source portrait 320x480 -> upright work image stays sane
  const top = items.find(i => i.category === "top");
  assert.equal(top.name, "Heart print tee");

  const recipe = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const ids = recipe.boards.map(b => b.id);
  for (const must of ["today", "confirm_0", "build", "choose_bottom", "cat_top", "cat_pants", "cat_shorts", "cat_dress", "cat_outfit"])
    assert.ok(ids.includes(must), "board " + must);

  const todayB = recipe.boards.find(b => b.id === "today");
  const outfit = todayB.buttons.find(x => x.type === "outfit");
  assert.ok(outfit.load.startsWith("confirm_"));
  assert.ok(outfit.say_on_load, "outfit tiles speak on load, like hers");
  assert.ok(Array.isArray(outfit.combo) && outfit.combo.length >= 1, "combo ids for the decision log");
  assert.ok(fs.existsSync(path.join(TMP, "wardrobe-outfits", path.basename(outfit.image))), "composite image exists");
  assert.ok(todayB.buttons.some(x => x.label === "Build my own"), "Build my own on today");

  const confirm = recipe.boards.find(b => b.id === outfit.load);
  const labels = confirm.buttons.map(x => x.label);
  for (const must of ["Yes", "Change top", "Change bottoms", "Back"])
    assert.ok(labels.includes(must), "confirm has " + must);
  assert.equal(confirm.buttons.find(x => x.label === "Change bottoms").load, "choose_bottom");
  assert.equal(confirm.buttons.find(x => x.label === "Yes").type, "yes");

  const catTop = recipe.boards.find(b => b.id === "cat_top");
  const item = catTop.buttons.find(x => x.type === "clothing");
  assert.equal(item.label, "Heart print tee", "items carry their AI-given names");
  assert.ok(item.image.startsWith("wardrobe-items/"));

  // Outfits sit in stable slots; the two CENTER cells [2,2][2,3] are the
  // rest cells (lib contract restCells: "center"), More [3,1] and Build
  // [3,4] own the corners. Dad 9/3 (I-13 photo): the bottom-middle pair and
  // the middle-right cell hold outfits too when there are enough - seven a
  // page, overruling the 9/1 six-cap and bottom-row rest strip. The Yes
  // tile is a TD-Snap-style green CHECK, not a pictogram.
  const outfits = todayB.buttons.filter(x => x.type === "outfit");
  assert.ok(outfits.length <= 7, "max 7 outfit choices per page");
  for (const o of outfits) {
    assert.ok(o.row && o.col, "outfit tiles pinned to stable slots");
    assert.ok(!(o.row === 2 && (o.col === 2 || o.col === 3)), "center rest cells stay black");
    assert.ok(!(o.row === 3 && (o.col === 1 || o.col === 4)), "More and Build own the bottom corners");
  }
  const build = todayB.buttons.find(x => x.label === "Build my own");
  assert.equal(build.row + "," + build.col, "3,4", "Build my own pinned bottom-right");
  const yes = confirm.buttons.find(x => x.label === "Yes");
  assert.equal(yes.glyph, "✓", "Yes is the green check");
  assert.ok(!yes.symbol, "no pictogram on Yes");
});

test("morning rule: a board built yesterday is stale, one built after 5am today is fresh (dad 9/1)", async () => {
  const recipe = path.join(TMP, "recipes", "today.json");
  const isFresh = () => clothing.boardIsFresh(TMP);
  const setBuilt = (d) => fs.utimesSync(recipe, d, d);

  const now = new Date();
  const beforeCutoff = new Date(now); beforeCutoff.setHours(4, 30, 0, 0);
  const afterCutoff = new Date(now); afterCutoff.setHours(6, 30, 0, 0);
  const yesterday = new Date(now.getTime() - 24 * 3600e3);

  setBuilt(yesterday);
  assert.equal(isFresh(), false, "yesterday's board must be rebuilt");
  if (now.getHours() >= 7) {          // only meaningful once past the cutoff
    setBuilt(afterCutoff);
    assert.equal(isFresh(), true, "a board built this morning stands");
    setBuilt(beforeCutoff);
    assert.equal(isFresh(), false, "a 4:30am board is last night's");
  }
  setBuilt(now);
});

test("second regenerate makes no further AI calls (catalog is durable)", async () => {
  // ANSWERED requests, not raw ones: a transport-level retry is one ask the
  // provider dropped and one it answered, and only the answered one counts as
  // spend (review r4/r5 — the drop case below pins the difference). Zero
  // tolerance: any fresh ask about a photo already catalogued moves this.
  const before = spent();
  await clothing.regenerate(true);
  assert.equal(spent(), before, "already-cataloged photos are never re-sent");
  assert.ok(wire.slice(0, 3).every(w => w.path === "/v1/messages" && w.auth === "sk-test"),
    "anthropic calls used /v1/messages with x-api-key");
  assert.deepEqual(wireErrors, [], "every request so far carried the provider's own picture field");
});

test("preferred-LLM: an OpenAI key ingests new photos through their wire format", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "openai", apiKey: "sk-oa-test" }));
  makeJpg(path.join(TMP, "clothing", "photo_d.jpg"), 90, 90, 220);
  await clothing.regenerate(true);
  const w = wire[wire.length - 1];
  assert.equal(w.path, "/v1/chat/completions");
  assert.equal(w.auth, "Bearer sk-oa-test");
  assert.deepEqual(wireErrors, [], "the openai body carried an image_url part");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_d.jpg"].ok, "photo cataloged via OpenAI");
});

test("a transient provider 503 is retried, not fatal (Google free tier, live QA 9/1)", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-retry" }));
  makeJpg(path.join(TMP, "clothing", "photo_r.jpg"), 30, 140, 200);
  flaky = 2;                    // first two calls answer 503, third succeeds
  const before = calls;
  await clothing.regenerate(true);
  assert.ok(calls >= before + 3, "retried through the 503s");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_r.jpg"].ok, "photo cataloged despite the transient");
  assert.equal(flaky, 0);
});

test("a throttled model falls through to the next one (Google 429 on -latest, 9/1)", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-fallback" }));
  makeJpg(path.join(TMP, "clothing", "photo_f.jpg"), 10, 60, 200);
  throttleModel = "gemini-flash-latest";     // first choice answers 429 forever
  await clothing.regenerate(true);
  const paths = wire.filter(x => x.path.startsWith("/v1beta/models/")).map(x => x.path);
  assert.ok(paths.some(x => x.includes("gemini-3.5-flash")), "fell through to the next model");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_f.jpg"].ok, "photo cataloged by the fallback model");
  throttleModel = "";
});

test("a model whose daily allowance runs out mid-build is retired, the next model carries on (live 9/2: 7 of 20 photos, 12 abandoned)", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-quota" }));
  for (const n of ["photo_q1", "photo_q2", "photo_q3"]) makeJpg(path.join(TMP, "clothing", n + ".jpg"), 30, 90, 150);
  throttleModel = "gemini-flash-latest";
  throttleAfter = calls + 1;                 // answers the first photo, then 429 forever
  const before = hits.length;
  await clothing.regenerate(true);
  const mine = hits.slice(before);
  const latest = mine.filter(p => p.includes("gemini-flash-latest")).length;
  assert.equal(latest, 2, "one answer + one 429, then never asked again this build");
  assert.ok(mine.some(p => p.includes("gemini-3.5-flash:")), "the next model took over");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  for (const n of ["photo_q1", "photo_q2", "photo_q3"]) assert.ok(cat.items[n + ".jpg"].ok, n + " cataloged");
  throttleModel = ""; throttleAfter = 0;
});

test("preferred-LLM: a Google key ingests through generateContent with x-goog-api-key", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-test" }));
  makeJpg(path.join(TMP, "clothing", "photo_e.jpg"), 90, 220, 120);
  await clothing.regenerate(true);
  const w = wire.filter(x => x.path.startsWith("/v1beta/models/")).pop();
  assert.ok(w.path.startsWith("/v1beta/models/") && w.path.endsWith(":generateContent"), w.path);
  assert.equal(w.auth, "AIza-test", "key travels in the header, never the URL");
  assert.deepEqual(wireErrors, [], "the google body carried inline_data");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_e.jpg"].ok, "photo cataloged via Google");
});

// The garment cut-out ships as a real model (dad 9/1: "add the 50mb so trim is
// nice looking"). The payload must actually carry it, and the code must fall
// back rather than fail when a machine lacks the runtime.
test("the segmentation model and its runtime are present and loadable", async () => {
  const seg = require("./segment.js");
  assert.ok(fs.existsSync(seg.modelPath()), "u2netp.onnx ships beside the app");
  assert.ok(fs.statSync(seg.modelPath()).size > 3e6, "model file is whole");
  // a plain grey field has no salient object — the model must DECLINE rather
  // than hand back a blank tile
  const w = 200, h = 200, data = Buffer.alloc(w * h * 4, 128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const out = await seg.cutOut({ data, width: w, height: h });
  assert.ok(out === null || (out.kept > 0.02 && out.kept < 0.97), "no blank tiles");
});

// Dad 9/3: "some extra pieces in places that need to be cleaned up" — the
// model keeps every above-threshold speck (a bit of floor, a label, a
// shadow). Only the garment's main piece(s) survive: the largest blob plus
// anything at least 5% of it (a two-piece set), never the specks.
test("stray specks around the garment are dropped; a real second piece is kept", () => {
  const seg = require("./segment.js");
  const W = 40, H = 40;
  const grid = () => new Uint8Array(W * H);
  const fill = (b, x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) b[y * W + x] = 1; };
  const count = (b) => b.reduce((n, v) => n + v, 0);

  // a 20×20 shirt, three 1–2 px specks, and one 1×3 sliver touching nothing
  const b = grid();
  fill(b, 10, 10, 30, 30);
  fill(b, 2, 2, 3, 3); fill(b, 36, 5, 38, 6); fill(b, 5, 35, 6, 38); fill(b, 33, 33, 34, 34);
  assert.equal(seg.keepMainPieces(b, W, H), 1, "one piece: the shirt");
  assert.equal(count(b), 400, "every speck gone, the shirt intact");
  assert.equal(b[2 * W + 2], 0); assert.equal(b[35 * W + 5], 0);

  // shorts (largest) + a 6×6 belt = 9% of it: a legitimate second piece stays
  const c = grid();
  fill(c, 2, 2, 22, 22); fill(c, 30, 30, 36, 36); fill(c, 0, 39, 2, 40);
  assert.equal(seg.keepMainPieces(c, W, H), 2, "two pieces");
  assert.equal(count(c), 400 + 36, "belt kept, the 2 px sliver dropped");

  // diagonal touch is NOT a connection (4-neighbourhood): a corner speck goes
  const d = grid();
  fill(d, 10, 10, 20, 20); d[9 * W + 9] = 1;
  seg.keepMainPieces(d, W, H);
  assert.equal(d[9 * W + 9], 0);

  // an empty mask is a no-op, not a crash
  assert.equal(seg.keepMainPieces(grid(), W, H), 0);
});

// A picture can go missing while its catalogue entry survives — a half-restored
// backup, a tidied folder, or (QA 9/2) a wipe that lands while the worker is
// still holding the catalogue in memory. Before this, the item was skipped
// forever ("nothing to do") and EVERY outfit died on composite ENOENT, so the
// child got a black board. The rebuild must heal itself, and must not spend a
// single AI call doing it: the name and category are already known.
test("a missing tile is redrawn without asking the AI again", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-test" }));
  makeJpg(path.join(TMP, "clothing", "photo_f.jpg"), 40, 80, 200);
  await clothing.regenerate(true);

  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const entry = cat.items["photo_f.jpg"];
  assert.ok(entry && entry.ok, "photo cataloged first");
  const tile = path.join(TMP, "wardrobe-items", entry.id + ".jpg");
  assert.ok(fs.existsSync(tile), "tile written");

  fs.rmSync(tile);                       // the picture disappears
  const before = spent();
  await clothing.regenerate(true);

  assert.ok(fs.existsSync(tile), "the tile is redrawn on the next build");
  assert.equal(spent(), before, "no AI call was spent redrawing a known garment");
  const after = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(after.items["photo_f.jpg"].name, entry.name, "name survives the repair");
  assert.equal(after.items["photo_f.jpg"].category, entry.category, "category survives");
});

// Dad 9/2: "someone may want to delete clothes from the library that no
// longer fit … all that should just work by adding to the clothing directory".
// A photo that leaves the folder leaves the wardrobe: entry, tile, outfits.
test("a photo removed from clothing/ leaves the catalogue, its tile and the board", async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const entry = cat.items["photo_f.jpg"];
  const tile = path.join(TMP, "wardrobe-items", entry.id + ".jpg");
  assert.ok(fs.existsSync(tile), "starts on the board");

  fs.rmSync(path.join(TMP, "clothing", "photo_f.jpg"));   // it no longer fits
  const before = spent();
  await clothing.regenerate(true);

  const after = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(after.items["photo_f.jpg"], undefined, "catalogue entry pruned");
  assert.ok(!fs.existsSync(tile), "tile removed");
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  assert.ok(!JSON.stringify(rec.boards).includes(entry.id), "no outfit still wears it");
  assert.equal(spent(), before, "removing a garment costs no AI call");
  assert.ok(rec.boards.some(b => String(b.id).startsWith("confirm_")), "the board still builds");
});

// Dad 9/3, the i13 board: "some upside down images". Phones store the sensor's
// pixels and an EXIF Orientation tag; jpeg-js ignores the tag, so the model
// (and the tile) saw the garment on its head. The photo must be turned the
// way a viewer shows it BEFORE anything looks at it.
test("a phone photo with EXIF orientation is turned upright before the model sees it and before the tile is cut", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-test" }));
  makeTurnedJpg(path.join(TMP, "clothing", "photo_g.jpg"), 3);   // shot red-over-blue, viewers show blue-over-red
  lastProbe = "";
  await clothing.regenerate(true);
  assert.ok(lastProbe, "the model was asked about the new photo");
  const jpeg = require("./vendor/jpeg-js");
  const probe = jpeg.decode(Buffer.from(lastProbe, "base64"), { formatAsRGBA: true });
  const px = (x, y) => probe.data.subarray((y * probe.width + x) * 4, (y * probe.width + x) * 4 + 3);
  const top = px(probe.width >> 1, 4), bottom = px(probe.width >> 1, probe.height - 5);
  assert.ok(top[2] > 150 && top[0] < 100, "top of the probe is blue: the model saw it turned as a viewer would");
  assert.ok(bottom[0] > 150 && bottom[2] < 100, "bottom of the probe is red");

  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const entry = cat.items["photo_g.jpg"];
  assert.equal(entry.exif, 3, "the orientation the tile was drawn with is remembered");
  const tile = path.join(TMP, "wardrobe-items", entry.id + ".jpg");
  assert.ok(fs.existsSync(tile), "tile written");

  // A wardrobe catalogued before this fix (no `exif` field) gets its turned
  // photos redrawn — with no AI call, the name and category are known.
  delete entry.exif; entry.rotate_deg = 0;
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify(cat));
  const stamp = fs.statSync(tile).mtimeMs;
  const before = spent();
  await new Promise(r => setTimeout(r, 20));
  await clothing.regenerate(true);
  assert.equal(spent(), before, "the legacy redraw costs no AI call");
  const after = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(after.items["photo_g.jpg"].exif, 3, "legacy entry migrated");
  assert.ok(fs.statSync(tile).mtimeMs > stamp, "its tile was redrawn");
  fs.rmSync(path.join(TMP, "clothing", "photo_g.jpg"));   // leave the later tests their photo set
  await clothing.regenerate(true);
});

// A laid-flat "garment" for the pipeline: a red body (0.15..0.85 of the frame)
// with a BLUE waistband strip along one of its edges, on a grey floor. The
// waistband is what must end up on top; the strip is what an over-tight box
// would slice off. Phone-sized (a tile never upscales a small photo).
function makeGarmentJpg(file, waistbandSide) {
  const jpeg = require("./vendor/jpeg-js");
  const w = 1200, h = 1200;
  const data = Buffer.alloc(w * h * 4);
  const x0 = Math.round(w * 0.15), x1 = Math.round(w * 0.85), y0 = Math.round(h * 0.15), y1 = Math.round(h * 0.85);
  const band = Math.round(w * 0.08);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let rgb = [150, 150, 150];                                   // floor
    if (x >= x0 && x < x1 && y >= y0 && y < y1) {
      rgb = [220, 30, 30];                                       // body
      const onBand = waistbandSide === "right" ? x >= x1 - band : waistbandSide === "left" ? x < x0 + band :
                     waistbandSide === "bottom" ? y >= y1 - band : y < y0 + band;
      if (onBand) rgb = [30, 30, 220];                           // waistband
    }
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  }
  fs.writeFileSync(file, jpeg.encode({ data, width: w, height: h }, 90).data);
}
function readTile(TMP, id) {
  const jpeg = require("./vendor/jpeg-js");
  const t = jpeg.decode(fs.readFileSync(path.join(TMP, "wardrobe-items", id + ".jpg")), { formatAsRGBA: true });
  const px = (x, y) => t.data.subarray((y * t.width + x) * 4, (y * t.width + x) * 4 + 3);
  // the tile's drawn area, ignoring the white padSquare frame
  let top = t.height, bottom = -1;
  for (let y = 0; y < t.height; y++) { const p = px(t.width >> 1, y); if (p[0] < 200 || p[1] < 200 || p[2] < 200) { if (y < top) top = y; bottom = y; } }
  const isBlue = (p) => p[2] > 150 && p[0] < 110;
  const isRed = (p) => p[0] > 150 && p[2] < 110;
  return { t, px, top, bottom, isBlue, isRed };
}

// Dad 9/3, the i13 board: "Green shorts" (and the Floral bloomers) upside
// down — the waistband at the bottom. Both photos lay with the waistband on
// the RIGHT; the model answered "rotate 90 clockwise" where 270 was right.
// Asked instead WHERE the waistband is, it only has to look, and we turn.
test("a sideways photo is turned by where the model saw the garment's top, not by an angle it computed (dad 9/3, the upside-down shorts)", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-test" }));
  makeGarmentJpg(path.join(TMP, "clothing", "photo_side.jpg"), "right");
  forceAnswer = { name: "Green shorts", category: "shorts", warmth: "hot", top_side: "right",
    // ...and the same wrong angle the live model gave, which must now be ignored
    rotate_deg: 90, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
  try {
    await clothing.regenerate(true);
  } finally { forceAnswer = null; }
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const entry = cat.items["photo_side.jpg"];
  assert.ok(entry && entry.ok, "catalogued");
  assert.equal(entry.rotate_deg, 270, "waistband on the right = a 270 clockwise turn, remembered for tile repairs");
  const { px, top, bottom, isBlue, isRed, t } = readTile(TMP, entry.id);
  assert.ok(bottom > top, "something was drawn");
  assert.ok(isBlue(px(t.width >> 1, top + 6)), "the waistband is at the TOP of the tile");
  assert.ok(isRed(px(t.width >> 1, bottom - 6)), "the legs hang below it");

  // and the older answer shape still works for a model that ignores top_side
  makeGarmentJpg(path.join(TMP, "clothing", "photo_side2.jpg"), "left");
  forceAnswer = { name: "Blue shorts", category: "shorts", warmth: "hot", rotate_deg: 90, crop: {} };
  try { await clothing.regenerate(true); } finally { forceAnswer = null; }
  const e2 = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8")).items["photo_side2.jpg"];
  assert.equal(e2.rotate_deg, 90, "rotate_deg alone is still honoured");
  const r2 = readTile(TMP, e2.id);
  assert.ok(r2.isBlue(r2.px(r2.t.width >> 1, r2.top + 6)), "waistband on the left, turned 90: on top");
  for (const f of ["photo_side.jpg", "photo_side2.jpg"]) fs.rmSync(path.join(TMP, "clothing", f));
  await clothing.regenerate(true);
});

// Dad 9/3: the leopard top's sleeves were sliced off ("over trimmed shirt").
// The model's box, guessed off a 384px probe, was tighter than the garment
// and won over the cut-out because it was smaller. The cut-out IS the garment:
// its own bounding box is the crop; the model's box is at most a hint for
// the fallback path, and a malformed one is no box at all.
test("the model's box cannot cut into a garment the cut-out already found (dad 9/3, the over-trimmed top)", async () => {
  makeGarmentJpg(path.join(TMP, "clothing", "photo_tight.jpg"), "top");
  forceAnswer = { name: "Leopard top", category: "top", warmth: "warm", top_side: "top",
    crop: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } };            // well inside the garment
  try { await clothing.regenerate(true); } finally { forceAnswer = null; }
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const entry = cat.items["photo_tight.jpg"];
  const { px, top, bottom, isBlue, isRed, t } = readTile(TMP, entry.id);
  assert.ok(isBlue(px(t.width >> 1, top + 6)), "the waistband strip at the garment's edge survived the model's tight box");
  assert.ok(isRed(px(t.width >> 1, bottom - 6)), "so did the hem");
  // the garment fills the tile's drawn area: a tight-but-complete cut, not a slice
  assert.ok(bottom - top > t.height * 0.8, `garment spans the tile (${bottom - top} of ${t.height})`);

  // malformed boxes (the live catalogue had {"y":2.7}, {"box_2d":...}, no "h") are dropped, not applied
  makeGarmentJpg(path.join(TMP, "clothing", "photo_junk.jpg"), "top");
  forceAnswer = { name: "Odd top", category: "top", warmth: "warm", top_side: "top", crop: { x: 0.08, y: 2.7, w: 0.8 } };
  try { await clothing.regenerate(true); } finally { forceAnswer = null; }
  const junk = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8")).items["photo_junk.jpg"];
  assert.deepEqual(junk.crop, {}, "a malformed box is not remembered as geometry");
  const rj = readTile(TMP, junk.id);
  assert.ok(rj.isBlue(rj.px(rj.t.width >> 1, rj.top + 6)), "and the tile is whole");
  for (const f of ["photo_tight.jpg", "photo_junk.jpg"]) fs.rmSync(path.join(TMP, "clothing", f));
  await clothing.regenerate(true);
});

// The 15-minute tick only ACTS on a stale board — but a family that adds or
// removes photos at 3pm expects the board to follow that afternoon, not
// tomorrow morning. The tick therefore also acts when the photo set changed.
test("the tick rebuilds a fresh board when the photo set changes (add or remove)", async () => {
  await clothing.regenerate(true);
  assert.equal(clothing.boardIsFresh(TMP), true, "board is fresh");
  await clothing.tick("test");   // settle: earlier tests moved photos since the startup tick looked
  assert.equal(clothing.tick("test"), null, "fresh board, same photos: nothing to do");

  makeJpg(path.join(TMP, "clothing", "photo_g.jpg"), 90, 200, 90);   // a new dress arrives
  const p = clothing.tick("test");
  assert.ok(p, "a new photo makes the tick act even though the board is fresh");
  await p;
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_g.jpg"] && cat.items["photo_g.jpg"].ok, "the new photo was catalogued");
  assert.equal(clothing.tick("test"), null, "settled again");

  fs.rmSync(path.join(TMP, "clothing", "photo_g.jpg"));
  const q = clothing.tick("test");
  assert.ok(q, "a removed photo makes the tick act too");
  await q;
  const cat2 = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(cat2.items["photo_g.jpg"], undefined, "and it is gone from the wardrobe");
});

test("a photo the day's allowance left behind waits for tomorrow; one a transient left behind is retried the same day (QA 9/2)", async () => {
  clothing._testReset();
  await clothing.regenerate(true);
  await clothing.tick("test");   // settle the photo-set memory
  assert.equal(clothing.tick("test"), null, "settled");

  // 1. quota: every Google model answers 429 -> the photo is left, the day is held
  makeJpg(path.join(TMP, "clothing", "photo_h.jpg"), 60, 120, 240);
  throttleModel = "gemini";
  const r = await clothing.tick("test");
  assert.equal(r.left, 1); assert.equal(r.quotaHit, true);
  throttleModel = "";
  clothing._testReset({ keepHold: true });
  assert.equal(clothing.tick("test"), null, "allowance spent today: no same-day retry");
  let cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(!(cat.items["photo_h.jpg"] && cat.items["photo_h.jpg"].ok), "still waiting");

  // 2. transient: a new day (reset); a 503 storm hits the first photo of a
  //    build -> it is left, the other lands, and the leftover is retried within the hour
  clothing._testReset();
  makeJpg(path.join(TMP, "clothing", "photo_i.jpg"), 200, 60, 120);
  flaky = 8;   // 4 models x 2 attempts: the build gives up on photo_h, but not for the day
  const r1 = await clothing.tick("test");   // acts: the photo set changed
  assert.equal(flaky, 0);
  assert.deepEqual([r1.landed, r1.left, r1.quotaHit], [1, 1, false]);
  const p = clothing.tick("test");
  assert.ok(p, "photos still waiting -> the tick retries even though the board is fresh");
  const r2 = await p;
  assert.equal(r2.left, 0);
  cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_h.jpg"].ok && cat.items["photo_i.jpg"].ok, "both landed");
  assert.equal(clothing.tick("test"), null, "nothing waiting: quiet again");

  // 3. a retry that lands nothing holds the day: a photo the AI cannot name
  //    gets two builds a day, not a request every hour
  clothing._testReset();
  makeJpg(path.join(TMP, "clothing", "photo_j.jpg"), 120, 200, 60);
  flaky = 8;
  await clothing.tick("test");              // change build: photo_j left
  flaky = 8;
  const r3 = await clothing.tick("test");   // the retry: left again
  assert.equal(r3.left, 1);
  clothing._testReset({ keepHold: true });  // the hour is up; the day's hold is what stops it
  assert.equal(clothing.tick("test"), null, "failed twice: waits for tomorrow");
  fs.rmSync(path.join(TMP, "clothing", "photo_j.jpg"));
  await clothing.tick("test");              // removing it is still a change build
  assert.equal(clothing.tick("test"), null);
});

// A photo removed while the hub was DOWN (I23): the first tick after boot had
// nothing to compare against (the memory started empty), the board was fresh
// by the clock, so the removal waited for tomorrow's 5am. The worker now
// stores what it saw beside .clothing-sig and start() reads it back — a hub
// that reboots is as observant as one that stayed awake. A fresh copy of the
// module stands in for the reboot; the shared one keeps its own memory.
test("start() seeds the photo memory from the last build: a removal while the hub was down is seen by the first tick", async () => {
  makeJpg(path.join(TMP, "clothing", "photo_k.jpg"), 60, 200, 200);
  await clothing.regenerate(true);   // the build stores its photo set
  let cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_k.jpg"] && cat.items["photo_k.jpg"].ok, "the photo was catalogued by that build");
  const modPath = require.resolve("./clothing.js");
  delete require.cache[modPath];
  const booted = require("./clothing.js");
  delete require.cache[modPath];      // the suite's copy stays the one `clothing` points at
  // the suite's own clock: a fresh copy started without one would deal and
  // record under the module's LA default, leaving a second `days` key in the
  // suite's history.json — inside 00:00-07:00 UTC that key is the suite's
  // OWN yesterday, and every later build would read it as the yesterday bar
  // (review r2). This case is about the photo memory, not the zone.
  booted.start(TMP, { noTimers: true, tz: () => ZONE });
  fs.rmSync(path.join(TMP, "clothing", "photo_k.jpg"));
  const p = booted.tick("test");
  assert.ok(p, "the removal was noticed on the very first tick after boot");
  await p;
  cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(cat.items["photo_k.jpg"], undefined, "and the garment left the wardrobe");
  assert.equal(booted.tick("test"), null, "settled");
});

// The worker is spawned with the Drive folder already resolved by the shell
// (plan W10): drive.js is a main-thread module with its own state, and a
// second copy in a worker would read the config behind the main one's back.
test("the worker never loads drive.js", () => {
  const src = fs.readFileSync(path.join(HUB, "clothing-worker.js"), "utf8");
  assert.ok(!/require\(["']\.\/drive(\.js)?["']\)/.test(src), "no require of drive.js in the worker");
  assert.ok(!/drive\.start\(/.test(src), "no drive.start() in the worker");
});

// Until the repair runs, one absent picture must not empty the board.
test("an item with no tile is left off the board, not fatal to it", async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  cat.items["ghost.jpg"] = { id: "item_ghost", ok: true, name: "Ghost tee",
    category: "top", warmth: "any" };
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify(cat));
  await clothing.regenerate(true);
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const labels = JSON.stringify(rec.boards);
  assert.ok(!labels.includes("Ghost tee"), "the item with no picture is skipped");
  assert.ok(rec.boards.some(b => String(b.id).startsWith("confirm_")), "the board still builds");
});

// Each half of a combo was shortened on its own, so two long halves made a
// 30-character plate that wrapped to a third line and got CLIPPED by the tile
// (QA 9/2: "Ribbed camisole + Green shorts" lost "Green shorts" off the
// bottom). Dad's standing rule is that a label is never cut mid-word.
test("a combo label is budgeted as a whole, so it never clips", async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  // reuse a real tile so the pair can actually be composited
  const tileId = Object.values(cat.items).find(i => i.ok &&
    fs.existsSync(path.join(TMP, "wardrobe-items", i.id + ".jpg"))).id;
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items: {
    "long_top.jpg":    { id: tileId, ok: true, name: "Ribbed camisole", category: "top",    warmth: "any" },
    "long_bottom.jpg": { id: tileId, ok: true, name: "Green shorts",    category: "shorts", warmth: "any" },
  }}));
  for (const f of ["long_top.jpg", "long_bottom.jpg"])   // the photos must exist or the entries are pruned
    fs.copyFileSync(path.join(TMP, "clothing", "photo_a.jpg"), path.join(TMP, "clothing", f));
  await clothing.regenerate(true);

  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const combos = [];
  for (const b of rec.boards) for (const btn of b.buttons || [])
    if (btn.type === "outfit") combos.push(btn.label);
  assert.ok(combos.length, "the pair produced an outfit");
  for (const label of combos)
    assert.ok(label.length <= 28, `outfit plate too long to fit: "${label}" (${label.length})`);
  // the garment nouns survive — they are what tell two outfits apart — and the
  // bottom keeps the colour that distinguishes one pair of shorts from another
  assert.ok(combos.some(l => /green shorts/i.test(l)),
    `the bottom kept its colour, got ${JSON.stringify(combos)}`);
});

// ...and the second cut, from the tile into the outfit picture, was the one
// that actually took the leopard top's sleeves: the tile was whole, but the
// composite's trim asked for a solid 2% of a column to differ from white, and
// a pale cuff with its thin tie is not that. On a tile the background IS
// white — anything off-white is garment, however thin.
test("a thin sleeve tie on a tile survives into the outfit picture (dad 9/3, the over-trimmed top)", async () => {
  const jpeg = require("./vendor/jpeg-js");
  const dim = 640, data = Buffer.alloc(dim * dim * 4, 255);
  const set = (x, y, r, g, b) => { const o = (y * dim + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; };
  for (let y = 200; y < 440; y++) for (let x = 200; x < 440; x++) set(x, y, 220, 30, 30);   // body
  for (let y = 318; y < 322; y++) for (let x = 60; x < 200; x++) set(x, y, 30, 30, 220);    // a 4px tie to the left
  fs.mkdirSync(path.join(TMP, "wardrobe-items"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "wardrobe-items", "item_tie.jpg"), jpeg.encode({ data, width: dim, height: dim }, 85).data);
  const saved = fs.readFileSync(path.join(TMP, "wardrobe.json"));
  const bottomId = Object.values(JSON.parse(saved.toString("utf8")).items)
    .find(i => i.ok && fs.existsSync(path.join(TMP, "wardrobe-items", i.id + ".jpg"))).id;
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items: {
    "tie_top.jpg":    { id: "item_tie", ok: true, name: "Tie top", category: "top",   warmth: "any" },
    "tie_bottom.jpg": { id: bottomId,   ok: true, name: "Pants",   category: "pants", warmth: "any" },
  }}));
  // A wardrobe of exactly these two: the other photos step aside (else they
  // are re-ingested and the day's 21 outfits may not include this pair).
  const aside = path.join(TMP, "clothing-aside");
  fs.renameSync(path.join(TMP, "clothing"), aside);
  fs.mkdirSync(path.join(TMP, "clothing"));
  for (const f of ["tie_top.jpg", "tie_bottom.jpg"])
    fs.copyFileSync(path.join(aside, "photo_a.jpg"), path.join(TMP, "clothing", f));
  await clothing.regenerate(true);

  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const outfit = rec.boards.flatMap(b => b.buttons || []).find(b => b.type === "outfit" && /tie top/i.test(b.label));
  assert.ok(outfit, "the pair produced an outfit");
  const c = jpeg.decode(fs.readFileSync(path.join(TMP, "wardrobe-outfits", path.basename(outfit.image))), { formatAsRGBA: true });
  // the top sits in the LEFT half (420 wide); find the leftmost drawn column there
  let firstX = -1, blueSeen = false;
  for (let x = 0; x < 420 && firstX < 0; x++)
    for (let y = 0; y < c.height; y++) {
      const o = (y * c.width + x) * 4;
      if (c.data[o] < 200 || c.data[o + 1] < 200 || c.data[o + 2] < 200) { firstX = x; blueSeen = c.data[o + 2] > 150 && c.data[o] < 110; break; }
    }
  assert.ok(firstX >= 0, "the top was drawn");
  assert.ok(blueSeen, `the garment's leftmost pixels are the tie, not the body — the tie was cut off (first drawn column ${firstX})`);
  fs.rmSync(path.join(TMP, "clothing"), { recursive: true, force: true });
  fs.renameSync(aside, path.join(TMP, "clothing"));
  fs.rmSync(path.join(TMP, "wardrobe-items", "item_tie.jpg"), { force: true });
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), saved);
  await clothing.regenerate(true);
});



// Bugs 10 + 11 (QA 9/1): a long AI name clipped mid-word on the plate, and a
// tile could start lowercase ("graphic tee + ..."). The name is squeezed in
// the MIDDLE (colour first, garment last — what a parent would have written)
// and every tile starts with a capital, single garment or combo.
test("a long or lowercase AI name lands as a short, capitalised label (bugs 10, 11)", async () => {
  forceAnswer = { name: "light wash denim shorts", category: "shorts", warmth: "hot",
    rotate_deg: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
  try {
    makeJpg(path.join(TMP, "clothing", "photo_long.jpg"), 120, 160, 210);
    await clothing.regenerate(true);
  } finally { forceAnswer = null; }
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const it = cat.items["photo_long.jpg"];
  assert.ok(it && it.ok, "the photo was catalogued");
  assert.equal(it.name, "Light denim shorts", "middle squeezed, colour and garment kept, capitalised");
  assert.ok(it.name.length <= 22, "fits the plate");

  // a combo of two lowercase halves is sentence-cased on both sides (the
  // names are edited in place — a rewritten catalogue would re-ingest every
  // photo through the model, ~2 min)
  const top = Object.values(cat.items).find(i => i.ok && i.category === "top");
  top.name = "graphic tee"; it.name = "green shorts";
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify(cat));
  await clothing.regenerate(true);
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const combos = [];
  for (const b of rec.boards) for (const btn of b.buttons || [])
    if (btn.type === "outfit") combos.push(btn.label);
  assert.ok(combos.some(l => l.startsWith("Graphic tee + ")), `top half cased, got ${JSON.stringify(combos)}`);
  assert.ok(combos.some(l => l.endsWith(" + Green shorts")), `bottom half cased, got ${JSON.stringify(combos)}`);
  for (const l of combos) assert.doesNotMatch(l, /(^| \+ )[a-z]/, "no tile half starts lowercase: " + l);
  for (const l of combos) assert.match(l, /^[A-Z]/, "no tile starts lowercase: " + l);
});

// Bug 22 (dad 9/1: "the shorts image are pants"): both tiles of "Pants or
// shorts?" wore the same jeans pictogram. Shorts is pinned to ARASAAC 13638.
test("the Shorts tile does not wear the Pants pictogram (bug 22)", () => {
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const b = rec.boards.find(x => x.id === "choose_bottom");
  assert.ok(b, "choose_bottom board exists");
  const sym = label => b.buttons.find(x => x.label === label).symbol;
  assert.equal(sym("Shorts"), "13638");
  assert.notEqual(sym("Shorts"), sym("Pants"));
});

// The gate reads this file's exit code, and it went red about one run in three
// on "already-cataloged photos are never re-sent" — `5 !== 3`, on a build whose
// ingest logged nothing at all (review r4). The one production path that makes
// the server count a request the worker never reports is callModel's
// transport-level retry: a connection the provider accepts and then drops is a
// second request for the SAME picture, and no console line said so. Here that
// path is driven on purpose, so the difference between "two requests reached
// the server" and "one of them was answered" is a pinned property rather than
// an unattributable flake — and the retry now says its name in the log
// (clothing-worker.js).
//
// LAST case before the favourites block, which prunes clothing/ to its own
// wardrobe: this one leaves a photo behind and would otherwise shift which
// answer the fake gives the photos after it.
test("a connection the provider drops is retried with the same picture — one photo, two requests", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  forceAnswer = { name: "Sunny tee", category: "top", warmth: "any",
    rotate_deg: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
  makeJpg(path.join(TMP, "clothing", "photo_drop.jpg"), 175, 45, 135);
  const beforeCalls = calls, beforeSpent = spent();
  hangups = 1;
  try { await clothing.regenerate(true); } finally { forceAnswer = null; hangups = 0; }

  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_drop.jpg"] && cat.items["photo_drop.jpg"].ok,
    "the photo was catalogued through the retry");
  assert.equal(calls - beforeCalls, 2,
    "the server counted the request twice: one dropped, one answered");
  assert.equal(spent() - beforeSpent, 1,
    "...but only ONE of them was answered — which is what an AI-spend pin must count");
  assert.deepEqual(wireErrors, [], "both requests were well-formed vision requests");
});

// ---- her favourites (audit 9/2; ported generator 9/5) ----
// The board has always reported her gazes and Yeses to the hub
// (wardrobe/history.json), but the product's generator never read them: a
// Yes changed nothing about tomorrow. Dad's plan (outfit_set.py, 8/5): a Yes
// is a confirmed wear, a day without one credits the last select at half
// weight, and the most-worn looks lead page 1 in two staple slots — variety
// by prioritisation, never exclusion. Since 9/5 the deal IS the original's
// (clothing-rank.js): page 1 is garment-distinct and seeded by the family's
// day, so this block's wardrobe is EIGHT tops by seven bottoms — seven
// distinct looks on page 1, 21 a day, and always one garment spare so page 1
// can sit out yesterday's look without the tiny-pool relaxation (a 7×7 with
// one look demoted leaves exactly that pair for the seventh slot). It is also
// hermetic: every other photo leaves clothing/ first, so no re-ingest can add
// a garment the fake AI happens to name. Ids stay loose (item_top1): only
// /outfit-event validates the hex shape (I10).
//
// THIS BLOCK MUST STAY LAST in the file: eightBySeven() prunes clothing/ of
// every photo that is not one of its own — the album/ subfolder an earlier
// case walks included — so a case appended after it would lose garments it
// never mentions (review r1).
//
// One day key for the whole block, read once WHEN THE BLOCK STARTS — on first
// use, not at file load: the cases below span ~90 s and a midnight roll
// partway through would flip half of them, but a top-level const is evaluated
// ~500 s earlier (node:test loads the file before test 1), which widened that
// window to the whole suite instead of closing it (review r2). Memoized rather
// than assigned by the first case: a single-case run (--test-name-pattern, the
// shape the red evidence for this block is captured with) otherwise walked
// back from undefined and died in the fixture instead of on the assertion (r3).
// n days ago is walked back with the rank's own calendar (never now −
// n×86400e3: a DST day is 23 or 25 hours long, I6).
let _today;
const todayKey = () => (_today ??= dayKey(Date.now(), ZONE));
const dayAgo = n => { let k = todayKey(); for (let i = 0; i < n; i++) k = yesterdayOf(k); return k; };
const TOPS = ["Sunny tee", "Cloud tee", "Pond tee", "Maple tee", "Berry tee", "Fern tee", "Dune tee", "Coral tee"];
const BOTTOMS = ["Sky leggings", "Moss jeans", "Sand pants", "Ruby leggings", "Lake jeans", "Cocoa pants", "Mint leggings"];
function eightBySeven() {
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const src = path.join(TMP, "wardrobe-items", Object.values(cat.items).find(i => i.ok).id + ".jpg");
  const items = {};
  const mk = (id, name, category) => {
    fs.copyFileSync(src, path.join(TMP, "wardrobe-items", id + ".jpg"));
    fs.copyFileSync(src, path.join(TMP, "clothing", id + ".jpg"));   // a photo that has left the folder is pruned
    items[id + ".jpg"] = { id, ok: true, name, category, warmth: "any" };
  };
  TOPS.forEach((n, i) => mk("item_top" + (i + 1), n, "top"));
  BOTTOMS.forEach((n, i) => mk("item_pants" + (i + 1), n, "pants"));
  for (const e of fs.readdirSync(path.join(TMP, "clothing")))
    if (!e.startsWith("item_")) fs.rmSync(path.join(TMP, "clothing", e), { recursive: true, force: true });
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items }));
}
const boardsOf = () => JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8")).boards;
const byLoad = (a, b) => Number(a.load.slice("confirm_".length)) - Number(b.load.slice("confirm_".length));
const outfitsOf = board => board.buttons.filter(x => x.type === "outfit").sort(byLoad).map(x => x.combo.join("+"));
const firstCombos = () => outfitsOf(boardsOf().find(b => b.id === "today"));
// every outfit of every today page (today, today_2, today_3), board order then
// slot order — the 21-for-21 comparator for "a same-day rebuild changes nothing"
const allCombos = () => boardsOf().filter(b => /^today(_\d)?$/.test(b.id)).flatMap(outfitsOf);
// history.json is {days, events} (spec §3.3): days = the page-1 lineups the
// build recorded, events = the board's picks.
const writePicks = (events, days = {}) =>
  (fs.mkdirSync(path.join(TMP, "wardrobe"), { recursive: true }),
   fs.writeFileSync(path.join(TMP, "wardrobe", "history.json"), JSON.stringify({ days, events })));

test("with no picks yet, today is pure rotation (nothing seated)", async () => {
  eightBySeven();
  todayKey();   // the block's clock, read as the block starts
  fs.rmSync(path.join(TMP, "wardrobe", "history.json"), { force: true });
  await clothing.regenerate(true);
  const first = firstCombos();
  assert.equal(first.length, 7, "page 1 is full: seven outfit slots (dad 9/3), the wardrobe has more");
  // eight tops, seven bottoms → page 1 repeats no garment (spec §1 V3)
  const tops = first.map(k => k.split("+")[0]), bottoms = first.map(k => k.split("+")[1]);
  assert.equal(new Set(tops).size, 7, "no top repeats on page 1");
  assert.equal(new Set(bottoms).size, 7, "no bottom repeats on page 1");
  assert.equal(allCombos().length, 21, "21 a day across today, today_2, today_3");
  // the worker's private least-recently-shown file is retired: memory is
  // wardrobe/history.json alone (plan T2.3)
  assert.ok(!fs.existsSync(path.join(TMP, "clothing-history.json")), "no clothing-history.json after a build");
});

// spec §3.5: a rebuild on the same day — a weather re-sort, a sync, a restart —
// deals the SAME 21 in the same order. The seed is the family's day and the
// memory ignores today's own entries; nothing random is left in the worker.
test("a same-day rebuild deals the same 21 in the same order", async () => {
  const first = allCombos();
  assert.equal(first.length, 21);
  await clothing.regenerate(true);
  assert.deepEqual(allCombos(), first, "21-for-21 identical across today, today_2, today_3");
});

// ONE writer for history.json (spec §3.3 as amended A4-1): the worker deals
// and POSTS the page-1 lineup; the shell records it beside the board's own
// events, and POST /outfit-event goes through the same door — both on the main
// thread, so a read-modify-write never races. Weather is offline in this
// suite, so the day's band is null.
test("the build records today's page 1 in history.json and leaves the day's events alone", async () => {
  const today = todayKey();
  const seeded = [{ kind: "yes", combo: ["item_top2", "item_pants1"], at: new Date().toISOString() }];
  writePicks({ [today]: seeded });
  await clothing.regenerate(true);
  const h = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe", "history.json"), "utf8"));
  assert.deepEqual(h.events[today], seeded, "today's events are untouched by the build");
  assert.equal(h.days[today].page1.length, 7, "page 1 as dealt: seven outfits");
  assert.equal(h.days[today].band, null, "weather offline: no band");
  assert.deepEqual(h.days[today].page1, firstCombos().map(k => k.split("+")), "the same seven the board shows, in order");
  assert.ok(!fs.existsSync(path.join(TMP, "wardrobe", "history.tmp")), "the atomic write left no tmp file behind");
});

// dad's 8/5 ruling (outfit_set.py:483-492, :538-556): a look that sat on page 1
// yesterday sits out page 1 today — even her Yes — and opens page 2 instead,
// so the board never shows the same first page two mornings running. A Yes
// today waits for tomorrow (today's own entries are ignored by the deal).
test("a Yes yesterday on yesterday's page 1 sits out page 1 today and opens page 2 — a Yes today waits for tomorrow", async () => {
  const yesterday = dayAgo(1), today = dayAgo(0);
  const days = { [yesterday]: { band: null, page1: [["item_top3", "item_pants2"]] } };
  const yEvents = [{ kind: "select", combo: ["item_top1", "item_pants1"] },
                   { kind: "yes",    combo: ["item_top3", "item_pants2"] }];
  writePicks({ [yesterday]: yEvents, [today]: [{ kind: "yes", combo: ["item_top2", "item_pants1"] }] }, days);
  await clothing.regenerate(true);
  const all = allCombos();
  assert.equal(all.length, 21);
  assert.ok(!firstCombos().includes("item_top3+item_pants2"), "yesterday's page-1 look is not on page 1 again");
  assert.equal(all[7], "item_top3+item_pants2", "…it opens today_2 instead (her Yes leads the demoted looks)");
  // today's Yes changes nothing about today: the same day without it deals
  // the very same 21 (and a same-day rebuild never shuffles — LRU would have)
  writePicks({ [yesterday]: yEvents }, days);
  await clothing.regenerate(true);
  assert.deepEqual(allCombos(), all, "a Yes today waits for tomorrow; same day, same deal");
});

// The Yes counts whether or not the look was dealt: a look she said Yes to
// from page 2 (not on yesterday's page 1) is a staple and leads page 1.
test("a Yes yesterday on a look that was not on yesterday's page 1 leads page 1 today as a staple", async () => {
  const yesterday = dayAgo(1);
  writePicks({
    [yesterday]: [{ kind: "yes", combo: ["item_top3", "item_pants2"] }],
  }, {
    [yesterday]: { band: null, page1: [] },
  });
  await clothing.regenerate(true);
  assert.equal(firstCombos()[0], "item_top3+item_pants2", "her Yes leads the board");
  assert.equal(allCombos().length, 21);
});

test("a day with no Yes credits her last-selected outfit at half weight; only the top looks are seated", async () => {
  writePicks({
    [dayAgo(3)]: [{ kind: "yes", combo: ["item_top3", "item_pants2"] }],
    [dayAgo(2)]: [{ kind: "yes", combo: ["item_top3", "item_pants2"] }],
    [dayAgo(1)]: [{ kind: "select", combo: ["item_top2", "item_pants2"] },
                  { kind: "select", combo: ["item_top1", "item_pants1"] }],   // last look of the day
  }, {
    [dayAgo(1)]: { band: null, page1: [] },   // nothing sat on page 1 yesterday: nothing is demoted
  });
  await clothing.regenerate(true);
  const seated = firstCombos().slice(0, 2);
  assert.ok(seated.includes("item_top3+item_pants2"), "twice-worn look is seated");
  assert.ok(seated.includes("item_top1+item_pants1"), "the inferred wear is seated at half weight");
  assert.ok(!seated.includes("item_top2+item_pants2"), "an earlier gaze that day is not a wear");
  assert.equal(firstCombos().length, 7, "the rest of page 1 is still fresh rotation");
});
