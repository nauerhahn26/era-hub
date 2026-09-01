// routes.test.mjs — static-route contract from the install QA (8/28): app
// directories reached WITHOUT a trailing slash redirect to the canonical
// slash form (query string kept) instead of 404ing, and /favicon.ico serves
// so browsers stop logging a 404 on every app. Born of the v0.12.0 payload
// QA: a family typing 127.0.0.1:8377/pencil got a bare "not found".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8409; // never live 8377; 8391-8408 held by sibling suites (movies took 8404-8406)
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-routes-"));
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

test("app dirs without trailing slash redirect to the slash form", async () => {
  for (const dir of ["/pencil", "/board", "/reader", "/home", "/lib"]) {
    const r = await fetch(`${BASE}${dir}`, { redirect: "manual" });
    assert.equal(r.status, 301, `${dir} should 301`);
    assert.equal(r.headers.get("location"), `${dir}/`);
  }
});

test("redirect keeps the query string (Music board deep link)", async () => {
  const r = await fetch(`${BASE}/board?recipe=songs`, { redirect: "manual" });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/board/?recipe=songs");
});

test("redirected app dirs then serve 200", async () => {
  for (const dir of ["/pencil", "/board", "/reader", "/home"]) {
    const r = await fetch(`${BASE}${dir}`); // follow redirects
    assert.equal(r.status, 200, `${dir} should land on index.html`);
  }
});

test("missing paths still 404 (no blind redirecting)", async () => {
  assert.equal((await fetch(`${BASE}/nope`, { redirect: "manual" })).status, 404);
  assert.equal((await fetch(`${BASE}/nope/`, { redirect: "manual" })).status, 404);
});

test("/favicon.ico serves with an image content type", async () => {
  const r = await fetch(`${BASE}/favicon.ico`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /icon|image/);
});

// The exit door's closer (dad 9/1: Making Words and The Pencil returned him to
// TD Snap but kept running behind it — the gaze engine's sweep missed our
// kiosk). The hub is always present, so it owns closing its own window; the
// route must answer immediately and never fail the caller.
test("POST /kiosk/close answers ok and never throws", async () => {
  const r = await fetch(`${BASE}/kiosk/close`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
