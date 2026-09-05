// clothing-weather.test.mjs — "Dress for 10 AM-1 PM" (dad 9/5: "she's often
// choosing clothing for when she'll be at school between ten and one, and we
// give her weather we don't hit until four PM — so it's not perfectly
// useful"). The outfits are sorted for the hours she is OUT, not for the
// afternoon peak: app-settings.json's weatherWindow {from,to} (inclusive
// local hours) picks the hours read out of the hourly forecast.
//
// Port 8446: ONE fake server standing in for both the geo lookup
// (ERA_GEO_URL) and Open-Meteo (ERA_WEATHER_URL). No key, no network.
// The board is rebuilt through clothing.rebuildToday() — the cheap door that
// re-reads the weather and re-sorts a wardrobe that is already catalogued —
// so this suite also proves that door never wakes the AI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WX_PORT = 8446;   // fake geo + Open-Meteo (plan §B port table)
const AI_PORT = 8447;   // a fake AI that must never be called from this suite
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-wx-"));
const require = createRequire(path.join(HUB, "server.js"));
let wx, ai, clothing;

// The family's coordinates for this run — invented, like every fixture here.
const LAT = 41.5, LON = -81.7;
const asks = [];        // every /v1/forecast query the fake was shown
let aiCalls = 0;

// A synthetic day: a cool, rainy late morning (9-12, up to 66°F, code 61) and
// a hot, clear afternoon (16:00, 80°F, code 0). Hours 9-12 are invented test
// hours, not anybody's school day.
function hourly() {
  const time = [], temperature_2m = [], weather_code = [];
  for (let h = 0; h < 24; h++) {
    time.push("2026-09-05T" + String(h).padStart(2, "0") + ":00");
    temperature_2m.push(h === 9 ? 64 : h === 10 ? 66 : h === 11 ? 65 : h === 12 ? 63
                      : h === 16 ? 80 : h >= 13 ? 70 : 55);
    weather_code.push(h >= 9 && h <= 12 ? 61 : 0);
  }
  return { time, temperature_2m, weather_code };
}

function makeJpg(file, r, g, b) {
  const jpeg = require("./vendor/jpeg-js");
  const w = 320, h = 480;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, jpeg.encode({ data, width: w, height: h }, 85).data);
}

function setWindow(win) {
  fs.writeFileSync(path.join(TMP, "app-settings.json"),
    JSON.stringify(win === null ? {} : { weatherWindow: win }, null, 1));
}
function tile() {
  const r = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  const today = r.boards.find(b => b.id === "today");
  return today.buttons.find(b => b.type === "control" && b.row === 1 && b.col === 1);
}

before(async () => {
  process.env.ERA_GEO_URL = `http://127.0.0.1:${WX_PORT}/geo`;
  process.env.ERA_WEATHER_URL = `http://127.0.0.1:${WX_PORT}`;
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  wx = http.createServer((req, res) => {
    if (req.url.startsWith("/geo")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ latitude: LAT, longitude: LON }));
      return;
    }
    if (req.url.startsWith("/v1/forecast")) {
      asks.push(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ latitude: LAT, longitude: LON, hourly: hourly() }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(r => wx.listen(WX_PORT, "127.0.0.1", r));
  ai = http.createServer((req, res) => { aiCalls++; res.writeHead(500).end("{}"); });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));

  // A wardrobe that is already catalogued, plus one photo the AI has never
  // seen: the rebuild door must leave that photo alone.
  fs.mkdirSync(path.join(TMP, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "wardrobe-items"), { recursive: true });
  makeJpg(path.join(TMP, "clothing", "top.jpg"), 220, 60, 90);
  makeJpg(path.join(TMP, "clothing", "bot.jpg"), 60, 90, 220);
  makeJpg(path.join(TMP, "clothing", "waiting.jpg"), 200, 200, 60);
  makeJpg(path.join(TMP, "wardrobe-items", "item_top.jpg"), 220, 60, 90);
  makeJpg(path.join(TMP, "wardrobe-items", "item_bot.jpg"), 60, 90, 220);
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items: {
    "top.jpg": { id: "item_top", ok: true, name: "Heart print tee", category: "top", warmth: "any" },
    "bot.jpg": { id: "item_bot", ok: true, name: "Pink leggings", category: "pants", warmth: "any" },
  } }, null, 1));
  // a key IS configured — the point is that the rebuild door still never calls it
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  clothing = require("./clothing.js");
  clothing.start(TMP);   // timers are unref'd; we drive the rebuild directly
});
after(() => {
  if (wx) wx.close();
  if (ai) ai.close();
  delete process.env.ERA_GEO_URL; delete process.env.ERA_WEATHER_URL; delete process.env.ERA_AI_URL;
});

