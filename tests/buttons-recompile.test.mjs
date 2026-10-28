// buttons-recompile.test.mjs: the hub compiles and keeps the device button
// listener (button press to ask, design 2026-10-27 §4.1; plan T5.2, T5.6),
// shaped like gaze-recompile.test.mjs. A real hub runs from a copy of the
// payload's modules with buttons/EraButtons.cs beside them; csc is stubbed
// through ERA_BUTTONS_CSC (the seam that lets the Windows-only path run here). The stub's "exe" is a shell script that
// prints the listener's registration line and leaves when the hub's pid is
// gone, as the real one does.
//
// Port: kernel-assigned (suite-ports reserves 8480+, and 8470 is
// buttons-press's), so this suite claims no fixed port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = process.env.ERA_TEST_TMP || os.tmpdir();
fs.mkdirSync(SCRATCH, { recursive: true });
const TMP = fs.mkdtempSync(path.join(SCRATCH, "era-buttons-rc-"));
const INSTALL = path.join(TMP, "install");
const DATA = path.join(TMP, "data");
const DIR = path.join(INSTALL, "buttons");
const SRC = path.join(DIR, "EraButtons.cs");
const EXE = path.join(DIR, "EraButtons.exe");
const HASH = path.join(DIR, "EraButtons.exe.src-sha256");
const CALLS = path.join(TMP, "csc-calls.log");
const CSC = path.join(TMP, "csc-stub.sh");
const LISTENER = path.join(TMP, "listener-stub.sh");
const ALL = ["F13", "F14", "Ctrl+Alt+F9", "Ctrl+Alt+F10", "Ctrl+Alt+F11"];
let PORT, BASE, child, log = "";

// build-payload.sh's module list, as gaze-recompile.test.mjs reads it
const HUB_MODULES = [...fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8")
  .matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.(?:json|js))"/g)].map(m => m[1]);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const status = async () => (await (await fetch(`${BASE}/status`)).json()).buttons;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function until(check, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what + "\n" + log); await pause(50); }
}

function boot() {
  log = "";
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_UPDATE_URL: "http://127.0.0.1:9", ERA_GEO_URL: "http://127.0.0.1:9/geo", ERA_WEATHER_URL: "http://127.0.0.1:9",
           ERA_SYMBOL_SEARCH_URL: "http://127.0.0.1:9/", ERA_SYMBOL_IMAGE_URL: "http://127.0.0.1:9/{id}",
           ERA_RECONCILE_DELAY_MS: "300", ERA_BUTTONS_POLL_MS: "200",
           ERA_BUTTONS_CSC: CSC },
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  return until(async () => { try { await fetch(`${BASE}/settings`); return true; } catch { return false; } }, 15000, "the hub");
}
const stop = () => new Promise((r) => { if (!child || child.exitCode !== null) return r(); child.once("exit", r); child.kill("SIGKILL"); });
// every state /status.buttons passes through until `done` says stop
async function watchStates(done, ms = 10000) {
  const seen = [];
  await until(async () => {
    let s; try { s = await status(); } catch { return false; }
    if (seen[seen.length - 1] !== s.state) seen.push(s.state);
    return done(s) && s;
  }, ms, "listener state");
  return seen;
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.mkdirSync(path.join(INSTALL, "public", "home"), { recursive: true });
  for (const f of HUB_MODULES) fs.copyFileSync(path.join(HUB, f), path.join(INSTALL, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"), path.join(INSTALL, "public", "home", "index.html"));
  fs.writeFileSync(path.join(INSTALL, "VERSION"), "20200101.0000\n");
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SRC, "// listener v1\n");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify({ childName: "Maya" }));
  fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: ["chat"] }));
  // the listener stand-in: the registration line, then wait for the hub ($2) to go
  fs.writeFileSync(LISTENER, `#!/bin/sh
echo '${JSON.stringify({ registered: ALL, failed: [] })}'
while kill -0 "$2" 2>/dev/null; do sleep 0.2; done
`);
  // the stub compiler: copies the stand-in and appends the source it was given;
  // a source containing BROKEN fails the way csc does (non-zero, reason on stdout).
  // It takes a moment, so /status can be seen saying "compiling".
  fs.writeFileSync(CSC, `#!/bin/sh
out=""; src=""
for a in "$@"; do case "$a" in /out:*) out="\${a#/out:}";; *.cs) src="$a";; esac; done
echo "$*" >> "${CALLS}"
sleep 0.6
if grep -q BROKEN "$src"; then echo "EraButtons.cs(1,1): error CS1002: ; expected"; exit 1; fi
{ cat "${LISTENER}"; sed 's/^/# /' "$src"; } > "$out"; chmod +x "$out"
`);
  for (const f of [CSC, LISTENER]) fs.chmodSync(f, 0o755);
});
after(async () => { await stop(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("(a) a fresh install compiles the listener, records the source hash, and /status goes compiling → running with five keys", async () => {
  await boot();
  const seen = await watchStates((s) => s.state === "running");
  assert.ok(seen.indexOf("compiling") >= 0 && seen.indexOf("compiling") < seen.indexOf("running"), "states: " + seen.join(" → "));
  const s = await status();
  assert.deepEqual(s.keys, { registered: ALL, failed: [] });
  assert.ok(Number.isInteger(s.pid) && alive(s.pid), "the listener runs as a process: " + s.pid);
  assert.equal(lines(CALLS).length, 1, log);
  assert.match(lines(CALLS)[0], /^\/nologo \/target:winexe \/platform:x64 \/out:.*EraButtons\.new\.exe \/r:System\.Windows\.Forms\.dll .*EraButtons\.cs$/);
  assert.match(fs.readFileSync(EXE, "utf8"), /listener v1/);
  assert.equal(fs.readFileSync(HASH, "utf8").trim(), sha(SRC));
  assert.ok(!fs.existsSync(path.join(DIR, "EraButtons.new.exe")));
  assert.match(log, /\[buttons\] listener compiled/, log);
  assert.match(log, /\[buttons\] listener running: holds F13, F14, Ctrl\+Alt\+F9, Ctrl\+Alt\+F10, Ctrl\+Alt\+F11/, log);
});

test("(a2) no microphone policy is written (decision 16): /status.buttons has no policy field and the hub says nothing of one", async () => {
  const s = await status();
  assert.ok(!("micPolicy" in s) && !("micPolicyError" in s), JSON.stringify(s));
  assert.doesNotMatch(log, /policy/i, log);
});

test("(b) a listener that dies is started again on its ladder, and /status counts it", async () => {
  const first = (await status()).pid;
  process.kill(first, "SIGTERM");
  await until(async () => (await status()).restarts === 1, 5000, "restart counted");
  const s = await until(async () => { const s = await status(); return s.state === "running" && s.pid !== first && s; }, 12000, "running again");
  assert.match(s.lastError, /exited/);
});

test("(c) Chat turned off stops our listener; Chat on again starts it", async () => {
  const pid = (await status()).pid;
  const off = await fetch(`${BASE}/apps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "chat", enabled: false }) });
  assert.ok([200, 204].includes(off.status));
  await until(async () => (await status()).state === "off", 5000, "off");
  await until(() => !alive(pid), 5000, "our listener stopped");
  assert.equal((await status()).pid, null);
  await fetch(`${BASE}/apps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "chat", enabled: true }) });
  await until(async () => (await status()).state === "running", 8000, "running again");
});

