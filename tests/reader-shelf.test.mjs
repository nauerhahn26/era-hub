// reader-shelf.test.mjs — the Book Reader's shelf as a TD Snap page (dad 9/30,
// docs/superpowers/specs/2026-09-30-book-shelf-layout-design.md).
//
// She has too many books for one scrolling shelf, so the shelf became her
// board's idiom: a left RAIL of sections — Back, This Week, Favorites,
// Storybooks, All, top to bottom, never moving — and the books in the same 3×4
// grid her clothing pages use:
//
//   * [2,2] and [2,3] are BLACK on every page, always: inert, no text, no
//     action, never a gaze target (board-design law, dad 9/3 in caps);
//   * More lives at [3,1] (bottom-LEFT, ux-contract anchors) and only when the
//     section has more than one page; on the last page it loops to page 1; on a
//     one-page section [3,1] is black — cells never move;
//   * books fill [1,1] [1,2] [1,3] [1,4] [2,1] [2,4] [3,2] [3,3] [3,4], nine a
//     page, and a short last page leaves the rest black;
//   * Back is the rail's top tile: one page back, dimmed and asleep on page 1;
//   * This Week = her weekly books (authored, not imported), newest week first
//     by the HUB's first-seen record — exportedAt moves on every re-publish;
//     Storybooks = everything else (scanned, from a friend, still being made),
//     All = every book, both in plain case-insensitive title order;
//   * Favorites = the books a grown-up's FINGER hold gave a ♥ — the one hold
//     that already opens the send sheet now opens one sheet with "♥ Add to
//     Favorites" and "Send to a friend". Stored on the hub, so it survives a
//     reload (and a browser reset);
//   * the Library button brings her back to the section and page she opened the
//     book from, and a reload keeps them.
//
// Harness: reader-ui.test.mjs's — the REAL server.js on a scratch port with a
// throwaway ERA_DATA_DIR and SYNTHETIC books (neutral fake titles, 1x1 JPEG
// covers, never family content), driven with Playwright at 1280x800 hasTouch.
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

// 8454 — swept free across all five repos' tests/ and every open worktree on
// 9/30 (8452/8453 are clothing-refit's). 8377 is the live family hub.
const PORT = Number(process.env.ERA_TEST_SHELF_PORT) || 8454;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-reader-shelf-"));
let child, browser;

// Every provider seam closed (reader-sizing.test.mjs's list): a hub reaches out
// on its own the moment it boots, and no test may spend a real key.
const SEAMS = {
  ERA_AI_URL: "http://127.0.0.1:1", ERA_ELEVEN_URL: "http://127.0.0.1:1",
  ERA_FAL_URL: "http://127.0.0.1:1", ERA_GEO_URL: "http://127.0.0.1:1/geo",
  ERA_WEATHER_URL: "http://127.0.0.1:1", ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode",
  ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_RESEND_URL: "http://127.0.0.1:1",
};

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64");

// THE WEEKLY BOOKS, deliberately written to disk in an order that is neither
// their week order nor their title order, so only the first-seen sort can put
// them right. exportedAt seeds first-seen on first sight.
const WEEKLY = [
  { dir: "Week Two Rain", exportedAt: "2026-09-14T06:00:00Z" },
  { dir: "Week Three Park", exportedAt: "2026-09-21T06:00:00Z" },
  { dir: "Week One Walk", exportedAt: "2026-09-07T06:00:00Z" },
];
// Twelve scanned books, mixed case and numbers: plain case-insensitive,
// numeric-aware title order is "2 Owls" before "10 Ducks", "apple" with "Apple".
const SCANNED = [
  "zebra zoom", "Banana Boat", "apple pie", "Cat Nap", "10 Ducks", "2 Owls",
  "Moon Song", "Little Cloud", "hat on a hen", "Jolly Jam", "Kite Day", "Egg Hunt",
];
const FRIEND = "Friendly Fish";        // imported: carries the share envelope

const slugOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ALPHA = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

