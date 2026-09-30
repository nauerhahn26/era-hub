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

// ================================================================ T9 — the grown-up
async function finger(page, from, to, steps = 6) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
    for (let k = 1; k <= steps; k++)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
        touchPoints: [{ x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}
const centreOf = async (page, sel) => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

test("the grown-up's tab sits in the door bar and is never a gaze target", async () => {
  const { ctx, page } = await openRing();
  const t = await page.evaluate(() => {
    const el = document.getElementById("partnerTab");
    return { inBar: !!el.closest(".msgbar"), dwell: el.matches(".dwell"),
             attrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("data-dwell")) };
  });
  assert.deepEqual(t, { inBar: true, dwell: false, attrs: [] });
  await ctx.close();
});

test("the sheet puts every target to sleep but the two doors, says no picture is finished yet, and wakes them on close", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#partnerTab").click();
  let r = await page.evaluate(() => ({ live: [...document.querySelectorAll(".dwell")].map((e) => e.id).sort(),
    asleep: document.querySelectorAll("#sRing [data-dwell-disabled]").length }));
  assert.deepEqual(r, { live: ["barDoor", "barTalk"], asleep: 10 });
  assert.equal(await page.textContent("#pMail"), "No picture finished yet");
  await page.locator("#pClose").click();
  r = await page.evaluate(() => ({ live: document.querySelectorAll("#sRing .dwell").length,
    asleep: document.querySelectorAll("[data-dwell-disabled]").length }));
  assert.deepEqual(r, { live: 10, asleep: 0 });
  await ctx.close();
});

test("dwell tune: 200 ms a tap, clamped 800-3000, and the doors follow at 2x", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#partnerTab").click();
  await page.locator("#pSlower").click();
  assert.equal(await page.evaluate(() => window.Dwell.config.ms), 1400);
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), "2800");
  assert.equal(await page.textContent("#pDwell"), "1400 ms");
  for (let k = 0; k < 12; k++) await page.locator("#pSlower").click();
  assert.equal(await page.evaluate(() => window.Dwell.config.ms), 3000);
  for (let k = 0; k < 20; k++) await page.locator("#pFaster").click();
  assert.equal(await page.evaluate(() => window.Dwell.config.ms), 800);
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), "1600");
  await ctx.close();
});

test("Clear picture: two stages, spoken, the same picture stays open, and the blank picture leaves the shelf", async () => {
  const { ctx, page, id } = await openRing();
  const first = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
  await page.locator("#tile-horse").click();
  await page.locator("#tile-sun").click();
  await first;
  assert.ok((await (await fetch(`${BASE}/drawings/index.json`)).json()).some((p) => p.id === id), "listed while it has stickers");
  await page.locator("#partnerTab").click();
  await page.locator("#pClear").click();
  let s = await st(page);
  assert.equal(s.items.length, 2, "one tap never clears");
  assert.equal(s.said.at(-1), "Clear the whole picture?");
  assert.equal(await page.isVisible("#pClearYes"), true);
  const cleared = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok());
  await page.locator("#pClearYes").click();
  s = await st(page);
  assert.deepEqual([s.items.length, s.id, s.screen, s.history], [0, id, "ring", 0]);
  assert.equal(s.said.at(-1), "All clear! A fresh picture.");
  await cleared;
  assert.ok(!(await (await fetch(`${BASE}/drawings/index.json`)).json()).some((p) => p.id === id), "a blank picture is not listed");
  await ctx.close();
});

test("a grown-up's finger drags a sticker (one move in her history, saved, undoable); a mouse drag never moves it", async () => {
  const { ctx, page } = await openRing();
  await page.locator("#tile-horse").click();
  await page.waitForFunction(() => !document.querySelector(".flyer"));
  const sw = await page.evaluate(() => document.getElementById("scene").getBoundingClientRect().width);
  const from = await centreOf(page, '#scene [data-i="0"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 200, from.y - 50, { steps: 6 });
  await page.mouse.up();
  let s = await st(page);
  assert.deepEqual([s.items[0], s.history], [{ s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }, 1], "a mouse is her gaze: nothing moves");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.ok() && r.request().postData().includes('"partner"'));
  await finger(page, from, { x: from.x - 200, y: from.y - 50 });
  s = await st(page);
  assert.ok(Math.abs(s.items[0].x - (0.5 - 200 / sw)) < 0.01, JSON.stringify(s.items[0]));
  assert.equal(s.items[0].by, "partner");
  assert.equal(s.history, 2);
  await saved;
  await page.locator("#btnUndo").click();
  assert.deepEqual((await st(page)).items[0], { s: "horse", x: 0.5, y: 0.82, w: 0.2, by: "ellie" }, "Undo puts it back");
  await ctx.close();
});

