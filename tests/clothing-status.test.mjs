// clothing-status.test.mjs — what a parent can SEE of the learning
// (spec §4, plan T5.1). Hub on 8461 (plan §B).
//
// /clothing/status is the only window onto the memory: how many days of picks
// are recorded, which looks she keeps choosing, how much of the sixty-day
// memory is filled and whether the family's other devices are sharing. It is
// PUBLIC and unauthenticated, so what it may say is as much of the test as
// what it says: a count of devices, never their names (plan W12/A4-2), and
// never a folder path.
//
// The read-out is memoized on the day plus the stat of the two files it reads
// through — never a TTL (plan W11). A TTL would make a history.json written a
// moment ago invisible for up to a minute, and this suite seeds one under the
// RUNNING hub and reads it back on the very next poll.
//
// Synthetic wardrobe, no key, every provider seam at a closed port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { materialize } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey, yesterdayOf } = require("./clothing-rank.js");
const PORT = 8461;                       // plan §B
const BASE = `http://127.0.0.1:${PORT}`;

// ONE clock for the suite, and deliberately neither of the two wrong answers
// (plan T2.4): not the build box's own zone — it is Etc/UTC, so a read-out
// that bucketed "today" by the OS clock would agree with every assertion
// here — and not clothing.js's own default (America/Los_Angeles), which a
// read-out that ignored the profile would fall back to. profile.json hands
// the hub this zone and the suite derives every day key from it.
const ZONE = (() => {
  const now = Date.now();
  const wrong = [dayKey(now, "UTC"), dayKey(now, "America/Los_Angeles")];
  const ends = ["Pacific/Kiritimati", "Etc/GMT+12"];
  return ends.find(z => !wrong.includes(dayKey(now, z)))
      || ends.find(z => dayKey(now, z) !== wrong[0]) || ends[0];
})();
const TODAY = dayKey(Date.now(), ZONE);
const D1 = yesterdayOf(TODAY), D2 = yesterdayOf(D1), D3 = yesterdayOf(D2);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-clothing-status-"));
const DATA = path.join(TMP, "data");
const DRIVE = path.join(TMP, "drive");
const HISTORY = path.join(DATA, "wardrobe", "history.json");
// Ids the catalogue cannot resolve: a combo naming one of them is dropped from
// the read-out rather than shown with a hole in it.
const GHOST = ["item_00deadbeef", "item_00cafebabe"];
let child, items;

const SEAMS = {
  ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_RESEND_URL: "http://127.0.0.1:1", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_AI_URL: "http://127.0.0.1:1",
  ERA_BIND: "127.0.0.1",
};

const status = async () => (await fetch(`${BASE}/clothing/status`, { cache: "no-store" })).json();
const raw = async () => (await fetch(`${BASE}/clothing/status`, { cache: "no-store" })).text();
// A build settles in stages (POST /clothing/regenerate syncs first, which can
// queue a tick's build), so "not building" has to hold twice with a gap.
async function idle(tries = 120) {
  for (let round = 0; round < 2; round++) {
    let ok = false;
    for (let i = 0; i < tries; i++) {
      if (!(await status()).building) { ok = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(ok, "the hub settled");
    if (round === 0) await new Promise(r => setTimeout(r, 2500));
  }
}
const readHistory = () => JSON.parse(fs.readFileSync(HISTORY, "utf8"));
const writeHistory = (h) => fs.writeFileSync(HISTORY, JSON.stringify(h));
const yes = (combo, at) => ({ kind: "yes", combo, at });
// Deliver a line the way the Drive mirror would.
function deliver(rel, line) {
  const f = path.join(DATA, "clothing", ".era", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(line) + "\n");
}

before(async () => {
  fs.mkdirSync(DRIVE, { recursive: true });
  items = materialize({ dataDir: DATA, n: 8 });
  fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify({ tz: ZONE }));
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: DATA };
  delete env.ERA_DEVICE_ID;              // this hub names itself (T4.1)
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env,
  });
  for (let i = 0; i < 200; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});
after(() => { if (child) child.kill("SIGKILL"); fs.rmSync(TMP, { recursive: true, force: true }); });

