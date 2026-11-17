// this-week.js — the week package on the shelf becomes the "This week" board
// (spec 2026-10-12 §3, plan B1). PURE: no server state, no timers, no network.
// server.js serves what build() returns; the download rail (this-week-fetch.js,
// B3) only ever adds files beside the manifest, which is why the ETag folds in
// which videos are ready.
//
// The folder: <DATA>/this-week/<YYYY-MM-DD>/ holding manifest.json (written
// LAST by the engine), <id>.mp4 + <id>.<webp|jpg|jpeg|png> (written by a hub)
// and claim-<id>.json (a hub's lock; never served). The manifest NEVER uses the
// keys `pages` or `cover`: drive.js isBookManifest would hold such a folder
// back as an unfinished book, so a manifest carrying them is refused as broken.
//
// The engine's schema.py is the law for the manifest; validate() re-checks the
// same rules here and drops a failing ITEM (listed in `dropped`), never the
// page — one bad word must not take Ellie's board away.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const THIS_WEEK_REV = 4;   // 2: the Play door (spec 2026-10-12 §5.6); 3: the small boards (spec §1, §3.4);
                           // 4: Past weeks (spec 2026-11-17)
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SYMBOL_RE = /^[a-z0-9-]{1,32}$/;
const GROUPS = ["science", "social_studies", "hero", "describing", "core"];
const THUMB_EXT = [".webp", ".jpg", ".jpeg", ".png"];
const MAX_WATCH = 5, MAX_TALK = 16;
// The fixed seats (D26, ux-contract §B): Back [1,1], More [3,1], centre black.
// Watch is a 3×3 ring around a black [2,2] (spec §3.4); Talk keeps the 3×4.
const WATCH_SEATS = [[1, 2], [1, 3], [2, 1], [2, 3], [3, 1]];
const TALK_SEATS = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const ROOT = "this-week";
// Play (spec §5.6): the twins of schema.py's Skill, Instrument and the
// instruments' position counts (harmonica/xylophone 10, telephone/puppet 2).
const SKILLS = ["predict", "compare", "cause", "classify", "sequence", "true-false",
                "count", "add", "subtract", "decode", "rhyme", "vocabulary"];
const POSITIONS = { "harmonica": 10, "xylophone": 10, "string-telephone": 2, "shadow-puppet": 2 };
const MAX_WHICH = 10, MAX_Q = 160, MAX_LABEL = 40;
// Past weeks (spec 2026-11-17): the newest 52 older weeks, eight a page in the Talk seats.
const MAX_PAST = 52, PAST_GLYPH = "🗓️";

const isStr = (s) => typeof s === "string" && s.trim() !== "";