function writeBook(dir, extra = {}) {
  const b = path.join(TMP, "books", dir);
  fs.mkdirSync(path.join(b, "pages"), { recursive: true });
  fs.writeFileSync(path.join(b, "cover.jpg"), JPEG);
  fs.writeFileSync(path.join(b, "pages", "001.jpg"), JPEG);
  fs.writeFileSync(path.join(b, "manifest.json"), JSON.stringify({
    schemaVersion: 1, slug: slugOf(dir), title: dir, cover: "cover.jpg",
    narration: { provider: "synthetic", model: "fixture", voice: "none" },
    pages: [{ index: 0, image: "pages/001.jpg", text: "A calm page.", audio: null }],
    ...extra,
  }, null, 2));
  return b;
}

before(async () => {
  for (const w of WEEKLY) writeBook(w.dir, { authored: true, exportedAt: w.exportedAt });
  for (const t of SCANNED) writeBook(t, { exportedAt: "2026-09-02T00:00:00Z" });
  const f = writeBook(FRIEND, { authored: true, exportedAt: "2026-09-25T00:00:00Z" });
  fs.writeFileSync(path.join(f, ".erabook.json"), JSON.stringify({
    v: 1, title: FRIEND, slug: slugOf(FRIEND), pages: 1, exportedAt: "2026-09-25T00:00:00Z",
    from: { app: "Our Era Comms", build: "20260925.1200" },
  }));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_DEVICE_ID: "test-dev", ...SEAMS },
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
  fs.rmSync(TMP, { recursive: true, force: true });
});

// A fresh hub-side ♥ state per test that cares, straight through the door the
// sheet uses (the route's own guards are books.test.mjs's business).
async function setFav(slug, on) {
  const r = await fetch(`${BASE}/books/${slug}/favorite`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: on }) });
  assert.equal(r.status, 200);
}
async function clearFavs() {
  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  for (const b of idx) if (b.favorite) await setFav(b.slug, false);
}

async function makePage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 },
                                         hasTouch: true, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { window.__testHooks = true; });
  if (opts.init) await ctx.addInitScript(opts.init);
  if (opts.routes) await opts.routes(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && window.Reader.state().shelfCount > 0);
  await page.locator("#shelfGrid [data-cell]").first().waitFor();
  return { ctx, page };
}
const state = (page) => page.evaluate(() => window.Reader.state());

// Every one of the twelve cells, by its [row,col], as the page drew it.
const cells = (page) => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll("#shelfGrid > [data-cell]")) {
    const card = el.classList.contains("shelf-card") ? el : null;
    out[el.dataset.cell] = {
      kind: el.classList.contains("shelf-black") ? "black"
          : el.id === "shelfMore" ? "more"
          : card ? "book" : "other",
      slug: card ? card.dataset.slug : null,
      title: card ? (card.querySelector(".shelf-title") || {}).textContent : null,
      text: el.textContent.trim(),
      dwell: el.classList.contains("dwell") || !!el.querySelector(".dwell"),
      dwellAttrs: [...el.querySelectorAll("*"), el].some(n =>
        [...n.attributes].some(a => a.name.startsWith("data-dwell"))),
      ariaHidden: el.getAttribute("aria-hidden"),
    };
  }
  return out;
});
const BOOK_CELLS = ["1,1", "1,2", "1,3", "1,4", "2,1", "2,4", "3,2", "3,3", "3,4"];
const ALL_CELLS = ["1,1", "1,2", "1,3", "1,4", "2,1", "2,2", "2,3", "2,4", "3,1", "3,2", "3,3", "3,4"];

// The titles on the current page, in the nine cells' reading order.
async function pageTitles(page) {
  const c = await cells(page);
  return BOOK_CELLS.map(k => c[k]).filter(x => x.kind === "book").map(x => x.title);
}

async function rail(page, id) {
  await page.locator("#" + id).click();
  await page.waitForTimeout(50);
}

