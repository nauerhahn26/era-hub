// play-ui.test.mjs — the Play app (/play/?w=<week_of>, spec 2026-10-12 §5.1, §5.2, §5.6) in a
// real browser: the menu, Which one? with its two-strike errorless path, the synthesised sounds.
// Harness: watch-ui's — the REAL server.js on this suite's own port with a throwaway ERA_DATA_DIR
// holding one fake week (2026-01-05, "Shadows!", three Which-one items, no sort, no playit); the
// hub serves play.json itself. Only /voices and /tts are routed (as the board suite does); /log
// reaches the real hub and is read off the page's requests. Playwright at 1920x1080 unless a case
// says otherwise. ERA_SHOTS=<dir> saves the menu and a Which-one item for a person to look at.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 8466 — the phase-2 plan's one new port (swept 10/21 across every repo; nothing spawns on it).
const PORT = 8466;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-play-ui-"));
const WEEK = "2026-01-05";
const SHOTS = process.env.ERA_SHOTS || "";

const ITEMS = [
  { id: "aBcDeFgHiJ1", skill: "cause", q: "What makes a shadow?",
    choices: [{ label: "Water", glyph: "💧" },
              { label: "Light is blocked", glyph: "🔦", right: true, sound: "kazoo" },   // a name the library lacks
              { label: "Wind", glyph: "🍃" }] },
  { id: "aBcDeFgHiJ2", skill: "compare", q: "Which shadow is longer?",
    choices: [{ label: "Morning", glyph: "🌅", right: true, sound: "bell-high" },
              { label: "Noon", glyph: "🕛" }] },
  { id: "aBcDeFgHiJ3", skill: "true-false", q: "Can a shadow be in front of you?",
    choices: [{ label: "No", glyph: "👎" }, { label: "Yes", glyph: "👍", right: true }] },
];
// the Sort it week (B2): a second fake week, so the first keeps "no sort, no playit" for B1's cases
const SORT_WEEK = "2026-01-12";
const SORT = { skill: "classify",
  bins: [{ label: "a light source", glyph: "💡" }, { label: "not a light source", glyph: "🌑" }],
  items: [{ label: "the sun", glyph: "☀️", bin: 0 }, { label: "a moon", glyph: "🌙", bin: 1 },
          { label: "a candle", glyph: "🕯️", bin: 0 }, { label: "a book", glyph: "📕", bin: 1 },
          { label: "a torch", glyph: "🔦", bin: 0 }] };
const sortQ = (i) => `Is ${SORT.items[i].label} ${SORT.bins[0].label} or ${SORT.bins[1].label}?`;
let child, browser;

