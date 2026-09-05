// music-add.js — "+ Add a song from the web", the one writer of the family's
// music library (spec §6 Music, plan T4.2). This retires
// era-family/tools/add-song.sh: a parent adds a song from the board's partner
// strip, on their own PC, and nobody has to open a terminal on a Linux box.
//
// Five laws, and everything here is one of them:
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
//      never a spinner that goes nowhere. The sheet's offer is real: the pack
//      belongs to no app, so POST /packs/install is its only way in.
//   5. NOTHING THE FAMILY ALREADY HAS IS DESTROYED BY A TRY. A download lands
//      under a staging name and replaces a song only once it is really here,
//      and a song list that cannot be READ is never WRITTEN over. Both were
//      real: a failed re-add used to delete a song for good, and one
//      half-synced manifest.json used to erase the whole library (review 9/5).
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
// ERA_PACK_ROOT is its other half: without it "the pack is missing" could only
// ever be proven by the accident that a checkout has no vendor/yt-dlp in it,
// and .gitignore expressly anticipates a developer dropping one there.
function packRoot() { return process.env.ERA_PACK_ROOT || __dirname; }
function tool() {
  const root = packRoot();
  const t = packs.ytDlp(root);
  if (process.env.ERA_YTDLP) return { bin: process.env.ERA_YTDLP, args: t.args };
  if (!packs.packInstalled(root, PACK)) return null;
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
    let stdout = "", stderr = "", timer = null, killed = false;
    // Caps: a broken tool can print for ever, and this is all held in memory.
    child.stdout.on("data", d => { if (stdout.length < 2e6) stdout += d; });
    child.stderr.on("data", d => { if (stderr.length < 2e5) stderr += d; });
    child.on("error", e => { stderr += e.message; });
    // `killed` is remembered because a SIGKILLed child prints nothing useful and
    // closes with a null code: "yt-dlp stopped with null" is not a fact anyone
    // can act on, and "it took too long" is.
    timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, KILL_MS);
    timer.unref();
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, killed }); });
  });
}

// What went wrong, in one line, FOR AN OPERATOR. yt-dlp's last stderr line is
// usually the only useful one ("Video unavailable", "Sign in to confirm..."),
// and it goes through redact() because anything this returns is kept in
// `last.error` and echoed into a log. It is not what a family reads — see
// plainly() below, and bug 5.
function why(what, r) {
  // KILL_MS fired: there is no last line worth having, and the close code is
  // null. Say the thing that actually happened.
  if (r.killed) return what + ": it took too long, so New ERA stopped it";
  const line = String(r.stderr || "").split("\n").map(s => s.trim())
    .filter(Boolean).pop() || "";
  const tail = redact(line).replace(/\s+/g, " ").slice(0, 200);
  return what + (tail ? ": " + tail : " (yt-dlp stopped with " + r.code + ")");
}

