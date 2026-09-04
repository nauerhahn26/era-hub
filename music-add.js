// music-add.js — "+ Add a song from the web", the one writer of the family's
// music library (spec §6 Music, plan T4.2). This retires
// era-family/tools/add-song.sh: a parent adds a song from the board's partner
// strip, on their own PC, and nobody has to open a terminal on a Linux box.
//
// Four laws, and everything here is one of them:
//
//   1. WHERE. Songs are written into the family's Drive content folder
//      (drive.status().folderPath + "/music"), never into <DATA>. <DATA> is
//      this device's shelf, which the mirror fills from Drive — a song written
//      there would play on this PC and exist nowhere else, and the next mirror
//      prune would eat it (drive.js MIRROR_DELETES now covers music). Same law
//      content.js opens with: build in the folder Google Drive uploads.
//   2. NO ffmpeg. A family PC has no ffmpeg and never will, so yt-dlp is asked
//      for audio that needs no remux (-f "ba[ext=m4a]/ba") and a thumbnail
//      written exactly as it comes (--write-thumbnail). NEVER -x, never
//      --audio-format, never --convert-thumbnails: all three shell out to
//      ffmpeg and fail on the family's box. The hub already serves .m4a and
//      .webp (server.js MUSIC_EXTS), so no conversion is wanted.
//   3. A SLUG IS A NAME, NOT A PATH. The id is [a-z0-9-] and at most 64
//      characters, the same discipline slug.js/books-index.js keep, because it
//      is spelled straight into a filename and into a board button's id.
//      A title becomes one through slugify(); a slug a caller sends is checked
//      and refused, never repaired.
//   4. THE PACK MAY BE ABSENT. yt-dlp is the optional media-tools pack
//      (packs.js, ~18 MB). Without it this answers "pack-missing" with words
//      the sheet can show and a pack id it can offer to install — never a 500,
//      never a spinner that goes nowhere.
//
// One add at a time, and the door answers 202 while the download runs behind
// it (the /clothing/regenerate pattern): a song can take a minute and no sheet
// should hold a socket open for it. status() is how the sheet finds out how it
// went, so every message here is written for a parent to read.
//
// No key is read in this file. yt-dlp needs none — but it does need a JS
// runtime, which packs.ytDlp() settles by pointing it at the Node this hub is
// already running on.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const drive = require("./drive.js");
const packs = require("./packs.js");
const { slugify } = require("./slug.js");
const { writeAtomic, redact } = require("./content-store.js");

const PACK = "media-tools";
// Law 3. 64 matches slug.js MAX_SLUG and the movies-catalog id rule.
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
// What yt-dlp may hand back, and what the hub will serve for it. Both lists are
// subsets of server.js MUSIC_AV_EXTS / MUSIC_EXTS: a file the shelf could not
// serve is not an add that worked.
const AUDIO_EXT = [".m4a", ".webm", ".opus", ".mp3", ".wav"];
const COVER_EXT = [".webp", ".jpg", ".jpeg", ".png"];
// A stuck download must not hold the "one at a time" slot for ever. Ten minutes
// is longer than any song and shorter than a parent's patience.
const KILL_MS = 10 * 60 * 1000;

let running = null;   // {title, phase} of the add in flight
let last = null;      // how the previous one went, for the sheet

// The tool, or null when the family has not installed the pack. ERA_YTDLP is a
// test seam in the shape ERA_AI_URL / ERA_DRIVE_API already have: it names a
// stand-in binary so no test ever runs the real yt-dlp or reaches YouTube.
function tool() {
  const t = packs.ytDlp(__dirname);
  if (process.env.ERA_YTDLP) return { bin: process.env.ERA_YTDLP, args: t.args };
  if (!packs.packInstalled(__dirname, PACK)) return null;
  return t;
}

// Law 1: the family's Drive folder, or null when there is no local one. Read
// live on every call — a parent can pick the folder while the sheet is open.
function musicDir() {
  const st = drive.status();
  if (st.mode !== "local" || !st.folderPath) return null;
  return path.join(st.folderPath, "music");
}

