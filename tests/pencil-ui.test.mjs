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
//
// Since 9/17 it also covers the SHARED door bar (era-core lib/doorbar.js): the
// 🚪 and the new 💬 "pause to talk" hold 2 x her Settings dwell while every
// other control on the page holds her dwell exactly (no attribute at all), the
// 💬 exists only where /settings says there is a TD Snap to go and talk in, and
// pressing it stops speech, posts /kiosk/pause with this app's path and leaves
// her page untouched behind the minimizing kiosk.
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
// Since 9/17 the door is the SHARED bar's 🚪 (era-core lib/doorbar.js): same
// round trip, one strip across all five apps, so the id is #barDoor.
test("door: follows the hub's /kiosk/exit — home navigates, closed stays", async () => {
  const setExit = (v) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exitTo: v }) });
  const quickSpeech = (ctx) => ctx.addInitScript(() => {   // belt: no TTS wait anywhere on the exit path
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
    await page.locator("#barDoor").click();               // live hub, no engine → home
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
    await p2.locator("#barDoor").click();
    await p2.waitForTimeout(600);
    assert.equal(hits, 1, "door POSTs /kiosk/exit exactly once");
    assert.match(p2.url(), /\/pencil\//, "closed: the hub is closing the kiosk — no navigation");
    await c2.close();
  } finally { await setExit("tdsnap"); }
});

// ---------------------------------------------------------------------------
// The shared bar (era-core lib/doorbar.js, dad 9/17) — "pause to talk".
// ---------------------------------------------------------------------------
// Two speeds and no third (spec §5.1): the two doors that take her OFF this
// screen hold 2 x her Settings dwell; every other control on the page holds
// exactly her dwell, which means NO data-dwell-ms attribute at all (the engine
// default, which /settings tunes). The five 1600s and the 1800/2000/2200 the
// Pencil used to carry were our invention, not hers.
const PENCIL_CONTROLS = ["btnRead", "btnSend", "btnDel", "clearAll", "btnSpace", "seatA",
                         "btnClearNo", "btnClearYes", "btnKeep", "btnConfirm", "btnAgain"];

// A page whose /settings answers exactly what we want — the live hub has no
// gaze engine on the bus, so its own pauseGoes is "home" and the 💬 would never
// mount. dwellMs 900 is deliberately NOT the hub's, so a door reading 1800
// proves setDwell() ran rather than the bar's built-in default.
// speech:true arms era-core speech.js's own test hook (__testHooks, set BEFORE
// init) so the voice layer runs in its deterministic fake-audio mode instead of
// reporting "off" in headless Chromium — the only way the app's S.tts is true
// and its prompts are real, assertable calls.
async function makeBarPage({ pauseGoes = "tdsnap", dwellMs = 900, speech = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  if (speech) await ctx.addInitScript(() => { window.__testHooks = true; });
  await ctx.route("**/tts", r => r.fulfill({ status: 503, body: "" }));
  await ctx.route("**/voices", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ enabled: false, current: "", voices: [] }) }));
  await ctx.route("**/settings", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ dwellMs, childName: "Maya", pauseGoes, doorGoes: pauseGoes }) }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/pencil/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Pencil && window.Pencil.state().mailChecked);
  await page.waitForSelector("#barDoor");
  return { ctx, page, dwellMs };
}

