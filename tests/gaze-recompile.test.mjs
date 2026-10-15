// gaze-recompile.test.mjs — a self-update that ships a newer ERAgaze.cs must
// reach the exe. Found on both home devices 9/27: v0.36.0 shipped the folder
// migration + rename in the engine's source, but the boot reconcile only ever
// called installGaze() for an engine that was NOT compiled yet, so both kept
// running the 9/14 binary. The hub now keeps the sha256 of the source each exe
// was built from beside it (gaze/ERAgaze.exe.src-sha256) and recompiles at
// boot when the shipped source differs. csc is stubbed through ERA_GAZE_CSC
// (the same seam lets the Windows-only path run here).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8476;      // 8475 = settings-ui; 8471-8474 held elsewhere
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "era-gazerc-"));
const INSTALL = path.join(TMP, "install");
const DATA = path.join(TMP, "data");
const GAZE = path.join(INSTALL, "gaze");
const SRC = path.join(GAZE, "ERAgaze.cs");
const EXE = path.join(GAZE, "ERAgaze.exe");
const HASH = path.join(GAZE, "ERAgaze.exe.src-sha256");
const CALLS = path.join(TMP, "csc-calls.log");
const CSC = path.join(TMP, "csc-stub.sh");
let child, log = "";

// build-payload.sh's module list, as reconcile.test.mjs reads it
const HUB_MODULES = [...fs.readFileSync(path.join(HUB, "tools", "build-payload.sh"), "utf8")
  .matchAll(/"\$HUB\/([A-Za-z0-9._-]+\.(?:json|js))"/g)].map(m => m[1]);

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const cscCalls = () => { try { return fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

function boot() {
  log = "";
  child = spawn("node", ["server.js", String(PORT)], {
    cwd: INSTALL, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ERA_DATA_DIR: DATA, ERA_BIND: "127.0.0.1", ERA_NO_UPDATE: "1",
           ERA_UPDATE_URL: "http://127.0.0.1:9", ERA_GAZE_CSC: CSC },
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  return (async () => {
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${BASE}/settings`); return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("hub never came up");
  })();
}
const stop = () => new Promise((r) => { if (!child || child.exitCode !== null) return r(); child.once("exit", r); child.kill("SIGKILL"); });
// boot, then wait out the +5 s boot reconcile and whatever it logs
async function bootAndReconcile(until) {
  await boot();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (i >= 12 && (!until || until.test(log))) break;
  }
}

before(() => {
  fs.mkdirSync(path.join(INSTALL, "public", "home"), { recursive: true });
  for (const f of HUB_MODULES) fs.copyFileSync(path.join(HUB, f), path.join(INSTALL, f));
  fs.copyFileSync(path.join(HUB, "public", "home", "index.html"), path.join(INSTALL, "public", "home", "index.html"));
  fs.writeFileSync(path.join(INSTALL, "VERSION"), "20200101.0000\n");
  fs.mkdirSync(GAZE, { recursive: true });
  fs.writeFileSync(path.join(GAZE, "tobii_stream_engine.dll"), "stand-in");   // no runtime hunt
  fs.writeFileSync(SRC, "// engine v1\n");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "profile.json"), JSON.stringify({ childName: "Maya" }));
  fs.writeFileSync(path.join(DATA, "apps.json"), JSON.stringify({ enabled: ["eragaze"] }));
  // the stub compiler: the "exe" is a no-op script carrying its source; a
  // source containing BROKEN fails the way csc does (non-zero, message on stdout)
  fs.writeFileSync(CSC, `#!/bin/sh
out=""; src=""
for a in "$@"; do case "$a" in /out:*) out="\${a#/out:}";; *.cs) src="$a";; esac; done
echo "$out" >> "${CALLS}"
if grep -q BROKEN "$src"; then echo "ERAgaze.cs(1,1): error CS1002: ; expected"; exit 1; fi
{ echo "#!/bin/sh"; echo "exit 0"; sed 's/^/# /' "$src"; } > "$out"; chmod +x "$out"
`);
  fs.chmodSync(CSC, 0o755);
});
after(async () => { await stop(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("(a) a fresh install compiles the engine and records the source hash", async () => {
  await bootAndReconcile(/\[gaze\] installed|reconcile eragaze/);
  assert.equal(cscCalls(), 1, log);
  assert.ok(fs.existsSync(EXE), log);
  assert.match(fs.readFileSync(EXE, "utf8"), /engine v1/);
  assert.equal(fs.readFileSync(HASH, "utf8").trim(), sha(SRC));
  assert.match(log, /\[gaze\] installed/, log);
});

test("(b) an exe whose recorded hash matches the source is left alone — even when the source was touched", async () => {
  await stop();
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(SRC, later, later);      // an overlay copy resets mtimes; that alone is no change
  await bootAndReconcile();
  assert.equal(cscCalls(), 1, "no recompile — " + log);
  assert.doesNotMatch(log, /\[gaze\]|reconcile eragaze/, log);
});

test("(c) a changed source recompiles, swaps the exe in and rewrites the hash (9/27)", async () => {
  await stop();
  const past = new Date(Date.now() - 3600_000);
  fs.writeFileSync(SRC, "// engine v2 — folder migration + rename\n");
  fs.utimesSync(SRC, past, past);        // older than the exe: an mtime check would skip it
  await bootAndReconcile(/reconcile(d)? eragaze/);
  assert.equal(cscCalls(), 2, log);
  assert.match(fs.readFileSync(EXE, "utf8"), /engine v2/, log);
  assert.equal(fs.readFileSync(HASH, "utf8").trim(), sha(SRC));
  assert.match(log, /\[gaze\] shipped source changed/, log);
  assert.match(log, /\[gaze\] recompiled from updated source/, log);
  assert.ok(!fs.existsSync(path.join(GAZE, "ERAgaze.new.exe")), "no staged build left behind");
});

test("(d) a failed compile keeps the old exe and its hash, and says why", async () => {
  await stop();
  const before = sha(EXE), beforeHash = fs.readFileSync(HASH, "utf8");
  fs.writeFileSync(SRC, "// engine v3 BROKEN\n");
  await bootAndReconcile(/reconcile eragaze/);
  assert.equal(cscCalls(), 3, log);
  assert.equal(sha(EXE), before, "the working engine is untouched");
  assert.equal(fs.readFileSync(HASH, "utf8"), beforeHash, "hash still names the build on disk");
  assert.match(log, /reconcile eragaze: compile failed: .*CS1002/, log);
});
