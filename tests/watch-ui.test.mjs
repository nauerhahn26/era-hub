// watch-ui.test.mjs — the This week watch page (/watch/?w=<week_of>&v=<id>, spec 2026-10-12 §3.3
// amended 2026-10-21, §5.4) through a real browser. The board takes the SAME kiosk window here; the
// page is a hub app page: the shared door bar on top, a left rail with Back and Pause / Play, the
// video filling the rest on black, its volume capped by musicVolCap. When it ends (or cannot play)
// it goes back to the Watch grid by itself. A video with a `before` question shows that one
// Which-one item first (which.js, the Play app's), then plays. Nothing calls the gaze engine.
//
// Spawns the REAL server.js on port 8427 (this suite's own) with a throwaway ERA_DATA_DIR holding
// one fixture week (2026-01-05) whose manifest lists two videos: watch[0] carries a `before`
// item, watch[1] none; both are tests/fixtures/this-week-1s.mp4 (a 1-second black H.264/AAC clip,
// made once with ffmpeg on the build box — nothing here needs ffmpeg). The hub serves play.json
// itself. Routed in the page context: /log (recorded), /voices + /tts (as the board suite does),
// /board/* (a stub, so a landing never runs the board), /kiosk/pause (the 💬 case).
// A one-second clip is too short to dwell on: cases that need it playing slow it to 0.1x.
// ERA_SHOTS=<dir> saves the page playing and the `before` question at 1920x1080.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8427;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-watch-ui-"));
const WEEK = "2026-01-05", ID = "aBcDeFgHiJk", QID = "aBcDeFgHiJq";
const GRID = `${BASE}/board/?recipe=this-week&board=watch`;
const SHOTS = process.env.ERA_SHOTS || "";
const BEFORE = { id: "aBcDeFgHiJb", skill: "compare", q: "Which one makes a shadow?",
  choices: [{ label: "A torch", glyph: "🔦", right: true }, { label: "A cloud", glyph: "☁️" }] };
let child, browser;

const video = (id, i, extra = {}) => ({
  id, title: "Shadow video " + (i + 1), channel: "A Channel", minutes: 3, why: "shows shadows",
  oembed: { title: "Shadow video " + (i + 1), author_name: "A Channel",
            thumbnail_url: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" }, ...extra });

before(async () => {
  const dir = path.join(TMP, "this-week", WEEK);
  fs.mkdirSync(dir, { recursive: true });
  for (const id of [ID, QID]) fs.copyFileSync(path.join(HUB, "tests", "fixtures", "this-week-1s.mp4"), path.join(dir, id + ".mp4"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    week_of: WEEK, title: "Shadows!", topic: "shadows", schema: 1,
    watch: [video(QID, 0, { before: BEFORE }), video(ID, 1, { before: null })], talk: [], play: { which: [] } }));
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
  // the hub's kiosk runs with this flag (build-payload.sh's start line): a video starts with its sound
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

// One page. `logs` = the /log bodies (with the time they left), `reqs` = every URL asked for.
async function watchPage(query, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1920, height: 1080 },
    deviceScaleFactor: 1, reducedMotion: opts.reducedMotion || "no-preference" });
  await ctx.addInitScript((slow) => {
    window.__testHooks = true;
    if (slow) new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes)
      if (n.tagName === "VIDEO") { n.defaultPlaybackRate = 0.1; n.playbackRate = 0.1;
        n.addEventListener("loadedmetadata", () => { n.playbackRate = 0.1; }); } })
      .observe(document, { childList: true, subtree: true });
  }, !!opts.slow);
  const logs = [], reqs = [], errors = [], pauses = [];
  await ctx.route("**/log", (r) => { logs.push({ ...JSON.parse(r.request().postData()), t: Date.now() }); return r.fulfill({ status: 204 }); });
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ enabled: false, voices: [] }) }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/board/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>grid</title>" }));
  await ctx.route("**/kiosk/pause", (r) => { pauses.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 200,
    contentType: "application/json", body: '{"action":"paused"}' }); });
  if (opts.settings) await ctx.route("**/settings", async (r) => {
    const res = await r.fetch();
    r.fulfill({ response: res, json: { ...(await res.json()), ...opts.settings } });
  });
  const page = await ctx.newPage();
  page.on("request", (r) => reqs.push(r.url()));
  page.on("pageerror", (e) => errors.push(String(e.message)));
  const t0 = Date.now();
  await page.goto(`${BASE}/watch/${query}`, { waitUntil: "load" });
  return { ctx, page, logs, reqs, errors, pauses, t0 };
}
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 40)); }
  return false;
};
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
const vid = (page) => page.$eval("video", (v) => ({ paused: v.paused, ended: v.ended, volume: v.volume,
  src: v.getAttribute("src"), autoplay: v.autoplay, visible: !!(v.offsetWidth || v.offsetHeight) && getComputedStyle(v).visibility !== "hidden" }));
