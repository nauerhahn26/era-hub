// setup.test.mjs — first-run wizard contract: fresh data dir has no profile,
// /home/ serves, POST /setup creates the profile + dwell, /settings reflects it
// immediately (no restart), and the wizard is idempotent (rename updates).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8397;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-setup-"));
let child;

before(async () => {
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
});
after(() => { if (child) child.kill("SIGKILL"); });

test("fresh data dir: hasProfile=false, neutral childName, /home/ serves", async () => {
  const s = await (await fetch(`${BASE}/settings`)).json();
  assert.equal(s.hasProfile, false);
  assert.equal(s.childName, "friend");
  assert.equal((await fetch(`${BASE}/home/`)).status, 200);
});

test("POST /setup creates profile + dwell; /settings reflects with NO restart", async () => {
  const r = await fetch(`${BASE}/setup`, { method: "POST",
    body: JSON.stringify({ childName: "Zoe", dwellMs: 1400 }) });
  assert.equal(r.status, 204);
  const prof = JSON.parse(fs.readFileSync(path.join(TMP, "profile.json"), "utf8"));
  assert.equal(prof.childName, "Zoe");
  const s = await (await fetch(`${BASE}/settings`)).json();
  assert.equal(s.hasProfile, true);
  assert.equal(s.childName, "Zoe");
  assert.equal(s.dwellMs, 1400);
});

test("idempotent: re-setup renames without clobbering other profile keys", async () => {
  const p = path.join(TMP, "profile.json");
  const before = JSON.parse(fs.readFileSync(p, "utf8"));
  before.publishEmail = "keep@example.com";
  fs.writeFileSync(p, JSON.stringify(before));
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`${BASE}/setup`, { method: "POST",
    body: JSON.stringify({ childName: "Zo" }) });
  assert.equal(r.status, 204);
  const after2 = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after2.childName, "Zo");
  assert.equal(after2.publishEmail, "keep@example.com", "existing keys survive");
});

test("validation: empty name 400; junk body 400", async () => {
  assert.equal((await fetch(`${BASE}/setup`, { method: "POST", body: '{"childName":"  "}' })).status, 400);
  assert.equal((await fetch(`${BASE}/setup`, { method: "POST", body: "not json" })).status, 400);
});
