// Settings page (/settings/) through a real browser — the family-facing
// copy and the taps that once did the wrong thing.
//
// Spawns the REAL server.js on a scratch port with a throwaway ERA_DATA_DIR
// and a stand-in for api.elevenlabs.io; Playwright drives the page.
// Each test is the named test for a row of docs/bug-test-index.md:
//   16  default AI provider is Google (free tier), never Claude
//   U7  the key placeholder says AQ. (new AI Studio keys) as well as AIza
//   U14 the Drive card names the clothing folder and the 10-minute check
//   30  a stray tap beside the Apps row must not untick an app
//   14  an ElevenLabs key is verified: a key ElevenLabs rejects never shows
//       "Premium voices active"
// Plus the "Your books" content card (T2.10): it is #content (Settings is
// deep-linked by fragment), it says what a book costs and what "Recommended"
// means, and it turns /content/status into sentences a parent can act on -
// including "this computer cannot build books" (Gap 1) and "tomorrow's
// allowance". /content/status is stubbed per test so the states are reachable
// without a Drive folder; no key is ever in play here.
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
const PORT = 8423;       // never live 8377; 8391-8422 held by sibling suites
const FAKE = 8424;       // stand-in for api.elevenlabs.io
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-settings-ui-"));
let child, fake, browser;
const GOOD_KEY = "sk_good_1234567890";   // the only key the stand-in accepts

