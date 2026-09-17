// clothing-accessories.test.mjs — jackets, shoes and a parent's last word
// (accessories spec 2026-09-17, §3 and §4).
//
// Two halves, in the order the hub meets them:
//
//   * THE CLASSIFIER (T3, spec §3.3). One prompt asks for eleven category
//     words instead of five and for an `occasion`; the whitelist that catches
//     the answer is the one exported list (`CATEGORIES`), so the prompt, the
//     catalogue and the pools cannot drift apart (preflight 1). An unknown
//     word is still a "top" and a missing occasion is still "everyday" — the
//     model is allowed to be wrong, and the hold sheet is how it gets fixed.
//
//   * THE MANUAL SWEEP (T4, spec §3.4). A parent's correction outranks the
//     model for ever: it lands in `wardrobe/edits.json` on the device the
//     parent touched and in a `manual: true` tag line for everyone else, and
//     every build — a full one or a weather re-sort — re-applies the newest of
//     the two before it deals a single look. `hidden` items leave the board
//     entirely, including the ones yesterday's page 1 remembers (preflight 18).
//
// No key is ever spent: the only "AI" is a local fake on 8467 (plan §B) that
// answers whatever the case queued for it and records what it was asked. Port
// 8465 is this suite's hub door and belongs to T6's route cases; nothing here
// binds it. Every id, name and colour is invented.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { materialize, idFor } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AI_PORT = 8467;                    // plan §B: this suite's fake model
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey, yesterdayOf, GARMENT_KINDS, ACCESSORY_KINDS } = require("./clothing-rank.js");
const drive = require("./drive.js");
const clothing = require("./clothing.js");

// One clock for the suite, and deliberately NEITHER of the two wrong answers a
// worker can give: not this box's own zone and not the module's default
// (America/Los_Angeles) — see tests/clothing.test.mjs for the full reasoning.
const ZONE = (() => {
  const now = Date.now();
  const box = dayKey(now, "UTC"), mod = dayKey(now, "America/Los_Angeles");
  const ends = ["Pacific/Kiritimati", "Etc/GMT+12"];
  return ends.find(z => dayKey(now, z) !== box && dayKey(now, z) !== mod)
      || ends.find(z => dayKey(now, z) !== box) || ends[0];
})();
const today = () => dayKey(Date.now(), ZONE);
const KINDS = [...GARMENT_KINDS, ...ACCESSORY_KINDS.map(k => k.id)];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-acc-"));
const SEAMS = {
  ERA_AI_URL: `http://127.0.0.1:${AI_PORT}`,
  // A dead loopback port keeps the suite local: no key is spent on weather and
  // the band is null, so nothing here is gated by the sky.
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_AI_SPACING_MS: "50",
};

let ai;
const asks = [];        // the TEXT half of every request: what the model was asked
const queue = [];       // the answers the next calls get, in order
// Everything a real ingest answer carries, so a case only has to say what it
// is about.
const ANSWER = { name: "Clover tee", category: "top", warmth: "warm", top_side: "top",
  crop: { x: 0, y: 0, w: 1, h: 1 },
  colors: ["blue"], pattern: "solid", statement: false, palette: "cool", vibe: "basic" };
let replyBytes = 0;     // the longest reply the fake has sent (the max_tokens measure)
// The sky, when a case wants one: invented coordinates and an invented day.
// `sky` is the hourly forecast the fake serves, or null for "no weather at
// all", which is what every other case in this file runs under.
const GEO = { latitude: 41.5, longitude: -81.7 };
let sky = null;
// A whole day at one temperature — the band is all these cases care about.
function allDayAt(f) {
  const time = [], temperature_2m = [], weather_code = [];
  for (let h = 0; h < 24; h++) {
    time.push("2026-09-17T" + String(h).padStart(2, "0") + ":00");
    temperature_2m.push(f);
    weather_code.push(0);
  }
  return { hourly: { time, temperature_2m, weather_code } };
}
// Run one build under a real forecast: the two weather seams point at the fake
// for the length of the call and go back to their dead port afterwards, so no
// later case inherits a sky.
async function underSky(forecast, fn) {
  sky = forecast;
  process.env.ERA_GEO_URL = `http://127.0.0.1:${AI_PORT}/geo`;
  process.env.ERA_WEATHER_URL = `http://127.0.0.1:${AI_PORT}`;
  try { return await fn(); }
  finally {
    sky = null;
    process.env.ERA_GEO_URL = SEAMS.ERA_GEO_URL;
    process.env.ERA_WEATHER_URL = SEAMS.ERA_WEATHER_URL;
  }
}

