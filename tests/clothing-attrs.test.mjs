// clothing-attrs.test.mjs — the needs-attributes pass (spec §3.1 item 3).
//
// The family's wardrobe was catalogued before the taste rules existed: 35
// garments with a name, a category and a warmth word, and nothing the rules
// read. Rather than ask the family to re-add every photo, `ingest()` runs a
// second, cheaper loop after the new photos are named — one call per garment
// that has never been described, through the SAME provider ladder, from the
// tile that is already on disk (never a second HEIC decode, I12).
//
// The rules it must obey, and why each one costs money if it is broken:
//   * once per garment per day, across every intra-day door — a regenerate, a
//     Sync now, the morning tick (plan A4-8). Every real call stamps
//     `attrsTriedAt` BEFORE its outcome is known, so a 429 ladder is spent at
//     most once a day, not once a door.
//   * a garment that has already been described (`attrsAt`) or already carries
//     attributes is never asked at all.
//   * the pass never touches the PHOTO counters — busy/quota/left/landed and
//     `holdDay` stay photo-only (plan A4-8, blocker B1-c): a pass that ran out
//     of allowance must not silence the retry for a photo still waiting to be
//     named.
//
// This suite is its own file rather than more cases in clothing.test.mjs,
// which is already at ~10 minutes of its 15-minute ceiling (plan A4-7). Its
// fake AI is on 8462 (plan §B) and `ERA_AI_SPACING_MS` shortens the 5 s the
// provider spacing costs in the family's own runs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AI_PORT = 8462;          // plan §B: this suite's fake AI
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey } = require("./clothing-rank.js");
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

let ai, clothing;
let calls = 0;                 // requests the fake was shown
const asks = [];               // the TEXT half of each request: what was asked
const pictures = [];           // {width, height} of each picture it was shown
let mode = "ok";               // "ok" | "429" | "empty"
let delayMs = 0;               // how long the fake sits on an answer
// Three answers, cycled: between them they exercise the whole whitelist —
// a colour string that must split and cap at three ("light blue" staying ONE
// entry), a pattern word outside the vocabulary, the string "true" (which is
// not `true`), and the palette/vibe words the rules score on.
const ATTRS_ANSWERS = [
  { colors: "pink and white, Light Blue, Green", pattern: "zebra", statement: "true", palette: "cool", vibe: "sporty" },
  { colors: ["black"], pattern: "denim", statement: true, palette: "neutral", vibe: "basic" },
  { colors: ["red"], pattern: "solid", statement: false, palette: "warm", vibe: "sweet" },
];

function jpeg() { return require("./vendor/jpeg-js"); }
function makeJpg(file, w, h, r, g, b) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, jpeg().encode({ data, width: w, height: h }, 85).data);
}

