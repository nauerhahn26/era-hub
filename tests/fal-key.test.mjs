// fal key card door — POST/GET /fal-key (T6.1).
//
// fal is the ONLY key in the product that spends real money per press, so its
// card owes a parent two things the free keys do not: proof the key is real
// before a book is ever quoted, and a price to quote it with. The door proves
// the key the way /tts-key proves a voice key — one cheap real call, here
// GET /v1/account/billing, which reads a balance and generates nothing — and
// answers {ok, error?, perClipPrice?}.
//
// The key itself must never come back out: not in the POST answer, not in the
// GET the card paints itself from, not in a log line. The suite spawns the real
// server.js with stdout PIPED so that last one is checked rather than hoped for.
//
// No network: ERA_FAL_URL points at a stand-in on 127.0.0.1 (plan §B port
// table: 8439 hub + 8441 fake fal). No real key is read, typed or printed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { aiRoles } = require("./ai-config.js");
const PORT = 8439;        // plan §B: this suite's port, never a live hub's
const FAKE = 8441;        // stand-in for api.fal.ai
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-fal-key-"));
const CFG = path.join(TMP, "ai-config.json");

// Stand-in key material only — never a real credential (plan §B.3).
const GOOD = "fal-good-1234567890";
const BAD = "fal-typo-missing-char";
const DEAD = "fal-unplugged";        // the stand-in hangs up on this one

let child, fake, out = "";
// Guardrail §B.2(c): the stand-in COUNTS what it was asked. Zero calls would
// mean the probe went somewhere real on the family's money.
let calls = 0;

before(async () => {
  fake = http.createServer((req, res) => {
    calls++;
    const auth = String(req.headers.authorization || "");
    // fal's own header shape: "Authorization: Key <key>". A hub that sent the
    // key any other way would pass here and fail on the real thing.
    if (auth === "Key " + DEAD) { req.socket.destroy(); return; }
    if (!req.url.startsWith("/v1/account/billing")) { res.writeHead(404).end(); return; }
    if (auth !== "Key " + GOOD)
      return res.writeHead(401, { "Content-Type": "application/json" })
        .end('{"error":{"type":"unauthorized","message":"invalid credentials"}}');
    res.writeHead(200, { "Content-Type": "application/json" })
       .end('{"username":"a-family","credits":{"current_balance":4.2,"currency":"USD"}}');
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1",
           ERA_FAL_URL: `http://127.0.0.1:${FAKE}` },
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

const save = (body, headers) => fetch(`${BASE}/fal-key`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body) });
const held = () => fetch(`${BASE}/fal-key`, { cache: "no-store" }).then(r => r.json());
const onDisk = () => { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } };

test("a key fal recognises comes back ok, with the price of one clip", async () => {
  const before_ = calls;
  const r = await save({ apiKey: GOOD });
  assert.equal(calls, before_ + 1, "the probe reached the stand-in, not fal itself");
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.ok, true);
  // The cost gate (T6.2) is mandatory, so the probe owes it a number: without
  // one the animate button can never be enabled.
  assert.equal(typeof v.perClipPrice, "number");
  assert.ok(v.perClipPrice > 0 && v.perClipPrice < 5, "a per-clip price, not a per-book one");
  assert.ok(!JSON.stringify(v).includes(GOOD), "the key never comes back out of the hub");
  assert.equal(onDisk().fal.apiKey, GOOD, "and it IS saved");
  assert.equal(onDisk().fal.keyOk, true);
});

test("the card is painted from what is saved, never from the key", async () => {
  const st = await held();
  assert.equal(st.ok, true);
  assert.equal(st.saved, true);
  assert.equal(st.keyOk, true);
  assert.equal(typeof st.perClipPrice, "number");
  assert.ok(!JSON.stringify(st).includes(GOOD), "the key never comes back out of the hub");
});

test("saving a fal key does not eat the keys beside it in the same file", async () => {
  // /ai-key and /movies-key write this same file; a card that rewrote it would
  // take the clothing build and the film search down with it.
  const cfg = onDisk();
  cfg.provider = "google"; cfg.apiKey = "test-vision-key";
  cfg.tmdb = { apiKey: "test-tmdb-key" };
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 1));
  await save({ apiKey: GOOD });
  const after = onDisk();
  assert.equal(after.apiKey, "test-vision-key");
  assert.deepEqual(after.tmdb, { apiKey: "test-tmdb-key" });
  assert.equal(after.fal.apiKey, GOOD);
  // …and it is written tmp-then-rename rather than in place (review 9/5): with
  // four cards' keys in one file, a save that died half way through — a crash,
  // a full disk (9/3) — would take every one of them with it. The rename is
  // what makes that impossible, and it leaves nothing behind.
  assert.equal(fs.existsSync(path.join(TMP, "ai-config.tmp")), false, "no litter beside the keys");
});

test("a key fal refuses is said in words, and is no key at all afterwards", async () => {
  const v = await (await save({ apiKey: BAD })).json();
  assert.equal(v.ok, false);
  assert.match(v.error, /fal/i);
  assert.match(v.error, /missing character/i, "the parent is told what to look for");
  assert.doesNotMatch(v.error, /401|unauthorized|invalid credentials/i,
                      "the provider's status line is not a sentence");
  assert.equal(onDisk().fal.keyOk, false);
  // …and the role a spender reads answers null, so the animate step can never
  // start a run on a key fal has already refused (elevenRole's rule).
  assert.equal(aiRoles(TMP).fal, null);
  const st = await held();
  assert.equal(st.saved, true);
  assert.equal(st.keyOk, false);
  assert.match(st.error, /missing character/i);
});

test("fal unreachable is 'could not reach', not a rejected key", async () => {
  const v = await (await save({ apiKey: DEAD })).json();
  assert.equal(v.ok, false);
  assert.match(v.error, /could not reach fal/i);
  // A hub that is merely offline must not tell a parent their key is wrong.
  assert.doesNotMatch(v.error, /recognise|missing character/i);
});

test("an empty box clears the key and the card goes back to 'no key yet'", async () => {
  const before_ = calls;
  const v = await (await save({ apiKey: "  " })).json();
  assert.equal(calls, before_, "clearing a key asks fal nothing");
  assert.equal(v.ok, true);
  assert.equal(v.saved, false);
  assert.equal(onDisk().fal, undefined, "the role is gone, not left blank");
  const st = await held();
  assert.equal(st.saved, false);
  assert.equal(st.keyOk, null);
});

test("the door is this hub's own pages only, and refuses nonsense", async () => {
  const cross = await save({ apiKey: GOOD }, { "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  assert.equal((await save({ apiKey: 12 })).status, 400);
  assert.equal((await save({ apiKey: "x".repeat(400) })).status, 400);
  const raw = await fetch(`${BASE}/fal-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{ not json" });
  assert.equal(raw.status, 400);
});

test("no key the family typed ever reached a log line", async () => {
  await new Promise(r => setTimeout(r, 200));
  for (const k of [GOOD, BAD, DEAD])
    assert.equal(out.includes(k), false, "a key reached stdout/stderr");
});
