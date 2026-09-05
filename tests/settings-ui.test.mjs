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
// The fal card (T6.1) proves its key the same way the Voice card does, so the
// same stand-in answers for api.fal.ai as well. Stand-in material only.
const FAL_GOOD = "fal-good-1234567890";
let falCalls = 0;

before(async () => {
  fake = http.createServer((req, res) => {
    if (req.url === "/v1/user/subscription") {
      if (req.headers["xi-api-key"] === GOOD_KEY)
        return res.writeHead(200, { "Content-Type": "application/json" }).end('{"tier":"free"}');
      return res.writeHead(401, { "Content-Type": "application/json" })
        .end('{"detail":{"status":"invalid_api_key"}}');
    }
    if (req.url.startsWith("/v1/account/billing")) {
      falCalls++;      // guardrail §B.2(c): zero calls means it went to fal itself
      if (req.headers.authorization === "Key " + FAL_GOOD)
        return res.writeHead(200, { "Content-Type": "application/json" })
          .end('{"username":"a-family","credits":{"current_balance":4.2,"currency":"USD"}}');
      return res.writeHead(401, { "Content-Type": "application/json" })
        .end('{"error":{"type":"unauthorized","message":"invalid credentials"}}');
    }
    res.writeHead(404).end();
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1",
           ERA_ELEVEN_URL: `http://127.0.0.1:${FAKE}`,
           ERA_FAL_URL: `http://127.0.0.1:${FAKE}`,
           // today's outfits are built on the hub's own timers and read the
           // weather: a dead loopback port keeps this suite off the internet
           ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1" },
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
           cost: { characters: 0, narrated: 0 }, flags: 0, pageFlags: 0, edited: 0,
           pausedUntil: null, note: null, paused: null, published: false, error: null, ...over };
}
// The pause as content.js derives it (T6b.1): whose allowance ran out, when it
// comes back, and where more is added. `hours` from now, so the sentence the
// card writes is a real local time rather than a fixture's frozen stamp.
function pausedIn(hours, provider) {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  return { provider, reason: provider === "elevenlabs"
             ? "waiting for this month's voice allowance"
             : "waiting for today's free allowance",
           until,
           addUrl: provider === "elevenlabs" ? "https://elevenlabs.io/app/subscription"
                                             : "https://aistudio.google.com/apikey" };
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

// ---- "Films and shows" keys card (T5.3) ----
//
// /movies/lookup's hint tells a parent to "add a TMDB key in Settings", and for
// one review cycle there was no such card anywhere in the product — the only
// way in was hand-editing a JSON file (review 9/5, the same dead end "Install
// it and try again" was fixed for in Phase 4). This is the card that sentence
// names. Neither key is ever verified against a provider here (that would spend
// one), and neither may ever come back out of the hub.
test("the films card takes both keys and never hands either one back (T5.3)", async () => {
  const { ctx, page } = await settingsPage();
  assert.match(await page.$eval("#movies h2", h => h.textContent), /Films/);
  assert.equal(await page.$eval("#tmdbKey", i => i.type), "password",
               "a key is not shoulder-surfable on a family PC");
  assert.equal(await page.$eval("#wmKey", i => i.type), "password");

  await page.fill("#tmdbKey", "tmdb-typed-by-a-parent");
  await page.click("#moviesKeySave");
  await page.waitForFunction(() => /saved|working|✓/i.test(
    document.getElementById("moviesKeyStatus").textContent));
  // the search is on now, and it says what this key does and does not buy
  let st = await (await fetch(`${BASE}/movies/keys`)).json();
  assert.equal(st.provider, "tmdb");
  assert.equal(st.deepLinks, false);
  assert.equal(st.tmdb, true, "the card is told a key is saved, never which key");
  assert.equal(st.watchmode, false);
  assert.ok(!JSON.stringify(st).includes("tmdb-typed-by-a-parent"),
            "the key never comes back out of the hub");

  await page.fill("#wmKey", "watchmode-typed-by-a-parent");
  await page.click("#moviesKeySave");
  await page.waitForFunction(() => /tile that plays|links|✓/i.test(
    document.getElementById("moviesKeyStatus").textContent));
  st = await (await fetch(`${BASE}/movies/keys`)).json();
  assert.equal(st.provider, "watchmode");
  assert.equal(st.deepLinks, true, "the optional key is what buys a tile that plays");
  assert.equal(st.watchmode, true);
  assert.ok(!JSON.stringify(st).includes("watchmode-typed-by-a-parent"));
  assert.equal(await page.$eval("#wmKey", i => i.value), "",
               "and the box is cleared, so the key is not left on screen");
  await ctx.close();
});

// ---- "Moving pages" fal card (T6.1) ----
//
// The one key in the product that spends real money per press. The card is a
// clone of the Voice card's key row because that is the one a parent has
// already used, and — like the Voice card and unlike the film keys — it proves
// the key with one real call before saying it works: a wrong key here would
// otherwise be discovered halfway through a book they have already agreed to
// pay for. It says the price of a clip, because the button that spends is
// quoted in the same money (T6.2's cost gate).
test("the fal card checks the key and quotes what a clip costs (T6.1)", async () => {
  const { ctx, page } = await settingsPage();
  assert.equal(await page.$eval("#fal h2", h => /pages|video|moving/i.test(h.textContent)), true,
               "the card is about turning pages into moving pictures");
  const hint = await page.$eval("#fal .hint", p => p.textContent);
  assert.match(hint, /money/i, "the only card that spends says so");
  assert.equal(await page.$eval("#falKey", i => i.type), "password",
               "a key is not shoulder-surfable on a family PC");

  // a key fal refuses never shows as working (the Voice card's bug 14, here)
  await page.fill("#falKey", "fal-typo-missing-char");
  await page.click("#falKeySave");
  await page.waitForFunction(() => /\S/.test(document.getElementById("falKeyStatus").textContent));
  let s = await page.$eval("#falKeyStatus", e => e.textContent);
  assert.match(s, /missing character/i, s);
  assert.doesNotMatch(s, /working/i, "a refused key is never 'working'");

  await page.fill("#falKey", FAL_GOOD);
  await page.click("#falKeySave");
  await page.waitForFunction(() => /working/i.test(
    document.getElementById("falKeyStatus").textContent));
  s = await page.$eval("#falKeyStatus", e => e.textContent);
  assert.match(s, /\$0?\.\d/, "the card quotes the price of one clip: " + s);
  assert.equal(await page.$eval("#falKey", i => i.value), "",
               "and the box is cleared, so the key is not left on screen");
  assert.equal(falCalls, 2, "both saves were proved against the stand-in, not fal itself");
  const st = await (await fetch(`${BASE}/fal-key`)).json();
  assert.equal(st.saved, true);
  assert.equal(st.keyOk, true);
  assert.ok(!JSON.stringify(st).includes(FAL_GOOD), "the key never comes back out of the hub");
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

// A job.json written before T6b carries a pausedUntil and nothing else. The card
// can still say the one thing that is true of it — this book is waiting, and it
// carries on by itself — but it must not GUESS the rest: naming Google, or
// tomorrow morning, under a book that is waiting on ElevenLabs' month tells the
// family to go and look in the wrong place (review 9/5).
test("a pause with no provider says only what it knows, and a flagged book links to its review page", async () => {
  const soon = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ pausedUntil: soon }),
    bookJob({ slug: "the-gruffalo", title: "The Gruffalo", state: "published",
              step: null, flags: 2, pageFlags: 3, published: true,
              progress: { pages: 8, transcribed: 8, narrated: 8 } }),
  ] }));
  await page.waitForSelector('#contentBooks [data-slug="the-gruffalo"]');
  const paused = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(paused, /waiting for more AI allowance/i);
  assert.match(paused, /carries on by itself/i, "and the honest half of the two choices");
  assert.doesNotMatch(paused, /Google|ElevenLabs/, "an unnamed allowance is not named");
  assert.doesNotMatch(paused, /tomorrow/i, "nor is a day nobody wrote down");
  assert.doesNotMatch(paused, new RegExp(soon.slice(0, 10)), "a date stamp is not a sentence");
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

// The other half of it: a moment that has PASSED is not a wait. The book is
// simply queued for the next look, and a card still telling the family to wait
// for something that already happened is a card nobody believes.
test("a pause whose moment has passed says nothing at all (T6b.2)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ pausedUntil: new Date(Date.now() - 60 * 1000).toISOString() }),
  ] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.doesNotMatch(row, /allowance/i, row);
  assert.doesNotMatch(row, /waiting/i, row);
  await ctx.close();
});

