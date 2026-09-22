// reader-share.test.mjs — the SEND half of book sharing (spec §4, plan T3.1).
//
// A grown-up holds a finger on a finished book on Rae's own shelf for 1.6 s and
// gets a sheet with three ways to send the file. Everything this suite pins is
// about the one thing that makes that safe on THIS screen: it is the single
// surface a non-verbal six-year-old drives with her eyes, and ERAgaze moves the
// REAL mouse cursor — so gaze and mouse are the same pointer at the DOM.
//
//   * the hold answers a FINGER and nothing else. A mouse held for two seconds
//     opens nothing, which is the whole safety argument written as a test;
//   * a SHORT touch still opens the book — her shelf is not hold-only;
//   * the card's button loses `.dwell` while the finger is down and has it back
//     afterwards. That is not cosmetics: era-core/dwell.js has a 150 ms
//     TAP-RESCUE that fires el.click() after a long touch is released, so a
//     completed hold would ALSO open the book underneath the sheet;
//   * a card that is not a finished book says so in one sentence;
//   * while the sheet is open the shelf AND the bar's two doors are asleep,
//     because dwell.js's targetAt() walks the elementsFromPoint stack and steps
//     straight over anything without `.dwell` — a full-screen backdrop hides
//     nothing from a gaze;
//   * "Send it now" is never a button that does nothing: it is drawn only where
//     navigator.canShare({files:[File]}) says yes.
//
// HOW THE HOLD IS DRIVEN: page.touchscreen can only TAP, so a 1600 ms finger is
// dispatched over CDP (Input.dispatchTouchEvent) exactly as board-edit.test.mjs
// does — real trusted pointer events with pointerType "touch", the one thing
// reader-share.js filters on.
//
// The harness is reader-ui.test.mjs's: the REAL server.js on scratch port 8469
// with a throwaway ERA_DATA_DIR and the SYNTHETIC "Luna the Fox" fixture (never
// real book content), driven with Playwright in a hasTouch context.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(__dirname, "..");

// 8469 — claimed for this suite by the plan's port sweep across all five repos'
// tests/ and every open worktree. 8377 is the live family hub and 8378 is the
// gate's; 8470/8471 belong to the two-hub e2e.
const PORT = Number(process.env.ERA_TEST_HUB_PORT) || 8469;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-reader-share-"));
// The family's Drive content folder, so "Put it in my Drive" has somewhere real
// to land (books-share.js law 1 — an export outbox lives beside their books).
const FOLDER = path.join(TMP, "drive", "New ERA Content");
let child, browser;

// Minimal valid 1x1 JPEG (hand-crafted synthetic bytes, no image lib needed).
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

// Valid PCM WAV: 44-byte RIFF header + 16-bit mono sine. 8kHz, `secs` long.
function makeWav(secs) {
  const samples = Math.round(8000 * secs);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i++)
    buf.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), 44 + i * 2);
  return buf;
}

before(async () => {
  const book = path.join(TMP, "books", "luna-the-fox");
  fs.mkdirSync(path.join(book, "pages"), { recursive: true });
  fs.mkdirSync(path.join(book, "audio"), { recursive: true });
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
  for (const n of ["001", "002"]) fs.writeFileSync(path.join(book, "pages", n + ".jpg"), JPEG);
  for (const n of ["001", "002"]) fs.writeFileSync(path.join(book, "audio", n + ".wav"), makeWav(3));
  fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000002",
    slug: "luna-the-fox",
    title: "Luna the Fox",
    authored: true,
    exportedAt: "2026-08-24T00:00:00Z",
    narration: { provider: "synthetic", model: "fixture", voice: "none" },
    cover: "cover.jpg",
    pages: [
      { index: 0, image: "pages/001.jpg", text: "Luna naps now.", audio: "audio/001.wav" },
      { index: 1, image: "pages/002.jpg", text: "Good night fox.", audio: "audio/002.wav" },
    ],
  }, null, 2));
  // The content folder, written down the way drive.js records a picked one, so
  // the hub has a real outbox before it boots.
  fs.writeFileSync(path.join(TMP, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: FOLDER }));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev" },
  });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child) child.kill("SIGKILL");
});

// A pile of photos nobody has tapped Build on — reader.js's notYetCard(), the
// card shape that is NOT a finished book. /content/status is the shelf's own
// source for these, so standing one in is the whole fixture.
const pileStatus = {
  mode: "local", local: true, skipped: null, loose: 0, quietMs: 600000,
  building: false, job: null, queued: [], lastScan: null,
  jobs: [{ kind: "books", slug: "kitchen-table", title: "Kitchen Table", state: "inbox",
           waiting: "pile", buildable: true, elsewhere: false,
           progress: { pages: 12, transcribed: 0, narrated: 0 },
           held: null, error: null, paused: null }],
};

