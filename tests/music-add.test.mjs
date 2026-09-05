// music-add.test.mjs — POST /music/add: the board strip's "+ Add a song"
// (spec §6 Music, plan T4.2). Drives the REAL server.js from outside.
//
// NO KEY, NO NETWORK, NO REAL yt-dlp. The hub is spawned with ERA_YTDLP
// pointing at a stand-in script this suite writes itself (a seam in the shape
// ERA_AI_URL / ERA_DRIVE_API already have), so nothing here ever reaches
// YouTube. The stand-in records its argv, which is how the ffmpeg-free
// contract is proven: -f "ba[ext=m4a]/ba", --write-thumbnail, and NEVER -x or
// --convert-thumbnails (spec §6: a family PC has no ffmpeg).
//
// Gap 13: the gate's headless Chromium cannot decode AAC, so no assertion here
// plays an .m4a. The song is proven by its manifest entry, by the generated
// songs recipe, and by a 200 + Accept-Ranges on GET /music/<slug>.m4a.
//
// Where the bytes land matters (Gap 1): the add writes into the family's DRIVE
// content folder, never <DATA>, and the mirror carries it to the shelf. The
// recipe assertion below is what would catch a write to the wrong directory.
//
// Port 8436 (this suite's own; 8377-8435 are held by siblings and live hubs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8436;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-music-add-"));
const ROOT = path.join(TMP, "My Drive");                // the named mount
const INSIDE = path.join(ROOT, "New ERA Content");      // what the family picks
const MUSIC = path.join(INSIDE, "music");               // where the add must write
const BIN = path.join(TMP, "bin", "yt-dlp");            // the stand-in
const CTL = path.join(TMP, "bin", "ctl.json");          // what it should do next
const CALLS = path.join(TMP, "bin", "calls.jsonl");     // every argv it saw
// A suite root with no packs in it. "the pack is missing" used to be proven
// only by the accident that vendor/yt-dlp happens not to exist in a worktree —
// and .gitignore expressly anticipates a developer dropping one there for local
// testing, which would have turned the pack-missing test green on the wrong
// answer. ERA_PACK_ROOT makes the absence a fact of the test, not of the box.
const NOPACKS = path.join(TMP, "no-packs");
let child = null;
let DATA = null;

// The stand-in. Two modes, exactly as music-add.js calls it: --dump-single-json
// (look it up) and a download (write the files the output template names).
const FAKE = `#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const ctl = process.env.FAKE_YTDLP_CTL;
const st = JSON.parse(fs.readFileSync(ctl, "utf8"));
fs.appendFileSync(path.join(path.dirname(ctl), "calls.jsonl"), JSON.stringify(argv) + "\\n");
const target = argv[argv.length - 1];
if (argv.includes("--dump-single-json")) {
  if (st.mode === "fail-resolve") {
    // st.stderr lets a case pick the shape yt-dlp fails in — the bot check
    // reads nothing like "Video unavailable" and the family is told a
    // different thing about each.
    process.stderr.write((st.stderr || "ERROR: [youtube] dQw: Video unavailable") + "\\n");
    process.exit(1);
  }
  if (st.mode === "no-hits") { process.stdout.write(JSON.stringify({ _type: "playlist", entries: [] })); process.exit(0); }
  const info = { id: st.id || "vid123", title: st.title, duration: st.duration,
                 webpage_url: st.webpageUrl || "https://www.youtube.com/watch?v=" + (st.id || "vid123") };
  process.stdout.write(JSON.stringify(
    target.startsWith("ytsearch") ? { _type: "playlist", entries: [info] } : info));
  process.exit(0);
}
if (st.mode === "fail-download") {
  process.stderr.write("ERROR: unable to download video data: HTTP Error 403: Forbidden\\n");
  process.exit(1);
}
const tmpl = argv[argv.indexOf("-o") + 1];
const base = tmpl.replace(/\\.%\\(ext\\)s$/, "");
fs.mkdirSync(path.dirname(base), { recursive: true });
fs.writeFileSync(base + ".m4a", Buffer.from(st.audio || "fake-m4a-bytes-not-real-audio"));
if (st.mode !== "no-thumbnail") fs.writeFileSync(base + ".webp", Buffer.from("fake-webp"));
process.exit(0);
`;