// ================================================================ T10 — the shelf
const PIC_CELLS = ["1,1", "1,2", "1,3", "1,4", "2,1", "2,4", "3,2", "3,3", "3,4"];
const ALL_CELLS = ["1,1", "1,2", "1,3", "1,4", "2,1", "2,2", "2,3", "2,4", "3,1", "3,2", "3,3", "3,4"];
const cellsOf = (page) => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll("#shelfGrid > [data-cell]")) out[el.dataset.cell] = {
    kind: el.classList.contains("shelf-black") ? "black" : el.id === "shelfMore" ? "more" : el.dataset.id ? "pic" : "other",
    id: el.dataset.id || null, dwell: el.classList.contains("dwell"), text: el.textContent.trim(),
    attrs: [...el.attributes].some((a) => a.name.startsWith("data-dwell")),
  };
  return out;
});
// n pictures, newest first, an hour apart back from `base`; returns their ids newest first
function seedShelf(n, base = Date.UTC(2026, 8, 30, 12, 0, 0)) {
  fs.rmSync(PICS, { recursive: true, force: true });
  const ids = [];
  for (let k = 0; k < n; k++) {
    const d = new Date(base - k * 3600e3), s = d.toISOString();
    const id = s.slice(0, 10) + "-" + s.slice(11, 19).replace(/:/g, "") + "-test-dev";
    seed(id, [H(), { s: "sun", x: 0.5, y: 0.17, w: 0.16, by: "ellie" }], s);
    ids.push(id);
  }
  return ids;
}

test("the shelf: New picture in the rail, the centre two black, newest first, More at [3,1] past nine; blank pictures never listed", async () => {
  const ids = seedShelf(11);
  seed("2026-09-30-130000-test-dev", [], "2026-09-30T13:00:00Z");          // blank (and newest): not listed
  const { ctx, page } = await makePage();
  const c = await cellsOf(page);
  assert.deepEqual(Object.keys(c).sort(), [...ALL_CELLS].sort());
  for (const k of ["2,2", "2,3"]) assert.deepEqual([c[k].kind, c[k].dwell, c[k].text, c[k].attrs], ["black", false, "", false], k);
  assert.deepEqual([c["3,1"].kind, c["3,1"].dwell], ["more", true]);
  assert.deepEqual(PIC_CELLS.map((k) => c[k].id), ids.slice(0, 9));
  assert.equal((await st(page)).shelfPages, 2);
  assert.equal(await page.locator("#railNew.dwell").count(), 1);
  // the rail's rows below New picture are black rest boxes like every empty cell (board law; overseer 9/30)
  const rail = await page.evaluate(() => [...document.querySelectorAll("#shelfRail > *")].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id, black: el.classList.contains("shelf-black"), bg: getComputedStyle(el).backgroundColor,
      dwell: el.classList.contains("dwell"), text: el.textContent.trim(), top: r.top, bottom: r.bottom, h: r.height,
      attrs: [...el.attributes].some((a) => a.name.startsWith("data-dwell")) };
  }));
  assert.deepEqual(rail.map((x) => x.id || (x.black ? "black" : "other")), ["railNew", "black", "black"]);
  for (const b of rail.slice(1)) {
    assert.deepEqual([b.bg, b.dwell, b.text, b.attrs], ["rgb(0, 0, 0)", false, "", false], "an inert black rail cell");
    assert.ok(Math.abs(b.h - rail[0].h) < 2 && b.top > rail[0].bottom, "a whole rail row below New picture: " + JSON.stringify(rail));
  }
  await page.locator("#shelfMore").click();
  const c2 = await cellsOf(page);
  assert.deepEqual(PIC_CELLS.map((k) => c2[k].id), [ids[9], ids[10], null, null, null, null, null, null, null]);
  for (const k of PIC_CELLS.slice(2)) assert.equal(c2[k].kind, "black", k);
  await page.locator("#shelfMore").click();
  assert.equal((await st(page)).shelfPage, 0, "More loops back to page 1");
  await ctx.close();
});

