// clothing-schedule.test.mjs — the shared gate hub's clothing schedule seam
// (gate-speed plan 1.3a).
//
// A hub starts the Clothing Picker with two timers: a build 20 s after boot
// ("the computer just woke up") and a check every 15 minutes. On the gate's
// shared hub those builds ran at moments no suite chose, and a build can
// rewrite recipes/today.json (and flip its ETag) under the board suites reading
// it: the one shared mutable thing a lane scheduler cannot see.
// ERA_CLOTHING_TICK_MS=0 starts the module with no schedule (clothing.start's
// noTimers), and the gate builds the board once, awaited, before the first
// suite (tools/era-gate.sh gate_build_clothing).
// Unset, as on every family's hub, the schedule is unchanged.
//
// One hub at a time on 8425: unclaimed in all five repos' tests/ on 10/26 (the
// three free ports left in 8390-8479 were 8425, 8465 and 8470) and nothing
// listening. No key, no network: every provider seam is closed.
//
// The 20 s itself has a suite's seam, ERA_CLOTHING_BOOT_MS (clothing.js
// start(); unset, as on every family's hub and in the gate, it is 20000). The
// absence case boots with it at 1 s, so the timer it proves absent would have
// fired 1 s in rather than 20 s in; the second case is the control that the
// seam really moves the startup build — without it a seam that did nothing
// would let the shortened absence check pass for the wrong reason.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8425;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-clo-sched-"));
const DATA = path.join(TMP, "data");
const DRIVE = path.join(TMP, "drive");
const RECIPE = path.join(DATA, "recipes", "today.json");
const STARTUP_TICK_MS = 1000;               // ERA_CLOTHING_BOOT_MS: the "just woke up" build, moved from 20 s
const BUILT = /\[clothing\] building today's board \(([^)]*)\)/;
let child = null, out = "", readyAt = 0;

const SEAMS = {
  ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_GEOCODE_URL: "http://127.0.0.1:1/geocode", ERA_NWS_URL: "http://127.0.0.1:1",
  ERA_RESEND_URL: "http://127.0.0.1:1", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_AI_URL: "http://127.0.0.1:1",
  ERA_SYMBOL_SEARCH_URL: "http://127.0.0.1:1/search/",
  ERA_SYMBOL_IMAGE_URL: "http://127.0.0.1:1/images/{id}.png",
  ERA_BIND: "127.0.0.1",
};
const status = async () => (await fetch(`${BASE}/clothing/status`, { cache: "no-store" })).json();
async function until(what, ok, ms) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (await ok()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for " + what);
}

// Two catalogued garments and no board yet, so any tick that runs deals one;
// and an empty family folder, so a Drive sync can ask for that tick by hand
// (drive.onSynced -> tick).
async function boot(dataDir, extra) {
  materialize({ dataDir, n: 2 });
  fs.mkdirSync(DRIVE, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "drive.json"), JSON.stringify({ mode: "local", folderPath: DRIVE }));
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: dataDir, ERA_CLOTHING_BOOT_MS: String(STARTUP_TICK_MS), ...extra };
  delete env.ERA_DEVICE_ID;
  out = "";
  child = spawn(process.execPath, ["server.js", String(PORT)], { cwd: HUB, stdio: ["ignore", "pipe", "inherit"], env });
  child.stdout.on("data", (b) => { out += b; });
  const me = child;
  for (let i = 0; i < 200; i++) {
    if (me.exitCode !== null) throw new Error("hub exited during startup");
    try { await fetch(`${BASE}/settings`); readyAt = Date.now(); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
}
async function stopHub() {
  if (!child || child.exitCode !== null) return;
  const me = child;
  me.kill("SIGKILL");
  await new Promise(r => me.once("exit", r));
  child = null;
}

before(() => boot(DATA, { ERA_CLOTHING_TICK_MS: "0" }));
after(async () => { await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("ERA_CLOTHING_TICK_MS=0: no build after boot, yet a tick that is asked for still builds", async () => {
  // The startup timer is armed in the listen callback, before /settings first
  // answered, so by now it is at least 1.5 s overdue if it was armed at all.
  await new Promise(r => setTimeout(r, Math.max(0, readyAt + STARTUP_TICK_MS + 1500 - Date.now())));
  assert.doesNotMatch(out, BUILT, "the hub built on its own schedule");
  assert.equal((await status()).building, false);
  assert.equal(fs.existsSync(RECIPE), false, "and no board was written");

  // The control: on this data dir a tick DOES build, so the silence above was
  // the schedule's absence and not a board the tick would have left alone.
  await fetch(`${BASE}/integrations/drive/sync`, { method: "POST" });
  await until("the tick the sync asked for", () => BUILT.test(out), 10000);
  assert.match(out.match(BUILT)[1], /drive sync/, "built because the sync asked, not on a timer");
  await until("the build to finish", async () => !(await status()).building, 60000);
  assert.ok(fs.existsSync(RECIPE), "today's board was written");
});

// The control for the case above: without ERA_CLOTHING_TICK_MS=0 the same seam
// really does bring the startup build forward — well before the family's 20 s.
// A fresh data dir: the board the case above wrote is fresh, and a tick leaves
// a fresh board alone.
test("ERA_CLOTHING_BOOT_MS moves the startup build; unset it is 20 s", async () => {
  await stopHub();
  await boot(path.join(TMP, "data-control"), {});
  await until("the startup build", () => BUILT.test(out), 10000);
  assert.match(out.match(BUILT)[1], /startup\/wake/, "built by the startup timer");
  assert.ok(Date.now() - readyAt < 10000, "inside the seam's 1 s, not the family's 20 s");
  const src = fs.readFileSync(path.join(HUB, "clothing.js"), "utf8");
  assert.match(src, /setTimeout\(\(\) => tick\("startup\/wake"\), Number\(process\.env\.ERA_CLOTHING_BOOT_MS\) \|\| 20 \* 1000\)\.unref\(\);/,
    "unset, 0 or not a number: the family's 20 s");
});