const said = (page) => page.evaluate(() => (window.__speechLog || []).filter((e) => e.call === "say").map((e) => e.text));
const events = (logs) => logs.map((l) => l.event);
const playing = (page) => page.waitForFunction(() => { const v = document.querySelector("video"); return v && !v.paused && v.currentTime > 0; });
// her dwell: a short real dwell (dwell.js fires the click itself), after the page-settle window,
// arriving from the rail's black rest box (dwell.js re-arms only after a move)
async function dwellOn(page, sel) {
  await page.evaluate(() => window.Dwell.setMs(300));
  await page.waitForFunction(() => !window.Dwell.state().suppressedMs);
  const rest = await box(page, "#rail .black");
  await page.mouse.move(rest.cx, rest.cy);
  const b = await box(page, sel);
  await page.mouse.move(b.cx, b.cy, { steps: 4 });
}
async function neverATest(page) {
  const text = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /wrong|no!|score|points|\bstars?\b|try again/i, text);
}

// ================================================================ the page
test("the page: the bar, Back and Pause in the left rail at board size, the video playing in the rest at the cap", async () => {
  const { ctx, page, logs, reqs, errors } = await watchPage(`?w=${WEEK}&v=${ID}`, { slow: true });
  try {
    await playing(page);
    const v = await vid(page);
    assert.equal(v.src, `/this-week/${WEEK}/${ID}.mp4`, "the mp4 path is unchanged");
    assert.equal(v.volume, 0.4, "volume = musicVolCap / 100");
    assert.ok(v.autoplay && v.visible, "no before: autoplay at once, visible");
    const g = await page.evaluate(() => {
      const b = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
      const v = document.querySelector("video");
      return {
        dwell: [...document.querySelectorAll(".dwell")].map((el) => el.id).sort(),
        bar: b(document.querySelector(".msgbar")), door: !document.getElementById("barDoor").hidden,
        back: { ...b(document.getElementById("btnBack")), text: document.getElementById("btnBack").innerText },
        pause: { ...b(document.getElementById("btnPause")), text: document.getElementById("btnPause").innerText },
        video: { ...b(v), fit: getComputedStyle(v).objectFit, inline: v.hasAttribute("playsinline") },
        behind: getComputedStyle(v.parentElement).backgroundColor, vbg: getComputedStyle(v).backgroundColor,
      };
    });
    assert.deepEqual(g.dwell, ["barDoor", "barTalk", "btnBack", "btnPause"], "no other dwell target on the page");
    assert.ok(g.door, "the 🚪 is up");
    assert.match(g.back.text, /←/); assert.match(g.back.text, /Back/);
    assert.match(g.pause.text, /⏸/); assert.match(g.pause.text, /Pause/);
    assert.ok(g.back.y >= g.bar.b - 0.5 && g.back.b <= g.pause.y, "Back on top, Pause below it, both under the bar");
    assert.ok(g.pause.y - g.back.b >= 13.5, "gap ≥ 14 between the rail tiles");
    assert.ok(Math.abs(g.back.x - g.pause.x) < 1 && Math.abs(g.back.w - g.pause.w) < 1, "one rail");
    for (const t of [g.back, g.pause]) assert.ok(Math.min(t.w, t.h) >= 90, "≥ 90 px at 1920: " + JSON.stringify(t));
    assert.ok(g.back.w >= 120 && g.back.w <= 260, "the rail is one board cell wide: " + g.back.w);
    assert.ok(g.video.x - g.back.r >= 13.5, "the video starts right of the rail, a gap away");
    assert.ok(g.video.r >= 1920 - 16 && g.video.b >= 1080 - 16 && g.video.y >= g.bar.b - 0.5, "the video fills the rest: " + JSON.stringify(g.video));
    assert.equal(g.video.fit, "contain"); assert.ok(g.video.inline, "playsinline");
    assert.equal(g.behind, "rgb(0, 0, 0)", "black behind the video"); assert.equal(g.vbg, "rgb(0, 0, 0)");
    assert.ok(await until(() => logs.some((l) => l.event === "open")), "open logged");
    const open = logs.find((l) => l.event === "open");
    assert.equal(typeof open.ms, "number");
    assert.deepEqual({ app: open.app, door: open.door, week_of: open.week_of, id: open.id },
      { app: "this-week", door: "watch", week_of: WEEK, id: ID });
    for (const u of reqs) assert.ok(u.startsWith(BASE + "/"), "this hub only: " + u);
    assert.ok(!reqs.some((u) => /49155/.test(u)), "the gaze engine is never called");
    await neverATest(page);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "watch-playing-1920.png") }); }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("a dwell on Pause pauses (the tile says Play ▶, /log paused); again plays (Pause ⏸, /log resumed)", async () => {
  const { ctx, page, logs } = await watchPage(`?w=${WEEK}&v=${ID}`, { slow: true });
  try {
    await playing(page);
    await dwellOn(page, "#btnPause");
    await page.waitForFunction(() => document.querySelector("video").paused);
    let t = await page.$eval("#btnPause", (el) => el.innerText);
    assert.match(t, /Play/); assert.match(t, /▶/); assert.doesNotMatch(t, /Pause/);
    assert.ok(await until(() => logs.some((l) => l.event === "paused")), "paused logged");
    const p = logs.find((l) => l.event === "paused");
    assert.equal(p.door, "watch"); assert.equal(p.id, ID); assert.equal(typeof p.ms, "number");
    await dwellOn(page, "#btnPause");
    await page.waitForFunction(() => !document.querySelector("video").paused);
    t = await page.$eval("#btnPause", (el) => el.innerText);
    assert.match(t, /Pause/); assert.match(t, /⏸/);
    assert.ok(await until(() => logs.some((l) => l.event === "resumed")), "resumed logged");
    assert.deepEqual(events(logs), ["open", "paused", "resumed"]);
  } finally { await ctx.close(); }
});