test("holds: the bar's two doors are 2x her dwell, every other control is bare", async () => {
  const { ctx, page, dwellMs } = await makeBarPage();
  await page.waitForFunction(d => document.getElementById("barDoor").dataset.dwellMs === String(2 * d), dwellMs);
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), String(2 * dwellMs));
  assert.equal(await page.getAttribute("#barTalk", "data-dwell-ms"), String(2 * dwellMs));
  const holds = await page.evaluate(ids => ids.map(id => {
    const el = document.getElementById(id);
    return [id, el ? el.getAttribute("data-dwell-ms") : "MISSING"];
  }), PENCIL_CONTROLS);
  for (const [id, v] of holds) assert.equal(v, null, `#${id} carries a hold of its own (${v})`);
  // the back seat on a letter page is the same seat — it must not grow a hold either
  await page.evaluate(() => openGroup(2));
  assert.equal(await page.getAttribute("#seatA", "data-dwell-ms"), null, "back seat inherits her dwell");
  // the one sanctioned exception, unchanged: reading the three predictions must
  // not become picking one (prediction slots sit ABOVE her dwell, on purpose)
  await page.evaluate(() => { renderGroups(); paintPredictions(["cat", "came", "can"]); });
  const pw = await page.getAttribute(".pword.dwell", "data-dwell-ms");
  assert.equal(pw, "2000", "prediction slots keep the contract's reading hold");
  await ctx.close();
});

test("#btnRead fills the left column now the door cell is gone", async () => {
  const { ctx, page } = await makeBarPage();
  const [col, read] = await page.evaluate(() => ["colL", "btnRead"]
    .map(id => document.getElementById(id).getBoundingClientRect())
    .map(r => ({ top: r.top, height: r.height, width: r.width })));
  assert.ok(Math.abs(read.height - col.height) < 2, `Read fills #colL (${read.height} of ${col.height})`);
  assert.ok(Math.abs(read.top - col.top) < 2, "…from the top of the column");
  assert.equal(await page.locator("#door").count(), 0, "no ring door cell — the bar carries the door");
  await ctx.close();
});

test("💬 pause to talk: stops speech, POSTs /kiosk/pause with /pencil/, stays put", async () => {
  const { ctx, page } = await makeBarPage();
  assert.equal(await page.locator("#barTalk").isVisible(), true, "pauseGoes tdsnap → the talk door is there");
  let body = null, hits = 0;
  await page.route("**/kiosk/pause", r => {
    hits++; body = JSON.parse(r.request().postData() || "null");
    r.fulfill({ status: 200, contentType: "application/json", body: '{"action":"paused"}' });
  });
  await page.evaluate(() => {
    window.__stops = 0;
    const real = window.Speech.stop;
    window.Speech.stop = function (...a) { window.__stops++; return real.apply(window.Speech, a); };
  });
  await page.locator("#barTalk").click();
  await page.waitForTimeout(400);
  assert.equal(hits, 1, "the talk door POSTs /kiosk/pause exactly once");
  assert.deepEqual(body, { path: "/pencil/" }, "the hub matches path+query, never the hash");
  assert.ok(await page.evaluate(() => window.__stops > 0), "she is about to talk — the Pencil goes quiet first");
  assert.match(page.url(), /\/pencil\//, "paused: the kiosk is going under her, no navigation");
  assert.equal(await page.locator("#page").isVisible(), true, "her page is exactly as she left it");
  await ctx.close();
});

// Speech.stop() cancels what is PLAYING. It cannot cancel what a chained prompt
// is about to start: pickLetter awaits the letter echo and then says "So far you
// have…", so a 💬 pressed mid-echo used to hand the screen to TD Snap and then
// talk over her conversation from underneath. Making Words gates its own voice
// on the same flag; the Pencil now does too.
test("💬 mid-letter: the prompt waiting behind the echo never speaks over TD Snap", async () => {
  const { ctx, page } = await makeBarPage({ speech: true });
  await page.route("**/kiosk/pause", r => r.fulfill({ status: 200,
    contentType: "application/json", body: '{"action":"paused"}' }));
  await page.waitForFunction(() => window.Speech && window.Speech.mode() === "test");
  await writeLetter(page, "a");                 // one letter: nothing chained yet
  // spy on the shared voice layer, and hold the letter echo open so the 💬 lands
  // while pickLetter is still awaiting it — her real timing, made deterministic
  await page.evaluate(() => {
    window.__said = [];
    window.__release = null;
    const real = window.Speech.say.bind(window.Speech);
    window.Speech.say = (text, kind) => {
      window.__said.push(text);
      if (kind === "letter") return new Promise(res => { window.__release = res; });
      return real(text, kind);
    };
  });
  await page.locator("#seatA").click();
  await page.locator("#rowBottom .lcell", { hasText: /^b$/ }).first().click();
  await page.waitForFunction(() => window.__release, null, { timeout: 5000 });
  await page.locator("#barTalk").click();       // she reaches for the 💬 mid-echo
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__release()); // the echo ends under TD Snap
  await page.waitForTimeout(300);
  const said = await page.evaluate(() => window.__said);
  assert.deepEqual(said.filter(t => /So far you have/.test(t)), [],
    `the Pencil spoke while she was in TD Snap: ${JSON.stringify(said)}`);
  await ctx.close();
});

