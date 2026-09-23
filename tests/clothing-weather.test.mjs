// clothing-weather.test.mjs — the outfits are sorted for the hours she is
// OUT, not for the afternoon peak (dad 9/5: she dresses for a morning at
// school and the day's high comes hours later, so the daily high was "not
// perfectly useful"). app-settings.json's weatherWindow {from,to} (inclusive
// local hours) picks the hours read out of the hourly forecast. The hours in
// this file are invented — the family's own window is config, never a fixture.
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

// A synthetic day: a cool, rainy late morning (9-12, up to 67°F, rain at 9) and
// a hot, clear afternoon (16:00, 80°F, code 0). Hours 9-12 are invented test
// hours, not anybody's school day.
//
// BOTH ENDS of the window are decisive on purpose — the spec is inclusive, and
// an interior peak would let an off-by-one at either end pass unnoticed:
//   * hour 12 (the LAST hour of the 9-12 window) is the window's warmest, 67°F,
//     so an exclusive end would report 66° instead;
//   * hour 9 (the FIRST) carries the only bad weather code of the day, so an
//     exclusive start would report sun instead of cloud.
function hourly() {
  const time = [], temperature_2m = [], weather_code = [];
  for (let h = 0; h < 24; h++) {
    time.push("2026-09-05T" + String(h).padStart(2, "0") + ":00");
    temperature_2m.push(h === 9 ? 64 : h === 10 ? 66 : h === 11 ? 65 : h === 12 ? 67
                      : h === 16 ? 80 : h >= 13 ? 70 : 55);
    weather_code.push(h === 9 ? 61 : 0);
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
// every outfit's garment ids, from every today page (today, today_2, ...)
function dealtIds() {
  const r = JSON.parse(fs.readFileSync(path.join(TMP, "recipes", "today.json"), "utf8"));
  return r.boards.filter(b => /^today(_\d)?$/.test(b.id))
    .flatMap(b => b.buttons.filter(x => x.type === "outfit").flatMap(x => x.combo));
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
  // 400, not 500: a refusal the ingest does not retry, so the one test below
  // that deliberately DOES call it costs a second instead of a retry storm.
  ai = http.createServer((req, res) => { aiCalls++; res.writeHead(400).end("{}"); });
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
  // ...and four garments the band gate has an opinion about (spec §3.4):
  // a cold top (tops are never gated), a hot bottom, a cold bottom — and a
  // SECOND top the warm band admits exactly. Without that second warm top the
  // "tops never gated" assertion under the warm band could not fail: a gated
  // top pool would hold one exact match, the widen rule (clothing-rank.js
  // eligible, "< 2 exact takes the neighbour bands too") would re-admit the
  // cold top anyway, and the test would pass whether tops were gated or not
  // (review r1). With two exact warm tops the widen never runs, so the cold
  // top is on the board only because tops are ungated.
  makeJpg(path.join(TMP, "clothing", "coldtop.jpg"), 120, 40, 160);
  makeJpg(path.join(TMP, "clothing", "warmtop.jpg"), 80, 180, 100);
  makeJpg(path.join(TMP, "clothing", "hotbot.jpg"), 240, 200, 40);
  makeJpg(path.join(TMP, "clothing", "coldbot.jpg"), 40, 140, 140);
  makeJpg(path.join(TMP, "wardrobe-items", "item_coldtop.jpg"), 120, 40, 160);
  makeJpg(path.join(TMP, "wardrobe-items", "item_warmtop.jpg"), 80, 180, 100);
  makeJpg(path.join(TMP, "wardrobe-items", "item_hotbot.jpg"), 240, 200, 40);
  makeJpg(path.join(TMP, "wardrobe-items", "item_coldbot.jpg"), 40, 140, 140);
  // attrsAt on every entry: a garment that has already been described is one
  // the needs-attributes pass (T3.2) walks past, so this suite's "the AI is
  // never called" pins hold on the full-build doors too. A fixed day, never
  // today's — the marker's presence is what counts, not its value.
  const DESCRIBED = "2026-09-01";
  fs.writeFileSync(path.join(TMP, "wardrobe.json"), JSON.stringify({ items: {
    "top.jpg": { id: "item_top", ok: true, name: "Heart print tee", category: "top", warmth: "any", attrsAt: DESCRIBED },
    "bot.jpg": { id: "item_bot", ok: true, name: "Pink leggings", category: "pants", warmth: "any", attrsAt: DESCRIBED },
    "coldtop.jpg": { id: "item_coldtop", ok: true, name: "Wool sweater", category: "top", warmth: "cold", attrsAt: DESCRIBED },
    "warmtop.jpg": { id: "item_warmtop", ok: true, name: "Sunny tee", category: "top", warmth: "warm", attrsAt: DESCRIBED },
    "hotbot.jpg": { id: "item_hotbot", ok: true, name: "Linen shorts", category: "shorts", warmth: "hot", attrsAt: DESCRIBED },
    "coldbot.jpg": { id: "item_coldbot", ok: true, name: "Fleece pants", category: "pants", warmth: "cold", attrsAt: DESCRIBED },
  } }, null, 1));
  // a key IS configured — the point is that the rebuild door still never calls it
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  clothing = require("./clothing.js");
  // No schedule: this suite drives the rebuild door itself, and the scheduler's
  // 20 s startup tick would fire a FULL build (ingest + AI) if the suite ever
  // ran that long — the very thing the last test here proves cannot happen.
  clothing.start(TMP, { noTimers: true });
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
  assert.match(t.label, /^67°/, "67°F is the peak of 9-12, not the 80° at 4 PM");
  assert.match(t.label, /warm/);
  // UPDATED 9/23 (weather unit A, spec §3.6): code 61 IS rain, and the symbol
  // map used to call everything from drizzle to a thunderstorm cloud or cold.
  // Which hour wins is unchanged — that is still max(weather_code).
  assert.equal(t.symbol, "rain", "the worst code over those hours (61 = rain) picks the symbol");
});

// The two ends of the window, pinned separately: 67° lives at hour 12 (the last
// hour) and the rain at hour 9 (the first), so dropping either end changes what
// the tile says. Without this the suite would pass with an exclusive end.
test("both ends of the window are inclusive", async () => {
  const t = tile();
  assert.match(t.label, /^67°/, "hour 12 is INSIDE 9-12: its 67° is the peak read");
  assert.equal(t.symbol, "rain", "hour 9 is INSIDE 9-12: its rain code picks the symbol");
  assert.match(t.say, /about 67 degrees/);
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
  assert.match(t.say, /Between 9 AM and 12 PM it is warm, about 67 degrees\./);
  // UPDATED 9/23 (weather unit A, spec §3.6): the footnote leads with the
  // PLACE. Nothing typed here, so it says the point is the network's guess —
  // which is the state that made every reading cold for eleven days running.
  assert.match(t.footnote, /^approximate location · for 9 AM-12 PM · updated /, t.footnote);
});

// UPDATED 9/23 (weather unit A, spec §3.5): an unset window used to mean the
// WHOLE DAY, and this case pinned that — "no window = the whole day, worded as
// before", 80° and hot off the 4 PM peak. The whole day is exactly what read
// warm while the hours she was actually outside did not, so the default is now
// 10 AM-2 PM: a child dresses for the middle of her day, not for the afternoon
// high. An unset window no longer means the whole day at all (a family that
// wants it stores 0-23, the test below), and hour 9's rain now falls OUTSIDE
// the default window, so the symbol is the clear sky of the hours that are read.
test("no window = 10 AM-2 PM, the middle of her day", async () => {
  setWindow(null);
  const t = await rebuild();
  assert.match(t.label, /^70°/, "10-14 peaks at 70°F, not the 80° at 4 PM");
  assert.match(t.label, /warm/);
  assert.equal(t.symbol, "sun", "the 61 at hour 9 is outside the default window");
  assert.equal(t.say, "Between 10 AM and 2 PM it is warm, about 70 degrees.");
  assert.match(t.footnote, /^approximate location · for 10 AM-2 PM · updated /, t.footnote);
});

test("an afternoon window gets the afternoon's sun", async () => {
  setWindow({ from: 14, to: 17 });
  const t = await rebuild();
  assert.match(t.label, /^80°/);
  assert.match(t.label, /hot/);
  assert.equal(t.symbol, "sun");
  assert.match(t.say, /Between 2 PM and 5 PM/);
  assert.match(t.footnote, /^approximate location · for 2 PM-5 PM · /, t.footnote);
});

// A family that really does want the whole day now says so: Settings stores
// 0-23 rather than deleting the key (plan T5.0), because a deleted key is
// 10 AM-2 PM. The hours are then read out as "all day" — "for 12 AM-11 PM" is
// accurate and nobody says it.
test("the whole day is called the whole day, not 12 AM-11 PM", async () => {
  setWindow({ from: 0, to: 23 });
  const t = await rebuild();
  assert.match(t.label, /^80°/, "every hour is read, so the 4 PM peak wins again");
  assert.equal(t.say, "All day it is hot, about 80 degrees.");
  assert.match(t.footnote, /^approximate location · for all day · updated /, t.footnote);
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
  assert.match(tile().label, /^67°/);
  // ...and the record now carries the window it was computed for
  const c = JSON.parse(fs.readFileSync(path.join(TMP, ".weather-cache.json"), "utf8"));
  assert.equal(c.window, "9-12");
});

test("the same window inside 3 hours is answered from the cache", async () => {
  const before = asks.length;
  await clothing.rebuildToday();
  assert.equal(asks.length, before, "no second lookup for the same window");
});

// Setting a window necessarily POSTs twice (pick the first hour, then the
// second), so the second re-sort lands while the first is still running and
// goes through the QUEUE. A queued run used to be re-dispatched as a full
// build — photo ingest, AI requests — which is exactly what this door promises
// never to do.
test("a re-sort queued behind a running re-sort is still only a re-sort", async () => {
  setWindow({ from: 14, to: 17 });
  const first = clothing.rebuildToday();
  const second = clothing.rebuildToday();   // arrives mid-build: queued
  await Promise.all([first, second]);
  assert.equal(aiCalls, 0, "the queued run did not turn into a full ingest");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(!cat.items["waiting.jpg"], "the uncatalogued photo was left alone by both runs");
  assert.match(tile().label, /^80°/, "and the board really was re-sorted for 2-5 PM");
});

test("the rebuild door never wakes the AI (photos wait for a real run)", async () => {
  assert.equal(aiCalls, 0, "waiting.jpg was NOT ingested: rebuildToday() re-sorts only");
  const cat = JSON.parse(fs.readFileSync(path.join(TMP, "wardrobe.json"), "utf8"));
  assert.ok(!cat.items["waiting.jpg"], "the uncatalogued photo is still waiting");
});

// The band gate is the original's (outfit_set.py:397-402, spec §3.4): bottoms
// and singles are gated by the hours she is out, TOPS NEVER ARE — a sweater
// on a hot day is her call, a fleece pant on a hot day is not dealt.
test("a hot window: tops never gated (the cold top is dealt), the hot bottom is dealt, cold bottom absent from every page", async () => {
  setWindow({ from: 14, to: 17 });
  const t = await rebuild();
  assert.ok(t.label.includes("hot"), "the 2-5 PM window really is hot: " + t.label);
  const ids = dealtIds();
  assert.ok(ids.includes("item_coldtop"), "the cold top is still on the board");
  assert.ok(ids.includes("item_hotbot"), "the hot bottom is dealt");
  assert.ok(!ids.includes("item_coldbot"), "the cold bottom is absent from every look of every page");
  assert.equal(aiCalls, 0);
});

// The warm band admits levels {1,2}: the plain top and the warm top are two
// EXACT matches, so a gated top pool would stop at those two and the cold top
// (level 3) could not be widened back in. The cold top is on the board only
// because tops are never gated (review r1).
test("a warm window: tops never gated (the cold top is dealt), cold bottom absent", async () => {
  setWindow({ from: 9, to: 12 });
  const t = await rebuild();
  assert.match(t.label, /^67°/, "the 9-12 window is warm, not hot");
  const ids = dealtIds();
  assert.ok(ids.includes("item_warmtop"), "the two warm-eligible tops are dealt: no widening is possible");
  assert.ok(ids.includes("item_top"));
  assert.ok(ids.includes("item_coldtop"), "the cold top is still on the board");
  assert.ok(!ids.includes("item_coldbot"), "a cold bottom is not for a warm day");
  assert.equal(aiCalls, 0);
});

// A profile can name a zone this computer does not know: "Pacific Time" and
// "America/Los_Angelos" are not IANA names, and dayKey (toLocaleDateString
// with timeZone) throws RangeError on them. Since the deal is seeded with the
// family's day key, an unchecked zone threw inside the worker, recipes/
// today.json was never rewritten and the board was simply gone, every build,
// with one console line as the only signal (review r1). The shell probes the
// zone at spawn and falls back to its default instead.
test("a profile time zone this computer does not know still builds today's board", async () => {
  clothing.start(TMP, { noTimers: true, tz: () => "Pacific Time" });
  setWindow({ from: 14, to: 17 });
  const t = await rebuild();
  assert.match(t.label, /^80°/, "the board was rebuilt for the 2-5 PM window");
  assert.ok(dealtIds().includes("item_hotbot"), "and it really has outfits on it");
  assert.equal(aiCalls, 0);
  clothing.start(TMP, { noTimers: true });   // really back to the module's own default (below)
});

// The BUILD half of "an unreadable history.json is never overwritten" (spec
// §3.3, plan T2.2). /outfit-event's half is pinned in pool.test.mjs; this is
// the door that runs every ten minutes on a Drive-local family, so it is the
// one a transient EBUSY/EPERM (a backup, a virus scanner holding the file)
// really meets. readHistory rethrows, and the ONE catch around recordOffer
// (clothing.js) turns that into "log it and keep the board" — without it the
// throw lands in the worker's message listener and takes the hub down.
test("a history.json the build cannot open is left alone and the board is still built", {
  skip: process.getuid && process.getuid() === 0 ? "root reads every file" : false,
}, async () => {
  const dir = path.join(TMP, "wardrobe");
  const hp = path.join(dir, "history.json");
  fs.mkdirSync(dir, { recursive: true });
  const seed = JSON.stringify({
    days: { "2026-07-01": { band: null, page1: [["item_top", "item_bot"]] } },
    events: { "2026-07-01": [{ kind: "yes", combo: ["item_top", "item_bot"] }] } });
  fs.writeFileSync(hp, seed);
  const asideBefore = fs.readdirSync(dir).filter(f => f.startsWith("history.json.bad-")).length;
  fs.chmodSync(hp, 0o000);
  try {
    const r = await clothing.rebuildToday();
    assert.equal(r.mode, "cataloged", "the board is still built");
  } finally { fs.chmodSync(hp, 0o644); }
  assert.equal(fs.readFileSync(hp, "utf8"), seed, "sixty days of memory are byte-for-byte what they were");
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith("history.json.bad-")).length, asideBefore,
    "nothing is wrong with the bytes, so nothing is set aside either");
});

