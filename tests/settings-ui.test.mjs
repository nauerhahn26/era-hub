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
// The AI helper card (T7.6 bug 6) proves its key the same way, so the stand-in
// answers Google's models.list too. Stand-in material only — never a credential.
//   AI_GOOD  recognised at once
//   AI_SLOW  recognised, but the answer is PARKED until the test lets it go —
//            the door blocks for the whole probe (up to 15 s on a black-holed
//            link), and the card has to look busy for all of it
//   AI_DEAD  the stand-in hangs up: the provider cannot be reached
//   anything else: Google's 400 API_KEY_INVALID
const AI_GOOD = "AQ.stand-in-good-key-0123456789";
const AI_SLOW = "AQ.stand-in-slow-key-0123456789";
const AI_DEAD = "AQ.stand-in-unplugged";
let aiHold = null;      // the parked answer for AI_SLOW: call it to let the probe finish

before(async () => {
  fake = http.createServer((req, res) => {
    if (req.url.startsWith("/v1beta/models")) {
      const key = req.headers["x-goog-api-key"];
      if (key === AI_DEAD) { req.socket.destroy(); return; }
      const answer = () => (key === AI_GOOD || key === AI_SLOW)
        ? res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[{"name":"models/a-model"}]}')
        : res.writeHead(400, { "Content-Type": "application/json" })
            .end('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
      if (key === AI_SLOW) { aiHold = answer; return; }
      return answer();
    }
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
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_ELEVEN_URL: `http://127.0.0.1:${FAKE}`,
           ERA_FAL_URL: `http://127.0.0.1:${FAKE}`,
           ERA_AI_URL: `http://127.0.0.1:${FAKE}`,
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

// settingsPage(contentStatus, opts) — opts.clothing stubs /clothing/status the
// way contentStatus stubs /content/status (the Clothing Picker read-out has to
// be reachable without a wardrobe, a build or a key), and opts.timezoneId puts
// the browser in a named zone: the card turns a day key into a weekday, and
// "2026-09-02" parsed as a UTC instant is the day BEFORE in California.
async function settingsPage(contentStatus, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true,
    ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}) });
  if (opts.clothing) await ctx.route("**/clothing/status", r => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(opts.clothing) }));
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
           // The pile of photos with no folder yet (dad 9/7). `quietMs` still
           // travels — older readers of this payload use it — but since "built
           // here" (spec §12) nothing in the hub starts on that clock, so no
           // card may say a number of minutes out loud any more.
           loose: 0, quietMs: 10 * 60 * 1000,
           queued: [], jobs: [], lastScan: null, ...over };
}
function bookJob(over) {
  return { kind: "books", slug: "tabby-mctat", title: "Tabby McTat", state: "transcribing",
           step: "transcribe", progress: { pages: 12, transcribed: 3, narrated: 0 },
           cost: { characters: 0, narrated: 0 }, flags: 0, pageFlags: 0, edited: 0,
           autoTitle: false, held: null,
           // What the card may OFFER (spec §14): `waiting:"pile"` is a folder of
           // photos nobody has claimed, `elsewhere` another computer's warm
           // claim, `buildable` "this door would say yes". A book being built
           // here is none of the three.
           waiting: null, buildable: true, elsewhere: false,
           pausedUntil: null, note: null, paused: null, published: false, error: null, ...over };
}
// A pile of photos in a folder of its own: no job.json, no manifest, nobody's
// claim — the row the Build button belongs to (content.js jobFor).
function pileJob(over) {
  return bookJob({ state: "inbox", step: "ingest", waiting: "pile",
                   progress: { pages: 17, transcribed: 0, narrated: 0 }, ...over });
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

// ---- AI helper key card (T7.6 bug 6, VM QA 9/5) ----
//
// The bug was a WORDING bug: a Google key with a character missing sat under
// "key saved ✓" until the Clothing Picker quietly held every photo. The door
// now asks the provider before it answers, and tests/ai-key.test.mjs pins the
// JSON — this is the half a parent reads. Three sentences, one each for what
// the provider said: refused (paste again — never "saved ✓"), unreachable
// (saved, honestly unchecked), recognised (checked and working). The branch
// ORDER in aiPaint is what the doesNotMatch pins: the refusal has to be tested
// before the plain "configured" line or the old lie comes back.
//
// And because the door now blocks for the whole probe (15 s on a black-holed
// link), Save has to look busy the way the Voice and fal cards do: the button
// goes dead and the card says who is being asked, and the 5-second repaint
// must not wipe that line while the answer is still out (review 9/5).
test("the AI card goes busy while the key is checked, and never says 'saved ✓' for a refused key (T7.6 bug 6)", async () => {
  const { ctx, page } = await settingsPage();
  const status = () => page.$eval("#aiStatus", e => e.textContent);
  const busy = () => page.$eval("#aiKeySave", b => b.disabled);

  // in flight: the stand-in parks the answer, so the card is caught mid-probe
  aiHold = null;
  await page.fill("#aiKey", AI_SLOW);
  await page.click("#aiKeySave");
  for (let i = 0; i < 100 && !aiHold; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(aiHold, "the probe reached the stand-in");
  assert.equal(await busy(), true, "Save is dead while the door is asking the provider");
  assert.match(await status(), /Checking the key with Google AI Studio/);
  // the periodic repaint must not overwrite the pending line mid-probe
  await page.evaluate(() => aiPaint());
  assert.match(await status(), /Checking the key with Google AI Studio/,
    "aiPaint's 5-second tick left the pending line alone");
  aiHold(); aiHold = null;
  await page.waitForFunction(() => !document.getElementById("aiKeySave").disabled);
  await page.waitForFunction(() => /checked and working ✓/.test(document.getElementById("aiStatus").textContent));
  assert.equal(await page.$eval("#aiKey", i => i.value), "", "the box is cleared, so the key is not left on screen");

  // refused: a paste-again, and NOT the old "saved ✓"
  await page.fill("#aiKey", "AQ.stand-in-typo-key");
  await page.click("#aiKeySave");
  await page.waitForFunction(() => /Copy it again/.test(document.getElementById("aiStatus").textContent));
  let s = await status();
  assert.match(s, /did not recognise that key/, s);
  assert.doesNotMatch(s, /saved ✓/, "a refused key is never 'saved ✓' (the 9/5 lie)");
  assert.doesNotMatch(s, /working/i, s);
  assert.equal(await busy(), false, "Save is live again after the answer");

  // unreachable: saved, and honestly unchecked — neither "working" nor a refusal
  await page.fill("#aiKey", AI_DEAD);
  await page.click("#aiKeySave");
  await page.waitForFunction(() => /could not reach Google AI Studio/.test(document.getElementById("toast").textContent));
  await page.waitForFunction(() => /key saved ✓/.test(document.getElementById("aiStatus").textContent));
  s = await status();
  assert.doesNotMatch(s, /checked and working/, s);
  assert.doesNotMatch(s, /Copy it again/, "an unreachable provider is not a refusal");
  assert.equal(await busy(), false);

  // recognised: the sentence the Voice card already earns
  await page.fill("#aiKey", AI_GOOD);
  await page.click("#aiKeySave");
  await page.waitForFunction(() => /checked and working ✓/.test(document.getElementById("aiStatus").textContent));
  s = await status();
  assert.match(s, /Google AI Studio key checked and working ✓/, s);
  const st = await (await fetch(`${BASE}/clothing/status`)).json();
  assert.equal(st.aiKeyOk, true);
  assert.ok(!JSON.stringify(st).includes(AI_GOOD), "the key never comes back out of the hub");
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

// ---- "Her picks": the Clothing Picker read-out (spec §4, plan T5.2) --------
//
// Nothing in Settings used to show that the picker learns anything at all
// (spec §1 row O1): a parent saw "35 clothing items catalogued" and had no way
// to tell whether the Yeses on the board were remembered. This card is that
// window — and it is the only place a garment NAME is printed on this page, so
// it is escaped like a book title is.
//
// /clothing/status is stubbed per case: the read-out's own arithmetic is
// pinned in tests/clothing-status.test.mjs, and what this suite owns is the
// sentence a parent reads.
const clothingPayload = (over) => ({
  building: false, ingesting: null, attrs: null, cataloged: 8, photos: 8,
  aiConfigured: true, aiProvider: "google", aiKeyOk: true, aiKeyError: "",
  waiting: 0, heldToday: false, guidance: null,
  picks: { days: 0, lastDay: null, top: [] },
  memory: { days: 0, yesterdayPage1: 0 },
  sharing: { mode: "local", devices: 1 },
  ...over,
});
// A day key `back` days before today IN THE BROWSER'S ZONE, and the weekday
// name that key stands for (built from the three numbers, never parsed from
// the string — that is the bug the card's local-date rule exists for).
function dayKeyBack(back, timeZone) {
  const [y, m, d] = new Date().toLocaleDateString("en-CA", { timeZone }).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}
const weekdayOf = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long" });
};
// …and the date a key past the week stands for, in the family browser's en-US
// default: "August 28", not "28 August" (plan T5.2 as amended r1).
const monthDayOf = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { day: "numeric", month: "long" });
};
const picksText = (page) => page.$eval("#picksStatus", e => e.textContent);

test("the picks card names her favourite looks, and escapes the names (O1)", async () => {
  const yesterday = dayKeyBack(1, "UTC");
  const { ctx, page } = await settingsPage(null, { clothing: clothingPayload({
    picks: { days: 24, lastDay: yesterday, top: [
      { combo: ["item_aaaa", "item_bbbb"], names: ["Sunny <b>tee</b>", "Pond shorts"], weight: 3 },
      { combo: ["item_cccc"], names: ["Meadow dress"], weight: 2 },
    ] },
    memory: { days: 33, yesterdayPage1: 7 },
  }) });
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  const t = await picksText(page);
  assert.match(t, /24 days recorded/, t);
  assert.match(t, /Sunny <b>tee<\/b> \+ Pond shorts \(×3\)/, "a two-piece look reads as one outfit: " + t);
  assert.match(t, /Meadow dress \(×2\)/, "a dress is one name, not an empty half: " + t);
  const html = await page.$eval("#picksStatus", e => e.innerHTML);
  assert.match(html, /Sunny &lt;b&gt;tee&lt;\/b&gt;/, "a garment name is family text, escaped: " + html);
  assert.equal(html.includes("<b>tee</b>"), false, "…and never markup the page runs");
  assert.equal(t.includes("item_"), false, "an id is not a sentence: " + t);
  await ctx.close();
});

test("with no picks yet the card says what will happen tomorrow, not nothing", async () => {
  const { ctx, page } = await settingsPage(null, { clothing: clothingPayload() });
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  const t = await picksText(page);
  assert.match(t, /No picks recorded yet/, t);
  assert.match(t, /every Yes on the board is remembered from tomorrow/, t);
  await ctx.close();
});

// A hub that cannot read its own memory answers with no picks/memory blocks at
// all rather than zeroed ones (clothing.js readOutFor, review r1) — because a
// zero here would be printed as "No picks recorded yet", a claim about her data.
// The empty line is the whole point: it says nothing.
test("a payload with no picks block leaves the line empty instead of claiming there are none", async () => {
  const { picks, memory, ...blind } = clothingPayload();
  const { ctx, page } = await settingsPage(null, { clothing: blind });
  await page.waitForFunction(() => /\S/.test(document.getElementById("aiStatus").textContent));
  assert.equal((await picksText(page)).trim(), "", "no sentence at all");
  assert.doesNotMatch(await picksText(page), /No picks recorded yet/);
  await ctx.close();
});

test("the sharing line appears only when the family really has a Drive folder", async () => {
  const shared = clothingPayload({ picks: { days: 4, lastDay: dayKeyBack(1, "UTC"), top: [] },
    sharing: { mode: "local", devices: 3 } });
  let { ctx, page } = await settingsPage(null, { clothing: shared });
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  assert.doesNotMatch(await picksText(page), /Shared with/, "no folder, no claim about other devices");
  await ctx.close();

  ({ ctx, page } = await settingsPage(null, { clothing: clothingPayload({
    picks: shared.picks, sharing: { mode: "drive", devices: 3 } }) }));
  await page.waitForFunction(() => /Shared with/.test(document.getElementById("picksStatus").textContent));
  assert.match(await picksText(page), /Shared with: 3 devices/);
  await ctx.close();

  // A folder nobody else has written into yet is not "shared with 1 device".
  ({ ctx, page } = await settingsPage(null, { clothing: clothingPayload({
    picks: shared.picks, sharing: { mode: "drive", devices: 1 } }) }));
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  const t = await picksText(page);
  assert.doesNotMatch(t, /Shared with: 1 device/, t);
  assert.match(t, /no other device/i, t);
  await ctx.close();
});

test("the picks line survives the branches that overwrite the AI status line", async () => {
  const picks = { days: 6, lastDay: dayKeyBack(1, "UTC"),
    top: [{ combo: ["item_aaaa"], names: ["Sunny tee"], weight: 1.5 }] };
  for (const over of [{ aiConfigured: false, aiProvider: null, aiKeyOk: null, cataloged: 0 },
                      { ingesting: { done: 2, total: 9 } },
                      { aiConfigured: true, aiKeyOk: false, aiKeyError: "That key was not recognised" }]) {
    const { ctx, page } = await settingsPage(null, { clothing: clothingPayload({ picks, ...over }) });
    await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
    const t = await picksText(page);
    assert.match(t, /6 days recorded/, JSON.stringify(over) + " → " + t);
    assert.match(t, /Sunny tee \(×1\.5\)/, "half a credit is still a favourite: " + t);
    await ctx.close();
  }
});

test("a pick made yesterday says yesterday; an older one names its weekday in the family's zone", async () => {
  // The browser is put in the same zone the key is built in: the card measures
  // against the BROWSER's local midnight, so on a box east of UTC a bare
  // dayKeyBack(1, "UTC") is two days back here and the sentence names a weekday.
  let { ctx, page } = await settingsPage(null, { timezoneId: "UTC",
    clothing: clothingPayload({
      picks: { days: 2, lastDay: dayKeyBack(1, "UTC"), top: [] } }) });
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  assert.match(await picksText(page), /yesterday/, "the one day a weekday name would be silly");
  await ctx.close();

  // California, four days back: "2026-09-02" parsed as an instant is midnight
  // UTC, which is the day BEFORE here — the card would name the wrong weekday.
  const zone = "America/Los_Angeles";
  const back4 = dayKeyBack(4, zone);
  ({ ctx, page } = await settingsPage(null, { timezoneId: zone,
    clothing: clothingPayload({ picks: { days: 9, lastDay: back4, top: [] } }) }));
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  const t = await picksText(page);
  assert.match(t, new RegExp("last " + weekdayOf(back4)), back4 + " → " + t);
  assert.doesNotMatch(t, /yesterday/, t);
  await ctx.close();
});

// The fourth `when` form (plan T5.2 as amended r1), and the one no case pinned:
// past a week a weekday name says nothing about WHICH week, so "last Thursday"
// for a three-week-old pick is a lie a parent could act on. Replacing the whole
// branch with "" left every other case in this suite green (review r2).
test("a pick more than a week old names its date instead of a weekday", async () => {
  const zone = "America/Los_Angeles";
  const back9 = dayKeyBack(9, zone);
  const { ctx, page } = await settingsPage(null, { timezoneId: zone,
    clothing: clothingPayload({ picks: { days: 12, lastDay: back9, top: [] } }) });
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  const t = await picksText(page);
  assert.match(t, new RegExp("last on " + monthDayOf(back9)), back9 + " → " + t);
  assert.doesNotMatch(t, /last (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/, t);
  assert.doesNotMatch(t, /yesterday/, t);
  await ctx.close();
});

// The hub buckets the day in the FAMILY's zone (profile.json) and this page in
// the browser's, so a family whose profile sits a day ahead of the tablet's OS
// hands the card a lastDay that is today here. "last one yesterday" for a pick
// made today is a small wrong word, and the empty form already renders cleanly.
test("a lastDay the browser has not reached yet says nothing about when, not 'yesterday'", async () => {
  const ahead = dayKeyBack(0, "Pacific/Kiritimati");     // UTC+14: today or tomorrow in California
  const { ctx, page } = await settingsPage(null, { timezoneId: "America/Los_Angeles",
    clothing: clothingPayload({ picks: { days: 3, lastDay: ahead, top: [] } }) });
  await page.waitForFunction(() => /\S/.test(document.getElementById("picksStatus").textContent));
  const t = await picksText(page);
  assert.match(t, /3 days recorded\./, "the sentence still closes: " + t);
  assert.doesNotMatch(t, /yesterday/, ahead + " → " + t);
  await ctx.close();
});

// The read-out is painted from the same fetch as the AI status line and BEFORE
// it (plan T5.2), so a payload the card cannot render must not take that line
// down with it: aiPaint's one try/catch would swallow the throw and leave both
// lines blank on every five-second repaint.
test("a picks block the card cannot render never takes the AI status line with it", async () => {
  const { ctx, page } = await settingsPage(null, { clothing: clothingPayload({
    // names as a string, not an array: (c.names||[]).join is not a function
    picks: { days: 4, lastDay: dayKeyBack(1, "UTC"),
             top: [{ combo: ["item_aaaa"], names: "Sunny tee", weight: 1 }] } }) });
  await page.waitForFunction(() => /\S/.test(document.getElementById("aiStatus").textContent));
  assert.match(await page.$eval("#aiStatus", e => e.textContent), /key checked and working/,
    "the line that was there before this card existed is still there");
  await ctx.close();
});

// ---------------------------------------------- loose photos and their book (9/7)
// dad dropped seventeen iPhone photos straight into books/ and the card said
// "No books yet" over the top of them for ten minutes.
//
// The ten minutes themselves are gone (spec §12, "built here"): the scan no
// longer gathers that pile, so the card that used to promise a start on a clock
// now offers the tap that is the only thing which starts one.

test("photos waiting in books/ are said out loud, and they wait for a TAP", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [], loose: 17 }));
  await page.waitForFunction(() => /photo/.test(document.getElementById("contentStatus").textContent));
  const s = await page.$eval("#contentStatus", e => e.textContent);
  assert.match(s, /17 photos/, s);
  assert.match(s, /one book/i, "the hub says what it is going to assume");
  assert.match(s, /tap Build|press Build/i, "and who starts it");
  assert.doesNotMatch(s, /10 minutes/, "nothing starts on a clock any more");
  assert.doesNotMatch(s, /No books yet/i, "never over the top of seventeen photos");
  assert.equal(await page.isVisible("#contentStatus button[data-build-loose]"), true,
    "the pile with no folder gets its own Build");
  await ctx.close();
});