// The other half of the round trip: TD Snap hands the screen back, the launcher's
// /kiosk/resume line re-foregrounds this kiosk and the page gets a visible flip.
// Her letters are exactly where she left them and the pencil writes again — and
// the park override is re-posted, because /app/park is transient in the engine and
// the trip through TD Snap resets it to the corner.
test("back from TD Snap: her letters are untouched, the pencil writes again, park re-posted", async () => {
  const { ctx, page } = await makeBarPage();
  const parks = [];
  await page.route("http://127.0.0.1:49155/app/park", r => {
    parks.push(JSON.parse(r.request().postData() || "null"));
    r.fulfill({ status: 200, body: "" });
  });
  await page.route("**/kiosk/pause", r => r.fulfill({ status: 200,
    contentType: "application/json", body: '{"action":"paused"}' }));
  await writeLetter(page, "a");
  await page.locator("#barTalk").click();
  await page.waitForTimeout(300);
  // she is under TD Snap: a stray selection on the page she cannot see writes nothing
  await page.locator("#seatA").click();                    // the abcd seat opens the group
  const bTile = page.locator("#rowBottom .lcell", { hasText: /^b$/ }).first();
  await bTile.click();
  await page.waitForTimeout(250);
  assert.equal(await page.textContent("#text"), "a", "paused: nothing lands on her paper");
  const parksBefore = parks.length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await bTile.click();                                     // the same tile, on the same open page
  await page.waitForFunction(() => document.querySelector("#text").textContent === "ab");
  assert.equal(await page.textContent("#text"), "ab", "resumed: she picks up mid-word");
  assert.ok(parks.length > parksBefore, "the rest block is the park spot again");
  const p = parks[parks.length - 1];
  assert.ok(p && p.x > 0.3 && p.x < 0.7, `park is her centre rest block (${JSON.stringify(p)})`);
  await ctx.close();
});

// S.paused is ONE flag with two hands on it: the partner strip's ⏸ and the 💬.
// A page the partner had already parked must come back from TD Snap still
// parked — otherwise the pill reads "▶ resume" and Dwell stays off while the
// paper writes again, and nobody can tell which state she is in.
test("partner ⏸ then 💬 and back: still parked — pill, engine and paper agree", async () => {
  const { ctx, page } = await makeBarPage();
  await page.route("**/kiosk/pause", r => r.fulfill({ status: 200,
    contentType: "application/json", body: '{"action":"paused"}' }));
  await writeLetter(page, "a");
  await page.locator("#partnerTab").click();
  await page.locator("#pPause").click();                 // the partner parks the page
  assert.equal((await page.textContent("#pPause")).trim(), "▶ resume");
  assert.equal(await page.evaluate(() => Dwell.config.enabled), false, "parked: no gaze");
  await page.locator("#barTalk").click();                // …and she goes to talk
  await page.waitForTimeout(300);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  assert.equal((await page.textContent("#pPause")).trim(), "▶ resume",
    "the partner's pause was never handed back by a screen she did not touch");
  assert.equal(await page.evaluate(() => Dwell.config.enabled), false, "dwell is still off");
  await page.locator("#seatA").click();                  // and the paper is still frozen
  await page.locator("#rowBottom .lcell", { hasText: /^b$/ }).first().click();
  await page.waitForTimeout(250);
  assert.equal(await page.textContent("#text"), "a", "still paused: nothing lands on her paper");
  await ctx.close();
});

