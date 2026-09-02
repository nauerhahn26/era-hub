// mail.test.mjs — The Pencil's "Send" tells the truth (audit 9/2).
// Before: /publish answered 204 unconditionally, so every public install
// heard "Sent! Your words are on their way" while no family email was ever
// configured (nothing in the product wrote it). Now Settings sets the pair
// via /mail-config (proven by a real test send), /publish reports mailed /
// not configured / failed, and unsent writings are retried once mail works.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8419;       // never live 8377; 8391-8418 held by sibling suites
const FAKE = 8420;       // stand-in for api.resend.com
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-mail-"));
let child, fake;
const got = [];          // every email the fake provider accepted
let mode = "ok";         // ok | badkey | down

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c);
    req.on("end", () => {
      const auth = req.headers.authorization || "";
      if (mode === "badkey" || !auth.startsWith("Bearer re_")) { res.writeHead(401).end('{"message":"API key is invalid"}'); return; }
      if (mode === "down") { res.writeHead(500).end("boom"); return; }
      got.push(JSON.parse(b));
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"x"}');
    });
  });
  await new Promise(r => fake.listen(FAKE, "127.0.0.1", r));
  fs.writeFileSync(path.join(TMP, "profile.json"), JSON.stringify({ childName: "Maya" }));
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_RESEND_URL: `http://127.0.0.1:${FAKE}/emails` },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); fake.close(); });

const publish = (text) => fetch(`${BASE}/publish`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: Date.now(), session: "s", text }) });
const mailcfg = (body) => fetch(`${BASE}/mail-config`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("with no family email set up, Send saves for Settings and says so", async () => {
  const r = await publish("i love you");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { saved: true, mailed: false, reason: "not configured" });
  const files = fs.readdirSync(path.join(TMP, "writings"));
  assert.equal(files.length, 1, "the writing is on disk");
  assert.equal(got.length, 0, "nothing was mailed");
  const m = await (await fetch(`${BASE}/mail-config`)).json();
  assert.equal(m.hasKey, false);
  assert.equal(m.writings.length, 1);
  assert.equal(m.writings[0].text, "i love you");
  assert.equal(m.writings[0].mailed, false);
});

test("an empty message is refused, not saved", async () => {
  assert.equal((await publish("   ")).status, 400);
  assert.equal(fs.readdirSync(path.join(TMP, "writings")).length, 1);
});

test("a key Resend rejects is named as such — no false 'working'", async () => {
  const r = await mailcfg({ email: "mum@example.com", apiKey: "nope" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /did not recognise that key/);
  const m = await (await fetch(`${BASE}/mail-config`)).json();
  assert.equal(m.ok, false, "status remembers the failed test");
});

test("a working pair sends a test email, then catches up the unsent writing", async () => {
  const r = await mailcfg({ email: "mum@example.com", apiKey: "re_good" });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(got.length >= 1, true);
  assert.deepEqual(got[0].to, ["mum@example.com"]);
  assert.match(got[0].subject, /connected/);
  // the writing saved before email existed goes out now
  for (let i = 0; i < 40 && got.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(got.length, 2, "earlier writing was mailed on catch-up");
  assert.match(got[1].subject, /Maya wrote/);
  assert.match(got[1].html, /i love you/);
  const m = await (await fetch(`${BASE}/mail-config`)).json();
  assert.equal(m.email, "mum@example.com");
  assert.equal(m.hasKey, true);
  assert.equal(m.ok, true);
  assert.ok(m.writings[0].mailed, "writing marked as mailed");
  // the key never lands in profile.json (credentials.env only)
  assert.equal(fs.readFileSync(path.join(TMP, "profile.json"), "utf8").includes("re_good"), false);
  assert.match(fs.readFileSync(path.join(TMP, "credentials.env"), "utf8"), /^RESEND_API_KEY=re_good$/m);
});

test("with email working, Send really mails and says Sent", async () => {
  const before = got.length;
  const j = await (await publish("hi dad")).json();
  assert.deepEqual(j, { saved: true, mailed: true });
  assert.equal(got.length, before + 1);
  assert.match(got[got.length - 1].html, /hi dad/);
});

test("when the provider is down, Send says saved-not-sent and keeps the words", async () => {
  mode = "down";
  const j = await (await publish("see you soon")).json();
  assert.deepEqual(j, { saved: true, mailed: false, reason: "failed" });
  const m = await (await fetch(`${BASE}/mail-config`)).json();
  const w = m.writings.find(x => x.text === "see you soon");
  assert.equal(w.mailed, false);
  assert.match(w.mailError, /Resend answered 500/);
  mode = "ok";
});

test("the mail sender escapes her words — a < in a message is not HTML", async () => {
  const j = await (await publish("i <3 you & mum")).json();
  assert.equal(j.mailed, true);
  assert.match(got[got.length - 1].html, /i &lt;3 you &amp; mum/);
});