before(async () => {
  const dir = path.join(TMP, "this-week", WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    week_of: WEEK, title: "Shadows!", topic: "shadows", schema: 1, watch: [], talk: [],
    play: { which: ITEMS } }));
  const sdir = path.join(TMP, "this-week", SORT_WEEK);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, "manifest.json"), JSON.stringify({
    week_of: SORT_WEEK, title: "Light!", topic: "shadows", schema: 1, watch: [], talk: [],
    play: { which: [], sort: SORT } }));
  fs.writeFileSync(path.join(TMP, "app-settings.json"), JSON.stringify({ musicVolCap: 40 }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1" },
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

// One page; `logs` = the /log bodies the page posted, `reqs` = every URL it asked for.
async function playPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1920, height: 1080 },
    deviceScaleFactor: 1, reducedMotion: opts.reducedMotion || "no-preference" });
  await ctx.addInitScript((idleMs) => {
    window.__testHooks = true;
    if (idleMs) window.__idleMs = idleMs;
    window.__confettiSeen = 0;
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes)
      if (n.classList && n.classList.contains("confetti")) window.__confettiSeen++; })
      .observe(document, { childList: true, subtree: true });
    // a wiggle lasts 400 ms: record it when it starts rather than racing it
    window.__wiggled = [];
    new MutationObserver((ms) => { for (const m of ms)
      if (m.target.classList && m.target.classList.contains("wiggle")) window.__wiggled.push(m.target.getAttribute("aria-label")); })
      .observe(document, { attributes: true, attributeFilter: ["class"], subtree: true });
  }, opts.idleMs || 0);
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ enabled: false, voices: [] }) }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  const page = await ctx.newPage();
  const logs = [], reqs = [], errors = [];
  page.on("request", (r) => {
    reqs.push(r.url());
    if (r.method() === "POST" && new URL(r.url()).pathname === "/log") logs.push(JSON.parse(r.postData()));
  });
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${BASE}/play/${opts.query ?? "?w=" + WEEK}${opts.hash || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Play && window.Play.state().ready);
  return { ctx, page, logs, reqs, errors };
}
const st = (page) => page.evaluate(() => window.Play.state());
const said = (page) => page.evaluate(() => (window.__speechLog || []).filter((e) => e.call === "say").map((e) => e.text));
const sounds = (page) => page.evaluate(() => (window.__soundLog || []).slice());
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 40)); }
  return false;
};
// her dwell: a short real dwell (dwell.js fires the click itself), after the page-settle window
async function dwellOn(page, sel) {
  await page.evaluate(() => window.Dwell.setMs(300));
  await page.waitForFunction(() => !window.Dwell.state().suppressedMs);
  const rest = await box(page, "#rail .black:last-child");   // away first, onto a rest box: dwell.js re-arms only after a move
  await page.mouse.move(rest.cx, rest.cy);
  const b = await box(page, sel);
  await page.mouse.move(b.cx, b.cy, { steps: 4 });
}
async function openWhich(page) {
  await page.locator("#tile-which").click();
  await page.waitForFunction(() => window.Play.state().page === "which" && document.querySelector(".wh-tile"));
}
const tileFor = (label) => `.wh-tile[aria-label="${label}"]`;
async function waitItem(page, id) {
  await page.waitForFunction((id) => window.Play.state().item === id && !document.querySelector(".wh-tile.alive"), id);
}
// nothing on screen judges or counts (spec §5.2, ux-contract §15-16)
async function neverATest(page) {
  const text = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /wrong|no!|score|points|\bstars?\b|try again/i, text);
  assert.doesNotMatch(text, /\d+\s*(\/|of)\s*\d+/i, "no counter: " + text);
}