// A data dir holding garments the hub already knows by name and has tiles for,
// and NOTHING the taste rules can read: the state the family's own wardrobe is
// in on the morning of the upgrade. Photos are 320x480 portraits, tiles are
// 640 squares — so the size of the picture the pass sends says which of the
// two it read (I12).
function seedWardrobe(dir, names) {
  fs.mkdirSync(path.join(dir, "clothing"), { recursive: true });
  fs.mkdirSync(path.join(dir, "wardrobe-items"), { recursive: true });
  const items = {};
  names.forEach(([id, name, category], i) => {
    makeJpg(path.join(dir, "clothing", id + ".jpg"), 320, 480, 40 + i * 30, 90, 200 - i * 20);
    makeJpg(path.join(dir, "wardrobe-items", id + ".jpg"), 640, 640, 40 + i * 30, 90, 200 - i * 20);
    items[id + ".jpg"] = { id, ok: true, name, category, warmth: "any" };
  });
  fs.writeFileSync(path.join(dir, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  return items;
}
function withKey(dir) {
  fs.writeFileSync(path.join(dir, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
}
const catalogOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "wardrobe.json"), "utf8")).items;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "era-attrs-"));
const QUOTA = fs.mkdtempSync(path.join(os.tmpdir(), "era-attrs-q-"));
const NOTHING = fs.mkdtempSync(path.join(os.tmpdir(), "era-attrs-n-"));
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), "era-attrs-p-"));

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  // No key is needed for the weather and none may be spent on it: a dead
  // loopback port keeps this suite local (band null = no gating).
  process.env.ERA_GEO_URL = "http://127.0.0.1:1/geo";
  process.env.ERA_WEATHER_URL = "http://127.0.0.1:1";
  // The 5 s the family's own runs wait between provider calls would be ~1 s
  // per garment of this suite's runtime for nothing (blocker B1-d).
  process.env.ERA_AI_SPACING_MS = "50";

  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      // Answered, never thrown on: a throw in the before hook's async graph is
      // an uncaughtException and a FILE-level failure (clothing.test.mjs r3).
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      calls++;
      const content = (parsed.messages && parsed.messages[0] && parsed.messages[0].content) || [];
      asks.push((content.find(p => typeof p.text === "string") || {}).text || "");
      const img = content.find(p => p.type === "image");
      if (img) {
        try {
          const d = jpeg().decode(Buffer.from(img.source.data, "base64"), { formatAsRGBA: true });
          pictures.push({ width: d.width, height: d.height });
        } catch { pictures.push(null); }
      }
      const answer = () => {
        if (mode === "429") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end('{"error":{"code":429,"message":"Resource exhausted"}}');
          return;
        }
        const a = mode === "empty" ? {} : ATTRS_ANSWERS[(asks.length - 1) % ATTRS_ANSWERS.length];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(a) }] }));
      };
      delayMs ? setTimeout(answer, delayMs) : answer();
    });
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));

  seedWardrobe(DATA, [["item_a1", "Sunny tee", "top"], ["item_a2", "Pond tee", "top"],
                      ["item_a3", "Sky leggings", "pants"]]);
  withKey(DATA);
  clothing = require("./clothing.js");
  // No schedule: this suite drives the doors itself (a startup tick would fire
  // a build nobody awaited).
  clothing.start(DATA, { noTimers: true, tz: () => ZONE });
});
after(() => {
  if (ai) ai.close();
  delete process.env.ERA_AI_URL; delete process.env.ERA_GEO_URL;
  delete process.env.ERA_WEATHER_URL; delete process.env.ERA_AI_SPACING_MS;
});

// ---- the pass itself ------------------------------------------------------

test("a wardrobe catalogued before the taste rules is described once, from its own tiles", async () => {
  const before = calls;
  delayMs = 500;                       // wide enough to watch the progress arrive
  const running = clothing.regenerate(true);
  let seen = null;
  for (let i = 0; i < 400 && !seen; i++) {
    const a = clothing.status().attrs;
    if (a) seen = a;
    await new Promise(r => setTimeout(r, 10));
  }
  const r = await running;
  delayMs = 0;

  assert.equal(calls - before, 3, "one call per garment that had never been described");
  assert.equal(r.attrsDone, 3, "the build says how many it described");
  assert.equal(r.attrsLeft, 0, "…and that none were left");
  // Settings' own progress line (I16): the pass counts itself, never through
  // `ingesting`, which is the photo loop's.
  assert.ok(seen && seen.total === 3 && seen.done >= 0, "the pass reports its own progress");
  assert.equal(clothing.status().attrs, null, "…and stops reporting when it is done");

  // What it asked for, and with what picture.
  const mine = asks.slice(-3);
  for (const a of mine) {
    assert.match(a, /"colors"/, "the pass asks for colours");
    assert.match(a, /"pattern".*"statement".*"palette".*"vibe"/s, "…and for the rest of the whitelist");
    assert.match(a, /ONLY a JSON object, no prose/);
    assert.doesNotMatch(a, /"category"/, "it never re-asks what the hub already knows");
    assert.doesNotMatch(a, /"top_side"/, "…nor which way up the photo is");
  }
  for (const p of pictures.slice(-3))
    assert.deepEqual(p, { width: 384, height: 384 },
      "the picture is the 640 tile scaled down, never the photo decoded again (I12)");

  const items = catalogOf(DATA);
  const [a1, a2, a3] = ["item_a1.jpg", "item_a2.jpg", "item_a3.jpg"].map(k => items[k]);
  for (const it of [a1, a2, a3]) {
    assert.equal(it.attrsAt, today(), it.name + " is stamped with the day it was described");
    assert.equal(it.attrsTriedAt, today(), it.name + " is stamped with the day it was asked");
  }
  // the whitelist, end to end (spec §3.1 item 2, clothing-rank.attributes)
  assert.deepEqual(a1.colors, ["pink", "white", "light blue"],
    "colours split on commas and 'and', cap at three, and 'light blue' stays one colour");
  assert.equal(a1.pattern, undefined, "a pattern word outside the vocabulary is dropped, not stored");
  assert.equal(a1.statement, false, 'the STRING "true" is not true');
  assert.equal(a1.palette, "cool");
  assert.equal(a1.vibe, "sporty");
  assert.equal(a2.statement, true, "a real loud piece is remembered as one");
  assert.equal(a2.pattern, "denim");
  assert.deepEqual(a3.colors, ["red"]);
});

