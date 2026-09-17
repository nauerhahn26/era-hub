// clothing-item.test.mjs — the door a grown-up's correction comes through
// (accessories spec §5.1/§5.2, plan T6). Hub on 8468 (the accessories band;
// 8465/8467 belong to the worker-side suite, and nothing else in the five
// repos answers on 8468).
//
// What this suite owns is the ROUTE's contract, and nothing behind it: the
// file that lands, the line the family gets, the rebuild that is asked for,
// the sentence a refusal says and the door the request has to come through.
// "the next build actually moves the garment" is the worker's promise and is
// proven in tests/clothing-accessories.test.mjs — a route that wrote the right
// file would pass here whether or not the build ever read it, and that is on
// purpose: these are two different ways to be broken.
//
// Synthetic wardrobe (no key, no network: every provider seam is a closed
// port), a real Drive folder on disk so the shared log has somewhere to go.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8468;                      // plan §B ports; never live 8377
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-clothing-item-"));
const DATA = path.join(TMP, "data");
const DRIVE = path.join(TMP, "drive");
const CATALOG = path.join(DATA, "wardrobe.json");
const EDITS = path.join(DATA, "wardrobe", "edits.json");

const SEAMS = {
  ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_RESEND_URL: "http://127.0.0.1:1", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_AI_URL: "http://127.0.0.1:1",
  ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
};

let child, items, deviceId;
const TOP = () => items[0].id;          // g01.jpg — the model called it a top
const JACKET = () => items[1].id;       // g02.jpg — seeded as a jacket below

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const catalog = () => readJson(CATALOG);
const entryFor = (id) => Object.values(catalog().items).find(i => i.id === id);
const edits = () => { try { return readJson(EDITS); } catch { return null; } };
const status = async () => (await fetch(`${BASE}/clothing/status`, { cache: "no-store" })).json();

// The family's copy of this device's tags, as clothing-log.js lays them out.
const tagsFile = () => path.join(DRIVE, "clothing", ".era", "tags", deviceId + ".jsonl");
function tagLines() {
  try { return fs.readFileSync(tagsFile(), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

const post = (body, headers = {}) => fetch(`${BASE}/clothing/item`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

// A build settles in stages; "not building" has to hold twice with a gap, or a
// queued run starts right after the check said the hub was idle.
async function idle(tries = 120) {
  for (let round = 0; round < 2; round++) {
    let ok = false;
    for (let i = 0; i < tries; i++) {
      if (!(await status()).building) { ok = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(ok, "the hub settled");
    if (round === 0) await new Promise(r => setTimeout(r, 800));
  }
}

before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  // Two garments with photos, tiles and a hash, plus the family's folder: a
  // hub that boots straight into a catalogue without ever needing a key.
  items = materialize({ dataDir: DATA, n: 2, driveFolder: DRIVE });
  // The second one is the accessory this suite reads back out of /status.
  // Seeded in the catalogue rather than through a build: the sweep that moves
  // a garment on a model's word is the worker's, not this door's.
  const cat = catalog();
  for (const it of Object.values(cat.items)) if (it.id === items[1].id) it.category = "jacket";
  fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 1));
  items[1].category = "jacket";
  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: DRIVE }));
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: DATA };
  delete env.ERA_DEVICE_ID;             // this hub names itself, like a family's does
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env,
  });
  let up = false;
  for (let i = 0; i < 200; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("hub never came up");
  deviceId = fs.readFileSync(path.join(DATA, "device-id"), "utf8").trim();
  await idle();
});
after(() => { if (child) child.kill("SIGKILL"); fs.rmSync(TMP, { recursive: true, force: true }); });