function jpeg() { return require("./vendor/jpeg-js"); }
function makeJpg(file, w, h, r, g, b) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg().encode({ data, width: w, height: h }, 85).data);
}
let colour = 0;
// A photo nobody has seen before, in a colour no other photo in this suite
// has: a hash-keyed match must never collide (I15).
function photo(dir, rel) {
  colour += 17;
  makeJpg(path.join(dir, "clothing", rel), 320, 480, (colour * 3) % 200 + 20, (colour * 7) % 200 + 20, colour % 200 + 20);
  return rel;
}
function withKey(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-not-a-real-key" }));
}
function dataDir(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(path.join(d, "clothing"), { recursive: true });
  return d;
}
const catalogOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "wardrobe.json"), "utf8")).items;
const entryFor = (dir, id) => Object.values(catalogOf(dir)).find(i => i.id === id);
// <DATA>/wardrobe/edits.json — this device's own corrections (spec §4.2). The
// ROUTE writes it (T6); every case here lays it down by hand, which is also
// how the worker's read-only rule is measured.
const editsPath = (dir) => path.join(dir, "wardrobe", "edits.json");
function writeEdits(dir, edits) {
  fs.mkdirSync(path.join(dir, "wardrobe"), { recursive: true });
  fs.writeFileSync(editsPath(dir), typeof edits === "string" ? edits : JSON.stringify(edits, null, 1));
}
// A manual tag line as another device's hub would have appended it, delivered
// where the mirror delivers (<DATA>/clothing/.era) or written into the family's
// Drive folder for a sync to carry.
function putTag(root, writer, ...lines) {
  const f = path.join(root, "clothing", ".era", "tags", writer + ".jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l) + "\n").join(""));
  return f;
}
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600 * 1000;
const recipeOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "recipes", "today.json"), "utf8"));
// Every id the board draws, speaks or loads anywhere in the recipe: the
// "disappears from the board" measure has to look at the whole file, not at
// one board (a hidden garment in a grid on page 3 is still on her board).
const idsInRecipe = (dir) => new Set(JSON.stringify(recipeOf(dir)).match(/item_[0-9a-f]+/g) || []);
// ---- reading the graph the way she walks it (T5) --------------------------
const boardOf = (dir, id) => recipeOf(dir).boards.find(b => b.id === id);
// Every page of one grid, in order: "cat_top", "cat_top_2", …
const pagesOf = (dir, id) =>
  recipeOf(dir).boards.filter(b => b.id === id || String(b.id).startsWith(id + "_"));
// The button in a cell, or undefined for a black rest cell.
const at = (board, row, col) => (board.buttons || []).find(b => b.row === row && b.col === col);
const cellOf = (board, label) => {
  const b = (board.buttons || []).find(x => x.label === label);
  return b ? b.row + "," + b.col : null;
};
// The one target she has to learn, wherever it turns up (spec §4.1).
function assertEntryTile(btn, where) {
  assert.ok(btn, "no Accessories tile " + where);
  assert.equal(btn.label, "Accessories", where);
  assert.equal(btn.type, "category", where + ": a dwell target like Build my own");
  assert.equal(btn.load, "acc", where + ": one door, whatever the number of kinds");
  assert.ok(btn.symbol, where + ": a picture, like every other category tile");
}
const outfitsOn = (board) => (board.buttons || []).filter(b => b.type === "outfit");
const tileIds = (board) => (board.buttons || []).filter(b => b.type === "clothing")
  .map(b => path.basename(b.image, ".jpg"));
// Deal for one device, in process: drive.js and clothing.js are module-global,
// so a device is "started" and then built, one at a time (the clothing-share
// pattern).
async function build(dir, deviceId = "dev-a", opts = {}) {
  drive.start(dir);
  clothing.start(dir, { noTimers: true, tz: () => ZONE, deviceId });
  clothing._testReset();
  return opts.rebuildOnly ? clothing.rebuildToday() : clothing.regenerate(true);
}