// ------------------------------------------------------------------ yt-dlp

function run(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) { resolve({ code: -1, stdout: "", stderr: String(e.message) }); return; }
    let stdout = "", stderr = "", timer = null;
    // Caps: a broken tool can print for ever, and this is all held in memory.
    child.stdout.on("data", d => { if (stdout.length < 2e6) stdout += d; });
    child.stderr.on("data", d => { if (stderr.length < 2e5) stderr += d; });
    child.on("error", e => { stderr += e.message; });
    timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, KILL_MS);
    timer.unref();
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// What went wrong, in one line, for a parent. yt-dlp's last stderr line is
// usually the only useful one ("Video unavailable", "Sign in to confirm..."),
// and it goes through redact() because anything this returns is shown in
// Settings and could be echoed into a log.
function why(what, r) {
  const line = String(r.stderr || "").split("\n").map(s => s.trim())
    .filter(Boolean).pop() || "";
  const tail = redact(line).replace(/\s+/g, " ").slice(0, 200);
  return what + (tail ? ": " + tail : " (yt-dlp stopped with " + r.code + ")");
}

// Ask yt-dlp what a link (or a search) actually is, WITHOUT downloading: the
// title is what names the file, so it has to be known before the download's
// output template can be written.
async function lookUp(t, target) {
  const r = await run(t.bin, [...t.args, "--no-playlist", "--no-warnings",
                              "--skip-download", "--dump-single-json", target]);
  if (r.code !== 0) throw new Error(why("could not look that up", r));
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw new Error("could not make sense of what came back for that"); }
  if (j && Array.isArray(j.entries)) j = j.entries[0];   // a search answers with a playlist
  if (!j || typeof j !== "object")
    throw new Error("nothing came back for that - check the link, or try a different name");
  return j;
}

async function download(t, dir, slug, source) {
  const r = await run(t.bin, [...t.args, "--no-playlist", "--no-warnings", "--no-progress",
    "--retries", "3",
    // Law 2. Do not add -x / --audio-format / --convert-thumbnails here.
    "-f", "ba[ext=m4a]/ba", "--write-thumbnail",
    "-o", path.join(dir, slug + ".%(ext)s"), source]);
  if (r.code !== 0) throw new Error(why("could not download that song", r));
}

// ---------------------------------------------------------------- the files

// `<slug>.<ext>` in dir, first extension that exists, or null. Exact names
// only: the slug is already known to be [a-z0-9-], so this can never glob its
// way out of the folder.
function pickFile(dir, slug, exts) {
  for (const e of exts) if (fs.existsSync(path.join(dir, slug + e))) return slug + e;
  return null;
}

// An older take of the same song, gone before the new one lands: a re-add whose
// audio comes back .webm this time must not leave yesterday's .m4a behind for
// the manifest to point at.
function forget(dir, slug) {
  for (const e of [...AUDIO_EXT, ...COVER_EXT])
    try { fs.unlinkSync(path.join(dir, slug + e)); } catch {}
}

// ------------------------------------------------------------- the manifest

function nextRank(songs) {
  let max = 0;
  for (const s of songs) if (s && Number.isFinite(s.rank) && s.rank > max) max = s.rank;
  return max + 1;
}

// The manifest as it stands, and never a throw: a folder with no manifest yet
// (a family's first song) and a manifest a text editor mangled both read as an
// empty library, which is what the next write then repairs.
function readManifest(dir) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch {}
  if (!m || typeof m !== "object" || Array.isArray(m)) m = {};
  const songs = Array.isArray(m.songs) ? m.songs.filter(s => s && typeof s === "object") : [];
  return { m, songs };
}