// THE LAW, checked on whatever page is up: twelve cells in place, the two
// centre cells black and inert, More only at [3,1].
async function assertLaw(page, where) {
  const c = await cells(page);
  assert.deepEqual(Object.keys(c).sort(), [...ALL_CELLS].sort(), where + ": twelve cells, each once");
  for (const k of ["2,2", "2,3"]) {
    assert.equal(c[k].kind, "black", `${where}: [${k}] must be black`);
    assert.equal(c[k].text, "", `${where}: [${k}] carries text`);
    assert.equal(c[k].dwell, false, `${where}: [${k}] is a dwell target`);
    assert.equal(c[k].dwellAttrs, false, `${where}: [${k}] carries a data-dwell-* attribute`);
  }
  for (const k of ALL_CELLS) if (k !== "3,1")
    assert.notEqual(c[k].kind, "more", `${where}: More at [${k}] — it lives at [3,1] only`);
  assert.equal(await page.locator("#shelfGrid #shelfMore").count() <= 1, true);
  return c;
}

// ============================================================ the rail

test("the rail: Back, This Week, Favorites, Storybooks, All — top to bottom, plain dwell, smaller than a book", async () => {
  const { ctx, page } = await makePage();
  const r = await page.evaluate(() => [...document.querySelectorAll("#shelfRail > *")].map(el => {
    const b = el.getBoundingClientRect();
    return { id: el.id, text: el.textContent.trim(), dwell: el.classList.contains("dwell"),
             ms: el.getAttribute("data-dwell-ms"), top: b.top, h: b.height, w: b.width };
  }));
  assert.deepEqual(r.map(x => x.id), ["railBack", "railWeek", "railFav", "railStory", "railAll"]);
  assert.match(r[0].text, /Back/); assert.match(r[1].text, /This Week/);
  assert.match(r[2].text, /Favorites/); assert.match(r[3].text, /Storybooks/);
  assert.match(r[4].text, /^All$/);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].top > r[i - 1].top, "rail order is top to bottom");
  for (const x of r) {
    assert.equal(x.dwell, true, x.id + " is a dwell target (§C: plain dwell)");
    assert.equal(x.ms, null, x.id + " claims its own hold");
  }
  const book = await page.locator("#shelfGrid .shelf-card").first().boundingBox();
  for (const x of r) assert.ok(x.h * x.w < book.height * book.width, x.id + " is not smaller than a book tile");
  // the rail spans the grid's height and never scrolls
  const grid = await page.locator("#shelfGrid").boundingBox();
  const last = r[r.length - 1];
  assert.ok(Math.abs(r[0].top - grid.y) < 2 && Math.abs(last.top + last.h - (grid.y + grid.height)) < 2,
    "five rail tiles fill the grid's height");
  await ctx.close();
});

test("opening the reader lands on This Week page 1, newest week first, and the rail says so", async () => {
  const { ctx, page } = await makePage();
  const s = await state(page);
  assert.equal(s.section, "week");
  assert.equal(s.shelfPage, 0);
  assert.equal(await page.locator("#railWeek.is-current").count(), 1, "This Week is lit");
  assert.equal(await page.locator("#shelfRail .is-current").count(), 1, "…and only it");
  assert.deepEqual(await pageTitles(page), ["Week Three Park", "Week Two Rain", "Week One Walk"],
    "newest week at [1,1]; an imported authored book is NOT a weekly book");
  // Back sleeps on page 1: dimmed AND asleep to her gaze
  const back = page.locator("#railBack");
  assert.equal(await back.getAttribute("data-dwell-disabled"), "");
  assert.equal(await back.evaluate(el => el.classList.contains("is-disabled")), true);
  // a one-page section: [3,1] is black, not More
  const c = await assertLaw(page, "This Week p1");
  assert.equal(c["3,1"].kind, "black", "one page: no More, [3,1] black");
  // a short page leaves the unfilled book cells black — cells never move
  assert.equal(c["1,3"].kind, "book");
  for (const k of ["1,4", "2,1", "2,4", "3,2", "3,3", "3,4"]) assert.equal(c[k].kind, "black", k);
  await ctx.close();
});

// ============================================================ the grid

