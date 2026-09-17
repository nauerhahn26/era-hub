// kiosk-pause.test.mjs — the talk door's two hub endpoints (dad 9/17,
// "pause to talk"; spec docs/superpowers/specs/2026-09-17-pause-to-talk-design.md
// §3, plan §B T2).
//
// She is half way through a song and needs to say something. 💬 POSTs
// /kiosk/pause: the hub remembers WHICH app she paused, drops the app's park
// override, minimizes the kiosk and hands the screen to her talker — the
// kiosk stays alive behind it. Her TD Snap tile then runs start-hub.bat,
// which POSTs /kiosk/resume BEFORE it kills anything: the same app comes
// back to the front exactly where she left it (200 "resumed"), anything else
// answers 409 "launch" and the bat launches fresh as it always did.
//
// The shape of this suite is routes.test.mjs': a real hub child on a port of
// its own, and a stand-in ERAgaze on the engine's fixed 49155 — which SKIPS
// (never fails) when a real engine already holds that port, because the gate
// runs on machines that have one.
//
// Windows-only behaviour (minimize, restore, SetForegroundWindow) cannot run
// here, so foregroundKiosk() answers ERA_FAKE_KIOSK_WINDOW !== "0" off
// Windows: a second hub with that env set to "0" is the "she closed the
// kiosk by hand" leg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PORTS: 8463 (the hub) + 8464 (the same hub with no kiosk window). 8377/8378
// are live hubs; the sibling suites in tests/ hold 8390-8400, 8402-8406,
// 8409-8424, 8428-8450 and 8458-8462 — 8440/8441 in particular are
// book-review-ui's fake provider and fal-key/content-animate's fake fal, which
// is why this suite sits above the whole table. 8480+ are scratch hubs and
// 8500+ are the device ssh tunnels (which answer HTTP as the DEVICE's live
// hub), so 8463/8464 is the free pair with room on both sides.
const PORT = 8463;
const PORT_NOWIN = 8464;  // the same hub with ERA_FAKE_KIOSK_WINDOW=0
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_NOWIN = `http://127.0.0.1:${PORT_NOWIN}`;
const SCRATCH = process.env.ERA_TEST_TMP || os.tmpdir();
const SKIP = "# 49155 busy — engine stand-in skipped";

let child, childNoWin, engine = null, portFree = false;
let hits = [];   // every request the stand-in engine saw, "METHOD /path"
let configBroken = false;   // flipped by the "engine won't say where TD Snap lives" leg

function mkTmp(tag) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, "era-kiosk-pause-" + tag + "-"));
}

function startHub(port, extraEnv) {
  return spawn("node", ["server.js", String(port)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"],
    // the hub builds outfits on its own timers and that build reads the
    // weather: both lookups point at a dead loopback port so nothing here
    // can reach the internet.
    env: { ...process.env, ERA_BIND: "127.0.0.1",
           ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
           ...extraEnv },
  });
}

async function waitUp(base) {
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${base}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up: " + base);
}

// the stand-in ERAgaze: /status so the hub believes an engine is on the bus,
// /config so the pause door learns where TD Snap lives, and a recorder for
// the /app/park the pause is supposed to post.
function startEngine() {
  return new Promise((resolve) => {
    const s = http.createServer((q, r) => {
      hits.push(q.method + " " + q.url);
      q.resume();
      if (q.method === "GET" && q.url === "/config") {
        // an engine that is up but will not read its own config file
        if (configBroken) { r.writeHead(500, { "Content-Type": "text/plain" }); r.end("no"); return; }
        r.writeHead(200, { "Content-Type": "application/json" });
        r.end(JSON.stringify({ ForegroundApp: "shell:AppsFolder\\Fake!App" }));
        return;
      }
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end("{}");
    });
    s.once("error", () => resolve(null));
    s.listen(49155, "127.0.0.1", () => resolve(s));
  });
}

const pause = (base, body, type = "application/json") =>
  fetch(`${base}/kiosk/pause`, { method: "POST", headers: { "Content-Type": type }, body });
const resume = (base, body, type = "application/json") =>
  fetch(`${base}/kiosk/resume`, { method: "POST", headers: { "Content-Type": type }, body });
const settle = () => new Promise(r => setTimeout(r, 250));

before(async () => {
  child = startHub(PORT, { ERA_DATA_DIR: mkTmp("a") });
  childNoWin = startHub(PORT_NOWIN, { ERA_DATA_DIR: mkTmp("b"), ERA_FAKE_KIOSK_WINDOW: "0" });
  await waitUp(BASE);
  await waitUp(BASE_NOWIN);
  // probe 49155 once, then let go of it again: the first test needs the bus
  // EMPTY, and a real engine on this machine means every engine leg skips.
  const probe = await startEngine();
  portFree = !!probe;
  if (probe) await new Promise(r => { probe.closeAllConnections?.(); probe.close(r); });
  hits = [];
});

after(() => {
  if (engine) { engine.closeAllConnections?.(); engine.close(); }
  if (child) child.kill("SIGKILL");
  if (childNoWin) childNoWin.kill("SIGKILL");
});