// Spec §14: "the Settings content card renders `waiting` rows as 'N photos —
// waiting for a grown-up to tap Build'". The count is the photos, and the
// pages-read counter stays away: nothing has been read, and "0 of 17 pages
// read" under a pile nobody has started reads like a failure.
test("a pile of photos says how many, and that it is waiting for a grown-up (spec §14)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [pileJob()] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const s = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(s, /17 photos/, s);
  assert.match(s, /waiting for a grown-up to tap Build/i, s);
  assert.doesNotMatch(s, /0 of 17 pages read/, "nothing has been read; that is not a failure to report");
  assert.doesNotMatch(s, /building begins|by itself/i, s);
  await ctx.close();
});

// The press that spends the family's money, in Settings' own two-tap arm (the
// shutdown button's idiom, index.html:596): the first tap arms and buys
// nothing, the second is the one that builds.
test("Build on a pile row arms on the first tap and posts on the second (spec §14)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [pileJob()] }));
  const posts = [];
  await page.route("**/content/build", r => {
    posts.push(JSON.parse(r.request().postData()));
    r.fulfill({ status: 202, contentType: "application/json",
                body: JSON.stringify({ started: true, slug: "tabby-mctat" }) });
  });
  const btn = page.locator('#contentBooks [data-slug="tabby-mctat"] button[data-build]');
  assert.match(await btn.textContent(), /Build/i);
  await btn.click();
  await page.waitForFunction(() => /again/i.test(
    document.querySelector('#contentBooks [data-slug="tabby-mctat"] button[data-build]').textContent));
  assert.deepEqual(posts, [], "one tap spends nothing");
  const [req] = await Promise.all([
    page.waitForRequest(r => r.url().includes("/content/build") && r.method() === "POST"),
    btn.click(),
  ]);
  assert.deepEqual(JSON.parse(req.postData()), { kind: "books", slug: "tabby-mctat" });
  await ctx.close();
});

