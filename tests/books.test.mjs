// books.test.mjs — book-package serving (era-book-reader M3, spec Piece 2).
// Spawns the REAL server.js on a TEST port with a throwaway ERA_DATA_DIR and a
// SYNTHETIC fixture package ("Luna the Fox": hand-crafted 1x1 JPEG + tiny PCM
// WAV — never real book content). Proves: index lists complete packages only,
// manifest/media caching headers, HTTP Range (206 byte math, 416), jail escape
// 403, and the degraded law (missing books dir -> [] with the server alive).
// Also proves the slug<->directory identity (T1.4): a parent names the folder
// ("Tabby McTat"), the shelf and the reader address it as /books/tabby-mctat/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import slugMod from "../slug.js";   // CJS: default import is module.exports
const { slugify } = slugMod;

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
  // builder scratch: the originals the parent dropped in, plus the job state
  // machine. These live INSIDE the package (so Drive mirrors them between
  // devices) but must never be reachable over HTTP — .jpg/.json are allowlisted
  // extensions, so only a name-based deny keeps them private.
  fs.mkdirSync(path.join(book, "sources"), { recursive: true });
  fs.mkdirSync(path.join(book, ".build"), { recursive: true });
  fs.writeFileSync(path.join(book, "sources", "IMG_0001.jpg"), JPEG);
  fs.writeFileSync(path.join(book, ".build", "job.json"), '{"state":"claimed"}');
  fs.writeFileSync(path.join(book, ".build", "text.json"), '{"pages":[]}');
  fs.writeFileSync(path.join(book, ".build", "log.jsonl"), '{"step":"ingest"}\n');
  // the SAME names under the music jail: the deny is books-only, so these serve
  fs.mkdirSync(path.join(TMP, "music", "sources"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "music", "sources", "cover.jpg"), JPEG);
  // Folders a PARENT named, not the exporter — the builder builds in place
  // inside the Drive folder, so the directory keeps the human name and the
  // hub derives the URL slug. One tiny package each (cover + manifest).
  const named = (dir, title) => {
    const b = path.join(TMP, "books", dir);
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, "cover.jpg"), JPEG);
    fs.writeFileSync(path.join(b, "manifest.json"), JSON.stringify({
      schemaVersion: 1, slug: dir, title, exportedAt: "2026-09-04T00:00:00Z",
      cover: "cover.jpg", pages: [{ index: 0, image: "cover.jpg", text: title }],
    }));
  };
  named("Tabby McTat", "Tabby McTat");                 // spaces + case
  named("Café Niño — Book 2!", "Café Niño — Book 2!"); // accents, em dash, punctuation
  named("-- Extra Dashes --", "Extra Dashes");         // leading/trailing dashes
  named("The Snail!", "The Snail (one)");              // collision pair: both
  named("The Snail?", "The Snail (two)");              // slugify to "the-snail"
  // The data-loss case: a folder that slugifies onto an EXISTING package's
  // slug must never take it. luna-the-fox is already its own slug, so it keeps
  // its URL (and the reader keeps its saved position); the newcomer is suffixed.
  named("Luna The Fox", "Luna The Fox (copy)");
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
  const slugs = idx.map(e => e.slug);
  assert.ok(!slugs.includes("half-exported") && !slugs.includes("broken-manifest"),
    "manifest-less + unparseable dirs are excluded");
  const luna = idx.find(e => e.slug === "luna-the-fox");
  // ?v= cache-bust: cover URL carries the package version (manifest mtime),
  // so a re-exported package escapes the immutable media cache (Tiddler
  // rotation lesson, 8/25)
  assert.match(luna.cover, /^\/books\/luna-the-fox\/cover\.jpg\?v=[a-z0-9]+$/);
  assert.equal(typeof luna.v, "string");
  const { cover: _c, v: _v, ...rest } = luna;
  assert.deepEqual(rest, {
    slug: "luna-the-fox", title: "Luna the Fox", pages: 2, hasVideo: false,
    authored: false,   // manifest `authored: true` passes through (coral-rim shelf card)
  });
  // and the versioned URL actually serves (query must not break the jail)
  const cv = await fetch(`${BASE}${luna.cover}`);
  assert.equal(cv.status, 200);
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

// The builder's scratch folders sit inside the package so Drive mirrors them,
// but the serve-side allowlist is by EXTENSION — sources/*.jpg and
// .build/*.json would otherwise be public. Deny by path segment, books only.
test("builder scratch is never served: sources/ and .build/ are 404", async () => {
  for (const p of ["/books/luna-the-fox/sources/IMG_0001.jpg",
                   "/books/luna-the-fox/.build/job.json",
                   "/books/luna-the-fox/.build/text.json",
                   "/books/luna-the-fox/.build/log.jsonl"]) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 404, `denied: ${p}`);
    const body = await r.text();
    assert.ok(!body.includes("claimed"), `no leak for ${p}`);
  }
});

test("scratch deny survives raw paths: percent-encoding and a trailing slash", async () => {
  for (const p of ["/books/luna-the-fox/%2Ebuild/job.json",   // .build re-encoded
                   "/books/luna-the-fox/%73ources/IMG_0001.jpg", // sources
                   "/books/luna-the-fox/SOURCES/IMG_0001.jpg", // case-insensitive fs
                   "/books/luna-the-fox/sources/"]) {
    const r = await rawGet(PORT, p);
    assert.equal(r.status, 404, `denied: ${p}`);
    assert.ok(!r.body.includes("claimed"), `no leak for ${p}`);
  }
});

