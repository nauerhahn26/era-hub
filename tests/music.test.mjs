// music.test.mjs — songs-board serving (Songs Board spec 8/24).
// Spawns the REAL server.js on a TEST port with a throwaway ERA_DATA_DIR and a
// SYNTHETIC music overlay (tiny PCM WAVs + 1x1 JPEG covers — never her real
// songs). Proves: /music/ jail (range streaming, immutable media, no-cache
// manifest, escape 403, bad ext 404), the GENERATED /recipes/songs.json
// (spec 2026-10-31: a rail of sections beside a 3x4 grid, usage order from
// the pick scores, pagination, ETag/304/HEAD with an order part), POST
// /music-event -> family pool, and the degraded law (no music dir ->
// 404 recipe with the server alive).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
    req.on("error", reject);
    req.end();
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");

const PORT = 8402;   // never live 8377; 8392/8398 books, 8393/8394 pool
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-music-"));
let child, symbolProvider;
let symbolEnv;
const symbolRequests = [];
const SYMBOL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

function makeWav(samples) {
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), 44 + i * 2);
  return buf;
}
const WAV = makeWav(800);   // 1644 bytes

// 12 synthetic songs -> page 1 holds ranks 1-9 (v3 corners), page 2 ranks 10-12.
const N = 12;
before(async () => {
  const music = path.join(TMP, "music");
  fs.mkdirSync(music, { recursive: true });
  const songs = [];
  for (let i = 1; i <= N; i++) {
    fs.writeFileSync(path.join(music, `song-${i}.wav`), WAV);
    fs.writeFileSync(path.join(music, `song-${i}.jpg`), JPEG);
    songs.push({ id: `song-${i}`, title: `Song ${i}`, audio: `song-${i}.wav`,
                 cover: `song-${i}.jpg`, duration: 30 + i,
                 source: "https://example.invalid/" + i, rank: i,
                 // song-11 and song-12 have no addedAt: they count as older
                 // than every dated song, the higher rank newer — whatever
                 // their audio files' times say (set below, opposite way round)
                 ...(i < N - 1 ? { addedAt: `2026-09-${String(i).padStart(2, "0")}T12:00:00.000Z` } : {}),
                 ...(i <= 3 ? { category: "top-hits" } : i === 4 ? { category: "disney" } : {}) });
  }
  songs[5].category = "jazz";   // not a category the board knows: no section
  // the mirror's copy time differs per device: make song-11's audio the newer file
  fs.utimesSync(path.join(music, "song-12.wav"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  fs.utimesSync(path.join(music, "song-11.wav"), new Date("2026-10-30T00:00:00Z"), new Date("2026-10-30T00:00:00Z"));
  const pictures = Array.from({ length: 10 }, (_, i) => `song-1-frame-0123456789abcdef-${String(i).padStart(2, "0")}.jpg`);
  for (const name of pictures) fs.writeFileSync(path.join(music, name), JPEG);
  songs[0].pictures = pictures;
  songs[1].pictures = ["../secret.json"];
  // manifest written out of rank order on purpose: server must sort by rank
  songs.reverse();
  fs.writeFileSync(path.join(music, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, songs }, null, 2));
  fs.writeFileSync(path.join(TMP, "secret.json"), '{"secret":true}');

  symbolProvider = http.createServer((req, res) => {
    symbolRequests.push(req.url);
    if (req.url === "/images/8289/8289.png") {
      res.writeHead(200, { "Content-Type": "image/png" }).end(SYMBOL_PNG);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    symbolProvider.once("error", reject);
    symbolProvider.listen(0, "127.0.0.1", resolve);
  });
  const symbolOrigin = `http://127.0.0.1:${symbolProvider.address().port}`;
  symbolEnv = { ERA_SYMBOL_SEARCH_URL: symbolOrigin + "/search/",
    ERA_SYMBOL_IMAGE_URL: symbolOrigin + "/images/{id}/{id}.png" };

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...symbolEnv, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await stopped;
  }
  if (symbolProvider?.listening) {
    symbolProvider.closeAllConnections();
    await new Promise(resolve => symbolProvider.close(resolve));
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

function btnAt(board, row, col) {
  return board.buttons.find(b => b.row === row && b.col === col) || null;
}

const CELLS = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];
const RAIL = ["Back", "Favorites", "New", "Top hits", "Disney", "All"];
const songsAt = (board) => CELLS.map(([r, c]) => btnAt(board, r, c)).filter(b => b && b.type === "song").map(b => b.song_id);
const recipeNow = async () => (await fetch(`${BASE}/recipes/songs.json`)).json();
const boardOf = (recipe, id) => recipe.boards.find(b => b.id === id);
// with nothing played every score is 0, so every score-ordered section is in
// added order: the dated songs newest first (10..1), then the undated ones by
// rank, higher first (12, 11) — never by their audio files' times
const BY_ADDED = [...Array.from({ length: N - 2 }, (_, i) => `song-${N - 2 - i}`), "song-12", "song-11"];

test("GET /recipes/songs.json: a rail of sections beside a 3x4 grid, nine songs a page", async () => {
  const r = await fetch(`${BASE}/recipes/songs.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.ok(r.headers.get("etag"), "has an ETag");
  const recipe = await r.json();
  assert.equal(recipe.root, "songs-all", "nothing played yet: Music opens on All");
  const ids = recipe.boards.map(b => b.id);
  for (const id of ["songs-fav", "songs-new", "songs-new-2", "songs-top-hits", "songs-disney", "songs-all", "songs-all-2"])
    assert.ok(ids.includes(id), id + " exists");
  assert.ok(!ids.includes("songs-new-3") && !ids.includes("songs-top-hits-2"), "no empty extra pages");
  assert.equal(recipe.boards.length, 7 + N, "seven section pages + one page per song");

  const p1 = boardOf(recipe, "songs-all");
  assert.equal(p1.rows, 3); assert.equal(p1.columns, 4);
  assert.deepEqual(p1.rail.map(b => b.label), RAIL, "rail top to bottom");
  const [back, ...sections] = p1.rail;
  assert.equal(back.type, "back");
  assert.equal(back.disabled, true, "Back is dimmed on page 1");
  assert.equal(back.load, undefined, "…and goes nowhere");
  assert.deepEqual(sections.map(b => b.load), ["songs-fav", "songs-new", "songs-top-hits", "songs-disney", "songs-all"],
    "a section opens its page 1");
  assert.deepEqual(sections.filter(b => b.current).map(b => b.label), ["All"], "the current section is lit");
  assert.ok(sections.every(b => b.type === "category"));

  assert.ok(!p1.buttons.some(b => b.type === "stop" || b.type === "exit" || b.type === "back"),
    "the grid holds songs and More only");
  assert.equal(btnAt(p1, 2, 2), null, "centre stays black");
  assert.equal(btnAt(p1, 2, 3), null, "centre stays black");
  const more = btnAt(p1, 3, 1);
  assert.equal(more.type, "control", "More matches the outfit board (teal control)");
  assert.equal(more.symbol, "more");
  assert.equal(more.load, "songs-all-2");
  assert.deepEqual(songsAt(p1), BY_ADDED.slice(0, 9), "nine songs in the spec's cell order");
  const first = btnAt(p1, 1, 1);
  assert.equal(first.load, `song-${first.song_id}`, "a song tile opens its page");
  assert.equal(first.audio, `music/${first.song_id}.wav`);
  assert.equal(first.image, `music/${first.song_id}.jpg`);
  assert.equal(first.clip_ms, 40000, "default 40s clip");
  assert.ok(Number.isFinite(first.v) && first.v > 0, "song carries a cache version");

  const p2 = boardOf(recipe, "songs-all-2");
  assert.equal(p2.rail[0].load, "songs-all", "Back is one page back in the same section");
  assert.ok(!p2.rail[0].disabled);
  assert.equal(btnAt(p2, 3, 1).load, "songs-all", "More on the last page loops to page 1");
  assert.deepEqual(songsAt(p2), BY_ADDED.slice(9), "the rest of the section");
  assert.equal(btnAt(p2, 1, 4), null, "a short page leaves its unfilled cells black");
});

test("sections: categories, New by added time, an empty section is one black page", async () => {
  const recipe = await recipeNow();
  assert.deepEqual(songsAt(boardOf(recipe, "songs-top-hits")), ["song-3", "song-2", "song-1"]);
  assert.deepEqual(songsAt(boardOf(recipe, "songs-disney")), ["song-4"]);
  assert.deepEqual(songsAt(boardOf(recipe, "songs-new")), BY_ADDED.slice(0, 9), "newest added first");
  const fav = boardOf(recipe, "songs-fav");
  assert.deepEqual(fav.buttons, [], "nothing played: Favorites is all black");
  assert.equal(btnAt(fav, 3, 1), null, "one page: no More");
  assert.deepEqual(fav.rail.filter(b => b.current).map(b => b.label), ["Favorites"]);
  for (const id of ["songs-top-hits", "songs-disney"])
    assert.equal(btnAt(boardOf(recipe, id), 3, 1), null, id + " has one page and no More");
  // song-6's unknown category puts it in no category section
  for (const id of ["songs-top-hits", "songs-disney"])
    assert.ok(!songsAt(boardOf(recipe, id)).includes("song-6"));
});

test("picture arrival invalidates the recipe even when the manifest did not change", async () => {
  const before = await fetch(`${BASE}/recipes/songs.json`);
  const etag = before.headers.get("etag");
  const picture = path.join(TMP, "music", "song-1-frame-0123456789abcdef-00.jpg");
  fs.renameSync(picture, picture + ".held");
  try {
    const partial = await fetch(`${BASE}/recipes/songs.json`, { headers: { "If-None-Match": etag } });
    assert.equal(partial.status, 200, "availability changed without touching the manifest");
    const recipe = await partial.json();
    assert.deepEqual(recipe.boards.find(b => b.id === "song-song-1").buttons[0].pictures, []);
    const partialTag = partial.headers.get("etag");
    fs.renameSync(picture + ".held", picture);
    const complete = await fetch(`${BASE}/recipes/songs.json`, { headers: { "If-None-Match": partialTag } });
    assert.equal(complete.status, 200, "late frame arrival becomes visible");
    const ready = await complete.json();
    assert.equal(ready.boards.find(b => b.id === "song-song-1").buttons[0].pictures.length, 10);
  } finally { if (fs.existsSync(picture + ".held")) fs.renameSync(picture + ".held", picture); }
});

test("song pages: hero spans three quarters; controls fill the far-right column", async () => {
  const recipe = await recipeNow();
  const sp = recipe.boards.find(b => b.id === "song-song-1");
  assert.ok(sp, "song page exists");
  assert.equal(sp.rows, 3); assert.equal(sp.columns, 4);
  assert.equal(sp.rail, undefined, "the song page has no rail");
  const hero = btnAt(sp, 1, 1);
  assert.equal(hero.type, "song");
  assert.equal(hero.row_span, 3); assert.equal(hero.col_span, 3);
  assert.equal(hero.load, undefined, "hero replays; it is not a door");
  assert.equal(hero.clip_ms, 40000);
  assert.equal(hero.category, "top-hits", "the parent sheet can show the song's section");
  assert.equal(hero.pictures.length, 10, "complete set of video stills included");
  assert.ok(hero.pictures.every(p => p.startsWith("music/song-1-frame-")));
  assert.equal(btnAt(recipe.boards.find(b => b.id === "song-song-6"), 1, 1).category, null, "an unknown category is none");
  const invalid = recipe.boards.find(b => b.id === "song-song-2");
  assert.deepEqual(btnAt(invalid, 1, 1).pictures, [], "invalid or incomplete sets stay off the child page");
  const back = btnAt(sp, 1, 4);
  assert.equal(back.type, "back"); assert.equal(back.glyph, "←");
  assert.equal(back.label, "Back", "arrow AND the word (dad r3)");
  assert.equal(back.return, true, "Back returns to the section page she came from");
  assert.equal(back.load, "songs-all-2", "…or, opened directly, to its page in All (song-1 is on All's page 2)");
  const stop = btnAt(sp, 2, 4);
  assert.equal(stop.type, "stop");
  assert.equal(stop.symbol, "8289", "Stop wears the exact-id STOP-sign pictogram");
  const full = btnAt(sp, 3, 4);
  assert.equal(full.type, "full");
  assert.equal(full.symbol, "music", "Full song wears the sheet-music pictogram");
  assert.equal(full.song_id, "song-1");
  assert.ok(full.audio && full.v, "Full song can start playback on its own");
  assert.equal(sp.buttons.reduce((n, b) => n + (b.row_span || 1) * (b.col_span || 1), 0), 12, "every cell covered");
  assert.equal(btnAt(recipe.boards.find(b => b.id === "song-song-10"), 1, 4).load, "songs-all");
});

test("musicVolCap: /settings round-trip with clamping (default 100)", async () => {
  const g0 = await (await fetch(`${BASE}/settings`)).json();
  assert.equal(g0.musicVolCap, 100, "default full volume");
  const post = (v) => fetch(`${BASE}/settings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ musicVolCap: v }),
  });
  assert.equal((await post(12)).status, 204);
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).musicVolCap, 12, "stored");
  await post(500);
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).musicVolCap, 100, "clamped high");
  await post(0);
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).musicVolCap, 1, "clamped low");
});