// Upsert by id, atomically (content-store's tmp + rename, so a device never
// mirrors half a manifest). A song added twice KEEPS the rank it has: its tile
// is where Ellie learned it is, and re-adding a song to fix its audio must not
// move it to the end of the board.
function upsert(dir, fields) {
  const file = path.join(dir, "manifest.json");
  const { m, songs } = readManifest(dir);
  const at = songs.findIndex(s => s.id === fields.id);
  const rank = at >= 0 && Number.isFinite(songs[at].rank) ? songs[at].rank : nextRank(songs);
  const entry = { ...(at >= 0 ? songs[at] : {}), ...fields, rank };
  if (at >= 0) songs[at] = entry; else songs.push(entry);
  songs.sort((a, b) => (a.rank || 0) - (b.rank || 0));
  writeAtomic(file, { ...m, schemaVersion: 1, songs });
  return entry;
}

// ------------------------------------------------------------------- the add

async function runAdd(job, t, dir) {
  const target = job.url || "ytsearch1:" + job.query;
  const info = await lookUp(t, target);
  const sourceTitle = String(info.title == null ? "" : info.title).trim();
  const title = job.title || sourceTitle || job.query;
  const slug = job.slug || slugify(title);
  // A title with no Latin letters at all ("♪♪♪") slugifies to nothing. Books
  // fall back to "book"; a song says so instead, because the parent is standing
  // right there and can type a name.
  if (!SLUG_RE.test(slug))
    throw new Error("that title does not make a name we can save - type one yourself");
  job.slug = slug;
  job.title = title;
  job.phase = "downloading";
  const source = String(info.webpage_url || info.original_url || job.url || target);

  fs.mkdirSync(dir, { recursive: true });
  forget(dir, slug);
  await download(t, dir, slug, source);
  const audio = pickFile(dir, slug, AUDIO_EXT);
  if (!audio) throw new Error("the download finished but left no audio file");

  job.phase = "putting it on the board";
  const entry = upsert(dir, {
    id: slug, title, audio, cover: pickFile(dir, slug, COVER_EXT),
    duration: Math.max(0, Math.round(Number(info.duration) || 0)),
    source, sourceTitle,
  });
  // The board plays from this device's shelf (<DATA>/music), which the mirror
  // fills from the folder we just wrote. Without this the song would appear at
  // the next ten-minute sync, long after the parent walked away.
  try { await drive.sync(); } catch {}
  return { id: entry.id, title: entry.title, rank: entry.rank };
}

// add(body) -> {started:true} | {error, message, ...}. Everything that can be
// known before yt-dlp runs is decided here, synchronously, so the door can
// answer a refusal properly instead of 202-ing into a failure.
function add(body) {
  const b = body && typeof body === "object" ? body : {};
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (url && !/^https?:\/\/[^\s/]+\/?\S*$/i.test(url))
    return { error: "bad-url", message: "That does not look like a web link. Paste the whole address, or type a name instead." };
  if (!url && !query)
    return { error: "need-url-or-query", message: "Paste a link to the song, or type its name." };
  // An id the sheet chose (a parent renaming a song). Checked, never repaired:
  // it becomes a filename and a board button's id, so "../evil" is a refusal,
  // not something to sanitise into silence. Absent, the title provides one.
  let slug = null;
  if (b.slug != null) {
    if (typeof b.slug !== "string" || !SLUG_RE.test(b.slug))
      return { error: "bad-slug", message: "A song's short name can only use small letters, numbers and dashes." };
    slug = b.slug;
  }
  const t = tool();
  if (!t)
    return { error: "pack-missing", pack: PACK,
             message: "Adding songs from the web needs a one-time download of about 18 MB. Install it and try again." };
  const dir = musicDir();
  if (!dir)
    return { error: "needs-local-drive",
             message: "New ERA saves new songs into the family's Drive folder, so every device gets them. Choose that folder in Settings first." };
  if (running)
    return { error: "busy", message: "One song at a time - the last one is still downloading." };

  const job = { slug, title: typeof b.title === "string" ? b.title.trim() : "",
                url, query, phase: "looking it up" };
  running = job;
  runAdd(job, t, dir)
    .then(r => { last = { ok: true, id: r.id, title: r.title, rank: r.rank, error: "",
                          when: new Date().toISOString() }; })
    .catch(e => { last = { ok: false, id: job.slug || null, title: job.title || query,
                           error: redact(String(e && e.message || e)).replace(/\s+/g, " "),
                           when: new Date().toISOString() }; })
    .finally(() => { running = null; });
  return { started: true };
}