// The same failure said again, for the FAMILY. VM QA 9/5 added a YouTube link
// from a datacenter IP and the board sheet showed the lot: "New ERA could not
// add that song. ERROR: [youtube] XqZsoesa55w: Sign in to confirm you're not a
// bot. Use --cookies-from-browser or --cookies for the authentication. See
// https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-t" — cut off
// mid-word, in a house where nobody is going to pass cookies from a browser.
// So `last.error` keeps yt-dlp's own words (the hub's console and whoever is
// fixing it need them) and `last.message` says the one sentence a parent can
// act on: no URL, no flag, no "ERROR:".
//
// Read most specific first: the bot-check line also talks about a download,
// and a country block also says "not available". Anything unrecognised gets
// the last sentence rather than the raw text — an unfamiliar shape is exactly
// the one that would put a command line on a six-year-old's board.
//
// (Everything refused BEFORE the 202 — no pack, no folder, a bad link, a song
// list we cannot read — already reaches the sheet in this file's own words
// through the door's `message`. Only what goes wrong mid-download comes here.)
const PLAIN = [
  [/Sign in to confirm you.re not a bot|confirm your age|login required/i,
   "YouTube would not let New ERA fetch that one from here. Try another link, or add the song from an MP3 in the family's music folder."],
  [/Video unavailable|Private video|This video is not available|removed/i,
   "That video is not available any more. Try another link."],
  // "…has blocked it in your country on copyright grounds" and "The uploader
  // has not made this video available in your country" are both real lines.
  [/copyright|blocked it in your country|available in your country/i,
   "That video cannot be played in your country. Try another link."],
  [/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|Unable to download|network|offline/i,
   "New ERA could not reach the internet to fetch it. Check the connection and try again."],
  [/Unsupported URL|is not a valid URL|No video formats/i,
   "New ERA does not know how to fetch a song from that link. Paste the video's own address."],
  [/timed out|took too long/i,
   "That took too long to download. Try again, or try a shorter video."],
];
const PLAIN_LAST = "New ERA could not add that song. Try again, or try another link.";
function plainly(raw) {
  const s = String(raw == null ? "" : raw);
  for (const [re, sentence] of PLAIN) if (re.test(s)) return sentence;
  return PLAIN_LAST;
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

async function download(t, dir, base, source) {
  const r = await run(t.bin, [...t.args, "--no-playlist", "--no-warnings", "--no-progress",
    "--retries", "3",
    // Law 2. Do not add -x / --audio-format / --convert-thumbnails here.
    "-f", "ba[ext=m4a]/ba", "--write-thumbnail",
    "-o", path.join(dir, base + ".%(ext)s"), source]);
  if (r.code !== 0) throw new Error(why("could not download that song", r));
}

// ---------------------------------------------------------------- the files

// Law 5, learned the hard way (review 9/5): A SONG THE FAMILY ALREADY HAS IS
// NEVER TOUCHED UNTIL THERE IS SOMETHING TO REPLACE IT WITH. A download lands
// under this staging name and is renamed into place only once yt-dlp has
// really left an audio file; before, the old take was deleted first, so a
// re-add whose download failed destroyed a song for good (songsRecipe drops a
// song whose audio file is missing, so the tile simply vanished).
// The slug is [a-z0-9-], so this name is ours alone and cannot collide with a
// song's own file.
function staging(slug) { return "." + slug + ".add"; }

// The first of `exts` that exists as `<base><ext>` in dir, or null. Exact names
// only: the base is built from a checked slug, so this can never glob its way
// out of the folder.
function pickExt(dir, base, exts) {
  for (const e of exts) if (fs.existsSync(path.join(dir, base + e))) return e;
  return null;
}
// An older take of the same song, gone as the new one lands: a re-add whose
// audio comes back .webm this time must not leave yesterday's .m4a behind for
// the manifest to point at.
function forget(dir, slug) {
  for (const e of [...AUDIO_EXT, ...COVER_EXT])
    try { fs.unlinkSync(path.join(dir, slug + e)); } catch {}
}

// Everything a staged download left, whatever extension yt-dlp chose — a
// .part, a .ytdl, a second thumbnail. A prefix match is safe here and only
// here: the staging name is ours, and no song's file can start with it.
function sweep(dir, base) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names)
    if (n === base || n.startsWith(base + "."))
      try { fs.unlinkSync(path.join(dir, n)); } catch {}
}

// ------------------------------------------------------------- the manifest

function nextRank(songs) {
  let max = 0;
  for (const s of songs) if (s && Number.isFinite(s.rank) && s.rank > max) max = s.rank;
  return max + 1;
}

// The manifest as it stands, and never a throw — but "there is no library yet"
// and "I could not read the library" are DIFFERENT ANSWERS (review 9/5). They
// used to share one catch, so a half-synced file (Google Drive for Desktop
// writes one), a Windows EBUSY/EPERM (Drive or an antivirus holding the file
// open) or a truncated write read as "no songs yet" — and the next add wrote
// the file back with a single song in it. Twenty songs, gone.
//
// Only ENOENT is an empty library. Everything else says `unreadable`, and every
// caller refuses rather than writing over what it could not read.
function readManifest(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { m: {}, songs: [] };   // the family's first song
    return { m: {}, songs: [], unreadable: true };
  }
  let m;
  try { m = JSON.parse(raw); } catch { return { m: {}, songs: [], unreadable: true }; }
  // an empty file, a `null`, a bare array: not a manifest, and not an excuse
  // to start a new one over the top of whatever was there.
  if (!m || typeof m !== "object" || Array.isArray(m)) return { m: {}, songs: [], unreadable: true };
  const songs = Array.isArray(m.songs) ? m.songs.filter(s => s && typeof s === "object") : [];
  return { m, songs };
}

