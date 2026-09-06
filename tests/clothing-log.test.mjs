// clothing-log.test.mjs — the shared dot-folder (spec §5), on its own.
//
// `clothing/.era/` rides inside the folder Google Drive for Desktop already
// mirrors, so the family's devices learn from each other with no server and no
// new secret. The rules that make that safe are all in this module, and every
// one of them is a way to lose a family's data if it is wrong:
//
//   * ONE WRITER PER FILE. This hub appends only under its own device id, and
//     only onto the Drive MOUNT — never into <DATA>/clothing/.era, which is
//     the mirror's own destination (plan A4-9). A hub appending there would
//     race the mirror's .part+rename.
//   * NEVER CREATE clothing/. An absent source folder means "leave ours
//     alone" to drive.js; an EMPTY one means "prune the wardrobe" (W8). A
//     side-effect mkdir turns the first into the second and the family's
//     local-only photos are gone for good.
//   * NEVER THROW. A missing mount, a read-only volume, a torn line
//     mid-sync: one log line, and the board is dealt anyway.
//
// Pure: temp dirs, no ports, no hub, no key. Every id, name and colour is
// invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { openLog } = require("./clothing-log.js");
const { dayKey, yesterdayOf, HISTORY_DAYS_KEPT } = require("./clothing-rank.js");

const ZONE = "UTC";
const TODAY = dayKey(Date.now(), ZONE);
const YESTERDAY = yesterdayOf(TODAY);
const OWN = "own-dev";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "era-log-" + tag + "-"));
// A pair of temp dirs in the shape the hub sees them: the Drive mount (where
// this device WRITES) and the data dir (where the mirror DELIVERS).
function beds({ mount = true } = {}) {
  const dataDir = tmp("d"), driveFolder = tmp("m");
  if (mount) fs.mkdirSync(path.join(driveFolder, "clothing"), { recursive: true });
  return { dataDir, driveFolder };
}
const era = (dataDir, ...p) => path.join(dataDir, "clothing", ".era", ...p);
// Deliver a line the way the mirror would: under <DATA>/clothing/.era.
function deliver(dataDir, rel, ...lines) {
  const file = era(dataDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map(l => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
  return file;
}
const open = (b, extra = {}) => openLog({ dataDir: b.dataDir, driveFolder: b.driveFolder,
  deviceId: OWN, tz: ZONE, ...extra });

// ---- writes: the mount, and nothing else -----------------------------------

test("an own pick lands in the Drive mount under this device's id, and nowhere else", () => {
  const b = beds();
  const log = open(b);
  assert.equal(log.appendPick(TODAY, { kind: "yes", combo: ["item_aaaa", "item_bbbb"] }), true);
  const file = path.join(b.driveFolder, "clothing", ".era", "picks", OWN, TODAY + ".jsonl");
  const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(line.kind, "yes");
  assert.deepEqual(line.combo, ["item_aaaa", "item_bbbb"]);
  assert.match(line.t, /^\d{4}-\d{2}-\d{2}T/, "every line is stamped");
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "append-only: the file always grows by whole lines");
  // A4-9: the local canonical for own picks is wardrobe/history.json. The
  // mirror owns <DATA>/clothing/.era — a hub append there is a second writer.
  assert.ok(!fs.existsSync(era(b.dataDir)), "nothing is written under the data dir");
});

test("offers and tags have their own shapes: a date file per device, one file per writer", () => {
  const b = beds();
  const log = open(b);
  assert.equal(log.appendOffer(TODAY, { band: "warm", page1: [["item_aaaa", "item_bbbb"], ["item_cccc"]] }), true);
  assert.equal(log.appendTag({ id: "item_aaaa", hash: "a".repeat(64), name: "Sunny tee",
    category: "top", warmth: "warm", colors: ["blue"], pattern: "solid", statement: false }), true);
  const root = path.join(b.driveFolder, "clothing", ".era");
  assert.ok(fs.existsSync(path.join(root, "offers", OWN, TODAY + ".jsonl")));
  assert.ok(fs.existsSync(path.join(root, "tags", OWN + ".jsonl")), "tags are one file per writer, not per day");
  assert.ok(!fs.existsSync(era(b.dataDir)));
});

// W8, the one that eats photos: syncLocal treats an ABSENT <folder>/clothing
// as "leave the local wardrobe alone" and an EMPTY one as "the parent deleted
// everything". A side-effect mkdir here turns a family's Drive folder that has
// no clothing/ yet into a delete-everything order on the next sync.
test("a Drive folder with no clothing/ is left exactly as it was", () => {
  const b = beds({ mount: false });
  const log = open(b);
  assert.equal(log.appendPick(TODAY, { kind: "yes", combo: ["item_aaaa"] }), false);
  assert.equal(log.appendOffer(TODAY, { band: null, page1: [["item_aaaa"]] }), false);
  assert.equal(log.appendTag({ id: "item_aaaa", category: "top" }), false);
  assert.ok(!fs.existsSync(path.join(b.driveFolder, "clothing")),
    "clothing/ was NOT created — an absent source must stay absent (W8)");
  assert.deepEqual(fs.readdirSync(b.driveFolder), [], "the Drive folder is untouched");
});

test("no Drive folder at all (API mode) is a quiet no-op, never a throw", () => {
  const b = beds();
  const log = openLog({ dataDir: b.dataDir, driveFolder: null, deviceId: OWN, tz: ZONE });
  assert.equal(log.appendPick(TODAY, { kind: "yes", combo: ["item_aaaa"] }), false);
  assert.equal(log.appendOffer(TODAY, { band: null, page1: [] }), false);
  assert.equal(log.appendTag({ id: "item_aaaa" }), false);
  assert.ok(!fs.existsSync(era(b.dataDir)));
});

test("a mount this hub cannot write refuses the line instead of failing the build", {
  skip: process.getuid && process.getuid() === 0 ? "root writes every directory" : false,
}, () => {
  const b = beds();
  fs.chmodSync(path.join(b.driveFolder, "clothing"), 0o500);
  try {
    const log = open(b);
    assert.equal(log.appendPick(TODAY, { kind: "yes", combo: ["item_aaaa"] }), false,
      "it says no rather than throwing into the build");
  } finally { fs.chmodSync(path.join(b.driveFolder, "clothing"), 0o700); }
});

// ---- reads: merge every device but this one --------------------------------

test("another device's picks are read; this device's own mirrored copy is not", () => {
  const b = beds();
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T09:00:00Z", kind: "yes", combo: ["item_aaaa", "item_bbbb"] });
  // A's own line, mirrored back to A. Its canonical copy is history.json, so
  // reading this one would double-count — and a divergent copy would win.
  deliver(b.dataDir, `picks/${OWN}/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T10:00:00Z", kind: "yes", combo: ["item_zzzz"] });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(m.picksEvents[YESTERDAY].map(e => e.combo),
    [["item_aaaa", "item_bbbb"]], "only the other device's Yes");
});

test("a torn last line is skipped and the rest of the file is still read", () => {
  const b = beds();
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T09:00:00Z", kind: "yes", combo: ["item_aaaa"] },
    { t: "2026-09-05T09:30:00Z", kind: "select", combo: ["item_bbbb"] });
  fs.appendFileSync(era(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`), '{"t":"2026-09-05T10:00:00Z","ki');
  const m = open(b).readMerged(TODAY);
  assert.equal(m.picksEvents[YESTERDAY].length, 2, "the two whole lines survived the mid-sync tear");
});

