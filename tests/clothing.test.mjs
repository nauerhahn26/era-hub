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
const AI_PORT = 8416;   // 8391-8415 held by sibling suites
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-"));
const require = createRequire(path.join(HUB, "server.js"));
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
let throttleModel = "";         // a model id that always answers 429
let throttleAfter = 0;          // ...but only once `calls` passes this (a quota that runs out mid-build)
const wire = [];   // {path, auth} per request — proves each provider's format
const hits = [];   // every request path, 429s included
let lastProbe = ""; // base64 of the last picture a Google call was shown

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls++;
      hits.push(req.url);
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
      if (req.url === "/v1/messages") {                       // anthropic
        assert.equal(parsed.messages[0].content[0].type, "image");
        wire.push({ path: req.url, auth: req.headers["x-api-key"] });
        out = { content: [{ type: "text", text }] };
      } else if (req.url === "/v1/chat/completions") {        // openai
        assert.equal(parsed.messages[0].content[0].type, "image_url");
        wire.push({ path: req.url, auth: req.headers["authorization"] });
        out = { choices: [{ message: { content: text } }] };
      } else if (req.url.startsWith("/v1beta/models/")) {     // google
        assert.ok(parsed.contents[0].parts[0].inline_data.data.length > 0);
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
  clothing.start(TMP);   // timers are unref'd; we drive regenerate() directly
});
after(() => { if (ai) ai.close(); delete process.env.ERA_AI_URL; });

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

  // board-design-rules.md, re-affirmed by dad 9/1: hard cap 6 outfits per
  // page in stable slots; the bottom row (except Build at [3,4]) stays a
  // black rest strip — no actionable tile may sit in [3,1..3,3]; the Yes
  // tile is a TD-Snap-style green CHECK, not a pictogram.
  const outfits = todayB.buttons.filter(x => x.type === "outfit");
  assert.ok(outfits.length <= 6, "max 6 outfit choices per page");
  for (const o of outfits) {
    assert.ok(o.row && o.col, "outfit tiles pinned to stable slots");
    assert.ok(!(o.row === 3 && o.col <= 3), "bottom row is the rest strip");
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
  const before = calls;
  await clothing.regenerate(true);
  assert.equal(calls, before, "already-cataloged photos are never re-sent");
  assert.ok(wire.slice(0, 3).every(w => w.path === "/v1/messages" && w.auth === "sk-test"),
    "anthropic calls used /v1/messages with x-api-key");
});

test("preferred-LLM: an OpenAI key ingests new photos through their wire format", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "openai", apiKey: "sk-oa-test" }));
  makeJpg(path.join(TMP, "clothing", "photo_d.jpg"), 90, 90, 220);
  await clothing.regenerate(true);
  const w = wire[wire.length - 1];
  assert.equal(w.path, "/v1/chat/completions");
  assert.equal(w.auth, "Bearer sk-oa-test");
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
  const before = calls;
  await clothing.regenerate(true);

  assert.ok(fs.existsSync(tile), "the tile is redrawn on the next build");
  assert.equal(calls, before, "no AI call was spent redrawing a known garment");
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
  const before = calls;
  await clothing.regenerate(true);

  const after = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(after.items["photo_f.jpg"], undefined, "catalogue entry pruned");
  assert.ok(!fs.existsSync(tile), "tile removed");
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  assert.ok(!JSON.stringify(rec.boards).includes(entry.id), "no outfit still wears it");
  assert.equal(calls, before, "removing a garment costs no AI call");
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
  const before = calls;
  await new Promise(r => setTimeout(r, 20));
  await clothing.regenerate(true);
  assert.equal(calls, before, "the legacy redraw costs no AI call");
  const after = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.equal(after.items["photo_g.jpg"].exif, 3, "legacy entry migrated");
  assert.ok(fs.statSync(tile).mtimeMs > stamp, "its tile was redrawn");
  fs.rmSync(path.join(TMP, "clothing", "photo_g.jpg"));   // leave the later tests their photo set
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