function ctl(state) { fs.writeFileSync(CTL, JSON.stringify(state)); }
function calls() {
  try {
    return fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
function manifest() {
  return JSON.parse(fs.readFileSync(path.join(MUSIC, "manifest.json"), "utf8"));
}

async function startHub(extraEnv) {
  DATA = fs.mkdtempSync(path.join(TMP, "data-"));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
           ERA_DRIVE_LOCAL_ROOTS: ROOT, FAKE_YTDLP_CTL: CTL,
           // belt and braces: a sync fans out to the clothing build, and that
           // build must never be able to reach a provider from a test box.
           ERA_AI_URL: "http://127.0.0.1:9/never",
           // POST /packs/install pulls the release tarball: point the feed at a
           // dead loopback port so the door can be exercised without a byte
           // leaving this machine.
           ERA_UPDATE_URL: "http://127.0.0.1:9/never", ...extraEnv },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}
async function stopHub() {
  if (!child) return;
  const c = child; child = null;
  const gone = new Promise(r => c.once("exit", r));
  c.kill("SIGKILL");
  await gone;
}

const post = (url, body) => fetch(BASE + url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const addStatus = () => fetch(`${BASE}/music/add/status`, { cache: "no-store" }).then(r => r.json());

// The add answers 202 and works behind it, so every case waits for the module
// to say it finished rather than sleeping a guessed number of milliseconds.
async function settled() {
  for (let i = 0; i < 200; i++) {
    const s = await addStatus();
    if (!s.running && s.last) return s.last;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("the add never finished");
}

before(() => {
  fs.mkdirSync(INSIDE, { recursive: true });
  fs.mkdirSync(NOPACKS, { recursive: true });
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  fs.writeFileSync(BIN, FAKE, { mode: 0o755 });
  ctl({ mode: "ok", title: "Let It Go!", duration: 232 });
});
after(async () => {
  await stopHub();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------- without the pack

test("without the media-tools pack the sheet gets an answer it can read, never a 500", async () => {
  await startHub({ ERA_PACK_ROOT: NOPACKS });   // no ERA_YTDLP, and a root with no packs in it

  const r = await post("/music/add", { url: "https://www.youtube.com/watch?v=abc" });
  assert.equal(r.status, 409, "a refusal, not a crash");
  const j = await r.json();
  assert.equal(j.error, "pack-missing");
  assert.equal(j.pack, "media-tools", "the sheet knows which box to tick");
  assert.ok(typeof j.message === "string" && j.message.length > 10, "and what to tell a parent");

  const s = await addStatus();
  assert.deepEqual(s.pack, { id: "media-tools", installed: false });
  assert.equal(s.running, null);
  assert.equal(calls().length, 0, "and nothing was spawned - a refusal never runs a downloader");
});

test("a body with neither a link nor a name is refused before anything is spawned", async () => {
  for (const body of [{}, { url: "" }, { query: "   " }, { url: "not a link" },
                      { url: "javascript:alert(1)" }]) {
    const r = await post("/music/add", body);
    assert.equal(r.status, 400, `refused: ${JSON.stringify(body)}`);
    const j = await r.json();
    assert.ok(j.error && j.message, "with something the sheet can show");
  }
  assert.equal(calls().length, 0, "and still nothing spawned");
});

// The sheet's "Install it and try again" has to lead somewhere: media-tools
// belongs to no app, so POST /apps could never lay it down (review 9/5).
test("the pack the sheet names can really be installed - POST /packs/install", async () => {
  const bad = await post("/packs/install", { pack: "../evil" });
  assert.equal(bad.status, 400, "a pack nobody has heard of is a refusal");
  assert.equal((await bad.json()).error, "unknown-pack");

  const there = await post("/packs/install", { pack: "reader" });
  assert.equal(there.status, 200, "a pack already on disk is never downloaded again");
  assert.deepEqual(await there.json(), { installed: true });

  const go = await post("/packs/install", { pack: "media-tools" });
  assert.equal(go.status, 202, "and the one the sheet offers really starts");
  assert.deepEqual(await go.json(), { installing: true });
});

// ------------------------------------------------------------- with the pack

test("with the tool but no Drive folder chosen, the add says so instead of writing to <DATA>", async () => {
  await stopHub();
  await startHub({ ERA_YTDLP: BIN });

  const r = await post("/music/add", { url: "https://www.youtube.com/watch?v=abc" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "needs-local-drive");
  assert.equal(fs.existsSync(path.join(DATA, "music")), false, "and nothing was written to the shelf");
  assert.equal(calls().length, 0, "and yt-dlp was never spawned to find out");
});

test("a pasted link: audio + thumbnail into the DRIVE folder, one manifest entry, rank 1", async () => {
  assert.equal((await post("/integrations/drive/localfolder", { folderPath: INSIDE })).status, 204);
  ctl({ mode: "ok", id: "letitgo1", title: "Let It Go!", duration: 232 });

  const r = await post("/music/add", { url: "https://www.youtube.com/watch?v=letitgo1" });
  assert.equal(r.status, 202, "202 and the download runs behind it");
  assert.deepEqual(await r.json(), { started: true });
  const last = await settled();
  assert.equal(last.ok, true, "the add finished: " + (last.error || ""));
  assert.equal(last.id, "let-it-go", "slug comes from the title, [a-z0-9-] only");

  assert.ok(fs.existsSync(path.join(MUSIC, "let-it-go.m4a")), "audio in the family's Drive folder");
  assert.ok(fs.existsSync(path.join(MUSIC, "let-it-go.webp")), "and its thumbnail");
  const m = manifest();
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.songs.length, 1);
  const s = m.songs[0];
  assert.equal(s.id, "let-it-go");
  assert.equal(s.title, "Let It Go!");
  assert.equal(s.audio, "let-it-go.m4a");
  assert.equal(s.cover, "let-it-go.webp");
  assert.equal(s.duration, 232);
  assert.equal(s.source, "https://www.youtube.com/watch?v=letitgo1");
  assert.equal(s.rank, 1, "first song takes the first tile");
  assert.equal(fs.existsSync(path.join(MUSIC, "manifest.tmp")), false, "written atomically, no litter");
  assert.deepEqual(fs.readdirSync(MUSIC).filter(n => n.startsWith(".")), [],
                   "and the staged download swept up after itself");
});

test("ffmpeg is never required: audio-only format, thumbnail written raw, no -x and no conversion", async () => {
  const seen = calls();
  assert.ok(seen.length >= 2, "one look-up and one download");
  const dl = seen[seen.length - 1];
  assert.equal(dl[dl.indexOf("-f") + 1], "ba[ext=m4a]/ba", "best audio, m4a preferred");
  assert.ok(dl.includes("--write-thumbnail"), "the cover comes down as-is");
  assert.ok(dl.includes("--no-playlist"), "a link with a list attached is still one song");
  for (const arg of seen.flat()) {
    assert.notEqual(arg, "-x", "no extract-audio: that needs ffmpeg");
    assert.notEqual(arg, "--audio-format", "no re-encode: that needs ffmpeg");
    assert.notEqual(arg, "--convert-thumbnails", "no thumbnail conversion: that needs ffmpeg");
  }
  const js = dl[dl.indexOf("--js-runtimes") + 1];
  assert.ok(js && js.startsWith("node:"), "yt-dlp is pointed at the hub's own node, unquoted");
});

test("the song reaches the shelf: it is in the generated recipe and servable with ranges", async () => {
  // The adaptation check the plan names: if the recipe drops the song, the add
  // wrote somewhere the mirror does not carry.
  let recipe = null;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${BASE}/recipes/songs.json`);
    if (r.status === 200) {
      recipe = await r.json();
      if (recipe.boards.some(b => b.buttons.some(x => x.song_id === "let-it-go"))) break;
    }
    await new Promise(r2 => setTimeout(r2, 100));
  }
  assert.ok(recipe, "the songs recipe exists once a song does");
  const tile = recipe.boards[0].buttons.find(b => b.song_id === "let-it-go");
  assert.ok(tile, "the new song has a tile");
  assert.equal(tile.audio, "music/let-it-go.m4a");
  assert.equal(tile.image, "music/let-it-go.webp");

  const a = await fetch(`${BASE}/music/let-it-go.m4a`);
  assert.equal(a.status, 200, "served from the shelf");
  assert.equal(a.headers.get("accept-ranges"), "bytes", "seekable (playback itself is not asserted: Gap 13)");
  const c = await fetch(`${BASE}/music/let-it-go.webp`);
  assert.equal(c.status, 200);
});

test("a typed name searches YouTube for one hit and takes the next free rank", async () => {
  ctl({ mode: "ok", id: "moana9", title: "How Far I'll Go", duration: 156 });
  assert.equal((await post("/music/add", { query: "how far ill go" })).status, 202);
  const last = await settled();
  assert.equal(last.ok, true, last.error || "");
  assert.equal(last.id, "how-far-ill-go");

  const look = calls().filter(a => a.includes("--dump-single-json")).pop();
  assert.equal(look[look.length - 1], "ytsearch1:how far ill go", "one hit, not a whole page of them");
  const dl = calls()[calls().length - 1];
  assert.equal(dl[dl.length - 1], "https://www.youtube.com/watch?v=moana9",
               "the download goes to the resolved page, not back through the search");

  const m = manifest();
  assert.equal(m.songs.length, 2);
  assert.equal(m.songs[1].rank, 2, "appended after the song already there");
});

test("adding the same song again replaces it in place and keeps its tile", async () => {
  ctl({ mode: "ok", id: "letitgo1", title: "Let It Go!", duration: 999 });
  assert.equal((await post("/music/add", { url: "https://www.youtube.com/watch?v=letitgo1" })).status, 202);
  assert.equal((await settled()).ok, true);

  const m = manifest();
  assert.equal(m.songs.length, 2, "replaced, not doubled");
  const s = m.songs.find(x => x.id === "let-it-go");
  assert.equal(s.rank, 1, "a re-added song keeps the place Ellie already knows");
  assert.equal(s.duration, 999, "and the entry really was rewritten");
});

test("a name that is not [a-z0-9-] is refused, and nothing is written outside music/", async () => {
  for (const slug of ["../evil", "Let It Go", "let/it/go", "", "x".repeat(65), "..", "a b"]) {
    const r = await post("/music/add", { url: "https://www.youtube.com/watch?v=abc", slug });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(slug)}`);
    assert.equal((await r.json()).error, "bad-slug");
  }
  assert.equal(fs.existsSync(path.join(INSIDE, "evil.m4a")), false);
  assert.equal(manifest().songs.length, 2, "the manifest never moved");
});

test("yt-dlp stopping non-zero surfaces a human message and leaves the manifest alone", async () => {
  for (const mode of ["fail-resolve", "fail-download"]) {
    ctl({ mode, id: "nope", title: "Nope", duration: 1 });
    assert.equal((await post("/music/add", { url: "https://www.youtube.com/watch?v=nope" })).status, 202);
    const last = await settled();
    assert.equal(last.ok, false, mode + " is reported as a failure");
    assert.ok(typeof last.error === "string" && last.error.length > 10,
              mode + " says something an operator can read: " + last.error);
    assert.ok(!/\n/.test(last.error), "one line, not a stack trace");
    assert.ok(last.message && !/ERROR:|http|--/.test(last.message),
              mode + " keeps yt-dlp's own words off the board: " + last.message);
    assert.equal(manifest().songs.length, 2, mode + " left the shelf as it was");
  }
  ctl({ mode: "no-hits" });
  assert.equal((await post("/music/add", { query: "asdfqwerzxcv" })).status, 202);
  const none = await settled();
  assert.equal(none.ok, false, "a search with no hits is a failure, not a blank song");
});

// Bug 5 (VM QA 9/5). From a datacenter IP YouTube answers with its bot check,
// and the board sheet showed the whole of it — "New ERA could not add that
// song. ERROR: [youtube] XqZsoesa55w: Sign in to confirm you're not a bot. Use
// --cookies-from-browser or --cookies for the authentication. See https://…" —
// truncated mid-word, at a family. The hub still keeps that line, because
// whoever is fixing it needs to know WHICH failure this was; what a parent
// reads is one sentence with somewhere to go.
test("yt-dlp's bot check reaches the family as one sentence, and the raw line stays for the hub", async () => {
  ctl({ mode: "fail-resolve", id: "botcheck", title: "Nope", duration: 1,
        stderr: "ERROR: [youtube] XqZsoesa55w: Sign in to confirm you're not a bot. " +
                "Use --cookies-from-browser or --cookies for the authentication. " +
                "See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp" });
  assert.equal((await post("/music/add", { url: "https://www.youtube.com/watch?v=XqZsoesa55w" })).status, 202);
  const last = await settled();
  assert.equal(last.ok, false, "the add failed");

  assert.match(last.error, /Sign in to confirm/, "the operator's copy keeps yt-dlp's own words");
  assert.equal(last.message,
    "YouTube would not let New ERA fetch that one from here. Try another link, or add the song from an MP3 in the family's music folder.",
    "and the family gets the sentence for THIS failure, not the generic one");
  assert.ok(!/http/i.test(last.message), "no address in what a family reads");
  assert.ok(!last.message.includes("--"), "no command-line flag either");
  assert.ok(!/ERROR:/.test(last.message), "and no ERROR: prefix");
  assert.equal(manifest().songs.length, 2, "and the shelf is as it was");
});

// Everything else yt-dlp can say. The map is the point: a shape nobody has
// seen before must still come out as a sentence, never as the raw text.
test("every yt-dlp failure has a family sentence, and an unknown one still says something plain", async () => {
  const cases = [
    ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader",
     "That video is not available any more. Try another link."],
    ["ERROR: [youtube] abc: The uploader has not made this video available in your country",
     "That video cannot be played in your country. Try another link."],
    ["ERROR: unable to download webpage: <urlopen error [Errno -2] Name or service not known (getaddrinfo failed)>",
     "New ERA could not reach the internet to fetch it. Check the connection and try again."],
    ["ERROR: Unsupported URL: https://example.com/not/a/video",
     "New ERA does not know how to fetch a song from that link. Paste the video's own address."],
    ["ERROR: [youtube] abc: something nobody has ever seen before",
     "New ERA could not add that song. Try again, or try another link."],
  ];
  for (const [stderr, want] of cases) {
    ctl({ mode: "fail-resolve", id: "nope", title: "Nope", duration: 1, stderr });
    assert.equal((await post("/music/add", { url: "https://www.youtube.com/watch?v=nope" })).status, 202);
    const last = await settled();
    assert.equal(last.message, want, "for: " + stderr);
    assert.match(last.error, /ERROR:/, "the raw line is still there for the hub");
  }
  assert.equal(manifest().songs.length, 2, "and none of it wrote anything");
});

// The re-add is the dangerous one: it used to delete the old audio and cover
// BEFORE the download ran, so a re-add that failed destroyed a song the family
// already had — the tile vanished (songsRecipe skips a song whose audio file is
// gone) and nothing put it back. The download now lands under a staging name
// and only replaces the song once there is really something to replace it with.
test("a re-add whose download fails leaves the song the family already had", async () => {
  const audio = path.join(MUSIC, "let-it-go.m4a");
  const before = fs.readFileSync(audio);
  ctl({ mode: "fail-download", id: "letitgo1", title: "Let It Go!", duration: 232 });
  assert.equal((await post("/music/add", { url: "https://www.youtube.com/watch?v=letitgo1" })).status, 202);
  const last = await settled();
  assert.equal(last.ok, false, "the download failed, and says so");

  assert.ok(fs.existsSync(audio), "yesterday's audio is still on the family's shelf");
  assert.deepEqual(fs.readFileSync(audio), before, "byte for byte, untouched");
  assert.ok(fs.existsSync(path.join(MUSIC, "let-it-go.webp")), "and so is its cover");
  const s = manifest().songs.find(x => x.id === "let-it-go");
  assert.equal(s.audio, "let-it-go.m4a", "the manifest still points at a file that exists");
  assert.deepEqual(fs.readdirSync(MUSIC).filter(n => n.startsWith(".")), [],
                   "and the failed download left no half-song behind in the family's Drive folder");
});

// One unreadable manifest used to erase the whole library: every read error was
// swallowed as "no songs yet", and the next add wrote the file back with one
// song in it. A half-synced file (Google Drive for Desktop) or a Windows
// EBUSY/EPERM is exactly that shape.
test("a song list New ERA cannot read is refused, never rewritten", async () => {
  const file = path.join(MUSIC, "manifest.json");
  const good = fs.readFileSync(file);
  const half = '{"schemaVersion":1,"songs":[{"id":"let-it-go"';
  fs.writeFileSync(file, half);
  ctl({ mode: "ok", id: "new1", title: "A New Song", duration: 10 });

  const r = await post("/music/add", { url: "https://www.youtube.com/watch?v=new1" });
  assert.equal(r.status, 409, "a refusal, not a 202 that eats the library");
  const j = await r.json();
  assert.equal(j.error, "manifest-unreadable");
  assert.ok(typeof j.message === "string" && j.message.length > 10, "in words a parent can act on");

  const o = await post("/music/order", { ids: ["let-it-go", "how-far-ill-go"] });
  assert.equal(o.status, 409, "and arranging is refused the same way");
  assert.equal((await o.json()).error, "manifest-unreadable");

  assert.equal(fs.readFileSync(file, "utf8"), half, "the half-written file is left exactly as it was");
  fs.writeFileSync(file, good);
});

// --------------------------------------------------- ⇅ Arrange (plan T4.3)
// POST /music/order is the whole running order in one shot: the strip hands
// back every id, the hub renumbers `rank` from 1 and touches nothing else.
// A song's tile is where Ellie learned it is, so a half-written order (one id
// missing, one id it does not have) must change nothing at all.

test("⇅ Arrange rewrites every rank and nothing else, and the board sees the new order", async () => {
  ctl({ mode: "ok", id: "sea7", title: "Under the Sea", duration: 187 });
  assert.equal((await post("/music/add", { url: "https://www.youtube.com/watch?v=sea7" })).status, 202);
  assert.equal((await settled()).ok, true);

  const before = manifest();
  assert.deepEqual(before.songs.map(s => [s.id, s.rank]),
                   [["let-it-go", 1], ["how-far-ill-go", 2], ["under-the-sea", 3]],
                   "three songs in the order they were added");
  const etagBefore = (await fetch(`${BASE}/recipes/songs.json`)).headers.get("etag");
  assert.ok(etagBefore, "the shelf is serving a songs recipe");

  const r = await post("/music/order", { ids: ["under-the-sea", "let-it-go", "how-far-ill-go"] });
  assert.equal(r.status, 200, "the order is written while the sheet waits: it is one small file");
  assert.deepEqual(await r.json(), { ok: true, songs: 3, mirrored: true },
                   "and the shelf took the new order, so the tiles really have moved");

  const after = manifest();
  assert.deepEqual(after.songs.map(s => [s.id, s.rank]),
                   [["under-the-sea", 1], ["let-it-go", 2], ["how-far-ill-go", 3]],
                   "rank 1..n in exactly the order the strip sent");
  assert.equal(after.schemaVersion, 1);
  const strip = (m) => Object.fromEntries(m.songs.map(({ rank, ...rest }) => [rest.id, rest]));
  assert.deepEqual(strip(after), strip(before),
                   "titles, audio, covers, durations and sources are untouched");
  assert.equal(fs.existsSync(path.join(MUSIC, "manifest.tmp")), false, "written atomically, no litter");

  const recipe = await fetch(`${BASE}/recipes/songs.json`);
  assert.notEqual(recipe.headers.get("etag"), etagBefore,
                  "the ETag moved, so a board holding a 304 cache refetches");
  const grid = (await recipe.json()).boards[0];
  assert.deepEqual(grid.buttons.filter(b => b.type === "song").map(b => b.song_id),
                   ["under-the-sea", "let-it-go", "how-far-ill-go"],
                   "the shelf's tiles are in the new order, so the write reached the Drive folder");
});

// The mirror is what carries a new order from the family's Drive folder to
// this device's shelf, which is the board the tiles are drawn from. A mirror
// that failed used to be swallowed, so the strip said "The songs are in their
// new order" over a board that had not moved at all.
test("an order the shelf did not take says so instead of claiming the tiles moved", async () => {
  const shelf = path.join(DATA, "music", "manifest.json");
  fs.rmSync(shelf, { force: true });
  fs.mkdirSync(shelf, { recursive: true });   // a landing spot the copy cannot use
  try {
    const r = await post("/music/order", { ids: ["let-it-go", "how-far-ill-go", "under-the-sea"] });
    assert.equal(r.status, 200, "the manifest in the family's folder really was rewritten");
    assert.deepEqual(await r.json(), { ok: true, songs: 3, mirrored: false },
                     "but the shelf did not take it, and the strip is told so it can say so");
  } finally { fs.rmSync(shelf, { recursive: true, force: true }); }
});

test("an order that does not name every song is refused, and the manifest never moves", async () => {
  const before = fs.readFileSync(path.join(MUSIC, "manifest.json"));
  const cases = [
    [{ ids: ["under-the-sea"] }, "incomplete"],
    [{ ids: ["under-the-sea", "let-it-go"] }, "incomplete"],
    [{ ids: ["under-the-sea", "let-it-go", "how-far-ill-go", "nope"] }, "unknown-song"],
    [{ ids: ["under-the-sea", "let-it-go", "under-the-sea"] }, "bad-ids"],
    [{ ids: ["../evil", "let-it-go", "how-far-ill-go"] }, "bad-ids"],
    [{ ids: [] }, "incomplete"],
    [{}, "bad-ids"],
    [{ ids: "let-it-go" }, "bad-ids"],
    [{ ids: [1, 2, 3] }, "bad-ids"],
  ];
  for (const [body, error] of cases) {
    const r = await post("/music/order", body);
    assert.equal(r.status, 400, `refused: ${JSON.stringify(body)}`);
    const j = await r.json();
    assert.equal(j.error, error, `refused: ${JSON.stringify(body)}`);
    assert.ok(typeof j.message === "string" && j.message.length > 10,
              "with something the sheet can show a parent");
  }
  assert.deepEqual(fs.readFileSync(path.join(MUSIC, "manifest.json")), before,
                   "not one byte of the manifest changed");
});

test("with no Drive folder chosen there is nothing to arrange, and it says so", async () => {
  await stopHub();
  await startHub({ ERA_YTDLP: BIN });   // fresh <DATA>, no folder picked yet

  const r = await post("/music/order", { ids: ["let-it-go"] });
  assert.equal(r.status, 409, "a refusal the sheet can render, not a crash");
  assert.equal((await r.json()).error, "needs-local-drive");
});