// L6 (the 16-page live run, 9/4). A page a grown-up retyped loses its `read` —
// the words are theirs, and no model may be named as their author — so from the
// card's side it looked exactly like a page nobody ever checked. It is the
// opposite: it is the most checked page in the book. The card says so in the
// same books card, next to the marks, and it is NOT a mark: nothing here is
// something to go and fix.
test("the books card says which pages carry words a grown-up typed", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ slug: "the-gruffalo", title: "The Gruffalo", state: "published", step: null,
              edited: 2, published: true, progress: { pages: 8, transcribed: 8, narrated: 8 } }),
  ] }));
  await page.waitForSelector('#contentBooks [data-slug="the-gruffalo"]');
  const row = await page.$eval('#contentBooks [data-slug="the-gruffalo"]', e => e.textContent);
  assert.match(row, /2 pages have words you typed/i, row);
  assert.doesNotMatch(row, /nobody could check/i, "a page they typed is not a page nobody checked");
  assert.doesNotMatch(row, /glance at/i, "and it is not a mark to go and fix");
  await ctx.close();
});

// One page is one page, and a card that says "1 pages" is a card written by a
// machine. The same sentence also has to say what it is FOR: the re-read keeps
// exactly these pages, which is the tick a parent meets on the review page.
test("one typed page is said in the singular, and the card says the re-read keeps it", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [bookJob({ edited: 1 })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(row, /1 page has words you typed/i, row);
  assert.doesNotMatch(row, /1 pages/, row);
  assert.match(row, /read the photos again/i, "the sentence says the re-read keeps them");
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

// ---- Out of allowance: the two honest choices (T6b.2, spec §4 "Design target")
//
// The family never adds a card to Google, so a book that stops for the day is
// the NORMAL path, not a fault. What the card owes them is: whose allowance ran
// out (the two are mended in different places), when it comes back in THEIR
// clock, and the two things they may do about it — wait, or add credit and
// press Try again now. Never a date stamp, never a provider's error string, and
// never the impression that something is broken.

test("a paused book names the provider, the local time it comes back, and both choices (T6b.2)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ paused: pausedIn(3, "google"), pausedUntil: pausedIn(3, "google").until }),
  ] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"] [data-paused]');
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"] [data-paused]',
                               e => e.textContent);
  assert.match(row, /Google/, "whose allowance ran out: " + row);
  assert.doesNotMatch(row, /ElevenLabs/, "and not the one that did not");
  // A local clock time, not the ISO moment the payload carries.
  assert.match(row, /(today|tomorrow) at \d/i, "when it comes back, in their clock: " + row);
  assert.doesNotMatch(row, /\d{4}-\d{2}-\d{2}|T\d\d:\d\d|Z\b/, "a date stamp is not a sentence");
  // Choice one: nothing. Said out loud, because a card that only offers a
  // button reads as "this is broken until you act".
  assert.match(row, /by itself/i, "waiting is a real choice and is named: " + row);
  // Choice two: where credit is added — the address travels with the status.
  const add = await page.$eval('#contentBooks [data-slug="tabby-mctat"] button[data-add]',
                               b => ({ url: b.dataset.add, text: b.textContent }));
  assert.equal(add.url, "https://aistudio.google.com/apikey");
  assert.match(add.text, /Google/i, add.text);
  // …and the press that uses it. Nothing here reads as a failure.
  assert.match(await page.$eval('#contentBooks [data-slug="tabby-mctat"] button[data-run]',
                                b => b.textContent), /again/i);
  const whole = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.doesNotMatch(whole, /stopped|failed|error/i, "a pause is not a failure: " + whole);
  await ctx.close();
});