// One emoji grapheme: a single extended grapheme cluster whose first code point
// is pictographic (or a regional indicator, for flags).
const SEG = new Intl.Segmenter("en", { granularity: "grapheme" });
function isGlyph(s) {
  if (typeof s !== "string" || !s) return false;
  const parts = [...SEG.segment(s)];
  if (parts.length !== 1) return false;
  return /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(s);
}
function isMonday(s) {
  if (typeof s !== "string" || !WEEK_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s && d.getUTCDay() === 1;
}

function watchProblem(v, seen) {
  if (!v || typeof v !== "object") return "not an object";
  if (typeof v.id !== "string" || !ID_RE.test(v.id)) return "bad id";
  if (seen.has(v.id)) return "duplicate id";
  if (!isStr(v.title)) return "no title";
  if (typeof v.channel !== "string") return "no channel";
  if (!Number.isInteger(v.minutes) || v.minutes < 1 || v.minutes > 15) return "minutes not 1-15";
  const o = v.oembed;
  if (!o || typeof o !== "object" || !isStr(o.title) || !isStr(o.author_name) || !isStr(o.thumbnail_url))
    return "oembed incomplete";
  return null;
}
function talkProblem(t) {
  if (!t || typeof t !== "object") return "not an object";
  if (!isStr(t.word) || [...SEG.segment(t.word)].length > 16) return "bad word";
  if (!isStr(t.say)) return "no say";
  if (!GROUPS.includes(t.group)) return "bad group";
  const g = t.glyph !== undefined && t.glyph !== null, s = t.symbol !== undefined && t.symbol !== null;
  if (g === s) return "needs exactly one of glyph or symbol";
  if (g && !isGlyph(t.glyph)) return "glyph is not one emoji";
  if (s && (typeof t.symbol !== "string" || !SYMBOL_RE.test(t.symbol))) return "bad symbol";
  return null;
}

// -> {manifest, dropped[]}; throws on a manifest that is not a week at all.
function validate(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("manifest is not an object");
  if ("pages" in m || "cover" in m) throw new Error("manifest uses pages/cover (a book's keys)");
  if (!Array.isArray(m.watch) || !Array.isArray(m.talk)) throw new Error("manifest needs watch and talk arrays");
  const dropped = [];
  const out = { ...m };
  if (!isStr(m.title) || [...SEG.segment(m.title)].length > 24) {
    dropped.push({ field: "title", value: m.title, why: "title missing or over 24" });
    out.title = "This week";
  }
  if (m.week_of !== undefined && !isMonday(m.week_of))
    dropped.push({ field: "week_of", value: m.week_of, why: "not an ISO Monday" });
  const seen = new Set();
  out.watch = [];
  m.watch.forEach((v, i) => {
    let why = watchProblem(v, seen);
    if (!why && out.watch.length >= MAX_WATCH) why = "more than " + MAX_WATCH + " videos";
    if (why) { dropped.push({ field: "watch", index: i, id: v && v.id, why }); return; }
    seen.add(v.id);
    out.watch.push(v);
  });
  out.talk = [];
  m.talk.forEach((t, i) => {
    let why = talkProblem(t);
    if (!why && out.talk.length >= MAX_TALK) why = "more than " + MAX_TALK + " words";
    if (why) { dropped.push({ field: "talk", index: i, word: t && t.word, why }); return; }
    out.talk.push(t);
  });
  return { manifest: out, dropped };
}

// ---- Play (spec 2026-10-12 §5.6, §6) ----------------------------------------
// One Which-one item (play.which[] or a video's `before`): null when good.
function whichProblem(w) {
  if (!w || typeof w !== "object" || Array.isArray(w)) return "not an object";
  if (!isStr(w.id)) return "no id";
  if (!SKILLS.includes(w.skill)) return "bad skill";
  if (!isStr(w.q) || w.q.length > MAX_Q) return "q missing or over " + MAX_Q;
  if (!Array.isArray(w.choices) || w.choices.length < 2 || w.choices.length > 3) return "needs 2-3 choices";
  for (const c of w.choices) {
    if (!c || typeof c !== "object") return "a choice is not an object";
    if (!isStr(c.label) || c.label.length > MAX_LABEL) return "choice label missing or over " + MAX_LABEL;
    if (!isGlyph(c.glyph)) return "choice glyph is not one emoji";
    // a name the page's library lacks is the page's to ignore (spec §5.6)
    if (c.sound !== undefined && c.sound !== null && typeof c.sound !== "string") return "sound not a string";
    if (c.right !== undefined && c.right !== null && typeof c.right !== "boolean") return "right not a boolean";
  }
  const rights = w.choices.filter(c => c.right === true).length;
  if (rights !== 1) return rights ? "two right answers" : "no right answer";
  return null;
}
function sortProblem(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "not an object";
  if (!Array.isArray(s.bins) || s.bins.length !== 2) return "needs exactly 2 bins";
  for (const b of s.bins)
    if (!b || typeof b !== "object" || !isStr(b.label) || !isGlyph(b.glyph)) return "a bin needs a label and one emoji";
  if (!SKILLS.includes(s.skill)) return "bad skill";
  if (!Array.isArray(s.items) || s.items.length < 4 || s.items.length > 10) return "needs 4-10 items";
  for (const it of s.items) {
    if (!it || typeof it !== "object" || !isStr(it.label) || !isGlyph(it.glyph)) return "an item needs a label and one emoji";
    if (it.bin !== 0 && it.bin !== 1) return "an item points at no bin";
  }
  return null;
}
function playitProblem(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "not an object";
  if (!Object.prototype.hasOwnProperty.call(POSITIONS, p.instrument)) return "unknown instrument";
  if (!isStr(p.q)) return "no q";
  if (!Number.isInteger(p.answer) || p.answer < 0 || p.answer >= POSITIONS[p.instrument])
    return "answer outside 0-" + (POSITIONS[p.instrument] - 1);
  return null;
}

// m = a manifest (validate()'s, so `watch` holds only good videos) ->
// {play: {which[], sort|null, playit|null}, before: {<video id>: item}, dropped[]}.
// Drops the failing ITEM, never the page, like validate().
function validatePlay(m) {
  const dropped = [];
  const p = (m && m.play && typeof m.play === "object" && !Array.isArray(m.play)) ? m.play : {};
  const play = { which: [], sort: null, playit: null };
  const seen = new Set();
  (Array.isArray(p.which) ? p.which : []).forEach((w, i) => {
    let why = whichProblem(w);
    if (!why && seen.has(w.id)) why = "duplicate id";
    if (!why && play.which.length >= MAX_WHICH) why = "more than " + MAX_WHICH + " items";
    if (why) { dropped.push({ field: "play.which", index: i, id: w && w.id, why }); return; }
    seen.add(w.id);
    play.which.push(w);
  });
  if (p.sort !== undefined && p.sort !== null) {
    const why = sortProblem(p.sort);
    if (why) dropped.push({ field: "play.sort", why }); else play.sort = p.sort;
  }
  if (p.playit !== undefined && p.playit !== null) {
    const why = playitProblem(p.playit);
    if (why) dropped.push({ field: "play.playit", why }); else play.playit = p.playit;
  }
  const before = {};
  for (const v of (m && Array.isArray(m.watch) ? m.watch : [])) {
    if (!v || v.before === undefined || v.before === null) continue;
    const why = whichProblem(v.before);
    if (why) dropped.push({ field: "before", id: v.id, why }); else before[v.id] = v.before;
  }
  return { play, before, dropped };
}
const playHasContent = (play) => play.which.length >= 1 || !!play.sort || !!play.playit;

// GET /this-week/<week_of>/play.json: that week's folder (not only the newest),
// validated; null when there is no such week or its manifest is not a week.
function playJson(dataDir, week_of) {
  if (typeof week_of !== "string" || !WEEK_RE.test(week_of)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dataDir, "this-week", week_of, "manifest.json"), "utf8")); }
  catch { return null; }
  let manifest;
  try { ({ manifest } = validate(raw)); } catch { return null; }
  const { play, before, dropped } = validatePlay(manifest);
  return { week_of, title: manifest.title, play, before, dropped, back: backFor(dataDir, week_of) };
}