// ================================================================ the menu
test("the menu: Back in the rail, only the Which one? tile, in its left seat; Sort and Play seats black", async () => {
  const { ctx, page, errors, reqs } = await playPage();
  const g = await page.evaluate(() => {
    const b = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    return {
      tiles: [...document.querySelectorAll("#stage .dwell")].map((el) => el.id),
      seats: [...document.querySelectorAll("#stage .seat")].map((el) => ({ id: el.id, seat: el.dataset.seat,
        bg: getComputedStyle(el).backgroundColor, dwell: el.matches(".dwell"), text: el.innerText.trim(), ...b(el) })),
      back: { ...b(document.getElementById("btnBack")), dwell: document.getElementById("btnBack").matches(".dwell"),
              text: document.getElementById("btnBack").innerText },
    };
  });
  assert.deepEqual(g.tiles, ["tile-which"], "one engine tile: the week has which items only");
  assert.deepEqual(g.seats.map((s) => s.seat), ["0", "1", "2"]);
  assert.equal(g.seats[0].id, "tile-which");
  assert.match(g.seats[0].text, /Which one\?/);
  for (const s of g.seats.slice(1)) {
    assert.equal(s.bg, "rgb(0, 0, 0)", "an engine without content: its seat black");
    assert.equal(s.dwell, false); assert.equal(s.text, "");
  }
  assert.ok(g.seats[0].x + g.seats[0].w < g.seats[1].x && g.seats[1].x + g.seats[1].w < g.seats[2].x, "left, centre, right");
  assert.ok(g.back.dwell && /Back/.test(g.back.text));
  assert.ok(g.back.x < g.seats[0].x, "Back is in the left rail");
  assert.ok(Math.min(g.seats[0].w, g.seats[0].h) >= 90 && Math.min(g.back.w, g.back.h) >= 90, "≥ 90 px at 1920");
  assert.ok(g.seats[1].x - (g.seats[0].x + g.seats[0].w) >= 13.5, "gaps ≥ 14");
  assert.ok(reqs.some((u) => u === `${BASE}/this-week/${WEEK}/play.json`), "it read play.json");
  for (const u of reqs) assert.ok(u.startsWith(BASE + "/"), "this hub only: " + u);
  await neverATest(page);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "play-menu-1920.png") }); }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("at 1280x720 the menu's tiles and every Which-one tile (three choices) are ≥ 60 px, gaps ≥ 14", async () => {
  const { ctx, page } = await playPage({ viewport: { width: 1280, height: 720 } });
  const mins = (sel) => page.$$eval(sel, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  for (const m of await mins("#btnBack, #tile-which")) assert.ok(m >= 60, "menu " + m);
  await openWhich(page);
  const tiles = await mins(".wh-tile");
  assert.equal(tiles.length, 3);
  for (const m of [...tiles, ...(await mins("#btnBack"))]) assert.ok(m >= 60, "which " + m);
  const xs = await page.$$eval(".wh-seat", (els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right]; }));
  for (let k = 1; k < xs.length; k++) assert.ok(xs[k][0] - xs[k - 1][1] >= 13.5, "gap " + (xs[k][0] - xs[k - 1][1]));
  const fs32 = await page.$$eval(".wh-q, .wh-label", (els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  for (const f of fs32) assert.ok(f >= 32 * 4 / 3, "text ≥ 32 pt: " + f);
  await ctx.close();
});

test("the two doors are the only 2x holds, on the menu and on a Which-one item", async () => {
  const { ctx, page } = await playPage();
  const holds = () => page.evaluate(() => [...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.id + "=" + el.dataset.dwellMs).sort());
  assert.deepEqual(await holds(), ["barDoor=2400", "barTalk=2400"]);
  await openWhich(page);
  assert.deepEqual(await holds(), ["barDoor=2400", "barTalk=2400"], "every content tile holds her dwell (1x)");
  await ctx.close();
});

test("a week that does not exist (or a bad w): the menu with 'Nothing to play yet', said once, and Back", async () => {
  for (const query of ["?w=2026-02-02", "?w=../x", ""]) {
    const { ctx, page, errors, reqs } = await playPage({ query });
    await page.waitForFunction(() => document.querySelector("#strip") && /Nothing to play yet/.test(document.querySelector("#strip").innerText));
    assert.equal(await page.locator("#stage .dwell").count(), 0, query + ": no engine tiles");
    assert.ok(await page.locator("#btnBack.dwell").isVisible(), query + ": Back");
    await until(async () => (await said(page)).length >= 1, 1500);
    await page.waitForTimeout(300);
    assert.deepEqual((await said(page)).filter((t) => /Nothing to play yet/.test(t)).length, 1, query + ": said once");
    for (const u of reqs) assert.ok(u.startsWith(BASE + "/"), "this hub only: " + u);
    assert.deepEqual(errors, [], query);
    await ctx.close();
  }
});

test("Back on the menu goes to the This week board", async () => {
  const { ctx, page } = await playPage();
  await Promise.all([page.waitForURL(`${BASE}/board/?recipe=this-week`, { waitUntil: "commit" }), page.locator("#btnBack").click()]);
  await ctx.close();
});

test("the sound cap is /settings' musicVolCap / 100", async () => {
  const { ctx, page } = await playPage();
  assert.equal((await st(page)).volCap, 0.4);
  await ctx.close();
});

// ================================================================ Which one?
test("Which one?: the first question in the strip, spoken; three choices in left/middle/right in manifest order", async () => {
  const { ctx, page, errors } = await playPage();
  await openWhich(page);
  assert.equal(await page.$eval(".wh-q", (el) => el.innerText.trim()), "What makes a shadow?");
  assert.ok(await until(async () => (await said(page)).includes("What makes a shadow?")), "the question was said");
  const seats = await page.$$eval(".wh-seat", (els) => els.map((el) => ({ seat: el.dataset.seat, label: el.getAttribute("aria-label"),
    dwell: el.matches(".dwell"), glyph: (el.querySelector(".wh-glyph") || {}).textContent, text: (el.querySelector(".wh-label") || {}).textContent })));
  assert.deepEqual(seats.map((s) => s.label), ["Water", "Light is blocked", "Wind"]);
  assert.deepEqual(seats.map((s) => s.glyph), ["💧", "🔦", "🍃"]);
  assert.deepEqual(seats.map((s) => s.text), ["Water", "Light is blocked", "Wind"], "text first: every tile carries its word");
  assert.ok(seats.every((s) => s.dwell));
  // the Back tile on an engine page goes to the menu
  assert.ok(await page.locator("#btnBack.dwell").isVisible());
  await neverATest(page);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "play-which-1920.png") }); }
  await page.locator("#btnBack").click();
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-which"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a dwell on the right tile: it comes alive, its sound plays (pop for a name the library lacks), the pick is logged, the next question appears", async () => {
  const { ctx, page, logs } = await playPage();
  await openWhich(page);
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await dwellOn(page, tileFor("Light is blocked"));
  await page.waitForSelector(tileFor("Light is blocked") + ".alive", { timeout: 3000 });
  const snd = await sounds(page);
  assert.ok(snd.includes("pop"), JSON.stringify(snd));
  assert.ok(!snd.includes("kazoo"), "an unknown name is ignored");
  await waitItem(page, "aBcDeFgHiJ2");
  assert.equal(await page.$eval(".wh-q", (el) => el.innerText.trim()), "Which shadow is longer?");
  assert.ok(await until(() => logs.length >= 1));
  assert.deepEqual(logs[0], { app: "this-week", door: "play", week_of: WEEK, engine: "which",
    item: "aBcDeFgHiJ1", pick: 1, right: true, strike: 0 });
  assert.ok((await said(page)).includes("Which shadow is longer?"), "the next question is said");
  await neverATest(page);
  await ctx.close();
});

