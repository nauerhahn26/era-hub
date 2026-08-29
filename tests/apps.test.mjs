// apps.test.mjs — app-picker contract (8/29 ruling: install everything, one,
// or a few). GET /apps lists the registry with enabled flags; absent
// data/apps.json = everything enabled (existing installs keep their apps);
// POST /apps toggles one app and persists the set; unknown ids are refused.
// Shortcut side effects are Windows-only and not exercised here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8413; // never live 8377; 8391-8412 held by sibling suites
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-apps-"));
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

test("fresh install: every app enabled, registry carries title/sub/path", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.ok(apps.length >= 6);
  assert.ok(apps.every(a => a.enabled === true));
  const pencil = apps.find(a => a.id === "pencil");
  assert.equal(pencil.title, "The Pencil");
  assert.equal(pencil.path, "/pencil/");
  assert.ok(apps.every(a => a.title && a.sub && a.path));
});

test("disable persists to data/apps.json; re-enable restores", async () => {
  let r = await fetch(`${BASE}/apps`, { method: "POST",
    body: JSON.stringify({ id: "movies", enabled: false }) });
  assert.equal(r.status, 204);
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "apps.json"), "utf8"));
  assert.ok(!onDisk.enabled.includes("movies"));
  let { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.equal(apps.find(a => a.id === "movies").enabled, false);
  assert.equal(apps.find(a => a.id === "pencil").enabled, true, "others untouched");

  r = await fetch(`${BASE}/apps`, { method: "POST",
    body: JSON.stringify({ id: "movies", enabled: true }) });
  assert.equal(r.status, 204);
  ({ apps } = await (await fetch(`${BASE}/apps`)).json());
  assert.equal(apps.find(a => a.id === "movies").enabled, true);
});

test("an install-chooser style apps.json (a few apps) is honored", async () => {
  fs.writeFileSync(path.join(TMP, "apps.json"),
    JSON.stringify({ enabled: ["pencil", "reader"] }));
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  const on = apps.filter(a => a.enabled).map(a => a.id).sort();
  assert.deepEqual(on, ["pencil", "reader"]);
});

test("unknown app id or bad body is refused", async () => {
  assert.equal((await fetch(`${BASE}/apps`, { method: "POST",
    body: JSON.stringify({ id: "nope", enabled: true }) })).status, 400);
  assert.equal((await fetch(`${BASE}/apps`, { method: "POST",
    body: JSON.stringify({ id: "pencil", enabled: "yes" }) })).status, 400);
  assert.equal((await fetch(`${BASE}/apps`, { method: "POST", body: "{" })).status, 400);
});
