// drawing-ui.test.mjs — Drawing in a real browser (spec docs/superpowers/specs/2026-09-30-drawing-design.md
// §2-§3, §8). Harness: reader-shelf.test.mjs's — the REAL server.js on a scratch port with a throwaway
// ERA_DATA_DIR, every provider seam closed, NO Drive folder (so every write is .local in the data dir),
// synthetic pictures only; Playwright at 1920x1080 with touch, UTC, speech in test mode.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 8478 — swept free 9/30 across all five repos' tests/ and every open worktree; ss -ltn clean.
const PORT = Number(process.env.ERA_TEST_DRAWING_PORT) || 8478;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-drawing-ui-"));
const PICS = path.join(TMP, "drawings");
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
};
let child, browser;

before(async () => {
  fs.writeFileSync(path.join(TMP, "profile.json"), JSON.stringify({ childName: "Maya" }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev", ERA_NO_UPDATE: "1", ...SEAMS },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1920, height: 1080 }, hasTouch: true,
    deviceScaleFactor: 1, timezoneId: "UTC", reducedMotion: opts.reducedMotion || "no-preference" });
  await ctx.addInitScript(() => { window.__testHooks = true; });
  await ctx.route("http://127.0.0.1:49155/**", (r) => r.abort());   // ERAgaze's port on her PC; nothing answers here
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  if (opts.routes) await opts.routes(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${BASE}/drawing/${opts.hash || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  return { ctx, page, errors };
}
const st = (page) => page.evaluate(() => window.Drawing.state());
const newId = async () => (await (await fetch(`${BASE}/drawings`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id;
const hubScene = async (id) => (await fetch(`${BASE}/drawings/${id}/scene.json`)).json();
async function openRing(opts = {}) {
  const id = opts.id || (await newId());
  const p = await makePage({ ...opts, hash: "#p=" + id });
  await p.page.waitForFunction(() => window.Drawing.state().screen === "ring");
  return { ...p, id };
}
// a picture another device made, straight into the data dir (what the mirror would carry in)
function seed(id, items, when) {
  fs.mkdirSync(path.join(PICS, id), { recursive: true });
  fs.writeFileSync(path.join(PICS, id, "scene.json"), JSON.stringify(
    { v: 1, id, created: when, updated: when, device: "test-dev", backdrop: "meadow", items, mailedHash: null }));
}
const H = (x = 0.5, y = 0.82) => ({ s: "horse", x, y, w: 0.2, by: "ellie" });
const puts = (page) => {
  const seen = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/scene.json")) seen.push(r); });
  return seen;
};

// ================================================================ T7 — the ring
test("the ring: eight sticker tiles in their fixed seats, Undo and Done either side of the black rest tile", async () => {
  const { ctx, page, errors } = await openRing();
  const g = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const rest = document.getElementById("restTile");
    return {
      tiles: [...document.querySelectorAll("#sRing .tile")].map((el) => ({ id: el.dataset.s, word: el.textContent.trim(), ...box(el) })),
      undo: box(document.getElementById("btnUndo")), done: box(document.getElementById("btnDone")),
      rest: { ...box(rest), bg: getComputedStyle(rest).backgroundColor }, scene: box(document.getElementById("scene")),
    };
  });
  assert.deepEqual(g.tiles.map((t) => t.id), ["house", "horse", "tree", "person", "sun", "cloud", "star", "splat"]);
  assert.deepEqual(g.tiles.map((t) => t.word), ["House", "Horse", "Tree", "Person", "Sun", "Cloud", "Star", "Splat"]);
  const left = g.tiles.slice(0, 4), right = g.tiles.slice(4);
  for (const t of left) assert.ok(t.x + t.w <= g.scene.x, t.id + " is left of the picture");
  for (const t of right) assert.ok(t.x >= g.scene.x + g.scene.w, t.id + " is right of the picture");
  for (const col of [left, right]) for (let k = 1; k < 4; k++)
    assert.ok(col[k].y - (col[k - 1].y + col[k - 1].h) >= 13.5, "a 14px gap down each column");
  assert.ok(Math.abs(g.undo.x - left[0].x) < 1 && g.undo.y > left[3].y, "Undo under Person");
  assert.ok(Math.abs(g.done.x - right[0].x) < 1 && g.done.y > right[3].y, "Done under Splat, bottom-right");
  assert.equal(g.rest.bg, "rgb(0, 0, 0)", "the rest tile is pure black");
  assert.ok(Math.abs(g.rest.y - g.undo.y) < 1 && g.rest.x > g.undo.x + g.undo.w && g.rest.x + g.rest.w < g.done.x);
  assert.ok(Math.abs(g.rest.x + g.rest.w / 2 - (g.scene.x + g.scene.w / 2)) < 2, "centred under the picture");
  for (const t of [...g.tiles, { id: "undo", ...g.undo }, { id: "done", ...g.done }])
    assert.ok(Math.min(t.w, t.h) >= 90, t.id + " is at least 90px at 1920");
  assert.ok(Math.abs(g.scene.w / g.scene.h - 16 / 9) < 0.01, "the picture is 16:9");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("her picture and the rest tile are inert, and the only holds on the page are the two doors' (2x her dwell)", async () => {
  const id = await newId();                              // a picture with one horse, saved through the hub
  await fetch(`${BASE}/drawings/${id}/scene.json`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, backdrop: "meadow", items: [H()] }) });
  const { ctx, page } = await openRing({ id });
  const r = await page.evaluate(() => ({
    sceneAttrs: [...document.querySelectorAll("#scene, #scene *")].some((n) =>
      n.matches(".dwell") || [...n.attributes].some((a) => a.name.startsWith("data-dwell"))),
    rest: document.getElementById("restTile").matches(".dwell") ||
      [...document.getElementById("restTile").attributes].some((a) => a.name.startsWith("data-dwell")),
    holds: [...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.id + "=" + el.dataset.dwellMs).sort(),
    ringTargets: document.querySelectorAll("#sRing .dwell").length,
    items: document.querySelectorAll("#scene .item").length,
  }));
  assert.equal(r.sceneAttrs, false, "no .dwell and no data-dwell-* anywhere in her picture");
  assert.equal(r.rest, false);
  assert.deepEqual(r.holds, ["barDoor=2400", "barTalk=2400"]);
  assert.equal(r.ringTargets, 10, "8 stickers + Undo + Done");
  assert.equal(r.items, 1);
  await ctx.close();
});

test("the rest tile is the gaze park: its centre is what the page posts, in 0-1 coordinates", async () => {
  const { ctx, page } = await openRing();
  const { park, rest, override } = await page.evaluate(() => {
    const r = document.getElementById("restTile").getBoundingClientRect();
    return { park: window.Drawing.state().park, override: document.documentElement.dataset.parkOverride,
             rest: { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight } };
  });
  assert.equal(override, "center");
  assert.ok(park && Math.abs(park.x - rest.x) < 0.002 && Math.abs(park.y - rest.y) < 0.002, JSON.stringify({ park, rest }));
  await ctx.close();
});

test("a hash that is not a picture id opens the shelf, never a broken ring", async () => {
  for (const h of ["#p=../../etc", "#p=2026-09-30-101500-X", "#p=", "#nothing"]) {
    const { ctx, page, errors } = await makePage({ hash: h });
    assert.equal((await st(page)).screen, "shelf", h);
    assert.deepEqual(errors, [], h);
    await ctx.close();
  }
});

test("at 1280x720 every ring tile is still at least 60px", async () => {
  const { ctx, page } = await openRing({ viewport: { width: 1280, height: 720 } });
  const mins = await page.evaluate(() => [...document.querySelectorAll("#sRing .dwell")].map((el) => {
    const r = el.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  assert.equal(mins.length, 10);
  for (const m of mins) assert.ok(m >= 60, String(m));
  await ctx.close();
});

// ================================================================ T8 — placing, undo, autosave
test("a dwell on Horse says \"Horse\" (after Speech.stop) and the horse lands at the first centre-out ground slot", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#tile-horse").click();
  let s = await st(page);
  assert.deepEqual(s.items, [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }]);
  assert.equal(s.said.at(-1), "Horse");
  assert.ok(await page.evaluate(() => (window.__speechEngineLog || []).some((e) => e.ev === "stop")), "Speech.stop() first");
  await page.locator("#tile-sun").click();
  s = await st(page);
  assert.deepEqual(s.items[1], { s: "sun", x: 0.5, y: 0.17, w: 0.16, by: "ellie" });
  await ctx.close();
});

test("Undo takes the last sticker away and says so; on an empty history it does nothing and says nothing", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#btnUndo").click();
  let s = await st(page);
  assert.equal(s.items.length, 0);
  assert.deepEqual(s.said, [], "silence — never \"wrong\"");
  await page.locator("#tile-tree").click();
  await page.locator("#tile-star").click();
  await page.locator("#btnUndo").click();
  s = await st(page);
  assert.deepEqual(s.items.map((i) => i.s), ["tree"]);
  assert.equal(s.said.at(-1), "Undo");
  await ctx.close();
});

test("a sticker flies from its tile into its slot; with reduced motion it simply appears", async () => {
  let { ctx, page } = await openRing();
  await page.locator("#tile-cloud").click();
  assert.equal(await page.locator(".flyer").count(), 1, "in flight");
  await page.waitForFunction(() => !document.querySelector(".flyer"), null, { timeout: 2000 });
  assert.equal(await page.evaluate(() => document.querySelector('#scene [data-i="0"]').style.visibility), "");
  await ctx.close();
  ({ ctx, page } = await openRing({ reducedMotion: "reduce" }));
  await page.locator("#tile-cloud").click();
  assert.equal(await page.locator(".flyer").count(), 0);
  await ctx.close();
});

test("her picture is saved as she goes: a reload shows it exactly", async () => {
  const { ctx, page, id } = await openRing();
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/drawings/${id}/scene.json`) && r.ok());
  await page.locator("#tile-house").click();
  await saved;
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["house"]);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  const s = await st(page);
  assert.deepEqual([s.screen, s.id, s.items.map((i) => i.s)], ["ring", id, ["house"]]);
  assert.equal(await page.locator("#scene .item").count(), 1);
  await ctx.close();
});

test("five quick dwells on one tile: five horses in five slots, one coalesced save, one Undo takes one (Review Focus 1)", async () => {
  const { ctx, page, id } = await openRing();
  const seen = puts(page);
  await page.evaluate(() => { for (let k = 0; k < 5; k++) document.getElementById("tile-horse").click(); });  // dwell.js's el.click()
  assert.deepEqual((await st(page)).items.map((i) => i.x), [0.5, 0.35, 0.65, 0.2, 0.8]);
  await page.waitForTimeout(1500);
  assert.equal(seen.length, 1, "the debounce coalesced five changes into one PUT");
  assert.equal((await hubScene(id)).items.length, 5);
  await page.locator("#btnUndo").click();
  assert.equal((await st(page)).items.length, 4);
  await ctx.close();
});

test("a save the hub does not take keeps the picture safe, survives a reload and goes on the next change (Review Focus 2)", async () => {
  let fail = true;
  const { ctx, page, id } = await openRing({ routes: (c) => c.route("**/drawings/*/scene.json",
    (r) => (fail && r.request().method() === "PUT" ? r.abort() : r.continue())) });
  await page.locator("#tile-horse").click();
  await page.waitForTimeout(1200);
  assert.equal((await st(page)).dirty, true);
  const stashed = await page.evaluate((id) => JSON.parse(localStorage.getItem("drawing_scene_" + id)), id);
  assert.equal(stashed.dirty, true);
  assert.equal(stashed.scene.items.length, 1);
  assert.deepEqual((await hubScene(id)).items, [], "the hub never got it");
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Drawing && window.Drawing.state().ready);
  assert.equal((await st(page)).items.length, 1, "a reload before the retry still shows it");
  await page.waitForTimeout(1200);                    // the reload's own retry fails too
  fail = false;
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"star"'));
  await page.locator("#tile-star").click();
  await saved;
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["horse", "star"]);
  assert.equal((await st(page)).dirty, false);
  await ctx.close();
});

test("leaving within the debounce still saves the last sticker (Review Focus 3)", async () => {
  const { ctx, page, id } = await openRing({ routes: (c) => c.route("**/kiosk/exit",
    (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' })) });
  const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith(`/drawings/${id}/scene.json`));
  await page.locator("#tile-person").click();
  await page.locator("#barDoor").click();                // well inside the 800 ms
  assert.deepEqual(JSON.parse((await put).postData()).items.map((i) => i.s), ["person"]);
  await page.waitForTimeout(300);
  assert.deepEqual((await hubScene(id)).items.map((i) => i.s), ["person"]);
  await ctx.close();
});

test("the 200th sticker is the last: a 201st dwell says its word, places nothing, sends nothing (Review Focus 5)", async () => {
  const id = "2026-09-30-120000-cap-dev";
  seed(id, Array.from({ length: 200 }, () => ({ s: "star", x: 0.5, y: 0.2, w: 0.1, by: "ellie" })), "2026-09-30T12:00:00Z");
  const { ctx, page } = await openRing({ id });
  const seen = puts(page);
  await page.locator("#tile-star").click();
  const s = await st(page);
  assert.equal(s.items.length, 200);
  assert.equal(s.said.at(-1), "Star");
  await page.waitForTimeout(1200);
  assert.equal(seen.length, 0);
  await ctx.close();
});