test("a book waiting on the voice allowance points at ElevenLabs, not at Google (T6b.2)", async () => {
  const p = pausedIn(30, "elevenlabs");
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ state: "narrating", step: "narrate", paused: p, pausedUntil: p.until }),
  ] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"] [data-paused]');
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"] [data-paused]',
                               e => e.textContent);
  assert.match(row, /ElevenLabs/, row);
  assert.doesNotMatch(row, /Google/, "the wrong page to send a parent to");
  assert.doesNotMatch(row, /\d{4}-\d{2}-\d{2}|T\d\d:\d\d/, "a date stamp is not a sentence");
  const add = await page.$eval('#contentBooks [data-slug="tabby-mctat"] button[data-add]',
                               b => b.dataset.add);
  assert.equal(add, "https://elevenlabs.io/app/subscription");
  // The address is opened through the hub's own door, so the page lands in a
  // REAL browser window rather than inside the kiosk (the 9/5 gate finding).
  const opened = [];
  await page.route("**/open-url", r => {
    opened.push(JSON.parse(r.request().postData()));
    r.fulfill({ status: 200, contentType: "application/json", body: '{"opened":true}' });
  });
  await page.click('#contentBooks [data-slug="tabby-mctat"] button[data-add]');
  await page.waitForTimeout(300);
  assert.deepEqual(opened, [{ url: "https://elevenlabs.io/app/subscription" }]);
  await ctx.close();
});