// recordOffer overwrites the day wholesale, so a deal with nothing in it would
// replace the morning's seven-look lineup with none — and that day would then
// contribute nothing to tomorrow's yesterday-bar or freshness. A build can
// deal nothing whenever every tile is gone (the same precondition the tile
// repair exists for), which is exactly when the memory matters most (r2).
test("a build that can draw nothing leaves the day's recorded lineup alone", async () => {
  const hp = path.join(TMP, "wardrobe", "history.json");
  await rebuild();
  const before = JSON.parse(fs.readFileSync(hp, "utf8"));
  const today = Object.keys(before.days).sort().pop();
  assert.ok(before.days[today].page1.length > 0, "the morning build recorded a lineup");
  const items = path.join(TMP, "wardrobe-items");
  const kept = fs.readdirSync(items).map(f => [f, fs.readFileSync(path.join(items, f))]);
  kept.forEach(([f]) => fs.rmSync(path.join(items, f)));
  try {
    await clothing.rebuildToday();
    // ...and the build really did draw nothing: without this the case would
    // stay green if a missing tile ever stopped emptying the deal, while
    // asserting nothing about the guard it exists for (r3).
    assert.equal(dealtIds().length, 0, "every tile is gone: the deal is empty");
  } finally { kept.forEach(([f, b]) => fs.writeFileSync(path.join(items, f), b)); }
  const after = JSON.parse(fs.readFileSync(hp, "utf8"));
  assert.deepEqual(after.days[today], before.days[today], "the day the board went blank still remembers its lineup");
});