test("before her first Yes the read-out says so, and today's own board is the whole memory", async () => {
  await fetch(`${BASE}/clothing/regenerate`, { method: "POST" });
  await idle();
  const s = await status();
  assert.equal(s.cataloged, 8, "eight synthetic garments, no AI key needed");
  assert.deepEqual(s.picks, { days: 0, lastDay: null, top: [] },
    "nothing to learn from yet — and that is a sentence Settings can write");
  assert.equal(s.memory.days, 1, "the build just recorded today (spec §4 memory counts today)");
  assert.equal(s.memory.yesterdayPage1, 0, "there was no yesterday");
});

test("a memory seeded under the running hub is read on the very next poll (no TTL)", async () => {
  const h = readHistory();
  assert.ok(h.days[TODAY], "the build recorded today in the family's zone, not the box's");
  const mine = [items[0].id, items[3].id];
  for (const [i, day] of [D3, D2, D1].entries()) {
    h.events[day] = [yes(mine, day + "T18:0" + i + ":00Z"), yes(GHOST, day + "T18:30:00Z")];
    h.days[day] = { band: null, page1: day === D1 ? [mine, [items[5].id]] : [mine] };
  }
  writeHistory(h);

  const s = await status();          // the very next poll: no sleep, no second write
  assert.equal(s.picks.days, 3, "three days of picks, seen at once");
  assert.equal(s.picks.lastDay, D1);
  assert.equal(s.picks.top.length, 1, "the combo naming a garment the catalogue lost is dropped");
  assert.equal(s.picks.top[0].weight, 3, "one credit a day per combo");
  assert.deepEqual(s.picks.top[0].combo, mine);
  assert.deepEqual(s.picks.top[0].names, [items[0].name, items[3].name],
    "the names Settings prints come from the catalogue");
  assert.equal(JSON.stringify(s.picks).includes(GHOST[0]), false,
    "an unresolvable id is not shown with a hole in it");
  assert.equal(s.memory.days, 4, "three seeded days plus today");
  assert.equal(s.memory.yesterdayPage1, 2, "yesterday's page 1, as the bar tomorrow reads it");
});

test("today's own Yes is not a day of picks yet — the memory counts days before this one", async () => {
  const combo = [items[1].id, items[4].id];
  const r = await fetch(`${BASE}/outfit-event`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "yes", combo }) });
  assert.equal(r.status, 204);
  assert.ok(readHistory().events[TODAY].length >= 1, "…and it IS recorded, in the family's day");
  const s = await status();
  assert.equal(s.picks.days, 3, "a pick made today counts tomorrow (spec §3.3 'days before today')");
  assert.equal(s.picks.top.length, 1);
  assert.equal(s.memory.days, 4);
});

test("sharing is local until the family has a Drive folder, and drive the moment they do", async () => {
  // A folder the family has since disconnected (or swapped for API mode) leaves
  // the OTHER devices' mirrored lines sitting under <DATA>/clothing/.era. The
  // payload must not then say "not shared" and "two devices" in one breath.
  deliver(`picks/dev-b/${D1}.jsonl`, { t: D1 + "T18:00:00Z", kind: "yes", combo: [items[2].id] });
  writeHistory(readHistory());       // the memo turns over on the memory's stat
  let s = await status();
  assert.equal(s.sharing.mode, "local", "no folder — drive.js calls that mode 'local' too (W13)");
  assert.equal(s.sharing.devices, 1, "nothing is shared, so nobody is sharing it: mode and count agree");

  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: DRIVE }));
  s = await status();
  assert.equal(s.sharing.mode, "drive", "the card must not say 'not shared' until tomorrow");
  assert.equal(s.sharing.devices, 2, "…and the device whose lines were already mirrored counts from the same moment");
});

