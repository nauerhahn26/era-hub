// apps.test.mjs — app-picker contract (8/29 ruling: install everything, one,
// or a few). GET /apps lists the registry with enabled flags; absent
// data/apps.json = established apps enabled; experimental Chat stays off;
// POST /apps toggles one app and persists the set; unknown ids are refused.
// Shortcut side effects are Windows-only and not exercised here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { shortcutScript } = createRequire(import.meta.url)("../shortcuts.js");

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

test("fresh install: established apps enabled; experimental Chat and the gaze engine stay off", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.ok(apps.length >= 7);
  assert.ok(apps.filter(a => !a.engine && a.id !== "chat").every(a => a.enabled === true));
  assert.equal(apps.find(a => a.id === "chat")?.enabled, false, "Chat requires a deliberate app choice");
  const gaze = apps.find(a => a.id === "eragaze");
  assert.equal(gaze.engine, true);
  assert.equal(gaze.enabled, false, "second engines are never auto-enabled");
  const pencil = apps.find(a => a.id === "pencil");
  assert.equal(pencil.title, "The Pencil");
  assert.equal(pencil.path, "/pencil/");
  assert.equal(apps.find(a => a.id === "math")?.enabled, true, "Math is available on a default install");
  assert.ok(apps.every(a => a.title && a.sub && (a.path || a.engine)));   // engines have no page
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

test("registry exposes installed flags", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.ok(apps.every(a => typeof a.installed === "boolean"));
});

test("wizard setup with an app choice seeds the enabled set", async () => {
  fs.rmSync(path.join(TMP, "apps.json"), { force: true });
  const r = await fetch(`${BASE}/setup`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ childName: "Zoe", dwellMs: 1200, apps: ["board", "music"] }) });
  assert.equal(r.status, 204);
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  assert.deepEqual(apps.filter(a => a.enabled).map(a => a.id).sort(), ["board", "music"]);
});

test("unknown app id or bad body is refused", async () => {
  assert.equal((await fetch(`${BASE}/apps`, { method: "POST",
    body: JSON.stringify({ id: "nope", enabled: true }) })).status, 400);
  assert.equal((await fetch(`${BASE}/apps`, { method: "POST",
    body: JSON.stringify({ id: "pencil", enabled: "yes" }) })).status, 400);
  assert.equal((await fetch(`${BASE}/apps`, { method: "POST", body: "{" })).status, 400);
});

// Drawing (spec 2026-09-30 §1): a CORE app — registered, on wherever no apps.json says otherwise,
// always installed (its files ride with the engine), and never offered a "remove files" button,
// because /apps/delete refuses a core app (plan deviation 1).
test("Drawing is a core app: registered as the spec says, always installed, never removable", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  const d = apps.find(a => a.id === "drawing");
  assert.ok(d, "Drawing is in the registry");
  assert.deepEqual({ title: d.title, sub: d.sub, path: d.path, engine: d.engine, installed: d.installed, icon: d.icon },
    { title: "Drawing", sub: "make a picture with stickers", path: "/drawing/", engine: false, installed: true, icon: "/icons/drawing.png" });
  if (d.enabled) assert.equal((await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "drawing", enabled: false }) })).status, 204);
  const r = await fetch(`${BASE}/apps/delete`, { method: "POST", body: JSON.stringify({ id: "drawing" }) });
  assert.equal(r.status, 400);
  assert.equal(await r.text(), "core app");
  const settings = fs.readFileSync(path.join(HUB, "public", "settings", "index.html"), "utf8");
  const removable = settings.match(/\(a\.engine \|\| (\[[^\]]*\])\.includes\(a\.id\)\)/);
  assert.ok(removable, "Settings' remove-files list is where it was");
  assert.ok(!JSON.parse(removable[1]).includes("drawing"), "no remove-files button for a core app");
});

test("Math is an installed core app with a usable icon and respects the app chooser", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  const math = apps.find(a => a.id === "math");
  assert.ok(math, "Math appears in the home and Settings registry");
  assert.deepEqual({ title: math.title, sub: math.sub, path: math.path, engine: math.engine, installed: math.installed, icon: math.icon },
    { title: "Math", sub: "explore numbers and number partners", path: "/math/", engine: false, installed: true, icon: "/icons/math.png" });
  assert.equal(math.enabled, false, "an existing explicit app choice is preserved");
  const icon = await fetch(`${BASE}${math.icon}`);
  assert.equal(icon.status, 200);
  assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const enable = await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "math", enabled: true }) });
  assert.equal(enable.status, 204);
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "apps.json"), "utf8"));
  assert.ok(onDisk.enabled.includes("math"));
  const disable = await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "math", enabled: false }) });
  assert.equal(disable.status, 204);
  const remove = await fetch(`${BASE}/apps/delete`, { method: "POST", body: JSON.stringify({ id: "math" }) });
  assert.equal(remove.status, 400);
  assert.equal(await remove.text(), "core app");
});

test("Chat is an opt-in installed page with icons and the normal kiosk shortcut", async () => {
  const { apps } = await (await fetch(`${BASE}/apps`)).json();
  const chat = apps.find(a => a.id === "chat");
  assert.ok(chat, "Chat appears in the app chooser");
  assert.deepEqual({ title: chat.title, sub: chat.sub, path: chat.path, engine: chat.engine, installed: chat.installed, icon: chat.icon, enabled: chat.enabled },
    { title: "Chat", sub: "experimental conversation · hold to ask", path: "/chat/", engine: false, installed: true, icon: "/icons/chat.png", enabled: false });
  for (const [ext, signature] of [["png", [137, 80, 78, 71, 13, 10, 26, 10]], ["ico", [0, 0, 1, 0]]]) {
    const icon = await fetch(`${BASE}/icons/chat.${ext}`); assert.equal(icon.status, 200);
    assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(0, signature.length)], signature);
  }
  const enable = await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "chat", enabled: true }) });
  assert.equal(enable.status, 204);
  assert.ok(JSON.parse(fs.readFileSync(path.join(TMP, "apps.json"), "utf8")).enabled.includes("chat"));
  const script = shortcutScript(chat, true, { dir: "C:\\suite", port: PORT, iconFor: () => "C:\\suite\\public\\icons\\chat.ico" });
  assert.ok(script.includes("Chat.lnk")); assert.ok(script.includes("start-hub.bat"));
  assert.ok(script.includes(`${PORT} \"/chat/\"`), "the existing launcher gets Chat's page path for kiosk resume/return");
  assert.ok(script.includes("chat.ico"));
  assert.equal((await fetch(`${BASE}/chat/`)).status, 200);
  const disable = await fetch(`${BASE}/apps`, { method: "POST", body: JSON.stringify({ id: "chat", enabled: false }) });
  assert.equal(disable.status, 204);
  const remove = await fetch(`${BASE}/apps/delete`, { method: "POST", body: JSON.stringify({ id: "chat" }) });
  assert.equal(remove.status, 409); assert.equal(await remove.text(), "pack in use", "Chat's board-pack dependency remains while the other board apps are enabled");
});