// This card rebuilds every row every five seconds, so an arm kept on the button
// would be thrown away half a second before the second tap. It lives outside the
// paint, the way the reader's ask does (`S.asking`, spec §13).
test("an armed Build survives the card's own repaint", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [pileJob()] }));
  await page.route("**/content/build", r => r.fulfill({ status: 202,
    contentType: "application/json", body: JSON.stringify({ started: true, slug: "tabby-mctat" }) }));
  const btn = page.locator('#contentBooks [data-slug="tabby-mctat"] button[data-build]');
  await btn.click();
  await page.evaluate(() => contentPaint());
  assert.match(await btn.textContent(), /again/i, "the arm outlived the repaint");
  const [req] = await Promise.all([
    page.waitForRequest(r => r.url().includes("/content/build") && r.method() === "POST"),
    btn.click(),
  ]);
  assert.deepEqual(JSON.parse(req.postData()), { kind: "books", slug: "tabby-mctat" });
  await ctx.close();
});

// The pile in books/ has no folder and so no slug until the hub gathers it, so
// its tap says `loose:true` and the hub hands the new slug back (spec §14). The
// reader's old NUL-prefixed grid marker is never sent, and neither is this
// card's own copy of it.
test("the loose pile's Build posts loose:true, never a slug", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [], loose: 17 }));
  await page.route("**/content/build", r => r.fulfill({ status: 202,
    contentType: "application/json", body: JSON.stringify({ started: true, slug: "photos-10-september" }) }));
  const btn = page.locator("#contentStatus button[data-build-loose]");
  await btn.click();
  await page.waitForFunction(() => /again/i.test(
    document.querySelector("#contentStatus button[data-build-loose]").textContent));
  const [req] = await Promise.all([
    page.waitForRequest(r => r.url().includes("/content/build") && r.method() === "POST"),
    btn.click(),
  ]);
  const body = req.postData();
  assert.deepEqual(JSON.parse(body), { kind: "books", loose: true });
  assert.doesNotMatch(body, /\u0000|slug/, body);
  await ctx.close();
});

