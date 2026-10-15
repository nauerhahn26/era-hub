// this-week-fetch.test.mjs — the download rail (spec 2026-10-12 §3.2, plan B3).
// Drives the REAL server.js from outside, on port 8457 (this suite's own).
//
// NO NETWORK, NO REAL yt-dlp. ERA_YTDLP names a stand-in Node script this suite
// writes (the music-add.test.mjs pattern): it records every argv it was called
// with, plus when it started and finished, and does what FAKE_YTDLP_CTL says.
// ERA_DRIVE_LOCAL_ROOTS points at a fake "My Drive" holding the week folder;
// the hub is pointed at it and the first sync mirrors the manifest down — and
// that sync's onSynced fan-out is what starts the rail (the chain under test).
//
// Each case gets a fresh Drive root and a fresh data dir: the rail's state is
// module state in the hub, and a claim left in one case must not leak into the
// next.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8457;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-this-week-fetch-"));
const BIN = path.join(TMP, "bin", "yt-dlp");
const CTL = path.join(TMP, "bin", "ctl.json");
const CALLS = path.join(TMP, "bin", "calls.jsonl");
const HOLD = path.join(TMP, "bin", "hold");
const NOPACKS = path.join(TMP, "no-packs");
const WEEK = "2026-01-05";
const A = "aBcDeFgHiJk", B = "bBcDeFgHiJk", C = "cBcDeFgHiJk";
const URL_OF = (id) => "https://www.youtube.com/watch?v=" + id;

// The stand-in. --dump-single-json answers the lookup; anything else is a
// download that writes what the -o template names. One line per call, written
// when the call ENDS: {argv, start, end} (ms since epoch).
const FAKE = `#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const start = Date.now();
const ctl = process.env.FAKE_YTDLP_CTL;
const st = JSON.parse(fs.readFileSync(ctl, "utf8"));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (st.hold && fs.existsSync(st.hold)) sleep(25);
if (st.sleepMs) sleep(st.sleepMs);
const done = () => fs.appendFileSync(path.join(path.dirname(ctl), "calls.jsonl"),
  JSON.stringify({ argv, start, end: Date.now() }) + "\\n");
const target = argv[argv.length - 1];
const id = target.split("v=")[1];
if (argv.includes("--dump-single-json")) {
  process.stdout.write(JSON.stringify({
    id, title: "A video", duration: st.duration || 300, height: 1080,
    formats: [
      { format_id: "18", ext: "mp4", height: 360, acodec: "mp4a.40.2", vcodec: "avc1.42001E" },
      { format_id: "137", ext: "mp4", height: 1080, acodec: "none", vcodec: "avc1.640028" },
    ],
  }));
  done(); process.exit(0);
}
const tmpl = argv[argv.indexOf("-o") + 1];
const base = tmpl.replace(/\\.%\\(ext\\)s$/, "");
fs.mkdirSync(path.dirname(base), { recursive: true });
fs.writeFileSync(base + "." + (st.ext || "mp4"), Buffer.alloc(1024, 7));
fs.writeFileSync(base + ".webp", Buffer.from("fake-webp"));
done(); process.exit(0);
`;

let child = null, DATA = null, DRIVE = null, INSIDE = null;

function ctl(state) { fs.writeFileSync(CTL, JSON.stringify(state)); }
function calls() {
  try { return fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}
const lookups = () => calls().filter(c => c.argv.includes("--dump-single-json"));
const downloads = () => calls().filter(c => !c.argv.includes("--dump-single-json"));
const driveWeek = () => path.join(INSIDE, "this-week", WEEK);

function manifest() {
  const words = ["shadow", "light", "sun", "dark", "big", "small"];
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
    talk: words.map(w => ({ word: w, say: w, group: "science", glyph: "🌑" })),
  };
}

