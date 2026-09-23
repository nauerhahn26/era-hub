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

// A flat synthetic day: every hour the same temperature and code. Phase 1 only
// cares about whether the forecast was FETCHED, never about the arithmetic —
// that is clothing-weather.test.mjs's job and it must stay untouched. The
// temperature is keyed on the POINT so a tile can name the place it was built
// for; `CODE` is the whole day's weather code, which the symbol tests move.
const TEMP_AT = new Map([[String(ELSEWHERE.lat), 85]]);
let CODE = 0;
function hourly(lat) {
  const time = [], temperature_2m = [], weather_code = [];
  for (let h = 0; h < 24; h++) {
    time.push("2026-09-23T" + String(h).padStart(2, "0") + ":00");
    temperature_2m.push(TEMP_AT.get(String(lat)) ?? 70);
    weather_code.push(CODE);
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
  wx = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/v1/forecast")) {
      asks.push(req.url);
      return json({ hourly: hourly(new URL(req.url, "http://x").searchParams.get("latitude")) });
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
           ERA_GEOCODE_URL: `http://127.0.0.1:${WX_PORT}/geocode` },
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
test("an unset window is 10 AM-2 PM, not the whole day", async () => {
  settings({});
  dropCache();
  await clothing.rebuildToday();
  const c = readCache();
  assert.equal(c.window, "10-14", "the default is the middle of the day");
  assert.deepEqual(c.w.window, { from: 10, to: 14 }, "and the tile is told which hours it read");
});

// A default is not a migration: rewriting hours a parent chose would be a
// surprise, and the two devices already carry explicit ones.
test("a window a parent chose is never rewritten by the default", async () => {
  settings({ weatherWindow: { from: 9, to: 12 } });
  dropCache();
  await clothing.rebuildToday();
  assert.equal(readCache().window, "9-12");
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
