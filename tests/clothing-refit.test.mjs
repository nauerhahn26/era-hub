// clothing-refit.test.mjs — the one-time refit pass (warmth coherence spec
// 2026-09-29 §2 D1, §3; plan phase 3 step 4).
//
// The family's 63 garments were catalogued before the ingest prompt asked how
// a garment is CUT. Until something tells the hub, the fit gate reads the
// legacy fallback from each warmth word. The refit pass is how the words
// arrive — and it is an OPERATOR's pass, run on ONE device: `POST
// /clothing/refit`. It consults the family's shared log first (by id, then by
// hash), calls the model only for a garment nobody has described, stamps
// `fitAt` (one-way) and `fitTriedAt` (daily, before the answer), publishes
// every real answer as a shared tag line, stops after two misses in a row,
// and rebuilds the board. The other device adopts the lines on its next sync
// and never runs the pass by itself: NOTHING but the route triggers it — not
// boot, not the morning tick, not a regenerate, not a sync. That rule is
// what closes the 9/21 hole (two devices describing the same twelve garments
// two minutes apart), so it is the first thing this suite pins.
//
// Ports 8452 (this suite's fake model) and 8453 (its hub, for the route) —
// surveyed free across all five repos 9/29. No key is ever spent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { materialize } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AI_PORT = 8452;          // this suite's fake model
const HUB_PORT = 8453;         // this suite's hub, for the route
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey } = require("./clothing-rank.js");
const clothing = require("./clothing.js");
const drive = require("./drive.js");
// The attrs suite's clock: neither this box's zone nor the module's default.
const ZONE = (() => {
  const now = Date.now();
  const box = dayKey(now, "UTC"), mod = dayKey(now, "America/Los_Angeles");
  const ends = ["Pacific/Kiritimati", "Etc/GMT+12"];
  return ends.find(z => dayKey(now, z) !== box && dayKey(now, z) !== mod)
      || ends.find(z => dayKey(now, z) !== box) || ends[0];
})();
const today = () => dayKey(Date.now(), ZONE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-refit-"));

let ai;
let calls = 0;
const asks = [];
let mode = "ok";               // "ok" | "503"
// What the model says about each garment, cycled: a sweatshirt, a tee, pants.
const ANSWERS = [
  { coverage: "long", weight: "mid" },
  { coverage: "short", weight: "heavy" },          // a weight nobody asked of a tee: dropped
  { coverage: "long", weight: "unsure", legs: "covered" },
];

function jpeg() { return require("./vendor/jpeg-js"); }
function makeJpg(file, w, h, r, g, b) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg().encode({ data, width: w, height: h }, 85).data);
}
// Garments the hub already knows by name, has tiles for and has DESCRIBED
// (attrsAt, colours) — so the needs-attributes pass is silent and every call
// the fake counts is refit's — and says nothing about how they are cut.
function seed(name, garments, driveFolder) {
  const dir = path.join(TMP, name);
  const items = {};
  garments.forEach(([id, gname, category, warmth], i) => {
    makeJpg(path.join(dir, "clothing", id + ".jpg"), 320, 480, 40 + i * 30, 90, 200 - i * 20);
    makeJpg(path.join(dir, "wardrobe-items", id + ".jpg"), 640, 640, 40 + i * 30, 90, 200 - i * 20);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "clothing", id + ".jpg"))).digest("hex");
    items[id + ".jpg"] = { id, ok: true, name: gname, category, warmth, hash,
      colors: ["blue"], pattern: "solid", statement: false, attrsAt: "2026-09-01" };
  });
  fs.writeFileSync(path.join(dir, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  fs.writeFileSync(path.join(dir, "ai-config.json"), JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  if (driveFolder) {
    fs.mkdirSync(path.join(driveFolder, "clothing"), { recursive: true });
    fs.writeFileSync(path.join(dir, "drive.json"), JSON.stringify({ mode: "local", folderPath: driveFolder }));
  }
  return dir;
}
const THREE = [["item_r1", "Grey sweatshirt", "top", "cool"], ["item_r2", "Sunny tee", "top", "warm"],
               ["item_r3", "Long dress", "dress", "cool"]];
const catalogOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "wardrobe.json"), "utf8")).items;
const start = (dir, deviceId = "dev-refit") => {
  drive.start(dir);
  clothing.start(dir, { noTimers: true, tz: () => ZONE, deviceId });
  clothing._testReset();
};
const tagLinesOf = (driveFolder, writer) => {
  try {
    return fs.readFileSync(path.join(driveFolder, "clothing", ".era", "tags", writer + ".jsonl"), "utf8")
      .trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch { return []; }
};

before(async () => {
  process.env.ERA_AI_URL = `http://127.0.0.1:${AI_PORT}`;
  process.env.ERA_GEO_URL = "http://127.0.0.1:1/geo";
  process.env.ERA_WEATHER_URL = "http://127.0.0.1:1";
  process.env.ERA_AI_SPACING_MS = "50";
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      calls++;
      const content = (parsed.messages && parsed.messages[0] && parsed.messages[0].content) || [];
      asks.push((content.find(p => typeof p.text === "string") || {}).text || "");
      if (mode === "503") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":{"code":503,"message":"The model is overloaded"}}');
        return;
      }
      const text = JSON.stringify(ANSWERS[(calls - 1) % ANSWERS.length]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));
});
after(() => {
  if (ai) ai.close();
  for (const k of ["ERA_AI_URL", "ERA_GEO_URL", "ERA_WEATHER_URL", "ERA_AI_SPACING_MS"]) delete process.env[k];
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- nothing but the route --------------------------------------------------

test("a device that never asks for a refit never spends: boot, tick, regenerate and re-sort ask nothing", async () => {
  const D = seed("never", THREE);
  start(D);
  const before = calls;
  await clothing.regenerate(true);                // the full build: ingest + attrs pass
  await clothing.rebuildToday();                  // the weather re-sort
  await (clothing.tick("test") || Promise.resolve());   // the morning tick (the board is fresh: a no-op)
  assert.equal(calls, before, "no door but /clothing/refit spends a request on the cut");
  const items = catalogOf(D);
  for (const it of Object.values(items)) {
    assert.equal("fitAt" in it, false, it.name);
    assert.equal("fitTriedAt" in it, false, it.name + " — not even tried");
  }
  assert.deepEqual(clothing.status().refit, { pending: 3, done: 0 },
    "…and the status says three garments are still owed a look");
});

// ---- the pass -----------------------------------------------------------------

test("refit asks once per garment from its tile, stamps fitAt, shares each answer and rebuilds the board", async () => {
  const DRIVE = path.join(TMP, "refit-drive");
  const D = seed("refit", THREE, DRIVE);
  start(D);
  const before = calls;
  const r = await clothing.refit();
  assert.equal(calls - before, 3, "one call per garment");
  assert.equal(r.mode, "cataloged", "the board was rebuilt after the pass");
  assert.equal(r.refitDone, 3);
  assert.equal(r.refitLeft, 0);
  for (const a of asks.slice(-3)) {
    assert.match(a, /"coverage"/);
    assert.match(a, /"legs"/);
    assert.match(a, /"weight"/);
    assert.match(a, /ONLY a JSON object/);
    assert.doesNotMatch(a, /"category"|"colors"|"top_side"/, "it asks the cut and nothing the hub already knows");
  }
  const items = catalogOf(D);
  const [a, b, c] = ["item_r1.jpg", "item_r2.jpg", "item_r3.jpg"].map(k => items[k]);
  assert.deepEqual([a.coverage, a.weight], ["long", "mid"]);
  assert.equal(b.coverage, "short");
  assert.equal("weight" in b, false, "a heavy tee is a word nobody asked for");
  assert.deepEqual([c.coverage, c.weight, c.legs], ["long", "unsure", "covered"]);
  for (const it of [a, b, c]) {
    assert.equal(it.fitAt, today(), it.name);
    assert.equal(it.fitTriedAt, today(), it.name);
    assert.equal(it.category !== undefined && it.name !== undefined && it.colors.length, 1,
      it.name + ": the pass wrote the cut and nothing else");
  }
  const lines = tagLinesOf(DRIVE, "dev-refit");
  assert.equal(lines.length, 3, "every real answer goes out to the family");
  assert.equal(lines.find(l => l.id === "item_r1").coverage, "long");
  assert.equal(lines.find(l => l.id === "item_r1").name, "Grey sweatshirt", "a complete line");
  assert.deepEqual(clothing.status().refit, { pending: 0, done: 3 });
  assert.ok(fs.existsSync(path.join(D, "recipes", "today.json")));
});

test("a garment with fitAt is never asked again — not the same day, not the next", async () => {
  const D = path.join(TMP, "refit");
  start(D);
  const before = calls;
  await clothing.refit();
  assert.equal(calls, before, "the same day asks nothing");
  const items = catalogOf(D);
  for (const k of Object.keys(items)) items[k].fitTriedAt = "2026-01-01";
  fs.writeFileSync(path.join(D, "wardrobe.json"), JSON.stringify({ items }, null, 1));
  await clothing.refit();
  assert.equal(calls, before, "a described garment is described: fitAt is one-way");
});

test("a garment the family already described is adopted from the shared log — by id or by hash — with no call and nothing published", async () => {
  const DRIVE = path.join(TMP, "adopt-drive");
  const D = seed("adopt", THREE, DRIVE);
  const items = catalogOf(D);
  // What the mirror delivered from the tablet that ran the pass: one line by
  // id, one by hash only (the photo is saved under another name there), and
  // one written before 9/29 that says nothing about the cut.
  const f = path.join(D, "clothing", ".era", "tags", "tablet.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    { t: "2026-09-29T08:00:00.000Z", id: "item_r1", name: "Grey sweatshirt", category: "top", coverage: "long", weight: "heavy" },
    { t: "2026-09-29T08:00:01.000Z", hash: items["item_r3.jpg"].hash, name: "Long dress", category: "dress",
      coverage: "long", legs: "covered" },
    { t: "2026-09-16T08:00:00.000Z", id: "item_r2", name: "Sunny tee", category: "top", colors: ["blue"] },
  ].map(l => JSON.stringify(l) + "\n").join(""));
  start(D, "dev-adopt");
  const before = calls;
  const r = await clothing.refit();
  assert.equal(calls - before, 1, "only the garment nobody had described costs a call");
  assert.equal(r.refitDone, 3);
  const after = catalogOf(D);
  assert.deepEqual([after["item_r1.jpg"].coverage, after["item_r1.jpg"].weight], ["long", "heavy"]);
  assert.deepEqual([after["item_r3.jpg"].coverage, after["item_r3.jpg"].legs], ["long", "covered"]);
  for (const k of ["item_r1.jpg", "item_r3.jpg"]) assert.equal(after[k].fitAt, today(), k + " adopted");
  const mine = tagLinesOf(DRIVE, "dev-adopt");
  assert.deepEqual(mine.map(l => l.id), ["item_r2"], "an adopted answer is already in the log: only the real one is published");
});

test("a provider that is busy stops the pass after two garments, and the same day asks nothing more", async () => {
  const D = seed("busy", THREE);
  start(D);
  mode = "503";
  const before = calls;
  const r = await clothing.refit();
  mode = "ok";
  // Anthropic's ladder: two models, one retry each = four requests a garment.
  assert.equal(calls - before, 8, "two garments' worth of ladder, then the pass believes the provider");
  assert.equal(r.refitDone, 0);
  assert.equal(r.refitLeft, 3);
  assert.equal(r.mode, "cataloged", "the board is still rebuilt");
  const items = catalogOf(D);
  for (const it of Object.values(items)) {
    assert.equal(it.fitTriedAt, today(), it.name + " was tried today (stamped before the answer)");
    assert.equal("fitAt" in it, false, it.name + " is still undescribed");
  }
  const mid = calls;
  await clothing.refit();
  assert.equal(calls, mid, "the same day, a second refit asks nothing");
  assert.deepEqual(clothing.status().refit, { pending: 3, done: 0 });
});

test("the model never overrules a parent: a sleeve a grown-up set survives the refit", async () => {
  const D = seed("manual", [["item_m1", "Grey sweatshirt", "top", "cool"]]);
  fs.mkdirSync(path.join(D, "wardrobe"), { recursive: true });
  fs.writeFileSync(path.join(D, "wardrobe", "edits.json"),
    JSON.stringify({ item_m1: { coverage: "short", t: new Date().toISOString() } }));
  start(D);
  await clothing.rebuildToday();                  // the sweep lands the parent's word
  assert.equal(catalogOf(D)["item_m1.jpg"].coverage, "short");
  calls = 0;                                       // the model will answer "long"
  await clothing.refit();
  const it = catalogOf(D)["item_m1.jpg"];
  assert.equal(it.coverage, "short", "the parent looked at it; the model guessed");
  assert.equal(it.fitAt, today(), "…and the garment is still counted as refit");
});

// ---- the route ------------------------------------------------------------------

test("POST /clothing/refit is this hub's own door, answers 202 and runs behind; /clothing/status counts it down", async () => {
  const D = path.join(TMP, "route");
  materialize({ dataDir: D, n: 4 });
  fs.writeFileSync(path.join(D, "ai-config.json"), JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));
  const env = { ...process.env, ERA_DATA_DIR: D, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
    ERA_AI_URL: `http://127.0.0.1:${AI_PORT}`, ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
    ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
    ERA_TMDB_URL: "http://127.0.0.1:1", ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_AI_SPACING_MS: "50" };
  const child = spawn("node", ["server.js", String(HUB_PORT)], { cwd: HUB, stdio: ["ignore", "ignore", "inherit"], env });
  const BASE = `http://127.0.0.1:${HUB_PORT}`;
  const status = async () => (await fetch(`${BASE}/clothing/status`, { cache: "no-store" })).json();
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { await fetch(`${BASE}/settings`); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(up, "the hub came up");
    const s0 = await status();
    assert.deepEqual(s0.refit, { pending: 4, done: 0 }, "four garments, none refit yet");

    const x = await fetch(`${BASE}/clothing/refit`, { method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" });
    assert.equal(x.status, 403, "a page somewhere else cannot spend the family's key");

    const before = calls;
    // the Settings/operator page's own shape: a JSON POST, same origin
    const r = await fetch(`${BASE}/clothing/refit`, { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { started: true });
    let s;
    for (let i = 0; i < 200; i++) {
      s = await status();
      if (s.refit.pending === 0 && !s.building) break;
      await new Promise(res => setTimeout(res, 150));
    }
    assert.deepEqual(s.refit, { pending: 0, done: 4 });
    assert.equal(calls - before, 4, "one call per garment");
  } finally { child.kill("SIGKILL"); }
});