before(async () => {
  for (const k of Object.keys(SEAMS)) process.env[k] = SEAMS[k];
  ai = http.createServer((req, res) => {
    // The same fake also plays the sky when a case arms it (`sky`): the geo
    // lookup and Open-Meteo answer on paths the AI never uses, so the suite
    // gets a cold morning without a second port (the 84xx band has holes —
    // tunnel-ports law). Unarmed, both doors 404 and the band stays null.
    if (req.url.startsWith("/geo") || req.url.startsWith("/v1/forecast")) {
      if (!sky) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url.startsWith("/geo") ? GEO : sky));
      return;
    }
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      // Answered, never thrown on: a throw in the before hook's async graph is
      // an uncaughtException and a FILE-level failure (clothing.test.mjs r3).
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const content = (parsed.messages && parsed.messages[0] && parsed.messages[0].content) || [];
      asks.push((content.find(p => typeof p.text === "string") || {}).text || "");
      const text = JSON.stringify(queue.length ? queue.shift() : ANSWER);
      replyBytes = Math.max(replyBytes, Buffer.byteLength(text));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));
});
after(() => {
  if (ai) ai.close();
  for (const k of Object.keys(SEAMS)) delete process.env[k];
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- T3: the classifier (spec §3.3) ---------------------------------------

// The three answers a model really gives: the word we asked for, a word we did
// not, and no word at all. Only the first is the interesting one — the other
// two are what keeps a jacket-shaped wardrobe from being poisoned by a model
// having a bad day.
test("a jacket is catalogued as a jacket; an unknown word is a top and a missing occasion is everyday", async () => {
  const D = dataDir("ingest");
  photo(D, "a-puffer.jpg");
  photo(D, "b-mystery.jpg");
  photo(D, "c-plain.jpg");
  withKey(D);
  queue.push(
    { ...ANSWER, name: "Blue puffer", category: "jacket", occasion: "fancy" },
    { ...ANSWER, name: "Odd thing", category: "sweatshirt", occasion: "gala" },
    { ...ANSWER, name: "Plain tee" },                        // no occasion at all
  );
  await build(D);

  const items = catalogOf(D);
  assert.equal(items["a-puffer.jpg"].category, "jacket", "the word the model was offered comes back whole");
  assert.equal(items["a-puffer.jpg"].occasion, "fancy", "…and so does the occasion");
  assert.equal(items["b-mystery.jpg"].category, "top", "a category nobody asked for is a top (unchanged default)");
  assert.equal(items["b-mystery.jpg"].occasion, "everyday", "…and an occasion nobody asked for is everyday");
  assert.equal(items["c-plain.jpg"].occasion, "everyday", "an ABSENT occasion is everyday, not absent");
});

test("the prompt asks for the eleven kinds, each exactly once, and says what a jacket is", () => {
  const ask = asks[0];
  assert.ok(ask, "the fake saw the ingest prompt");
  // The words come from clothing-rank's lists, so a kind added there without a
  // word added here is this assertion failing rather than a silent misfiling.
  // (The LIST is what is counted, not the whole prompt: the jacket definition
  // necessarily says "jacket" and "top" again.)
  const list = /"category": one of ([^—]+)—/.exec(ask);
  assert.ok(list, "the category clause names its words before the jacket definition");
  assert.deepEqual((list[1].match(/"([a-z]+)"/g) || []).map(s => s.slice(1, -1)), KINDS,
    "every kind, in clothing-rank order, exactly once");
  assert.match(ask, /one clothing item, accessory or matching set/,
    "the opening sentence stops calling an accessory a clothing item");
  assert.match(ask, /"jacket" is an outer layer worn over another top and taken off indoors/);
  assert.match(ask, /a pullover sweater is a "top"/, "the one line that decides most of the wardrobe");
  assert.match(ask, /"occasion": "fancy" only if it is party, holiday or dress-up wear, else "everyday"/);
  assert.match(ask, /"warmth"/, "warmth is still asked — it orders the jackets");
  // The reply is what max_tokens caps (480 per provider), not the prompt: the
  // new field is ~20 characters on an answer that was already well inside it.
  assert.ok(replyBytes < 1200, "the longest answer the fake sent is " + replyBytes + " bytes, far inside 480 tokens");
});

test("the tag line the family shares carries the occasion", async () => {
  const D = dataDir("share"), DRIVE = path.join(TMP, "share-drive");
  fs.mkdirSync(path.join(DRIVE, "clothing"), { recursive: true });
  fs.writeFileSync(path.join(D, "drive.json"), JSON.stringify({ mode: "local", folderPath: DRIVE }));
  photo(D, "party-dress.jpg");
  withKey(D);
  queue.push({ ...ANSWER, name: "Star dress", category: "dress", occasion: "fancy" });
  await build(D, "dev-share");

  const f = path.join(DRIVE, "clothing", ".era", "tags", "dev-share.jsonl");
  const tag = fs.readFileSync(f, "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(tag.category, "dress");
  assert.equal(tag.occasion, "fancy", "the other tablet learns the occasion too, or it asks again");
});

test("a redraw keeps the parent's word: category, occasion, hidden and manualAt all survive", async () => {
  const D = dataDir("redraw");
  const rel = photo(D, "hoodie.jpg");
  const id = idFor(rel);
  withKey(D);
  // The state a device is in the morning after a parent fixed this garment:
  // catalogued, manual, and with its tile missing (the one case that sends a
  // KNOWN garment back through the photo loop — QA 9/2).
  fs.writeFileSync(path.join(D, "wardrobe.json"), JSON.stringify({ items: { [rel]: {
    id, ok: true, name: "Grey hoodie", category: "jacket", occasion: "fancy", hidden: false,
    manualAt: "2026-09-16", warmth: "cool", rotate_deg: 0, crop: {}, exif: 1,
    colors: ["gray"], pattern: "solid", statement: false, palette: "neutral", vibe: "basic",
    attrsAt: "2026-09-16",
  } } }, null, 1));
  const before = asks.length;
  await build(D, "dev-redraw");

  assert.equal(asks.length, before, "a redraw asks the model nothing — the answer is already here");
  const it = catalogOf(D)[rel];
  assert.equal(it.category, "jacket", "the model does not get a second go at a garment a parent filed");
  assert.equal(it.occasion, "fancy");
  assert.equal(it.manualAt, "2026-09-16", "…and the stamp that says so is not rewritten");
  assert.ok(fs.statSync(path.join(D, "wardrobe-items", id + ".jpg")).size > 0, "the tile was redrawn");
});

test("a garment another device described arrives with its occasion and costs no call", async () => {
  const D = dataDir("fromtag");
  const rel = photo(D, "gala-shoes.jpg");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(D, "clothing", rel))).digest("hex");
  withKey(D);
  // What the mirror delivers: another device's tags file, under <DATA>/clothing/
  // .era (the mirror's destination — this hub never writes there, A4-9).
  const f = path.join(D, "clothing", ".era", "tags", "dev-other.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ t: "2026-09-16T10:00:00.000Z", id: idFor(rel), hash,
    name: "Party shoes", category: "shoes", occasion: "fancy", warmth: "any",
    colors: ["black"], pattern: "solid", statement: false, palette: "neutral", vibe: "basic",
    rotate_deg: 0, crop: {} }) + "\n");
  const before = asks.length;
  await build(D, "dev-fromtag");

  assert.equal(asks.length, before, "the family had already paid for this garment");
  const it = catalogOf(D)[rel];
  assert.equal(it.category, "shoes");
  assert.equal(it.occasion, "fancy", "the occasion rides along, or this device asks for it again");
});