test("(d) an exe whose recorded hash matches the source is left alone, even when the source was touched", async () => {
  await stop();
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(SRC, later, later);
  await boot();
  await watchStates((s) => s.state === "running");
  assert.equal(lines(CALLS).length, 1, "no recompile: " + log);
});

test("(e) a changed source recompiles, swaps the exe in and rewrites the hash", async () => {
  await stop();
  const past = new Date(Date.now() - 3600_000);
  fs.writeFileSync(SRC, "// listener v2\n");
  fs.utimesSync(SRC, past, past);
  await boot();
  const seen = await watchStates((s) => s.state === "running");
  assert.ok(seen.includes("compiling"), seen.join(" → "));
  assert.equal(lines(CALLS).length, 2, log);
  assert.match(fs.readFileSync(EXE, "utf8"), /listener v2/);
  assert.equal(fs.readFileSync(HASH, "utf8").trim(), sha(SRC));
  assert.match(log, /\[buttons\] recompiled from updated source/, log);
  assert.ok(!fs.existsSync(path.join(DIR, "EraButtons.new.exe")));
});

test("(f) a failed compile keeps the old exe and its hash, says why once, and the old listener and Chat's press route still work", async () => {
  await stop();
  const before = sha(EXE), beforeHash = fs.readFileSync(HASH, "utf8");
  fs.writeFileSync(SRC, "// listener v3 BROKEN\n");
  await boot();
  await watchStates((s) => s.state === "running" && /compile failed/.test(s.lastError || ""));
  await pause(1500);   // several 200 ms ticks: the same source is not tried again
  assert.equal(lines(CALLS).length, 3, log);
  assert.equal((log.match(/\[buttons\] compile failed: .*CS1002/g) || []).length, 1, log);
  assert.equal(sha(EXE), before, "the working listener is untouched");
  assert.equal(fs.readFileSync(HASH, "utf8"), beforeHash);
  const r = await fetch(`${BASE}/buttons/press`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "F14", action: "cancel" }) });
  assert.deepEqual(await r.json(), { ok: true, dispatch: "none" });
  assert.equal((await status()).lastPress.key, "F14");
});

test("(g) a failed FIRST compile: no listener, state failed, Chat's press route still answers", async () => {
  await stop();
  fs.rmSync(EXE, { force: true }); fs.rmSync(HASH, { force: true });
  await boot();
  const s = await watchStates((s) => s.state === "failed");
  assert.ok(s.includes("compiling"), s.join(" → "));
  const st = await status();
  assert.equal(st.pid, null); assert.match(st.lastError, /compile failed: .*CS1002/);
  assert.equal(fs.existsSync(EXE), false);
  const r = await fetch(`${BASE}/buttons/press`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "F14" }) });
  assert.equal(r.status, 200);
});
