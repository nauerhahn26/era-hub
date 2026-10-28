// POST /buttons/press on a real hub (button press to ask, design 2026-10-27
// §4.2; plan T1.3, T1.5). The device listener posts a press; the hub decides:
// a visible Chat page gets `ask` on its command stream, a hidden one is
// foregrounded first, and with no page listening the kiosk is relaunched at
// /chat/?ask=<nonce> (off Windows the relaunch is only logged, "relaunch
// (would) ...", which is how this suite reads the nonce). Chat off is 409. The
// route is loopback only and counts as activity.
//
// Shape of kiosk-pause.test.mjs: a real hub child, then the same port again
// with ERA_FAKE_KIOSK_WINDOW=0 ("no kiosk window to bring back") bound to
// 0.0.0.0 so a press from this machine's own LAN address proves the gate. That
// hub runs with ERA_NO_UPDATE=1 and off Windows a press only logs, so being
// reachable for those seconds changes nothing on this machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PORT: 8470. The plan named 8494/8495, but suite-ports reserves 8480 and up
// (push-device feeds, device tunnels); on 10/28 the free suite ports across
// all five repos' tests/ were 8465 (held by a clothing-accessories note) and
// 8470, and 8471/8472 have listeners on the build host. So one port, and the
// two hubs run one after the other.
const PORT = 8470;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.ERA_TEST_TMP || os.tmpdir();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 4000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await pause(10); } };

let hub = null;
function startHub(data, extraEnv = {}) {
  const child = spawn("node", ["server.js", String(PORT)], {
    cwd: HUB, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ERA_BIND: "127.0.0.1", ERA_DATA_DIR: data, ERA_NO_UPDATE: "1",
           ERA_UPDATE_URL: "http://127.0.0.1:1", ERA_GEO_URL: "http://127.0.0.1:1/geo", ERA_WEATHER_URL: "http://127.0.0.1:1",
           ...extraEnv },
  });
  child.out = "";
  child.stdout.on("data", (b) => { child.out += b; });
  return child;
}
async function waitUp() {
  for (let i = 0; i < 150; i++) { try { await fetch(`${BASE}/settings`); return; } catch {} await pause(100); }
  throw new Error("hub never came up on " + PORT);
}
async function stopHub() {
  if (!hub) return;
  const child = hub; hub = null;
  if (child.exitCode === null) { const gone = new Promise((r) => child.once("exit", r)); child.kill("SIGTERM"); await gone; }
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/settings`); } catch { return; } await pause(100); }
}
function dataDir(tag, enabled) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "era-buttons-press-" + tag + "-"));
  fs.writeFileSync(path.join(dir, "apps.json"), JSON.stringify({ enabled }));
  return dir;
}
const press = (body, base = BASE) => fetch(`${base}/buttons/press`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body) });
const status = async () => (await (await fetch(`${BASE}/status`)).json()).buttons;
const visibility = (visible) => fetch(`${BASE}/chat/api/commands/visibility`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visible }) });

// The Chat page's command stream, as the page will open it.
const pages = [];
async function page(query = "") {
  const response = await fetch(`${BASE}/chat/api/commands${query}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const p = { raw: "", events: [], close: () => reader.cancel().catch(() => {}) };
  pages.push(p);
  (async () => { let pending = ""; try { while (true) { const { value, done } = await reader.read(); if (done) break; const text = decoder.decode(value, { stream: true });
    p.raw += text; pending += text;
    let cut; while ((cut = pending.indexOf("\n\n")) >= 0) { const block = pending.slice(0, cut); pending = pending.slice(cut + 2);
      if (block.startsWith("data: ")) { const e = JSON.parse(block.slice(6)); if (e.type !== "ping") p.events.push(e); } } } } catch {} })();
  await until(() => p.raw.includes(": connected"));
  return p;
}
const closePages = async () => { for (const p of pages.splice(0)) await p.close(); await pause(50); };
const relaunchNonces = () => [...hub.out.matchAll(/\[buttons\] relaunch \(would\) .*?--kiosk http:\/\/127\.0\.0\.1:\d+\/chat\/\?ask=([0-9a-f]{16}) /g)].map((m) => m[1]);

let DATA;
before(async () => { DATA = dataDir("a", ["chat"]); hub = startHub(DATA); await waitUp(); });
after(async () => { await closePages(); await stopHub(); });

test("no Chat page listening: the kiosk relaunches at /chat/?ask=<nonce> and the page that connects with it is asked once", async () => {
  const before = Date.now();
  const r = await press({ key: "F13", action: "ask" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, dispatch: "relaunch" });
  await until(() => relaunchNonces().length === 1);
  const [nonce] = relaunchNonces();
  assert.match(hub.out, /--user-data-dir=.*kiosk-profile/, "the relaunch is the kiosk line's");
  const p = await page(`?nonce=${nonce}&visible=1`);
  await until(() => p.events.length === 1);
  assert.equal(p.events[0].type, "ask"); assert.equal(p.events[0].key, "F13"); assert.equal(p.events[0].nonce, nonce);
  assert.ok(p.events[0].pressAt >= before && p.events[0].pressAt <= Date.now());
  const reload = await page(`?nonce=${nonce}&visible=1`);
  await pause(150);
  assert.deepEqual(reload.events, [], "a reload of /chat/?ask=<nonce> never asks again");
  await closePages();
});