// reader-ui.test.mjs's makePage, plus the two seams this suite needs: `init`
// for a navigator.canShare stub (the Web Share API is absent in headless
// Chromium, so BOTH answers have to be stood in) and `status` for the pile.
async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await ctx.addInitScript(() => { window.__testHooks = true; });
  if (opts.init) await ctx.addInitScript(opts.init);
  if (opts.status) await ctx.route("**/content/status", r => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(opts.status) }));
  if (opts.routes) await opts.routes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && typeof window.Reader.state === "function");
  await page.waitForFunction(() => window.__shareTest && typeof window.__shareTest.holdMs === "number");
  return { ctx, page };
}

// A real finger on a real element, held for `ms`. CDP, not page.touchscreen:
// the latter only taps. touchStart -> pointerdown{pointerType:"touch"} in the
// page, which is precisely what reader-share.js filters on.
async function hold(page, selector, ms, midway) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    if (midway) { await page.waitForTimeout(Math.min(400, ms)); await midway(); await page.waitForTimeout(Math.max(0, ms - 400)); }
    else await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}

const CARD = "#shelfGrid .shelf-card:not(.is-pile):not(.is-building)";
const PILE = "#shelfGrid .shelf-card.is-pile";
const HOLD = 2200;                 // comfortably past the module's 1600 ms

const shelfState = (page) => page.evaluate(() => {
  const cards = [...document.querySelectorAll("#shelfGrid .shelf-card-button")];
  const doors = [...document.querySelectorAll(".msgbar .bardoor")];
  return {
    sheet: !!document.getElementById("shareSheet"),
    screen: (document.querySelector(".screen.show") || {}).id || null,
    cardsAwake: cards.filter(el => el.classList.contains("dwell")).length,
    cardsAsleep: cards.filter(el => !el.classList.contains("dwell") &&
      el.hasAttribute("data-dwell-disabled")).length,
    doorsAwake: doors.filter(el => el.classList.contains("dwell")).length,
    doors: doors.length,
  };
});

const CAN_SHARE = () => {
  navigator.canShare = () => true;
  navigator.share = async () => { window.__shared = (window.__shared || 0) + 1; };
};
const NO_SHARE = () => {
  navigator.canShare = () => false;
  navigator.share = undefined;
};

// ======================================================= who may open the sheet

test("a FINGER held on a finished book opens the grown-up's sheet: cover, title, three outs in spec order", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, HOLD);
  const sheet = page.locator("#shareSheet");
  await sheet.waitFor({ timeout: 3000 });
  assert.equal(await sheet.locator(".share-title").textContent(), "Luna the Fox");
  assert.match(await sheet.locator(".share-cover img").getAttribute("src"),
    /\/books\/luna-the-fox\/cover\.jpg/, "the book's own cover, on the sheet");
  // SPEC §4.2's ORDER, which is the order of how well the hardware delivers
  // them — not an alphabet and not a preference.
  const outs = await sheet.locator(".share-out").allTextContents();
  assert.deepEqual(outs.map(s => s.trim()),
    ["Send it now", "Put it in my Drive", "Save a copy"], outs.join(" | "));
  // and the hold never turned into a pick: the release click belongs to the
  // hold, not to the book underneath it
  assert.equal((await shelfState(page)).screen, "sShelf", "the hold did not open the book");
  await ctx.close();
});

// THE WHOLE SAFETY ARGUMENT. ERAgaze drives the real cursor, so a parked gaze
// and a parked mouse are the same pointer at the DOM. A hold that answered
// `mouse` would be a sheet SHE could open by looking at her own book.
test("a mouse held for two seconds opens nothing: gaze is a mouse here", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE });
  const box = await page.locator(CARD).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(HOLD);
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#shareSheet").count(), 0,
    "a mouse hold opened the send sheet — her gaze would open it too");
  await ctx.close();
});

test("a SHORT touch still opens the book: her shelf is not hold-only", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, 60);
  await page.waitForFunction(() => window.Reader.state().screen === "sRead", null, { timeout: 5000 });
  assert.equal(await page.locator("#shareSheet").count(), 0, "a tap is not a hold");
  assert.equal((await page.evaluate(() => window.Reader.state())).slug, "luna-the-fox");
  await ctx.close();
});