// ---- T4: the manual sweep (spec §3.4) --------------------------------------

test("a parent's own edit outranks the model on the very next re-sort", async () => {
  const D = dataDir("edits");
  const items = materialize({ dataDir: D, n: 8 });
  const top = items.find(i => i.category === "top");
  await build(D, "dev-edits");
  assert.equal(entryFor(D, top.id).category, "top", "the model's word, before anybody looked");
  assert.ok(idsInRecipe(D).has(top.id), "…and it was on her board");

  const t = iso(Date.now());
  writeEdits(D, { [top.id]: { category: "jacket", occasion: "fancy", t } });
  // A weather re-sort, not a full build: the sweep runs on BOTH paths
  // (preflight 3), and this is the one the route asks for (spec §5.1).
  const r = await build(D, "dev-edits", { rebuildOnly: true });

  const it = entryFor(D, top.id);
  assert.equal(it.category, "jacket", "the parent's word, on the next build, with no AI anywhere");
  assert.equal(it.occasion, "fancy");
  assert.equal(it.manualAt, t, "…stamped with the parent's own clock, exactly (T4)");
  assert.deepEqual(r.accessories, ["jacket"], "and the build knows a jacket kind is present now");

  // An accessory is never pooled and never sits in a garment grid: the deal
  // drops it (clothing-rank), and the browse grids ask for a garment WORD, so
  // "accessory" can fall into none of them (preflight 2). Its OWN grid is the
  // one place it is drawn (T5), and that is the whole point of the edit.
  const recipe = recipeOf(D);
  for (const b of recipe.boards)
    for (const btn of b.buttons) {
      assert.ok(!(btn.combo || []).includes(top.id), "no look on " + b.id + " is built out of a jacket");
      if (String(b.id).startsWith("acc_")) continue;
      assert.notEqual(btn.image, "wardrobe-items/" + top.id + ".jpg", b.id + " draws no jacket tile");
    }
  assert.deepEqual(tileIds(boardOf(D, "acc_jacket")), [top.id], "…it is on the jackets grid instead");

  assert.deepEqual(JSON.parse(fs.readFileSync(editsPath(D), "utf8")),
    { [top.id]: { category: "jacket", occasion: "fancy", t } },
    "the worker READS edits.json and never writes it — the route owns the file (spec §7)");
});

// The other half of §3.4: the tablet the parent touched shares a manual line,
// and every other device applies it on its next build. Nothing is coordinated;
// the family's Drive folder carries the whole conversation.
test("a manual line from one tablet moves the garment on the other", async () => {
  const DRIVE = path.join(TMP, "family-drive");
  fs.mkdirSync(path.join(DRIVE, "clothing"), { recursive: true });
  const A = dataDir("famA"), B = dataDir("famB");
  const items = materialize({ dataDir: A, n: 8, driveFolder: DRIVE });
  materialize({ dataDir: B, n: 8, driveFolder: DRIVE });
  for (const d of [A, B])
    fs.writeFileSync(path.join(d, "drive.json"), JSON.stringify({ mode: "local", folderPath: DRIVE }));
  const top = items.find(i => i.category === "top");

  const t = iso(Date.now());
  putTag(DRIVE, "tablet", { t, id: top.id, name: top.name, category: "jacket",
    warmth: top.warmth, occasion: "everyday", manual: true });
  drive.start(B);
  await drive.sync();
  assert.ok(fs.existsSync(path.join(B, "clothing", ".era", "tags", "tablet.jsonl")),
    "the mirror carried the line to the second device");

  const r = await build(B, "dev-b");
  const it = entryFor(B, top.id);
  assert.equal(it.category, "jacket", "the device nobody touched agrees with the parent");
  assert.equal(it.manualAt, t, "…and stamps the parent's own clock, not its own build's");
  assert.deepEqual(r.accessories, ["jacket"]);
});

test("the newest parent wins, and a correction from another day never reverts them", async () => {
  const D = dataDir("newest");
  const items = materialize({ dataDir: D, n: 8 });
  const top = items.find(i => i.category === "top");
  const older = iso(Date.now() - 2 * HOUR), newer = iso(Date.now() - HOUR);
  putTag(D, "dev-other", { t: older, id: top.id, name: top.name, category: "jacket", manual: true });
  writeEdits(D, { [top.id]: { category: "shoes", t: newer } });
  await build(D, "dev-newest");
  assert.equal(entryFor(D, top.id).category, "shoes", "two manual lines, an hour apart: the later one");

  // The mirror delivers a correction made the day before yesterday (another
  // device catching up). The stamp on the entry is what refuses it.
  const stale = yesterdayOf(yesterdayOf(today())) + "T00:00:00.000Z";
  fs.rmSync(editsPath(D));                       // …and the route has pruned this device's own copy
  putTag(D, "dev-other", { t: stale, id: top.id, name: top.name, category: "hat", manual: true });
  await build(D, "dev-newest", { rebuildOnly: true });
  assert.equal(entryFor(D, top.id).category, "shoes", "an older correction is not news");
  assert.equal(entryFor(D, top.id).manualAt, newer);
});