// Two set-asides in the same millisecond used to pick the same name, and the
// second rename clobbered the first quarantined copy — bytes this path exists
// to preserve (r2). The sentinels below cover the millisecond the next
// set-aside can land in, so the collision is certain, not a race.
test("a set-aside never lands on a name that is already taken", () => {
  const dir = path.join(TMP, "wardrobe");
  const hp = path.join(dir, "history.json");
  const now = Date.now();
  const sentinels = [];
  for (let t = now; t <= now + 100; t++) {
    const f = path.join(dir, "history.json.bad-" + t);
    fs.writeFileSync(f, "sentinel " + t);
    sentinels.push([f, "sentinel " + t]);
  }
  fs.writeFileSync(hp, "{ not json");
  clothing.readHistory();
  try {
    for (const [f, want] of sentinels)
      assert.equal(fs.readFileSync(f, "utf8"), want, "an earlier set-aside was overwritten: " + path.basename(f));
    const asides = fs.readdirSync(dir).filter(f => f.startsWith("history.json.bad-"));
    assert.equal(asides.filter(f => fs.readFileSync(path.join(dir, f), "utf8") === "{ not json").length, 1,
      "the unreadable bytes are kept under a name of their own");
  } finally {
    for (const f of fs.readdirSync(dir).filter(f => f.startsWith("history.json.bad-")))
      fs.rmSync(path.join(dir, f));
  }
});

