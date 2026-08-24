// music.test.mjs — songs-board serving (Songs Board spec 8/24).
// Spawns the REAL server.js on a TEST port with a throwaway ERA_DATA_DIR and a
// SYNTHETIC music overlay (tiny PCM WAVs + 1x1 JPEG covers — never her real
// songs). Proves: /music/ jail (range streaming, immutable media, no-cache
// manifest, escape 403, bad ext 404), the GENERATED /recipes/songs.json
// (rank order, page layout + frozen anchors, pagination, ETag/304/HEAD),
// POST /music-event -> family pool, and the degraded law (no music dir ->
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
let child;

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

// 8 synthetic songs -> page 1 holds ranks 1-7, page 2 holds rank 8.
const N = 8;
before(async () => {
  const music = path.join(TMP, "music");
  fs.mkdirSync(music, { recursive: true });
  const songs = [];
  for (let i = 1; i <= N; i++) {
    fs.writeFileSync(path.join(music, `song-${i}.wav`), WAV);
    fs.writeFileSync(path.join(music, `song-${i}.jpg`), JPEG);
    songs.push({ id: `song-${i}`, title: `Song ${i}`, audio: `song-${i}.wav`,
                 cover: `song-${i}.jpg`, duration: 30 + i,
                 source: "https://example.invalid/" + i, rank: i });
  }
  // manifest written out of rank order on purpose: server must sort by rank
  songs.reverse();
  fs.writeFileSync(path.join(music, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, songs }, null, 2));
  fs.writeFileSync(path.join(TMP, "secret.json"), '{"secret":true}');

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); });

function btnAt(board, row, col) {
  return board.buttons.find(b => b.row === row && b.col === col) || null;
}

test("GET /recipes/songs.json: generated, rank-ordered, page-1 layout with frozen anchors", async () => {
  const r = await fetch(`${BASE}/recipes/songs.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.ok(r.headers.get("etag"), "has an ETag");
  const recipe = await r.json();
  assert.equal(recipe.root, "songs");
  assert.equal(recipe.boards.length, 2, "8 songs -> 2 pages");
  const p1 = recipe.boards[0];
  assert.equal(p1.id, "songs");
  assert.equal(p1.rows, 3); assert.equal(p1.columns, 4);

  const stop = btnAt(p1, 1, 1);
  assert.equal(stop.type, "stop", "Stop tile top-left");
  const more = btnAt(p1, 3, 1);
  assert.equal(more.type, "more", "More bottom-left when a next page exists");
  assert.equal(more.load, "songs-2");
  const exit = btnAt(p1, 3, 4);
  assert.equal(exit.type, "exit", "exit anchor bottom-right");

  // center rest cells stay unpinned (renderer fills them black)
  assert.equal(btnAt(p1, 2, 2), null);
  assert.equal(btnAt(p1, 2, 3), null);

  // ranks 1-7 in reading order across the song cells
  const cells = [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3]];
  cells.forEach(([row, col], i) => {
    const b = btnAt(p1, row, col);
    assert.equal(b.type, "song", `song tile at (${row},${col})`);
    assert.equal(b.song_id, `song-${i + 1}`, `rank ${i + 1} at (${row},${col})`);
    assert.equal(b.audio, `music/song-${i + 1}.wav`);
    assert.equal(b.image, `music/song-${i + 1}.jpg`);
    assert.equal(b.say, `Song ${i + 1}`);
    assert.ok(Number.isFinite(b.v) && b.v > 0, "song carries a cache version");
  });

  // every button is pinned (pin-everything law for hand-built boards)
  assert.ok(p1.buttons.every(b => b.row >= 1 && b.col >= 1), "all pinned");

  const p2 = recipe.boards[1];
  assert.equal(p2.id, "songs-2");
  const back = btnAt(p2, 1, 1);
  assert.equal(back.type, "back", "page 2 back anchor top-left");
  assert.equal(back.load, "songs");
  assert.equal(btnAt(p2, 1, 2).song_id, "song-8", "rank 8 opens page 2");
  assert.equal(btnAt(p2, 3, 4).type, "exit");
  assert.equal(btnAt(p2, 3, 1), null, "no More on the last page");
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

test("POST /music-event: valid play/stop/end -> 204 + pool append; junk -> 400", async () => {
  for (const action of ["play", "stop", "end"]) {
    const r = await fetch(`${BASE}/music-event`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId: "song-1", action }),
    });
    assert.equal(r.status, 204, `${action} accepted`);
  }
  for (const body of [{}, { songId: "song-1", action: "shuffle" },
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
  for (const k of ["music-play", "music-stop", "music-end"])
    assert.ok(kinds.includes(k), `pool has ${k}`);
  assert.equal(lines.find(l => l.kind === "music-play").songId, "song-1");
});

test("LAW: no music dir -> songs.json 404 and the server stays alive", async () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-nomusic-"));
  const PORT2 = 8403;
  const c2 = spawn("node", ["server.js", String(PORT2)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP2, ERA_BIND: "127.0.0.1" },
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