test("a hidden garment leaves every board, and a second edit the same minute still lands", async () => {
  const D = dataDir("hidden");
  const items = materialize({ dataDir: D, n: 10 });
  const top = items.find(i => i.category === "top");
  await build(D, "dev-hidden");
  assert.ok(idsInRecipe(D).has(top.id), "it was on her board to begin with");

  writeEdits(D, { [top.id]: { hidden: true, t: iso(Date.now()) } });
  const r = await build(D, "dev-hidden", { rebuildOnly: true });
  assert.ok(!idsInRecipe(D).has(top.id), "hidden means gone: no look, no grid, no page");
  assert.equal(entryFor(D, top.id).hidden, true, "…though the catalogue entry is kept, not deleted");
  assert.deepEqual(r.accessories, [], "and no accessory kind is present");

  // A parent who fixes a mistake twice in one minute must be obeyed twice: the
  // day stamp is coarse, so the guard compares the edit's own clock to it.
  writeEdits(D, { [top.id]: { hidden: true, category: "jacket", t: iso(Date.now()) } });
  const r2 = await build(D, "dev-hidden", { rebuildOnly: true });
  assert.equal(entryFor(D, top.id).category, "jacket", "the second edit of the day landed too");
  assert.deepEqual(r2.accessories, [], "a HIDDEN jacket is no jacket to offer her");
  assert.ok(!idsInRecipe(D).has(top.id));
});

// preflight 18: the memory remembers ids, not garments. A hidden garment in
// yesterday's page 1 (it bars a look) and in her picks (it scores one) must
// neither throw nor come back.
test("a hidden garment in yesterday's page 1 and in her picks is harmless", async () => {
  const D = dataDir("memory");
  const items = materialize({ dataDir: D, n: 10 });
  const top = items.find(i => i.category === "top");
  const bottom = items.find(i => i.category === "pants" || i.category === "shorts");
  const y = yesterdayOf(today());
  fs.mkdirSync(path.join(D, "wardrobe"), { recursive: true });
  fs.writeFileSync(path.join(D, "wardrobe", "history.json"), JSON.stringify({
    days: { [y]: { band: null, page1: [[top.id, bottom.id]] } },
    events: { [y]: [{ t: y + "T18:00:00.000Z", kind: "yes", combo: [top.id, bottom.id] }] },
  }, null, 1));
  writeEdits(D, { [top.id]: { hidden: true, t: iso(Date.now()) } });

  const r = await build(D, "dev-memory");
  assert.equal(r.mode, "cataloged", "the board was dealt");
  assert.ok(!idsInRecipe(D).has(top.id), "…and her Yes of yesterday did not bring it back");
});

// spec §3.2: the needs-attributes pass writes taste attributes and nothing
// else. A pass that widened into `category` would hand a parent's jacket back
// to the model on the next morning tick.
test("the needs-attributes pass describes a garment without touching what a parent said", async () => {
  const D = dataDir("attrspass");
  const rel = photo(D, "cardigan.jpg");
  const id = idFor(rel);
  makeJpg(path.join(D, "wardrobe-items", id + ".jpg"), 640, 640, 30, 60, 90);
  const stamp = iso(Date.now());
  fs.writeFileSync(path.join(D, "wardrobe.json"), JSON.stringify({ items: { [rel]: {
    id, ok: true, name: "Grey cardigan", category: "jacket", occasion: "fancy", hidden: false,
    manualAt: stamp, warmth: "cool", rotate_deg: 0, crop: {}, exif: 1,
  } } }, null, 1));
  withKey(D);
  queue.push({ ...ANSWER, name: "Something else", category: "top", occasion: "everyday" });
  const before = asks.length;
  await build(D, "dev-attrspass");

  assert.equal(asks.length - before, 1, "one call for the garment nobody had described");
  const it = entryFor(D, id);
  assert.deepEqual(it.colors, ["blue"], "it learned the colours the taste rules read");
  assert.equal(it.category, "jacket", "…and the model's category never reached the entry");
  assert.equal(it.occasion, "fancy");
  assert.equal(it.hidden, false);
  assert.equal(it.manualAt, stamp);
});

test("an edits.json that will not parse costs a log line, never the build or the file", async () => {
  const D = dataDir("broken");
  materialize({ dataDir: D, n: 8 });
  writeEdits(D, "{ this is not json");
  const r = await build(D, "dev-broken");
  assert.equal(r.mode, "cataloged", "the board is dealt without the family's own edits");
  assert.equal(fs.readFileSync(editsPath(D), "utf8"), "{ this is not json",
    "a reader never deletes what it could not read (spec §7)");
});

// ---- T5: the board graph (spec §4.1, dad's 9/17 re-route) ------------------
//
// One jacket is the whole feature: the moment a kind is present she gets an
// "Accessories" door on every page she can be standing on — today, "This one?"
// and every browse grid — plus the menu behind it and a grid per kind. The
// door costs today's seventh outfit slot ([3,3], dad 9/17), so a page carries
// six looks while she has accessories and seven when she has none.