// A refusal is a sentence the hub wrote, not a status code: "another computer
// in the family is making this book" is the whole answer, and the card says it
// in the hub's own words (server.js answers 409 {refused, error}).
test("a refused Build shows the hub's own sentence", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [pileJob()] }));
  await page.route("**/content/build", r => r.fulfill({ status: 409,
    contentType: "application/json", body: JSON.stringify({ refused: "elsewhere",
      error: "Another computer in the family is making this book." }) }));
  const btn = page.locator('#contentBooks [data-slug="tabby-mctat"] button[data-build]');
  await btn.click();
  await page.waitForFunction(() => /again/i.test(
    document.querySelector('#contentBooks [data-slug="tabby-mctat"] button[data-build]').textContent));
  await btn.click();
  await page.waitForFunction(() => /Another computer in the family/i.test(document.body.textContent));
  await ctx.close();
});

// The same door, the same manners: since "built here" /content/run refuses a
// book another computer holds (server.js answers 409 {refused, error}), and
// "Try this book again" used to throw that answer away — leaving a parent
// pressing a button that plainly did nothing.
test("a run this hub may not make says why, in the hub's own words", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [bookJob({
    state: "failed", step: "transcribe", elsewhere: true, buildable: false,
    error: "ai(google/gemini-3-flash-preview) 500 boom" })] }));
  await page.route("**/content/run", r => r.fulfill({ status: 409,
    contentType: "application/json", body: JSON.stringify({ refused: "elsewhere",
      error: "Another computer in the family is making this book." }) }));
  await page.click('#contentBooks [data-slug="tabby-mctat"] button[data-run]');
  await page.waitForFunction(() => /Another computer in the family/i.test(document.body.textContent));
  await ctx.close();
});