test("Chat page connected and visible: ask arrives on its stream", async () => {
  const p = await page("?visible=1");
  const r = await (await press({ key: "Ctrl+Alt+F9", action: "ask" })).json();
  assert.deepEqual(r, { ok: true, dispatch: "visible" });
  await until(() => p.events.length === 1);
  assert.deepEqual([p.events[0].type, p.events[0].key], ["ask", "Ctrl+Alt+F9"]);
  await closePages();
});

test("Chat page hidden: the kiosk is brought forward, the page says it is visible, then ask arrives", async () => {
  const p = await page("?visible=0");
  const answer = press({ key: "Ctrl+Alt+F10" });
  await pause(200);
  assert.equal(p.events.length, 0, "nothing is pushed to a hidden page");
  assert.equal((await visibility(true)).status, 200);
  assert.deepEqual(await (await answer).json(), { ok: true, dispatch: "foreground" });
  await until(() => p.events.length === 1);
  assert.equal(p.events[0].type, "ask");
  await closePages();
});

test("cancel with no window and nothing coming up does nothing", async () => {
  assert.deepEqual(await (await press({ key: "F14", action: "cancel" })).json(), { ok: true, dispatch: "none" });
});

test("an unknown key, a mismatched action or a body that is not JSON is 400", async () => {
  for (const body of [{ key: "F12", action: "ask" }, { key: "F13", action: "cancel" }, "not json", ""]) {
    const r = await press(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test("a press is activity: the hub's idle clock restarts", async () => {
  await pause(400);
  const idleBefore = (await (await fetch(`${BASE}/version`)).json()).idleMs;
  assert.ok(idleBefore >= 400, "quiet for 400 ms: " + idleBefore);
  await press({ key: "F14" });
  const idleAfter = (await (await fetch(`${BASE}/version`)).json()).idleMs;
  assert.ok(idleAfter < 300, "a press is a partner beside her: " + idleAfter);
});

test("Chat turned off: 409 chat-off and nothing is relaunched", async () => {
  fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: [] }));
  const launched = relaunchNonces().length;
  try {
    const r = await press({ key: "F13", action: "ask" });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "chat-off" });
    await pause(100);
    assert.equal(relaunchNonces().length, launched);
  } finally { fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: ["chat"] })); }
});

test("the route is three lines: the loopback gate, the body, buttons.press; it is not in NOT_INTERACTION", () => {
  const src = fs.readFileSync(path.join(HUB, "server.js"), "utf8");
  const at = src.indexOf('urlPath === "/buttons/press"');
  assert.ok(at > 0);
  const body = src.slice(src.indexOf("{", at) + 1, src.indexOf("\n  }\n", at)).split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(body.length, 4, "gate, body + press, answer, return:\n" + body.join("\n"));
  assert.match(body[0], /^if \(!updater\.isLoopback\(req\.socket && req\.socket\.remoteAddress\)\) \{ res\.writeHead\(403\)\.end\(\); return; \}$/);
  assert.match(body[1], /^buttons\.readBody\(req\)\.then\(\(body\) => buttons\.press\(body\)\)$/);
  assert.equal(body[3], "return;");
  const notInteraction = /const NOT_INTERACTION = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
  assert.ok(!notInteraction.includes("/buttons/press"));
});

test("hidden and no kiosk window to bring back: relaunch at once; a press from the LAN is refused", async (t) => {
  await stopHub();
  hub = startHub(dataDir("b", ["chat"]), { ERA_FAKE_KIOSK_WINDOW: "0", ERA_BIND: "0.0.0.0" });
  await waitUp();
  const p = await page("?visible=0");
  const started = Date.now();
  assert.deepEqual(await (await press({ key: "F13" })).json(), { ok: true, dispatch: "relaunch" });
  assert.ok(Date.now() - started < 2500, "no 3 s wait when there is no window to foreground");
  assert.equal(p.events.length, 0);
  await closePages();

  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  const ip = lan.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) || lan[0];
  if (!ip) { t.diagnostic("no non-internal IPv4: the LAN leg is skipped"); return; }
  const presses = relaunchNonces().length;
  const r = await press({ key: "F13", action: "ask" }, `http://${ip}:${PORT}`);
  assert.equal(r.status, 403, "a press from another machine never reaches the dispatcher");
  const spoof = await press({ key: "F13" }, `http://${ip}:${PORT}`).then((x) => x.status);
  assert.equal(spoof, 403);
  const forwarded = await fetch(`http://${ip}:${PORT}/buttons/press`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1", Host: `127.0.0.1:${PORT}` }, body: '{"key":"F13"}' });
  assert.equal(forwarded.status, 403, "headers never buy their way in");
  await pause(100);
  assert.equal(relaunchNonces().length, presses);
});