async function rebuild() {
  try { fs.rmSync(path.join(TMP, ".weather-cache.json"), { force: true }); } catch {}
  const r = await clothing.rebuildToday();
  assert.equal(r.mode, "cataloged", "the wardrobe it already has was re-sorted");
  return tile();
}

test("a window reads the hours she is out, not the day's high", async () => {
  setWindow({ from: 9, to: 12 });
  const t = await rebuild();
  assert.match(t.label, /^66°/, "66°F is the peak of 9-12, not the 80° at 4 PM");
  assert.match(t.label, /warm/);
  assert.equal(t.symbol, "cloud", "the worst code over those hours (61 = rain) picks the symbol");
});

test("the query is the hourly forecast at the family's coordinates", async () => {
  const q = asks[asks.length - 1];
  assert.match(q, /hourly=temperature_2m,weather_code/);
  assert.ok(!/daily=/.test(q), "the daily afternoon peak is not asked for any more: " + q);
  assert.match(q, /forecast_days=1/);
  assert.match(q, /timezone=auto/, "hourly times must be local to the coordinates");
  assert.match(q, new RegExp("latitude=" + LAT));
  assert.match(q, new RegExp("longitude=" + String(LON).replace("-", "-")));
});

test("the tile says the hours out loud, and the footnote names them", async () => {
  const t = tile();
  assert.match(t.say, /Between 9 AM and 12 PM it is warm, about 66 degrees\./);
  assert.match(t.footnote, /^for 9 AM-12 PM · updated /);
});

test("no window = the whole day, worded as before", async () => {
  setWindow(null);
  const t = await rebuild();
  assert.match(t.label, /^80°/, "the whole day peaks at 80°F");
  assert.match(t.label, /hot/);
  // Adaptation from the task's sketch: the whole day CONTAINS the rainy
  // morning, and the symbol is the worst code over the hours read — so the
  // all-day symbol is cloud here. The sunny case is the 2-5 PM test below.
  assert.equal(t.symbol, "cloud");
  assert.equal(t.say, "Today it is hot, about 80 degrees.");
  assert.match(t.footnote, /^updated /, "no window, no 'for ...' prefix: " + t.footnote);
});

test("an afternoon window gets the afternoon's sun", async () => {
  setWindow({ from: 14, to: 17 });
  const t = await rebuild();
  assert.match(t.label, /^80°/);
  assert.match(t.label, /hot/);
  assert.equal(t.symbol, "sun");
  assert.match(t.say, /Between 2 PM and 5 PM/);
  assert.match(t.footnote, /^for 2 PM-5 PM · /);
});

test("a cache stamped for another window is stale — the forecast is re-read", async () => {
  // fresh by the clock (3 h), but computed for hours she is no longer out for
  fs.writeFileSync(path.join(TMP, ".weather-cache.json"), JSON.stringify({
    at: Date.now(), window: "14-17",
    w: { t: 99, band: "hot", symbol: "sun", window: { from: 14, to: 17 } } }));
  setWindow({ from: 9, to: 12 });
  const before = asks.length;
  const r = await clothing.rebuildToday();
  assert.equal(r.mode, "cataloged");
  assert.equal(asks.length, before + 1, "the stale record was thrown away and Open-Meteo asked again");
  assert.match(tile().label, /^66°/);
  // ...and the record now carries the window it was computed for
  const c = JSON.parse(fs.readFileSync(path.join(TMP, ".weather-cache.json"), "utf8"));
  assert.equal(c.window, "9-12");
});

test("the same window inside 3 hours is answered from the cache", async () => {
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before, "no second lookup for the same window");
});

test("the rebuild door never wakes the AI (photos wait for a real run)", async () => {
  assert.equal(aiCalls, 0, "waiting.jpg was NOT ingested: rebuildToday() re-sorts only");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(!cat.items["waiting.jpg"], "the uncatalogued photo is still waiting");
});
