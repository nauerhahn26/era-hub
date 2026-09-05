// home-tiles.test.mjs — an app a family switched on has a tile, songs or no
// songs. VM QA 9/5 (T7.6, fresh install): the wizard offered Music and Movies,
// both ticked, and the launcher then showed neither — the tiles used to hide
// until the library had something in it, from the days a dev script was the
// only way to add a song. Since spec §6 the board's own "+ Add" strip is how
// a grown-up adds the first song, and the tile is the only door to it: hide
// the tile and the family can never fill the library. Spawns the REAL server
// on a fresh data dir (never the live hub) and drives the real home page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8448;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-home-tiles-"));
let child, browser;

before(async () => {
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1" },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ childName: "Zoe", dwellMs: 1200, apps: ["board", "music", "movies", "reader"] }) });
  assert.equal(r.status, 204, "the wizard picked Music and Movies");
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (child) child.kill("SIGKILL"); });

async function tiles(page) {
  await page.goto(`${BASE}/home/`, { waitUntil: "load" });
  await page.waitForSelector("#appMgr:not([hidden])");   // the tile loop has run
  return page.$$eval("a.app", els => els.map(e => ({
    title: (e.childNodes[1] || e.firstChild).textContent.trim() || e.textContent.trim().split("\n")[0].trim(),
    sub: (e.querySelector("small") || {}).textContent || "",
    href: e.getAttribute("href"),
  })));
}

test("fresh install, nothing added yet: Music and Movies still get a tile, and it says so", async () => {
  assert.equal((await fetch(`${BASE}/recipes/songs.json`)).status, 404, "no songs library yet (the honest 404 stays)");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const t = await tiles(page);
  const music = t.find(x => x.href === "/board/?recipe=songs");
  const movies = t.find(x => x.href === "/board/?recipe=movies");
  assert.ok(music, "Music has a tile with no songs: " + JSON.stringify(t));
  assert.ok(movies, "Movies has a tile with nothing to watch: " + JSON.stringify(t));
  assert.match(music.sub, /no songs yet/i, "the tile says the library is empty, not what it will hold");
  assert.match(music.sub, /\+ Add/, "…and names the control that fills it");
  assert.match(movies.sub, /nothing to watch yet/i);
  assert.match(movies.sub, /\+ Add/);
  await ctx.close();
});

test("with a song in the library the tile wears its ordinary line", async () => {
  // the smallest library the recipe accepts: one song whose audio file exists
  const dir = path.join(TMP, "music");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "one.wav"), Buffer.alloc(64));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1,
    songs: [{ id: "one", title: "One", audio: "one.wav", rank: 1 }] }));
  assert.equal((await fetch(`${BASE}/recipes/songs.json`)).status, 200);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const t = await tiles(page);
  const music = t.find(x => x.href === "/board/?recipe=songs");
  assert.ok(music);
  assert.doesNotMatch(music.sub, /no songs yet/i);
  assert.match(music.sub, /songs/i, "the registry's own sub-line: " + music.sub);
  await ctx.close();
});

test("an app switched OFF has no tile, empty or not", async () => {
  const r = await fetch(`${BASE}/apps`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "movies", enabled: false }) });
  assert.ok(r.ok);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const t = await tiles(page);
  assert.ok(!t.find(x => x.href === "/board/?recipe=movies"), "Movies off → no tile: " + JSON.stringify(t));
  assert.ok(t.find(x => x.href === "/board/?recipe=songs"), "Music stays");
  await ctx.close();
});