before(async () => {
  fake = http.createServer((req, res) => {
    if (req.url === "/v1/user/subscription") {
      if (req.headers["xi-api-key"] === GOOD_KEY)
        return res.writeHead(200, { "Content-Type": "application/json" }).end('{"tier":"free"}');
      return res.writeHead(401, { "Content-Type": "application/json" })
        .end('{"detail":{"status":"invalid_api_key"}}');
    }
    res.writeHead(404).end();
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1",
           ERA_ELEVEN_URL: `http://127.0.0.1:${FAKE}` },
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

async function settingsPage(contentStatus) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  // ERAgaze lives on 127.0.0.1:49155 on the family PC; here nothing answers
  await ctx.route("http://127.0.0.1:49155/**", r => r.abort());
  // A book job needs a local Drive folder full of photos; the card's job is to
  // turn whatever /content/status says into sentences, so the payload is the
  // fixture and the real route is left alone unless a test asks for one.
  if (contentStatus) await ctx.route("**/content/status", r => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(contentStatus) }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/settings/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#appsList label").length > 0);
  return { ctx, page };
}

// The shape content.js:status() returns, with the parts a test cares about
// overridden. Kept next to the tests so a change to that payload breaks here.
function statusPayload(over) {
  return { mode: "local", local: true, skipped: null, building: false, job: null,
           queued: [], jobs: [], lastScan: null, ...over };
}
function bookJob(over) {
  return { kind: "books", slug: "tabby-mctat", title: "Tabby McTat", state: "transcribing",
           step: "transcribe", progress: { pages: 12, transcribed: 3, narrated: 0 },
           cost: { characters: 0, narrated: 0 }, flags: 0, pausedUntil: null, note: null,
           published: false, error: null, ...over };
}

test("the AI helper defaults to Google — free services first (bug 16)", async () => {
  const { ctx, page } = await settingsPage();
  const sel = await page.$eval("#aiProv button.sel", b => b.dataset.prov);
  assert.equal(sel, "google");
  assert.match(await page.$eval("#aiOpen", b => b.textContent), /Google AI Studio/);
  await ctx.close();
});

test("the key placeholder admits the new AQ. AI Studio keys (U7)", async () => {
  const { ctx, page } = await settingsPage();
  const ph = await page.$eval("#aiKey", i => i.placeholder);
  assert.match(ph, /AQ\./, ph);
  assert.match(ph, /AIza/, ph);
  await ctx.close();
});

test("the Drive card names the clothing folder and the 10-minute check (U14)", async () => {
  const { ctx, page } = await settingsPage();
  const hint = await page.$eval("#integrations .hint", p => p.textContent);
  assert.match(hint, /\bclothing\b/);
  assert.match(hint, /every 10 minutes/);
  assert.doesNotMatch(hint, /^[^(]*every 6 hours/, "6 hours is only the no-Drive-app aside");
  await ctx.close();
});

test("a stray tap beside the Apps row does not untick an app (bug 30)", async () => {
  const { ctx, page } = await settingsPage();
  const row = page.locator("#appsList label", { hasText: "Making Words" });
  const cb = row.locator("input[type=checkbox]");
  assert.equal(await cb.isChecked(), true, "Making Words starts on");
  const box = await row.boundingBox();
  const list = await page.locator("#appsList").boundingBox();
  // the empty space to the right of the words, still inside the list
  const x = Math.min(box.x + box.width + 120, list.x + list.width - 10);
  assert.ok(x > box.x + box.width, "there is empty space to the right of the row");
  await page.mouse.click(x, box.y + box.height / 2);
  await page.waitForTimeout(500);
  assert.equal(await cb.isChecked(), true, "the stray tap left Making Words ticked");
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.equal(apps.find(a => a.id === "making-words").enabled, true,
    "the hub still lists it enabled");
  await ctx.close();
});

test("a voice key ElevenLabs rejects never shows 'Premium voices active' (bug 14)", async () => {
  const { ctx, page } = await settingsPage();
  await page.fill("#ttsKey", "sk_typo_missing_char");
  await page.click("#ttsKeySave");
  await page.waitForFunction(() => /not working|rejected|recognise/i.test(
    document.getElementById("voiceStatus").textContent + document.getElementById("ttsKeyStatus").textContent));
  assert.doesNotMatch(await page.$eval("#voiceStatus", e => e.textContent), /Premium voices active/);
  assert.match(await page.$eval("#ttsKeyStatus", e => e.textContent), /missing character/);
  let v = await (await fetch(`${BASE}/voices`)).json();
  assert.equal(v.enabled, false); assert.equal(v.keyPresent, true); assert.equal(v.keyOk, false);

  // the real key: verified against the server, then and only then "active"
  await page.fill("#ttsKey", GOOD_KEY);
  await page.click("#ttsKeySave");
  await page.waitForFunction(() => /Premium voices active/.test(document.getElementById("voiceStatus").textContent));
  assert.match(await page.$eval("#ttsKeyStatus", e => e.textContent), /Key checked and working/);
  v = await (await fetch(`${BASE}/voices`)).json();
  assert.equal(v.enabled, true); assert.equal(v.keyOk, true);
  await ctx.close();
});

// ---- "Your books" content card (T2.10) ----

test("the books card is #content and names the recommended setup (spec §4)", async () => {
  const { ctx, page } = await settingsPage();
  assert.equal(await page.$eval("#content h2", h => h.textContent.includes("books")), true,
    "the card is headed 'Your books'");
  const tiers = await page.$eval("#contentTiers", e => e.textContent);
  assert.match(tiers, /Recommended/);
  assert.match(tiers, /ElevenLabs/);
  assert.match(tiers, /free/i, "the free-key row is spelled out too");
  assert.doesNotMatch(tiers, /\$\s*\?/, "no placeholder prices");
  await ctx.close();
});

// E8: the free tier is the default, so the card that recommends it owes the
// parent the one thing the free tier costs — Google may train on what is sent.
// The books card steers to that same free key on purpose: two free readers
// checking each other is what the 9/4 bake-off bought, and it is free.
test("the free Google key is described honestly, and books are steered to it (E8)", async () => {
  const { ctx, page } = await settingsPage();
  // VISIBLE, not merely present: the note ships display:none and one line of
  // script reveals it for the Google tier. Reading textContent off a hidden
  // node passes whether or not a parent can ever see the disclosure, which is
  // the whole reason this test exists.
  assert.equal(await page.isVisible("#aiNote"), true,
    "the free tier is the default, so its disclosure has to be on screen");
  const note = await page.$eval("#aiNote", e => e.textContent);
  assert.match(note, /free AI Studio/i, note);
  assert.match(note, /improve Google’s products/i, note);
  assert.match(note, /pay-as-you-go/i, note);
  assert.match(note, /Google’s terms/i, note);
  const tiers = await page.$eval("#contentTiers", e => e.textContent);
  assert.match(tiers, /Books read best with a free Google AI Studio key/i, tiers);
  assert.match(tiers, /two free readers check every page/i, tiers);
  // …and it belongs to the tier it describes: the other two providers are not
  // used that way, so the sentence goes away when they are picked.
  await page.click('#aiProv button[data-prov="anthropic"]');
  assert.equal(await page.isVisible("#aiNote"), false,
    "a pay-as-you-go provider must not be given the free tier's warning");
  await page.click('#aiProv button[data-prov="google"]');
  assert.equal(await page.isVisible("#aiNote"), true);
  await ctx.close();
});

test("no Drive folder: the books card says which computer builds books (Gap 1)", async () => {
  const { ctx, page } = await settingsPage(
    statusPayload({ mode: "off", local: false, skipped: "needs-local-drive" }));
  await page.waitForFunction(() => /\S/.test(document.getElementById("contentStatus").textContent));
  const s = await page.$eval("#contentStatus", e => e.textContent);
  assert.match(s, /Google Drive/);
  assert.doesNotMatch(s, /needs-local-drive/, "the code word never reaches the parent");
  assert.equal(await page.$eval("#contentBooks", e => e.children.length), 0);
  await ctx.close();
});

test("zero books: the card says how to add one", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [] }));
  await page.waitForFunction(() => /\S/.test(document.getElementById("contentStatus").textContent));
  const s = await page.$eval("#contentStatus", e => e.textContent);
  assert.match(s, /No books yet/i);
  assert.match(s, /books/, "it names the folder to drop photos in");
  await ctx.close();
});

