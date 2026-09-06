// clothing-log.js — the family's shared taste, carried by the folder Google
// Drive already mirrors (spec §5). No server, no account, no new secret.
//
//   <Drive folder>/clothing/.era/
//     picks/<device-id>/<YYYY-MM-DD>.jsonl   {t, kind: select|yes, combo:[ids]}
//     offers/<device-id>/<YYYY-MM-DD>.jsonl  {t, band, page1:[[ids]…]}
//     tags/<writer>.jsonl                    {t, id?, hash?, name?, category,
//                                             warmth, colors, pattern,
//                                             statement, palette, vibe,
//                                             rotate_deg?, crop?}
//     pairs/<writer>.jsonl                   {t, kind: great|avoid|favorite|none,
//                                             combo:[ids]}
//
// Why this is safe under the mirror the hub already has (verified in drive.js):
// dotfiles are copied by both copy paths and never pruned, never listed as
// photos, never trip photoSet(); one writer per file means Drive never sees two
// editors; append-only means every write grows the file; a torn last line is
// skipped on read.
//
// THREE RULES, each of them a way to lose a family's data if it is broken.
//
// 1. WRITES GO TO THE MOUNT ONLY (plan A4-9). The local canonical for this
//    device's own picks and offers is wardrobe/history.json (one writer,
//    clothing.js) and for its own tags wardrobe.json. <DATA>/clothing/.era is
//    the MIRROR's destination — drive.js writes there through .part+rename —
//    so a hub appending there is a second writer on the mirror's own file.
//    Own-id lines that come back through the mirror are skipped on read.
//
// 2. AN OWN WRITE NEVER CREATES <folder>/clothing (W8). syncLocal reads an
//    ABSENT source folder as "leave the local wardrobe alone" and an EMPTY one
//    as "the parent deleted everything". A side-effect mkdir turns the first
//    into the second, and a family whose photos are only on this device loses
//    them on the next sync. So: every append re-checks that clothing/ is
//    already a directory, and the only mkdir is BENEATH it.
//
// 3. NOTHING HERE EVER THROWS. A missing mount, a read-only volume, a file
//    half-written by the syncer: one console line, `false`, and the board is
//    dealt anyway. The shared log is a bonus, never a dependency.
"use strict";
const fs = require("fs");
const path = require("path");
const { dayKey, pairKey, HISTORY_DAYS_KEPT } = require("./clothing-rank.js");
const { slug } = require("./device-id.js");

const ERA = ".era";
const DATE_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const JSONL = /^[A-Za-z0-9._-]+\.jsonl$/;
// The original's warmth is an int level; the hub's is a word (plan W3). The
// migration tool carries the level, so the reader speaks both.
const WARMTH_WORD = { 1: "warm", 2: "cool", 3: "cold" };
let saidNoFolder = false;   // the "no Drive folder" line, once per process
let saidNoClothing = false; // …and the "the folder has no clothing/ yet" line

// ---- the shapes a line must have to be a line -------------------------------
// A line that is skipped is not the last line of anything: the migration tool
// ends every file it writes with a marker so a re-run changes the file's byte
// length (W9), and "the last line of a date wins" must look past it.
const strings = v => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && s);
// A lineup with no looks in it is not a lineup. The local canonical says the
// same (clothing.js recordOffer: a build that finds every tile missing must not
// REPLACE the morning's seven looks with none) and the shared half needs the
// rule at both ends — an empty line published after a good one would blank that
// date's page 1 for every OTHER device, and the yesterday bar (spec §1 V3)
// would stop barring those looks family-wide.
const VALID = {
  picks: l => strings(l.combo),
  offers: l => Array.isArray(l.page1) && l.page1.length > 0,
  tags: l => typeof l.id === "string" || typeof l.hash === "string",
  pairs: l => strings(l.combo),
};
function usable(kind, line) {
  if (!line || typeof line !== "object" || Array.isArray(line)) return false;
  if (line.kind === "marker") return false;
  return VALID[kind](line);
}

// Every whole JSON line of a file, in order, skipping blanks and the torn last
// line a syncer left mid-flight (the pool.js pattern). A file that will not
// open is an empty one.
function linesOf(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn: the syncer is mid-copy */ }
  }
  return out;
}
const stamp = l => String((l && l.t) || "");