// --------------------------------------------------------------- ⇅ Arrange

// order({ids}) -> {ok, songs} | {error, message}. The strip's "⇅ Arrange" hands
// back the WHOLE running order, not a move, because that is the only shape that
// cannot half-apply: rank becomes 1..n in the order given and no other field is
// touched.
//
// A partial list is a refusal, never a best effort. Ellie navigates the songs
// board from memory, so an order that quietly dropped the songs it forgot to
// name — or renumbered around a song added on another device thirty seconds ago
// — would move tiles nobody asked to move. If the strip is out of date it must
// reload and send again.
//
// Unlike add(), this answers when it is done: it is one small file and a mirror
// of a folder the family already has locally, so the sheet can wait for it and
// know the board is right the moment the spinner stops.
async function order(body) {
  const b = body && typeof body === "object" ? body : {};
  const ids = Array.isArray(b.ids) ? b.ids : null;
  // Law 3 again: every id is checked as a name, not repaired. Nothing here is
  // ever spelled into a path, but an id that could not be a slug cannot be one
  // of ours either, so it is refused before the manifest is even read.
  if (!ids || !ids.every(id => typeof id === "string" && SLUG_RE.test(id)))
    return { error: "bad-ids", message: "New ERA could not read that new order. Reload the board and try again." };
  const dir = musicDir();
  if (!dir)
    return { error: "needs-local-drive",
             message: "New ERA keeps the songs in the family's Drive folder, so every device gets the same order. Choose that folder in Settings first." };
  // An add in flight is about to rewrite this same file: let it land first
  // rather than race it and lose one of the two writes.
  if (running)
    return { error: "busy", message: "A song is still downloading - arrange the board when it lands." };

  const { m, songs } = readManifest(dir);
  if (!songs.length)
    return { error: "no-songs", message: "There are no songs on the board to arrange yet." };

  const byId = new Map(songs.map(s => [s.id, s]));
  const seen = new Set();
  const ordered = [];
  for (const id of ids) {
    const s = byId.get(id);
    // The id is family content, so the message names no song: the sheet knows
    // which tile it dragged, and a reload is the whole fix.
    if (!s)
      return { error: "unknown-song",
               message: "That order names a song New ERA does not have. Reload the board and try again." };
    if (seen.has(id))
      return { error: "bad-ids", message: "That order names the same song twice. Reload the board and try again." };
    seen.add(id);
    ordered.push(s);
  }
  if (ordered.length !== songs.length)
    return { error: "incomplete",
             message: "That order left songs out, so New ERA changed nothing. Reload the board and try again." };

  const next = ordered.map((s, i) => ({ ...s, rank: i + 1 }));
  writeAtomic(path.join(dir, "manifest.json"), { ...m, schemaVersion: 1, songs: next });
  // The board reads this device's shelf, and the recipe's ETag is the shelf
  // manifest's mtime (server.js songsRecipe) — without the mirror the tiles
  // would keep their old places until the next ten-minute sync.
  try { await drive.sync(); } catch {}
  return { ok: true, songs: next.length };
}

// What the sheet polls. No folder path, no key, no yt-dlp command line — the
// song's own title is the only family thing in here, and it is the one thing a
// parent needs to see.
function status() {
  return {
    pack: { id: PACK, installed: !!tool() },
    folder: !!musicDir(),
    running: running ? { title: running.title || running.query || "", phase: running.phase } : null,
    last,
  };
}

module.exports = { add, order, status, SLUG_RE };
