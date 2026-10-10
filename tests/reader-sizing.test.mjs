// reader-sizing.test.mjs — the Book Reader must MATCH THE OLD Book-Reader app,
// pixel for pixel, at 1920x1080 CSS px (dad 9/7: "A lot of sizing on the book
// reader is also off from the previous. It should match it, pixel perfect...
// you should be able to see a lot more books on a single page, and also the
// arrows to turn the page").
//
// Two separate things were wrong on the device and only ONE of them is CSS:
//
//  1. SCALE. The old suite launched Chrome with --force-device-scale-factor=1
//     (aac-board-builder/aac-studio/install/windows-device.ps1:50), so the
//     I-13's 1920x1080 panel gave 1920x1080 CSS px. The new start-hub.bat
//     dropped the flag, so Windows' 150% scaling makes it 1280x720 CSS px and
//     every fixed px renders 1.5x larger: 3 book columns instead of 5, corner
//     arrows 147px wide instead of 98. That is fixed in the launcher, not here
//     — but this suite pins the 1920 numbers so the regression is loud.
//
//  2. REAL DRIFT (fixed in this commit). .dwell-button gained
//     `display:flex; align-items:center; justify-content:center` (the divs
//     here stand in for the old app's <button> elements) and that centring
//     leaked into .shelf-card-button, which re-declares display:grid. A
//     centred grid sizes its auto column to max-content, so each card's cover
//     shrank to its TITLE's width: covers 113-271px instead of a uniform
//     319.59px, card heights 263-344px instead of a uniform 379.22px, ragged
//     rows. reader.js also appended the cover and title straight to the tile
//     instead of inside the old DwellButton's <span class="dwell-label">,
//     which turned the title into a blockified grid item (+10px grid gap,
//     taller line box) and grew every card by ~14px.
//
// 9/30: THE SHELF IS A TD SNAP PAGE NOW (dad, spec 2026-09-30) — a rail of
// sections and a 3x4 centre-black grid, nine books a page, no scrolling. The
// old app's "5 columns of 319.6px covers, 10 on the first screen" numbers
// described the single scrolling shelf that page replaced, so the two shelf
// tests below pin the NEW page's geometry instead: 4 columns x 3 rows, every
// cell one size, every cover one size and square, the title still inside the
// old DwellButton wrapper, all nine books wholly on screen under the bar. The
// regression they were written against (a centred grid track sizing covers to
// their TITLE — ragged covers) is still exactly what they catch. The reading
// page's numbers below are unchanged and still the old app's.
// (reader-shelf.test.mjs owns the page's laws: cells, rail, More, sections.)
//
// Reference numbers below are measured from the old app itself
// (/home/claude/Book-Reader: app/globals.css + components/library-client.tsx
// + components/reader-client.tsx) rendered at the same viewport.
//
// Synthetic fixture books only — never family book content.
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

// scratch port: reader-ui uses 8391, settings-ui 8423/8424 — 8450 is ours.
const PORT = 8450;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-reader-size-"));
let child, browser;

// No test may spend a real key, and a hub reaches out on its own the moment it
// boots: server.js calls clothing.start() for every hub and the 20 s tick asks
// ipapi/Open-Meteo for the weather (clothing-worker.js:926-939), /content/status
// asks ElevenLabs for the month's voice left, a Resend send is a real email, fal
// spends per press. An UNSET seam means the provider's production base, and this
// suite spawns with `...process.env`, so every one has to be named here — the
// same list tools/era-gate.sh exports gate-wide (the last test pins the parity).
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1",
  ERA_FAL_URL: "http://127.0.0.1:1", ERA_GEO_URL: "http://127.0.0.1:1/geo",
  ERA_WEATHER_URL: "http://127.0.0.1:1", ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode",
  ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
};

// Minimal valid 1x1 JPEG (synthetic bytes, no image lib needed).
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