// Where /watch/ and /play/ return for this week (spec 2026-11-17 §5): the
// current week's Watch ring / root as ever, a listed past week's own boards,
// and the root for a week with no board of its own (too old, or unlisted).
// The board builds the /watch/ URL itself, so the page asks here, not the URL.
function backFor(dataDir, week_of) {
  let weeks = [];
  try { weeks = readWeeks(dataDir); } catch {}
  const i = weeks.findIndex(w => w.week_of === week_of);
  if (i === 0) return { watch: "watch", board: ROOT };
  if (i > 0) return { watch: "w-" + week_of + "-watch", board: "w-" + week_of };
  return { watch: ROOT, board: ROOT };
}

// Newest <YYYY-MM-DD> folder holding a parseable manifest.json, or null.
// A newer folder whose manifest is mid-write (unparseable) is skipped; one that
// parses but carries a book's keys is refused (thrown), not skipped — a week
// that silently fell back to last week's board would hide the mistake.
function weekNames(dataDir) {
  try { return fs.readdirSync(path.join(dataDir, "this-week")).filter(n => WEEK_RE.test(n)).sort().reverse(); }
  catch { return []; }
}
// One folder's parsed manifest + stat, or null (none yet, or mid-write).
function loadRaw(dataDir, week_of) {
  const dir = path.join(dataDir, "this-week", week_of);
  const mp = path.join(dir, "manifest.json");
  try {
    const st = fs.statSync(mp);
    if (!st.isFile()) return null;
    return { week_of, manifest: JSON.parse(fs.readFileSync(mp, "utf8")), dir, mtimeMs: st.mtimeMs, size: st.size };
  } catch { return null; }
}
function readWeek(dataDir) {
  for (const week_of of weekNames(dataDir)) {
    const raw = loadRaw(dataDir, week_of);
    if (!raw) continue;
    const manifest = raw.manifest;
    if (manifest && typeof manifest === "object" && ("pages" in manifest || "cover" in manifest))
      throw new Error("week " + week_of + ": manifest uses pages/cover");
    return raw;
  }
  return null;
}

// Every week the board lists, newest first, each with a VALIDATED manifest:
// [current (readWeek's pick, and its throw), ...up to MAX_PAST older weeks].
// A past week that is missing, unparseable or fails validate() is left out —
// an old broken folder must never take the current week's board away.
function readWeeks(dataDir) {
  const cur = readWeek(dataDir);
  if (!cur) return [];
  const v = validate(cur.manifest);
  const out = [{ ...cur, manifest: v.manifest, dropped: v.dropped }];
  for (const week_of of weekNames(dataDir)) {
    if (out.length > MAX_PAST) break;
    if (week_of >= cur.week_of) continue;
    const raw = loadRaw(dataDir, week_of);
    if (!raw) continue;
    try { const p = validate(raw.manifest); out.push({ ...raw, manifest: p.manifest, dropped: p.dropped }); }
    catch { /* left out of the list */ }
  }
  return out;
}