test("a picks line with no combo is dropped without taking the file down", () => {
  const b = beds();
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T09:00:00Z", kind: "yes" },
    { t: "2026-09-05T09:05:00Z", kind: "yes", combo: "item_aaaa" },
    { t: "2026-09-05T09:10:00Z", kind: "yes", combo: ["item_aaaa"] });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(m.picksEvents[YESTERDAY].map(e => e.combo), [["item_aaaa"]]);
});

// W9: the migration tool ends every file with a marker so a re-run changes the
// byte length (a same-length rewrite is invisible to the mirror). The reader
// has to skip it — and skipping it must not make it "the last line of the
// date", or a re-run would blank the day's page 1 on every other device.
test("a marker line at the end of an offers file leaves the day's page 1 alone", () => {
  const b = beds();
  deliver(b.dataDir, `offers/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T06:00:00Z", band: "cool", page1: [["item_aaaa", "item_bbbb"]] },
    { t: "2026-09-05T06:30:00Z", band: "warm", page1: [["item_cccc", "item_dddd"]] },
    { t: "2026-09-05T23:00:00Z", kind: "marker" });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(m.offers[YESTERDAY].page1, [["item_cccc", "item_dddd"]],
    "the last VALID line of the date wins, not the marker");
  assert.equal(m.offers[YESTERDAY].band, "warm");
});

// ...and a marker is a marker whatever else the line carries. The tool writes
// a bare {t, kind:"marker"} today, which the required-field checks would drop
// on their own; the rule has to hold if that line ever grows a field, or a
// re-run of the migration would blank every other device's yesterday.
test("a marker is never a line, even when it carries the field its file needs", () => {
  const b = beds();
  deliver(b.dataDir, `offers/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T06:00:00Z", band: "cool", page1: [["item_aaaa", "item_bbbb"]] },
    { t: "2026-09-05T23:00:00Z", kind: "marker", page1: [] });
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T09:00:00Z", kind: "yes", combo: ["item_aaaa"] },
    { t: "2026-09-05T23:00:00Z", kind: "marker", combo: ["item_marker"] });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(m.offers[YESTERDAY].page1, [["item_aaaa", "item_bbbb"]], "yesterday's lineup stands");
  assert.deepEqual(m.picksEvents[YESTERDAY].map(e => e.combo), [["item_aaaa"]], "and the marker is no pick");
});