test("every other writer in the family's folder is counted, and none of them is named", async () => {
  deliver(`picks/dev-b/${D1}.jsonl`, { t: D1 + "T18:00:00Z", kind: "yes", combo: [items[2].id] });
  deliver(`offers/dev-c/${D1}.jsonl`, { t: D1 + "T07:00:00Z", band: null, page1: [[items[2].id]] });
  deliver("tags/studio.jsonl", { t: D3 + "T07:00:00Z", id: items[2].id, category: "top", warmth: 1 });
  // The shared half is re-read when the memory changes — which every Yes does.
  await fetch(`${BASE}/outfit-event`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "yes", combo: [items[1].id] }) });

  const s = await status();
  assert.equal(s.sharing.devices, 3, "this device and two others — the migration tool's 'studio' "
    + "lines are in the folder from before the first build (§7/A4-13) and are not a third tablet");
  const body = await raw();
  const own = fs.readFileSync(path.join(DATA, "device-id"), "utf8").trim();
  assert.equal(body.includes(own), false, "this device's own name never leaves it");
  for (const name of ["dev-b", "dev-c", "studio"])
    assert.equal(body.includes(name), false, name + " is a count, not a name");
  assert.deepEqual(Object.keys(s.sharing).sort(), ["devices", "mode"],
    "two fields, and neither of them can carry a name: a payload that grew a third has to argue here");
  assert.equal(body.includes(DRIVE), false, "and no folder path — this endpoint is public");

  // …and the other device's Yes really did reach the read-out: without the
  // merge the assertion above would pass just as well.
  assert.equal(s.picks.top.some(c => c.combo.length === 1 && c.combo[0] === items[2].id), true,
    "another device's pick is one of hers too (spec §5 'Reads')");
});

// The whole point of the sentence Settings writes — "Favourites: A + B (×3),
// C (×2)…" — is that A is the look she chooses MOST. Until now every case in
// this suite had one resolvable combo, so any order at all was green: a
// comparator flipped by a typo would have shown a parent her five LEAST-chosen
// looks, and the "top five" of spec §4 would have been "all of them".
test("her favourites come out most-chosen first, and never more than five (spec §4 'top five')", async () => {
  // Six more combos, each said Yes to on a different NUMBER of past days, so
  // the weight is the only thing that can put them in this order.
  const combos = [
    [items[0].id, items[1].id], [items[2].id, items[3].id], [items[4].id, items[5].id],
    [items[6].id, items[7].id], [items[0].id], [items[1].id],
  ];
  const days = [];
  for (let d = D3, i = 0; i < 9; i++) days.push(d = yesterdayOf(d));
  const h = readHistory();
  combos.forEach((combo, i) => {
    for (let n = 0; n < 9 - i; n++) {          // weights 9, 8, 7, 6, 5, 4
      const day = days[n];
      (h.events[day] || (h.events[day] = [])).push(yes(combo, day + "T18:0" + i + ":00Z"));
    }
  });
  writeHistory(h);

  const s = await status();
  assert.deepEqual(s.picks.top.map(c => c.weight), [9, 8, 7, 6, 5],
    "best-loved first — a parent reads the first name as the one she wears most");
  assert.deepEqual(s.picks.top.map(c => c.combo), combos.slice(0, 5),
    "…and the names go with the weights");
  // Eight combos resolve now (these six, the two-piece of the second case and
  // the other device's single); five is what a sentence can hold.
  assert.equal(s.picks.top.length, 5, "the top five, not the whole memory");
});