test("Storybooks: scanned + from a friend, alphabetical; 9 a page in the listed cells; More at [3,1] loops", async () => {
  const { ctx, page } = await makePage();
  await rail(page, "railStory");
  const want = [...SCANNED, FRIEND].sort(ALPHA);
  assert.equal(want.length, 13);
  let s = await state(page);
  assert.equal(s.section, "story"); assert.equal(s.shelfPage, 0); assert.equal(s.shelfPages, 2);
  assert.equal(await page.locator("#railStory.is-current").count(), 1);

  let c = await assertLaw(page, "Storybooks p1");
  assert.deepEqual(BOOK_CELLS.map(k => c[k].title), want.slice(0, 9),
    "nine books in [1,1] [1,2] [1,3] [1,4] [2,1] [2,4] [3,2] [3,3] [3,4] order");
  assert.equal(c["3,1"].kind, "more", "more than one page: More at [3,1]");
  assert.equal(c["3,1"].dwell, true, "More is a plain dwell target");
  assert.equal(await page.locator("#shelfMore").getAttribute("data-dwell-ms"), null);
  // the friend's book keeps its badge in Storybooks
  assert.equal(await page.locator(`#shelfGrid .shelf-card[data-slug="${slugOf(FRIEND)}"] .shelf-shared-badge`).count(), 1);

  await page.locator("#shelfMore").click();
  s = await state(page);
  assert.equal(s.shelfPage, 1);
  c = await assertLaw(page, "Storybooks p2");
  assert.deepEqual((await pageTitles(page)), want.slice(9), "page 2 holds the rest, in order");
  assert.equal(c["3,1"].kind, "more", "More stays at [3,1] on the last page");
  for (const k of ["2,4", "3,2", "3,3", "3,4"]) assert.equal(c[k].kind, "black", "short last page: " + k);
  // Back wakes past page 1
  assert.equal(await page.locator("#railBack").getAttribute("data-dwell-disabled"), null);

  // More on the LAST page loops to page 1
  await page.locator("#shelfMore").click();
  assert.equal((await state(page)).shelfPage, 0, "More loops to page 1");
  // …and Back goes one page back (here: from page 2)
  await page.locator("#shelfMore").click();
  await page.locator("#railBack").click();
  assert.equal((await state(page)).shelfPage, 0, "Back = one page back");
  assert.equal(await page.locator("#railBack").getAttribute("data-dwell-disabled"), "");
  await ctx.close();
});

test("the black centre is inert: tapping it does nothing", async () => {
  const { ctx, page } = await makePage();
  await rail(page, "railStory");
  const before = await state(page);
  for (const k of ["2,2", "2,3"]) await page.locator(`#shelfGrid > [data-cell="${k}"]`).click();
  await page.waitForTimeout(100);
  const after = await state(page);
  assert.equal(after.screen, "sShelf");
  assert.equal(after.section, before.section);
  assert.equal(after.shelfPage, before.shelfPage);
  await ctx.close();
});

test("All: every book, alphabetical, the centre black on every page", async () => {
  const { ctx, page } = await makePage();
  await rail(page, "railAll");
  const want = [...SCANNED, FRIEND, ...WEEKLY.map(w => w.dir)].sort(ALPHA);
  const s = await state(page);
  assert.equal(s.section, "all");
  assert.equal(s.shelfPages, Math.ceil(want.length / 9));
  const seen = [];
  for (let p = 0; p < s.shelfPages; p++) {
    await assertLaw(page, "All p" + (p + 1));
    seen.push(...await pageTitles(page));
    await page.locator("#shelfMore").click();
  }
  assert.deepEqual(seen, want);
  assert.equal((await state(page)).shelfPage, 0, "…and looped home");
  await ctx.close();
});

test("choosing a section opens its page 1", async () => {
  const { ctx, page } = await makePage();
  await rail(page, "railStory");
  await page.locator("#shelfMore").click();
  assert.equal((await state(page)).shelfPage, 1);
  await rail(page, "railAll");
  assert.equal((await state(page)).shelfPage, 0);
  await rail(page, "railStory");
  assert.equal((await state(page)).shelfPage, 0, "a section always opens on page 1");
  await ctx.close();
});

test("This Week keeps its order when a re-publish bumps exportedAt (first-seen is the hub's)", async () => {
  const m = path.join(TMP, "books", "Week One Walk", "manifest.json");
  const was = fs.readFileSync(m, "utf8");
  // warm the index once so first-seen is on record, then re-publish the OLDEST
  await fetch(`${BASE}/books/index.json`);
  fs.writeFileSync(m, JSON.stringify({ ...JSON.parse(was), exportedAt: "2026-09-29T23:00:00Z" }, null, 2));
  try {
    const { ctx, page } = await makePage();
    assert.deepEqual(await pageTitles(page), ["Week Three Park", "Week Two Rain", "Week One Walk"]);
    await ctx.close();
  } finally { fs.writeFileSync(m, was); }
});

