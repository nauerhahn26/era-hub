// this-week-recipe.test.mjs — the week package on the shelf becomes the
// "This week" board (spec 2026-10-12 §3, plan B1). Two halves:
//
//   1. in-process: this-week.js is pure, so readWeek / validate / recipe /
//      videoState / build are driven directly against a temp data dir;
//   2. over HTTP: a real hub on port 8456 (this suite's own — see the plan's
//      free-port table) serves /recipes/this-week.json, the /this-week/ media
//      jail and /this-week/status.
//
// Fixture week only: 2026-01-05, "Shadows!", fake 11-char ids. Nothing real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tw = require(path.join(HUB, "this-week.js"));
const PORT = 8456;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-this-week-"));
const WEEK = "2026-01-05";
const A = "aBcDeFgHiJk", B = "bBcDeFgHiJk", C = "cBcDeFgHiJk";

const WORDS = [
  ["shadow", "science", { glyph: "🌑" }], ["light", "science", { glyph: "💡" }],
  ["sun", "science", { glyph: "☀️" }], ["lamp", "science", { glyph: "🪔" }],
  ["dark", "describing", { glyph: "🌚" }], ["big", "describing", { glyph: "🐘" }],
  ["small", "describing", { glyph: "🐜" }], ["more", "core", { symbol: "more" }],
  ["help", "core", { symbol: "help" }], ["go", "core", { symbol: "go" }],
];
function manifest(extra = {}) {
  return {
    week_of: WEEK, title: "Shadows!", schema: 1, approved: "2026-01-02T10:00:00Z",
    topic: { science: "light and shadows", social_studies: "our special place",
             phonics: "short e", math: "make ten", hero: null },
    watch: [A, B, C].map((id, i) => ({
      id, title: "Shadow video " + (i + 1), channel: "A Channel", minutes: 5,
      why: "shows shadows", before: null,
      oembed: { title: "Shadow video " + (i + 1), author_name: "A Channel",
                thumbnail_url: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" },
    })),
    talk: WORDS.map(([w, group, g]) => ({ word: w, say: w, group, ...g })),
    play: { which: [], playit: { instrument: "shadow-puppet", q: "Tall?", answer: 0 } },
    ...extra,
  };
}
function writeWeek(dataDir, week, m, files = true) {
  const dir = path.join(dataDir, "this-week", week);
  fs.mkdirSync(dir, { recursive: true });
  if (files) {
    fs.writeFileSync(path.join(dir, A + ".mp4"), Buffer.alloc(1024, 1));
    fs.writeFileSync(path.join(dir, A + ".webp"), Buffer.alloc(64, 2));
    fs.writeFileSync(path.join(dir, B + ".mp4"), Buffer.alloc(0));
    fs.writeFileSync(path.join(dir, "claim-a.json"), JSON.stringify({ device: "x", started: 1 }));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), typeof m === "string" ? m : JSON.stringify(m));
  return dir;
}
const board = (r, id) => r.boards.find(b => b.id === id);
const at = (b, row, col) => b.buttons.filter(c => c.row === row && c.col === col);

// ---------------------------------------------------------------- in-process

test("root board: exactly Watch [1,1] + Talk [1,4], say_on_load on the first", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  const { recipe } = tw.build(d);
  assert.equal(recipe.root, "this-week");
  const root = board(recipe, "this-week");
  assert.equal(root.rows, 3); assert.equal(root.columns, 4);
  assert.equal(root.name, "Shadows!");
  assert.equal(root.buttons.length, 2);
  assert.deepEqual(root.buttons[0], { type: "show", board: "watch", label: "Watch", say: "watch",
    glyph: "🎬", row: 1, col: 1, say_on_load: "This week: Shadows!" });
  assert.deepEqual(root.buttons[1], { type: "show", board: "talk-1", label: "Talk", say: "talk",
    glyph: "💬", row: 1, col: 4 });
});