test("the video plays to its end: /log ended (ms ≈ a second), then the page goes back to the Watch grid", async () => {
  const { ctx, page, logs } = await watchPage(`?w=${WEEK}&v=${ID}`);
  try {
    await page.waitForURL(GRID, { waitUntil: "commit", timeout: 8000 });
    const ended = logs.find((l) => l.event === "ended");
    assert.ok(ended, "ended logged: " + JSON.stringify(logs));
    assert.ok(ended.ms >= 500 && ended.ms <= 3000, "about a second played: " + ended.ms);
    assert.deepEqual(events(logs), ["open", "ended"], "the log goes before the navigation");
  } finally { await ctx.close(); }
});

test("a video that cannot play: /log error, then the Watch grid after about a second", async () => {
  const { ctx, page, logs } = await watchPage(`?w=${WEEK}&v=ZZZZZZZZZZZ`);
  try {
    assert.ok(await until(() => logs.some((l) => l.event === "error")), "error logged");
    const err = logs.find((l) => l.event === "error");
    assert.equal(err.id, "ZZZZZZZZZZZ"); assert.equal(err.week_of, WEEK); assert.equal(typeof err.ms, "number");
    assert.equal(page.url(), `${BASE}/watch/?w=${WEEK}&v=ZZZZZZZZZZZ`, "not at once");
    await page.waitForURL(GRID, { waitUntil: "commit", timeout: 4000 });
    const at = Date.now() - err.t;
    assert.ok(at >= 800, "a second after the error: " + at);
  } finally { await ctx.close(); }
});

test("Back goes to the Watch grid", async () => {
  const { ctx, page } = await watchPage(`?w=${WEEK}&v=${ID}`, { slow: true });
  try {
    await playing(page);
    await Promise.all([page.waitForURL(GRID, { waitUntil: "commit" }), dwellOn(page, "#btnBack")]);
  } finally { await ctx.close(); }
});

test("bad params: no video source, nothing logged, the Watch grid after about a second", async () => {
  for (const q of ["?w=x&v=y", `?w=${WEEK}&v=../../etc`, `?w=2026-1-5&v=${ID}`, `?w=${WEEK}&v=${ID}x`, ""]) {
    const { ctx, page, logs, t0 } = await watchPage(q);
    try {
      const src = await page.$$eval("video", (vs) => vs.map((v) => v.getAttribute("src") || v.currentSrc || ""));
      assert.ok(src.every((s) => !s), `${q}: no video source (${JSON.stringify(src)})`);
      await page.waitForURL(GRID, { waitUntil: "commit", timeout: 4000 });
      const at = Date.now() - t0;
      assert.ok(at >= 900 && at <= 3000, `${q}: after about a second (${at} ms)`);
      assert.deepEqual(logs, [], q);
    } finally { await ctx.close(); }
  }
});