// ready = <id>.mp4 with bytes; ext = the first thumbnail present (no dot).
function videoState(dir, id) {
  let size = 0;
  try { const st = fs.statSync(path.join(dir, id + ".mp4")); if (st.isFile()) size = st.size; } catch {}
  let ext = null;
  for (const e of THUMB_EXT) {
    try { if (fs.statSync(path.join(dir, id + e)).isFile()) { ext = e.slice(1); break; } } catch {}
  }
  return { ready: size > 0, ext, size };
}

// "<manifest mtime>-<size>-<ready bits hex, watch order>[-p<hash of past weeks>]-r<REV>",
// quoted. past = [{week_of, mtimeMs, size, manifest, ready}]: a newly mirrored
// past video, or a past week arriving, refreshes the board too (spec 2026-11-17).
function weekBits(week, ready) {
  const bits = (week.manifest.watch || []).map(v => (ready[v.id] && ready[v.id].ready) ? "1" : "0").join("");
  return Math.floor(week.mtimeMs || 0) + "-" + (week.size || 0) + "-" + (bits ? BigInt("0b" + bits).toString(16) : "0");
}
function etagFor(week, ready, past) {
  let p = "";
  if (past && past.length) {
    const h = crypto.createHash("sha1");
    for (const w of past) h.update(w.week_of + ":" + weekBits(w, w.ready || {}) + ";");
    p = "-p" + h.digest("hex").slice(0, 12);
  }
  return '"' + weekBits(week, ready) + p + "-r" + THIS_WEEK_REV + '"';
}

const backCell = (load = ROOT) => ({ label: "Back", say: "back", type: "back", glyph: "←", load, row: 1, col: 1 });

// The root-only board: no week on disk, or a broken one. Valid and alive.
function emptyRecipe() {
  return { locale: "en-US", root: ROOT, home_label: "This week",
           boards: [{ id: ROOT, name: "This week", rows: 2, columns: 3, buttons: [] }] };
}

// The Watch ring and the Talk pages, the same for the current week and a past
// one: only the board ids and where Back goes differ (spec 2026-11-17 §4).
function watchBoard(id, back, week, ready) {
  const watch = [backCell(back)];
  week.manifest.watch.slice(0, WATCH_SEATS.length).forEach((v, i) => {
    const [row, col] = WATCH_SEATS[i];
    const s = ready[v.id];
    if (s && s.ready) {
      // a ready video with no thumbnail is still playable: the cell drops only
      // its picture (like a movie with no poster), the label carries it
      const c = { type: "video", id: v.id, week_of: week.week_of, label: v.title };
      if (s.ext) c.image = ROOT + "/" + week.week_of + "/" + v.id + "." + s.ext;
      c.row = row; c.col = col;
      watch.push(c);
    } else
      watch.push({ type: "word", label: v.title, say: "not here yet", glyph: "⏳", row, col });
  });
  return { id, name: "Watch", rows: 3, columns: 3, buttons: watch };
}
function talkBoards(prefix, back, m) {
  const boards = [];
  const per = TALK_SEATS.length;
  const pages = Math.max(1, Math.ceil(m.talk.length / per));
  for (let p = 0; p < pages; p++) {
    const buttons = [backCell(back)];
    m.talk.slice(p * per, (p + 1) * per).forEach((t, i) => {
      const [row, col] = TALK_SEATS[i];
      const c = { type: "word", label: t.word, say: t.say };
      if (t.glyph) c.glyph = t.glyph; else c.symbol = t.symbol;
      c.row = row; c.col = col;
      buttons.push(c);
    });
    if (p < pages - 1)
      buttons.push({ label: "More", type: "control", symbol: "more", load: prefix + "talk-" + (p + 2), row: 3, col: 1 });
    boards.push({ id: prefix + "talk-" + (p + 1), name: "Talk", rows: 3, columns: 4, buttons });
  }
  return boards;
}

// A past week's one picture: its hero word's glyph, else its first science
// word's glyph, else the calendar (spec 2026-11-17 §2).
function weekGlyph(m) {
  const by = (g) => m.talk.find(t => t.group === g && t.glyph);
  const t = by("hero") || by("science");
  return t ? t.glyph : PAST_GLYPH;
}

