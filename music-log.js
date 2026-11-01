// music-log.js — how often she picks each song, shared across the family's
// devices the way clothing picks are (clothing-log.js; spec 2026-10-31
// "Score" and "Sharing across devices"). No server, no account, no new secret.
//
//   <Drive folder>/music/.era/plays/<device-id>/
//     legacy.jsonl          this device's pool history from before sharing, once
//     <YYYY-MM-DD>.jsonl    {t, song, action: play|full|done, fresh?}
//
// SCORE. Every pick counts once, at a base of partial 1 or full 3, decayed by
// its age (DECAY, below). A pick is a play start — `play` (a grid door or a
// hero replay) or `full` with `fresh` (Full song from silence). It becomes full when a `full` for the same song arrives during it
// (Full song authorized) or a `done` does (the song ended naturally). Stop, the
// clip running out and leaving the page change nothing, so they are never
// written. Old pool history carries no `fresh` and no `done`, and an old `end`
// meant either the clip or the song ending; it reads by the same rule: a play
// followed by a full for the same song before the next pick is full, and a
// full that follows no play of its own song is a full pick of its own.
//
// DECAY. A pick's weight halves every HALF_LIFE (30 days) of its age, the age
// measured from the pick's START (its `play`, or the fresh/standalone `full`)
// to now: weight x 0.5^(age / HALF_LIFE). An upgrade to full adds (3 - 1)
// decayed by that same start, never by the upgrade's own time. A pick dated in
// the future (another device's clock ahead) counts at age 0. A line with no
// readable `t` (very old history) counts as UNDATED_AGE old: still above zero,
// so nothing she has ever played leaves Favorites; it only sinks. Every score
// shrinks by the same factor as time passes, so the clock alone never swaps two
// dated songs: the order moves on a new pick. Of two equal picks the later one
// has decayed a hair less and ranks first; only exactly equal scores fall to
// the added-time tie-break (music-sections.js). The board's ETag hashes the id
// ORDER (server.js `~o`), never the scores.
//
// THE SAME THREE RULES AS clothing-log.js:
// 1. WRITES GO TO THE MOUNT ONLY. <DATA>/music/.era is the mirror's
//    destination. This device's own lines are read from its LOCAL canonical —
//    its own family-pool events (pool.js, <pool>/events/<device-id>/), which
//    already hold every music event this device ever posted — and own lines
//    that come back through the mirror are skipped.
// 2. AN OWN WRITE NEVER CREATES <folder>/music. The only mkdir is beneath it.
// 3. NOTHING HERE EVER THROWS. A missing mount, a read-only volume, a torn
//    line: `false` or an empty answer, and the board is dealt anyway.
"use strict";
const fs = require("fs");
const path = require("path");
const { slug } = require("./device-id.js");

const ERA = ".era";
const SONG_RE = /^[a-z0-9-]{1,64}$/;
const SHARED = new Set(["play", "full", "done"]);       // what can move a score
const NAME_RE = /^(\d{4}-\d{2}-\d{2}|legacy)\.jsonl$/;
const LEGACY = "legacy.jsonl";
const PARTIAL = 1, FULL = 3;
const DAY_MS = 24 * 3600 * 1000;
// 30 days: a month-old pick counts half and a three-month-old one an eighth, so
// a favourite she stops playing slides below the songs she plays now within
// weeks, while a run of plays from last week still holds its place.
const HALF_LIFE_MS = 30 * DAY_MS;
// A line with no readable time is from the oldest history there is: a year old
// (1/4096 of its base), never zero.
const UNDATED_AGE_MS = 365 * DAY_MS;

// ---- the fold ------------------------------------------------------------------
// events: one device's stream [{t, song, action, fresh?}] -> Map song -> score.
// now: ms since the epoch (tests pin it; the hub passes its clock).
function decay(t, now) {
  const ms = Date.parse(t);
  const age = Number.isFinite(ms) ? Math.max(0, now - ms) : UNDATED_AGE_MS;
  return Math.pow(0.5, age / HALF_LIFE_MS);
}
function foldScores(events, into, now) {
  const out = into instanceof Map ? into : new Map();
  const at = Number.isFinite(now) ? now : Date.now();
  const list = (Array.isArray(events) ? events : [])
    .filter(e => e && typeof e.song === "string" && typeof e.action === "string")
    .slice().sort((a, b) => String(a.t || "").localeCompare(String(b.t || "")));
  const add = (song, n) => out.set(song, (out.get(song) || 0) + n);
  let cur = null;   // {song, full, w}: the pick in progress on this device, w its start's decay
  const start = (e, full) => { cur = { song: e.song, full, w: decay(e.t, at) }; add(e.song, (full ? FULL : PARTIAL) * cur.w); };
  const upgrade = () => { cur.full = true; add(cur.song, (FULL - PARTIAL) * cur.w); };
  for (const e of list) {
    if (e.action === "play") start(e, false);
    else if (e.action === "full") {
      if (!e.fresh && cur && cur.song === e.song) { if (!cur.full) upgrade(); }
      else start(e, true);
    } else if (e.action === "done") {
      if (cur && cur.song === e.song && !cur.full) upgrade();
    }
    // stop / clip / end: the pick stays as it is (partial unless already full)
  }
  return out;
}