test("one jacket opens the accessories door on every page she can be standing on", async () => {
  const D = dataDir("onejacket");
  // 35 garments: 17 tops, so the tops grid really has a second page and the
  // [3,4] door has to be drawn twice.
  materialize({ dataDir: D, n: 35, accessories: { jacket: 1 } });
  const r = await build(D, "dev-onejacket");
  assert.deepEqual(r.accessories, ["jacket"], "the build knows the kind is present");

  const ids = recipeOf(D).boards.map(b => b.id);
  assert.ok(ids.includes("acc"), "the accessories menu exists");
  assert.ok(ids.includes("acc_jacket"), "…and the jackets grid behind it");

  // Today: the door at [3,3], six looks, and nothing else in that cell.
  for (const pid of ["today", "today_2", "today_3"]) {
    const page = boardOf(D, pid);
    assert.ok(page, pid + " exists");
    assertEntryTile(at(page, 3, 3), pid + " [3,3]");
    assert.equal(outfitsOn(page).length, 6, pid + " carries six looks while she has accessories");
    for (const o of outfitsOn(page))
      assert.ok(!(o.row === 3 && o.col === 3), pid + ": no look is hiding under the door");
    assert.equal(new Set(page.buttons.map(x => x.row + "," + x.col)).size, page.buttons.length,
      pid + ": one button per cell");
    assert.equal(cellOf(page, "Build my own"), "3,4", pid + ": Build my own keeps its corner");
  }
  // The memory the next day reads must agree with the page she saw.
  const hist = JSON.parse(fs.readFileSync(path.join(D, "wardrobe", "history.json"), "utf8"));
  assert.equal(hist.days[today()].page1.length, 6, "page 1 remembered six looks, not seven");

  assertEntryTile(at(boardOf(D, "confirm_0"), 3, 2), "confirm_0 [3,2]");

  const tops = pagesOf(D, "cat_top");
  assert.ok(tops.length >= 2, "17 tops is two pages, so the door is drawn more than once");
  for (const p of tops) assertEntryTile(at(p, 3, 4), p.id + " [3,4]");

  // Build my own: 3 x 4, centre black, the kinds along the edges.
  const b = boardOf(D, "build");
  assert.equal(b.rows + "x" + b.columns, "3x4", "Build my own is the centre-black 3x4 board now");
  assert.equal(cellOf(b, "Back"), "1,1");
  assert.equal(cellOf(b, "Tops"), "1,2");
  assert.equal(cellOf(b, "Bottoms"), "1,3");
  assert.equal(cellOf(b, "Dresses"), "1,4");
  assert.equal(cellOf(b, "Outfits"), "2,1");
  assert.equal(cellOf(b, "Jackets"), "2,4", "the first present kind takes the first edge cell");
  assert.equal(at(b, 2, 2), undefined, "the centre cells stay black");
  assert.equal(at(b, 2, 3), undefined, "…both of them");
  assert.equal(at(b, 2, 4).load, "acc_jacket", "and it goes straight to the jackets");

  // The kind's own grid: clothing tiles that speak, Back to today, no door.
  const g = boardOf(D, "acc_jacket");
  assert.equal(g.name, "Jackets");
  assert.equal(g.rows + "x" + g.columns, "3x4");
  assert.equal(tileIds(g).length, 1, "the one jacket she owns");
  const tile = g.buttons.find(x => x.type === "clothing");
  assert.equal(tile.say, tile.label, "tapping a jacket speaks its name, like a garment tile");
  assert.equal(tile.load, undefined, "…and goes nowhere");
  assert.equal(at(g, 1, 1).load, "today", "Back from a jackets grid is today");
  assert.ok(!g.buttons.some(x => x.label === "Accessories"), "no door on the door's own grid");
});

test("a pair of shoes takes the next cell on Build my own and the second on the menu", async () => {
  const D = dataDir("jacketshoes");
  materialize({ dataDir: D, n: 12, accessories: { jacket: 1, shoes: 1 } });
  const r = await build(D, "dev-jacketshoes");
  assert.deepEqual(r.accessories, ["jacket", "shoes"], "in ACCESSORY_KINDS order, not photo order");

  const b = boardOf(D, "build");
  assert.equal(cellOf(b, "Jackets"), "2,4");
  assert.equal(cellOf(b, "Shoes"), "3,1", "the second kind takes the second edge cell");
  const menu = boardOf(D, "acc");
  assert.equal(menu.rows + "x" + menu.columns, "3x4");
  assert.equal(at(menu, 1, 1).load, "today", "Back from the menu is today");
  assert.equal(cellOf(menu, "Jackets"), "1,2");
  assert.equal(cellOf(menu, "Shoes"), "1,3");
  assert.equal(at(menu, 1, 3).load, "acc_shoes");
  assert.equal(at(menu, 2, 2), undefined, "the menu's centre is black too");
  assert.equal(at(menu, 2, 3), undefined);
  assert.ok(boardOf(D, "acc_shoes"), "and the shoes have a grid");
});

