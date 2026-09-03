// pencil-ui.test.mjs — The Pencil's Send tile greys out until the family has
// an email on file (dad 9/2: "Send should be grayed out if there is not an
// email on file"). Before this, a fresh install offered a full-colour Send
// that could only ever answer "Saved for your family" — the tile promised
// something the hub could not do.
//
// Spawns the REAL server.js on a scratch port with a throwaway ERA_DATA_DIR
// and a fake Resend, then drives /pencil/ with Playwright. Proves: with no
// email on file the tile carries data-dwell-disabled (the dwell engine's own
// skip) and neither a tap nor a programmatic activation reaches the confirm
// screen; the tile is greyed but NEVER shrunk (74px ladder); a hub that can't
// answer leaves Send ON (the outbox is the honest path there); and when the
// family finishes setup in Settings the open Pencil lights Send up on its own
// re-check — no relaunch (the reader's 9/2 "never notices" bug).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8421;       // never live 8377; 8391-8420 held by sibling suites
const FAKE = 8422;       // stand-in for api.resend.com
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-pencil-ui-"));
let child, fake, browser;

before(async () => {
  fake = http.createServer((req, res) => {         // accepts any re_ key
    let b = ""; req.on("data", c => b += c);
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"x"}'));
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  fs.writeFileSync(path.join(TMP, "profile.json"), JSON.stringify({ childName: "Maya" }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1",
           ERA_RESEND_URL: `http://127.0.0.1:${FAKE}/emails` },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
  fake.close();
});

// The suite records every setInterval the app registers so the periodic
// re-check can be fired on demand — proving the "no relaunch" law without
// sitting through 30 real seconds.
async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__timers = [];
    const si = window.setInterval.bind(window);
    window.setInterval = (fn, ms) => { window.__timers.push({ fn, ms }); return si(fn, ms); };
  });
  await ctx.route("**/tts", r => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/voices", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ enabled: false, current: "", voices: [] }) }));
  if (opts.hubUnreachable) await ctx.route("**/mail-config", r => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/pencil/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Pencil && window.Pencil.state().mailChecked);
  return { ctx, page };
}
const sendDisabled = (page) =>
  page.evaluate(() => document.getElementById("btnSend").hasAttribute("data-dwell-disabled"));
// her flip book: the abcd seat opens the group, the letter lands on the paper
async function writeLetter(page, L) {
  await page.locator("#seatA").click();
  await page.locator("#rowBottom .lcell", { hasText: new RegExp("^" + L + "$") }).first().click();
  await page.waitForFunction(l => (document.querySelector("#text .partial") || {}).textContent === l, L);
}

test("no email on file: Send is greyed out, skipped by dwell, and inert", async () => {
  const { ctx, page } = await makePage();
  assert.equal(await sendDisabled(page), true, "data-dwell-disabled — the engine's own skip");
  assert.equal(await page.locator("#btnSend.is-disabled").count(), 1, "greyed out");
  assert.equal(await page.getAttribute("#btnSend", "aria-disabled"), "true");
  // the dwell engine targets exactly this selector (dwell.js targetAt)
  assert.equal(await page.locator(".dwell:not([data-dwell-disabled])#btnSend").count(), 0,
    "gaze can no longer land on Send");
  // greyed, never shrunk: Send keeps the Read tile's font (74px ladder, contract #20)
  const [send, read] = await page.evaluate(() => ["btnSend", "btnRead"]
    .map(id => getComputedStyle(document.getElementById(id)).fontSize));
  assert.equal(send, read, "disabled Send keeps its size — only its colour goes");
  // she writes, then Send does nothing at all: no confirm screen, words untouched
  await writeLetter(page, "a");
  await page.locator("#btnSend").click();
  await page.evaluate(() => document.getElementById("btnSend").click());   // gaze/keyboard fire
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#sConfirm.show").count(), 0, "no send confirm screen");
  assert.equal(await page.locator("#page").isVisible(), true, "she is still on her paper");
  assert.equal(await page.textContent("#text"), "a", "her word is untouched");
  await ctx.close();
});

test("hub unreachable: Send stays ON — the outbox is the honest path", async () => {
  const { ctx, page } = await makePage({ hubUnreachable: true });
  assert.equal(await sendDisabled(page), false, "a failed /mail-config never greys Send out");
  assert.equal(await page.locator("#btnSend.is-disabled").count(), 0);
  await ctx.close();
});

test("family finishes setup in Settings: the open Pencil lights Send up, no relaunch", async () => {
  const { ctx, page } = await makePage();
  assert.equal(await sendDisabled(page), true, "grey while nothing is set up");
  // Settings saves the pair (the hub proves it with a real test send)
  const j = await (await fetch(`${BASE}/mail-config`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "mum@example.com", apiKey: "re_good" }) })).json();
  assert.equal(j.ok, true, JSON.stringify(j));
  // the app re-checks on a timer; fire the registered intervals rather than wait
  const every = await page.evaluate(() => window.__timers.map(t => t.ms));
  assert.ok(every.some(ms => ms > 0 && ms <= 30000), `re-checks at least every 30s (${every})`);
  await page.evaluate(async () => { for (const t of window.__timers) await t.fn(); });
  await page.waitForFunction(() => !document.getElementById("btnSend").hasAttribute("data-dwell-disabled"));
  assert.equal(await page.locator("#btnSend.is-disabled").count(), 0, "Send is full colour again");
  await ctx.close();
});

test("email on file at boot: Send is live and opens the confirm screen", async () => {
  const { ctx, page } = await makePage();
  assert.equal(await sendDisabled(page), false, "email + key on file — nothing to grey out");
  assert.equal(await page.getAttribute("#btnSend", "aria-disabled"), "false");
  await writeLetter(page, "a");
  await page.locator("#btnSend").click();
  await page.waitForSelector("#sConfirm.show");
  assert.match(await page.textContent("#confirmSub"), /a/, "her words on the confirm screen");
  await ctx.close();
});

// The door goes where Settings says (dad 9/3): the hub's /kiosk/exit decides;
// the Pencil only follows — "closed" stays put (kiosk closing), else home.
test("door: follows the hub's /kiosk/exit — home navigates, closed stays", async () => {
  const setExit = (v) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exitTo: v }) });
  const quickSpeech = (ctx) => ctx.addInitScript(() => {   // no 5 s wait for the goodbye line
    if (window.speechSynthesis) speechSynthesis.speak = (u) => setTimeout(() => u.onend && u.onend(), 0);
  });
  try {
    await setExit("home");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    await quickSpeech(ctx);
    await ctx.route("**/tts", r => r.fulfill({ status: 503, body: "" }));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/pencil/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.Pencil && window.Pencil.state().mailChecked);
    await page.locator("#door").click();                  // live hub, no engine → home
    await page.waitForURL(/\/home\/?$/, { timeout: 10000 });
    await ctx.close();

    await setExit("tdsnap");
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    await quickSpeech(c2);
    await c2.route("**/tts", r => r.fulfill({ status: 503, body: "" }));
    let hits = 0;
    await c2.route("**/kiosk/exit", (r) => { hits++; r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"closed"}' }); });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/pencil/`, { waitUntil: "load" });
    await p2.waitForFunction(() => window.Pencil && window.Pencil.state().mailChecked);
    await p2.locator("#door").click();
    await p2.waitForTimeout(600);
    assert.equal(hits, 1, "door POSTs /kiosk/exit exactly once");
    assert.match(p2.url(), /\/pencil\//, "closed: the hub is closing the kiosk — no navigation");
    await c2.close();
  } finally { await setExit("tdsnap"); }
});