test("two choices seat left + right; a miss wiggles and re-asks with 'Look for', a second miss brings the right one alive by itself", async () => {
  const { ctx, page, logs } = await playPage({ hash: "" });
  await openWhich(page);
  await page.locator(tileFor("Light is blocked")).click();
  await waitItem(page, "aBcDeFgHiJ2");
  const seats = await page.$$eval(".wh-seats > *", (els) => els.map((el) => ({ seat: el.dataset.seat, label: el.getAttribute("aria-label"),
    dwell: el.matches(".dwell"), bg: getComputedStyle(el).backgroundColor })));
  assert.deepEqual(seats.map((s) => s.label), ["Morning", null, "Noon"], "left + right, the middle seat empty");
  assert.equal(seats[1].dwell, false); assert.equal(seats[1].bg, "rgb(0, 0, 0)");
  logs.length = 0;
  await page.evaluate(() => { window.__speechLog.length = 0; window.__soundLog.length = 0; });

  // first miss
  await dwellOn(page, tileFor("Noon"));
  await page.waitForFunction(() => window.__wiggled.includes("Noon"), null, { timeout: 3000 });
  assert.ok(await until(() => logs.length >= 1));
  assert.deepEqual(logs[0], { app: "this-week", door: "play", week_of: WEEK, engine: "which",
    item: "aBcDeFgHiJ2", pick: 1, right: false, strike: 1 });
  assert.ok(await until(async () => (await said(page)).some((t) => t === "Which shadow is longer? Look for Morning")),
    JSON.stringify(await said(page)));
  assert.equal(await page.locator(".wh-tile.alive").count(), 0, "nothing comes alive on a first miss");
  const live = await page.$$eval(".wh-tile", (els) => els.map((el) => el.matches(".dwell:not([data-dwell-disabled])")));
  assert.deepEqual(live, [true, true], "both tiles stay live");
  assert.ok((await sounds(page)).includes("pop"), "the picked tile does its small thing");
  assert.equal(await st(page).then((s) => s.item), "aBcDeFgHiJ2", "still on the item");
  await neverATest(page);

  // second miss
  await dwellOn(page, tileFor("Noon"));
  await page.waitForSelector(tileFor("Morning") + ".alive", { timeout: 3000 });
  assert.ok(await until(() => logs.length >= 2));
  assert.deepEqual(logs[1], { app: "this-week", door: "play", week_of: WEEK, engine: "which",
    item: "aBcDeFgHiJ2", pick: 1, right: false, strike: 2 });
  assert.ok((await sounds(page)).includes("bell-high"), "the right one sounds by itself");
  await waitItem(page, "aBcDeFgHiJ3");
  await neverATest(page);
  await ctx.close();
});

test("a yes/no item listed no-first seats yes LEFT and no RIGHT; the pick logs the manifest index", async () => {
  const { ctx, page, logs } = await playPage();
  await openWhich(page);
  await page.locator(tileFor("Light is blocked")).click();
  await waitItem(page, "aBcDeFgHiJ2");
  await page.locator(tileFor("Morning")).click();
  await waitItem(page, "aBcDeFgHiJ3");
  const seats = await page.$$eval(".wh-seats > *", (els) => els.map((el) => el.getAttribute("aria-label")));
  assert.deepEqual(seats, ["Yes", null, "No"]);
  logs.length = 0;
  await page.locator(tileFor("Yes")).click();
  assert.ok(await until(() => logs.length >= 1));
  assert.equal(logs[0].pick, 1, "Yes is index 1 in the manifest");
  assert.equal(logs[0].right, true);
  await ctx.close();
});

