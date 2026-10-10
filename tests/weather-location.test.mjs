// weather-location.test.mjs — the board reads the weather for a place a parent
// TYPED, not for wherever an IP lookup guesses (dad 9/23: "it's always a lot
// colder than my weather reports" — both devices were geolocating to a city
// centroid a microclimate away, 11 days out of 11 too cold).
//
// Port 8401: ONE fake server standing in for the geo lookup (ERA_GEO_URL),
// the geocoder (ERA_GEOCODE_URL), Open-Meteo (ERA_WEATHER_URL) and weather.gov
// (ERA_NWS_URL — spec §7, the second rung). No key, no network. Surveyed free across all five repos 9/23 — and NOT 8380-8389, which
// is the manual-hub band, not a suite band (docs/dev-flow.md:24).
//
// Every town, ZIP and coordinate in this file is invented. The family's own
// location is config and never a fixture.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const nwsHits = [];     // every weather.gov path the fake was shown, in order
const nwsAgents = [];   // ...and the User-Agent each one carried
// What the two forecast rungs are doing (spec §7). OM: ok | 403 — the 10/10
// receipt, every Open-Meteo call refused from the family's address. NWS:
// ok | 404 (a point it does not serve: not in the US) | dead.
let OM = "ok";
let NWS = "ok";
let NWS_TEMP = 58;              // weather.gov's °F for every hour
let NWS_SKY = "Light Rain";     // ...and its sentence
const geoHits = [];     // every IP-geolocation lookup the fake was shown
const geocodeHits = []; // every geocoder search the fake was shown
let GEOCODE = "hits";   // what the geocoder is doing: hits | empty | dead | flood

// The seam carries the whole ladder, comma-separated, exactly as the shipped
// default does — one URL is still one URL, so the sibling suites are untouched.
const GEO = (...tail) => tail.map(t => `http://127.0.0.1:${WX_PORT}/geo${t}`).join(",");

// Two different places, so "which point was asked for" is always decidable.
const IP_POINT = { latitude: 41.5, longitude: -81.7 };     // what the IP guess returns
const TYPED = { name: "Fairhaven", admin1: "Ohio", country: "US", lat: 39.25, lon: -84.5 };
// A second typed place, so "the stored point CHANGED" is decidable too — and
// its own temperature, so a board built for it can be told from a board built
// for anywhere else without trusting a timestamp.
const ELSEWHERE = { name: "Pelham Rise", admin1: "Havershire", country: "US", lat: 33.5, lon: -95.25 };

// A flat synthetic week: every hour the same temperature and code. Phase 1 only
// cares about whether the forecast was FETCHED, never about the arithmetic —
// that is clothing-weather.test.mjs's job. The temperature is keyed on the
// POINT so a tile can name the place it was built for; `CODE` is every hour's
// weather code, which the symbol tests move.
//
// The series starts YESTERDAY in this suite's zone and runs one day past what
// was asked for, so "today" is inside it whatever zone the reader is in — the
// spawned hub below keeps its own. Since spec §7 the window is read out of the
// series BY DATE, so a fixed date here would be a day that never comes.
const TEMP_AT = new Map([[String(ELSEWHERE.lat), 85]]);
let CODE = 0;
function days(n) {
  const out = [yesterday()];
  while (out.length < n + 1) {
    const [y, m, d] = out[out.length - 1].split("-").map(Number);
    out.push(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10));
  }
  return out;
}
function hourly(lat, n = 1) {
  const time = [], temperature_2m = [], weather_code = [];
  for (const day of days(n)) for (let h = 0; h < 24; h++) {
    time.push(day + "T" + String(h).padStart(2, "0") + ":00");
    temperature_2m.push(TEMP_AT.get(String(lat)) ?? 70);
    weather_code.push(CODE);
  }
  return { time, temperature_2m, weather_code };
}
// weather.gov's hourly periods, its own shape: an ISO start WITH its offset,
// °F, and a sentence where Open-Meteo has a code. Seven days, as it serves.
function periods() {
  return days(7).flatMap(day => Array.from({ length: 24 }, (_, h) => ({
    number: 1, startTime: day + "T" + String(h).padStart(2, "0") + ":00:00+09:00",
    endTime: day + "T" + String(h).padStart(2, "0") + ":59:00+09:00", isDaytime: h >= 6 && h < 18,
    temperature: NWS_TEMP, temperatureUnit: "F", windSpeed: "5 mph", shortForecast: NWS_SKY })));
}
// A stored series by hand, in the store's ONE shape (spec §7.1): `temp(day, h)`
// and `code(day, h)` pick each hour, so a test can tell which day was read.
const PLACE = TYPED.lat.toFixed(3) + "," + TYPED.lon.toFixed(3);
function series(dayList, temp, code = () => 3) {
  const time = [], t = [], c = [];
  for (const day of dayList) for (let h = 0; h < 24; h++) {
    time.push(day + "T" + String(h).padStart(2, "0") + ":00");
    t.push(temp(day, h)); c.push(code(day, h));
  }
  return { time, temp: t, code: c };
}
const HOUR = 3600e3;

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
function dropCache() {
  fs.rmSync(path.join(TMP, ".weather-cache.json"), { force: true });
}
// the weather tile: today's board, [1,1]
function tile() {
  const r = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  return r.boards.find(b => b.id === "today")
          .buttons.find(b => b.type === "control" && b.row === 1 && b.col === 1);
}