// dwell.js's TAP-RESCUE fires el.click() 150 ms after a long touch is released,
// remembering the `.dwell` it saw at pointerdown. reader-share.js listens in
// CAPTURE on `window` — ahead of dwell.js's own document-capture handler — and
// takes the class off before dwell.js looks, so no rescue is ever scheduled.
// Take it off for good and her gaze loses the book; take it off never and every
// completed hold opens the book under the sheet.
test("the card's button leaves `.dwell` while the finger is down and has it back after", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE });
  const btn = page.locator(CARD + " .shelf-card-button");
  await btn.waitFor();
  assert.equal(await btn.evaluate(el => el.classList.contains("dwell")), true, "awake before");
  let midway = null;
  await hold(page, CARD, HOLD, async () => {
    midway = await btn.evaluate(el => ({
      dwell: el.classList.contains("dwell"),
      disabled: el.hasAttribute("data-dwell-disabled"),
      holding: el.closest(".shelf-card").classList.contains("holding"),
      holdMs: el.closest(".shelf-card").style.getPropertyValue("--hold-ms").trim(),
    }));
  });
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  assert.equal(midway.dwell, false, "the card was still a .dwell under the finger — dwell.js would rescue it");
  assert.equal(midway.disabled, true, "…and her gaze could still have armed on it");
  assert.equal(midway.holding, true, "the fill ring runs while the finger is down");
  assert.equal(midway.holdMs, (await page.evaluate(() => window.__shareTest.holdMs)) + "ms",
    "timed to the module's own hold, not a number in the stylesheet");
  // …and given back. The sheet's own freeze then claims it like every other
  // card, so the thaw hands it back with them — one list, one owner.
  await page.evaluate(() => window.__shareTest.close());
  await page.waitForTimeout(100);
  const after = await btn.evaluate(el => ({
    dwell: el.classList.contains("dwell"),
    disabled: el.hasAttribute("data-dwell-disabled"),
    holding: el.closest(".shelf-card").classList.contains("holding"),
  }));
  assert.deepEqual(after, { dwell: true, disabled: false, holding: false },
    "the card came back to her exactly as it was");
  await ctx.close();
});

// An ABANDONED hold fires nothing at all — and on Chromium that means eating
// the click the touch sequence still sends on release, or a grown-up who
// changed their mind would have opened the book instead.
test("a hold let go early opens neither the sheet nor the book", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, 900);
  await page.waitForTimeout(500);               // past dwell.js's 150 ms rescue
  const s = await shelfState(page);
  assert.equal(s.sheet, false, "the hold was abandoned: no sheet");
  assert.equal(s.screen, "sShelf", "…and an abandoned hold is not a tap either");
  await ctx.close();
});

// Dad, 9/19. A pile of photos and a book still being made have no manifest to
// walk, so there is nothing to send — and the sheet says the one sentence a
// parent can act on rather than a fault.
test("a hold on a card that is NOT a finished book says only that it isn't finished yet", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE, status: pileStatus });
  await page.locator(PILE).waitFor();
  await hold(page, PILE, HOLD);
  const sheet = page.locator("#shareSheet");
  await sheet.waitFor({ timeout: 3000 });
  assert.equal((await sheet.locator(".share-msg").textContent()).trim(),
    "This book isn't finished yet.");
  assert.equal(await sheet.locator(".share-out").count(), 0, "nothing to press but the way out");
  assert.equal(await sheet.locator("#shareClose").count(), 1, "and there IS a way out");
  await ctx.close();
});

// A pile card is born ASLEEP (reader.js: .dwell AND data-dwell-disabled, so the
// long-press rescue and contextmenu suppression still match while her gaze
// cannot arm). A rearm that simply removed the attribute would WAKE it — a
// grown-up's hold handing her gaze the Build button. board-edit.js never met
// this, because a board tile is never born disabled.
test("holding an unfinished card leaves it exactly as asleep as it was born", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE, status: pileStatus });
  const box = page.locator(PILE + " .shelf-card-box");
  await box.waitFor();
  await hold(page, PILE, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  await page.evaluate(() => window.__shareTest.close());
  await page.waitForTimeout(100);
  assert.equal(await box.getAttribute("data-dwell-disabled"), "",
    "the pile card woke up: her gaze can now reach Build a book");
  await ctx.close();
});

// ============================================================ the sleeping shelf
// A full-screen backdrop hides nothing from dwell.js's targetAt(), which walks
// the whole elementsFromPoint stack for the first .dwell without
// [data-dwell-disabled]. So both halves go, and the bar's two doors go with
// them — this is reader.js's OWN freeze (the Build ask's), borrowed, not a
// second switch over the same list.
test("while the sheet is open the shelf and BOTH of the bar's doors are asleep, and wake together", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE, status: { ...pileStatus, jobs: [] } });
  await page.locator(CARD).waitFor();
  const before = await shelfState(page);
  assert.ok(before.cardsAwake >= 1, "a live card to start with");
  assert.equal(before.doorsAwake, before.doors, "and live doors");

  await hold(page, CARD, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  const open = await shelfState(page);
  assert.equal(open.cardsAwake, 0, "a card is still a live gaze target under the sheet");
  assert.equal(open.cardsAsleep, before.cardsAwake, "…and every one of them was claimed");
  assert.equal(open.doorsAwake, 0, "the 🚪 and the 💬 sleep under a grown-up's sheet");

  await page.evaluate(() => window.__shareTest.close());
  await page.waitForTimeout(100);
  const after = await shelfState(page);
  assert.equal(after.cardsAwake, before.cardsAwake, "her shelf came back");
  assert.equal(after.doorsAwake, before.doorsAwake, "…and so did both doors");
  await ctx.close();
});