test("after the last item: the bigger cheer, 'You did them all!', and the menu", async () => {
  const { ctx, page } = await playPage();
  await openWhich(page);
  for (const [label, next] of [["Light is blocked", "aBcDeFgHiJ2"], ["Morning", "aBcDeFgHiJ3"], ["Yes", null]]) {
    await page.locator(tileFor(label)).click();
    if (next) await waitItem(page, next);
  }
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-which"), null, { timeout: 5000 });
  assert.ok((await page.evaluate(() => window.__confettiSeen)) >= 60 + 24, "confetti ran");
  assert.ok((await said(page)).includes("You did them all!"));
  assert.equal(await page.evaluate(() => location.hash), "#menu");
  await neverATest(page);
  await ctx.close();
});

test("with no pick the question is said once more after the idle wait, and only once", async () => {
  const { ctx, page } = await playPage({ idleMs: 400 });
  await openWhich(page);
  assert.ok(await until(async () => (await said(page)).filter((t) => t === "What makes a shadow?").length === 2, 3000),
    JSON.stringify(await said(page)));
  await page.waitForTimeout(1200);
  assert.equal((await said(page)).filter((t) => t === "What makes a shadow?").length, 2, "once more, not on a loop");
  await ctx.close();
});

test("a reload on #which lands on the first item", async () => {
  const { ctx, page } = await playPage({ hash: "#which" });
  await page.waitForFunction(() => window.Play.state().page === "which" && window.Play.state().item === "aBcDeFgHiJ1");
  await ctx.close();
  // the later engines' routes are stubs that fall back to the menu while the week has none
  for (const hash of ["#sort", "#playit", "#nope"]) {
    const p = await playPage({ hash });
    await p.page.waitForFunction(() => window.Play.state().page === "menu");
    await p.ctx.close();
  }
});

test("reduced motion: the tiles have no transition and nothing animates", async () => {
  const { ctx, page } = await playPage({ reducedMotion: "reduce" });
  await openWhich(page);
  await page.locator(tileFor("Light is blocked")).click();
  const r = await page.$eval(tileFor("Light is blocked"), (el) => {
    const s = getComputedStyle(el);
    return { t: s.transitionDuration, a: s.animationName, alive: el.matches(".alive") };
  });
  assert.ok(r.alive);
  assert.ok(r.t.split(",").every((d) => parseFloat(d) === 0), "no transition: " + r.t);
  assert.equal(r.a, "none");
  await ctx.close();
});

// ================================================================ sounds.js
test("sounds: an unknown name is nothing and never throws; no AudioContext degrades to the log; the master gain is the cap", async () => {
  const { ctx, page } = await playPage();
  const r = await page.evaluate(async () => {
    const { createSounds } = await import("/play/sounds.js");
    window.__soundLog.length = 0;
    const a = createSounds({ volCap: 0.25 });
    a.unlock();
    const out = { unknown: a.play("kazoo"), pop: a.play("pop"), note: a.note(65, "xylophone"), gain: a.state().gain };
    for (const n of ["drum-low", "drum-high", "bell-low", "bell-high", "string-pluck", "whoosh-up", "whoosh-down", "cheer"]) a.play(n);
    a.note(60); a.muffled(true); a.muffled(false);
    const real = window.AudioContext;
    window.AudioContext = undefined; window.webkitAudioContext = undefined;
    const b = createSounds({ volCap: 1 });
    let threw = false;
    try { b.unlock(); out.silentPop = b.play("pop"); b.note(70, "harmonica"); b.play(""); b.play(null); } catch { threw = true; }
    window.AudioContext = real;
    return { ...out, threw, log: window.__soundLog.slice(), noCtx: b.state().ctx };
  });
  assert.equal(r.unknown, false);
  assert.equal(r.pop, true);
  assert.equal(r.threw, false);
  assert.equal(r.noCtx, false);
  assert.equal(r.silentPop, true, "the name is known even with no audio device");
  assert.deepEqual(r.log, ["pop", 65, "drum-low", "drum-high", "bell-low", "bell-high", "string-pluck", "whoosh-up",
    "whoosh-down", "cheer", 60, "muffled", "clear", "pop", 70]);
  if (r.gain !== null) assert.ok(Math.abs(r.gain - 0.25) < 1e-6, "master gain " + r.gain);
  await ctx.close();
});

