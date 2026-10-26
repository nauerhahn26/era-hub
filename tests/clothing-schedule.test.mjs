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
// One hub on 8425: unclaimed in all five repos' tests/ on 10/26 (the three
// free ports left in 8390-8479 were 8425, 8465 and 8470) and nothing listening.
// An absence of a 20 s timer cannot be shown in less than 20 s, so the case
// waits that long once. No key, no network: every provider seam is closed.
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
const STARTUP_TICK_MS = 20 * 1000;          // clothing.js start(): the "just woke up" build
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

before(async () => {
  // Two catalogued garments and no board yet, so any tick that runs deals one;
  // and an empty family folder, so a Drive sync can ask for that tick by hand
  // (drive.onSynced -> tick).
  materialize({ dataDir: DATA, n: 2 });
  fs.mkdirSync(DRIVE, { recursive: true });
  fs.writeFileSync(path.join(DATA, "drive.json"), JSON.stringify({ mode: "local", folderPath: DRIVE }));
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: DATA, ERA_CLOTHING_TICK_MS: "0" };
  delete env.ERA_DEVICE_ID;
  child = spawn(process.execPath, ["server.js", String(PORT)], { cwd: HUB, stdio: ["ignore", "pipe", "inherit"], env });
  child.stdout.on("data", (b) => { out += b; });
  const me = child;
  for (let i = 0; i < 200; i++) {
    if (me.exitCode !== null) throw new Error("hub exited during startup");
    try { await fetch(`${BASE}/settings`); readyAt = Date.now(); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});
after(() => { if (child) child.kill("SIGKILL"); fs.rmSync(TMP, { recursive: true, force: true }); });

test("ERA_CLOTHING_TICK_MS=0: no build 20 s after boot, yet a tick that is asked for still builds", async () => {
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