test("GET /symbol/<numeric-id> downloads exact image bytes without search, then uses the cache", async () => {
  const cacheFile = path.join(TMP, "symbols-cache", "8289.png");
  assert.equal(fs.existsSync(cacheFile), false, "the numeric symbol starts uncached");
  const r = await fetch(`${BASE}/symbol/8289`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-symbol-cache"), "miss");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), SYMBOL_PNG, "the exact numeric image bytes are served");
  assert.deepEqual(fs.readFileSync(cacheFile), SYMBOL_PNG, "the image bytes reached the disk cache");
  assert.deepEqual(symbolRequests.filter(url => url.includes("8289")), ["/images/8289/8289.png"],
    "a numeric ID downloads its exact image path without a search lookup");
  const cached = await fetch(`${BASE}/symbol/8289`);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("x-symbol-cache"), "hit");
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), SYMBOL_PNG);
  assert.deepEqual(symbolRequests.filter(url => url.includes("8289")), ["/images/8289/8289.png"],
    "the second request makes no provider call");
});

test("songs.json ETag: 304 on If-None-Match, HEAD supported, CORS open", async () => {
  const r1 = await fetch(`${BASE}/recipes/songs.json`);
  const etag = r1.headers.get("etag");
  assert.equal(r1.headers.get("access-control-allow-origin"), "*");
  const r2 = await fetch(`${BASE}/recipes/songs.json`, { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 304);
  const rh = await fetch(`${BASE}/recipes/songs.json`, { method: "HEAD" });
  assert.equal(rh.status, 200);
  assert.equal(rh.headers.get("etag"), etag);
  assert.equal((await rh.arrayBuffer()).byteLength, 0, "HEAD has no body");
});

test("songs.json ETag changes when the manifest changes", async () => {
  const r1 = await fetch(`${BASE}/recipes/songs.json`);
  const etag1 = r1.headers.get("etag");
  const mp = path.join(TMP, "music", "manifest.json");
  await new Promise(r => setTimeout(r, 20));   // ensure a distinct mtime
  fs.utimesSync(mp, new Date(), new Date());
  const r2 = await fetch(`${BASE}/recipes/songs.json`);
  assert.notEqual(r2.headers.get("etag"), etag1, "manifest mtime moves the ETag");
});

const event = (body) => fetch(`${BASE}/music-event`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("plays reorder the sections on the next build, and only the ETag's order part moves", async () => {
  const r1 = await fetch(`${BASE}/recipes/songs.json`);
  const etag1 = r1.headers.get("etag");
  assert.match(etag1, /~o[0-9a-f]+"$/, "the ETag ends in an order part the board can tell apart");
  // song-5: one partial pick. song-3: a pick made full by Full song. song-2:
  // a pick that ended naturally while capped. song-7: the clip ran out, then
  // Stop — partial.
  for (const b of [{ songId: "song-5", action: "play" }, { songId: "song-5", action: "clip" },
                   { songId: "song-3", action: "play" }, { songId: "song-3", action: "full" },
                   { songId: "song-2", action: "play" }, { songId: "song-2", action: "done" },
                   { songId: "song-7", action: "play" }, { songId: "song-7", action: "clip" },
                   { songId: "song-7", action: "stop" }])
    assert.equal((await event(b)).status, 204);
  const r2 = await fetch(`${BASE}/recipes/songs.json`, { headers: { "If-None-Match": etag1 } });
  assert.equal(r2.status, 200, "a reopened board gets the new order");
  const etag2 = r2.headers.get("etag");
  assert.equal(etag2.replace(/~o[0-9a-f]+"$/, ""), etag1.replace(/~o[0-9a-f]+"$/, ""),
    "the content part is unchanged: a board on screen does not reload for a score");
  assert.notEqual(etag2, etag1);
  const recipe = await r2.json();
  assert.equal(recipe.root, "songs-fav", "once she has favorites, Music opens on them");
  // scores 3,3,1,1: ties newest added first (song-3 09-03 before song-2 09-02; song-7 before song-5)
  assert.deepEqual(songsAt(boardOf(recipe, "songs-fav")), ["song-3", "song-2", "song-7", "song-5"]);
  assert.deepEqual(songsAt(boardOf(recipe, "songs-all")).slice(0, 5), ["song-3", "song-2", "song-7", "song-5", "song-10"]);
  assert.deepEqual(songsAt(boardOf(recipe, "songs-top-hits")), ["song-3", "song-2", "song-1"]);
  assert.deepEqual(songsAt(boardOf(recipe, "songs-new")), BY_ADDED.slice(0, 9), "New never reorders by score");
  const r3 = await fetch(`${BASE}/recipes/songs.json`, { headers: { "If-None-Match": etag2 } });
  assert.equal(r3.status, 304, "nothing moved since: 304");
});

test("Full song from silence is a full pick of its own", async () => {
  const before = songsAt(boardOf(await recipeNow(), "songs-fav"));
  assert.equal((await event({ songId: "song-9", action: "full", fresh: true })).status, 204);
  const after = songsAt(boardOf(await recipeNow(), "songs-fav"));
  assert.notDeepEqual(after, before);
  assert.deepEqual(after.slice(0, 3), ["song-9", "song-3", "song-2"], "score 3, newest added of the three");
});

test("/music media: Accept-Ranges + immutable + exact bytes; Range 206/416", async () => {
  const full = await fetch(`${BASE}/music/song-1.wav`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("cache-control"), "max-age=86400, immutable");
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(WAV), "bytes intact");

  const part = await fetch(`${BASE}/music/song-1.wav`, { headers: { Range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${WAV.length}`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(WAV.subarray(10, 20)));

  const bad = await fetch(`${BASE}/music/song-1.wav`, { headers: { Range: `bytes=${WAV.length}-` } });
  assert.equal(bad.status, 416);
});

test("/music covers 200 immutable; manifest.json no-cache", async () => {
  const c = await fetch(`${BASE}/music/song-1.jpg`);
  assert.equal(c.status, 200);
  assert.equal(c.headers.get("content-type"), "image/jpeg");
  const m = await fetch(`${BASE}/music/manifest.json`);
  assert.equal(m.status, 200);
  assert.equal(m.headers.get("cache-control"), "no-cache");
});

test("/music jail: escapes 403 with no leak; disallowed ext 404", async () => {
  for (const p of ["/music/../secret.json", "/music/%2e%2e/secret.json"]) {
    const r = await rawGet(PORT, p);
    assert.equal(r.status, 403, `escape blocked for ${p}`);
    assert.ok(!r.body.includes("secret"), `no leak for ${p}`);
  }
  const r = await fetch(`${BASE}/music/song-1.txt`);
  assert.equal(r.status, 404);
});

test("POST /music-event: valid play/stop/end/full/clip/done -> 204 + pool append; junk -> 400", async () => {
  for (const action of ["play", "stop", "end", "full", "clip", "done"]) {
    const r = await fetch(`${BASE}/music-event`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId: "song-1", action }),
    });
    assert.equal(r.status, 204, `${action} accepted`);
  }
  for (const body of [{}, { songId: "song-1", action: "shuffle" }, { songId: "song-1", action: "full", fresh: "yes" },
                      { songId: "../evil", action: "play" }, { action: "play" }]) {
    const r = await fetch(`${BASE}/music-event`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, `rejected: ${JSON.stringify(body)}`);
  }
  const day = new Date().toISOString().slice(0, 10);
  const poolFile = path.join(TMP, "pool", "events", "test-dev", day + ".jsonl");
  const lines = fs.readFileSync(poolFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const kinds = lines.map(l => l.kind);
  for (const k of ["music-play", "music-stop", "music-end", "music-full", "music-clip", "music-done"])
    assert.ok(kinds.includes(k), `pool has ${k}`);
  assert.equal(lines.find(l => l.kind === "music-play").songId, "song-5");
  assert.equal(lines.find(l => l.kind === "music-full" && l.fresh === true).songId, "song-9",
    "a Full song from silence keeps its fresh mark in the pool");
});

test("LAW: no music dir -> songs.json 404 and the server stays alive", async () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-nomusic-"));
  const PORT2 = 8403;
  const c2 = spawn("node", ["server.js", String(PORT2)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...symbolEnv, ERA_DATA_DIR: TMP2, ERA_BIND: "127.0.0.1" },
  });
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://127.0.0.1:${PORT2}/settings`); up = true; break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(up, "server boots without a music dir");
    const r = await fetch(`http://127.0.0.1:${PORT2}/recipes/songs.json`);
    assert.equal(r.status, 404, "no manifest -> honest 404 (board keeps last-good)");
    const s = await fetch(`http://127.0.0.1:${PORT2}/settings`);
    assert.equal(s.status, 200, "server alive after the degraded recipe");
  } finally { c2.kill("SIGKILL"); }
});