test("Try again now posts retry:true, once (T6b.2)", async () => {
  const p = pausedIn(5, "elevenlabs");
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [
    bookJob({ state: "narrating", step: "narrate", paused: p, pausedUntil: p.until }),
  ] }));
  const posts = [];
  await page.route("**/content/run", r => {
    posts.push(JSON.parse(r.request().postData()));
    r.fulfill({ status: 202, contentType: "application/json", body: '{"started":true}' });
  });
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"] button[data-run]');
  await page.click('#contentBooks [data-slug="tabby-mctat"] button[data-run]');
  await page.waitForTimeout(600);
  // retry:true is the only thing that lifts the pause the steps honour, so the
  // press has to carry it — and the button goes dead behind the press, so a
  // parent leaning on it cannot queue five runs of the same book.
  assert.deepEqual(posts, [{ kind: "books", slug: "tabby-mctat", step: null, retry: true }]);
  await ctx.close();
});

test("a book that is not paused says nothing about allowances (T6b.2)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [bookJob()] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  assert.equal(await page.$('#contentBooks [data-slug="tabby-mctat"] [data-paused]'), null);
  assert.equal(await page.$('#contentBooks [data-slug="tabby-mctat"] button[data-add]'), null);
  const row = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.doesNotMatch(row, /allowance/i, row);
  await ctx.close();
});

// The Voice card is where a parent decides whether this month can afford a
// book. /content/status carries ElevenLabs' own counters (T6b.1), so the card
// can say it in the two units that matter: characters, and roughly how many
// pages of a picture book those buy.
test("the Voice card says how much of this month's voice is left (T6b.2)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    narration: { charactersLeft: 8000, resetsAt: "2026-10-03T09:00:00.000Z" } }));
  await page.waitForFunction(() => /\S/.test(document.getElementById("voiceAllowance").textContent));
  const s = await page.$eval("#voiceAllowance", e => e.textContent);
  assert.match(s, /8,000 characters/, s);
  assert.match(s, /about \d+ pages/i, "and what that buys, in books: " + s);
  assert.match(s, /resets/i, s);
  assert.doesNotMatch(s, /2026-10-03|T09:00/, "a date stamp is not a sentence: " + s);
  assert.equal(await page.isVisible("#voiceAllowance"), true);
  await ctx.close();
});

test("no allowance answer, no made-up number (T6b.2)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ narration: null }));
  await page.waitForFunction(() => /\S/.test(document.getElementById("contentStatus").textContent));
  assert.equal(await page.isVisible("#voiceAllowance"), false,
    "an allowance nobody could read is not an allowance of zero");
  await ctx.close();
});

// "Dress for the weather between ..." (dad 9/5): the outfits are sorted for
// the hours she is actually out, not for the afternoon high she never feels.
// Pointer UI (a grown-up's row), loaded from GET /settings like every other
// knob and saved the moment a choice changes.
test("the weather-window row loads the saved hours and saves a change", async () => {
  const post = (weatherWindow) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weatherWindow }) });
  const saved = async () => (await (await fetch(`${BASE}/settings`)).json()).weatherWindow;
  await post({ from: 10, to: 13 });
  const { ctx, page } = await settingsPage();
  try {
    await page.waitForFunction(() => document.getElementById("wxFrom").value === "10");
    assert.equal(await page.$eval("#wxTo", s => s.value), "13");
    assert.equal(await page.$eval("#wxFrom option", o => o.textContent), "All day",
      "the first choice is the whole day, which is what a family starts with");
    const hint = await page.$eval("#wxHint", e => e.textContent);
    assert.match(hint, /afternoon/i, hint);

    await page.selectOption("#wxFrom", "9");
    await page.selectOption("#wxTo", "12");
    await page.waitForFunction(() => /Outfits re-sorted for 9 AM-12 PM/.test(document.getElementById("toast").textContent));
    assert.deepEqual(await saved(), { from: 9, to: 12 });

    // back to the whole day: the second select has nothing left to say
    await page.selectOption("#wxFrom", "");
    await page.waitForFunction(() => /whole day/.test(document.getElementById("toast").textContent));
    assert.equal(await saved(), undefined);
    assert.equal(await page.$eval("#wxTo", s => s.disabled), true);
  } finally { await ctx.close(); await post(null); }
});