test("which.js is a module with no page globals: it imports only the kit", () => {
  const src = fs.readFileSync(path.join(HUB, "public", "play", "which.js"), "utf8");
  assert.match(src, /export function mountWhich\(host, item, \{/);
  assert.doesNotMatch(src, /window\.(Play|Speech|Dwell|__)/, "no page globals in which.js");
  for (const m of src.matchAll(/^import .* from "([^"]+)"/gm)) assert.match(m[1], /^\.\.\/lib\//);
});

// ================================================================ Sort it (B2)
const SQ = "?w=" + SORT_WEEK;
async function openSort(page) {
  await page.locator("#tile-sort").click();
  await page.waitForFunction(() => window.Play.state().page === "sort" && document.querySelector(".so-bin"));
}
const itemLabel = (page) => page.$eval("#sortItem .so-label", (el) => el.textContent);
const chips = (page) => page.$$eval(".so-bin", (els) => els.map((b) => [...b.querySelectorAll(".so-tray .so-chip")].map((c) => c.textContent)));
async function waitSortItem(page, i) {
  await page.waitForFunction((i) => window.Play.state().page === "sort" && window.Play.state().idx === i &&
    !document.querySelector("#sortItem.landing") && document.querySelector(".so-bin.dwell:not([data-dwell-disabled])"), i, { timeout: 5000 });
}
// a wobble lasts ~500 ms: record it when it starts
async function watchWobble(page) {
  await page.evaluate(() => {
    window.__wobbled = 0;
    new MutationObserver((ms) => { for (const m of ms)
      if (m.target.id === "sortItem" && m.target.classList.contains("wobble")) window.__wobbled++; })
      .observe(document.getElementById("stage"), { attributes: true, attributeFilter: ["class"], subtree: true });
  });
}

test("Sort it: the menu seats its tile in the centre (🗂️); the Which one? and Play it seats black", async () => {
  const { ctx, page, errors } = await playPage({ query: SQ });
  const g = await page.$$eval("#stage .seat", (els) => els.map((el) => { const r = el.getBoundingClientRect();
    return { id: el.id, seat: el.dataset.seat, dwell: el.matches(".dwell"), bg: getComputedStyle(el).backgroundColor,
             text: el.innerText.trim(), w: r.width, h: r.height }; }));
  assert.deepEqual(g.map((s) => s.id), ["", "tile-sort", ""]);
  assert.equal(g[1].seat, "1");
  assert.match(g[1].text, /🗂️/u); assert.match(g[1].text, /Sort it/);
  assert.ok(g[1].dwell && Math.min(g[1].w, g[1].h) >= 90);
  for (const s of [g[0], g[2]]) { assert.equal(s.bg, "rgb(0, 0, 0)"); assert.equal(s.dwell, false); }
  assert.deepEqual(await st(page).then((s) => s.engines), { which: false, sort: true, playit: false });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Sort it: two bins left and right (glyph + label, ≥ 120 px tall), the item centred and inert, the question shown and spoken", async () => {
  const { ctx, page, errors, reqs } = await playPage({ query: SQ });
  await openSort(page);
  const g = await page.evaluate(() => {
    const b = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2 }; };
    const item = document.getElementById("sortItem");
    return {
      bins: [...document.querySelectorAll(".so-bin")].map((el) => ({ ...b(el), id: el.id, dwell: el.matches(".dwell"),
        label: el.getAttribute("aria-label"), glyph: el.querySelector(".so-glyph").textContent, word: el.querySelector(".so-label").textContent })),
      item: { ...b(item), dwell: !!item.closest(".dwell") || !!item.querySelector(".dwell"),
              glyph: item.querySelector(".so-glyph").textContent, word: item.querySelector(".so-label").textContent },
      stage: b(document.getElementById("stage")),
      q: document.querySelector(".so-q").innerText.trim(),
      dwells: [...document.querySelectorAll("#stage .dwell")].map((el) => el.id),
      fonts: [...document.querySelectorAll(".so-q, .so-bin .so-label, #sortItem .so-label")].map((el) => parseFloat(getComputedStyle(el).fontSize)),
    };
  });
  assert.deepEqual(g.bins.map((x) => [x.id, x.label, x.glyph, x.word]),
    [["bin0", "a light source", "💡", "a light source"], ["bin1", "not a light source", "🌑", "not a light source"]]);
  assert.deepEqual(g.dwells, ["bin0", "bin1"], "the bins are the only dwell targets in the stage");
  assert.ok(g.bins.every((x) => x.dwell && x.h >= 120 && Math.min(x.w, x.h) >= 90), JSON.stringify(g.bins));
  assert.ok(g.bins[0].x + g.bins[0].w < g.item.x && g.item.x + g.item.w < g.bins[1].x, "left bin | item | right bin");
  assert.ok(g.item.x - (g.bins[0].x + g.bins[0].w) >= 13.5 && g.bins[1].x - (g.item.x + g.item.w) >= 13.5, "gaps ≥ 14");
  assert.ok(Math.abs(g.item.cx - g.stage.cx) < 4, "the item is centred");
  assert.equal(g.item.dwell, false, "the item is inert");
  assert.deepEqual([g.item.glyph, g.item.word], ["☀️", "the sun"]);
  assert.equal(g.q, sortQ(0));
  for (const f of g.fonts) assert.ok(f >= 32 * 4 / 3, "text ≥ 32 pt: " + f);
  assert.ok(await until(async () => (await said(page)).includes(sortQ(0))), "the question was said");
  assert.ok(await page.locator("#btnBack.dwell").isVisible());
  const holds = await page.evaluate(() => [...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.id + "=" + el.dataset.dwellMs).sort());
  assert.deepEqual(holds, ["barDoor=2400", "barTalk=2400"], "only the two doors hold 2x");
  assert.deepEqual(await chips(page), [[], []], "the trays start empty");
  for (const u of reqs) assert.ok(u.startsWith(BASE + "/"), "this hub only: " + u);
  await neverATest(page);
  await page.locator("#btnBack").click();
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-sort"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Sort it at 1280x720: bins ≥ 60 px, gaps ≥ 14", async () => {
  const { ctx, page } = await playPage({ query: SQ, viewport: { width: 1280, height: 720 } });
  await openSort(page);
  const g = await page.$$eval(".so-bin, #sortItem, #btnBack", (els) => els.map((el) => { const r = el.getBoundingClientRect();
    return { id: el.id, l: r.left, r: r.right, b: r.bottom, m: Math.min(r.width, r.height) }; }));
  for (const x of g) assert.ok(x.m >= 60, x.id + " " + x.m);
  const [b0, b1, it] = [g.find((x) => x.id === "bin0"), g.find((x) => x.id === "bin1"), g.find((x) => x.id === "sortItem")];
  assert.ok(it.l - b0.r >= 13.5 && b1.l - it.r >= 13.5);
  for (const x of g) assert.ok(x.b <= 720, "on screen: " + x.id);
  await ctx.close();
});

test("Sort it: a dwell on the right bin slides the item in, pops, a glyph lands in the tray, the pick is logged, the next item is asked", async () => {
  const { ctx, page, logs } = await playPage({ query: SQ });
  await openSort(page);
  const tr = await page.$eval("#sortItem", (el) => getComputedStyle(el).transitionDuration);
  assert.ok(tr.split(",").some((d) => Math.abs(parseFloat(d) - 0.5) < 1e-6), "a 500 ms slide: " + tr);
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await dwellOn(page, "#bin0");
  await waitSortItem(page, 1);
  assert.deepEqual(await chips(page), [["☀️"], []], "the sun landed in the light-source tray");
  assert.ok((await sounds(page)).includes("pop"));
  assert.ok(await until(() => logs.length >= 1));
  assert.deepEqual(logs[0], { app: "this-week", door: "play", week_of: SORT_WEEK, engine: "sort",
    item: 0, pick: 0, right: true, strike: 0 });
  assert.equal(await itemLabel(page), "a moon");
  assert.equal(await page.$eval(".so-q", (el) => el.innerText.trim()), sortQ(1));
  assert.ok(await until(async () => (await said(page)).includes(sortQ(1))), "the next question is said");
  await neverATest(page);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "play-sort-1920.png") }); }
  await ctx.close();
});