// Titles of wildly different lengths: a centred grid track sizes itself to the
// TITLE, so ragged covers only show up when the titles differ. All synthetic.
const TITLES = [
  "Sunny Pond", "Luna the Fox", "The Blue Boat", "Rain on the Roof",
  "Ten Little Stones", "Marla and the Kite", "A Very Long Walk Home",
  "Snow Day", "The Sleepy Bear", "Frogs Count to Five", "Under the Bridge",
  "Wind in the Reeds",
];

before(async () => {
  TITLES.forEach((title, i) => {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const book = path.join(TMP, "books", slug);
    fs.mkdirSync(path.join(book, "pages"), { recursive: true });
    fs.writeFileSync(path.join(book, "cover.jpg"), JPEG);
    for (const n of ["001", "002"]) fs.writeFileSync(path.join(book, "pages", n + ".jpg"), JPEG);
    fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
      slug, title,
      authored: i % 4 === 0,
      exportedAt: "2026-08-24T00:00:00Z",
      narration: { provider: "synthetic", model: "fixture", voice: "none" },
      cover: "cover.jpg",
      pages: [
        { index: 0, image: "pages/001.jpg", text: "Sunny pond is calm today.", audio: null },
        { index: 1, image: "pages/002.jpg", text: "Good night pond.", audio: null },
      ],
    }, null, 2));
  });

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB,
    // ...SEAMS last: every provider seam points nowhere, whatever this shell
    // happens to have exported.
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_CONSOLE: "1", ...SEAMS },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + "/books/index.json"); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  child?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// deviceScaleFactor 1 + a 1920x1080 viewport is EXACTLY what
// --force-device-scale-factor=1 gives on the I-13.
async function shelfAt(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/reader/", { waitUntil: "networkidle" });
  await page.waitForSelector("#shelfGrid .shelf-card-button");
  // All: every one of the twelve fixture books, so page 1 is a FULL page of
  // nine with titles of every length on it.
  await page.locator("#railAll").click();
  await page.waitForFunction(() => window.Reader.state().section === "all");
  const m = await page.evaluate(() => {
    const grid = document.querySelector(".shelf-grid");
    const gs = getComputedStyle(grid);
    const cards = [...document.querySelectorAll("#shelfGrid .shelf-card")]
      .filter(c => c.querySelector(".shelf-card-button"));
    const cells = [...document.querySelectorAll("#shelfGrid > [data-cell]")];
    const rect = (e) => e.getBoundingClientRect();
    return {
      // the shared door bar takes its strip off the top of the shelf (9/17):
      // measured, never restated — doorbar.js owns the 9% rule.
      barH: +rect(document.querySelector(".msgbar")).height.toFixed(2),
      columns: gs.gridTemplateColumns.split(" ").length,
      rows: gs.gridTemplateRows.split(" ").length,
      cellWidths: cells.map(c => +rect(c).width.toFixed(2)),
      cellHeights: cells.map(c => +rect(c).height.toFixed(2)),
      titleHeights: cards.map(c => +rect(c.querySelector(".shelf-title")).height.toFixed(2)),
      gap: gs.gap,
      gridWidth: +rect(grid).width.toFixed(2),
      cardWidth: +rect(cards[0]).width.toFixed(2),
      cardHeights: cards.map(c => +rect(c).height.toFixed(2)),
      coverWidths: cards.map(c => +rect(c.querySelector(".shelf-cover")).width.toFixed(2)),
      coverHeights: cards.map(c => +rect(c.querySelector(".shelf-cover")).height.toFixed(2)),
      // a title inside the old DwellButton wrapper, as the old app rendered it
      titleWrapped: cards.every(c => c.querySelector(".dwell-label > .shelf-title")),
      fullyVisible: cards.filter(c => rect(c).bottom <= innerHeight + 0.5).length,
    };
  });
  await ctx.close();
  return m;
}