// ============================================================ favorites

test("empty Favorites: every cell black, and one inert note OUTSIDE the grid says how", async () => {
  await clearFavs();
  const { ctx, page } = await makePage();
  await rail(page, "railFav");
  assert.equal((await state(page)).section, "fav");
  const c = await assertLaw(page, "Favorites (empty)");
  for (const k of ALL_CELLS) assert.equal(c[k].kind, "black", "empty Favorites: [" + k + "] black");
  const note = page.locator("#shelfNote");
  assert.equal(await note.isVisible(), true);
  assert.equal((await note.textContent()).trim(), "Hold a book's cover to add it to Favorites.");
  assert.equal(await note.evaluate(el => el.closest("#shelfGrid") === null), true, "the note is not in a cell");
  assert.equal(await note.evaluate(el => el.classList.contains("dwell") || !!el.querySelector(".dwell")), false);
  // …and it is Favorites' own: gone on another section
  await rail(page, "railStory");
  assert.equal(await note.isVisible(), false);
  await ctx.close();
});

// A real finger held on a real element (reader-share.test.mjs's helper): CDP
// touch, because page.touchscreen can only tap.
async function hold(page, selector, ms) {
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}

test("the hold sheet gives a ♥: badge, stored on the hub, in Favorites, survives a reload — and takes it back", async () => {
  await clearFavs();
  const { ctx, page } = await makePage();
  await rail(page, "railStory");
  const slug = slugOf("Cat Nap");
  const card = `#shelfGrid .shelf-card[data-slug="${slug}"]`;
  await hold(page, card, 2200);
  const sheet = page.locator("#shareSheet");
  await sheet.waitFor({ timeout: 3000 });
  const btns = (await sheet.locator(".share-choice").allTextContents()).map(s => s.trim());
  assert.deepEqual(btns, ["♥ Add to Favorites", "Send to a friend"], btns.join(" | "));
  assert.equal(await sheet.locator(".dwell, [data-dwell-say], [data-dwell-ms]").count(), 0,
    "nothing on the sheet is a gaze target");
  await page.locator("#shareFav").click();
  await sheet.waitFor({ state: "detached", timeout: 5000 });
  await page.locator(card + " .shelf-fav-badge").waitFor({ timeout: 5000 });
  const badge = page.locator(card + " .shelf-fav-badge");
  assert.equal(await badge.evaluate(el => el.classList.contains("dwell") ||
    [...el.attributes].some(a => a.name.startsWith("data-dwell"))), false, "the ♥ is decoration");
  const idx = await (await fetch(`${BASE}/books/index.json`)).json();
  assert.equal(idx.find(b => b.slug === slug).favorite, true, "the hub holds the ♥");

  await rail(page, "railFav");
  assert.deepEqual(await pageTitles(page), ["Cat Nap"]);
  assert.equal(await page.locator("#shelfNote").isVisible(), false, "no how-to note once there is a favorite");

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && window.Reader.state().shelfCount > 0);
  await page.locator(card + " .shelf-fav-badge").waitFor({ timeout: 5000 });
  assert.equal((await state(page)).section, "fav", "a reload keeps the section");

  // the same hold takes it back
  await hold(page, card, 2200);
  await sheet.waitFor({ timeout: 3000 });
  assert.equal((await page.locator("#shareFav").textContent()).trim(), "♥ Remove from Favorites");
  await page.locator("#shareFav").click();
  await sheet.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForFunction(() => window.Reader.state().shelfCount > 0 &&
    !document.querySelector("#shelfGrid .shelf-card"), null, { timeout: 5000 });
  assert.equal((await (await fetch(`${BASE}/books/index.json`)).json())
    .find(b => b.slug === slug).favorite, false);
  await ctx.close();
});