// past = [{week_of, manifest (validated), ready}], newest first: the Past weeks
// pages (Talk mould, eight a page) and each week's corner board + its doors.
function pastBoards(past) {
  const boards = [];
  const per = TALK_SEATS.length;
  const pages = Math.ceil(past.length / per);
  const listed = [];
  for (let p = 0; p < pages; p++) {
    const buttons = [backCell()];
    past.slice(p * per, (p + 1) * per).forEach((w, i) => {
      const [row, col] = TALK_SEATS[i];
      // a door that says the week's title as it opens it (board-model's boolean say_on_load)
      buttons.push({ type: "word", label: w.manifest.title, say: w.manifest.title, glyph: weekGlyph(w.manifest),
                     load: "w-" + w.week_of, say_on_load: true, row, col });
      listed.push({ w, page: "past-" + (p + 1) });
    });
    if (p < pages - 1)
      buttons.push({ label: "More", type: "control", symbol: "more", load: "past-" + (p + 2), row: 3, col: 1 });
    boards.push({ id: "past-" + (p + 1), name: "Past weeks", rows: 3, columns: 4, buttons });
  }
  for (const { w, page } of listed) {
    const id = "w-" + w.week_of, m = w.manifest;
    // a 3×3 with the doors in the corners, so each has black neighbours
    const buttons = [
      backCell(page),
      { type: "show", board: id + "-watch", label: "Watch", say: "watch", glyph: "🎬", row: 1, col: 3,
        say_on_load: m.title },
    ];
    if (playHasContent(validatePlay(m).play))
      buttons.push({ type: "link", href: "/play/?w=" + w.week_of, label: "Play", say: "play", glyph: "🎲", row: 3, col: 1 });
    buttons.push({ type: "show", board: id + "-talk-1", label: "Talk", say: "talk", glyph: "💬", row: 3, col: 3 });
    boards.push({ id, name: m.title, rows: 3, columns: 3, buttons });
    boards.push(watchBoard(id + "-watch", id, w, w.ready || {}));
    boards.push(...talkBoards(id + "-", id, m));
  }
  return boards;
}

// week = readWeek()'s answer with a VALIDATED manifest; ready = {id: videoState};
// past = readWeeks()'s older weeks, each with its own `ready` (optional).
function recipe(week, ready, past) {
  ready = ready || {};
  past = past || [];
  const m = week.manifest, title = m.title;
  const boards = [];
  // the root is the 2×3 triangle (spec §1): two doors up, Play below, black between
  boards.push({ id: ROOT, name: title, rows: 2, columns: 3, buttons: [
    { type: "show", board: "watch", label: "Watch", say: "watch", glyph: "🎬", row: 1, col: 1,
      say_on_load: "This week: " + title },
    { type: "show", board: "talk-1", label: "Talk", say: "talk", glyph: "💬", row: 1, col: 3 },
  ] });
  // the Play door (spec §5.6): a same-origin link, only when an engine has content
  if (playHasContent(validatePlay(m).play))
    boards[0].buttons.push({ type: "link", href: "/play/?w=" + week.week_of, label: "Play", say: "play",
                             glyph: "🎲", row: 2, col: 2 });
  // the fourth door the triangle reserved (spec 2026-11-17 §1): only with a past week
  if (past.length)
    boards[0].buttons.push({ type: "show", board: "past-1", label: "Past weeks", say: "past weeks",
                             glyph: PAST_GLYPH, row: 2, col: 1 });
  boards.push(watchBoard("watch", ROOT, week, ready));
  boards.push(...talkBoards("", ROOT, m));
  boards.push(...pastBoards(past));
  return { recipe: { locale: "en-US", root: ROOT, home_label: "This week", boards },
           etag: etagFor(week, ready, past) };
}

const readyOf = (w) => {
  const ready = {};
  for (const v of w.manifest.watch) ready[v.id] = videoState(w.dir, v.id);
  return ready;
};

// Everything a request needs, never throwing: {recipe, etag, week, dropped, error}.
// `week`, `ready` and `dropped` are the current week's (the download rail reads them).
function build(dataDir) {
  try {
    const weeks = readWeeks(dataDir);
    if (!weeks.length) return { recipe: emptyRecipe(), etag: '"none-r' + THIS_WEEK_REV + '"', week: null, dropped: [] };
    const { dropped, ...week } = weeks[0];
    const ready = readyOf(week);
    const past = weeks.slice(1).map(w => ({ ...w, ready: readyOf(w) }));
    const out = recipe(week, ready, past);
    return { ...out, week, ready, dropped };
  } catch (e) {
    return { recipe: emptyRecipe(), etag: '"err-' + Date.now() + '"', week: null, dropped: [], error: e.message };
  }
}

module.exports = { THIS_WEEK_REV, readWeek, readWeeks, validate, validatePlay, playJson, recipe, videoState, etagFor, build, emptyRecipe,
                   WATCH_SEATS, TALK_SEATS, THUMB_EXT };