async function readerAt(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/reader/", { waitUntil: "networkidle" });
  await page.waitForSelector("#shelfGrid .shelf-card-button");
  await page.locator("#shelfGrid .shelf-card-button").first().click();
  await page.waitForSelector("#sRead.show");
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const rect = (e) => { const b = e.getBoundingClientRect();
      return { w: +b.width.toFixed(2), h: +b.height.toFixed(2), x: +b.x.toFixed(2), y: +b.y.toFixed(2) }; };
    const barH = +document.querySelector(".msgbar").getBoundingClientRect().height.toFixed(2);
    const prev = document.querySelector(".reader-prev-button");
    const next = document.querySelector(".reader-next-button");
    // a silent fixture page is "ready" the moment it opens, so drop the ready
    // classes to measure the ordinary corner arrow first.
    next.classList.remove("reader-next-button-ready", "reader-next-button-pulse");
    const small = { prev: rect(prev), next: rect(next),
                    fontSize: getComputedStyle(next).fontSize,
                    arrowFontSize: getComputedStyle(next.querySelector(".reader-arrow")).fontSize };
    next.classList.add("reader-next-button-ready", "reader-next-button-pulse");
    const ready = rect(next);
    const transform = getComputedStyle(next).transform;
    return { small, ready, transform, barH };
  });
  await ctx.close();
  return m;
}

const spread = (a) => +(Math.max(...a) - Math.min(...a)).toFixed(2);

test("shelf at 1920x1080 CSS: a 4x3 page, nine books wholly on screen, uniform square covers", async () => {
  const m = await shelfAt(1920, 1080);
  assert.equal(m.columns, 4, "4 columns right of the rail (spec 2026-09-30)");
  assert.equal(m.rows, 3, "3 rows");
  assert.equal(m.cardHeights.length, 9, "nine books a page");

  // THE regression guard, and it needs no font metrics: every cell, every
  // card and every cover is one size. A centred grid track makes them ragged.
  assert.ok(spread(m.cellWidths) < 0.5 && spread(m.cellHeights) < 0.5,
    `cells must all be one size, got ${JSON.stringify([m.cellWidths, m.cellHeights])}`);
  assert.ok(spread(m.coverWidths) < 0.5, `covers must all be one width, got ${JSON.stringify(m.coverWidths)}`);
  assert.ok(spread(m.cardHeights) < 0.5, `cards must all be one height, got ${JSON.stringify(m.cardHeights)}`);
  for (let i = 0; i < m.coverWidths.length; i++)
    assert.ok(Math.abs(m.coverWidths[i] - m.coverHeights[i]) < 0.5, "covers are square (aspect-ratio 1/1)");
  // the cover takes the card's height: card = padding + cover + gap + title
  const inner = m.cardHeights[0] - 2 * 10 - 2 * 1;       // 10px padding + 1px border
  assert.ok(Math.abs(m.coverHeights[0] + 6 + m.titleHeights[0] - inner) < 1.5,
    `cover ${m.coverHeights[0]} + title ${m.titleHeights[0]} must fill the card's ${inner}px`);
  assert.ok(m.coverWidths[0] >= 200, `a cover she can see across a room: ${m.coverWidths[0]}px`);
  assert.ok(m.titleWrapped, "cover+title live inside the old DwellButton's .dwell-label wrapper");
  assert.ok(m.barH > 0 && m.barH <= 124, `the bar is a slim strip, got ${m.barH}`);
  console.log(`# bar ${m.barH}px — cover ${m.coverWidths[0]}px square at 1920x1080`);
  assert.equal(m.fullyVisible, 9, `all nine books wholly on the page under a ${m.barH}px bar`);
});

test("shelf at 1280x720 CSS (no scale-factor flag): the same page, still uniform", async () => {
  // Not the shipping geometry — this is what Windows' 150% scaling gives when
  // the kiosk forgets --force-device-scale-factor=1. The page is the same page
  // (cells never move); only its size changes, and it must stay UNIFORM.
  const m = await shelfAt(1280, 720);
  assert.equal(m.columns, 4);
  assert.equal(m.rows, 3);
  assert.ok(spread(m.coverWidths) < 0.5, `covers uniform at 1280 too, got ${JSON.stringify(m.coverWidths)}`);
  assert.ok(spread(m.cardHeights) < 0.5, `cards uniform at 1280 too, got ${JSON.stringify(m.cardHeights)}`);
  assert.ok(Math.abs(m.coverWidths[0] - m.coverHeights[0]) < 0.5, "covers still square");
  assert.equal(m.fullyVisible, 9, "nine books wholly on screen");
});