before(async () => {
  process.env.ERA_GEO_URL = `http://127.0.0.1:${WX_PORT}/geo`;
  process.env.ERA_WEATHER_URL = `http://127.0.0.1:${WX_PORT}`;
  process.env.ERA_GEOCODE_URL = `http://127.0.0.1:${WX_PORT}/geocode`;
  process.env.ERA_NWS_URL = `http://127.0.0.1:${WX_PORT}`;
  wx = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/v1/forecast")) {
      asks.push(req.url);
      // Exactly what Open-Meteo said to the family's address on 10/10.
      if (OM === "403") {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: true, reason: "Forbidden" }));
      }
      const sp = new URL(req.url, "http://x").searchParams;
      return json({ hourly: hourly(sp.get("latitude"), Number(sp.get("forecast_days")) || 1) });
    }
    // weather.gov: /points/{lat},{lon} names the grid's hourly URL — on the
    // REAL service another host path; here this same fake, which is what the
    // seam rewrites it to — and that URL answers the periods.
    if (req.url.startsWith("/points/") || req.url.startsWith("/gridpoints/")) {
      nwsHits.push(req.url);
      nwsAgents.push(req.headers["user-agent"] || "");
      if (NWS === "dead") return req.socket.destroy();
      if (NWS === "404") {
        res.writeHead(404, { "Content-Type": "application/problem+json" });
        return res.end(JSON.stringify({ title: "Data Unavailable For Requested Point" }));
      }
      if (req.url.startsWith("/points/"))
        return json({ properties: {
          forecastHourly: `http://127.0.0.1:${WX_PORT}/gridpoints/TST/10,20/forecast/hourly` } });
      return json({ properties: { periods: periods() } });
    }
    // /geocode BEFORE /geo: the geocoder's path starts with the IP lookup's,
    // and the other way round the geo branch answers every search.
    if (req.url.startsWith("/geocode")) {
      geocodeHits.push(req.url);
      // Every mode a real geocoder can be in. "dead" is the one that matters:
      // a lookup that never answers must reach the parent as a sentence, not
      // as a crashed request.
      if (GEOCODE === "dead") return req.socket.destroy();
      if (GEOCODE === "empty") return json({ generationtime_ms: 0.2 });
      if (GEOCODE === "flood") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // well past the 4 KB ceiling, and never valid JSON when it is cut off
        return res.end('{"results":[' + '{"name":"Ever and ever"},'.repeat(4000) + "]}");
      }
      // Eight matches, population-ranked, with the upstream's own field names
      // and a pile of keys the hub has no use for.
      return json({ results: Array.from({ length: 8 }, (_, i) => ({
        id: 1000 + i, name: "Fairhaven " + (i + 1), admin1: ELSEWHERE.admin1,
        admin2: "Kestrel County", country: "United States", country_code: ELSEWHERE.country,
        latitude: ELSEWHERE.lat, longitude: ELSEWHERE.lon,
        elevation: 210, population: 90000 - i, timezone: "Etc/UTC",
      })) });
    }
    // The real lookup walks TWO providers, so the seam takes a list of them.
    // /geo/half answers with HALF a point — a latitude and no longitude, the
    // shape a rate-limited provider's reply used to slip through as.
    if (req.url.startsWith("/geo")) {
      geoHits.push(req.url);
      return json(req.url.startsWith("/geo/half") ? { latitude: 12.5 } : IP_POINT);
    }
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
  if (child) child.kill("SIGKILL");
  delete process.env.ERA_GEO_URL;
  delete process.env.ERA_WEATHER_URL;
  delete process.env.ERA_GEOCODE_URL;
  delete process.env.ERA_NWS_URL;
});