test("Favorites sort alphabetically, and a mouse held on a cover gives no ♥ (gaze is a mouse)", async () => {
  await clearFavs();
  for (const t of ["zebra zoom", "Week Two Rain", "apple pie"]) await setFav(slugOf(t), true);
  const { ctx, page } = await makePage();
  await rail(page, "railFav");
  assert.deepEqual(await pageTitles(page), ["apple pie", "Week Two Rain", "zebra zoom"]);
  await rail(page, "railStory");
  const box = await page.locator(`#shelfGrid .shelf-card[data-slug="${slugOf("Banana Boat")}"]`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(2200); await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#shareSheet").count(), 0, "a mouse hold opened the ♥ sheet");
  await clearFavs();
  await ctx.close();
});

// ============================================================ coming back

test("the Library button returns to the section and page the book was opened from", async () => {
  const { ctx, page } = await makePage();
  await rail(page, "railStory");
  await page.locator("#shelfMore").click();
  const titles = await pageTitles(page);
  await page.locator("#shelfGrid .shelf-card-button", { hasText: titles[1] }).click();
  await page.waitForFunction(() => window.Reader.state().screen === "sRead");
  await page.locator("#btnLibrary").click();
  await page.waitForFunction(() => window.Reader.state().screen === "sShelf");
  const s = await state(page);
  assert.equal(s.section, "story"); assert.equal(s.shelfPage, 1);
  assert.deepEqual(await pageTitles(page), titles);
  await ctx.close();
});

test("a reload keeps the section and page; a fresh open starts on This Week", async () => {
  const { ctx, page } = await makePage();
  await rail(page, "railAll");
  await page.locator("#shelfMore").click();
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && window.Reader.state().shelfCount > 0);
  let s = await state(page);
  assert.equal(s.section, "all"); assert.equal(s.shelfPage, 1, "the page survived the reload");
  // a fresh open — she came in through her home screen, not a reload
  await page.goto(`${BASE}/reader/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.Reader && window.Reader.state().shelfCount > 0);
  s = await state(page);
  assert.equal(s.section, "week"); assert.equal(s.shelfPage, 0, "opening the reader opens This Week");
  await ctx.close();
});

test("no weekly books: the reader opens on Storybooks", async () => {
  const { ctx, page } = await makePage({ routes: (c) => c.route("**/books/index.json", async (r) => {
    const rows = await (await r.fetch()).json();
    await r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(rows.filter(b => b.authored !== true)) });
  }) });
  assert.equal((await state(page)).section, "story");
  await ctx.close();
});

// ============================================================ it fits

for (const [w, h] of [[1920, 1080], [1280, 800], [1280, 720]]) {
  test(`at ${w}x${h} the whole page fits — no scroll, uniform cells, square covers`, async () => {
    const { ctx, page } = await makePage({ viewport: { width: w, height: h } });
    await rail(page, "railStory");
    const m = await page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const kids = [...document.querySelectorAll("#shelfGrid > [data-cell]")];
      const covers = [...document.querySelectorAll("#shelfGrid .shelf-card .shelf-cover")];
      const shelf = document.getElementById("sShelf");
      return {
        bottom: Math.max(...kids.map(k => r(k).bottom), ...[...document.querySelectorAll("#shelfRail > *")].map(k => r(k).bottom)),
        scrolls: shelf.scrollHeight > shelf.clientHeight + 1,
        ws: kids.map(k => +r(k).width.toFixed(1)), hs: kids.map(k => +r(k).height.toFixed(1)),
        cw: covers.map(c => r(c).width), ch: covers.map(c => r(c).height),
      };
    });
    assert.ok(m.bottom <= h + 0.5, `the shelf runs off the screen: ${m.bottom} > ${h}`);
    assert.equal(m.scrolls, false, "the shelf scrolls — the rail and More are the only way through");
    const spread = (a) => Math.max(...a) - Math.min(...a);
    assert.ok(spread(m.ws) < 1 && spread(m.hs) < 1, `cells uniform: ${JSON.stringify([m.ws, m.hs])}`);
    assert.ok(spread(m.cw) < 1, "covers one size");
    for (let i = 0; i < m.cw.length; i++) assert.ok(Math.abs(m.cw[i] - m.ch[i]) < 1, "covers are square");
    assert.ok(m.cw[0] >= 80, `covers are big enough to see: ${m.cw[0]}`);
    await ctx.close();
  });
}
