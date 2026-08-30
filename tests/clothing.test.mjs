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
const wire = [];   // {path, auth} per request — proves each provider's format

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const answer = ANSWERS[Math.min(calls, ANSWERS.length - 1)]; calls++;
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

test("no AI key: plain photo tiles still make a board (v1 fallback)", async () => {
  const r = await clothing.regenerate(true);
  assert.equal(r.mode, "plain");
  const recipe = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  assert.equal(recipe.root, "today");
  assert.ok(recipe.boards.find(b => b.id === "today").buttons.some(x => x.label === "This one"));
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

test("preferred-LLM: a Google key ingests through generateContent with x-goog-api-key", async () => {
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "google", apiKey: "AIza-test" }));
  makeJpg(path.join(TMP, "clothing", "photo_e.jpg"), 90, 220, 120);
  await clothing.regenerate(true);
  const w = wire[wire.length - 1];
  assert.ok(w.path.startsWith("/v1beta/models/") && w.path.endsWith(":generateContent"), w.path);
  assert.equal(w.auth, "AIza-test", "key travels in the header, never the URL");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(cat.items["photo_e.jpg"].ok, "photo cataloged via Google");
});