test("two devices' page 1 for one day is the union, one entry per look", () => {
  const b = beds();
  deliver(b.dataDir, `offers/dev-b/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T06:00:00Z", band: "warm", page1: [["item_aaaa", "item_bbbb"]] });
  deliver(b.dataDir, `offers/dev-c/${YESTERDAY}.jsonl`,
    { t: "2026-09-05T07:00:00Z", band: "warm", page1: [["item_aaaa", "item_bbbb"], ["item_cccc"]] });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(m.offers[YESTERDAY].page1.map(c => c.join("+")).sort(),
    ["item_aaaa+item_bbbb", "item_cccc"]);
});

// A day older than the memory itself can only slow the read down.
test("a date file older than the sixty days the memory keeps is not read at all", () => {
  const b = beds();
  const old = new Date(Date.now() - (HISTORY_DAYS_KEPT + 5) * 86400000).toISOString().slice(0, 10);
  deliver(b.dataDir, `picks/dev-b/${old}.jsonl`, { t: old + "T09:00:00Z", kind: "yes", combo: ["item_old0"] });
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`, { t: "2026-09-05T09:00:00Z", kind: "yes", combo: ["item_aaaa"] });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(Object.keys(m.picksEvents), [YESTERDAY]);
});

// I19: the mirror leaves .part siblings mid-copy and writes its own
// .mirrored.json ledger beside the libraries. Neither is a log line.
test("only .jsonl files with the right name shape are read", () => {
  const b = beds();
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl`, { t: "2026-09-05T09:00:00Z", kind: "yes", combo: ["item_aaaa"] });
  deliver(b.dataDir, `picks/dev-b/${YESTERDAY}.jsonl.part`, { t: "2026-09-05T10:00:00Z", kind: "yes", combo: ["item_part"] });
  deliver(b.dataDir, "picks/dev-b/notes.jsonl", { t: "2026-09-05T11:00:00Z", kind: "yes", combo: ["item_note"] });
  const m = open(b).readMerged(TODAY);
  const all = Object.values(m.picksEvents).flat().map(e => e.combo.join("+"));
  assert.deepEqual(all, ["item_aaaa"]);
});

test("a missing .era folder is simply an empty memory", () => {
  const b = beds();
  const m = open(b).readMerged(TODAY);
  assert.deepEqual(m.picksEvents, {});
  assert.deepEqual(m.offers, {});
  assert.equal(m.tags.size, 0);
  assert.equal(m.favorites.size, 0);
  assert.equal(m.pairing.great.size + m.pairing.avoid.size, 0);
});

// ---- tags: the family pays the AI once (spec §3.1 item 1, §5) --------------

test("a tag with only a hash is found by hash — the same garment under another filename", () => {
  const b = beds();
  const hash = "b".repeat(64);
  deliver(b.dataDir, "tags/studio.jsonl",
    { t: "2026-09-05T09:00:00Z", hash, name: "Sunny tee", category: "top", warmth: "warm",
      colors: ["blue"], pattern: "solid", statement: false });
  const log = open(b), m = log.readMerged(TODAY);
  assert.equal(log.tagsFor(m, "item_other", hash).name, "Sunny tee");
  assert.equal(log.tagsFor(m, "item_other", "c".repeat(64)), null, "a hash nobody tagged misses");
});

test("id is tried first; a line whose id is someone else's still matches by hash", () => {
  const b = beds();
  const hash = "d".repeat(64);
  deliver(b.dataDir, "tags/dev-b.jsonl",
    { t: "2026-09-05T09:00:00Z", id: "item_theirs", hash, category: "top", warmth: "hot", colors: ["red"] },
    { t: "2026-09-05T09:01:00Z", id: "item_mine", hash: "e".repeat(64), category: "top", warmth: "cold", colors: ["navy"] });
  const log = open(b), m = log.readMerged(TODAY);
  assert.deepEqual(log.tagsFor(m, "item_mine", hash).colors, ["navy"], "the id wins when it is known");
  assert.deepEqual(log.tagsFor(m, "item_unknown", hash).colors, ["red"], "otherwise the hash finds it");
});

// W3: the migration tool carries the original's INT warmth levels.
test("a warmth level from the migrated wardrobe reads as the hub's word", () => {
  const b = beds();
  deliver(b.dataDir, "tags/studio.jsonl",
    { t: "2026-09-05T09:00:00Z", id: "item_aaaa", category: "pants", warmth: 2, colors: ["navy"] },
    { t: "2026-09-05T09:00:01Z", id: "item_bbbb", category: "pants", warmth: 1, colors: ["navy"] },
    { t: "2026-09-05T09:00:02Z", id: "item_cccc", category: "pants", warmth: 3, colors: ["navy"] });
  const log = open(b), m = log.readMerged(TODAY);
  assert.equal(log.tagsFor(m, "item_aaaa").warmth, "cool");
  assert.equal(log.tagsFor(m, "item_bbbb").warmth, "warm");
  assert.equal(log.tagsFor(m, "item_cccc").warmth, "cold");
});

test("the newest line for a garment wins, whichever device wrote it", () => {
  const b = beds();
  deliver(b.dataDir, "tags/dev-b.jsonl",
    { t: "2026-09-05T09:00:00Z", id: "item_aaaa", category: "top", warmth: "warm", colors: ["blue"] });
  deliver(b.dataDir, "tags/dev-c.jsonl",
    { t: "2026-09-06T09:00:00Z", id: "item_aaaa", category: "top", warmth: "warm", colors: ["green"] });
  const log = open(b), m = log.readMerged(TODAY);
  assert.deepEqual(log.tagsFor(m, "item_aaaa").colors, ["green"]);
});

test("a tag line naming neither an id nor a hash is not a tag", () => {
  const b = beds();
  deliver(b.dataDir, "tags/dev-b.jsonl",
    { t: "2026-09-05T09:00:00Z", category: "top", warmth: "warm", colors: ["blue"] },
    { t: "2026-09-05T09:01:00Z", kind: "marker" });
  const m = open(b).readMerged(TODAY);
  assert.equal(m.tags.size, 0);
});

// ---- pairs: the grown-up's curated taste (spec §4, §5) ---------------------

test("a curated pair keys the same however the two ids are ordered", () => {
  const b = beds();
  deliver(b.dataDir, "pairs/studio.jsonl",
    { t: "2026-09-05T09:00:00Z", kind: "great", combo: ["item_aaaa", "item_bbbb"] },
    { t: "2026-09-05T09:00:01Z", kind: "avoid", combo: ["item_dddd", "item_cccc"] });
  const m = open(b).readMerged(TODAY);
  assert.ok(m.pairing.great.has("item_aaaa+item_bbbb"));
  assert.ok(m.pairing.avoid.has("item_cccc+item_dddd"), "sorted into one key, whichever order it was written in");
  assert.equal(m.pairing.great.size, 1);
});

test("the newest verdict on a pair is the one that counts", () => {
  const b = beds();
  deliver(b.dataDir, "pairs/studio.jsonl",
    { t: "2026-09-05T09:00:00Z", kind: "great", combo: ["item_aaaa", "item_bbbb"] },
    { t: "2026-09-06T09:00:00Z", kind: "avoid", combo: ["item_bbbb", "item_aaaa"] });
  const m = open(b).readMerged(TODAY);
  assert.equal(m.pairing.great.size, 0, "the great verdict was replaced, not kept alongside");
  assert.ok(m.pairing.avoid.has("item_aaaa+item_bbbb"));
});

test("a favourite can be taken back", () => {
  const b = beds();
  deliver(b.dataDir, "pairs/studio.jsonl",
    { t: "2026-09-05T09:00:00Z", kind: "favorite", combo: ["item_aaaa"] },
    { t: "2026-09-05T09:00:01Z", kind: "favorite", combo: ["item_bbbb"] },
    { t: "2026-09-06T09:00:00Z", kind: "none", combo: ["item_aaaa"] });
  const m = open(b).readMerged(TODAY);
  assert.deepEqual([...m.favorites], ["item_bbbb"]);
});

test("a pairs line with no combo is skipped, marker lines included", () => {
  const b = beds();
  deliver(b.dataDir, "pairs/studio.jsonl",
    { t: "2026-09-05T09:00:00Z", kind: "great" },
    { t: "2026-09-05T09:00:01Z", kind: "marker" },
    { t: "2026-09-05T09:00:02Z", kind: "great", combo: ["item_aaaa", "item_bbbb"] });
  const m = open(b).readMerged(TODAY);
  assert.equal(m.pairing.great.size, 1);
});