test("a shelf cell is her picture drawn from scene.json by the same renderer, with a date plate", async () => {
  const [id] = seedShelf(1);
  const { ctx, page } = await makePage();
  const t = await page.evaluate((id) => {
    const el = document.querySelector(`#shelfGrid [data-id="${id}"]`), th = el.querySelector(".thumb"), r = th.getBoundingClientRect();
    return { items: th.querySelectorAll(".item").length, img: th.querySelector("img.item").getAttribute("src"),
             bg: th.style.background, plate: el.querySelector(".plate").textContent, ratio: r.width / r.height };
  }, id);
  assert.deepEqual([t.items, t.img, t.plate], [2, "stickers/horse.png", "Wed 30 Sep"]);
  assert.match(t.bg, /linear-gradient/);
  assert.ok(Math.abs(t.ratio - 16 / 9) < 0.02, String(t.ratio));
  assert.equal((await cellsOf(page))["3,1"].kind, "black", "one page: [3,1] stays black");
  await ctx.close();
});

test("a picture on the shelf opens the ring on it, and she keeps adding", async () => {
  const [id] = seedShelf(1);
  const { ctx, page } = await makePage();
  await page.locator(`#shelfGrid [data-id="${id}"]`).click();
  await page.waitForFunction(() => window.Drawing.state().screen === "ring");
  assert.deepEqual([(await st(page)).id, (await st(page)).items.length], [id, 2]);
  await page.locator("#tile-star").click();
  assert.equal((await st(page)).items.length, 3);
  await ctx.close();
});

test("New picture: the hub gives it an id, the ring opens empty, and the shelf does not list it yet", async () => {
  seedShelf(0);
  const { ctx, page } = await makePage();
  await page.locator("#railNew").click();
  await page.waitForFunction(() => window.Drawing.state().screen === "ring");
  const s = await st(page);
  assert.match(s.id, /^\d{4}-\d{2}-\d{2}-\d{6}-test-dev(-\d+)?$/);
  assert.equal(s.items.length, 0);
  assert.equal(await page.evaluate(() => location.hash), "#p=" + s.id);
  assert.deepEqual(await (await fetch(`${BASE}/drawings/index.json`)).json(), []);
  assert.ok(fs.existsSync(path.join(PICS, s.id, ".local")), "no Drive folder here: kept on this device, marked .local");
  await ctx.close();
});

test("a picture another device made shows up on the open shelf without a relaunch", async () => {
  seedShelf(1);
  const { ctx, page } = await makePage();
  assert.equal((await st(page)).shelfIds.length, 1);
  seed("2026-09-30-140000-other-dev", [H()], "2026-09-30T14:00:00Z");     // the mirror just carried it in
  await page.evaluate(() => window.Drawing.pollShelf());
  assert.deepEqual((await st(page)).shelfIds.slice(0, 2), ["2026-09-30-140000-other-dev", "2026-09-30-120000-test-dev"]);
  await ctx.close();
});

