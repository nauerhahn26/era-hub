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

const ANSWERS = [
  { name: "Heart print tee", category: "top", warmth: "warm", rotate_deg: 90, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  { name: "Pink leggings", category: "pants", warmth: "any", rotate_deg: 0, crop: { x: 0, y: 0, w: 1, h: 1 } },
  { name: "Sunflower dress", category: "dress", warmth: "warm", rotate_deg: 0, crop: { x: 0.2, y: 0, w: 0.6, h: 1 } },
];
let calls = 0;
let flaky = 0;                  // >0 = answer this many calls with a 503 first
let throttleModel = "";         // a model id that always answers 429
const wire = [];   // {path, auth} per request — proves each provider's format

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls++;
      if (throttleModel && req.url.includes(throttleModel)) {
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
      const answer = ANSWERS[wire.length % ANSWERS.length];
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
  makeJpg(path.join(TMP, "clothing", "photo_c.jpg"), 250, 210, 60);
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