test("the deny is books-only: /music/sources/ still serves", async () => {
  const r = await fetch(`${BASE}/music/sources/cover.jpg`);
  assert.equal(r.status, 200, "music and movies have no scratch folders to hide");
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.equals(JPEG));
});

test("normal package files are unaffected by the deny", async () => {
  for (const p of ["/books/luna-the-fox/manifest.json",
                   "/books/luna-the-fox/cover.jpg",
                   "/books/luna-the-fox/pages/001.jpg",
                   "/books/luna-the-fox/audio/001.wav"]) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 200, `still served: ${p}`);
  }
});

// ---- T1.4: slug <-> directory identity --------------------------------------
// The builder builds IN PLACE in the family's Drive folder, so the directory is
// whatever the parent typed. One slugify, shared by the index and the future
// worker, decides the URL; serveBook resolves slug -> directory before jailing.

test("slugify: spaces, case, accents, punctuation, edge dashes", () => {
  assert.equal(slugify("Tabby McTat"), "tabby-mctat");
  assert.equal(slugify("Café Niño — Book 2!"), "cafe-nino-book-2");
  assert.equal(slugify("-- Extra Dashes --"), "extra-dashes");
  assert.equal(slugify("The Snail & the Whale"), "the-snail-the-whale");
  assert.equal(slugify("Ellie's Garden"), "ellies-garden");   // apostrophe vanishes
  assert.equal(slugify("Ellie’s Garden"), "ellies-garden"); // curly one too
  assert.equal(slugify("  ...  "), "");                       // nothing usable
  assert.equal(slugify("tabby-mctat"), "tabby-mctat", "an already-slug name is a fixed point");
  assert.ok(slugify("x".repeat(200)).length <= 64, "bounded, like the movies id rule");
  assert.ok(!slugify("x".repeat(63) + " tail").endsWith("-"), "truncation never leaves a trailing dash");
});

test("slugify is idempotent for every fixture folder name", () => {
  for (const n of ["Tabby McTat", "Café Niño — Book 2!", "-- Extra Dashes --",
                   "The Snail!", "Luna The Fox", "luna-the-fox"])
    assert.equal(slugify(slugify(n)), slugify(n), `idempotent for ${n}`);
});

test("a human-named folder serves under its slug", async () => {
  const r = await fetch(`${BASE}/books/tabby-mctat/manifest.json`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).title, "Tabby McTat");
  const c = await fetch(`${BASE}/books/tabby-mctat/cover.jpg`);
  assert.equal(c.status, 200, "media under the slug resolves to the real directory");
  // the raw directory name is NOT a second URL for the same package
  assert.equal((await rawGet(PORT, "/books/Tabby%20McTat/manifest.json")).status, 404);
});

test("accents and punctuation: the shelf lists the slug, the slug serves", async () => {
  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  const e = idx.find(x => x.slug === "cafe-nino-book-2");
  assert.ok(e, "accented folder is indexed under its slug");
  assert.equal(e.title, "Café Niño — Book 2!", "the TITLE keeps the parent's words");
  assert.match(e.cover, /^\/books\/cafe-nino-book-2\/cover\.jpg\?v=/);
  assert.equal((await fetch(`${BASE}${e.cover}`)).status, 200);
  assert.ok(idx.some(x => x.slug === "extra-dashes"), "edge dashes trimmed");
});

test("collisions are deterministic: first by name keeps the slug, the next is suffixed", async () => {
  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  const one = idx.find(x => x.title === "The Snail (one)");
  const two = idx.find(x => x.title === "The Snail (two)");
  assert.equal(one.slug, "the-snail", '"The Snail!" sorts first, so it keeps the bare slug');
  assert.equal(two.slug, "the-snail-2", "the collider is suffixed, never merged");
  for (const s of ["the-snail", "the-snail-2"])
    assert.equal((await fetch(`${BASE}/books/${s}/manifest.json`)).status, 200);
});

test("an already-slug folder keeps its URL even when a newcomer slugifies onto it", async () => {
  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  assert.equal(idx.find(x => x.slug === "luna-the-fox").title, "Luna the Fox",
    "the existing package keeps its slug (reading positions are per-slug)");
  assert.equal(idx.find(x => x.title === "Luna The Fox (copy)").slug, "luna-the-fox-2");
  const m = await (await fetch(`${BASE}/books/luna-the-fox-2/manifest.json`)).json();
  assert.equal(m.title, "Luna The Fox (copy)", "and the newcomer is reachable, not lost");
});

test("PARITY: every indexed slug is exactly the slug the resolver accepts", async () => {
  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  assert.ok(idx.length >= 7, "all the fixture packages are on the shelf");
  for (const e of idx) {
    assert.equal(e.slug, slugify(e.slug), "the served slug is a slugify fixed point");
    const r = await fetch(`${BASE}/books/${e.slug}/manifest.json`);
    assert.equal(r.status, 200, `resolver accepts ${e.slug}`);
    assert.equal((await r.json()).title, e.title, `${e.slug} resolves to its OWN directory`);
  }
});

test("slug resolution never widens the jail: escapes and denies still hold", async () => {
  assert.equal((await rawGet(PORT, "/books/../secret.json")).status, 403);
  assert.equal((await rawGet(PORT, "/books/tabby-mctat/../../secret.json")).status, 403);
  assert.equal((await fetch(`${BASE}/books/no-such-book/manifest.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/books/tabby-mctat/sources/IMG_0001.jpg`)).status, 404);
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
