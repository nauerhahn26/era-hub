// books.test.mjs — book-package serving (era-book-reader M3, spec Piece 2).
// Spawns the REAL server.js on a TEST port with a throwaway ERA_DATA_DIR and a
// SYNTHETIC fixture package ("Luna the Fox": hand-crafted 1x1 JPEG + tiny PCM
// WAV — never real book content). Proves: index lists complete packages only,
// manifest/media caching headers, HTTP Range (206 byte math, 416), jail escape
// 403, and the degraded law (missing books dir -> [] with the server alive).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

// fetch() (WHATWG URL) normalizes ../ AND %2e%2e into dot segments client-side,
// so jail-escape attempts must go out as a RAW request path.
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

const PORT = 8392; // never the live port (8393/8394 pool, 8395/8396 seen held by stale scratch hubs)
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-books-"));
let child;

// Minimal valid 1x1 JPEG (hand-crafted synthetic bytes, no image lib needed).
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

// Small valid PCM WAV: 44-byte RIFF header + 16-bit mono sine samples.
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
const WAV = makeWav(1000);   // 2044 bytes

before(async () => {
  // fixture package: media first, manifest LAST (the completeness marker)
  const book = path.join(TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
  fs.writeFileSync(path.join(book, "pages", "001.jpg"), JPEG);
  fs.writeFileSync(path.join(book, "pages", "002.jpg"), JPEG);
  fs.writeFileSync(path.join(book, "audio", "001.wav"), WAV);
  fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    exportedAt: "2026-08-24T00:00:00Z",
    narration: { provider: "synthetic", model: "fixture", voice: "none" },
    cover: "cover.jpg",
    pages: [
      { index: 0, image: "pages/001.jpg", text: "Luna naps.", audio: "audio/001.wav",
        words: [{ word: "Luna", start: 0.0, end: 0.4 }, { word: "naps.", start: 0.4, end: 0.9 }] },
      { index: 1, image: "pages/002.jpg", text: "", audio: null },
    ],
  }, null, 2));
  // an incomplete package (mid-export: media present, NO manifest) — must be skipped
  const partial = path.join(TMP, "books", "half-exported");
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, "cover.jpg"), JPEG);
  // an unparseable manifest — must also be skipped silently
  const broken = path.join(TMP, "books", "broken-manifest");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "manifest.json"), "{not json");
  // a jail-escape target OUTSIDE the books dir
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

test("GET /books/index.json lists the complete package ONLY, spec shape, no-cache", async () => {
  const r = await fetch(`${BASE}/books/index.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const idx = await r.json();
  assert.equal(idx.length, 1, "manifest-less + unparseable dirs are excluded");
  assert.deepEqual(idx[0], {
    slug: "luna-the-fox", title: "Luna the Fox",
    cover: "/books/luna-the-fox/cover.jpg", pages: 2, hasVideo: false,
    authored: false,   // manifest `authored: true` passes through (coral-rim shelf card)
  });
});

test("manifest.json serves 200 with no-cache", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/manifest.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const m = await r.json();
  assert.equal(m.title, "Luna the Fox");
  assert.equal(m.pages.length, 2);
});

test("cover image: full 200, immutable cache, exact bytes", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/cover.jpg`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("cache-control"), "max-age=86400, immutable");
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.length, JPEG.length);
  assert.ok(body.equals(JPEG), "image bytes intact");
});

test("media full 200: Accept-Ranges, Content-Length, immutable, exact bytes", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/audio/001.wav`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(r.headers.get("cache-control"), "max-age=86400, immutable");
  assert.equal(parseInt(r.headers.get("content-length"), 10), WAV.length);
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.equals(WAV), "full WAV bytes intact");
});

test("Range bytes=a-b: 206 with correct Content-Range math and the exact slice", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/audio/001.wav`,
    { headers: { Range: "bytes=10-19" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 10-19/${WAV.length}`);
  assert.equal(parseInt(r.headers.get("content-length"), 10), 10);
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.equals(WAV.subarray(10, 20)), "exactly bytes 10..19");
});

test("Range bytes=a- (open end): 206 to EOF", async () => {
  const start = WAV.length - 7;
  const r = await fetch(`${BASE}/books/luna-the-fox/audio/001.wav`,
    { headers: { Range: `bytes=${start}-` } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes ${start}-${WAV.length - 1}/${WAV.length}`);
  assert.equal(parseInt(r.headers.get("content-length"), 10), 7);
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.equals(WAV.subarray(start)), "tail bytes intact");
});

test("Range bytes=-N (suffix): 206 with the last N bytes", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/audio/001.wav`,
    { headers: { Range: "bytes=-5" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"),
    `bytes ${WAV.length - 5}-${WAV.length - 1}/${WAV.length}`);
  assert.equal(parseInt(r.headers.get("content-length"), 10), 5);
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.equals(WAV.subarray(WAV.length - 5)));
});

test("Range end clamped to EOF when past it", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/audio/001.wav`,
    { headers: { Range: `bytes=0-${WAV.length + 500}` } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 0-${WAV.length - 1}/${WAV.length}`);
  assert.equal(parseInt(r.headers.get("content-length"), 10), WAV.length);
});

test("unsatisfiable Range: 416 with Content-Range bytes */size", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/audio/001.wav`,
    { headers: { Range: `bytes=${WAV.length}-` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), `bytes */${WAV.length}`);
});

test("jail escape is 403 and never leaks the file", async () => {
  for (const p of ["/books/../secret.json",
                   "/books/luna-the-fox/../../secret.json",
                   "/books/%2e%2e/secret.json",
                   "/books/luna-the-fox/%2e%2e/%2e%2e/secret.json"]) {
    const r = await rawGet(PORT, p);
    assert.equal(r.status, 403, `escape blocked for ${p}`);
    assert.ok(!r.body.includes("secret"), `no leak for ${p}`);
  }
});

test("disallowed extension in the jail is 404", async () => {
  const r = await fetch(`${BASE}/books/luna-the-fox/manifest.txt`);
  assert.equal(r.status, 404);
});

test("LAW: missing books dir -> index [] and the server stays alive", async () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "era-nobooks-"));
  const PORT2 = 8398;
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
    assert.ok(up, "server boots without a books dir");
    const r = await fetch(`http://127.0.0.1:${PORT2}/books/index.json`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [], "empty shelf, not an error");
    const s = await fetch(`http://127.0.0.1:${PORT2}/settings`);
    assert.equal(s.status, 200, "server alive after the degraded index");
  } finally { c2.kill("SIGKILL"); }
});
