// AI helper key card door — POST /ai-key proves the key (VM QA 9/5, T7.6 bug 6).
//
// The Voice card says "Key checked and working ✓" because /tts-key asks
// ElevenLabs; the AI card only ever said "saved ✓", so a Google key with one
// character missing sat there looking accepted until the Clothing Picker
// quietly held every photo. The door now asks the provider the cheapest
// question it has — list your models — which spends no tokens on any of the
// three, and answers {ok, error?} the way /tts-key and /fal-key do.
//
// A refused key is still SAVED (the card shows the refusal and asks for a
// paste-again; a family offline at save time must not lose the key they
// typed), and it never comes back out: not in the answer, not in
// /clothing/status, not in a log line — the server's stdout is piped and read.
//
// No network: ERA_AI_URL points at a stand-in on 127.0.0.1 (this suite's ports:
// 8449 hub + 8431 fake provider). No real key is read, typed or printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8449;
const FAKE = 8431;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-ai-key-"));
const CFG = path.join(TMP, "ai-config.json");

// Stand-in key material only — never a real credential.
const GOOD = "AQ.stand-in-good-key-0123456789";
const BAD = "AQ.stand-in-typo-key";
const DEAD = "AQ.stand-in-unplugged";     // the stand-in hangs up on this one

let child, fake, out = "";
let calls = [];        // {url, headers} of every probe the stand-in saw

before(async () => {
  fake = http.createServer((req, res) => {
    calls.push({ url: req.url, headers: req.headers });
    const h = req.headers;
    // each provider's own header shape — a hub that sent the key any other way
    // would pass here and fail on the real thing
    const key = h["x-goog-api-key"] || h["x-api-key"] ||
      (String(h.authorization || "").startsWith("Bearer ") ? String(h.authorization).slice(7) : "");
    if (key === DEAD) { req.socket.destroy(); return; }
    const google = req.url.startsWith("/v1beta/models");
    const other = req.url.startsWith("/v1/models");
    if (!google && !other) { res.writeHead(404).end(); return; }
    if (key !== GOOD) {
      // Google refuses a bad key with 400 API_KEY_INVALID; the other two with 401
      if (google) return res.writeHead(400, { "Content-Type": "application/json" })
        .end('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
      return res.writeHead(401, { "Content-Type": "application/json" })
        .end('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    }
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(google ? '{"models":[{"name":"models/gemini-3.1-flash-lite"}]}' : '{"data":[{"id":"a-model"}]}');
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_AI_URL: `http://127.0.0.1:${FAKE}`,
           // saving a key kicks the clothing build, which reads the weather
           ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1" },
  });
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); up = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!up) throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); fake.close(); });

const save = (body) => fetch(`${BASE}/ai-key`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const status = () => fetch(`${BASE}/clothing/status`, { cache: "no-store" }).then(r => r.json());
const onDisk = () => { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } };

test("a key the provider recognises comes back ok, and the card can say so", async () => {
  const n = calls.length;
  const r = await save({ provider: "google", apiKey: GOOD });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.ok, true);
  assert.equal(calls.length, n + 1, "one probe, at the stand-in, not at Google");
  assert.ok(calls[n].url.startsWith("/v1beta/models"), "the free question: list models " + calls[n].url);
  assert.ok(!calls[n].url.includes(GOOD), "the key travels in a header, never in the URL");
  assert.equal(calls[n].headers["x-goog-api-key"], GOOD);
  assert.ok(!JSON.stringify(v).includes(GOOD), "the key never comes back out of the hub");
  assert.equal(onDisk().apiKey, GOOD, "and it IS saved, in the flat shape ai-config.js reads first");
  assert.equal(onDisk().provider, "google");
  assert.equal(onDisk().keyOk, true);
  const s = await status();
  assert.equal(s.aiConfigured, true);
  assert.equal(s.aiKeyOk, true);
  assert.ok(!JSON.stringify(s).includes(GOOD));
});

test("a refused key is saved AND reported refused — never 'saved ✓'", async () => {
  const r = await save({ provider: "google", apiKey: BAD });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.ok, false);
  assert.match(v.error, /Google AI Studio did not recognise that key/);
  assert.equal(onDisk().apiKey, BAD, "saved: the family does not lose what they typed");
  assert.equal(onDisk().keyOk, false);
  const s = await status();
  assert.equal(s.aiConfigured, true, "the role is still set up (a wrongly-refused key must not lock the wardrobe)");
  assert.equal(s.aiKeyOk, false);
  assert.match(s.aiKeyError, /did not recognise/);
  assert.ok(!JSON.stringify(s).includes(BAD));
});

test("a provider that cannot be reached: saved, and honestly 'could not check'", async () => {
  const r = await save({ provider: "google", apiKey: DEAD });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.ok, false);
  assert.match(v.error, /could not reach Google AI Studio/);
  assert.equal(onDisk().apiKey, DEAD);
  assert.equal(onDisk().keyOk, undefined, "unknown, not refused");
  const s = await status();
  assert.equal(s.aiKeyOk, null);
});

test("Claude and OpenAI keys are asked in their own header shapes", async () => {
  let n = calls.length;
  let v = await (await save({ provider: "anthropic", apiKey: GOOD })).json();
  assert.equal(v.ok, true);
  assert.ok(calls[n].url.startsWith("/v1/models"), calls[n].url);
  assert.equal(calls[n].headers["x-api-key"], GOOD);
  assert.ok(calls[n].headers["anthropic-version"], "Anthropic refuses a request without a version");
  n = calls.length;
  v = await (await save({ provider: "openai", apiKey: GOOD })).json();
  assert.equal(v.ok, true);
  assert.ok(calls[n].url.startsWith("/v1/models"), calls[n].url);
  assert.equal(calls[n].headers.authorization, "Bearer " + GOOD);
  v = await (await save({ provider: "openai", apiKey: BAD })).json();
  assert.equal(v.ok, false);
  assert.match(v.error, /OpenAI did not recognise that key/);
});

test("saving the vision key keeps the other roles in the same file", async () => {
  const cfg = onDisk();
  cfg.fal = { apiKey: "fal-stand-in", keyOk: true, perClipPrice: 0.35 };
  fs.writeFileSync(CFG, JSON.stringify(cfg));
  await save({ provider: "google", apiKey: GOOD });
  assert.equal(onDisk().fal.apiKey, "fal-stand-in", "the fal role survived the save");
  assert.equal(onDisk().apiKey, GOOD);
});

test("a key that is not a string is refused before anything is probed", async () => {
  const n = calls.length;
  assert.equal((await save({ provider: "google", apiKey: 42 })).status, 400);
  assert.equal(calls.length, n, "nothing went out");
});

test("no key ever reaches the hub's log", () => {
  for (const k of [GOOD, BAD, DEAD]) assert.ok(!out.includes(k), "stdout/stderr carries " + k);
});