test("Sort it: a miss wobbles the item back and re-asks; a second miss slides it into the right bin by itself with the cheer", async () => {
  const { ctx, page, logs } = await playPage({ query: SQ });
  await openSort(page);
  await page.locator("#bin0").click();                       // the sun -> a light source
  await waitSortItem(page, 1);                               // a moon (bin 1)
  logs.length = 0;
  await page.evaluate(() => { window.__speechLog.length = 0; window.__soundLog.length = 0; window.__confettiSeen = 0; });
  await watchWobble(page);

  // first miss
  await dwellOn(page, "#bin0");
  await page.waitForFunction(() => window.__wobbled > 0, null, { timeout: 3000 });
  assert.ok(await until(() => logs.length >= 1));
  assert.deepEqual(logs[0], { app: "this-week", door: "play", week_of: SORT_WEEK, engine: "sort",
    item: 1, pick: 0, right: false, strike: 1 });
  assert.ok(await until(async () => (await said(page)).includes(sortQ(1))), "the question again: " + JSON.stringify(await said(page)));
  await page.waitForFunction(() => !document.querySelector("#sortItem.wobble"), null, { timeout: 3000 });
  assert.deepEqual(await chips(page), [["☀️"], []], "nothing landed on a miss");
  assert.equal(await itemLabel(page), "a moon", "the item is back in the middle");
  const live = await page.$$eval(".so-bin", (els) => els.map((el) => el.matches(".dwell:not([data-dwell-disabled])")));
  assert.deepEqual(live, [true, true], "both bins stay live");
  assert.equal(await page.evaluate(() => window.__confettiSeen), 0);
  assert.ok(!(await sounds(page)).includes("cheer"));
  await neverATest(page);

  // second miss
  await dwellOn(page, "#bin0");
  await waitSortItem(page, 2);
  assert.ok(await until(() => logs.length >= 2));
  assert.deepEqual(logs[1], { app: "this-week", door: "play", week_of: SORT_WEEK, engine: "sort",
    item: 1, pick: 0, right: false, strike: 2 });
  assert.deepEqual(await chips(page), [["☀️"], ["🌙"]], "it slid into the right bin by itself");
  assert.ok((await sounds(page)).includes("cheer"), "the cheer");
  assert.ok((await page.evaluate(() => window.__confettiSeen)) > 0, "confetti");
  assert.equal(await itemLabel(page), "a candle");
  await neverATest(page);
  await ctx.close();
});

