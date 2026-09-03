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

async function settingsPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  // ERAgaze lives on 127.0.0.1:49155 on the family PC; here nothing answers
  await ctx.route("http://127.0.0.1:49155/**", r => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/settings/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#appsList label").length > 0);
  return { ctx, page };
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