// ================================================================ T11 — Done
test("Done: a 1600x900 PNG goes to the hub, she hears what she made (never \"sent\"), and the shelf opens with it first", async () => {
  seedShelf(3, Date.now() - 3600e3);                      // older pictures already on the shelf
  const { ctx, page, id } = await openRing();
  for (const t of ["horse", "house", "star", "star"]) await page.locator("#tile-" + t).click();
  const req = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/drawings/${id}/done`));
  await page.locator("#btnDone").click();
  const png = (await req).postDataBuffer();
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1600, 900]);
  await page.waitForFunction(() => window.Drawing.state().screen === "shelf");
  let s = await st(page);
  assert.ok(s.said.includes("You made a picture with a horse, a house and two stars!"), JSON.stringify(s.said));
  assert.ok(!s.said.some((t) => /sent/i.test(t)), "the mail is never spoken");
  assert.equal(s.shelfIds[0], id, "her picture is the first cell");
  await page.waitForFunction(() => window.Drawing.state().lastMail);
  assert.deepEqual((await st(page)).lastMail, { id, saved: true, mail: "no-email" });
  assert.ok(fs.existsSync(path.join(PICS, id, "picture.png")));
  await ctx.close();
});

test("Done on a blank picture: \"You made a picture!\", saved, never mailed, not on the shelf", async () => {
  seedShelf(0);
  const { ctx, page, id } = await openRing();
  await page.locator("#btnDone").click();
  await page.waitForFunction(() => window.Drawing.state().screen === "shelf" && window.Drawing.state().lastMail);
  const s = await st(page);
  assert.ok(s.said.includes("You made a picture!"));
  assert.deepEqual(s.lastMail, { id, saved: true, mail: "empty" });
  assert.deepEqual(s.shelfIds, []);
  assert.ok(fs.existsSync(path.join(PICS, id, "picture.png")), "saved all the same");
  await ctx.close();
});

test("the partner line tells the mail truth, one line per answer", async () => {
  for (const [answer, line] of [
    [{ saved: true, mail: "sent" }, "Sent to your family"],
    [{ saved: true, mail: "no-email" }, "Saved — no family email set up yet"],
    [{ saved: true, mail: "failed", reason: "x" }, "Saved — mail failed, will not retry"],
    [{ saved: true, mail: "unchanged" }, "Saved — already sent, nothing new to send"],
    [{ saved: true, mail: "empty" }, "Saved — the picture is empty, nothing sent"],
    [null, "Not saved — the hub did not answer"],
  ]) {
    const { ctx, page } = await openRing({ routes: (c) => c.route("**/drawings/*/done", (r) => (answer
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) }) : r.abort())) });
    await page.locator("#tile-sun").click();
    await page.locator("#btnDone").click();
    await page.waitForFunction(() => window.Drawing.state().screen === "shelf" && window.Drawing.state().lastMail);
    await page.locator("#partnerTab").click();
    assert.equal(await page.textContent("#pMail"), line, JSON.stringify(answer));
    assert.equal(await page.isVisible("#pClearRow"), false, "Clear lives on the ring only");
    await ctx.close();
  }
});

test("the celebration does not wait for the mail (deviation 9)", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const { ctx, page } = await openRing({ routes: (c) => c.route("**/drawings/*/done", async (r) => { await held; await r.continue(); }) });
  await page.locator("#tile-tree").click();
  await page.locator("#btnDone").click();
  await page.waitForFunction(() => window.Drawing.state().said.some((t) => t.startsWith("You made a picture")), null, { timeout: 3000 });
  assert.equal((await st(page)).lastMail, null, "the mail has not answered yet");
  release();
  await page.waitForFunction(() => window.Drawing.state().lastMail, null, { timeout: 5000 });
  await ctx.close();
});

// ================================================================ T13 — the contract audit, seeded
test("the contract audit is clean on a full shelf and a full ring, at both gate viewports", async () => {
  seedShelf(12);
  const full = "2026-09-30-150000-test-dev";
  seed(full, [H(), { s: "house", x: 0.35, y: 0.75, w: 0.26, by: "ellie" }, { s: "tree", x: 0.65, y: 0.74, w: 0.28, by: "ellie" },
    { s: "person", x: 0.2, y: 0.82, w: 0.22, by: "ellie" }, { s: "sun", x: 0.5, y: 0.17, w: 0.16, by: "ellie" },
    { s: "cloud", x: 0.33, y: 0.25, w: 0.14, by: "ellie" }, { s: "star", x: 0.67, y: 0.25, w: 0.1, by: "ellie" },
    { s: "splat", x: 0.45, y: 0.33, w: 0.15, by: "ellie", c: "#DE7B52", seed: 7 }], "2026-09-30T15:00:00Z");
  process.env.INVARIANTS_BASE = BASE;                    // read when invariants.mjs is first imported
  const { auditPath } = await import("./invariants.mjs");
  for (const state of [{ id: "/drawing/ (12 pictures)", path: "/drawing/" },
                       { id: "/drawing/#ring (every sticker)", path: "/drawing/#p=" + full }]) {
    const r = await auditPath(browser, state);
    for (const v of r.viewports) assert.ok(v.nTargets >= 11, `${state.id} @${v.vp.w}: only ${v.nTargets} targets`);
    assert.deepEqual(r.violations, [], state.id + ":\n" + r.violations.join("\n"));
  }
});