test("Sort it: after the last item, confetti, 'All sorted!', and the menu", async () => {
  const { ctx, page, logs } = await playPage({ query: SQ });
  await openSort(page);
  for (let i = 0; i < SORT.items.length; i++) {
    await waitSortItem(page, i);
    await page.locator("#bin" + SORT.items[i].bin).click();
  }
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-sort"), null, { timeout: 6000 });
  assert.ok((await page.evaluate(() => window.__confettiSeen)) >= 60, "the bigger cheer");
  assert.ok((await said(page)).includes("All sorted!"));
  assert.equal(await page.evaluate(() => location.hash), "#menu");
  assert.deepEqual(logs.map((l) => [l.engine, l.item, l.pick, l.right, l.strike]),
    SORT.items.map((it, i) => ["sort", i, it.bin, true, 0]));
  await neverATest(page);
  await ctx.close();
});

test("Sort it: with no pick the question is said once more after the idle wait, and only once", async () => {
  const { ctx, page } = await playPage({ query: SQ, idleMs: 400 });
  await openSort(page);
  assert.ok(await until(async () => (await said(page)).filter((t) => t === sortQ(0)).length === 2, 3000),
    JSON.stringify(await said(page)));
  await page.waitForTimeout(1200);
  assert.equal((await said(page)).filter((t) => t === sortQ(0)).length, 2, "once more, not on a loop");
  await ctx.close();
});

test("Sort it: a reload on #sort lands on the first item", async () => {
  const { ctx, page } = await playPage({ query: SQ, hash: "#sort" });
  await page.waitForFunction(() => window.Play.state().page === "sort" && window.Play.state().idx === 0);
  assert.equal(await itemLabel(page), "the sun");
  await ctx.close();
});

test("Sort it under reduced motion: no transition, no animation; the item still lands", async () => {
  const { ctx, page } = await playPage({ query: SQ, reducedMotion: "reduce" });
  await openSort(page);
  const r = await page.$eval("#sortItem", (el) => { const s = getComputedStyle(el); return { t: s.transitionDuration, a: s.animationName }; });
  assert.ok(r.t.split(",").every((d) => parseFloat(d) === 0), "no transition: " + r.t);
  assert.equal(r.a, "none");
  await page.locator("#bin0").click();
  await waitSortItem(page, 1);
  assert.deepEqual(await chips(page), [["☀️"], []]);
  await ctx.close();
});