// history.json has TWO doors (spec §3.3, A4-1): the build's recordOffer and
// POST /outfit-event. Validating the zone on the build side alone only moved
// the damage — the board came back and every Yes was answered 400 instead,
// silently, forever, so favourites could never be learned (review r2). One
// validated zone, both doors.
test("the pick recorder buckets by the shell's validated zone, never the raw profile one", () => {
  const src = fs.readFileSync(path.join(HUB, "server.js"), "utf8");
  assert.match(src, /dayKey\(Date\.now\(\), clothing\.zone\(\)\)/,
    "POST /outfit-event takes its day key from clothing.zone()");
  assert.ok(!/dayKey\(Date\.now\(\), TZ\)/.test(src), "the unvalidated profile zone never reaches dayKey");
});

test("zone() answers the module default for a zone this computer cannot resolve", () => {
  clothing.start(TMP, { noTimers: true, tz: () => "Pacific Time" });
  assert.equal(clothing.zone(), "America/Los_Angeles");
  clothing.start(TMP, { noTimers: true, tz: () => "Pacific/Kiritimati" });
  assert.equal(clothing.zone(), "Pacific/Kiritimati", "a zone it CAN resolve is honoured as it is");
});

// start() used to assign the getter only when one was passed, so a suite could
// never hand the zone back — the line above pretended to and did not (r2).
test("start() without a zone is back to the module's own default", () => {
  clothing.start(TMP, { noTimers: true, tz: () => "Pacific/Kiritimati" });
  clothing.start(TMP, { noTimers: true });
  assert.equal(clothing.zone(), "America/Los_Angeles");
});