// ---- a real hub, for the two routes ---------------------------------------
//
// /weather/search and POST /settings live in server.js, so phase 3 needs a hub
// listening. 8426: the OTHER port this unit's survey found free across all five
// repos (spec §4) — the fake above already owns 8401 and cannot also be the
// hub. Started lazily, so the worker cases above never pay for it.
const HUB_PORT = 8426;
const HUB_BASE = `http://127.0.0.1:${HUB_PORT}`;
const HTMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-wx-hub-"));
let child;
async function hub() {
  if (child) return HUB_BASE;
  // Its own wardrobe, already described: a re-sort has something to deal, and
  // no photo is left for the hub's own startup tick to want.
  fs.mkdirSync(path.join(HTMP, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(HTMP, "wardrobe-items"), { recursive: true });
  makeJpg(path.join(HTMP, "clothing", "top.jpg"), 220, 60, 90);
  makeJpg(path.join(HTMP, "clothing", "bot.jpg"), 60, 90, 220);
  makeJpg(path.join(HTMP, "wardrobe-items", "item_top.jpg"), 220, 60, 90);
  makeJpg(path.join(HTMP, "wardrobe-items", "item_bot.jpg"), 60, 90, 220);
  fs.writeFileSync(path.join(HTMP, "wardrobe.json"), JSON.stringify({ items: {
    "top.jpg": { id: "item_top", ok: true, name: "Heart tee", category: "top", warmth: "any", attrsAt: "2026-09-01" },
    "bot.jpg": { id: "item_bot", ok: true, name: "Pink leggings", category: "pants", warmth: "any", attrsAt: "2026-09-01" },
  } }, null, 1));
  child = spawn("node", ["server.js", String(HUB_PORT)], {
    cwd: HUB, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: HTMP, ERA_BIND: "127.0.0.1",
           ERA_GEO_URL: GEO(""), ERA_WEATHER_URL: `http://127.0.0.1:${WX_PORT}`,
           ERA_GEOCODE_URL: `http://127.0.0.1:${WX_PORT}/geocode`,
           ERA_NWS_URL: `http://127.0.0.1:${WX_PORT}` },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${HUB_BASE}/settings`); return HUB_BASE; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("the hub never came up on " + HUB_PORT);
}
const saveSettings = (body) => fetch(HUB_BASE + "/settings",
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const storedLocation = async () => (await (await fetch(HUB_BASE + "/settings")).json()).location;
const hubCache = () => path.join(HTMP, ".weather-cache.json");
function hubTile() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(HTMP, "recipes", "today.json"), "utf8"));
    return r.boards.find(b => b.id === "today")
            .buttons.find(b => b.type === "control" && b.row === 1 && b.col === 1);
  } catch { return null; }
}
// A bounded wait, and the bound is load-bearing: the hub runs a startup build
// of its own 20 s after it comes up, so anything this suite credits to a POST
// has to be asserted well inside that.
async function until(what, tries, why) {
  for (let i = 0; i < tries; i++) {
    if (what()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(why);
}

// ---- Phase 1: the store is a SERIES, read by the day ----------------------
//
// UPDATED 10/10 (spec §7.1). This phase used to pin the §3.4 bug as a cache
// KEY: the record was one answer, computed for one day, so a record stamped
// yesterday had to be thrown away. Since §7 the store is the whole week's
// hourly series and today's window is read out of it BY DATE — "nothing is
// stale by date any more" — so the same bug is now pinned where it would live:
// a series that holds yesterday as well as today must be read for TODAY.
// `at` still decides one thing: whether to try to refresh (3 h).

test("a series that holds yesterday and today is read for TODAY", async () => {
  settings({ location: TYPED, weatherWindow: { from: 9, to: 12 } });
  // fetched a moment ago (the 11 PM build) and holding both days: yesterday's
  // hours at 99 °F, today's at 64 °F
  writeCache({ at: Date.now(), place: PLACE, source: "open-meteo",
    hourly: series([yesterday(), today()], d => d === today() ? 64 : 99) });
  const before = asks.length;
  const r = await clothing.rebuildToday();
  assert.equal(r.mode, "cataloged");
  assert.equal(asks.length, before, "under three hours old: served with no call");
  assert.match(tile().label, /^64°/, "today's hours, not the day that has ended: " + tile().label);
});

test("a fresh series that does not reach today is no answer for today", async () => {
  writeCache({ at: Date.now(), place: PLACE, source: "open-meteo",
    hourly: series([yesterday()], () => 99) });
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "a week that ended yesterday cannot dress her today — ask again");
  assert.match(tile().label, /^70°/);
});

test("the same place inside three hours is answered from the store", async () => {
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before, "no second lookup for the same place");
});

test("a record in the old one-answer shape is re-read once", async () => {
  // Exactly the shape the 9/23 build wrote: one computed answer, no series.
  writeCache({ at: Date.now(), window: "9-12", place: PLACE, day: today(),
    w: { t: 99, band: "hot", symbol: "sun", window: { from: 9, to: 12 } } });
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "an answer is not a series: nothing in it can be read for a window");
  assert.ok(Array.isArray(readCache().hourly.time), "and what replaces it is the series");
  assert.match(tile().label, /^70°/, "never the 99 the old record carried");
});

// UPDATED 10/10 (spec §7.1): a window used to be half the cache key, so a
// record for other hours was thrown away and the forecast asked again. The
// store now holds every hour of the week, so a new window is a new READ of
// it, never a new call — and that matters on a day the providers refuse.
test("a new window is read out of the stored series, with no call", async () => {
  writeCache({ at: Date.now(), place: PLACE, source: "open-meteo",
    hourly: series([today()], (d, h) => h >= 14 ? 81 : 60) });
  settings({ location: TYPED, weatherWindow: { from: 14, to: 17 } });
  const before = asks.length;
  await clothing.rebuildToday();
  assert.match(tile().label, /^81°/, "the afternoon hours of the stored day");
  settings({ location: TYPED, weatherWindow: { from: 9, to: 12 } });
  await clothing.rebuildToday();
  assert.match(tile().label, /^60°/, "...and the morning hours of the same stored day");
  assert.equal(asks.length, before, "neither window cost a call");
});

// ---- Phase 2: the point the forecast is asked for -------------------------
//
// An IP lookup answers with the ISP's idea of where the family is — a city
// centroid, which on both devices sat a microclimate away and read cold every
// day for eleven days running. A parent types a town once; from then on that
// is the point, and the guess is never made at all.

test("a stored location is the point the forecast is asked for, and the guess is never made", async () => {
  settings({ location: TYPED, weatherWindow: { from: 9, to: 12 } });
  dropCache();
  const geoBefore = geoHits.length;
  await clothing.rebuildToday();
  const q = asks[asks.length - 1];
  assert.match(q, /latitude=39\.25(&|$)/, "the typed point, not the guessed one: " + q);
  assert.match(q, /longitude=-84\.5(&|$)/, q);
  assert.equal(geoHits.length, geoBefore, "a town a parent typed needs no IP lookup at all");
});

test("no stored location falls back to the IP lookup, the providers tried in order", async () => {
  settings({ weatherWindow: { from: 9, to: 12 } });
  process.env.ERA_GEO_URL = GEO("/first", "/second");
  geoHits.length = 0;
  dropCache();
  await clothing.rebuildToday();
  assert.deepEqual(geoHits, ["/geo/first"],
    "the first provider answered, so the second was never asked");
  assert.match(asks[asks.length - 1], /latitude=41\.5(&|$)/, "and its point is the one used");
});

test("half a geo answer is no answer: a latitude with no longitude falls to the next provider", async () => {
  process.env.ERA_GEO_URL = GEO("/half", "/second");
  geoHits.length = 0;
  dropCache();
  await clothing.rebuildToday();
  assert.deepEqual(geoHits, ["/geo/half", "/geo/second"],
    "a provider that answers with only a latitude is refused, not taken");
  const q = asks[asks.length - 1];
  assert.match(q, /latitude=41\.5(&|$)/, "the SECOND provider's point is the one used: " + q);
  assert.ok(!/longitude=(undefined|NaN|&|$)/.test(q), "and the forecast is never asked for half a point: " + q);
});

// Moving the point makes a cached answer an answer to a different question,
// exactly as moving the window does — so the key has to carry it.
test("changing the place makes a cached answer stale, the way changing the window does", async () => {
  settings({ location: TYPED, weatherWindow: { from: 9, to: 12 } });
  dropCache();
  await clothing.rebuildToday();                    // a record computed for Fairhaven
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before, "same place, same window, same day: the cache answers");
  settings({ location: ELSEWHERE, weatherWindow: { from: 9, to: 12 } });
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "a different point is a different question");
  assert.match(asks[asks.length - 1], /latitude=33\.5(&|$)/, "and it is the new point that is asked for");
});

// A child dresses for the middle of her day, not for the afternoon high — so
// an unset window is those hours, not the whole day the daily maximum gave.
// UPDATED 10/10 (spec §7.1): read off the TILE, not the store — the store is
// the whole week's series now and carries no window at all.
test("an unset window is 10 AM-2 PM, not the whole day", async () => {
  settings({});
  dropCache();
  await clothing.rebuildToday();
  assert.match(tile().footnote, / · for 10 AM-2 PM · /, "the default is the middle of the day");
  assert.match(tile().say, /^Between 10 AM and 2 PM /, "and the tile is told which hours it read");
});

// A default is not a migration: rewriting hours a parent chose would be a
// surprise, and the two devices already carry explicit ones.
test("a window a parent chose is never rewritten by the default", async () => {
  settings({ weatherWindow: { from: 9, to: 12 } });
  dropCache();
  await clothing.rebuildToday();
  // UPDATED 10/10 (spec §7.1): the hours read are on the tile, not the store
  assert.match(tile().footnote, / · for 9 AM-12 PM · /);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, "app-settings.json"), "utf8")).weatherWindow,
    { from: 9, to: 12 }, "and the file on disk still says what the parent set");
});

// ---- Phase 3: the geocoder route ------------------------------------------
//
// The hub proxies Open-Meteo's own geocoder rather than letting the Settings
// page call out: one place owns the seam, the timeout and the wording. It is
// pressed by a parent, never on the build path — a dead geocoder can cost a
// lookup, never a board.

test("the search route answers a short, normalised list", async () => {
  const base = await hub();
  GEOCODE = "hits";
  const r = await fetch(base + "/weather/search?q=Fairhaven");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.results.length, 5, "eight upstream, five offered");
  assert.deepEqual(Object.keys(body.results[0]).sort(), ["admin1", "country", "lat", "lon", "name"],
    "the upstream's other fourteen fields are none of the page's business");
  assert.deepEqual(body.results[0], { name: "Fairhaven 1", admin1: ELSEWHERE.admin1,
    country: ELSEWHERE.country, lat: ELSEWHERE.lat, lon: ELSEWHERE.lon });
});

test("a geocoder that does not answer is a 503, and the place already stored survives it", async () => {
  const base = await hub();
  GEOCODE = "hits";
  assert.equal((await saveSettings({ location: TYPED })).status, 204);
  GEOCODE = "dead";
  const r = await fetch(base + "/weather/search?q=Fairhaven");
  assert.equal(r.status, 503, "a lookup that did not answer is a sentence, not a crash");
  assert.deepEqual(await r.json(), { error: "offline" });
  const l = await storedLocation();
  assert.equal(l && l.name, TYPED.name, "a failed lookup writes nothing and clears nothing");
});

// 200 with an empty list, NEVER 404: the page has two different things to say
// ("no town by that name" and "could not reach the lookup") and cannot tell
// them apart from a status that means both.
test("nothing matched is an empty list, not a 404", async () => {
  const base = await hub();
  GEOCODE = "empty";
  const r = await fetch(base + "/weather/search?q=zzzzzzzz");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { results: [] });
  const asked = geocodeHits.length;
  const blank = await fetch(base + "/weather/search?q=");
  assert.equal(blank.status, 200);
  assert.deepEqual(await blank.json(), { results: [] });
  assert.equal(geocodeHits.length, asked, "nothing typed is nothing to look up");
});

test("a geocoder that will not stop talking is cut off, not swallowed whole", async () => {
  const base = await hub();
  GEOCODE = "flood";
  const r = await fetch(base + "/weather/search?q=Fairhaven");
  assert.equal(r.status, 503, "past the ceiling the answer is no answer");
});

// Per FIELD, the house rule: a field that is not what it should be costs that
// field, never the setting. A body carrying no usable POINT is not a location
// at all, so the one already stored is left exactly as it was — a parent who
// fat-fingers the box does not lose the town they picked last week.
test("a location is taken field by field, and a malformed one never clears a good one", async () => {
  await hub();
  GEOCODE = "hits";
  assert.equal((await saveSettings({ location: { ...TYPED, q: "12345" } })).status, 204);
  const good = await storedLocation();
  assert.equal(good.name, TYPED.name);
  assert.equal(good.admin1, TYPED.admin1);
  assert.equal(good.lat, TYPED.lat);
  assert.equal(good.lon, TYPED.lon);
  assert.equal(good.q, "12345", "what the parent typed is kept, so the box can show it back");
  assert.match(good.at, /^\d{4}-\d{2}-\d{2}T/, "and when they set it");

  await saveSettings({ location: { ...TYPED, name: "Nowhere", lat: "tepid" } });
  assert.deepEqual(await storedLocation(), good, "a lat that is not a finite number is not a place");
  await saveSettings({ location: { ...TYPED, name: "Nowhere", lat: 900 } });
  assert.deepEqual(await storedLocation(), good, "...and neither is a latitude off the planet");
  await saveSettings({ location: { name: "Nowhere", lat: 12.5 } });
  assert.deepEqual(await storedLocation(), good, "half a point is not a place either");

  await saveSettings({ location: { ...TYPED, lat: 12.5, lon: 34.75, name: "x".repeat(200) } });
  const clipped = await storedLocation();
  assert.equal(clipped.lat, 12.5, "a good point is stored");
  assert.equal(clipped.lon, 34.75);
  assert.ok(!clipped.name, "and the 200-character name costs the NAME, nothing else");
  assert.equal(clipped.admin1, TYPED.admin1, "the fields beside it are untouched");

  assert.equal((await saveSettings({ location: null })).status, 204);
  assert.equal(await storedLocation(), undefined, "null clears it, back to the IP guess");
});

// The window already does exactly this (a new window makes the cached answer
// an answer to the old question, and today's board a board for the wrong
// hours); a new place is the same fact about the other half of the key.
test("a CHANGED place throws the cached answer away and re-sorts the board", async () => {
  await hub();
  GEOCODE = "hits";
  await saveSettings({ location: TYPED });
  // a record by hand, so "was it thrown away" is decidable without a clock
  fs.writeFileSync(hubCache(), JSON.stringify({ at: Date.now(), window: "10-14",
    place: "39.250,-84.500", day: today(),
    w: { t: 99, band: "hot", symbol: "sun", window: { from: 10, to: 14 } } }));

  assert.equal((await saveSettings({ location: TYPED })).status, 204);
  assert.ok(fs.existsSync(hubCache()), "the same town saved again is not a change: the record stands");

  assert.equal((await saveSettings({ location: ELSEWHERE })).status, 204);
  assert.ok(!fs.existsSync(hubCache()), "a new town, and the stored answer is thrown away");
  await until(() => { const t = hubTile(); return t && /^85°/.test(t.label); }, 80,
    "the board was never re-sorted for the point the parent just picked");
});

// ---- Phase 4: the tile says which place, and what the sky is doing --------

test("the footnote names the town a parent typed", async () => {
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  dropCache();
  await clothing.rebuildToday();
  assert.match(tile().footnote, /^Fairhaven · for 10 AM-2 PM · updated /, tile().footnote);
});

// The state that started this whole investigation, on the board instead of
// invisible in a cache file: a wrong answer becomes visible rather than silent.
test("with no town stored the footnote says the place is a guess", async () => {
  settings({ weatherWindow: { from: 10, to: 14 } });
  dropCache();
  await clothing.rebuildToday();
  assert.match(tile().footnote, /^approximate location · for 10 AM-2 PM · updated /, tile().footnote);
});

// Above code 67 the old map called everything cold, so a thunderstorm and a
// rain shower both put a snowflake on the board. Which HOUR wins is left
// alone — max(weather_code) is not a severity ordering and never was; that is
// unit B's business. What is fixed here is the map.
test("the symbol map: rain is rain, and only snow is cold", async () => {
  for (const [code, symbol] of [[1, "sun"], [45, "cloud"], [61, "rain"],
                                [71, "cold"], [80, "rain"], [95, "rain"]]) {
    CODE = code;
    settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
    dropCache();
    await clothing.rebuildToday();
    assert.equal(tile().symbol, symbol, "weather code " + code + " should be " + symbol);
  }
  CODE = 0;
});

// ---- Phase 5: three rungs — Open-Meteo, then weather.gov, then the store ----
//
// 10/10: Open-Meteo answered the family's address with 403 for every call, the
// home device built at 09:57 with NO weather — tile gone, outfits ungated for
// a 64 °F day — and nothing retried it all day. Dad, 10/10: fetch the next few
// days and store them; if the first service does not respond use another; if
// neither does, use any stored weather for future dates (spec §7).

// The footnote's "updated …", formatted exactly as the tile formats it.
const stamp = (at) => new Date(at).toLocaleString("en-US",
  { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const distinctDays = (h) => new Set(h.time.map(t => String(t).slice(0, 10))).size;
function rungs(om, nws) { OM = om; NWS = nws; }
function hasTile() {
  const r = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  return r.boards.find(b => b.id === "today").buttons.some(b => b.type === "control" && b.row === 1 && b.col === 1);
}

test("rung 1 serves the day: one call, the whole week stored, source open-meteo", async () => {
  rungs("ok", "ok");
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  dropCache();
  const before = asks.length, nwsBefore = nwsHits.length;
  const t0 = Date.now();
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "one call");
  assert.match(asks[asks.length - 1], /forecast_days=7(&|$)/, "for the week, not the day: " + asks[asks.length - 1]);
  assert.equal(nwsHits.length, nwsBefore, "rung 1 answered, so rung 2 was never asked");
  const c = readCache();
  assert.equal(c.source, "open-meteo");
  assert.equal(c.place, PLACE, "the point the series is FOR");
  assert.ok(c.at >= t0 && c.at <= Date.now(), "stamped with the fetch time");
  assert.ok(distinctDays(c.hourly) >= 7, "seven days stored, got " + distinctDays(c.hourly));
  assert.equal(c.hourly.temp.length, c.hourly.time.length);
  assert.equal(c.hourly.code.length, c.hourly.time.length);
  assert.match(tile().label, /^70°/);
});

test("rung 1 answers 403: weather.gov is asked (points, then hourly) and its number is the tile's", async () => {
  rungs("403", "ok");
  NWS_TEMP = 58; NWS_SKY = "Light Rain";
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  dropCache();
  nwsHits.length = 0; nwsAgents.length = 0;
  await clothing.rebuildToday();
  assert.deepEqual(nwsHits, ["/points/39.25,-84.5", "/gridpoints/TST/10,20/forecast/hourly"],
    "the point first, then the hourly URL it named");
  for (const ua of nwsAgents)
    assert.match(ua, /^OurEraComms \(ourerafoundation\.org\)$/, "weather.gov refuses a request that does not say who it is");
  const t = tile();
  assert.match(t.label, /^58°  cool/, t.label);
  assert.equal(t.symbol, "rain", "\"Light Rain\" is rain");
  const c = readCache();
  assert.equal(c.source, "weather.gov");
  assert.ok(distinctDays(c.hourly) >= 7, "its week is stored too");
  assert.ok(c.hourly.code.every(Number.isFinite), "in the store's ONE shape: a code for every hour, not a sentence");
  rungs("ok", "ok");
});

test("both fail, the store covers today: the tile comes from the store and says how old it is", async () => {
  rungs("403", "404");          // weather.gov does not serve this point
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  const fetchedAt = Date.now() - 3 * 24 * HOUR;   // three days ago
  const rec = { at: fetchedAt, place: PLACE, source: "open-meteo",
    hourly: series([today()], () => 62, () => 3) };
  writeCache(rec);
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "an old series is refreshed first — the store is the fallback, never the first answer");
  assert.ok(hasTile(), "a forecast fetched three days ago for today beats no forecast at all");
  const t = tile();
  assert.match(t.label, /^62°/, t.label);
  assert.equal(t.symbol, "cloud");
  assert.ok(t.footnote.endsWith("updated " + stamp(fetchedAt)),
    "the fetch time, not the build time, so a parent can see it is three days old: " + t.footnote);
  assert.deepEqual(readCache(), rec, "and a failed refresh leaves the store exactly as it was");
  rungs("ok", "ok");
});

test("both fail and the store does not cover today: no tile, and the next tick tries again", async () => {
  rungs("403", "dead");
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  writeCache({ at: Date.now() - 4 * HOUR, place: PLACE, source: "open-meteo",
    hourly: series([yesterday()], () => 99) });
  await clothing.rebuildToday();
  assert.ok(!hasTile(), "no weather at all: no tile (there is nothing true to put on it)");

  // still down: the tick tries the ladder, and a blind board is not redrawn
  // for nothing
  const board = path.join(TMP, "recipes", "today.json");
  const mtime = fs.statSync(board).mtimeMs;
  const asked = asks.length;
  const first = clothing.tick("test");
  assert.ok(first, "a board dealt with no weather is not the day's work: the tick acts");
  await first;
  assert.equal(asks.length, asked + 1, "...and what it does is ask again");
  assert.ok(!hasTile());
  assert.equal(fs.statSync(board).mtimeMs, mtime, "a retry that found nothing leaves the board alone");

  // the block lifts: the first success re-sorts
  rungs("ok", "ok");
  const second = clothing.tick("test");
  assert.ok(second, "still blind, so the tick tries again");
  const r = await second;
  assert.equal(r && r.mode, "cataloged", "a RE-SORT of what she has");
  assert.ok(hasTile(), "the weather is back on the board");
  assert.match(tile().label, /^70°/);
  assert.equal(clothing.tick("test"), null, "and the flag is spent: nothing left to retry");
});

test("under three hours the store is served with no call; older is refreshed, and only a success replaces it", async () => {
  rungs("ok", "ok");
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  const week = days(7);
  writeCache({ at: Date.now() - 1 * HOUR, place: PLACE, source: "weather.gov",
    hourly: series(week, () => 61) });
  let before = asks.length, nwsBefore = nwsHits.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before, "an hour old: no call");
  assert.equal(nwsHits.length, nwsBefore, "...to either service");
  assert.match(tile().label, /^61°/);

  writeCache({ at: Date.now() - 4 * HOUR, place: PLACE, source: "weather.gov",
    hourly: series(week, () => 61) });
  before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "four hours old: refreshed");
  assert.equal(readCache().source, "open-meteo", "a success replaces the store");
  assert.match(tile().label, /^70°/);

  rungs("403", "dead");
  const old = { at: Date.now() - 4 * HOUR, place: PLACE, source: "open-meteo",
    hourly: series(week, () => 61) };
  writeCache(old);
  before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before + 1, "the refresh was tried");
  assert.deepEqual(readCache(), old, "a failed refresh never truncates the week");
  assert.match(tile().label, /^61°/);
  rungs("ok", "ok");
});

test("weather.gov's sentence becomes the tile's picture", async () => {
  rungs("403", "ok");
  NWS_TEMP = 58;
  settings({ location: TYPED, weatherWindow: { from: 10, to: 14 } });
  for (const [sky, symbol] of [["Chance Showers And Thunderstorms", "rain"], ["Patchy Drizzle", "rain"],
                               ["Rain And Snow", "rain"], ["Light Snow", "cold"], ["Sleet", "cold"],
                               ["Snow Flurries", "cold"], ["Sunny", "sun"], ["Mostly Clear", "sun"],
                               ["Partly Cloudy", "cloud"], ["Patchy Fog", "cloud"]]) {
    NWS_SKY = sky;
    dropCache();
    await clothing.rebuildToday();
    assert.equal(tile().symbol, symbol, JSON.stringify(sky) + " should be " + symbol);
  }
  NWS_SKY = "Light Rain";
  rungs("ok", "ok");
});
