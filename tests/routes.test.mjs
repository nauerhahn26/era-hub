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

// The door, decided in one place (dad 9/3: "configure where you return to
// when an app closes — TD Snap or New ERA"). Every app POSTs /kiosk/exit and
// follows the answer; the setting round-trips through /settings.
test("Settings exitTo round-trips and rejects junk", async () => {
  const s0 = await (await fetch(`${BASE}/settings`)).json();
  assert.equal(s0.exitTo, "tdsnap", "TD Snap is the default door");
  const post = (exitTo) => fetch(`${BASE}/settings`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exitTo }) });
  await post("home");
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).exitTo, "home");
  await post("elsewhere");
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).exitTo, "home", "unknown values are ignored");
  await post("tdsnap");
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).exitTo, "tdsnap");
});

test("POST /kiosk/exit → home when no engine answers (TD Snap chosen but unreachable)", async () => {
  const r = await fetch(`${BASE}/kiosk/exit`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { action: "home" });
  // ...and /settings tells the apps so (the Reader's tile is named for it)
  assert.equal((await (await fetch(`${BASE}/settings`)).json()).doorGoes, "home", "no engine on the bus: doorGoes=home even though exitTo=tdsnap");
});

test("POST /kiosk/exit → closed when the engine takes the screen; → home when Settings says New ERA", async () => {
  // a stand-in ERAgaze on its fixed port; skip (not fail) if a real one holds it
  const http = await import("node:http");
  const hits = [];
  const engine = http.createServer((q, s) => { hits.push(q.url); s.writeHead(200).end("ok"); });
  const bound = await new Promise((res) => {
    engine.once("error", () => res(false));
    engine.listen(49155, "127.0.0.1", () => res(true));
  });
  if (!bound) { console.log("# 49155 busy — engine stand-in skipped"); return; }
  try {
    assert.equal((await (await fetch(`${BASE}/settings`)).json()).doorGoes, "tdsnap", "/settings says where the door really goes");
    hits.length = 0;                                   // (that probe was /status)
    const r = await fetch(`${BASE}/kiosk/exit`, { method: "POST" });
    assert.deepEqual(await r.json(), { action: "closed" });
    assert.deepEqual(hits, ["/app/exit"], "TD Snap: the hub asks the engine to hand the screen over");

    await fetch(`${BASE}/settings`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exitTo: "home" }) });
    hits.length = 0;
    assert.equal((await (await fetch(`${BASE}/settings`)).json()).doorGoes, "home");
    const r2 = await fetch(`${BASE}/kiosk/exit`, { method: "POST" });
    assert.deepEqual(await r2.json(), { action: "home" });
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(hits, ["/app/park"], "New ERA: no hand-over, only the park override is cleared");
  } finally {
    engine.close();
    await fetch(`${BASE}/settings`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exitTo: "tdsnap" }) });
  }
});