test("page arrows at 1920x1080 CSS: 3.2rem corner glyphs, 5.625x ready-arrow", async () => {
  const m = await readerAt(1920, 1080);
  // old app: .reader-prev/next-button font-size 3.2rem -> 51.2px, the glyph
  // span 1.45em -> 74.24px, box 98.23x86.23 at 16px from the corner.
  assert.equal(m.small.fontSize, "51.2px", "corner arrow button font-size (3.2rem)");
  assert.equal(m.small.arrowFontSize, "74.24px", "corner arrow glyph (1.45em of 3.2rem)");
  assert.ok(Math.abs(m.small.prev.h - 86.23) < 1, `prev arrow box height ${m.small.prev.h}, old app 86.23`);
  assert.ok(Math.abs(m.small.next.h - 86.23) < 1, `next arrow box height ${m.small.next.h}, old app 86.23`);
  assert.equal(m.small.prev.x, 16, "prev arrow 16px from the left edge");
  // 16px from the top of the STAGE, which now starts under the shared door bar
  // (9/17) — the arrow kept its place in the frame, the frame moved down.
  assert.equal(m.small.prev.y, +(16 + m.barH).toFixed(2),
    `prev arrow 16px below the ${m.barH}px bar`);
  assert.ok(Math.abs(m.small.next.x + m.small.next.w - (1920 - 16)) < 1, "next arrow 16px from the right edge");

  // the big "she may turn the page now" arrow: scale(5.625), never bigger.
  assert.match(m.transform, /^matrix\(5\.625, 0, 0, 5\.625,/, `ready-arrow transform ${m.transform}`);
  const grew = m.ready.h / m.small.next.h;
  assert.ok(Math.abs(grew - 5.625) < 0.05, `ready arrow grows 5.625x, got ${grew.toFixed(3)}`);
  assert.ok(Math.abs(m.ready.h - 485.07) < 6, `ready arrow height ${m.ready.h}, old app 485.07`);
  assert.ok(Math.abs(m.ready.w - 552.57) < 6, `ready arrow width ${m.ready.w}, old app 552.57`);
});

// The harness guard on SEAMS itself. A name no hub file reads LOOKS like a
// closed seam and closes nothing — this suite shipped with ERA_TTS_URL, which
// exists nowhere in era-hub, while the real ElevenLabs/fal/geo/weather seams
// sat at their production URLs (9/7 review). A seam LEFT OUT is the same bug
// with no misspelling to notice, so pin both directions: every name here is
// read by the hub, and nothing the gate closes gate-wide is missing here.
test("every provider seam this suite spawns with is real, and none is missing", () => {
  const src = fs.readdirSync(HUB).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(HUB, f), "utf8")).join("\n");
  // assert.ok, not assert.match: a failing match would dump the whole hub.
  for (const name of Object.keys(SEAMS))
    assert.ok(new RegExp(`process\\.env\\.${name}\\b`).test(src),
      `${name} is not a seam — no hub file reads it, so it closes nothing`);

  const gate = fs.readFileSync(path.join(HUB, "tools/era-gate.sh"), "utf8");
  const closed = new Set([...gate.matchAll(/\b(ERA_[A-Z_]*URL)="http:\/\/127\.0\.0\.1:1/g)].map((m) => m[1]));
  assert.ok(closed.size >= 8, `only ${closed.size} seams parsed out of era-gate.sh`);
  for (const name of closed)
    assert.ok(name in SEAMS,
      `era-gate.sh closes ${name} gate-wide; this suite leaves it at its production base`);
});