test("watch board: Back, one ready video, two 'not here yet' in seats", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  const w = board(tw.build(d).recipe, "watch");
  assert.equal(w.buttons.length, 4);
  assert.deepEqual(at(w, 1, 1)[0], { label: "Back", say: "back", type: "back", glyph: "←",
    load: "this-week", row: 1, col: 1 });
  assert.deepEqual(at(w, 1, 2)[0], { type: "video", id: A, week_of: WEEK, label: "Shadow video 1",
    image: `this-week/${WEEK}/${A}.webp`, row: 1, col: 2 });
  assert.deepEqual(at(w, 1, 3)[0], { type: "word", label: "Shadow video 2", say: "not here yet",
    glyph: "⏳", row: 1, col: 3 });
  assert.deepEqual(at(w, 1, 4)[0], { type: "word", label: "Shadow video 3", say: "not here yet",
    glyph: "⏳", row: 1, col: 4 });
  assert.equal(at(w, 2, 2).length + at(w, 2, 3).length, 0, "centre stays black");
});

test("talk boards: 8 words + More on talk-1, 2 words + Back and no More on talk-2", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  const r = tw.build(d).recipe;
  const t1 = board(r, "talk-1"), t2 = board(r, "talk-2");
  const words1 = t1.buttons.filter(c => c.type === "word");
  assert.equal(words1.length, 8);
  assert.deepEqual(words1.map(c => [c.row, c.col]),
    [[1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]]);
  assert.deepEqual(words1[0], { type: "word", label: "shadow", say: "shadow", glyph: "🌑", row: 1, col: 2 });
  assert.deepEqual(words1[7], { type: "word", label: "more", say: "more", symbol: "more", row: 3, col: 4 });
  assert.deepEqual(at(t1, 1, 1)[0].load, "this-week");
  assert.deepEqual(at(t1, 3, 1)[0], { label: "More", type: "control", symbol: "more",
    load: "talk-2", row: 3, col: 1 });
  assert.equal(t2.buttons.filter(c => c.type === "word").length, 2);
  assert.equal(at(t2, 1, 1)[0].type, "back");
  assert.equal(at(t2, 1, 1)[0].load, "this-week");
  assert.equal(at(t2, 3, 1).length, 0, "no More on the last page");
  assert.equal(board(r, "talk-3"), undefined);
});

test("validate drops a bad item and lists it, never the page", () => {
  const m = manifest();
  m.watch.push({ ...m.watch[0], id: "not-an-id" });
  m.talk.push({ word: "both", say: "both", group: "core", glyph: "🌑", symbol: "more" });
  m.talk.push({ word: "x", say: "x", group: "nope", glyph: "🌑" });
  m.talk.push({ word: "waytoolongforaword", say: "w", group: "core", glyph: "🌑" });
  m.talk.push({ word: "notemoji", say: "n", group: "core", glyph: "ab" });
  const out = tw.validate(m);
  assert.equal(out.manifest.watch.length, 3);
  assert.equal(out.manifest.talk.length, 10);
  assert.equal(out.dropped.length, 5);
  assert.ok(out.dropped.some(x => /not-an-id/.test(JSON.stringify(x))));
  const bad = { ...manifest() }; bad.watch[1] = { ...bad.watch[1], minutes: 40 };
  assert.equal(tw.validate(bad).manifest.watch.length, 2);
  assert.throws(() => tw.validate({ ...manifest(), pages: [] }));
  assert.throws(() => tw.validate({ ...manifest(), cover: "x.jpg" }));
  const noTalk = manifest(); delete noTalk.talk;
  assert.throws(() => tw.validate(noTalk));
});

test("videoState: ready needs bytes; thumbnail ext is the first present", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  const dir = writeWeek(d, WEEK, manifest());
  assert.deepEqual(tw.videoState(dir, A), { ready: true, ext: "webp", size: 1024 });
  assert.equal(tw.videoState(dir, B).ready, false);
  assert.equal(tw.videoState(dir, C).ready, false);
  assert.equal(tw.videoState(dir, C).ext, null);
});

test("ETag changes when the zero-byte mp4 gains bytes, stable otherwise", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  const dir = writeWeek(d, WEEK, manifest());
  const e1 = tw.build(d).etag, e2 = tw.build(d).etag;
  assert.equal(e1, e2);
  assert.match(e1, /^"\d+-\d+-[0-9a-f]+-r1"$/);
  assert.equal(tw.THIS_WEEK_REV, 1);
  fs.writeFileSync(path.join(dir, B + ".mp4"), Buffer.alloc(512, 1));
  const e3 = tw.build(d).etag;
  assert.notEqual(e3, e1);
  const v = at(board(tw.build(d).recipe, "watch"), 1, 3)[0];
  assert.equal(v.type, "video");
});