// The one time the card says why there is no button (spec §13/§14). No device
// name, no path: another computer is enough.
test("a book another computer is building says so, and offers no Build (spec §13)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    jobs: [bookJob({ elsewhere: true, buildable: false })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const s = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(s, /Building on another computer/i, s);
  assert.equal(await page.$$eval('#contentBooks button[data-build]', b => b.length), 0,
    "nothing to press: the other computer holds this book");
  await ctx.close();
});

// The weekly book (spec §8): it arrives finished, its job.json says `done`
// before the manifest lands, and this hub never builds it. The row it gets is
// the one every finished book gets, unchanged.
test("a finished book from another computer says it is ready to read (§17)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [bookJob({
    slug: "first-grade-news", title: "First Grade News", state: "done", step: null,
    published: true, buildable: false, progress: { pages: 8, transcribed: 8, narrated: 8 } })] }));
  await page.waitForSelector('#contentBooks [data-slug="first-grade-news"]');
  const s = await page.$eval('#contentBooks [data-slug="first-grade-news"]', e => e.textContent);
  assert.match(s, /Ready to read in Book Reader ✓/, s);
  assert.equal(await page.$$eval('#contentBooks button[data-build]', b => b.length), 0,
    "an already-made book is never offered a build");
  await ctx.close();
});