// The OTHER reader of history.json is the worker's, and it used to answer "no
// memory" for every read error the shell rethrows. A file whose bytes will not
// come for a moment (a backup, a scanner) therefore dealt a board with no
// staples, no yesterday bar and no freshness — while the shell's recorder threw
// on the same file, so that day was never recorded either — and recipes/
// today.json was rewritten all the same, so the memory-free board STOOD as the
// day's work until the next forced door (r3). The worker retries the read,
// then says it dealt blind; the tick builds again rather than leave it up.
// The three memory cases below share one data dir and run in order: T3 is made
// by the first and carried by the two after it (the module is pointed at it).
const rootHere = process.getuid && process.getuid() === 0 ? "root reads every file" : false;
let T3 = null;
const memPath = () => path.join(T3, "wardrobe", "history.json");
const daysOf = () => JSON.parse(fs.readFileSync(memPath(), "utf8")).days;

test("a build that could not read the memory is not the day's work", {
  skip: rootHere,
}, async () => {
  T3 = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-wx3-"));
  fs.mkdirSync(path.join(T3, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(T3, "wardrobe-items"), { recursive: true });
  makeJpg(path.join(T3, "clothing", "top.jpg"), 210, 70, 90);
  makeJpg(path.join(T3, "clothing", "bot.jpg"), 70, 90, 210);
  // One photo nobody has named: it makes a FULL build reach the fake AI, which
  // is what gives the "no model request was spent" assertions below their bite
  // (a re-sort never opens the photo folder at all).
  makeJpg(path.join(T3, "clothing", "waiting.jpg"), 200, 200, 70);
  makeJpg(path.join(T3, "wardrobe-items", "item_top.jpg"), 210, 70, 90);
  makeJpg(path.join(T3, "wardrobe-items", "item_bot.jpg"), 70, 90, 210);
  fs.writeFileSync(path.join(T3, "wardrobe.json"), JSON.stringify({ items: {
    "top.jpg": { id: "item_top", ok: true, name: "Sunny tee", category: "top", warmth: "any", attrsAt: "2026-09-01" },
    "bot.jpg": { id: "item_bot", ok: true, name: "Pond leggings", category: "pants", warmth: "any", attrsAt: "2026-09-01" },
  } }, null, 1));
  fs.writeFileSync(path.join(T3, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  clothing.start(T3, { noTimers: true });
  const spentByFull = aiCalls;
  await clothing.regenerate(true);
  assert.ok(aiCalls > spentByFull, "a FULL build in this fixture really does ask the model");
  const hp = memPath();
  assert.ok(Object.keys(daysOf()).length, "the healthy build recorded the day it dealt");
  // The leftover photo has an hourly door of its own (the AI refused it): let
  // that door fire once, so every tick after this one is only ever about the
  // memory. It lands nothing, so the day's allowance is held from here on.
  const retry = clothing.tick("test");
  assert.ok(retry, "the photo nobody could name is retried within the hour");
  await retry;
  assert.ok(clothing.status().heldToday, "...and a retry that landed nothing holds the day");
  assert.equal(clothing.tick("test"), null, "a board dealt with her memory is the day's work");

  // Empty the memory before locking it, so the recovery build below has a hole
  // to fill: without this the case never asserts that the day comes back.
  fs.writeFileSync(hp, JSON.stringify({ days: {}, events: {} }));
  const memory = fs.readFileSync(hp, "utf8");
  fs.chmodSync(hp, 0o000);
  let r;
  try { r = await clothing.rebuildToday(); } finally { fs.chmodSync(hp, 0o644); }
  assert.equal(r.mode, "cataloged", "a locked memory file never costs her the board");
  assert.equal(r.historyUnread, true, "...but the build says it dealt without her memory");
  assert.equal(fs.readFileSync(hp, "utf8"), memory, "the memory it could not read is untouched");

  const spent = aiCalls;
  const again = clothing.tick("test");
  assert.ok(again, "the next tick deals again instead of leaving the memory-free board up");
  const r2 = await again;
  assert.ok(!r2.historyUnread, "the second build read the memory");
  assert.equal(aiCalls, spent,
    "the re-deal is a RE-SORT: a memory that will not open never spends a model request");
  const days = daysOf();
  assert.equal(Object.keys(days).length, 1, "the day the memory came back is recorded");
  assert.ok(days[Object.keys(days)[0]].page1.length > 0, "...with the lineup it dealt");
  assert.equal(clothing.tick("test"), null, "...and once it has, the board is the day's work again");
});

// The re-deal above is a RETRY, and a retry with no bound is a loop: while the
// file stays shut every 15-minute pass would run another build, and while it
// was a FULL build each pass walked the provider ladder again for the photo
// still waiting — four times an hour into an allowance the hub already holds
// (clothing.js's own rule two lines up: "an hourly loop into the same wall
// would only spend the free requests"). One extra deal, then the board on
// screen stands (review r4).
test("a memory that stays shut buys ONE re-deal, not a build every fifteen minutes", {
  skip: rootHere,
}, async () => {
  const hp = memPath();
  assert.equal(clothing.tick("test"), null, "settled before the lock");
  fs.chmodSync(hp, 0o000);
  try {
    const blind = await clothing.rebuildToday();
    assert.equal(blind.historyUnread, true, "the forced door dealt blind");
    assert.ok(clothing.status().heldToday, "the day's allowance is already held");
    const spent = aiCalls;
    const one = clothing.tick("test");
    assert.ok(one, "the blind board buys one more deal");
    assert.equal((await one).historyUnread, true, "...which still could not read it");
    assert.equal(clothing.tick("test"), null, "and that is the end of it, not a build every pass");
    assert.equal(clothing.tick("test"), null, "...still nothing to do on the pass after that");
    assert.equal(aiCalls, spent,
      "not one model request was spent on a file that will not open");
  } finally { fs.chmodSync(hp, 0o644); }
});

// Only the READ half of the recorder was hardened at r3. When the WRITE fails
// — writeAtomic is writeFileSync(tmp) + rename, and a rename over a file a
// backup is holding is EPERM on the family's Windows box — the day's page-1
// lineup was silently lost from the sixty-day memory: no retry, no flag, no
// re-deal, and the next morning yesterday's page-1 looks came back on page 1
// because no day had been recorded to bar them (review r4).
test("a lineup the memory would not accept is not lost: the next pass records it", {
  skip: rootHere,
}, async () => {
  const dir = path.join(T3, "wardrobe");
  // A healthy build first: the memory works, so the re-deal budget the case
  // above spent is back (a build that reads AND records clears it).
  await clothing.rebuildToday();
  assert.ok(Object.keys(daysOf()).length, "the memory is working again");
  fs.writeFileSync(memPath(), JSON.stringify({ days: {}, events: {} }));
  assert.equal(clothing.tick("test"), null, "settled before the write is blocked");
  fs.chmodSync(dir, 0o555);           // the tmp file writeAtomic renames from cannot be made
  let r;
  try { r = await clothing.rebuildToday(); } finally { fs.chmodSync(dir, 0o755); }
  assert.equal(r.mode, "cataloged", "a memory that will not take the write never costs her the board");
  assert.deepEqual(daysOf(), {}, "the day really was not recorded");

  const again = clothing.tick("test");
  assert.ok(again, "a lineup that was not recorded is not the day's work either");
  await again;
  const days = daysOf();
  assert.equal(Object.keys(days).length, 1, "the pass after it records the day");
  assert.ok(days[Object.keys(days)[0]].page1.length > 0, "...with the lineup it dealt");
  assert.equal(clothing.tick("test"), null, "and then it is settled");
});

// I9: the worker posts the page-1 lineup to the shell BEFORE it draws the
// composites and writes the board — "the memory tomorrow's deal reads must not
// depend on every picture surviving". Nothing exercised that ordering: moving
// the post below the draw (or into the {done} payload) left every case green
// (review r4). Here the board cannot be written at all, and the day is
// remembered anyway.
test("the day's lineup is recorded even when the board itself cannot be written", {
  skip: rootHere,
}, async () => {
  const recipes = path.join(T3, "recipes");
  fs.writeFileSync(memPath(), JSON.stringify({ days: {}, events: {} }));
  // The board file has to be CREATED for the write to need the folder: an
  // existing today.json is opened by permissions of its own and lands happily
  // in a read-only folder (the first shape of this case did exactly that and
  // proved nothing).
  fs.rmSync(path.join(recipes, "today.json"), { force: true });
  fs.chmodSync(recipes, 0o555);
  let r;
  try { r = await clothing.rebuildToday(); } finally { fs.chmodSync(recipes, 0o755); }
  assert.ok(r.error, "the build really did die on the board it could not write: " + JSON.stringify(r));
  const days = daysOf();
  assert.equal(Object.keys(days).length, 1, "...and the lineup it dealt was recorded all the same");
  assert.ok(days[Object.keys(days)[0]].page1.length > 0, "...with the looks it dealt");
});

// The blind-memory door and the freshness door answer DIFFERENT builds: a
// re-sort for a board that is otherwise the day's work, the morning's FULL
// build for one that predates this morning's cutoff (spec §3.5). Asking the
// blind flag FIRST made it REPLACE the stale-board door instead of borrowing
// it, so a blind deal that happened to be the last thing before 05:00
// downgraded that morning to a re-sort — and a re-sort never runs ingest,
// which is the only door that redraws a tile that has gone missing (QA 9/2:
// a wipe left 20 catalogued items with 5 tiles). The garment was then in no
// outfit for the rest of the day, because nothing re-opens either door once
// the board is fresh again (review r5).
test("a stale board still gets the morning's FULL build when the last deal was blind", {
  skip: rootHere,
}, async () => {
  const hp = memPath();
  await clothing.rebuildToday();               // healthy: the memory is read and recorded
  assert.equal(clothing.tick("test"), null, "settled before the blind deal");

  fs.chmodSync(hp, 0o000);
  try { assert.equal((await clothing.rebuildToday()).historyUnread, true, "the last deal was blind"); }
  finally { fs.chmodSync(hp, 0o644); }

  const board = path.join(T3, "recipes", "today.json");
  const stale = new Date(Date.now() - 30 * 3600e3);
  fs.utimesSync(board, stale, stale);
  assert.equal(clothing.boardIsFresh(T3), false, "...and the board it left predates this morning");

  const tileOf = (f) => {
    const c = JSON.parse(fs.readFileSync(path.join(T3, "wardrobe.json"), "utf8"));
    return path.join(T3, "wardrobe-items", c.items[f].id + ".jpg");
  };
  fs.rmSync(tileOf("top.jpg"));                // only ingest redraws a tile

  const build = clothing.tick("test");
  assert.ok(build, "the morning tick builds");
  await build;
  // the id is re-read: a repair re-derives it from the photo's name, so the
  // hand-seeded "item_top" of this fixture becomes the worker's own id
  assert.ok(fs.existsSync(tileOf("top.jpg")),
    "the tick ran the morning's FULL build: the garment's lost tile was redrawn");
  assert.equal(clothing.tick("test"), null, "...and the day's board is settled");
});

// Tomorrow, for the shell's own clock: the module reads `new Date()` directly
// (boardIsFresh's 5am cutoff, holdDay, the re-deal budget below), so a case
// about "the next day" has to move that clock and put it back. A subclass
// rather than node:test's mock.timers: this needs Date and nothing else, and
// the mock API prints an ExperimentalWarning into the gate's log.
const RealDate = Date;
async function tomorrow(fn) {
  const shift = 24 * 3600e3;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); }
    static now() { return RealDate.now() + shift; }
  };
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

// The re-deal budget belongs to the DAY, the way holdDay does. Counted per
// OUTAGE and cleared only by a build that succeeds, the one re-deal was spent
// for good: a history.json shut for a moment on two mornings running left the
// second morning's blind board standing — no staples, no yesterday bar, no day
// recorded — and bought no re-deal at all (review r5).
test("tomorrow's memory trouble buys tomorrow's re-deal", {
  skip: rootHere,
}, async () => {
  const hp = memPath();
  const board = path.join(T3, "recipes", "today.json");
  const freshen = () => { const t = Date.now() / 1000; fs.utimesSync(board, t, t); };
  // Nothing left for the hourly leftovers door to want: it shares this branch
  // with the re-deal, and a photo still waiting would fire a build of its own
  // tomorrow whatever the memory did — so the case would pass either way.
  const cat = JSON.parse(fs.readFileSync(path.join(T3, "wardrobe.json"), "utf8"));
  cat.items["waiting.jpg"] = { id: "item_waiting", ok: true, name: "Sunny shorts",
    category: "shorts", warmth: "any", attrsAt: "2026-09-01" };
  fs.writeFileSync(path.join(T3, "wardrobe.json"), JSON.stringify(cat, null, 1));
  makeJpg(path.join(T3, "wardrobe-items", "item_waiting.jpg"), 200, 200, 70);

  await clothing.rebuildToday();                    // healthy: the budget is clear
  assert.equal(clothing.tick("test"), null, "settled before the outage");

  fs.chmodSync(hp, 0o000);
  try {
    assert.equal((await clothing.rebuildToday()).historyUnread, true, "today's deal was blind");
    const one = clothing.tick("test");
    assert.ok(one, "today's one re-deal");
    await one;
    assert.equal(clothing.tick("test"), null, "...and today's budget is spent");

    await tomorrow(async () => {
      const blind = await clothing.rebuildToday();  // the file is still shut
      assert.equal(blind.historyUnread, true, "tomorrow's deal is blind too");
      freshen();
      assert.equal(clothing.boardIsFresh(T3), true, "...and its board is tomorrow's own");
      const two = clothing.tick("test");
      assert.ok(two, "a new day buys a new re-deal");
      await two;
      freshen();
      assert.equal(clothing.tick("test"), null, "...one, and only one");
    });
  } finally { fs.chmodSync(hp, 0o644); }
});

// LAST — it repoints the module at a second data dir and lets the fake AI be
// called, so it must run after the aiCalls assertions above.
//
// A hub with photos but nothing catalogued yet is being COACHED ("Today's free
// AI allowance is used up", "the AI helper is busy"). A window change re-sorts
// through a door that never ran ingest, so it knows nothing about the
// allowance — it must not answer that question and drop the family to the
// generic message for the rest of the day (holdDay suppresses the retry that
// would restore it).
test("a re-sort with nothing catalogued leaves the board's coaching alone", async () => {
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-wx2-"));
  fs.mkdirSync(path.join(T2, "clothing"), { recursive: true });
  makeJpg(path.join(T2, "clothing", "unnamed.jpg"), 90, 200, 120);
  fs.writeFileSync(path.join(T2, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  clothing.start(T2, { noTimers: true });

  const full = await clothing.regenerate(true);          // a REAL run: the fake AI refuses
  assert.ok(full.guidance, "the real run has a verdict: " + JSON.stringify(full));
  const coaching = clothing.status().guidance;
  assert.equal(coaching, full.guidance);

  const r = await clothing.rebuildToday();
  assert.equal(r.rebuildOnly, true, "a re-sort with no catalogue says only that");
  assert.ok(!r.guidance, "...and passes no verdict of its own: " + JSON.stringify(r));
  assert.equal(clothing.status().guidance, coaching, "the coaching the board shows is untouched");
});
