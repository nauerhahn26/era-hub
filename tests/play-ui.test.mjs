// play-ui.test.mjs — the Play app (/play/?w=<week_of>, spec 2026-10-12 §5.1, §5.2, §5.6) in a
// real browser: the menu, Which one? with its two-strike errorless path, the synthesised sounds.
// Harness: watch-ui's — the REAL server.js on this suite's own port with a throwaway ERA_DATA_DIR
// holding one fake week (2026-01-05, "Shadows!", three Which-one items, no sort, no playit); the
// hub serves play.json itself. Only /voices and /tts are routed (as the board suite does); /log
// reaches the real hub and is read off the page's requests. Playwright at 1920x1080 unless a case
// says otherwise. ERA_SHOTS=<dir> saves the menu and a Which-one item for a person to look at.
// The small boards (spec §5.6 amended 2026-10-25): the menu is the triangle (Which one? top-left,
// Sort it top-right, Play it bottom-centre, black elsewhere), three answers sit in the same
// triangle, two keep the one tall row with the black middle, and the answers are inert and muted
// until the question's first reading has ended (or ARM_CAP_MS when it never reports its end).
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
// the Play it weeks (B3): one small week per instrument, nothing else in them
const PI = {
  "harmonica": { week: "2026-01-19", q: "Which hole plays the lowest note?", answer: 0 },
  "xylophone": { week: "2026-01-26", q: "Which bar makes the highest sound?", answer: 9 },
  "string-telephone": { week: "2026-02-09", q: "Which string carries your voice, tight or loose?", answer: 0 },
  "shadow-puppet": { week: "2026-02-16", q: "Which makes the shadow bigger, closer to the lamp or farther?", answer: 0 },
};
// the full menu (2b): every engine in one week
const ALL_WEEK = "2026-02-23";
const ARM_CAP_MS = 8000;
let child, browser;