// Spec §12: "every sentence that promised an automatic start goes", and "a test
// asserts no card promises one". The whole card is read, static copy included —
// the hint above the list promised the same thing in the same breath.
test("nothing in Your books promises a build that starts by itself (spec §12)", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [pileJob()], loose: 17 }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"] button[data-build]');
  const card = await page.$eval("#content", e => e.textContent);
  for (const promise of [/building begins/i, /starts building/i, /looks for new photos/i,
                         /minutes after the last/i, /by itself/i, /on its own/i])
    assert.doesNotMatch(card, promise, card);
  assert.match(card, /tap Build|press Build/i, "and it says what does start one");
  await ctx.close();
});

test("iPhone photos with no decoder: the card names the fix, not a code word", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    jobs: [bookJob({ state: "inbox", held: "needs-photo-decoder" })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const s = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(s, /HEIC/, s);
  assert.match(s, /Clothing Picker/, "it names the app that carries the decoder");
  assert.match(s, /JPEG/, "…and the other way out");
  assert.doesNotMatch(s, /needs-photo-decoder/, "the code word never reaches the parent");
  await ctx.close();
});

test("a book with no AI key says so instead of pretending to read", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    jobs: [bookJob({ state: "transcribing", held: "no-ai-key" })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const s = await page.$eval('#contentBooks [data-slug="tabby-mctat"]', e => e.textContent);
  assert.match(s, /AI helper key/i, s);
  await ctx.close();
});

