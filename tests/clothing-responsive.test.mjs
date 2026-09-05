// clothing-responsive.test.mjs — the hub must stay responsive during a
// clothing build (dad 8/31: while his 20 photos ingested, every page —
// Settings' "Back to apps" included — hung for minutes; the pixel loops ran
// on the hub's event loop). The pipeline now runs in a worker thread; this
// suite pins that: with a deliberately slow AI endpoint stretching the build,
// page requests answer in well under a second.
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
const PORT = 8417;      // 8391-8416 held by sibling suites
const AI_PORT = 8418;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-resp-"));
const require = createRequire(path.join(HUB, "server.js"));
let ai, child;

function makeJpg(file, r, g, b) {
  const jpeg = require("./vendor/jpeg-js");
  const w = 1600, h = 1600;   // big: real decode+scale work per photo
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, jpeg.encode({ data, width: w, height: h }, 90).data);
}

before(async () => {
  // slow AI: 1.5s per answer — a 6-photo ingest is a ~9s+ build window
  ai = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text:
        '{"name":"Test top","category":"top","warmth":"any","rotate_deg":0,"crop":{"x":0,"y":0,"w":1,"h":1}}' }] }));
    }, 1500));
  });
  await new Promise(r => ai.listen(AI_PORT, "127.0.0.1", r));

  fs.mkdirSync(path.join(TMP, "clothing"), { recursive: true });
  for (let i = 0; i < 6; i++) makeJpg(path.join(TMP, "clothing", `p${i}.jpg`), 40 * i, 90, 120);
  fs.writeFileSync(path.join(TMP, "ai-config.json"),
    JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }));

  child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ERA_DATA_DIR: TMP, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_AI_URL: `http://127.0.0.1:${AI_PORT}`,
           // the build reads the weather too: a dead loopback port keeps this
           // suite off the internet (seam added with the 9/5 weather window)
           ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1" },
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/settings`); return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("hub never came up");
});
after(() => { if (child) child.kill("SIGKILL"); if (ai) ai.close(); });

test("pages answer fast while a clothing build is running", async () => {
  // kick the build via the same path Settings uses (saving a key re-triggers)
  await fetch(`${BASE}/ai-key`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "anthropic", apiKey: "sk-test" }) });

  // wait until the worker reports building
  let s = null;
  for (let i = 0; i < 100; i++) {
    s = await (await fetch(`${BASE}/clothing/status`, { cache: "no-store" })).json();
    if (s.building) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(s.building, "build started");

  // while it builds: the exact clicks dad made — home page, settings, status
  let slowest = 0;
  for (let i = 0; i < 10; i++) {
    for (const p of ["/home/", "/settings", "/clothing/status", "/apps"]) {
      const t0 = Date.now();
      const r = await fetch(BASE + p, { cache: "no-store" });
      assert.ok(r.ok, p + " answered");
      slowest = Math.max(slowest, Date.now() - t0);
    }
    await new Promise(r => setTimeout(r, 300));
    const st = await (await fetch(`${BASE}/clothing/status`)).json();
    if (!st.building) break;   // build finished early — we still measured during it
  }
  assert.ok(slowest < 900, `slowest page during build ${slowest}ms — the 8/31 freeze is back if this grows`);

  // and the build itself completes into her board
  for (let i = 0; i < 240; i++) {
    const st = await (await fetch(`${BASE}/clothing/status`)).json();
    if (!st.building && st.cataloged >= 6) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const fin = await (await fetch(`${BASE}/clothing/status`)).json();
  assert.equal(fin.cataloged, 6, "all photos cataloged by the worker");
});