before(async () => {
  const adir = path.join(TMP, "this-week", ALL_WEEK);
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, "manifest.json"), JSON.stringify({
    week_of: ALL_WEEK, title: "Everything!", topic: "shadows", schema: 1, watch: [], talk: [],
    play: { which: [ITEMS[1]], sort: SORT, playit: { instrument: "harmonica", q: PI.harmonica.q, answer: 0 } } }));
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
  for (const [instrument, w] of Object.entries(PI)) {
    const d = path.join(TMP, "this-week", w.week);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({
      week_of: w.week, title: "Sound!", topic: "sound", schema: 1, watch: [], talk: [],
      play: { which: [], playit: { instrument, q: w.q, answer: w.answer } } }));
  }
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
  await ctx.addInitScript(([idleMs, clockMs, rng]) => {
    window.__testHooks = true;
    if (idleMs) window.__idleMs = idleMs;
    if (clockMs) window.__clockMs = clockMs;
    // Sort it shuffles with window.__rng (spec §5.6, amended 2026-10-26): pinned to the identity
    // (every Fisher–Yates draw picks its own slot, the manifest order) unless a test hands it a
    // sequence of draws; once the sequence runs out it is the identity again
    { const seq = rng.slice(); window.__rng = () => (seq.length ? seq.shift() : 0.999999); }
    window.__confettiSeen = 0;
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes)
      if (n.classList && n.classList.contains("confetti")) window.__confettiSeen++; })
      .observe(document, { childList: true, subtree: true });
    // a wiggle lasts 400 ms: record it when it starts rather than racing it
    window.__wiggled = [];
    new MutationObserver((ms) => { for (const m of ms)
      if (m.target.classList && m.target.classList.contains("wiggle")) window.__wiggled.push(m.target.getAttribute("aria-label")); })
      .observe(document, { attributes: true, attributeFilter: ["class"], subtree: true });
  }, [opts.idleMs || 0, opts.clockMs || 0, opts.rng || []]);
  // arming: the answers' state when they first appear, and whether the question's `end` was in the
  // speech engine's log at the moment they armed
  if (opts.arming) await ctx.addInitScript(ARM_WATCH);
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ enabled: false, voices: [] }) }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  const page = await ctx.newPage();
  if (opts.clock) await page.clock.install();
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
// every answer tile inert + muted (true) or armed (false)
const waitingState = (page) => page.$$eval(".wh-tile", (els) => els.map((el) => [el.hasAttribute("data-dwell-disabled"), el.classList.contains("wh-waiting")]));
async function waitArmed(page, ms = 3000) {
  await page.waitForFunction(() => { const t = [...document.querySelectorAll(".wh-tile")];
    return t.length > 0 && t.every((el) => !el.hasAttribute("data-dwell-disabled") && !el.classList.contains("wh-waiting")); }, null, { timeout: ms });
}
const ended = (page, text) => page.evaluate((t) => (window.__speechEngineLog || []).some((e) => e.ev === "end" && e.text === t.slice(0, 40)), text);
// an init script (no closures): records the first answers' state and the arming moment
function ARM_WATCH() {
  window.__arm = { first: null, endAtArm: null };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "childList") for (const n of m.addedNodes) {
        if (!n.querySelectorAll || window.__arm.first) continue;
        const t = n.matches(".wh-tile") ? [n] : [...n.querySelectorAll(".wh-tile")];
        if (t.length) window.__arm.first = t.map((el) => el.hasAttribute("data-dwell-disabled") && el.classList.contains("wh-waiting"));
      }
      if (m.type === "attributes" && m.target.classList.contains("wh-tile") && !m.target.hasAttribute("data-dwell-disabled") &&
          window.__arm.endAtArm === null) {
        const q = (document.querySelector(".wh-q") || {}).textContent || "";
        window.__arm.endAtArm = (window.__speechEngineLog || []).some((e) => e.ev === "end" && e.text === q.slice(0, 40));
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-dwell-disabled"] });
}
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
test("the menu: Back in the rail, only the Which one? tile, top-left of the triangle; every other seat black", async () => {
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
  assert.deepEqual(g.seats.map((s) => s.seat), ["0", "1", "2", "3", "4", "5"], "two rows of three, reading order");
  assert.equal(g.seats[0].id, "tile-which");
  assert.match(g.seats[0].text, /Which one\?/);
  for (const s of g.seats.slice(1)) {
    assert.equal(s.bg, "rgb(0, 0, 0)", "an engine without content and every rest seat: black");
    assert.equal(s.dwell, false); assert.equal(s.text, "");
  }
  assert.ok(g.seats[0].x + g.seats[0].w < g.seats[1].x && g.seats[1].x + g.seats[1].w < g.seats[2].x, "row 1: left, centre, right");
  assert.ok(g.seats[3].y >= g.seats[0].y + g.seats[0].h + 13.5, "row 2 under row 1");
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

test("at 1280x720 the menu's tiles and every Which-one tile (three choices, two rows) are ≥ 60 px, gaps ≥ 14, on screen", async () => {
  const { ctx, page } = await playPage({ viewport: { width: 1280, height: 720 } });
  const mins = (sel) => page.$$eval(sel, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  const rects = (sel) => page.$$eval(sel, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
  // both triangles: two rows of three, each row's gaps ≥ 14, the rows ≥ 14 apart, nothing off screen
  const triangle = (s, what) => {
    assert.equal(s.length, 6, what + ": six seats");
    for (const row of [s.slice(0, 3), s.slice(3)])
      for (let k = 1; k < 3; k++) assert.ok(row[k].l - row[k - 1].r >= 13.5, what + " gap " + (row[k].l - row[k - 1].r));
    assert.ok(s[3].t - s[0].b >= 13.5, what + " row gap " + (s[3].t - s[0].b));
    for (const x of s) assert.ok(x.b <= 720 && x.r <= 1280, what + ": on screen");
  };
  for (const m of await mins("#btnBack, #tile-which")) assert.ok(m >= 60, "menu " + m);
  triangle(await rects("#stage .seat"), "menu");
  await openWhich(page);
  const tiles = await mins(".wh-tile");
  assert.equal(tiles.length, 3);
  for (const m of [...tiles, ...(await mins("#btnBack"))]) assert.ok(m >= 60, "which " + m);
  triangle(await rects(".wh-seat"), "which");
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
test("Which one?: the first question in the strip, spoken; three choices in the triangle in manifest order", async () => {
  const { ctx, page, errors } = await playPage();
  await openWhich(page);
  assert.equal(await page.$eval(".wh-q", (el) => el.innerText.trim()), "What makes a shadow?");
  assert.ok(await until(async () => (await said(page)).includes("What makes a shadow?")), "the question was said");
  assert.deepEqual(await page.$$eval(".wh-seats > *", (els) => els.map((el) => el.getAttribute("aria-label"))),
    ["Water", null, "Light is blocked", null, "Wind", null]);
  const seats = await page.$$eval(".wh-tile", (els) => els.map((el) => ({ seat: el.dataset.seat, label: el.getAttribute("aria-label"),
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
  await waitArmed(page);
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
  await waitArmed(page);
  await page.locator(tileFor("Light is blocked")).click();
  await waitItem(page, "aBcDeFgHiJ2");
  await waitArmed(page);
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
  await waitArmed(page);
  await page.locator(tileFor("Light is blocked")).click();
  await waitItem(page, "aBcDeFgHiJ2");
  await waitArmed(page);
  await page.locator(tileFor("Morning")).click();
  await waitItem(page, "aBcDeFgHiJ3");
  await waitArmed(page);
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
    await waitArmed(page);
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
  await waitArmed(page);
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

// ================================================================ the small boards (2b): the triangle and arming
test("three answers sit in the triangle: answer 0 top-left, 1 top-right, 2 bottom-centre, black in the other three", async () => {
  const { ctx, page, errors } = await playPage();
  await openWhich(page);
  const g = await page.evaluate(() => {
    const b = (el) => { const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
    const row = document.querySelector(".wh-seats");
    return { strip: b(document.querySelector(".wh-q")), row: b(row),
      seats: [...row.children].map((el) => ({ seat: el.dataset.seat, i: el.dataset.i ?? null, dwell: el.matches(".dwell"),
        bg: getComputedStyle(el).backgroundColor, ...b(el) })) };
  });
  assert.deepEqual(g.seats.map((s) => s.seat), ["0", "1", "2", "3", "4", "5"]);
  assert.deepEqual(g.seats.map((s) => s.i), ["0", null, "1", null, "2", null], "row 1 col 1, row 1 col 3, row 2 col 2");
  for (const k of [1, 3, 5]) {
    assert.equal(g.seats[k].bg, "rgb(0, 0, 0)", "seat " + k + " black");
    assert.equal(g.seats[k].dwell, false);
  }
  const [a0, m1, a1, l2, a2, r2] = g.seats;
  assert.ok(Math.abs(a0.y - a1.y) < 1 && a0.r < m1.x && m1.r < a1.x, "answers 0 and 1 share the top row, black between them");
  assert.ok(a2.y >= a0.b + 13.5, "answer 2 is a row below: " + a2.y + " vs " + a0.b);
  assert.ok(Math.abs(a2.cx - g.strip.cx) < 4, "answer 2 is centred under the strip: " + a2.cx + " vs " + g.strip.cx);
  assert.ok(l2.r < a2.x && a2.r < r2.x && Math.abs(l2.y - a2.y) < 1 && Math.abs(r2.y - a2.y) < 1, "black either side of answer 2");
  assert.ok(a0.y > g.strip.b && a2.b <= g.row.b + 0.5, "under the question, inside the stage");
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, "play-which-triangle-muted-1920.png") });
    await waitArmed(page);
    await page.screenshot({ path: path.join(SHOTS, "play-which-triangle-armed-1920.png") });
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("two answers keep the one tall row with the black middle", async () => {
  const { ctx, page } = await playPage();
  await openWhich(page);
  await waitArmed(page);
  await page.locator(tileFor("Light is blocked")).click();
  await waitItem(page, "aBcDeFgHiJ2");
  const g = await page.evaluate(() => {
    const row = document.querySelector(".wh-seats"), rr = row.getBoundingClientRect();
    return { row: { y: rr.top, h: rr.height }, seats: [...row.children].map((el) => { const r = el.getBoundingClientRect();
      return { seat: el.dataset.seat, i: el.dataset.i ?? null, y: r.top, h: r.height, bg: getComputedStyle(el).backgroundColor }; }) };
  });
  assert.deepEqual(g.seats.map((s) => [s.seat, s.i]), [["0", "0"], ["1", null], ["2", "1"]]);
  assert.equal(g.seats[1].bg, "rgb(0, 0, 0)");
  for (const s of g.seats) {
    assert.ok(Math.abs(s.y - g.row.y) < 1, "one row");
    assert.ok(Math.abs(s.h - g.row.h) < 1, "tall: the seat fills the row's height " + s.h + " vs " + g.row.h);
  }
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "play-which-two-1920.png") }); }
  await ctx.close();
});

test("arming: the answers are inert and muted while the question is read; a pick then does nothing; after its end they arm and a pick works", async () => {
  const { ctx, page, logs } = await playPage({ arming: true });
  // hold the question's reading open until the test lets it go (the real test-mode reading follows)
  await page.evaluate(() => {
    const orig = window.Speech.say;
    window.Speech.say = (text, kind) => text === "What makes a shadow?" && !window.__held
      ? (window.__held = true, new Promise((res) => { window.__release = () => orig(text, kind).then(res); }))
      : orig(text, kind);
  });
  await openWhich(page);
  assert.deepEqual(await page.evaluate(() => window.__arm.first), [true, true, true], "inert + muted when they appear");
  assert.deepEqual(await waitingState(page), [[true, true], [true, true], [true, true]]);
  const muted = await page.$eval(tileFor("Water"), (el) => { const s = getComputedStyle(el);
    return { opacity: parseFloat(s.opacity), filter: s.filter, td: s.transitionDuration, tp: s.transitionProperty }; });
  assert.ok(Math.abs(muted.opacity - 0.55) < 0.01, "muted: " + JSON.stringify(muted));
  assert.match(muted.filter, /saturate\(0\.6\)/);
  const props = muted.tp.split(",").map((p) => p.trim()), durs = muted.td.split(",").map((d) => parseFloat(d));
  for (const p of ["opacity", "filter"]) { const k = props.indexOf(p); assert.ok(k < 0 || durs[k] <= 0.15, "arming fades in ≤ 150 ms: " + JSON.stringify(muted)); }
  const sayN = (await said(page)).length;
  await page.locator(tileFor("Light is blocked")).click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".wh-tile.alive").count(), 0, "no alive before arming");
  assert.deepEqual(logs, [], "no /log line before arming");
  assert.equal((await said(page)).length, sayN, "no praise, no re-ask");
  assert.deepEqual(await waitingState(page), [[true, true], [true, true], [true, true]], "still waiting");
  await page.evaluate(() => window.__release());
  await waitArmed(page);
  assert.ok(await ended(page, "What makes a shadow?"), "the question's reading ended");
  assert.equal(await page.evaluate(() => window.__arm.endAtArm), true, "armed only once its end was logged");
  await page.locator(tileFor("Light is blocked")).click();
  await page.waitForSelector(tileFor("Light is blocked") + ".alive", { timeout: 3000 });
  assert.ok(await until(() => logs.length >= 1));
  assert.deepEqual(logs[0], { app: "this-week", door: "play", week_of: WEEK, engine: "which",
    item: "aBcDeFgHiJ1", pick: 1, right: true, strike: 0 });
  await ctx.close();
});

test("arming: the real test-mode reading arms the answers at its end, and a miss's re-ask and the idle re-ask never disarm", async () => {
  const { ctx, page, logs } = await playPage({ arming: true, idleMs: 900 });
  await openWhich(page);
  assert.deepEqual(await page.evaluate(() => window.__arm.first), [true, true, true]);
  await waitArmed(page);
  assert.equal(await page.evaluate(() => window.__arm.endAtArm), true, "armed when the question's end was logged");
  await page.locator(tileFor("Water")).click();                       // a miss: the re-ask reads
  assert.ok(await until(async () => (await said(page)).some((t) => /Look for Light is blocked/.test(t))));
  assert.deepEqual(await waitingState(page), [[false, false], [false, false], [false, false]], "the re-ask does not disarm");
  assert.ok(await until(async () => (await said(page)).filter((t) => t === "What makes a shadow?").length === 2, 3000), "the idle re-ask");
  assert.deepEqual(await waitingState(page), [[false, false], [false, false], [false, false]], "the idle re-ask does not disarm");
  await page.locator(tileFor("Light is blocked")).click();
  await page.waitForSelector(tileFor("Light is blocked") + ".alive", { timeout: 3000 });
  assert.ok(await until(() => logs.length >= 2));
  await ctx.close();
});

test("arming: with speech off the answers are armed at once", async () => {
  const { ctx, page } = await playPage();
  await page.evaluate(() => { window.Speech.say = () => Promise.resolve(); window.Speech.mode = () => "off"; });
  await openWhich(page);
  assert.deepEqual(await waitingState(page), [[false, false], [false, false], [false, false]], "armed when they appear");
  await ctx.close();
});

test("arming: a reading that never reports its end arms the answers at ARM_CAP_MS", async () => {
  const { ctx, page } = await playPage({ clock: true });
  await page.evaluate(() => { window.Speech.say = () => new Promise(() => {}); });
  await openWhich(page);
  assert.deepEqual(await waitingState(page), [[true, true], [true, true], [true, true]]);
  await page.clock.fastForward(ARM_CAP_MS - 1000);
  assert.deepEqual(await waitingState(page), [[true, true], [true, true], [true, true]], "still waiting before the cap");
  await page.clock.fastForward(1100);
  await waitArmed(page, 1000);
  await ctx.close();
});

test("the menu with every engine: Which one? top-left, Sort it top-right, Play it bottom-centre, black in the other three", async () => {
  const { ctx, page, errors } = await playPage({ query: "?w=" + ALL_WEEK });
  const g = await page.evaluate(() => {
    const strip = document.getElementById("strip").getBoundingClientRect();
    return { stripCx: strip.left + strip.width / 2, stripB: strip.bottom,
      seats: [...document.querySelectorAll("#stage .seats > *")].map((el) => { const r = el.getBoundingClientRect();
        return { id: el.id, seat: el.dataset.seat, dwell: el.matches(".dwell"), bg: getComputedStyle(el).backgroundColor,
                 x: r.left, y: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, w: r.width, h: r.height }; }) };
  });
  assert.deepEqual(g.seats.map((s) => s.id), ["tile-which", "", "tile-sort", "", "tile-playit", ""]);
  assert.deepEqual(g.seats.map((s) => s.seat), ["0", "1", "2", "3", "4", "5"]);
  for (const k of [1, 3, 5]) { assert.equal(g.seats[k].bg, "rgb(0, 0, 0)"); assert.equal(g.seats[k].dwell, false); }
  const [w, , s, , p] = g.seats;
  assert.ok(w.dwell && s.dwell && p.dwell);
  assert.ok(Math.abs(w.y - s.y) < 1 && w.r < s.x, "Which one? and Sort it share the top row");
  assert.ok(p.y >= w.b + 13.5, "Play it is a row below");
  assert.ok(Math.abs(p.cx - g.stripCx) < 4, "Play it is centred under the strip");
  assert.ok(w.y > g.stripB);
  for (const t of [w, s, p]) assert.ok(Math.min(t.w, t.h) >= 90, "≥ 90 px at 1920");
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "play-menu-all-1920.png") }); }
  assert.deepEqual(errors, []);
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

test("Sort it: the menu seats its tile top-right of the triangle (🗂️); the Which one? and Play it seats black", async () => {
  const { ctx, page, errors } = await playPage({ query: SQ });
  const g = await page.$$eval("#stage .seat", (els) => els.map((el) => { const r = el.getBoundingClientRect();
    return { id: el.id, seat: el.dataset.seat, dwell: el.matches(".dwell"), bg: getComputedStyle(el).backgroundColor,
             text: el.innerText.trim(), w: r.width, h: r.height }; }));
  assert.deepEqual(g.map((s) => s.id), ["", "", "tile-sort", "", "", ""]);
  assert.equal(g[2].seat, "2");
  assert.match(g[2].text, /🗂️/u); assert.match(g[2].text, /Sort it/);
  assert.ok(g[2].dwell && Math.min(g[2].w, g[2].h) >= 90);
  for (const s of g.filter((_, k) => k !== 2)) { assert.equal(s.bg, "rgb(0, 0, 0)"); assert.equal(s.dwell, false); }
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

// ---- Sort it shuffles (spec §5.6, amended 2026-10-26): every open deals the items afresh, and
// never opens on the previous play's first item for the same week
// the draws a descending Fisher–Yates over 5 items needs to reverse them: j = 0, 1, 2, 1
const REVERSE5 = [0.1, 0.375, 0.99, 0.75];
const order = (page) => page.evaluate(() => { try { return sessionStorage.getItem("era-sort-first:2026-01-12"); } catch { return "throws"; } });

test("Sort it shuffles: a reversing draw opens on the manifest's last item; the questions and the logs follow the dealt order; the bins keep their seats", async () => {
  // reduced motion: the dealing is the subject here, not the slide (land() takes 0 ms instead of
  // SLIDE_MS; the animated slide stays pinned by the Sort it cases above)
  const { ctx, page, logs, errors } = await playPage({ query: SQ, rng: REVERSE5, reducedMotion: "reduce" });
  await openSort(page);
  const dealt = [4, 3, 2, 1, 0];
  const bins = await page.$$eval(".so-bin", (els) => els.map((el) => [el.id, el.dataset.seat, el.getAttribute("aria-label"),
    el.querySelector(".so-glyph").textContent]));
  assert.deepEqual(bins, [["bin0", "0", "a light source", "💡"], ["bin1", "2", "not a light source", "🌑"]], "the bins never move");
  assert.equal(await page.$eval(".so-mid", (el) => el.dataset.seat), "1");
  for (let k = 0; k < dealt.length; k++) {
    const m = dealt[k];
    await waitSortItem(page, k);
    assert.equal(await itemLabel(page), SORT.items[m].label, "dealt item " + k);
    assert.equal(await page.$eval(".so-q", (el) => el.innerText.trim()), sortQ(m));
    assert.ok(await until(async () => (await said(page)).includes(sortQ(m))), "its question is said: " + sortQ(m));
    assert.equal((await st(page)).item, m, "the page holds the manifest index of the item up");
    if (k === 0) assert.equal(await order(page), "4", "the first item is remembered for the week");
    await page.locator("#bin" + SORT.items[m].bin).click();
  }
  await page.waitForFunction(() => window.Play.state().page === "menu", null, { timeout: 6000 });
  assert.deepEqual(logs.map((l) => [l.engine, l.item, l.pick, l.right, l.strike]),
    dealt.map((m) => ["sort", m, SORT.items[m].bin, true, 0]), "the log carries the manifest index, in the dealt order");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Sort it shuffles: an open whose deal would repeat the last play's first item rotates it away; the next open is free again", async () => {
  // identity draws: the sun every time; reduced motion, as above
  const { ctx, page, errors } = await playPage({ query: SQ, reducedMotion: "reduce" });
  await openSort(page);
  assert.equal(await itemLabel(page), "the sun");
  assert.equal(await order(page), "0");
  await page.locator("#btnBack").click();
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-sort"));
  await openSort(page);
  assert.equal(await itemLabel(page), "a moon", "never the same first item twice in a row");
  assert.equal(await page.$eval(".so-q", (el) => el.innerText.trim()), sortQ(1));
  assert.equal(await order(page), "1");
  // rotated by one: the rest follow, the old first item comes last
  for (const [k, m] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]]) {
    await waitSortItem(page, k);
    assert.equal(await itemLabel(page), SORT.items[m].label, "rotated item " + k);
    await page.locator("#bin" + SORT.items[m].bin).click();
  }
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-sort"), null, { timeout: 6000 });
  await openSort(page);
  assert.equal(await itemLabel(page), "the sun", "the sun differs from the moon, so no rotation");
  assert.equal(await order(page), "0");
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ================================================================ Play it (B3)
const PQ = (inst) => "?w=" + PI[inst].week;
const SHOT_DIR = () => { fs.mkdirSync(SHOTS, { recursive: true }); return SHOTS; };
async function openPlayit(page) {
  await page.locator("#tile-playit").click();
  await page.waitForFunction(() => window.Play.state().page === "playit" && document.querySelector(".pi-pos"));
}
const positions = (page) => page.$$eval(".pi-pos", (els) => els.map((el) => { const r = el.getBoundingClientRect();
  return { i: Number(el.dataset.i), label: el.getAttribute("aria-label"), dwell: el.matches(".dwell"),
           x: r.left, r: r.right, y: r.top, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
const playLogs = (logs) => logs.filter((l) => l.engine === "playit");
// classes that come and go (alive while a note sounds, the wave on the string): record them as they appear
async function watchClasses(page) {
  await page.evaluate(() => {
    window.__seen = [];
    window.__classFeedback = [];
    const aliveState = new WeakMap();
    new MutationObserver((ms) => { for (const m of ms) {
      const t = m.target; if (!t.classList) continue;
      if (t.matches('.pi-pos')) {
        const alive = t.classList.contains('alive');
        if ((aliveState.get(t) || false) !== alive) {
          aliveState.set(t, alive);
          const rect = t.getBoundingClientRect();
          window.__classFeedback.push({ i: Number(t.dataset.i), alive, at: performance.now(),
            visible: rect.width > 0 && rect.height > 0 && getComputedStyle(t).visibility === 'visible' });
        }
      }
      for (const c of ["alive", "wave"]) if (t.classList.contains(c)) window.__seen.push((t.dataset.i != null ? t.dataset.i : (t.id || t.className)) + "." + c);
    } }).observe(document.getElementById("stage"), { attributes: true, attributeFilter: ["class"], subtree: true });
  });
}
const seen = (page) => page.evaluate(() => window.__seen.slice());
// every word sits whole inside its tile: one line, not clipped
async function wordsFit(page, what) {
  const bad = await page.$$eval("#stage .pi-tile .pi-word", (els) => els.filter((el) => {
    const t = el.closest(".pi-tile").getBoundingClientRect(), r = el.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).fontSize) * 1.5;
    return r.height > lh || r.left < t.left - 0.5 || r.right > t.right + 0.5;
  }).map((el) => el.textContent));
  assert.deepEqual(bad, [], what + ": words that wrap or spill");
}
const holds2x = (page) => page.evaluate(() => [...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.id + "=" + el.dataset.dwellMs).sort());

test("Play it: the menu seats its tile bottom-centre of the triangle with the instrument's glyph; the other seats black", async () => {
  const glyph = { "harmonica": "🎵", "xylophone": "🎵", "string-telephone": "☎️", "shadow-puppet": "🔦" };
  for (const inst of Object.keys(PI)) {
    const { ctx, page, errors } = await playPage({ query: PQ(inst) });
    const g = await page.$$eval("#stage .seat", (els) => els.map((el) => ({ id: el.id, seat: el.dataset.seat,
      dwell: el.matches(".dwell"), bg: getComputedStyle(el).backgroundColor, text: el.innerText.trim() })));
    assert.deepEqual(g.map((s) => s.id), ["", "", "", "", "tile-playit", ""], inst);
    assert.equal(g[4].seat, "4");
    assert.ok(g[4].text.includes(glyph[inst]), inst + ": " + g[4].text);
    assert.match(g[4].text, /Play it/);
    for (const s of g.filter((_, k) => k !== 4)) { assert.equal(s.bg, "rgb(0, 0, 0)"); assert.equal(s.dwell, false); }
    assert.deepEqual((await st(page)).engines, { which: false, sort: false, playit: true });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("Play it, harmonica: ten holes left to right, ≥ 90 px at 1920; hole 3 plays MIDI 65, its reed comes alive while it sounds, the pick is logged with no right", async () => {
  const { ctx, page, logs, errors, reqs } = await playPage({ query: PQ("harmonica") });
  await openPlayit(page);
  const pos = await positions(page);
  assert.equal(pos.length, 10);
  assert.deepEqual(pos.map((p) => p.i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (let k = 1; k < 10; k++) assert.ok(pos[k].x - pos[k - 1].r >= 13.5, "left to right, gap ≥ 14: " + (pos[k].x - pos[k - 1].r));
  assert.ok(pos.every((p) => p.dwell && Math.min(p.w, p.h) >= 90), JSON.stringify(pos.map((p) => [p.w, p.h])));
  assert.equal(await page.locator(".pi-hole .pi-reed").count(), 10, "a reed strip over every hole");
  assert.equal(await page.locator("#piQ").count(), 0, "free play first: no question");
  assert.deepEqual(await holds2x(page), ["barDoor=2400", "barTalk=2400"], "only the two doors hold 2x");
  assert.ok(await page.locator("#btnBack.dwell").isVisible());
  await watchClasses(page);
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await dwellOn(page, '.pi-pos[data-i="3"]');
  await page.waitForSelector('.pi-pos[data-i="3"].alive', { timeout: 3000 });
  assert.deepEqual(await sounds(page), [65]);
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR(), "playit-harmonica-1920.png") });
  await page.waitForFunction(() => !document.querySelector('.pi-pos[data-i="3"].alive'), null, { timeout: 3000 });
  assert.ok(await until(() => playLogs(logs).length >= 1));
  assert.deepEqual(playLogs(logs)[0], { app: "this-week", door: "play", week_of: PI.harmonica.week, engine: "playit",
    instrument: "harmonica", pick: 3 });
  // every hole has its own note, low to high
  await page.evaluate(() => { window.__soundLog.length = 0; });
  for (let i = 0; i < 10; i++) await page.locator(`.pi-pos[data-i="${i}"]`).click();
  assert.deepEqual(await sounds(page), [60, 62, 64, 65, 67, 69, 71, 72, 74, 76]);
  for (const u of reqs) assert.ok(u.startsWith(BASE + "/"), "this hub only: " + u);
  await neverATest(page);
  await page.locator("#btnBack").click();
  await page.waitForFunction(() => window.Play.state().page === "menu" && document.getElementById("tile-playit"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Play it at 1280x720: ten harmonica holes and ten xylophone bars are each ≥ 60 px with gaps ≥ 14, on screen", async () => {
  for (const inst of ["harmonica", "xylophone"]) {
    const { ctx, page } = await playPage({ query: PQ(inst), viewport: { width: 1280, height: 720 } });
    await openPlayit(page);
    const pos = await positions(page);
    assert.equal(pos.length, 10);
    console.log(`# ${inst} at 1280x720: ` + pos.map((p) => Math.round(p.w) + "x" + Math.round(p.h)).join(" "));
    for (const p of pos) { assert.ok(Math.min(p.w, p.h) >= 60, inst + " " + p.w + "x" + p.h); assert.ok(p.b <= 720 && p.r <= 1280); }
    for (let k = 1; k < 10; k++) assert.ok(pos[k].x - pos[k - 1].r >= 13.5, inst + " gap " + (pos[k].x - pos[k - 1].r));
    await ctx.close();
  }
  for (const inst of ["string-telephone", "shadow-puppet"]) {
    const { ctx, page } = await playPage({ query: PQ(inst), viewport: { width: 1280, height: 720 } });
    await openPlayit(page);
    const m = await page.$$eval("#stage .dwell, #btnBack", (els) => els.map((el) => { const r = el.getBoundingClientRect();
      return { id: el.id || el.className, m: Math.min(r.width, r.height), b: r.bottom }; }));
    for (const x of m) { assert.ok(x.m >= 60, inst + " " + x.id + " " + x.m); assert.ok(x.b <= 720, inst + " on screen " + x.id); }
    const fonts = await page.$$eval("#stage .pi-word, .pi-name", (els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    for (const f of fonts) assert.ok(f >= 32 * 4 / 3, inst + " text ≥ 32 pt: " + f);
    await wordsFit(page, inst + " at 1280");
    await ctx.close();
  }
});

test("Play it, xylophone: ten bars, longest to shortest left to right; bar 0 rings MIDI 60 and comes alive", async () => {
  const { ctx, page, logs, errors } = await playPage({ query: PQ("xylophone") });
  await openPlayit(page);
  const pos = await positions(page);
  assert.equal(pos.length, 10);
  assert.equal(await page.locator(".pi-bar.pi-pos").count(), 10);
  for (let k = 1; k < 10; k++) {
    assert.ok(pos[k].x > pos[k - 1].r, "left to right");
    assert.ok(pos[k].h < pos[k - 1].h, "each bar shorter than the one before: " + pos.map((p) => Math.round(p.h)).join(" "));
  }
  assert.ok(pos.every((p) => p.dwell && Math.min(p.w, p.h) >= 90));
  await watchClasses(page);
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await dwellOn(page, '.pi-pos[data-i="0"]');
  // The highlight lasts 500 ms. Latch its actual visible class transition
  // before the real dwell rather than racing it from a subsequent poll.
  await page.waitForFunction(() => window.__classFeedback.some(e => e.i === 0 && e.alive && e.visible), null, { timeout: 3000 });
  assert.deepEqual(await sounds(page), [60]);
  assert.ok(await until(() => playLogs(logs).length >= 1));
  assert.deepEqual(playLogs(logs)[0], { app: "this-week", door: "play", week_of: PI.xylophone.week, engine: "playit",
    instrument: "xylophone", pick: 0 });
  await neverATest(page);
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR(), "playit-xylophone-1920.png") });
  assert.deepEqual(errors, []);
  await page.waitForFunction(() => window.__classFeedback.some(e => e.i === 0 && !e.alive), null, { timeout: 3000 });
  const feedback = await page.evaluate(() => window.__classFeedback.filter(e => e.i === 0));
  assert.equal(feedback[0].alive, true);
  assert.equal(feedback[1].alive, false);
  assert.ok(feedback[1].at - feedback[0].at >= 450, 'the visible note feedback retains its half-second duration');
  await ctx.close();
});

test("Play it, string telephone: Tight left, Loose right, her cup and the far cup; tight + her cup -> a wave runs and hello plays clear; loose -> muffled", async () => {
  const { ctx, page, logs, errors } = await playPage({ query: PQ("string-telephone") });
  await openPlayit(page);
  const pos = await positions(page);
  assert.deepEqual(pos.map((p) => [p.i, p.label]), [[0, "Tight"], [1, "Loose"]]);
  assert.ok(pos[0].r < pos[1].x, "tight left, loose right");
  assert.ok(pos.every((p) => p.dwell && Math.min(p.w, p.h) >= 90));
  const cups = await page.evaluate(() => ({ her: !!document.querySelector("#piCup.dwell"),
    far: !!document.getElementById("piFar") && !document.querySelector("#piFar.dwell, #piFar .dwell"),
    string: !!document.getElementById("piString"),
    dwells: [...document.querySelectorAll("#stage .dwell")].map((el) => el.id).sort() }));
  assert.ok(cups.her && cups.far && cups.string, JSON.stringify(cups));
  assert.deepEqual(cups.dwells, ["piCup", "pos0", "pos1"], "the two strings and her cup are the only dwell targets");
  const cup = await box(page, "#piCup"), far = await box(page, "#piFar");
  assert.ok(Math.min(cup.w, cup.h) >= 90 && cup.cx < far.cx, "her cup on the left, ≥ 90 px");
  await wordsFit(page, "telephone at 1920");
  await watchClasses(page);

  await page.locator("#pos0").click();                               // tight
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await dwellOn(page, "#piCup");
  await page.waitForFunction(() => window.__seen.includes("piString.wave"), null, { timeout: 3000 });
  assert.ok(await until(async () => (await sounds(page)).includes("hello"), 3000), JSON.stringify(await sounds(page)));
  const s1 = await sounds(page);
  assert.deepEqual(s1.slice(s1.indexOf("hello") - 1, s1.indexOf("hello") + 1), ["clear", "hello"], JSON.stringify(s1));
  await page.waitForFunction(() => !document.querySelector("#piString.wave"), null, { timeout: 3000 });

  await page.locator("#pos1").click();                               // loose
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await page.locator("#piCup").click();
  assert.ok(await until(async () => (await sounds(page)).includes("hello"), 3000));
  const s2 = await sounds(page);
  assert.deepEqual(s2.slice(s2.indexOf("hello") - 1, s2.indexOf("hello") + 1), ["muffled", "hello"], JSON.stringify(s2));
  assert.ok(await until(async () => (await sounds(page)).includes("clear"), 3000), "the muffle comes off after the call");

  const pl = playLogs(logs);
  assert.deepEqual(pl.filter((l) => "pick" in l).map((l) => l.pick), [0, 1]);
  assert.ok(pl.every((l) => !("right" in l) && !("strike" in l)), "free play: no right, no strike");
  assert.deepEqual(pl.filter((l) => l.talk).map((l) => l.string), ["tight", "loose"], "the cup's calls are logged too");
  await neverATest(page);
  if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR(), "playit-string-telephone-1920.png") });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Play it, shadow puppet: Closer left, Farther right, four shapes under the scene; closer grows the shadow to 1.6, farther shrinks it to 0.7", async () => {
  const { ctx, page, logs, errors } = await playPage({ query: PQ("shadow-puppet") });
  await openPlayit(page);
  const pos = await positions(page);
  assert.deepEqual(pos.map((p) => [p.i, p.label]), [[0, "Closer"], [1, "Farther"]]);
  assert.ok(pos[0].r < pos[1].x && pos.every((p) => p.dwell && Math.min(p.w, p.h) >= 90));
  const shapes = await page.$$eval(".pi-shape", (els) => els.map((el) => { const r = el.getBoundingClientRect();
    return { shape: el.dataset.shape, glyph: el.querySelector(".pi-glyph").textContent, dwell: el.matches(".dwell"),
             hold: el.dataset.dwellMs || null, y: r.top, m: Math.min(r.width, r.height) }; }));
  assert.deepEqual(shapes.map((s) => [s.shape, s.glyph]), [["bat", "🦇"], ["bird", "🐦"], ["rabbit", "🐰"], ["dog", "🐕"]]);
  const scene = await box(page, "#piScene");
  assert.ok(shapes.every((s) => s.dwell && s.hold === null && s.m >= 90 && s.y >= scene.y + scene.h), "1x tiles under the scene");
  for (const id of ["piLamp", "piPuppet", "piWall", "piShadow"]) assert.equal(await page.locator("#" + id).count(), 1, id);
  await wordsFit(page, "puppet at 1920");
  const scale = () => page.$eval("#piShadow", (el) => Number(el.dataset.scale));
  assert.equal(await scale(), 1);
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await dwellOn(page, "#pos0");
  await page.waitForFunction(() => document.getElementById("piShadow").dataset.scale === "1.6", null, { timeout: 3000 });
  assert.ok((await sounds(page)).length >= 1, "the move sounds");
  // the shadow grows over its 600 ms transition: read the painted scale once it has settled
  await page.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.getElementById("piShadow")).transform).a - 1.6) < 0.01,
    null, { timeout: 3000 }).catch(() => {});
  const grown = await page.$eval("#piShadow", (el) => new DOMMatrix(getComputedStyle(el).transform).a);
  await page.locator("#pos1").click();
  assert.equal(await scale(), 0.7);
  await page.locator('.pi-shape[data-shape="rabbit"]').click();
  assert.equal(await page.$eval("#piPuppet", (el) => el.textContent), "🐰");
  assert.equal(await page.$eval("#piShadow", (el) => el.textContent), "🐰");
  assert.ok(Math.abs(grown - 1.6) < 0.01, "the shadow's painted scale grew to 1.6: " + grown);
  const pl = playLogs(logs);
  assert.deepEqual(pl.filter((l) => "pick" in l).map((l) => l.pick), [0, 1]);
  assert.ok(pl.some((l) => l.shape === "rabbit"));
  assert.ok(pl.every((l) => !("right" in l)));
  assert.deepEqual(await holds2x(page), ["barDoor=2400", "barTalk=2400"]);
  await neverATest(page);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Play it: the question waits for 60 s of play from the FIRST pick; then it is shown and said; a right pick comes alive with the cheer; the question never returns", async () => {
  const { ctx, page, logs, errors } = await playPage({ query: PQ("harmonica"), clockMs: 700 });
  await openPlayit(page);
  await page.waitForTimeout(1100);
  assert.equal(await page.locator("#piQ").count(), 0, "nobody played: no question");
  await page.locator('.pi-pos[data-i="4"]').click();                 // the clock starts here
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#piQ").count(), 0, "still free play");
  await page.waitForSelector("#piQ", { timeout: 3000 });
  assert.equal(await page.$eval("#piQ", (el) => el.innerText.trim()), PI.harmonica.q);
  assert.ok(await until(async () => (await said(page)).includes(PI.harmonica.q)), "the question was said");
  const f = await page.$eval("#piQ", (el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(f >= 32 * 4 / 3, "≥ 32 pt: " + f);
  logs.length = 0;
  await page.evaluate(() => { window.__soundLog.length = 0; window.__confettiSeen = 0; });
  await dwellOn(page, '.pi-pos[data-i="0"]');
  await page.waitForSelector('.pi-pos[data-i="0"].alive', { timeout: 3000 });
  assert.ok(await until(async () => (await sounds(page)).includes("cheer")), JSON.stringify(await sounds(page)));
  assert.ok((await sounds(page)).includes(60), "the hole still plays its note");
  assert.ok((await page.evaluate(() => window.__confettiSeen)) > 0, "confetti");
  assert.ok(await until(() => playLogs(logs).length >= 1));
  assert.deepEqual(playLogs(logs)[0], { app: "this-week", door: "play", week_of: PI.harmonica.week, engine: "playit",
    instrument: "harmonica", pick: 0, right: true, strike: 0 });
  await page.waitForFunction(() => !document.getElementById("piQ"), null, { timeout: 4000 });
  // free play goes on, and the question does not come back
  logs.length = 0;
  await page.evaluate(() => { window.__soundLog.length = 0; });
  await page.locator('.pi-pos[data-i="9"]').click();
  assert.ok((await sounds(page)).includes(76));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator("#piQ").count(), 0, "the question never returns");
  assert.ok(await until(() => playLogs(logs).length >= 1));
  assert.deepEqual(playLogs(logs)[0], { app: "this-week", door: "play", week_of: PI.harmonica.week, engine: "playit",
    instrument: "harmonica", pick: 9 });
  await neverATest(page);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Play it: a first miss does its own thing and re-asks with the instrument's hint; a second miss lights the right position by itself with the cheer", async () => {
  const cases = [
    { inst: "harmonica", miss: [5, 7], hint: "Listen for the low one", rightNote: 60 },
    { inst: "xylophone", miss: [2, 4], hint: "Listen for the high one", rightNote: 76 },
    { inst: "string-telephone", miss: [1, 1], hint: "Try the tight string" },
    { inst: "shadow-puppet", miss: [1, 1], hint: "Move it closer" },
  ];
  for (const c of cases) {
    const w = PI[c.inst];
    const { ctx, page, logs, errors } = await playPage({ query: PQ(c.inst), clockMs: 300 });
    await openPlayit(page);
    await page.locator(`.pi-pos[data-i="${c.miss[0]}"]`).click();      // free play starts the clock
    await page.waitForSelector("#piQ", { timeout: 3000 });
    if (SHOTS && c.inst === "shadow-puppet") await page.screenshot({ path: path.join(SHOT_DIR(), "playit-shadow-puppet-question-1920.png") });
    logs.length = 0;
    await page.waitForTimeout(400);                                  // let the free-play sound settle
    await watchClasses(page);
    await page.evaluate(() => { window.__speechLog.length = 0; window.__soundLog.length = 0; window.__confettiSeen = 0; });
    // first miss
    await page.locator(`.pi-pos[data-i="${c.miss[0]}"]`).click();
    assert.ok(await until(() => playLogs(logs).length >= 1));
    assert.deepEqual(playLogs(logs)[0], { app: "this-week", door: "play", week_of: w.week, engine: "playit",
      instrument: c.inst, pick: c.miss[0], right: false, strike: 1 }, c.inst);
    assert.ok(await until(async () => (await said(page)).includes(w.q + " " + c.hint)), c.inst + ": " + JSON.stringify(await said(page)));
    assert.ok((await sounds(page)).length >= 1, c.inst + ": the picked position does its own thing");
    assert.ok(!(await sounds(page)).includes("cheer"), c.inst + ": no cheer on a first miss");
    assert.ok(!(await seen(page)).includes(w.answer + ".alive"), c.inst + ": the right one did not light");
    assert.equal(await page.locator("#piQ").count(), 1, c.inst + ": the question stays up");
    assert.ok((await positions(page)).every((p) => p.dwell), "every position stays live");
    await neverATest(page);
    // second miss
    await page.locator(`.pi-pos[data-i="${c.miss[1]}"]`).click();
    await page.waitForSelector(`.pi-pos[data-i="${w.answer}"].alive`, { timeout: 3000 });
    assert.ok(await until(async () => (await sounds(page)).includes("cheer")), c.inst);
    if (c.rightNote) assert.ok((await sounds(page)).includes(c.rightNote), c.inst + ": the right one sounds by itself");
    assert.ok((await page.evaluate(() => window.__confettiSeen)) > 0, c.inst + ": confetti");
    assert.ok(await until(() => playLogs(logs).length >= 2));
    assert.deepEqual(playLogs(logs)[1], { app: "this-week", door: "play", week_of: w.week, engine: "playit",
      instrument: c.inst, pick: c.miss[1], right: false, strike: 2 }, c.inst);
    await page.waitForFunction(() => !document.getElementById("piQ"), null, { timeout: 4000 });
    await neverATest(page);
    assert.deepEqual(errors, [], c.inst);
    await ctx.close();
  }
});

test("Play it: a reload on #playit lands on the instrument; reduced motion -> the positions have no transition or animation", async () => {
  const { ctx, page } = await playPage({ query: PQ("xylophone"), hash: "#playit", reducedMotion: "reduce" });
  await page.waitForFunction(() => window.Play.state().page === "playit" && document.querySelectorAll(".pi-pos").length === 10);
  await page.locator('.pi-pos[data-i="2"]').click();
  const r = await page.$eval('.pi-pos[data-i="2"]', (el) => { const s = getComputedStyle(el);
    return { t: s.transitionDuration, a: s.animationName, alive: el.matches(".alive") }; });
  assert.ok(r.alive);
  assert.ok(r.t.split(",").every((d) => parseFloat(d) === 0), "no transition: " + r.t);
  assert.equal(r.a, "none");
  await ctx.close();
  const p = await playPage({ query: PQ("shadow-puppet"), hash: "#playit", reducedMotion: "reduce" });
  await p.page.waitForFunction(() => window.Play.state().page === "playit" && document.getElementById("piShadow"));
  const s = await p.page.$eval("#piShadow", (el) => getComputedStyle(el).transitionDuration);
  assert.ok(s.split(",").every((d) => parseFloat(d) === 0), "the shadow jumps: " + s);
  await p.ctx.close();
});

test("playit.js is a module with no page globals: it imports only the kit", () => {
  const src = fs.readFileSync(path.join(HUB, "public", "play", "playit.js"), "utf8");
  assert.match(src, /export function mountPlayit\(host, playit, \{/);
  assert.doesNotMatch(src, /window\.(Play|Speech|Dwell|__)/, "no page globals in playit.js");
  for (const m of src.matchAll(/^import .* from "([^"]+)"/gm)) assert.match(m[1], /^\.\.\/lib\//);
  assert.doesNotMatch(src, /\.(png|jpe?g|webp|gif|mp3|wav|ogg)\b/i, "no media files");
});