test("two week folders: the newest wins; an unparseable newer one is skipped", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest());
  writeWeek(d, "2026-01-12", manifest({ week_of: "2026-01-12", title: "Next!" }), false);
  assert.equal(tw.readWeek(d).week_of, "2026-01-12");
  writeWeek(d, "2026-01-19", "{not json", false);
  assert.equal(tw.readWeek(d).week_of, "2026-01-12");
  fs.mkdirSync(path.join(d, "this-week", ".tmp"), { recursive: true });
  assert.equal(tw.readWeek(d).week_of, "2026-01-12");
});

test("no folder: root-only valid board, etag none-r1", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  assert.equal(tw.readWeek(d), null);
  const out = tw.build(d);
  assert.equal(out.etag, '"none-r1"');
  assert.equal(out.recipe.root, "this-week");
  assert.deepEqual(out.recipe.boards.map(b => b.id), ["this-week"]);
});

test("a manifest with pages is refused: err etag, root-only", () => {
  const d = fs.mkdtempSync(path.join(TMP, "d-"));
  writeWeek(d, WEEK, manifest({ pages: [] }));
  const out = tw.build(d);
  assert.match(out.etag, /^"err-\d+"$/);
  assert.deepEqual(out.recipe.boards.map(b => b.id), ["this-week"]);
});

// ---------------------------------------------------------------- over HTTP

let child = null;
const HDATA = path.join(TMP, "hub-data");
before(async () => {
  writeWeek(HDATA, WEEK, manifest());
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: HDATA, ERA_BIND: "127.0.0.1",
           ERA_DRIVE_LOCAL_ROOTS: path.join(TMP, "no-roots"),
           ERA_PACK_ROOT: path.join(TMP, "no-packs"),
           ERA_AI_URL: "http://127.0.0.1:9/never",
           ERA_WEATHER_URL: "http://127.0.0.1:9/never",
           ERA_GEO_URL: "http://127.0.0.1:9/never",
           ERA_UPDATE_URL: "http://127.0.0.1:9/never" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(async () => {
  if (child) { const c = child; child = null; const gone = new Promise(r => c.once("exit", r)); c.kill("SIGKILL"); await gone; }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// raw request: fetch() would normalise a ".." away before it ever left
function raw(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, headers }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject); r.end();
  });
}

test("HTTP: recipe 200 + ETag, 304 on If-None-Match, unknown recipe 404", async () => {
  const r = await fetch(`${BASE}/recipes/this-week.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const etag = r.headers.get("etag");
  assert.match(etag, /-r1"$/);
  const body = await r.json();
  assert.equal(body.root, "this-week");
  assert.equal(board(body, "watch").buttons.filter(c => c.type === "video").length, 1);
  const r2 = await fetch(`${BASE}/recipes/this-week.json`, { headers: { "If-None-Match": etag } });
  assert.equal(r2.status, 304);
  const h = await fetch(`${BASE}/recipes/this-week.json`, { method: "HEAD" });
  assert.equal(h.status, 200);
  assert.equal((await fetch(`${BASE}/recipes/nope.json`)).status, 404);
});

test("HTTP: the media jail — range 206, '..' refused, claims hidden", async () => {
  const r = await fetch(`${BASE}/this-week/${WEEK}/${A}.mp4`, { headers: { Range: "bytes=0-99" } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  const img = await fetch(`${BASE}/this-week/${WEEK}/${A}.webp`);
  assert.equal(img.status, 200);
  const man = await fetch(`${BASE}/this-week/${WEEK}/manifest.json`);
  assert.equal(man.status, 200);
  assert.equal(await raw(`/this-week/${WEEK}/../../app-settings.json`), 403);
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/claim-a.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/CLAIM-a.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/this-week/${WEEK}/x.exe`)).status, 404);
});

test("HTTP: /this-week/status reads the files", async () => {
  const r = await fetch(`${BASE}/this-week/status`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const s = await r.json();
  assert.equal(s.week_of, WEEK);
  assert.equal(s.switch, true);
  assert.deepEqual(s.pack, { id: "media-tools", installed: false });
  assert.equal(s.folder, false);
  assert.equal(s.running, null);
  assert.equal(s.videos[A].state, "ready");
  assert.equal(s.videos[B].state, "coming");
  assert.equal(s.videos[C].state, "coming");
});
