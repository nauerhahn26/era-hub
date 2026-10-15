// watch-ui.test.mjs — the This week watch page (/watch/?w=<week_of>&v=<id>,
// spec 2026-10-12 §3.3) through a real browser. ERAgaze opens this page in its
// watch mode; the page plays one downloaded video with the picture and, when it
// ends (or cannot play), logs it to the hub and tells the engine on
// 127.0.0.1:49155 that the video is over. Nothing else lives on the page.
//
// Spawns the REAL server.js on port 8427 (this suite's own — see the plan's
// free-port table) with a throwaway ERA_DATA_DIR holding one fixture week.
// The fixture is a 1-second black H.264/AAC mp4 (tests/fixtures/this-week-1s.mp4,
// made once with ffmpeg on the build box — nothing here needs ffmpeg).
// The engine is never contacted: /app/watch-end is routed in the page context.
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
const WEEK = "2026-01-05", ID = "aBcDeFgHiJk";
let child, browser;

before(async () => {
  const dir = path.join(TMP, "this-week", WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(HUB, "tests", "fixtures", "this-week-1s.mp4"), path.join(dir, ID + ".mp4"));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1" },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  // ERAgaze's watch window lets a video start with its sound; so does this one
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

// One page with the engine and the log routed; `calls` records both, in order.
async function watchPage(query) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const calls = [];
  await ctx.addInitScript(() => {
    window.__ms = [];
    if (navigator.mediaSession) {
      const real = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, fn) => {
        window.__ms.push(action);
        (window.__msFns = window.__msFns || {})[action] = fn;
        return real(action, fn);
      };
    }
  });
  await ctx.route("**/app/watch-end", r => {
    calls.push({ url: "watch-end", body: r.request().postData(), headers: r.request().headers(), t: Date.now() });
    return r.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await ctx.route("**/log", r => {
    calls.push({ url: "log", body: r.request().postData(), t: Date.now() });
    return r.fulfill({ status: 204 });
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/watch/${query}`, { waitUntil: "load" });
  return { ctx, page, calls, t0 };
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
};

test("the video plays to its end, then logs 'ended' and only then tells the engine", async () => {
  const { ctx, page, calls } = await watchPage(`?w=${WEEK}&v=${ID}`);
  try {
    assert.equal(await page.$eval("video", v => v.getAttribute("src")), `/this-week/${WEEK}/${ID}.mp4`);
    const look = await page.$eval("video", v => {
      const s = getComputedStyle(v);
      return { fit: s.objectFit, w: v.getBoundingClientRect().width, h: v.getBoundingClientRect().height,
               autoplay: v.autoplay, inline: v.hasAttribute("playsinline"),
               bg: getComputedStyle(document.body).backgroundColor };
    });
    assert.equal(look.fit, "contain");
    assert.equal(look.w, 1280); assert.equal(look.h, 800);
    assert.ok(look.autoplay && look.inline, "autoplay playsinline");
    assert.equal(look.bg, "rgb(0, 0, 0)", "a black page");
    assert.ok(await until(() => calls.some(c => c.url === "watch-end")), "watch-end posted: " + JSON.stringify(calls));
    assert.equal(await page.$eval("video", v => v.ended), true, "Chromium really played the fixture to its end");
    assert.deepEqual(calls.map(c => c.url), ["log", "watch-end"], "the log goes first");
    const log = JSON.parse(calls[0].body);
    assert.equal(typeof log.ms, "number");
    assert.ok(log.ms >= 500 && log.ms <= 3000, "about a second played: " + log.ms);
    delete log.ms;
    assert.deepEqual(log, { app: "this-week", door: "watch", week_of: WEEK, id: ID, event: "ended" });
    assert.deepEqual(JSON.parse(calls[1].body), { reason: "video-ended" });
    assert.equal(calls[1].headers["content-type"] === undefined ||
                 /^text\/plain/.test(calls[1].headers["content-type"]), true,
      "a simple CORS request: no JSON content type, so no preflight the engine would have to answer");
  } finally { await ctx.close(); }
});

test("a video that cannot play logs 'error' and still ends the watch", async () => {
  const { ctx, calls } = await watchPage(`?w=${WEEK}&v=ZZZZZZZZZZZ`);
  try {
    assert.ok(await until(() => calls.some(c => c.url === "watch-end")), "watch-end posted");
    assert.deepEqual(calls.map(c => c.url), ["log", "watch-end"]);
    const log = JSON.parse(calls[0].body);
    assert.equal(log.event, "error"); assert.equal(log.id, "ZZZZZZZZZZZ"); assert.equal(log.week_of, WEEK);
    assert.equal(typeof log.ms, "number");
  } finally { await ctx.close(); }
});

test("bad params: a blank page, no video source, watch-end after a second", async () => {
  for (const q of ["?w=x&v=y", `?w=${WEEK}&v=../../etc`, `?w=2026-1-5&v=${ID}`, ""]) {
    const { ctx, page, calls, t0 } = await watchPage(q);
    try {
      const src = await page.$$eval("video", vs => vs.map(v => v.getAttribute("src") || v.currentSrc || ""));
      assert.ok(src.every(s => !s), `${q}: no video source (${JSON.stringify(src)})`);
      assert.ok(await until(() => calls.some(c => c.url === "watch-end"), 2500), `${q}: watch-end posted`);
      const at = calls.find(c => c.url === "watch-end").t - t0;
      assert.ok(at <= 2000, `${q}: within ~1.5 s (${at} ms)`);
      assert.deepEqual(JSON.parse(calls.find(c => c.url === "watch-end").body), { reason: "video-ended" });
    } finally { await ctx.close(); }
  }
});

test("the media keys reach the video: play and pause handlers are registered", async () => {
  const { ctx, page } = await watchPage(`?w=${WEEK}&v=${ID}`);
  try {
    const actions = await page.evaluate(() => window.__ms);
    assert.ok(actions.includes("play") && actions.includes("pause"), JSON.stringify(actions));
    const paused = await page.evaluate(() => { window.__msFns.pause(); return document.querySelector("video").paused; });
    assert.equal(paused, true, "the pause key pauses the video");
  } finally { await ctx.close(); }
});

test("the page is the video and nothing else: no dwell targets, no fullscreen, no external script", () => {
  const html = fs.readFileSync(path.join(HUB, "public", "watch", "index.html"), "utf8");
  const js = fs.readFileSync(path.join(HUB, "public", "watch", "watch.js"), "utf8");
  for (const src of html.matchAll(/<script[^>]*\bsrc="([^"]*)"/g))
    assert.ok(!/^(https?:)?\/\//.test(src[1]), "local scripts only: " + src[1]);
  assert.doesNotMatch(html + js, /requestFullscreen/);
  assert.doesNotMatch(html + js, /dwell/i);
  assert.doesNotMatch(html, /<(button|a)\b/);
});