// The one refusal both doors give for it, in a parent's words.
const UNREADABLE = { error: "manifest-unreadable",
  message: "New ERA could not read the list of songs just now. Try again in a minute." };

// Upsert by id, atomically (content-store's tmp + rename, so a device never
// mirrors half a manifest). A song added twice KEEPS the rank it has: its tile
// is where Ellie learned it is, and re-adding a song to fix its audio must not
// move it to the end of the board.
function upsert(dir, fields) {
  const file = path.join(dir, "manifest.json");
  const { m, songs, unreadable } = readManifest(dir);
  // add() checked this before the download started; a minute has passed since,
  // and the file is in a folder Google Drive is syncing. Check again rather
  // than write a one-song library over a library we cannot see.
  if (unreadable) throw new Error(UNREADABLE.message);
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
  // Law 5: everything lands under the staging name first. The old take is not
  // touched until the new one is really here, and whatever the download left
  // half-finished is swept whether it worked or not.
  const stage = staging(slug);
  let audio = null, cover = null;
  sweep(dir, stage);
  try {
    await download(t, dir, stage, source);
    const ae = pickExt(dir, stage, AUDIO_EXT);
    if (!ae) throw new Error("the download finished but left no audio file");
    const ce = pickExt(dir, stage, COVER_EXT);
    // Last look before anything the family has is touched: upsert() would
    // refuse to write an unreadable manifest, and refusing AFTER the swap
    // would leave the old audio deleted and the manifest still naming it.
    if (readManifest(dir).unreadable) throw new Error(UNREADABLE.message);
    forget(dir, slug);                       // NOW yesterday's take may go
    audio = slug + ae;
    fs.renameSync(path.join(dir, stage + ae), path.join(dir, audio));
    if (ce) {
      cover = slug + ce;
      fs.renameSync(path.join(dir, stage + ce), path.join(dir, cover));
    }
  } finally { sweep(dir, stage); }

  job.phase = "putting it on the board";
  const entry = upsert(dir, {
    id: slug, title, audio, cover,
    duration: Math.max(0, Math.round(Number(info.duration) || 0)),
    source, sourceTitle,
  });
  // The board plays from this device's shelf (<DATA>/music), which the mirror
  // fills from the folder we just wrote. Without this the song would appear at
  // the next ten-minute sync, long after the parent walked away.
  return { id: entry.id, title: entry.title, rank: entry.rank, mirrored: await mirror() };
}

// Carry what we just wrote from the family's Drive folder to this device's
// shelf, and SAY whether it arrived. drive.sync() reports a failure by
// answering rather than throwing (and syncLocal collects per-file errors), so
// a plain try/catch here saw nothing — which is how "The songs are in their new
// order" came to be said over a board that had not moved (review 9/5).
async function mirror() {
  try {
    const r = await drive.sync();
    return !(r && (r.error || (Array.isArray(r.errors) && r.errors.length)));
  } catch { return false; }
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
  // Refuse BEFORE the 202: a library we cannot read is not a library we may
  // write a single song over (see readManifest).
  if (readManifest(dir).unreadable) return UNREADABLE;
  if (running)
    return { error: "busy", message: "One song at a time - the last one is still downloading." };

  const job = { slug, title: typeof b.title === "string" ? b.title.trim() : "",
                url, query, phase: "looking it up" };
  running = job;
  runAdd(job, t, dir)
    .then(r => { last = { ok: true, id: r.id, title: r.title, rank: r.rank, error: "",
                          mirrored: r.mirrored, when: new Date().toISOString() }; })
    .catch(e => {
      const raw = redact(String(e && e.message || e)).replace(/\s+/g, " ");
      // Two readers, two sentences: `error` is yt-dlp's line, kept for the
      // console and for whoever is fixing the hub, and `message` is the only
      // one the board sheet ever shows (bug 5).
      console.error("[music-add] " + raw);
      last = { ok: false, id: job.slug || null, title: job.title || query,
               error: raw, message: plainly(raw),
               when: new Date().toISOString() };
    })
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

  const { m, songs, unreadable } = readManifest(dir);
  if (unreadable) return UNREADABLE;
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
  // would keep their old places until the next ten-minute sync. `mirrored`
  // is that outcome, so the strip can say "saved, the board will catch up"
  // instead of "the songs are in their new order" over an unmoved board.
  return { ok: true, songs: next.length, mirrored: await mirror() };
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
