// weather-location.test.mjs — the board reads the weather for a place a parent
// TYPED, not for wherever an IP lookup guesses (dad 9/23: "it's always a lot
// colder than my weather reports" — both devices were geolocating to a city
// centroid a microclimate away, 11 days out of 11 too cold).
//
// Port 8401: ONE fake server standing in for the geo lookup (ERA_GEO_URL),
// the geocoder (ERA_GEOCODE_URL) and Open-Meteo (ERA_WEATHER_URL). No key, no
// network. Surveyed free across all five repos 9/23 — and NOT 8380-8389, which
// is the manual-hub band, not a suite band (docs/dev-flow.md:24).
//
// Every town, ZIP and coordinate in this file is invented. The family's own
// location is config and never a fixture.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WX_PORT = 8401;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-wx-loc-"));
const require = createRequire(path.join(HUB, "server.js"));
const rank = require(path.join(HUB, "clothing-rank.js"));

// A zone that is neither this box's nor the module's own default, so a suite
// that accidentally reads the OS clock fails loudly instead of passing by luck.
const ZONE = "Asia/Tokyo";
const today = () => rank.dayKey(Date.now(), ZONE);
const yesterday = () => rank.yesterdayOf(today());

let wx, clothing;
const asks = [];        // every /v1/forecast query the fake was shown
const geoHits = [];     // every IP-geolocation lookup the fake was shown

// Two different places, so "which point was asked for" is always decidable.
const IP_POINT = { latitude: 41.5, longitude: -81.7 };     // what the IP guess returns
const TYPED = { name: "Fairhaven", admin1: "Ohio", country: "US", lat: 39.25, lon: -84.5 };

// A flat synthetic day: every hour 70°F, code 0. Phase 1 only cares about
// whether the forecast was FETCHED, never about the arithmetic — that is
// clothing-weather.test.mjs's job and it must stay untouched.
function hourly() {
  const time = [], temperature_2m = [], weather_code = [];
  for (let h = 0; h < 24; h++) {
    time.push("2026-09-23T" + String(h).padStart(2, "0") + ":00");
    temperature_2m.push(70);
    weather_code.push(0);
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

function settings(obj) {
  fs.writeFileSync(path.join(TMP, "app-settings.json"), JSON.stringify(obj || {}, null, 1));
}
function readCache() {
  return JSON.parse(fs.readFileSync(path.join(TMP, ".weather-cache.json"), "utf8"));
}
function writeCache(rec) {
  fs.writeFileSync(path.join(TMP, ".weather-cache.json"), JSON.stringify(rec));
}

before(async () => {
  process.env.ERA_GEO_URL = `http://127.0.0.1:${WX_PORT}/geo`;
  process.env.ERA_WEATHER_URL = `http://127.0.0.1:${WX_PORT}`;
  process.env.ERA_GEOCODE_URL = `http://127.0.0.1:${WX_PORT}/geocode`;
  wx = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/geo")) { geoHits.push(req.url); return json(IP_POINT); }
    if (req.url.startsWith("/v1/forecast")) { asks.push(req.url); return json({ hourly: hourly() }); }
    res.writeHead(404).end();
  });
  await new Promise(r => wx.listen(WX_PORT, "127.0.0.1", r));

  // The smallest wardrobe that deals a board: one top, one bottom, both already
  // described so no pass ever reaches for an AI key that is not configured.
  fs.mkdirSync(path.join(TMP, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "wardrobe-items"), { recursive: true });
  makeJpg(path.join(TMP, "clothing", "top.jpg"), 220, 60, 90);
  makeJpg(path.join(TMP, "clothing", "bot.jpg"), 60, 90, 220);
  makeJpg(path.join(TMP, "wardrobe-items", "item_top.jpg"), 220, 60, 90);
  makeJpg(path.join(TMP, "wardrobe-items", "item_bot.jpg"), 60, 90, 220);
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items: {
    "top.jpg": { id: "item_top", ok: true, name: "Heart tee", category: "top", warmth: "any", attrsAt: "2026-09-01" },
    "bot.jpg": { id: "item_bot", ok: true, name: "Pink leggings", category: "pants", warmth: "any", attrsAt: "2026-09-01" },
  } }, null, 1));
  settings({ weatherWindow: { from: 9, to: 12 } });

  clothing = require(path.join(HUB, "clothing.js"));
  clothing.start(TMP, { noTimers: true, tz: () => ZONE });
});

after(() => {
  if (wx) wx.close();
  delete process.env.ERA_GEO_URL;
  delete process.env.ERA_WEATHER_URL;
  delete process.env.ERA_GEOCODE_URL;
});

// ---- Phase 1: the cache key carries the DAY -------------------------------
//
// The record holds for 3 h and `forecast_days=1` always means TODAY, so with no
// day in the key a build between local midnight and ~03:00 that follows an
// evening build serves YESTERDAY's window — the board sorted for a day that has
// already ended. The 5 AM cutoff (clothing.js boardIsFresh) makes the ordinary
// morning build a fresh fetch, so this is narrow, but a photo change or a
// restart in that gap reaches it.

test("a cache stamped YESTERDAY is stale, even inside three hours", async () => {
  writeCache({ at: Date.now(), window: "9-12", day: yesterday(),
    w: { t: 99, band: "hot", symbol: "sun", window: { from: 9, to: 12 } } });
  const before = asks.length;
  const r = await clothing.rebuildToday();
  assert.equal(r.mode, "cataloged");
  assert.equal(asks.length, before + 1,
    "yesterday's record answers a question about a day that has ended — ask again");
  assert.equal(readCache().day, today(), "and the fresh record is stamped with today");
});

test("the same day, window and place inside three hours is answered from the cache", async () => {
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before, "no second lookup for the same day and window");
});

test("a record written before this upgrade carries no day and is re-read once", async () => {
  // Exactly the shape the previous build wrote: {at, window, w} and no `day`.
  writeCache({ at: Date.now(), window: "9-12",
    w: { t: 99, band: "hot", symbol: "sun", window: { from: 9, to: 12 } } });
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "an undated record cannot be shown to be today's");
  assert.equal(readCache().day, today());
});

test("a cache stamped for another window is still stale (unchanged)", async () => {
  writeCache({ at: Date.now(), window: "14-17", day: today(),
    w: { t: 99, band: "hot", symbol: "sun", window: { from: 14, to: 17 } } });
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "the window half of the key must keep working");
});