// A HOLD IS DECIDED BY THE HOLD, not by the absence of an error. A book holding
// on "retry" ALWAYS carries one — content-worker.js notes the page it lost and
// only then holds, and content.js publishes that last message as `error` for
// exactly this state — so the sentence written for it could never be shown, and
// a book that is going to try again by itself was reported as stopped.
test("a book that lost a page says it will try again, and is not called stopped", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    jobs: [bookJob({ state: "transcribing", held: "retry",
                     error: "ai(google/gemini-3-flash-preview) 500 boom on page 4" })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = page.locator('#contentBooks [data-slug="tabby-mctat"]');
  const s = await row.textContent();
  assert.match(s, /tries that page again/i, s);
  assert.match(s, /every page already read is kept/i);
  assert.equal(await row.locator(".status.bad").count(), 0, "a book that is still going is not a red line");
  await ctx.close();
});

test("a book that really stopped keeps its red line, in words and never the provider's", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    // …carrying the hold it was under when it fell over: content-store.fail
    // keeps `held`, so the card must not tell a parent to wait AND that it
    // stopped in the same breath.
    jobs: [bookJob({ state: "failed", held: "needs-photo-decoder",
                     error: "ai(google/gemini-3-flash-preview) 500 boom" })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = page.locator('#contentBooks [data-slug="tabby-mctat"]');
  assert.equal(await row.locator(".status.bad").count(), 1);
  assert.doesNotMatch(await row.textContent(), /carries on by itself/i,
    "a book that stopped is not also waiting");
  const s = await row.locator(".status.bad").textContent();
  assert.match(s, /could not be reached/i, s);
  assert.doesNotMatch(s, /gemini|boom/i, "the raw provider string never reaches the card");
  assert.equal(await row.locator("button[data-run]").count(), 1, "and there is something to press");
  await ctx.close();
});

