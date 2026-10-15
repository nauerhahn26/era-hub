// icons.test.mjs — every app wears its own icon (dad 9/3: "use icons from
// Ellie's original for all the new era products"). Her i13's .ico files ship
// as public/icons/<id>.ico (desktop shortcuts) with a .png twin (home tiles);
// Music and Movies were drawn to match. Runs against the live :8377 hub like
// the other engine suites; the tile check drives the real home page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:8377";
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

test("every app — engine included — has a real .ico on disk; every page app a .png", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.ok(apps.length >= 6, "the app registry answered");
  for (const a of apps) {
    const ico = path.join(HUB, "public", "icons", a.id + ".ico");
    assert.ok(fs.existsSync(ico), `${a.id}.ico is missing`);
    const head = fs.readFileSync(ico).subarray(0, 4);
    assert.deepEqual([...head], [0, 0, 1, 0], `${a.id}.ico is not an ICO container`);
    if (a.engine) { assert.equal(a.icon, null, "the engine has no tile, so no tile icon"); continue; }
    assert.equal(a.icon, `/icons/${a.id}.png`, `${a.id} advertises its tile icon`);
    const r = await fetch(BASE + a.icon);
    assert.equal(r.status, 200, `${a.icon} serves`);
    assert.match(r.headers.get("content-type") || "", /png/);
    assert.ok(Number(r.headers.get("content-length") || (await r.arrayBuffer()).byteLength) > 1000, `${a.icon} is a real image`);
  }
});

test("the home page shows each app's icon on its tile", async () => {
  // the tiles only exist once a family has been through the welcome wizard
  const s = await (await fetch(`${BASE}/settings`)).json();
  if (!s.hasProfile) {
    const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childName: s.childName || "Zoe", dwellMs: s.dwellMs || 1200 }) });
    assert.equal(r.status, 204, "wizard setup so the tiles appear");
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home/`, { waitUntil: "load" });
  await page.waitForSelector("a.app img");
  const tiles = await page.$$eval("a.app", els => els.map(e => ({
    title: e.textContent.trim().split("\n")[0].trim(),
    img: e.querySelector("img") ? e.querySelector("img").getAttribute("src") : null,
    loaded: e.querySelector("img") ? e.querySelector("img").naturalWidth > 0 : false,
  })));
  const withIcon = tiles.filter(t => t.img);
  assert.ok(withIcon.length >= 2, "app tiles carry icons: " + JSON.stringify(tiles));
  for (const t of withIcon) assert.ok(t.loaded, `${t.title}'s icon ${t.img} actually loaded`);
  // Settings is the one tile without an app icon (it is not one of her apps)
  const settings = tiles.find(t => /^Settings/.test(t.title));
  assert.ok(settings && !settings.img, "Settings keeps its plain tile");
  await ctx.close();
});