// ================================================================ before (§5.4)
test("a video with a before question: the question first (spoken), the video paused and hidden; a right dwell logs and plays it", async () => {
  const { ctx, page, logs, errors } = await watchPage(`?w=${WEEK}&v=${QID}`, { slow: true });
  try {
    await page.waitForFunction(() => document.querySelector(".wh-q"));
    assert.equal(await page.$eval(".wh-q", (el) => el.innerText), BEFORE.q);
    assert.ok(await until(async () => (await said(page)).includes(BEFORE.q), 2000), "the question was said");
    let v = await vid(page);
    assert.ok(v.paused && !v.visible && !v.autoplay, "the video waits, hidden, no autoplay: " + JSON.stringify(v));
    assert.equal(v.src, `/this-week/${WEEK}/${QID}.mp4`, "the video element exists");
    const dw = await page.$$eval(".dwell:not([data-dwell-disabled])", (els) => els.map((el) => el.matches(".wh-tile") ? el.getAttribute("aria-label") : el.id).sort());
    assert.deepEqual(dw, ["A cloud", "A torch", "barDoor", "barTalk", "btnBack"].sort(),
      "during the question: Back, the doors and the choices; the Pause tile rests");
    const q = await box(page, ".wh"), r = await box(page, "#btnBack");
    assert.ok(q.x - r.r >= 13.5, "the question sits over the video area, right of the rail");
    await neverATest(page);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "watch-before-1920.png") }); }
    await dwellOn(page, '.wh-tile[aria-label="A torch"]');
    await page.waitForFunction(() => document.querySelector(".wh-tile.alive"));
    assert.ok(await until(() => logs.some((l) => l.event === "before")), "before logged");
    const b = logs.find((l) => l.event === "before");
    assert.deepEqual({ app: b.app, door: b.door, week_of: b.week_of, id: b.id, item: b.item, pick: b.pick, right: b.right, strike: b.strike },
      { app: "this-week", door: "watch", week_of: WEEK, id: QID, item: BEFORE.id, pick: 0, right: true, strike: 0 });
    await playing(page);
    v = await vid(page);
    assert.ok(v.visible, "the video shows once the question is answered");
    assert.equal(await page.locator(".wh").count(), 0, "the question is cleared");
    assert.match(await page.$eval("#btnPause", (el) => el.innerText), /Pause/);
    assert.ok(await page.$eval("#btnPause", (el) => el.matches(".dwell") && !el.hasAttribute("data-dwell-disabled")), "Pause is live again");
    assert.deepEqual(events(logs), ["open", "before"]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("before, two-strike: a miss re-asks with 'Look for', a second miss lights the right one by itself, then the video plays", async () => {
  const { ctx, page, logs } = await watchPage(`?w=${WEEK}&v=${QID}`, { slow: true });
  try {
    await page.waitForFunction(() => document.querySelector(".wh-tile"));
    await dwellOn(page, '.wh-tile[aria-label="A cloud"]');
    assert.ok(await until(() => logs.some((l) => l.event === "before")), "the miss is logged");
    assert.ok(await until(async () => (await said(page)).some((t) => /Look for A torch/.test(t)), 2000), "the hint");
    assert.equal(await page.locator(".wh-tile.alive").count(), 0);
    assert.ok((await vid(page)).paused, "the video still waits");
    await neverATest(page);
    await dwellOn(page, '.wh-tile[aria-label="A cloud"]');
    await page.waitForFunction(() => document.querySelector('.wh-tile.alive[aria-label="A torch"]'));
    const bs = logs.filter((l) => l.event === "before").map((l) => [l.pick, l.right, l.strike]);
    assert.deepEqual(bs, [[1, false, 1], [1, false, 2]]);
    await neverATest(page);
    await playing(page);
    assert.ok((await vid(page)).visible);
  } finally { await ctx.close(); }
});

// ================================================================ the doors
test("the 💬 with pauseGoes tdsnap: /kiosk/pause posted with /watch/, the video paused in place; coming back plays it", async () => {
  const { ctx, page, logs, pauses } = await watchPage(`?w=${WEEK}&v=${ID}`, { slow: true, settings: { pauseGoes: "tdsnap" } });
  try {
    await page.waitForFunction(() => !document.getElementById("barTalk").hidden);
    await playing(page);
    const at = await page.evaluate(() => document.querySelector("video").currentTime);
    await page.locator("#barTalk").click();
    assert.ok(await until(() => pauses.length === 1), "/kiosk/pause posted");
    assert.deepEqual(pauses[0], { path: "/watch/" });
    assert.ok((await vid(page)).paused, "paused in place");
    assert.ok(await until(() => logs.some((l) => l.event === "paused")), "paused logged");
    assert.equal(page.url(), `${BASE}/watch/?w=${WEEK}&v=${ID}`, "she stays on the page");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction((at) => { const v = document.querySelector("video"); return !v.paused && v.currentTime >= at; }, at);
    assert.ok(await until(() => logs.some((l) => l.event === "resumed")), "resumed logged");
  } finally { await ctx.close(); }
});

test("the two doors are the only 2x holds; Back and Pause hold her dwell", async () => {
  const { ctx, page } = await watchPage(`?w=${WEEK}&v=${QID}`);
  try {
    await page.waitForFunction(() => document.querySelector(".wh-tile"));
    const holds = () => page.evaluate(() => [...document.querySelectorAll("[data-dwell-ms]")].map((el) => el.id + "=" + el.dataset.dwellMs).sort());
    assert.deepEqual(await holds(), ["barDoor=2400", "barTalk=2400"], "during the question");
    assert.equal(await page.evaluate(() => window.Dwell.config.ms), 1200, "her dwell, 1x, on everything else");
  } finally { await ctx.close(); }
});

test("at 1280x720 Back and Pause are ≥ 60 px, gaps ≥ 14; reduced motion: the rail tiles have no transition", async () => {
  const { ctx, page } = await watchPage(`?w=${WEEK}&v=${ID}`, { viewport: { width: 1280, height: 720 }, reducedMotion: "reduce", slow: true });
  try {
    await playing(page);
    const back = await box(page, "#btnBack"), pause = await box(page, "#btnPause"), v = await box(page, "video");
    for (const t of [back, pause]) assert.ok(Math.min(t.w, t.h) >= 60, "≥ 60 px: " + JSON.stringify(t));
    const fit = await page.$$eval("#rail .railTile", (els) => els.map((el) => { const w = el.querySelector(".word").getBoundingClientRect(), r = el.getBoundingClientRect();
      return { left: w.left - r.left, right: r.right - w.right, px: parseFloat(getComputedStyle(el.querySelector(".word")).fontSize) }; }));
    for (const f of fit) assert.ok(f.left >= 0 && f.right >= 0 && f.px >= 44, "the word fits its tile, ≥ 44 px: " + JSON.stringify(f));
    assert.ok(pause.y - back.b >= 13.5 && v.x - back.r >= 13.5, "gaps ≥ 14");
    const tr = await page.$$eval("#rail .railTile", (els) => els.map((el) => { const s = getComputedStyle(el); return [s.transitionDuration, s.animationName]; }));
    for (const [t, a] of tr) { assert.ok(t.split(",").every((d) => parseFloat(d) === 0), "no transition: " + t); assert.equal(a, "none"); }
  } finally { await ctx.close(); }
});

test("the source: no gaze-engine call, no fullscreen, local scripts only, Which one? is the Play app's module", () => {
  const html = fs.readFileSync(path.join(HUB, "public", "watch", "index.html"), "utf8");
  const js = fs.readFileSync(path.join(HUB, "public", "watch", "watch.js"), "utf8");
  const css = fs.readFileSync(path.join(HUB, "public", "watch", "watch.css"), "utf8");
  for (const src of html.matchAll(/<(?:script|link)[^>]*\b(?:src|href)="([^"]*)"/g))
    assert.ok(!/^(https?:)?\/\//.test(src[1]), "local files only: " + src[1]);
  assert.doesNotMatch(html + js + css, /49155|app\/launch|watch-end/);
  assert.doesNotMatch(html + js, /requestFullscreen/);
  assert.match(js, /import\s*\{\s*mountWhich\s*\}\s*from\s*"\.\.\/play\/which\.js"/);
  assert.match(js, /mountDoorBar\(document\.body/);
  assert.match(js, /keepalive:\s*true/);
  assert.match(css, /prefers-reduced-motion/);
});