// ---- reading files, cheaply -----------------------------------------------------
// The board's recipe is built on every request, so every file is parsed once
// per (size, mtime) and kept: only today's files ever change.
const cache = new Map();   // abs path -> {size, mtimeMs, lines}
function cachedLines(file, parse) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return []; }
  const have = cache.get(file);
  if (have && have.size === st.size && have.mtimeMs === st.mtimeMs) return have.lines;
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const lines = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }   // torn: the syncer is mid-copy
    const e = parse(j);
    if (e) lines.push(e);
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, lines });
  return lines;
}
function dirsOf(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch { return []; }
}
function filesOf(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort(); }
  catch { return []; }
}
const shared = (j) => (j && typeof j === "object" && SONG_RE.test(String(j.song)) && SHARED.has(j.action))
  ? { t: String(j.t || ""), song: j.song, action: j.action, ...(j.fresh === true ? { fresh: true } : {}) } : null;

// This device's music events out of its own pool directory (pool.js writes
// {t, device, kind: "music-<action>", songId, fresh?}). Only its own: a pool
// pointed at a synced folder holds other devices too, and those arrive here
// through the shared log instead — counting both would count them twice.
function poolMusicEvents(poolRoot, deviceId) {
  if (!poolRoot || !deviceId) return [];
  const dir = path.join(String(poolRoot), "events", String(deviceId));
  const parse = (j) => {
    if (!j || typeof j.kind !== "string" || !j.kind.startsWith("music-")) return null;
    if (j.device != null && j.device !== deviceId) return null;
    const action = j.kind.slice(6);
    if (!SONG_RE.test(String(j.songId))) return null;
    return { t: String(j.t || ""), song: j.songId, action, ...(j.fresh === true ? { fresh: true } : {}) };
  };
  const out = [];
  for (const name of filesOf(dir)) if (name.endsWith(".jsonl")) out.push(...cachedLines(path.join(dir, name), parse));
  return out;
}

// ---- openMusicLog ---------------------------------------------------------------
// {dataDir, poolRoot, driveFolder, deviceId, now?} — dataDir is READ ONLY (the
// mirror's delivery point), driveFolder is where this device writes; now() is
// the clock scores decay against (Date.now unless a test pins it).
let warned = false;
function openMusicLog({ dataDir, poolRoot, driveFolder, deviceId, now } = {}) {
  const clock = typeof now === "function" ? now : Date.now;
  const own = slug(deviceId) || "hub";
  const ownPoolId = String(deviceId || "");
  const mount = driveFolder ? String(driveFolder) : null;

  function ownDir() {
    if (!mount) return null;
    const music = path.join(mount, "music");
    try { if (!fs.statSync(music).isDirectory()) return null; } catch { return null; }   // rule 2
    return path.join(music, ERA, "plays", own);
  }

  // The first shared write from this device carries its pool history along,
  // once, so the other devices order by the same past. Only when the device's
  // directory holds no line at all: a legacy file someone deleted later must
  // not come back on top of the dated lines that followed it.
  function backfill(dir) {
    if (filesOf(dir).some(n => NAME_RE.test(n))) return;
    const body = poolMusicEvents(poolRoot, ownPoolId).filter(e => SHARED.has(e.action))
      .map(e => JSON.stringify(e) + "\n").join("");
    const tmp = path.join(dir, "." + LEGACY + ".tmp");
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(dir, LEGACY));
  }

  // record({song, action, fresh}) -> true when the line reached the folder.
  function record({ song, action, fresh } = {}) {
    if (!SONG_RE.test(String(song)) || !SHARED.has(action)) return false;
    const dir = ownDir();
    if (!dir) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });         // only ever beneath music/ (rule 2)
      backfill(dir);
      const t = new Date().toISOString();
      fs.appendFileSync(path.join(dir, t.slice(0, 10) + ".jsonl"),
        JSON.stringify({ t, song, action, ...(fresh === true ? { fresh: true } : {}) }) + "\n");
      return true;
    } catch (e) {
      if (!warned) { warned = true; console.warn("[music] the shared play log could not be written: " + e.message); }
      return false;
    }
  }

  // scores() -> Map song -> score: this device from its pool, every other
  // device from what the mirror delivered.
  function scores() {
    const out = new Map();
    const at = clock();
    try {
      foldScores(poolMusicEvents(poolRoot, ownPoolId), out, at);
      const root = path.join(String(dataDir || ""), "music", ERA, "plays");
      for (const device of dirsOf(root)) {
        if (device === own) continue;
        const dir = path.join(root, device), lines = [];
        for (const name of filesOf(dir)) if (NAME_RE.test(name)) lines.push(...cachedLines(path.join(dir, name), shared));
        foldScores(lines, out, at);
      }
    } catch { /* rule 3: whatever was read stands */ }
    return out;
  }

  return { record, scores };
}

module.exports = { foldScores, openMusicLog, poolMusicEvents, HALF_LIFE_MS };