// ---- with no engine on the bus there is nowhere to pause TO -----------------
// The door goes home on a VM or a dev browser, and home lives in the same
// kiosk window — so pause is meaningless and says so. The apps never mount 💬
// in that case (§5); this leg is the belt for a stray POST.
test("no engine on the bus: pause answers home and remembers nothing", async () => {
  if (!portFree) { console.log(SKIP); return; }
  const s = await (await fetch(`${BASE}/settings`)).json();
  assert.equal(s.doorGoes, "home", "no engine: the door goes home");
  assert.equal(s.pauseGoes, "home", "pauseGoes tracks doorGoes");

  const r = await pause(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { action: "home" });

  // nothing was remembered, so her tile still launches the app fresh
  const r2 = await resume(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  assert.equal(r2.status, 409);
  assert.deepEqual(await r2.json(), { action: "launch" });
});

test("pause without a path is a 400 (nothing to come back to)", async () => {
  for (const body of ["{}", JSON.stringify({ path: "" }), JSON.stringify({ path: "   " }), "not json"]) {
    const r = await pause(BASE, body);
    assert.equal(r.status, 400, "no path: " + body);
  }
});

// ---- from here on a stand-in engine holds 49155 -----------------------------
test("engine on the bus: pauseGoes flips to tdsnap and pause parks + answers paused", async () => {
  if (!portFree) { console.log(SKIP); return; }
  engine = await startEngine();
  if (!engine) { console.log(SKIP); return; }

  const s = await (await fetch(`${BASE}/settings`)).json();
  assert.equal(s.doorGoes, "tdsnap");
  assert.equal(s.pauseGoes, "tdsnap", "pauseGoes is doorGoes under another name");

  hits = [];
  const r = await pause(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { action: "paused" });
  await settle();
  assert.ok(hits.includes("POST /app/park"),
    "the app's park override is dropped while she is in TD Snap: " + JSON.stringify(hits));
  assert.ok(hits.includes("GET /config"),
    "where TD Snap lives is read from the engine, not hard-coded: " + JSON.stringify(hits));
  assert.equal(hits.some(h => h.startsWith("POST /app/exit")), false,
    "pause never asks the engine to CLOSE the app — that is the 🚪");
});

// The /config read is a nicety, not a precondition: it only chooses WHICH app
// to raise, and there is a hard-coded TD Snap fallback for when the engine will
// not say. An engine that answers /status but 500s /config (a hand-edited
// ERAgaze.json — the 9/11 school cutover shipped one with a trailing comma)
// must still get her to her talker, and must still drop the park override, or
// the app she left keeps the gaze cursor while she is trying to talk.
test("engine refuses /config: pause still parks and still answers paused", async () => {
  if (!engine) { console.log(SKIP); return; }
  configBroken = true;
  try {
    hits = [];
    const r = await pause(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { action: "paused" });
    await settle();
    assert.ok(hits.includes("GET /config"), "it did ask: " + JSON.stringify(hits));
    assert.ok(hits.includes("POST /app/park"),
      "the park override is dropped even when /config fails: " + JSON.stringify(hits));
  } finally { configBroken = false; }
  // and the pause it recorded is real: the same app still resumes
  const back = await resume(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  assert.equal(back.status, 200);
  assert.deepEqual(await back.json(), { action: "resumed" });
});

test("resume of the same app comes back, trailing slash and case and all", async () => {
  if (!engine) { console.log(SKIP); return; }
  await pause(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  const r = await resume(BASE, JSON.stringify({ path: "/BOARD?recipe=songs" }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { action: "resumed" });

  // and it is spent: the window is already in front, a second tile press launches
  const r2 = await resume(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  assert.equal(r2.status, 409);
  assert.deepEqual(await r2.json(), { action: "launch" });

  // the Reader's two spellings are the same app too
  await pause(BASE, JSON.stringify({ path: "/reader/" }));
  assert.equal((await resume(BASE, JSON.stringify({ path: "/reader" }))).status, 200);
});

test("a DIFFERENT app refuses and forgets: that launch kills the paused kiosk", async () => {
  if (!engine) { console.log(SKIP); return; }
  await pause(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  const r = await resume(BASE, JSON.stringify({ path: "/board/?recipe=movies" }));
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { action: "launch" });

  // Songs is gone with it — the bat that got the 409 has wmic'd the kiosk
  const r2 = await resume(BASE, JSON.stringify({ path: "/board/?recipe=songs" }));
  assert.equal(r2.status, 409);
});

// start-hub.bat sends the bare path as text/plain: %OPEN% carries ? and =,
// and quoting it into JSON inside a .bat is exactly the fragile thing the
// Music/Movies icons taught us not to do.
test("resume takes a raw text body as well as JSON", async () => {
  if (!engine) { console.log(SKIP); return; }
  await pause(BASE, JSON.stringify({ path: "/pencil/" }));
  const r = await resume(BASE, "/pencil/\r\n", "text/plain");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { action: "resumed" });
});

test("the 🚪 forgets the pause: exit then a tile press launches fresh", async () => {
  if (!engine) { console.log(SKIP); return; }
  await pause(BASE, JSON.stringify({ path: "/reader/" }));
  await fetch(`${BASE}/kiosk/exit`, { method: "POST" });
  const r = await resume(BASE, JSON.stringify({ path: "/reader/" }));
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { action: "launch" });
});

// Somebody closed the kiosk by hand while she was talking: the path matches
// but there is no window to bring forward, so the bat must launch.
test("paused app whose window has gone: 409 launch", async () => {
  if (!engine) { console.log(SKIP); return; }
  const r0 = await pause(BASE_NOWIN, JSON.stringify({ path: "/reader/" }));
  assert.deepEqual(await r0.json(), { action: "paused" }, "it pauses normally");
  const r = await resume(BASE_NOWIN, JSON.stringify({ path: "/reader/" }));
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { action: "launch" });
  // and it was forgotten, so a retry does not keep trying a dead window
  assert.equal((await resume(BASE_NOWIN, JSON.stringify({ path: "/reader/" }))).status, 409);
});