// ================================================================== the three outs

// NEVER A BUTTON THAT DOES NOTHING (spec §4.2). The Windows share sheet is the
// nicest path in the house where it exists and is simply absent on the i13's
// Edge, so the row is drawn from the answer the browser actually gives — and
// the question is asked with a REAL File, because bare canShare() answers a
// different question ("can you share anything at all?").
test("'Send it now' is absent when navigator.canShare says no", async () => {
  const { ctx, page } = await makePage({ init: NO_SHARE });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  assert.equal(await page.locator("#shareSend").count(), 0,
    "a share button on a browser that cannot share");
  const outs = await page.locator("#shareSheet .share-out").allTextContents();
  assert.deepEqual(outs.map(s => s.trim()), ["Put it in my Drive", "Save a copy"],
    "the other two are always there");
  await ctx.close();
});

test("the canShare question is asked with a real .erabook File, never bare", async () => {
  const { ctx, page } = await makePage({ init: () => {
    window.__canShareArgs = [];
    navigator.canShare = (d) => {
      window.__canShareArgs.push(d && d.files
        ? d.files.map(f => ({ name: f.name, isFile: f instanceof File, size: f.size }))
        : null);
      return true;
    };
    navigator.share = async () => {};
  } });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  const args = await page.evaluate(() => window.__canShareArgs);
  assert.ok(args.length >= 1, "canShare was never asked");
  assert.equal(args[0] && args[0].length, 1, "asked with one file: " + JSON.stringify(args[0]));
  assert.equal(args[0][0].isFile, true, "…a real File, not a bag of properties");
  assert.match(args[0][0].name, /\.erabook$/, args[0][0].name);
  await ctx.close();
});

// THE OUT THAT SURVIVES A FORTY-MEGABYTE BOOK, and the one dad named. It writes
// into the family's own Drive folder and then says WHERE, in a parent's words —
// a download they would then have to find is not an answer on a tablet.
test("'Put it in my Drive' writes the file and says where to find it", async () => {
  const { ctx, page } = await makePage({ init: NO_SHARE });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  await page.locator("#shareDrive").click();
  await page.waitForFunction(
    () => /Google Drive/.test(document.querySelector("#shareSheet .share-msg").textContent),
    null, { timeout: 15000 });
  const said = await page.locator("#shareSheet .share-msg").textContent();
  assert.match(said, /New ERA Content/, said);
  assert.match(said, /shared/, said);
  assert.ok(fs.existsSync(path.join(FOLDER, "shared", "Luna the Fox.erabook")),
    "the bytes are where the sheet says they are");
  await ctx.close();
});

// A FAILURE KEEPS THE SHEET OPEN with a sentence a parent can act on (spec
// §4.2). The hub's own sentence, whole — it knows why better than we do.
test("a refusal from the hub stays on the sheet as its own sentence", async () => {
  const { ctx, page } = await makePage({ init: NO_SHARE, routes: (c) =>
    c.route("**/share-to-drive", r => r.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "write-failed", message: "There wasn't room to save the book." }) })) });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  await page.locator("#shareDrive").click();
  await page.waitForFunction(
    () => /room to save/.test(document.querySelector("#shareSheet .share-msg").textContent),
    null, { timeout: 8000 });
  assert.equal(await page.locator("#shareSheet").count(), 1, "the sheet stayed open");
  assert.equal(await page.locator("#shareDrive").isDisabled(), false,
    "…and they can try again");
  await ctx.close();
});

// NOTHING THIS FEATURE ADDS IS A GAZE TARGET. Not the sheet, not its buttons,
// not the hold's own ring — every one of them is a grown-up's control.
test("nothing on the send sheet is a dwell target or claims a hold", async () => {
  const { ctx, page } = await makePage({ init: CAN_SHARE });
  await page.locator(CARD).waitFor();
  await hold(page, CARD, HOLD);
  await page.locator("#shareSheet").waitFor({ timeout: 3000 });
  assert.equal(await page.locator("#shareSheet .dwell").count(), 0, "a .dwell on the sheet");
  assert.equal(await page.locator("#shareSheet [data-dwell-say]").count(), 0);
  assert.equal(await page.locator("#shareSheet [data-dwell-ms]").count(), 0);
  assert.equal(await page.locator("#shareSheet [data-dwell-disabled]").count(), 0);
  await ctx.close();
});