// A visible flip that is NOT her coming back — an alt-tab on the QA VM, a screen
// waking, the taskbar — must be a no-op end to end: doorbar.js only resumes when
// it posted a pause of its own.
test("a stray visible flip with no pause pending changes nothing", async () => {
  const { ctx, page } = await makeBarPage();
  const parks = [], kiosk = [];
  await page.route("http://127.0.0.1:49155/app/park", r => { parks.push(1); r.fulfill({ status: 200, body: "" }); });
  await page.route("**/kiosk/**", r => { kiosk.push(new URL(r.request().url()).pathname); r.abort(); });
  await writeLetter(page, "a");
  const before = parks.length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(400);
  assert.equal(parks.length, before, "onResume never ran — no park re-post");
  assert.deepEqual(kiosk, [], "no /kiosk traffic at all");
  assert.match(page.url(), /\/pencil\//, "and nowhere to go");
  // S.paused is untouched: she was never paused, and she can still write
  await page.locator("#seatA").click();
  await page.locator("#rowBottom .lcell", { hasText: /^b$/ }).first().click();
  await page.waitForFunction(() => document.querySelector("#text").textContent === "ab");
  await ctx.close();
});

// Dad's ruling is a RATIO, not a number: the doors hold 2 x the dwell she is
// actually on. The partner's ⏱ buttons move that dwell, so they move the doors.
test("partner dwell tuning takes the doors with it — still 2x", async () => {
  const { ctx, page, dwellMs } = await makeBarPage();
  await page.waitForFunction(d => document.getElementById("barDoor").dataset.dwellMs === String(2 * d), dwellMs);
  await page.locator("#partnerTab").click();
  await page.locator("#pEasier").click();                // +200ms: she needs longer today
  const tuned = dwellMs + 200;
  assert.equal(await page.evaluate(() => Dwell.config.ms), tuned, "the engine took the tune");
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), String(2 * tuned),
    "🚪 follows her dwell, not the last /settings value");
  assert.equal(await page.getAttribute("#barTalk", "data-dwell-ms"), String(2 * tuned), "💬 too");
  await page.locator("#pFaster").click();                // …and back down
  assert.equal(await page.getAttribute("#barDoor", "data-dwell-ms"), String(2 * dwellMs));
  assert.equal(await page.getAttribute("#barTalk", "data-dwell-ms"), String(2 * dwellMs));
  await ctx.close();
});

// The partner tab is a touch-only strip dead centre, directly under the 💬. It
// must not catch a finger aimed at the talk door.
test("the partner tab clears the 💬 by a finger's slip", async () => {
  const { ctx, page } = await makeBarPage();
  // measured from the BAR's bottom edge, not the 💬's own box: the strip is live
  // to its last pixel, so that edge is where a slipping touch leaves the door.
  const m = await page.evaluate(() => {
    const talk = document.getElementById("barTalk").getBoundingClientRect();
    const bar = document.querySelector(".msgbar").getBoundingClientRect();
    const tab = document.getElementById("partnerTab").getBoundingClientRect();
    return { gap: tab.top - bar.bottom, overlapX: tab.left < talk.right && tab.right > talk.left };
  });
  assert.equal(m.overlapX, true, "it really is the strip under the talk door");
  assert.ok(m.gap >= 12, `a low touch on the 💬 opens a conversation, not the panel (${m.gap}px)`);
  await ctx.close();
});

test("no engine on the bus: no 💬 at all (the VM and a dev browser look like 9/16)", async () => {
  const { ctx, page } = await makeBarPage({ pauseGoes: "home" });
  assert.equal(await page.locator("#barDoor").isVisible(), true, "the 🚪 is always there");
  assert.equal(await page.locator("#barTalk").isVisible(), false, "nothing to talk to → no talk door");
  await ctx.close();
});