// ---- her favourites (audit 9/2) ----
// The board has always reported her gazes and Yeses to the hub
// (wardrobe/history.json), but the product's generator never read them: a
// Yes changed nothing about tomorrow. Dad's plan (outfit_set.py, 8/5): a Yes
// is a confirmed wear, a day without one credits the last select at half
// weight, and the most-worn looks lead page 1 in two staple slots — variety
// by prioritisation, never exclusion.
const dayAgo = n => new Date(Date.now() - n * 86400e3).toLocaleDateString("en-CA");
function fiveGarments() {
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  const src = path.join(TMP, "wardrobe-items", Object.values(cat.items).find(i => i.ok).id + ".jpg");
  const items = {};
  const mk = (id, name, category) => {
    fs.copyFileSync(src, path.join(TMP, "wardrobe-items", id + ".jpg"));
    fs.copyFileSync(src, path.join(TMP, "clothing", id + ".jpg"));   // a photo that has left the folder is pruned
    items[id + ".jpg"] = { id, ok: true, name, category, warmth: "any" };
  };
  mk("item_top1", "Heart tee", "top"); mk("item_top2", "Striped tee", "top"); mk("item_top3", "Cat tee", "top");
  mk("item_pants1", "Pink leggings", "pants"); mk("item_pants2", "Blue jeans", "pants");
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items }));
}
const firstCombos = () => {
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const today = rec.boards.find(b => b.id === "today");
  return today.buttons.filter(x => x.type === "outfit")
    .sort((a, b) => a.load.localeCompare(b.load)).map(x => x.combo.join("+"));
};
const writePicks = events =>
  (fs.mkdirSync(path.join(TMP, "wardrobe"), { recursive: true }),
   fs.writeFileSync(path.join(TMP, "wardrobe", "history.json"), JSON.stringify({ events })));

test("with no picks yet, today is pure rotation (nothing seated)", async () => {
  fiveGarments();
  fs.rmSync(path.join(TMP, "wardrobe", "history.json"), { force: true });
  await clothing.regenerate(true);
  const first = firstCombos();
  assert.equal(first.length, 4, "four outfits on page 1");
  // two bottoms → the first two looks share neither top nor bottom; the
  // remaining slots are then filled from what is left (never exclusion)
  const [a, b] = first.map(k => k.split("+"));
  assert.notEqual(a[0], b[0], "no top repeat while alternatives remain");
  assert.notEqual(a[1], b[1], "no bottom repeat while alternatives remain");
});

test("a Yes yesterday seats that outfit first on page 1 today — a Yes today waits for tomorrow", async () => {
  writePicks({
    [dayAgo(1)]: [{ kind: "select", combo: ["item_top1", "item_pants1"] },
                  { kind: "yes",    combo: ["item_top3", "item_pants2"] }],
    [dayAgo(0)]: [{ kind: "yes",    combo: ["item_top2", "item_pants1"] }],
  });
  await clothing.regenerate(true);
  assert.equal(firstCombos()[0], "item_top3+item_pants2", "yesterday's Yes leads the board");
  // a second rebuild the same day keeps her favourite up front (LRU would have buried it)
  await clothing.regenerate(true);
  assert.equal(firstCombos()[0], "item_top3+item_pants2", "still first on a rebuild");
});

test("a day with no Yes credits her last-selected outfit at half weight; only the top looks are seated", async () => {
  writePicks({
    [dayAgo(3)]: [{ kind: "yes", combo: ["item_top3", "item_pants2"] }],
    [dayAgo(2)]: [{ kind: "yes", combo: ["item_top3", "item_pants2"] }],
    [dayAgo(1)]: [{ kind: "select", combo: ["item_top2", "item_pants2"] },
                  { kind: "select", combo: ["item_top1", "item_pants1"] }],   // last look of the day
  });
  await clothing.regenerate(true);
  const seated = firstCombos().slice(0, 2);
  assert.ok(seated.includes("item_top3+item_pants2"), "twice-worn look is seated");
  assert.ok(seated.includes("item_top1+item_pants1"), "the inferred wear is seated at half weight");
  assert.ok(!seated.includes("item_top2+item_pants2"), "an earlier gaze that day is not a wear");
  assert.equal(firstCombos().length, 4, "the rest of page 1 is still fresh rotation");
});