// ---- openLog ----------------------------------------------------------------
// {dataDir, driveFolder, deviceId, tz} — dataDir is READ ONLY (the mirror's
// delivery point), driveFolder is where this device writes, deviceId names its
// files, tz is the family zone a day key defaults to.
function openLog({ dataDir, driveFolder, deviceId, tz } = {}) {
  // Slugged HERE, not merely by the caller: `own` is a directory name in a
  // folder Google Drive mirrors onto Windows, macOS and Linux alike, and rule 2
  // ("the only mkdir is BENEATH clothing/") is this module's to keep. Every
  // caller in the tree already passes a device-id.js slug; a future one that
  // passes a hostname or a `..` lands under "hub" instead of outside .era.
  const own = slug(deviceId) || "hub";
  const zone = tz || "UTC";
  const mount = driveFolder ? String(driveFolder) : null;
  // Said once per process, not once per build: the worker opens a log on every
  // run, and a family without Drive would otherwise read this line every
  // fifteen minutes for ever.
  if (!mount && !saidNoFolder) {
    saidNoFolder = true;
    console.log("[clothing] no Drive folder — this device's picks stay local (nothing is shared)");
  }

  // The mount's clothing/ folder, only if it is ALREADY there (rule 2). Checked
  // on every append, not once: a family can point Settings at a folder before
  // they make the folder, and a Drive mount can come and go.
  function mountEra(kind) {
    if (!mount) return null;
    const clothing = path.join(mount, "clothing");
    let there = false;
    try { there = fs.statSync(clothing).isDirectory(); } catch {}
    if (!there) {
      // spec §5: an own write that cannot land is "a log line and nothing
      // else". A parent who points Settings at their Drive folder before the
      // Drive app has made clothing/ in it would otherwise get no signal at
      // all that sharing is off. Once per process, like the line above.
      if (!saidNoClothing) {
        saidNoClothing = true;
        console.log("[clothing] the Drive folder has no clothing/ yet — this device's picks stay local");
      }
      return null;
    }
    return path.join(clothing, ERA, kind);
  }
  let warned = false;
  function append(kind, file, line) {
    const base = mountEra(kind);
    if (!base) return false;
    try {
      const dir = path.dirname(path.join(base, file));
      fs.mkdirSync(dir, { recursive: true });       // only ever beneath .era (rule 2)
      fs.appendFileSync(path.join(base, file),
        JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n");
      return true;
    } catch (e) {
      if (!warned) { warned = true; console.warn("[clothing] the shared log could not be written: " + e.message); }
      return false;
    }
  }
  const dayOr = d => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : dayKey(Date.now(), zone);

  const appendPick = (day, line) => append("picks", path.join(own, dayOr(day) + ".jsonl"), line);
  // A line this module's own reader would skip is not worth writing: it cannot
  // help another device and an empty lineup would outrank the day's real one.
  const appendOffer = (day, line) =>
    usable("offers", line) && append("offers", path.join(own, dayOr(day) + ".jsonl"), line);
  const appendTag = (line) => append("tags", own + ".jsonl", line);

  // ---- reads ---------------------------------------------------------------
  // Everything the MIRROR delivered under <DATA>/clothing/.era, merged per
  // spec §5 — every device but this one (own lines come from the local
  // canonical, and a divergent mirrored copy must never win).
  function readMerged(today) {
    const root = path.join(dataDir, "clothing", ERA);
    const cutoff = oldestKept(today);
    const merged = {
      picksEvents: {},     // {date: [{kind, combo, t}]} — derivePicks' input
      offers: {},          // {date: {band, page1: [[ids]]}}
      tags: new Map(),     // id | hash -> the newest line naming it
      pairing: { great: new Set(), avoid: new Set() },
      favorites: new Set(),
    };
    readDated(root, "picks", cutoff, (date, lines) => {
      const evs = merged.picksEvents[date] || (merged.picksEvents[date] = []);
      for (const l of lines) evs.push({ kind: l.kind, combo: l.combo, t: stamp(l) });
    });
    readDated(root, "offers", cutoff, (date, lines) => {
      // One device's day is its LAST valid line; the day across devices is the
      // union of their page 1s (spec §5).
      const last = lines[lines.length - 1];
      const day = merged.offers[date] || (merged.offers[date] = { band: null, page1: [], _keys: new Set() });
      // The FIRST band read wins, matching mergeHistory below (which keeps the
      // local band and takes a shared one only for a day this device never
      // built). Two devices can only disagree about a date this one missed, and
      // "whichever directory readdir listed last" is not an answer — dirsOf
      // sorts, so this is the first device by name, every run.
      if (day.band == null && last.band != null) day.band = last.band;
      for (const combo of last.page1) {
        if (!Array.isArray(combo) || !strings(combo)) continue;
        const k = combo.join("+");
        if (day._keys.has(k)) continue;
        day._keys.add(k);
        day.page1.push(combo);
      }
    });
    for (const [, evs] of Object.entries(merged.picksEvents)) evs.sort((a, b) => a.t.localeCompare(b.t));
    for (const day of Object.values(merged.offers)) delete day._keys;

    // tags: newest per id, newest per hash (spec §5). One line can land under
    // both keys — tagsFor tries the id first, then the hash (§3.1 item 1).
    const newest = new Map();
    for (const line of readFlat(root, "tags")) {
      const t = normalizeTag(line);
      for (const k of [line.id, line.hash]) {
        if (typeof k !== "string" || !k) continue;
        const have = newest.get(k);
        if (!have || stamp(line) >= stamp(have.raw)) newest.set(k, { raw: line, tag: t });
      }
    }
    for (const [k, v] of newest) merged.tags.set(k, v.tag);

    // pairs: newest verdict per unordered pair; favorite/none per single id.
    const verdict = new Map(), fav = new Map();
    for (const line of readFlat(root, "pairs")) {
      const kind = line.kind;
      if (kind === "great" || kind === "avoid") {
        if (line.combo.length !== 2) continue;
        const k = pairKey(line.combo[0], line.combo[1]);
        const have = verdict.get(k);
        if (!have || stamp(line) >= have.t) verdict.set(k, { kind, t: stamp(line) });
      } else if (kind === "favorite" || kind === "none") {
        if (line.combo.length !== 1) continue;     // W2: a favourite is ONE garment
        const id = line.combo[0];
        const have = fav.get(id);
        if (!have || stamp(line) >= have.t) fav.set(id, { on: kind === "favorite", t: stamp(line) });
      }
    }
    for (const [k, v] of verdict) merged.pairing[v.kind === "great" ? "great" : "avoid"].add(k);
    for (const [id, v] of fav) if (v.on) merged.favorites.add(id);
    return merged;
  }

  // A shared tag stands in for the model's answer, so it hands back the same
  // fields askModel would have — with the migrated int warmth translated (W3)
  // and the geometry the tagging device saw (W5: without rotate_deg/crop a
  // sideways photo would draw a sideways tile on the device that skipped the
  // call). A line with neither is rot 0, which is what a pre-W5 writer meant.
  function normalizeTag(l) {
    const out = { name: l.name, category: l.category,
      colors: l.colors, pattern: l.pattern, statement: l.statement,
      palette: l.palette, vibe: l.vibe };
    out.warmth = typeof l.warmth === "number" ? WARMTH_WORD[l.warmth]
      : (typeof l.warmth === "string" ? l.warmth.toLowerCase() : undefined);
    if (typeof l.rotate_deg === "number") out.rotate_deg = l.rotate_deg;
    if (l.crop && typeof l.crop === "object") out.crop = l.crop;
    return out;
  }

  // spec §3.1 item 1: by id, else by content hash.
  function tagsFor(merged, id, hash) {
    if (!merged || !(merged.tags instanceof Map)) return null;
    if (typeof id === "string" && merged.tags.has(id)) return merged.tags.get(id);
    if (typeof hash === "string" && merged.tags.has(hash)) return merged.tags.get(hash);
    return null;
  }

  // picks/ and offers/ are <kind>/<device>/<date>.jsonl. Own-id directories are
  // skipped (rule 1), as are dates older than the memory keeps and any name the
  // mirror left behind (.part siblings, .mirrored.json — I19).
  function readDated(root, kind, cutoff, take) {
    for (const device of dirsOf(path.join(root, kind))) {
      if (device === own) continue;
      const dir = path.join(root, kind, device);
      for (const name of filesOf(dir)) {
        if (!DATE_NAME.test(name)) continue;
        const date = name.slice(0, 10);
        if (cutoff && date < cutoff) continue;
        const lines = linesOf(path.join(dir, name)).filter(l => usable(kind, l));
        if (lines.length) take(date, lines);
      }
    }
  }
  // tags/ and pairs/ are <kind>/<writer>.jsonl — one file per writer, no date.
  function readFlat(root, kind) {
    const out = [];
    for (const name of filesOf(path.join(root, kind))) {
      if (!JSONL.test(name) || name.slice(0, -6) === own) continue;
      out.push(...linesOf(path.join(root, kind, name)).filter(l => usable(kind, l)));
    }
    out.sort((a, b) => stamp(a).localeCompare(stamp(b)));
    return out;
  }

  return { appendPick, appendOffer, appendTag, readMerged, tagsFor };
}

// ---- who else writes here (spec §4 "sharing", plan W12) --------------------
// The distinct DEVICE names under <DATA>/clothing/.era, with this device's own
// name left out.
//
// The NAMES stay here. /clothing/status is public and unauthenticated and a
// writer name is a hostname slug (W12), so the only thing the caller may take
// out of this Set is its size: "Shared with: 2 devices".
//
// The family's migration tool signs its lines "studio" (§7) and writes all four
// kinds into the folder — and A4-13 requires them to be there BEFORE the
// upgraded hub's first build, so this is not a corner case: every migrated
// family would read one device more than it owns, for good. It is a tool, not a
// device. A machine whose hostname really is "studio" is undercounted by one
// instead, which is the far smaller lie (review r2).
const TOOL_WRITER = "studio";
function sharedWriters(dataDir, deviceId) {
  const own = slug(deviceId) || "hub";
  const root = path.join(String(dataDir || ""), "clothing", ERA);
  const out = new Set();
  // A writer is a directory with a DAY in it. The file half below already skips
  // what the syncer leaves behind (I19), and the directory half needs the same
  // rule: a scratch or `.part` directory arriving through the shared folder, or
  // one left empty, is not another device — and "Shared with: 4 devices" to a
  // family of two is a sentence a parent cannot check.
  for (const kind of ["picks", "offers"])
    for (const name of dirsOf(path.join(root, kind))) {
      if (name === own) continue;
      if (!filesOf(path.join(root, kind, name)).some(f => DATE_NAME.test(f))) continue;
      out.add(name);
    }
  for (const kind of ["tags", "pairs"])
    for (const name of filesOf(path.join(root, kind))) {
      if (!JSONL.test(name)) continue;                 // .part siblings, .mirrored.json (I19)
      const writer = name.slice(0, -".jsonl".length);
      if (writer !== own) out.add(writer);
    }
  out.delete(TOOL_WRITER);
  return out;
}

// ---- one memory out of two (spec §5 "Reads", §6 step 4) ---------------------
// buildCandidates takes a single {days, events}. The LOCAL canonical is this
// device's — wardrobe/history.json, one writer (A4-1/A4-9) — and everything
// else arrives through the mirror. Union, never replacement:
//   * events: both devices' lines for a date, oldest first. derivePicks then
//     collapses them per its own rules (one credit per combo per day, and the
//     day's last select only when nobody said Yes).
//   * days:   this device's band for its own day; page 1 is the UNION, so a
//     look the other tablet offered yesterday sits out page 1 here today.
// `local` is never mutated: the shell reads the same object back to write it.
function mergeHistory(local, merged) {
  const src = local && typeof local === "object" ? local : {};
  const days = src.days && typeof src.days === "object" && !Array.isArray(src.days) ? src.days : {};
  const events = src.events && typeof src.events === "object" && !Array.isArray(src.events) ? src.events : {};
  const out = { days: {}, events: {} };

  for (const [date, evs] of Object.entries(events)) if (Array.isArray(evs)) out.events[date] = evs.slice();
  for (const [date, evs] of Object.entries((merged && merged.picksEvents) || {}))
    (out.events[date] || (out.events[date] = [])).push(...evs);
  const when = e => String((e && (e.at || e.t)) || "");
  for (const evs of Object.values(out.events)) evs.sort((a, b) => when(a).localeCompare(when(b)));

  for (const [date, entry] of Object.entries(days)) {
    if (!entry || typeof entry !== "object") continue;
    out.days[date] = { band: entry.band == null ? null : entry.band,
      page1: (Array.isArray(entry.page1) ? entry.page1 : []).filter(Array.isArray).map(c => c.slice()) };
  }
  for (const [date, entry] of Object.entries((merged && merged.offers) || {})) {
    const day = out.days[date] || (out.days[date] = { band: null, page1: [] });
    if (day.band == null && entry.band != null) day.band = entry.band;
    const seen = new Set(day.page1.map(c => c.join("+")));
    for (const combo of entry.page1 || []) {
      const k = combo.join("+");
      if (seen.has(k)) continue;
      seen.add(k);
      day.page1.push(combo.slice());
    }
  }
  return out;
}

// The oldest date a read bothers with: HISTORY_DAYS_KEPT before `today`.
function oldestKept(today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - HISTORY_DAYS_KEPT)).toISOString().slice(0, 10);
}
function dirsOf(dir) {
  // Sorted, like filesOf: readdir order is the filesystem's, and a merge rule
  // that says "the first device wins" has to mean the same thing twice.
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch { return []; }
}
function filesOf(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort(); }
  catch { return []; }
}

module.exports = { openLog, mergeHistory, sharedWriters };