// The mirror of tests/clothing-weather.test.mjs' "a history.json the build
// cannot open is left alone": readHistory rethrows every non-ENOENT read error
// precisely so no caller can mistake a held file for an empty memory. The
// read-out is the third caller, and the sentence it feeds is a claim about the
// family's own data — "No picks recorded yet" repainted every five seconds
// while sixty days sit on the disk. Saying nothing is the only honest answer.
test("a memory the read-out cannot open makes it say nothing, not 'no picks recorded yet'", {
  skip: process.getuid && process.getuid() === 0 ? "root reads every file" : false,
}, async () => {
  assert.ok((await status()).picks.days > 0, "there IS a memory to be wrong about");
  writeHistory(readHistory());        // the same bytes: the memo turns over on the stat
  const was = fs.statSync(HISTORY);
  fs.chmodSync(HISTORY, 0o000);
  let s;
  try { s = await status(); } finally { fs.chmodSync(HISTORY, 0o644); }
  assert.equal("picks" in s, false, "no picks block at all — Settings blanks the line (index.html picksPaint)");
  assert.equal("memory" in s, false, "…and no memory block either: zero days is a lie about her data");
  assert.equal(s.sharing.mode, "drive", "what the read-out still knows it still says");
  assert.equal(s.sharing.devices, 3, "the folder and its writers are a different file");

  // AND IT HEALS THE MOMENT THE FILE OPENS AGAIN — with nothing written. A
  // scanner or a backup letting go of history.json changes its ctime alone,
  // never mtime or size, so a memo that had stored the blind answer under the
  // same key would keep serving it: the card would stay blank on every
  // five-second repaint until the next Yes or tomorrow's 05:00 build (r2).
  const back = await status();        // chmod only — no write, so the key is unmoved
  const now = fs.statSync(HISTORY);
  assert.deepEqual([now.mtimeMs, now.size], [was.mtimeMs, was.size],
    "nothing rewrote the memory: the poll above is the only thing that changed");
  assert.ok(back.picks.days > 0, "nothing was lost — the file was only shut for a moment");
});

// The names in "Favourites: …" come from wardrobe.json, so wardrobe.json is one
// of the files the read-out reads THROUGH and belongs in the memo key beside the
// memory and the folder. Without it a garment the family removed keeps its name
// in the card until the next build or Yes — and a catalogue that was unreadable
// for one poll leaves Favourites empty for the rest of the day.
test("a garment renamed in the catalogue is renamed in her favourites on the next poll", async () => {
  const before = await status();
  const id = before.picks.top[0].combo[0];
  const catFile = path.join(DATA, "wardrobe.json");
  const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
  const rel = Object.keys(cat.items).find(f => cat.items[f].id === id);
  const was = fs.statSync(HISTORY);
  cat.items[rel].name = "Willow cardigan";
  fs.writeFileSync(catFile, JSON.stringify(cat, null, 1));

  const s = await status();
  const now = fs.statSync(HISTORY);
  assert.deepEqual([now.mtimeMs, now.size], [was.mtimeMs, was.size],
    "the memory did not move — the catalogue is the only thing that changed");
  assert.equal(s.picks.top[0].names[0], "Willow cardigan",
    "the card names the garment the catalogue holds now, not the one it held this morning");
});

// A POLL IS A READ. /clothing/status is public, unauthenticated and asked every
// few seconds (Settings 5 s, the board 3-15 s); the two doors that WRITE the
// memory — the build's recordOffer and POST /outfit-event — are the ones
// allowed to set an unreadable file aside. The concrete case is the family's
// own restore: a plain `cp` of a keep's history.json into a running hub's data
// dir is not atomic, so a poll landing mid-copy used to rename the half-written
// file to history.json.bad-<ts> and leave the finished copy with no
// history.json in place — the read-out doing the one thing its own header says
// it never does ("nothing written"). Same rule as clothing-worker.js:124-125.
test("a poll never sets the memory aside — quarantine belongs to the doors that write", async () => {
  const good = fs.readFileSync(HISTORY);
  const dir = path.dirname(HISTORY);
  const before = fs.readdirSync(dir).sort();
  const halfCopied = '{"days":{"' + D1 + '":{"band":null,"page1":[["item_00';
  fs.writeFileSync(HISTORY, halfCopied);          // a `cp` caught in the middle

  const s = await status();
  assert.deepEqual(fs.readdirSync(dir).sort(), before,
    "the poll renamed nothing: history.json is still history.json, with no .bad- sibling");
  assert.equal(fs.readFileSync(HISTORY, "utf8"), halfCopied,
    "…and the bytes on disk are the ones the copy is still writing");
  assert.equal("picks" in s, false,
    "a memory it cannot read makes the read-out say nothing — never 'no picks recorded yet'");
  assert.equal("memory" in s, false);

  fs.writeFileSync(HISTORY, good);                 // the copy finishes
  assert.ok((await status()).picks.days > 0, "and the finished copy is read on the next poll");
});