// Six kinds can never fit the five edge cells Build my own has left, so the
// last one becomes the door itself (spec §4.1).
test("six kinds turn Build my own's last cell into the door, and the menu holds them all", async () => {
  const D = dataDir("sixkinds");
  materialize({ dataDir: D, n: 12,
    accessories: { jacket: 1, shoes: 1, jewelry: 1, hat: 1, hair: 1, makeup: 1 } });
  const r = await build(D, "dev-sixkinds");
  assert.deepEqual(r.accessories, ["jacket", "shoes", "jewelry", "hat", "hair", "makeup"]);

  const b = boardOf(D, "build");
  assert.equal(cellOf(b, "Jackets"), "2,4");
  assert.equal(cellOf(b, "Shoes"), "3,1");
  assert.equal(cellOf(b, "Jewelry"), "3,2");
  assert.equal(cellOf(b, "Hats"), "3,3");
  assertEntryTile(at(b, 3, 4), "build [3,4] with six kinds");
  assert.equal(cellOf(b, "Hair"), null, "the fifth kind is behind the door, not on the board");
  assert.equal(cellOf(b, "Makeup"), null);

  const menu = boardOf(D, "acc");
  assert.deepEqual(["Jackets", "Shoes", "Jewelry", "Hats", "Hair", "Makeup"].map(l => cellOf(menu, l)),
    ["1,2", "1,3", "1,4", "2,1", "2,4", "3,1"], "all six on the menu, along the edges, in order");
  for (const k of ["jacket", "shoes", "jewelry", "hat", "hair", "makeup"])
    assert.ok(boardOf(D, "acc_" + k), "acc_" + k + " exists");
});

// Spec §4.1: an accessory is never weather-hidden — the sky only re-orders the
// page, so on a cold morning the coats lead.
test("jackets lead with the day's band, and fall back to catalogue order with no weather", async () => {
  const D = dataDir("jacketband");
  // warmths cycle cold / cool / any / warm (synthetic-wardrobe)
  const items = materialize({ dataDir: D, n: 12, accessories: { jacket: 4 } });
  const jackets = items.filter(i => i.category === "jacket");
  const byId = jackets.map(j => j.id).sort();

  await build(D, "dev-jacketband");
  assert.deepEqual(tileIds(boardOf(D, "acc_jacket")), byId,
    "no weather, no opinion: catalogue order by id");

  const C = dataDir("jacketcold");
  const cold = materialize({ dataDir: C, n: 12, accessories: { jacket: 4 } });
  const r = await underSky(allDayAt(40), () => build(C, "dev-jacketcold"));
  assert.equal(r.mode, "cataloged");
  // |level(item) − level(cold)|: an "any" piece is 0 to every band, so it ties
  // with the coat and the two sort by id; then cool, then warm.
  const rank = { cold: 0, any: 0, cool: 1, warm: 2 };
  const expected = cold.filter(i => i.category === "jacket")
    .sort((a, b) => rank[a.warmth] - rank[b.warmth] || (a.id < b.id ? -1 : 1))
    .map(i => i.id);
  assert.deepEqual(tileIds(boardOf(C, "acc_jacket")), expected, "on a cold morning the coats lead");
  assert.notDeepEqual(expected, [...expected].sort(), "…and that is not just id order again");
});

// The board must be able to name what is under a finger without parsing a
// label (spec §4, the hold sheet's rows).
test("every garment and outfit tile carries the items it is made of", async () => {
  const D = dataDir("tileitems");
  const items = materialize({ dataDir: D, n: 12, accessories: { jacket: 1 } });
  // One garment a parent already called fancy, so the field is read and not
  // merely defaulted.
  const top = items.find(i => i.category === "top");
  const cat = JSON.parse(fs.readFileSync(path.join(D, "wardrobe.json"), "utf8"));
  for (const [rel, it] of Object.entries(cat.items)) if (it.id === top.id) cat.items[rel].occasion = "fancy";
  fs.writeFileSync(path.join(D, "wardrobe.json"), JSON.stringify(cat, null, 1));
  await build(D, "dev-tileitems");

  const garment = boardOf(D, "cat_top").buttons
    .find(b => b.type === "clothing" && b.image.includes(top.id));
  assert.deepEqual(garment.items, [{ id: top.id, name: top.name, category: "top", occasion: "fancy" }],
    "one row, the whole garment, exactly as the sheet will show it");

  const jacket = boardOf(D, "acc_jacket").buttons.find(b => b.type === "clothing");
  assert.equal(jacket.items.length, 1);
  assert.equal(jacket.items[0].category, "jacket");
  assert.equal(jacket.items[0].occasion, "everyday", "a garment nobody has judged is everyday");

  const page = boardOf(D, "today");
  const pair = outfitsOn(page).find(o => o.combo.length === 2);
  assert.ok(pair, "at least one look is a top and a bottom");
  assert.deepEqual(pair.items.map(i => i.id), pair.combo, "the combo's two halves, in the combo's order");
  assert.equal(pair.items.map(i => i.name).join(" and "), pair.say,
    "the names on the tile are the names the tile speaks");
  const confirm = boardOf(D, pair.load);
  assert.deepEqual(confirm.buttons[0].items, pair.items, "and the same two rows on This one?");
});

