// clothing-sync-rebuild.test.mjs — ONE deal a day (spec §1 V4, §3.5).
//
// Until now `drive.onSynced` called `clothing.regenerate(true)`, so the board
// was re-dealt on every sync — every ten minutes in local mode. The
// least-recently-shown signal collapsed within the hour and the lineup flipped
// all day. It is now `clothing.tick()`, which acts only when the photos really
// changed, the board predates this morning's cutoff, or a photo is still
// waiting to be named.
//
// That is also the property that LICENSES the shared log: another device's
// picks, offers and tags arrive through the very same sync, and they must
// change nothing today. They count tomorrow — which is exactly what the
// original did.
//
// Hub on 8460 (plan §B). No key, no network: every provider seam points at a
// closed port and the wardrobe is synthetic and already catalogued.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { materialize } from "./synthetic-wardrobe.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(HUB, "server.js"));
const { dayKey } = require("./clothing-rank.js");
const PORT = 8460;                       // plan §B
const BASE = `http://127.0.0.1:${PORT}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-syncreb-"));
const DATA = path.join(TMP, "data");
const DRIVE = path.join(TMP, "drive");
const RECIPE = path.join(DATA, "recipes", "today.json");
const TODAY = dayKey(Date.now(), "UTC");
let child;

// Every provider seam at a closed port: no suite may spend a key, and a hub
// reaches out on its own (the weather, at least) if you let it.
const SEAMS = {
  ERA_ELEVEN_URL: "http://127.0.0.1:1", ERA_FAL_URL: "http://127.0.0.1:1",
  ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
  ERA_RESEND_URL: "http://127.0.0.1:1", ERA_TMDB_URL: "http://127.0.0.1:1",
  ERA_STREAMING_URL: "http://127.0.0.1:1", ERA_AI_URL: "http://127.0.0.1:1",
  ERA_BIND: "127.0.0.1",
};

const status = async () => (await fetch(`${BASE}/clothing/status`)).json();
// A build settles in stages: POST /clothing/regenerate syncs first (which can
// queue a tick's build) and then runs its own, so "not building" has to hold
// twice with a gap — a single check catches the pause between two builds.
async function idle(tries = 120) {
  for (let round = 0; round < 2; round++) {
    let ok = false;
    for (let i = 0; i < tries; i++) {
      if (!(await status()).building) { ok = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(ok, "the hub settled");
    if (round === 0) await new Promise(r => setTimeout(r, 2500));
  }
}
const sync = () => fetch(`${BASE}/integrations/drive/sync`, { method: "POST" });
const line = (o) => JSON.stringify(o) + "\n";
function deliverToDrive(rel, body) {
  const f = path.join(DRIVE, "clothing", ".era", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

before(async () => {
  // A small wardrobe on purpose: this suite is about whether a build happens
  // at all, not about how many looks it deals.
  fs.mkdirSync(path.join(DRIVE, "clothing"), { recursive: true });
  materialize({ dataDir: DATA, n: 6, driveFolder: DRIVE });
  fs.writeFileSync(path.join(DATA, "drive.json"),
    JSON.stringify({ mode: "local", folderPath: DRIVE }));
  const env = { ...process.env, ...SEAMS, ERA_DATA_DIR: DATA };
  delete env.ERA_DEVICE_ID;              // this hub names itself (T4.1)
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "inherit", "inherit"], env,
  });
  for (let i = 0; i < 200; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});
after(() => { if (child) child.kill("SIGKILL"); fs.rmSync(TMP, { recursive: true, force: true }); });

test("the wardrobe is catalogued and the first board is dealt", async () => {
  await fetch(`${BASE}/clothing/regenerate`, { method: "POST" });
  await idle();
  const s = await status();
  assert.equal(s.cataloged, 6, "six synthetic garments, no AI key needed");
  assert.ok(fs.existsSync(RECIPE), "today's board exists");
});

// The property this whole phase rests on: the mirror carries other devices'
// lines in, and today's board does not move.
test("log-only changes arriving on a sync never rebuild today's board", async () => {
  const before = { mtime: fs.statSync(RECIPE).mtimeMs, bytes: fs.readFileSync(RECIPE) };

  await sync();                       // a sync with nothing new at all
  await idle();
  assert.equal(fs.statSync(RECIPE).mtimeMs, before.mtime, "an empty sync deals nothing");

  // now the interesting half: another device's picks and offers land
  deliverToDrive(`picks/dev-b/${TODAY}.jsonl`,
    line({ t: new Date().toISOString(), kind: "yes", combo: ["item_aaaa", "item_bbbb"] }));
  deliverToDrive(`offers/dev-b/${TODAY}.jsonl`,
    line({ t: new Date().toISOString(), band: null, page1: [["item_aaaa", "item_bbbb"]] }));
  await sync();
  await idle();

  assert.equal(fs.statSync(RECIPE).mtimeMs, before.mtime, "today's board was not re-dealt");
  assert.ok(before.bytes.equals(fs.readFileSync(RECIPE)), "…and is byte-identical");
  // …and the lines really did arrive: the assertion above would pass just as
  // well if the mirror had ignored them entirely.
  for (const rel of [`picks/dev-b/${TODAY}.jsonl`, `offers/dev-b/${TODAY}.jsonl`])
    assert.ok(fs.existsSync(path.join(DATA, "clothing", ".era", rel)),
      rel + " was mirrored onto this device");
});

test("a photo added to the Drive folder does rebuild the board", async () => {
  const before = fs.statSync(RECIPE).mtimeMs;
  fs.copyFileSync(path.join(DRIVE, "clothing", "g01.jpg"), path.join(DRIVE, "clothing", "g99.jpg"));
  await sync();
  await idle();
  assert.notEqual(fs.statSync(RECIPE).mtimeMs, before, "a wardrobe that changed is a board that changes");
});