test("a correction lands in edits.json, goes out to the family as a manual tag, and asks for a build", async () => {
  const before = tagLines().length;
  const r = await post({ id: TOP(), category: "jacket" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.ok, true);
  assert.equal(typeof out.builds, "boolean", "the sheet is told whether a build started");
  assert.equal(out.builds, true, "the hub was idle, so this edit is on its way into a board now");

  // 1. the local file the worker reads on its next build
  const e = edits();
  assert.ok(e && e[TOP()], "the edit is written under the garment's own id");
  assert.equal(e[TOP()].category, "jacket");
  assert.match(e[TOP()].t, /^\d{4}-\d{2}-\d{2}T/, "stamped when the parent said it");
  assert.equal("hidden" in e[TOP()], false, "only what was asked for is written");

  // 2. the family's folder: a COMPLETE tag line, not a fragment — another
  //    device that has never seen this photo must be able to file it.
  const lines = tagLines();
  assert.equal(lines.length, before + 1, "exactly one line per edit");
  const last = lines.at(-1);
  assert.equal(last.manual, true, "a grown-up looked at the garment (spec §3.4)");
  assert.equal(last.id, TOP());
  assert.equal(last.hash, entryFor(TOP()).hash, "…and the hash, so a device with another filename finds it");
  assert.equal(last.category, "jacket", "the field the parent changed");
  assert.equal(last.name, items[0].name, "…and the fields they did not, copied off the catalogue");
  assert.equal(last.warmth, items[0].warmth);
  assert.deepEqual(last.colors, items[0].colors);
  assert.match(String(last.t), /^\d{4}-\d{2}-\d{2}T/);

  // 3. the catalogue is NOT this door's to write (preflight 4)
  assert.equal(entryFor(TOP()).category, "top",
    "only the worker writes wardrobe.json — the route queues the edit, it does not apply it");
  await idle();
});

test("a second edit for the same garment is the parent's latest word, not a merge", async () => {
  const r = await post({ id: TOP(), hidden: true });
  assert.equal(r.status, 200);
  const e = edits();
  assert.deepEqual(Object.keys(e[TOP()]).sort(), ["hidden", "t"],
    "the entry is REPLACED: the category they set a moment ago is not carried along");
  assert.equal(e[TOP()].hidden, true);
  assert.equal(tagLines().at(-1).hidden, true);
  await idle();
});

test("an edit for a second garment sits beside the first, and neither disturbs the other", async () => {
  const r = await post({ id: JACKET(), occasion: "fancy" });
  assert.equal(r.status, 200);
  const e = edits();
  assert.equal(e[JACKET()].occasion, "fancy");
  assert.equal(e[TOP()].hidden, true, "the other garment's edit is still there");
  await idle();
});

test("a body the route cannot act on is refused with one plain sentence", async () => {
  const before = JSON.stringify(edits());
  const cases = [
    ["an id that is not an id", { id: "../../etc/passwd", category: "jacket" }],
    ["a garment this family does not own", { id: "item_00deadbeef", category: "jacket" }],
    ["a kind of clothing the hub does not know", { id: TOP(), category: "cheese" }],
    ["an occasion that is neither everyday nor fancy", { id: TOP(), occasion: "wedding" }],
    ["a hide that is not yes or no", { id: TOP(), hidden: "yes" }],
    ["nothing to change at all", { id: TOP() }],
    ["no body worth the name", "{not json"],
  ];
  for (const [why, body] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, why);
    const out = await r.json();
    assert.equal(typeof out.error, "string", why + " — and it says why");
    assert.ok(out.error.length > 8 && /[a-z]/.test(out.error), why + ": " + out.error);
    assert.equal(/item_[0-9a-f]|\/\^|regex|undefined/i.test(out.error), false,
      "a parent reads this sentence, not the code that wrote it: " + out.error);
  }
  assert.equal(JSON.stringify(edits()), before, "a refused edit changes nothing on disk");
});

test("a body far bigger than any edit is dropped on the floor", async () => {
  await assert.rejects(() => post({ id: TOP(), category: "jacket", pad: "x".repeat(8192) }));
});

test("the edit door is this hub's own pages only", async () => {
  const before = JSON.stringify(edits());
  const r = await post({ id: TOP(), category: "shoes" }, { "sec-fetch-site": "cross-site" });
  assert.equal(r.status, 403);
  assert.equal(JSON.stringify(edits()), before, "a request from somewhere else edits nothing");
});

test("a catalogue that will not parse is 'try again', never a wrong refusal and never a rewrite", async () => {
  await idle();
  const good = fs.readFileSync(CATALOG);
  const torn = Buffer.from('{"items":{"g01.jpg":{"id":"item_');   // the worker, mid-write
  fs.writeFileSync(CATALOG, torn);
  try {
    const r = await post({ id: TOP(), category: "jacket" });
    assert.equal(r.status, 503, "the garment may well exist — the hub simply cannot see it yet");
    const out = await r.json();
    assert.equal(out.error, "catalogue busy — try again");
    assert.deepEqual(fs.readFileSync(CATALOG), torn,
      "and the door that cannot read wardrobe.json certainly does not write it");
  } finally {
    fs.writeFileSync(CATALOG, good);
  }
});

test("/clothing/status counts the accessories she can reach, and the ones a grown-up hid", async () => {
  await idle();
  // The edits posted above were REAL: the builds they asked for swept
  // edits.json into the catalogue (T4), so by now the top is filed as a jacket
  // and hidden on disk. This test owns the read-out, not the sweep — start
  // from a clean queue and the seeded catalogue, with no build pending to
  // put the edits back.
  fs.rmSync(EDITS, { force: true });
  {
    const cat = catalog();
    for (const it of Object.values(cat.items)) {
      it.hidden = false;
      it.category = it.id === JACKET() ? "jacket" : "top";
    }
    fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 1));
  }
  let s = await status();
  assert.deepEqual(s.accessories, { kinds: [{ kind: "jacket", count: 1 }], hidden: 0 },
    "one jacket in the catalogue, nothing hidden");

  // A second kind, out of alphabetical order on purpose: the read-out is in
  // ACCESSORY_KINDS order (the order she meets the tiles in), not sorted.
  const cat = catalog();
  const set = (id, over) => { for (const it of Object.values(cat.items)) if (it.id === id) Object.assign(it, over); };
  const save = () => fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 1));
  set(TOP(), { category: "hat" });
  save();
  s = await status();
  assert.deepEqual(s.accessories.kinds, [{ kind: "jacket", count: 1 }, { kind: "hat", count: 1 }],
    "jacket before hat, as ACCESSORY_KINDS has them — not 'hat' first because h sorts before j");

  // Hidden is the worker's stamp, so it is seeded here the way a swept
  // catalogue would carry it: the read-out is what this test owns.
  set(JACKET(), { hidden: true });
  save();
  s = await status();
  assert.deepEqual(s.accessories, { kinds: [{ kind: "hat", count: 1 }], hidden: 1 },
    "a hidden jacket is not a kind she can reach — it is counted as hidden instead");

  // …and with nothing accessory-shaped left, the block is still there and still
  // answers: Settings prints nothing from it rather than guessing.
  for (const it of Object.values(cat.items)) { it.category = "top"; it.hidden = false; }
  save();
  s = await status();
  assert.deepEqual(s.accessories, { kinds: [], hidden: 0 });
});