test("a book being built shows its title and how far it has got", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    building: true, job: { kind: "books", slug: "tabby-mctat", step: "transcribe" },
    jobs: [bookJob()] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(row, /Tabby McTat/);
  assert.match(row, /3 of 12/, "pages read out of pages photographed");
  assert.match(row, /read/i, "the step is said in words, not as 'transcribe'");
  assert.doesNotMatch(row, /transcribing/, "the state name is not shown raw");
  await ctx.close();
});

test("a quota pause says tomorrow, and a flagged book links to its review page", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ pausedUntil: "2026-09-05" }),
    bookJob({ slug: "the-gruffalo", title: "The Gruffalo", state: "published",
              step: null, flags: 2, pageFlags: 3, published: true,
              progress: { pages: 8, transcribed: 8, narrated: 8 } }),
  ] }));
  await page.waitForSelector('#contentBooks [data-slug="the-gruffalo"]');
  const paused = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(paused, /tomorrow/i);
  assert.doesNotMatch(paused, /2026-09-05/, "a date stamp is not a sentence");
  const link = await page.$eval('#contentBooks [data-slug="the-gruffalo"] a', a =>
    ({ href: a.getAttribute("href"), text: a.textContent }));
  assert.equal(link.href, "/book-review/?slug=the-gruffalo");
  assert.match(link.text, /Review this book/i);
  const flagged = await page.$eval('#contentBooks [data-slug="the-gruffalo"]', e => e.textContent);
  assert.match(flagged, /2 words/, "the flag count is named");
  // The whole-page marks are counted as PAGES, in their own sentence: they name
  // no word, so folding them into the word count promises a parent highlights
  // that are not there (E2).
  assert.match(flagged, /3 pages nobody could check/i, flagged);
  // E8: what a parent DOES about a flag — glance at those pages on the review
  // page — rather than only how many the AI was unsure of.
  assert.match(flagged, /pages to glance at/i, flagged);
  await ctx.close();
});

// A book that stopped needs a button that actually restarts IT. "Look for new
// books now" only asks Drive to sync, and the scan behind it will not re-claim
// a book whose heartbeat is fresh for another thirty minutes — so the card was
// telling a parent to press something that could not work. The raw provider
// string is for log.jsonl, never for the card.
test("a stopped book says so in plain words and offers its own try-again button", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [bookJob({
    state: "failed", step: "transcribe",
    error: "ai(google/gemini-3-flash-preview) 500 boom" })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"] button[data-run]');
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.doesNotMatch(row, /gemini|500|boom|ai\(/, "the raw provider error never reaches the parent");
  assert.doesNotMatch(row, /Look for new books now/, "that button cannot restart this book");
  assert.match(row, /again/i, "the card says what pressing it does");

  const [req] = await Promise.all([
    page.waitForRequest(r => r.url().includes("/content/run") && r.method() === "POST"),
    page.click('#contentBooks [data-slug="tabby-mctat"] button[data-run]'),
  ]);
  // retry:true is what makes this press different from every other run: it is
  // the only thing in the hub that lifts a PERMANENT failure and puts the book
  // back on the walk, so a save on the review page (which re-publishes through
  // the same door) cannot restart a refused key by accident.
  assert.deepEqual(JSON.parse(req.postData()),
                   { kind: "books", slug: "tabby-mctat", step: null, retry: true });
  await ctx.close();
});