// The two holds only a PERSON can lift are looked at twice a day rather than
// every half hour (content.js SLOW_HOLDS), so the parent who has just ticked the
// box gets a press that says "look now" instead of waiting until the morning.
test("a book waiting on a person can be started by hand", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    jobs: [bookJob({ state: "inbox", held: "needs-photo-decoder" })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = page.locator('#contentBooks [data-slug="tabby-mctat"]');
  assert.equal(await row.locator("button[data-run]").count(), 1);
  let sent = null;
  await page.route("**/content/run", (r) => {
    sent = JSON.parse(r.request().postData());
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await row.locator("button[data-run]").click();
  await page.waitForFunction(() => /Starting/i.test(document.body.textContent));
  assert.deepEqual(sent, { kind: "books", slug: "tabby-mctat", step: null, retry: true });
  await ctx.close();
});

test("a book New ERA named itself offers the rename, and says how to split it", async () => {
  const { ctx, page } = await settingsPage(statusPayload({
    jobs: [bookJob({ title: "New book 2026-09-07", autoTitle: true })] }));
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = page.locator('#contentBooks [data-slug="tabby-mctat"]');
  const s = await row.textContent();
  assert.match(s, /gathered these loose photos into one book/i, s);
  assert.match(s, /own folder/i, "and how to say 'these were two books'");
  // touch-only, no dwell, no confirm dialog: a button and a box.
  assert.equal(await row.locator("button[data-rename]").count(), 1);
  assert.equal(await row.locator(".ct-rename").isHidden(), true, "the box is out of the way until asked for");
  await row.locator("button[data-rename]").click();
  await row.locator(".ct-rename").waitFor({ state: "visible" });
  assert.equal(await row.locator(".ct-rename input").inputValue(), "New book 2026-09-07",
    "prefilled with the name it has now");
  await ctx.close();
});

test("the rename box posts the new name and shows the hub's own refusal", async () => {
  const { ctx, page } = await settingsPage(statusPayload({ jobs: [bookJob({ autoTitle: true })] }));
  let sent = null;
  await page.route("**/content/rename", (r) => {
    sent = JSON.parse(r.request().postData());
    r.fulfill({ status: 400, contentType: "application/json",
                body: JSON.stringify({ error: "New ERA is working on this book right now — try again in a minute." }) });
  });
  await page.waitForSelector('#contentBooks [data-slug="tabby-mctat"]');
  const row = page.locator('#contentBooks [data-slug="tabby-mctat"]');
  await row.locator("button[data-rename]").click();
  await row.locator(".ct-rename input").fill("Sunny Pond");
  await row.locator(".ct-rename-save").click();
  await page.waitForFunction(() => /working on this book/i.test(document.body.textContent));
  assert.deepEqual(sent, { kind: "books", slug: "tabby-mctat", title: "Sunny Pond" });
  await ctx.close();
});