// The chips in the hold sheet are named from the recipe, so the board keeps no
// list of its own to drift (spec §4.2).
test("the recipe names every category the family can file a garment under", async () => {
  const D = dataDir("cats");
  materialize({ dataDir: D, n: 8 });        // no accessories at all
  await build(D, "dev-cats");
  assert.deepEqual(recipeOf(D).categories, [
    { id: "top", label: "Top" }, { id: "pants", label: "Pants" }, { id: "shorts", label: "Shorts" },
    { id: "dress", label: "Dress" }, { id: "set", label: "Set" },
    ...ACCESSORY_KINDS.map(k => ({ id: k.id, label: k.label })),
  ], "garments first, then the accessory kinds — whatever this wardrobe happens to hold");
});

// The recipe this worker built before accessories existed, measured rather
// than remembered: the baseline worker is git-shown into the temp dir with its
// "./x" requires pinned to the hub (moving the file is all that breaks), and
// run over the SAME data dir, so every id, seed and composite is shared.
const BASELINE = "c1a0195";
function baselineWorker() {
  const f = path.join(TMP, "baseline-clothing-worker.cjs");
  if (!fs.existsSync(f))
    fs.writeFileSync(f, execFileSync("git", ["-C", HUB, "show", BASELINE + ":clothing-worker.js"],
      { encoding: "utf8", maxBuffer: 8 << 20 })
      .replace(/require\("\.\/([^"]+)"\)/g, (_, p) => `require(${JSON.stringify(path.join(HUB, p))})`));
  return f;
}
function buildAsBaseline(dir, deviceId) {
  return new Promise((resolve, reject) => {
    const w = new Worker(baselineWorker(), { workerData: {
      dataDir: dir, force: true, rebuildOnly: true, tz: ZONE, deviceId, driveFolder: null } });
    w.on("message", (m) => { if (m.done) resolve(m.done); });
    w.on("error", reject);
  });
}

test("a wardrobe with no accessories gets the board she had yesterday", async () => {
  const D = dataDir("nochange");
  materialize({ dataDir: D, n: 35 });
  const was = await buildAsBaseline(D, "dev-nochange");
  assert.equal(was.mode, "cataloged", "the baseline worker dealt a board");
  const before = recipeOf(D);
  const r = await build(D, "dev-nochange");
  assert.deepEqual(r.accessories, [], "nothing to offer, so no kind is present");
  const after = recipeOf(D);

  // The three things T5 adds and nothing else: the items on the tiles, the
  // category list at the root, and the reshaped Build my own board.
  const strip = (recipe) => {
    const r2 = JSON.parse(JSON.stringify(recipe));
    delete r2.categories;
    r2.boards = r2.boards.filter(b => b.id !== "build");
    for (const b of r2.boards) for (const btn of b.buttons) delete btn.items;
    return r2;
  };
  assert.deepEqual(strip(after), strip(before),
    "board for board, cell for cell, the board she had before accessories existed");
  assert.ok(!JSON.stringify(after).includes("Accessories"), "and no door anywhere on it");
  assert.ok(!after.boards.some(b => String(b.id).startsWith("acc")), "no acc boards either");
  for (const pid of ["today", "today_2", "today_3"])
    assert.equal(outfitsOn(boardOf(D, pid)).length, 7, pid + " keeps its seven looks");

  // Build my own is the new 3 x 4 shape even with nothing to put on it.
  const b = boardOf(D, "build");
  assert.equal(b.rows + "x" + b.columns, "3x4");
  assert.equal(b.buttons.length, 5, "five buttons and eight black cells");
  assert.deepEqual(b.buttons.map(x => x.label + "@" + x.row + "," + x.col),
    ["Back@1,1", "Tops@1,2", "Bottoms@1,3", "Dresses@1,4", "Outfits@2,1"]);
});

// The hold sheet's Hide is the last word here too: a hidden accessory is off
// its grid, and the last one of its kind takes the whole door with it.
test("hiding the only jacket takes the door down with it", async () => {
  const D = dataDir("hidejacket");
  const items = materialize({ dataDir: D, n: 10, accessories: { jacket: 2 } });
  const [j1, j2] = items.filter(i => i.category === "jacket").map(i => i.id).sort();
  await build(D, "dev-hidejacket");
  assert.deepEqual(tileIds(boardOf(D, "acc_jacket")), [j1, j2], "both jackets to begin with");

  writeEdits(D, { [j1]: { hidden: true, t: iso(Date.now()) } });
  await build(D, "dev-hidejacket", { rebuildOnly: true });
  assert.deepEqual(tileIds(boardOf(D, "acc_jacket")), [j2], "the hidden one is off the grid");
  assertEntryTile(at(boardOf(D, "today"), 3, 3), "today [3,3] with one jacket left");

  writeEdits(D, { [j1]: { hidden: true, t: iso(Date.now()) }, [j2]: { hidden: true, t: iso(Date.now()) } });
  const r = await build(D, "dev-hidejacket", { rebuildOnly: true });
  assert.deepEqual(r.accessories, [], "the kind is gone");
  const recipe = recipeOf(D);
  assert.ok(!recipe.boards.some(b => String(b.id).startsWith("acc")), "so are its boards");
  assert.ok(!JSON.stringify(recipe).includes("Accessories"), "and every door on every page");
  assert.equal(outfitsOn(boardOf(D, "today")).length, 7, "and the seventh slot is a look again");
});