// A fresh Drive root + data dir + hub. opts.settings is written into the data
// dir before boot; opts.env adds hub env; opts.prepare(driveWeekDir) runs
// before the first sync. Returns after the hub is up and pointed at the folder
// (NOT synced: each case decides when the sync — and so the first tick — runs).
async function fresh(opts = {}) {
  await stopHub();
  fs.rmSync(CALLS, { force: true });
  fs.rmSync(HOLD, { force: true });
  const root = fs.mkdtempSync(path.join(TMP, "drive-"));
  DRIVE = path.join(root, "My Drive");
  INSIDE = path.join(DRIVE, "New ERA Content");
  fs.mkdirSync(driveWeek(), { recursive: true });
  fs.writeFileSync(path.join(driveWeek(), "manifest.json"), JSON.stringify(manifest()));
  if (opts.prepare) opts.prepare(driveWeek());
  DATA = fs.mkdtempSync(path.join(TMP, "data-"));
  if (opts.settings) fs.writeFileSync(path.join(DATA, "app-settings.json"), JSON.stringify(opts.settings));
  const env = { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1",
                ERA_DRIVE_LOCAL_ROOTS: DRIVE, FAKE_YTDLP_CTL: CTL,
                ERA_AI_URL: "http://127.0.0.1:9/never", ERA_UPDATE_URL: "http://127.0.0.1:9/never",
                ...(opts.env || { ERA_YTDLP: BIN }) };
  if (opts.env) delete env.ERA_YTDLP;
  child = spawn("node", ["server.js", String(PORT)], { cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); break; } catch {}
    await new Promise(r => setTimeout(r, 100));
    if (i === 99) throw new Error("server never came up");
  }
  const r = await post("/integrations/drive/localfolder", { folderPath: INSIDE });
  assert.equal(r.status, 204);
}
async function stopHub() {
  if (!child) return;
  const c = child; child = null;
  const gone = new Promise(r => c.once("exit", r));
  c.kill("SIGKILL");
  await gone;
}
const post = (url, body) => fetch(BASE + url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});
const sync = async () => { const r = await post("/integrations/drive/sync"); assert.equal(r.status, 200); };
const status = () => fetch(`${BASE}/this-week/status`).then(r => r.json());
async function until(pred, what) {
  let s;
  for (let i = 0; i < 300; i++) {
    s = await status();
    if (pred(s)) return s;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("never: " + what + " — last status " + JSON.stringify(s));
}
const states = (s) => [A, B, C].map(id => s.videos[id] && s.videos[id].state);
const allIn = (want) => (s) => !s.running && states(s).every(x => want.includes(x));

after(async () => {
  await stopHub();
  fs.rmSync(TMP, { recursive: true, force: true });
});
fs.mkdirSync(NOPACKS, { recursive: true });
fs.mkdirSync(path.dirname(BIN), { recursive: true });
fs.writeFileSync(BIN, FAKE, { mode: 0o755 });

// --------------------------------------------------------------- the ladder

test("(a) the switch off: every missing video says switch-off and nothing is spawned", async () => {
  ctl({});
  await fresh({ settings: { downloadWeekVideos: false } });
  await sync();
  const s = await until(allIn(["switch-off"]), "switch-off");
  assert.equal(s.switch, false);
  assert.equal(s.week_of, WEEK);
  assert.equal(s.running, null);
  assert.ok(s.videos[A].error && !/yt-dlp|ERROR/.test(s.videos[A].error), "a plain sentence");
  assert.equal(calls().length, 0, "never spawned");
  assert.deepEqual(fs.readdirSync(driveWeek()), ["manifest.json"], "nothing written into the Drive folder");
});

test("(b) without the media-tools pack: pack-missing, nothing spawned", async () => {
  ctl({});
  await fresh({ env: { ERA_PACK_ROOT: NOPACKS } });
  await sync();
  const s = await until(allIn(["pack-missing"]), "pack-missing");
  assert.deepEqual(s.pack, { id: "media-tools", installed: false });
  assert.equal(calls().length, 0);
  assert.deepEqual(fs.readdirSync(driveWeek()), ["manifest.json"]);
});

// ---------------------------------------------------------------- happy path

test("(c) happy path: exact argv, files land in Drive, claim + tmp gone, ETag moves, cell becomes a video", async () => {
  ctl({ hold: HOLD });
  await fresh();
  fs.writeFileSync(HOLD, "");
  await sync();                       // the onSynced chain starts the rail; the fake waits on HOLD
  await until(s => s.running && s.running.id === A, "running A");
  assert.ok(fs.existsSync(path.join(driveWeek(), "claim-" + A + ".json")), "A is claimed while it runs");
  const claim = JSON.parse(fs.readFileSync(path.join(driveWeek(), "claim-" + A + ".json"), "utf8"));
  assert.ok(typeof claim.device === "string" && claim.device.length > 0 && claim.started);
  const r0 = await fetch(`${BASE}/recipes/this-week.json`);
  const etag0 = r0.headers.get("etag");
  const watch0 = (await r0.json()).boards.find(b => b.id === "watch");
  assert.equal(watch0.buttons.find(b => b.row === 1 && b.col === 2).type, "word");

  fs.rmSync(HOLD);
  const s = await until(allIn(["ready"]), "all ready");
  for (const id of [A, B, C]) assert.equal(s.videos[id].height, 360, "the chosen format's height");

  const tmpA = path.join(DATA, "this-week", ".tmp", A);
  const lk = lookups(), dl = downloads();
  assert.equal(lk.length, 3); assert.equal(dl.length, 3);
  assert.equal(lk[0].argv[0], "--js-runtimes");
  assert.deepEqual(lk[0].argv.slice(2),
    ["--no-playlist", "--no-warnings", "--skip-download", "--dump-single-json", URL_OF(A)]);
  assert.deepEqual(dl[0].argv.slice(2),
    ["--no-playlist", "--no-warnings", "--no-progress", "--retries", "3",
     "-f", "b[ext=mp4][height<=720]/b[ext=mp4]/18", "--write-thumbnail",
     "-o", path.join(tmpA, A + ".%(ext)s"), URL_OF(A)]);
  assert.deepEqual(calls().map(c => c.argv.at(-1)),
    [URL_OF(A), URL_OF(A), URL_OF(B), URL_OF(B), URL_OF(C), URL_OF(C)], "lookup then download, in order");

  const files = fs.readdirSync(driveWeek()).sort();
  assert.deepEqual(files, ["manifest.json", ...[A, B, C].flatMap(id => [id + ".mp4", id + ".webp"])].sort(),
    "both files in Drive, no claim, no .part");
  assert.equal(fs.statSync(path.join(driveWeek(), A + ".mp4")).size, 1024);
  assert.equal(fs.existsSync(tmpA), false, "the tmp dir is gone");
  assert.equal(fs.existsSync(path.join(DATA, "this-week", WEEK, A + ".mp4")), true, "mirrored now");

  const r1 = await fetch(`${BASE}/recipes/this-week.json`);
  assert.notEqual(r1.headers.get("etag"), etag0, "the ETag moved");
  const cell = (await r1.json()).boards.find(b => b.id === "watch").buttons.find(b => b.row === 1 && b.col === 2);
  assert.equal(cell.type, "video");
  assert.equal(cell.id, A);
  assert.equal(cell.image, "this-week/" + WEEK + "/" + A + ".webp");

  const pooled = fs.readdirSync(path.join(DATA, "pool", "events"), { recursive: true })
    .filter(f => f.endsWith(".jsonl"))
    .map(f => fs.readFileSync(path.join(DATA, "pool", "events", f), "utf8")).join("");
  assert.equal((pooled.match(/"this-week-fetch"/g) || []).length, 3, "one pool line per job");
});

// ------------------------------------------------------------------ refusals

test("(d) a video over 15 minutes: too-long, never downloaded, claim gone", async () => {
  ctl({ duration: 1000 });
  await fresh();
  await sync();
  const s = await until(allIn(["too-long"]), "too-long");
  assert.ok(s.videos[A].error);
  assert.equal(lookups().length, 3);
  assert.equal(downloads().length, 0, "no download argv");
  assert.deepEqual(fs.readdirSync(driveWeek()), ["manifest.json"], "claims gone");
});

test("(e) a .webm comes back: not-mp4, nothing moved, claim and tmp gone", async () => {
  ctl({ ext: "webm" });
  await fresh();
  await sync();
  const s = await until(allIn(["not-mp4"]), "not-mp4");
  assert.ok(s.videos[A].error);
  assert.deepEqual(fs.readdirSync(driveWeek()), ["manifest.json"], "nothing moved, no claim");
  assert.equal(fs.existsSync(path.join(DATA, "this-week", ".tmp", A)), false);
});

test("(f) a fresh claim by another device is respected; a 31-minute-old one is not", async () => {
  ctl({});
  const claimPath = () => path.join(driveWeek(), "claim-" + A + ".json");
  await fresh({ prepare: (dir) => fs.writeFileSync(path.join(dir, "claim-" + A + ".json"),
    JSON.stringify({ device: "other-device", started: new Date().toISOString() })) });
  await sync();
  let s = await until(s => !s.running && s.videos[A]?.state === "claimed" &&
                           s.videos[B]?.state === "ready" && s.videos[C]?.state === "ready", "A claimed");
  assert.equal(calls().filter(c => c.argv.at(-1) === URL_OF(A)).length, 0, "no spawn for A");
  assert.equal(JSON.parse(fs.readFileSync(claimPath(), "utf8")).device, "other-device", "their claim untouched");

  const old = new Date(Date.now() - 31 * 60 * 1000);
  fs.writeFileSync(claimPath(), JSON.stringify({ device: "other-device", started: old.toISOString() }));
  fs.utimesSync(claimPath(), old, old);
  const t = await post("/this-week/tick");
  assert.equal(t.status, 202);
  s = await until(s => !s.running && s.videos[A]?.state === "ready", "A proceeds");
  assert.equal(calls().filter(c => c.argv.at(-1) === URL_OF(A)).length, 2, "lookup + download for A");
  assert.equal(fs.existsSync(claimPath()), false, "the stale claim is gone");
});

// --------------------------------------------------------------- one at a time

test("(g) two missing videos: two jobs in manifest order, never overlapping", async () => {
  ctl({ sleepMs: 150 });
  await fresh({ prepare: (dir) => {
    fs.writeFileSync(path.join(dir, A + ".mp4"), Buffer.alloc(512, 1));   // A is already done
    fs.writeFileSync(path.join(dir, A + ".webp"), Buffer.from("w"));
  } });
  await sync();
  await until(allIn(["ready"]), "all ready");
  const c = calls();
  assert.equal(c.length, 4, "lookup + download for B and C only");
  assert.deepEqual(c.map(x => x.argv.at(-1)), [URL_OF(B), URL_OF(B), URL_OF(C), URL_OF(C)]);
  for (let i = 1; i < c.length; i++)
    assert.ok(c[i].start >= c[i - 1].end, `call ${i} started after call ${i - 1} ended`);
});

test("(h) a tick while a job runs answers busy", async () => {
  ctl({ hold: HOLD });
  await fresh();
  fs.writeFileSync(HOLD, "");
  await sync();
  await until(s => s.running && s.running.id === A, "running A");
  const t = await post("/this-week/tick");
  assert.equal(t.status, 200);
  assert.deepEqual(await t.json(), { tick: "busy" });
  fs.rmSync(HOLD);
  await until(allIn(["ready"]), "all ready");
  assert.equal(lookups().length, 3, "the busy tick started nothing of its own");
});