test("attributes are the deal's business: nothing about them reaches the board", () => {
  const recipe = fs.readFileSync(path.join(DATA, "recipes", "today.json"), "utf8");
  for (const k of ["colors", "pattern", "statement", "palette", "vibe", "hash", "attrsAt", "attrsTriedAt"])
    assert.ok(!recipe.includes('"' + k + '"'), "no " + k + " in recipes/today.json");
});

test("a garment that has been described is never asked again — by any door, on any day", async () => {
  const before = calls;
  await clothing.regenerate(true);
  assert.equal(calls, before, "a second regenerate the same day asks nothing");
  await clothing.rebuildToday();
  assert.equal(calls, before, "and a weather re-sort never opens the pass at all");

  // Not "asked today" — described, full stop. An answer that landed is the
  // answer; a hub that re-asked every morning would spend one request per
  // garment per day for ever on a wardrobe it already understands.
  const items = catalogOf(DATA);
  for (const k of Object.keys(items)) items[k].attrsTriedAt = "2026-01-01";
  fs.writeFileSync(path.join(DATA, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  await clothing.regenerate(true);
  assert.equal(calls, before, "a new day does not re-describe a described garment");
});

test("a garment that already carries attributes is not asked even without the marker", async () => {
  const items = catalogOf(DATA);
  for (const k of Object.keys(items)) { delete items[k].attrsAt; delete items[k].attrsTriedAt; }
  fs.writeFileSync(path.join(DATA, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  const before = calls;
  await clothing.regenerate(true);
  assert.equal(calls, before, "the attributes themselves are evidence enough");
});

// ---- the allowance ladder (plan A4-8) -------------------------------------

test("an allowance that runs out costs the ladder ONCE, not once per garment, and never a photo counter", async () => {
  seedWardrobe(QUOTA, [["item_q1", "Sunny tee", "top"], ["item_q2", "Pond tee", "top"],
                       ["item_q3", "Sky leggings", "pants"]]);
  withKey(QUOTA);
  clothing.start(QUOTA, { noTimers: true, tz: () => ZONE });
  clothing._testReset();

  mode = "429";
  const before = calls;
  const r = await clothing.regenerate(true);
  mode = "ok";

  // Anthropic's ladder is two models. The first garment walks it and retires
  // both; the second finds nothing left to ask and the pass stops. A pass that
  // walked the ladder per garment would have spent six.
  assert.equal(calls - before, 2, "the ladder is walked once, then the pass gives up");
  assert.equal(r.attrsDone, 0);
  assert.equal(r.attrsLeft, 3, "all three are still waiting");

  // The PHOTO counters are untouched: the pass has no say over them (B1-c).
  assert.equal(r.left, 0, "no photo is waiting: the pass does not report photos");
  assert.equal(r.quotaHit, false, "…and its 429 is not the photo allowance");
  assert.equal(clothing.status().heldToday, false, "the day is not held: a photo could still be named today");
  assert.equal(clothing.tick("test"), null, "…and nothing is waiting for the hourly retry either");

  const items = catalogOf(QUOTA);
  for (const k of Object.keys(items)) {
    assert.equal(items[k].attrsTriedAt, today(), k + " was tried today");
    assert.equal(items[k].attrsAt, undefined, k + " is still undescribed");
    assert.ok(!items[k].colors || !items[k].colors.length, k + " has no colours to show for it");
  }
});

test("the spent ladder is not spent again the same day, and tomorrow buys exactly one call per garment", async () => {
  const before = calls;
  await clothing.regenerate(true);
  assert.equal(calls, before, "the same day, through a second door, asks nothing");

  // One garment's stamp rolls back to yesterday (what the calendar does at
  // midnight): exactly that garment is asked, and exactly once.
  const items = catalogOf(QUOTA);
  items["item_q2.jpg"].attrsTriedAt = "2026-01-01";
  fs.writeFileSync(path.join(QUOTA, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  const r = await clothing.regenerate(true);
  assert.equal(calls - before, 1, "one garment, one call");
  assert.equal(r.attrsDone, 1);
  const after = catalogOf(QUOTA);
  assert.ok(after["item_q2.jpg"].colors.length >= 1, "the garment that came due was described");
  assert.equal(after["item_q1.jpg"].attrsAt, undefined, "the two still stamped today were left alone");
  assert.equal(after["item_q3.jpg"].attrsAt, undefined);
});

// A model that looks at a garment and has nothing usable to say about it is
// still an answer: the garment is DESCRIBED — badly — and asking again
// tomorrow, and every morning after that, would spend one request a day per
// garment for ever on a wardrobe nobody can improve. `attrsAt` is what
// remembers that, which is why the pass keys on the marker and not on "no
// colours" (plan A4-5, blocker B1-a).
test("a garment the model had nothing to say about is asked once, not every morning", async () => {
  seedWardrobe(NOTHING, [["item_n1", "Sunny tee", "top"]]);
  withKey(NOTHING);
  clothing.start(NOTHING, { noTimers: true, tz: () => ZONE });
  clothing._testReset();

  mode = "empty";
  const before = calls;
  const r = await clothing.regenerate(true);
  mode = "ok";
  assert.equal(calls - before, 1, "it was asked once");
  assert.equal(r.attrsDone, 1, "an answer that parses counts as described, whatever it said");
  const it = catalogOf(NOTHING)["item_n1.jpg"];
  assert.equal(it.attrsAt, today(), "…and the garment carries the day it was described");
  assert.ok(!it.colors || !it.colors.length, "even though there is nothing to show for it");

  // tomorrow (the day stamp rolls over): still not asked
  const items = catalogOf(NOTHING);
  items["item_n1.jpg"].attrsTriedAt = "2026-01-01";
  fs.writeFileSync(path.join(NOTHING, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  await clothing.regenerate(true);
  assert.equal(calls - before, 1, "and never asked again on a later day");
});

// ---- degradation, never exclusion (spec §3.1 item 4) ----------------------

test("no attributes anywhere and no key: the board is still a full 21", async () => {
  // Eight tops by seven bottoms: enough for a garment-distinct page of seven
  // with one garment to spare, and 56 pairs behind the day's 21. (A smaller
  // wardrobe would run page 1 short and the RENDERED first seven would spill
  // into the next algorithmic page, where a garment may return — I11.)
  const names = [];
  for (let i = 1; i <= 8; i++) names.push(["item_t" + i, "Sunny tee " + i, "top"]);
  for (let i = 1; i <= 7; i++) names.push(["item_b" + i, "Sky leggings " + i, "pants"]);
  seedWardrobe(PLAIN, names);          // no ai-config.json: nothing can be asked
  clothing.start(PLAIN, { noTimers: true, tz: () => ZONE });
  clothing._testReset();
  const before = calls;
  await clothing.regenerate(true);
  assert.equal(calls, before, "no key, no calls — the pass never runs without one");

  const boards = JSON.parse(fs.readFileSync(path.join(PLAIN, "recipes", "today.json"), "utf8")).boards;
  const outfits = boards.filter(b => /^today(_\d)?$/.test(b.id))
    .flatMap(b => b.buttons.filter(x => x.type === "outfit"));
  assert.equal(outfits.length, 21, "a wardrobe the model has never described still fills the day");
  const page1 = boards.find(b => b.id === "today").buttons
    .filter(x => x.type === "outfit").flatMap(x => x.combo);
  assert.equal(new Set(page1).size, page1.length, "and page 1 still repeats no garment");
});
