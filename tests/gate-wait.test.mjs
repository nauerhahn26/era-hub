// gate-wait (gate-speed plan phase 4, design 3.3): an agent waits for a gate
// with one blocking call instead of a sleep loop. Every case drives
// tools/gate-wait.sh against a stand-in gate (a bash script named
// tools/era-gate.sh in a temp checkout that writes its own slot, as admission
// does) and a run directory the test completes while the wait is blocked. No
// hub, no port, no real slot directory, store or stamp directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WAIT = path.join(HUB, "tools", "gate-wait.sh");
const TREE = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 1)); };

// The stand-in gate: registers a slot like gate_register_slot, removes it on
// exit like gate_release_slot (unless told it dies uncleanly), and runs until
// its stdin closes.
const STUB = `#!/usr/bin/env bash
read -r stat </proc/$$/stat; rest="\${stat##*) }"; read -r -a f <<<"$rest"
slot="$ERA_GATE_SLOTS/$$"
printf 'pid=%s\\nstart=%s\\nlanes=2\\nat=%s\\nhub=%s\\nisolated=1\\n' "$$" "\${f[19]}" "$(date +%s)" "$CHECKOUT" >"$slot.tmp" && mv -f "$slot.tmp" "$slot"
[ -n "\${GATE_DIES:-}" ] || trap 'rm -f "$slot"' EXIT
echo "== era-gate: lock acquired =="
read -r _ || true
`;

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "era-gate-wait-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = { root, checkout: path.join(root, "era-hub--wt-x"), store: path.join(root, "runs"), slots: path.join(root, "slots"), stamps: path.join(root, "stamps") };
  put(path.join(w.checkout, "tools", "era-gate.sh"), STUB);
  for (const d of [w.store, w.slots, w.stamps]) fs.mkdirSync(d, { recursive: true });
  w.env = { ...process.env, ERA_GATE_SLOTS: w.slots, ERA_GATE_RUNS: w.store, ERA_GATE_STAMPS: w.stamps, CHECKOUT: w.checkout };
  delete w.env.NODE_TEST_CONTEXT;
  return w;
}

// Starts the stand-in with its stdout in a log file, as a detached launch has it.
async function startGate(t, w, extra = {}) {
  const log = fs.openSync(path.join(w.root, "gate.log"), "w");
  const child = spawn("bash", ["tools/era-gate.sh"], { cwd: w.checkout, env: { ...w.env, ...extra }, stdio: ["pipe", log, log] });
  fs.closeSync(log);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(w.slots, String(child.pid))); i++) await sleep(25);
  assert.ok(fs.existsSync(path.join(w.slots, String(child.pid))), "the stand-in registered its slot");
  return { pid: child.pid, end: async () => { child.stdin.end(); await exited; }, kill: async () => { child.kill("SIGKILL"); await exited; } };
}

function waitFor(w, args, extra = {}) {
  const child = spawn("bash", [WAIT, ...args], { env: { ...w.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", done = false;
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const result = new Promise((resolve) => child.once("exit", (code) => { done = true; resolve({ code, stdout, stderr, lines: stdout.split("\n").filter(Boolean) }); }));
  return { result, running: () => !done };
}

// A run directory as reuse.mjs plan leaves it, named by the time like a real one.
function startRun(w, pid) {
  const id = `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}-0123456`;
  const dir = path.join(w.store, id);
  put(path.join(dir, "keys.json"), { version: 1, run: id, checkout: w.checkout, pid, tree: TREE, head: HEAD, suites: {} });
  put(path.join(dir, "plan.tsv"), ["a", "b", "c", "d"].map((n) => `era-hub:tests/${n}.test.mjs\t${n}.test.mjs\t${"0".repeat(64)}`).join("\n") + "\n");
  return { id, dir };
}
const row = (name, status, line, extra = {}) => ({ suite: `era-hub:tests/${name}`, file: name, status, exit: status === "pass" ? 0 : 1, seconds: 1.5, lane: 1, attempt: 1, line, ...extra });
function results(dir, rows) { put(path.join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); }
function finish(w, run, { pass, fail, failed = "", flaky = 0 }) {
  const summary = `== era-gate: ${pass} passed, ${fail} failed${failed ? ` →${failed}` : ""} ==`;
  const line = `receipt: 0 reused, ${pass + fail} run fresh${flaky ? ` (${flaky} FLAKY)` : ""}; ${path.join(run.dir, "receipt.json")}`;
  put(path.join(run.dir, "receipt.json"), { version: 1, run: run.id, tree: TREE, head: HEAD, pass, fail, green: fail === 0,
    counts: { suites: pass + fail, reused: 0, fresh: pass + fail, flaky }, summary, line });
  if (fail === 0) put(path.join(w.stamps, TREE), `${summary}\nhead=${HEAD}\nat=${Math.floor(Date.now() / 1000)}\nhub=${w.checkout}\n`);
  return { summary, line };
}

test("green: blocks while the gate runs, even past its receipt, then prints the summary, the receipt and the stamp", async (t) => {
  const w = world(t), gate = await startGate(t, w);
  const wait = waitFor(w, [String(gate.pid)]);
  await sleep(400);
  assert.ok(wait.running(), "no run yet: still waiting");
  const run = startRun(w, gate.pid);
  results(run.dir, ["a", "b", "c", "d"].map((n) => row(`${n}.test.mjs`, "pass", `PASS ${n}.test.mjs`)));
  const { summary, line } = finish(w, run, { pass: 4, fail: 0 });
  await sleep(400);
  assert.ok(wait.running(), "the receipt is written but the gate has not ended: still waiting");
  await gate.end();
  const r = await wait.result;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.lines, [summary, line, `stamp: ${path.join(w.stamps, TREE)}`]);

  // the same pid after the gate has ended: found through the run's keys.json
  const again = await waitFor(w, [String(gate.pid)]).result;
  assert.deepEqual([again.code, again.lines], [0, r.lines]);
  const byRun = await waitFor(w, ["--run", run.dir]).result;
  assert.deepEqual([byRun.code, byRun.lines], [0, r.lines]);
});

test("red: the FAIL lines with their gate/ paths, each suite's last verdict only, no stamp; exit 1", async (t) => {
  const w = world(t), gate = await startGate(t, w);
  const wait = waitFor(w, [String(gate.pid)]);
  const run = startRun(w, gate.pid);
  results(run.dir, [
    row("a.test.mjs", "pass", "PASS a.test.mjs"),
    row("b.test.mjs", "fail", "FAIL b.test.mjs (see gate/b.test.out)"),
    row("c.test.mjs", "fail", "FAIL c.test.mjs (see gate/c.test.out)", { attempt: 1 }),
    row("c.test.mjs", "fail", "FAIL c.test.mjs (failed again on retry; see gate/c.test.out)", { attempt: 2 }),
    row("d.test.mjs", "blocked", "FAIL d.test.mjs (failed twice on these inputs, last in R0; not run until it or what it tests changes)", { attempt: 0 }),
  ]);
  const { summary, line } = finish(w, run, { pass: 1, fail: 3, failed: " b.test.mjs c.test.mjs d.test.mjs" });
  await gate.end();
  const r = await wait.result;
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(r.lines, [summary, line,
    "FAIL b.test.mjs (see gate/b.test.out)",
    "FAIL c.test.mjs (failed again on retry; see gate/c.test.out)",
    "FAIL d.test.mjs (failed twice on these inputs, last in R0; not run until it or what it tests changes)"]);
});

test("FLAKY: a pass on retry is green, its FLAKY line is printed and its first FAIL is not", async (t) => {
  const w = world(t), gate = await startGate(t, w);
  const wait = waitFor(w, [String(gate.pid)]);
  const run = startRun(w, gate.pid);
  results(run.dir, [
    row("a.test.mjs", "pass", "PASS a.test.mjs"),
    row("racy.test.mjs", "fail", "FAIL racy.test.mjs (see gate/racy.test.out)"),
    row("racy.test.mjs", "pass", "FLAKY racy.test.mjs (passed on retry)", { attempt: 2, flaky: true }),
  ]);
  const { summary, line } = finish(w, run, { pass: 2, fail: 0, flaky: 1 });
  await gate.end();
  const r = await wait.result;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.lines, [summary, line, "FLAKY racy.test.mjs (passed on retry)", `stamp: ${path.join(w.stamps, TREE)}`]);
});

test("a gate killed outright, slot left behind, no receipt: its last results and log lines, exit 1, without watching (15 s sleep)", async (t) => {
  const w = world(t), gate = await startGate(t, w, { GATE_DIES: "1" });
  const wait = waitFor(w, [String(gate.pid)], { ERA_GATE_WAIT_NO_WATCH: "1" });
  const run = startRun(w, gate.pid);
  results(run.dir, [row("a.test.mjs", "pass", "PASS a.test.mjs"), row("b.test.mjs", "fail", "FAIL b.test.mjs (see gate/b.test.out)")]);
  await sleep(800); // gate-wait has found the live gate and its log, and is asleep
  const started = Date.now();
  await gate.kill();
  assert.ok(fs.existsSync(path.join(w.slots, String(gate.pid))), "the killed stand-in left its slot, as a killed gate does");
  const r = await wait.result;
  assert.ok(Date.now() - started < 20_000, "noticed within one 15 s look");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(r.lines, [
    `gate-wait: gate ${gate.pid} ended without a receipt (killed, out of memory, or stopped before its record)`,
    `last results (${path.join(run.dir, "results.jsonl")}; 2 of 4 planned suites):`,
    "  PASS a.test.mjs",
    "  FAIL b.test.mjs (see gate/b.test.out)",
    `last lines of ${path.join(w.root, "gate.log")}:`,
    "  == era-gate: lock acquired ==",
  ]);
});

test("timeout: one progress line and exit 124 while the gate runs on; --timeout 0 looks once", async (t) => {
  const w = world(t), gate = await startGate(t, w);
  const early = await waitFor(w, [String(gate.pid), "--timeout", "0"]).result;
  assert.equal(early.code, 124);
  assert.deepEqual(early.lines, [`gate-wait: still running after 0 s: gate ${gate.pid} in ${w.checkout}; no run record yet (admission, collection or setup)`]);
  const run = startRun(w, gate.pid);
  results(run.dir, [row("a.test.mjs", "pass", "PASS a.test.mjs"), row("b.test.mjs", "fail", "FAIL b.test.mjs (see gate/b.test.out)")]);
  const started = Date.now();
  const r = await waitFor(w, [String(gate.pid), "--timeout", "1"]).result;
  assert.ok(Date.now() - started >= 900, "it waited the second out");
  assert.equal(r.code, 124, r.stdout + r.stderr);
  assert.deepEqual(r.lines, [`gate-wait: still running after 1 s: gate ${gate.pid} in ${w.checkout}; 2 of 4 suites done, 1 failed so far; run ${run.dir}`]);
  await gate.end();
});

test("an unknown pid, a pid that is not a gate, a missing run and bad arguments exit 2", async (t) => {
  const w = world(t);
  const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  const unknown = await waitFor(w, [gone]).result;
  assert.equal(unknown.code, 2);
  assert.match(unknown.stdout, new RegExp(`^gate-wait: no gate with pid ${gone}: no slot under ${w.slots}, no such process, no run of it under ${w.store}$`, "m"));
  const notGate = await waitFor(w, [String(process.pid)]).result;
  assert.deepEqual([notGate.code, notGate.lines], [2, [`gate-wait: pid ${process.pid} is not an era-gate`]]);
  const noRun = await waitFor(w, ["--run", path.join(w.store, "nothing")]).result;
  assert.deepEqual([noRun.code, noRun.lines], [2, [`gate-wait: ${path.join(w.store, "nothing")} is not a gate run (no keys.json)`]]);
  for (const args of [[], ["--bogus"], ["--timeout", "soon", "1"], ["--run"]]) {
    assert.equal((await waitFor(w, args).result).code, 2, args.join(" "));
  }
});

// ---- the no-polling law, held statically --------------------------------------------
// No script under tools/ sleeps in a loop that watches a gate (its log, its
// results, its receipt or stamp, or era-gate itself): waiting is gate-wait's
// job. Exempt: gate-wait itself, and the gate's own admission wait
// (gate_admit), which waits for a slot rather than watching a gate's output.
const GATE_WATCH = /gate\.log|era-gate|lane-results|results\.jsonl|receipt\.json|gate-wait/;
export function sleepLoopsWatchingAGate(text) {
  const lines = text.split("\n"), found = [];
  lines.forEach((line, i) => {
    if (!/(^|[\s;&|(])sleep\b/.test(line.replace(/#.*$/, ""))) return;
    let from = i;
    while (from > 0 && i - from < 15 && !/\b(while|until|for)\b/.test(lines[from])) from--;
    if (!/\b(while|until|for)\b/.test(lines[from])) return;
    const window = lines.slice(from, Math.min(lines.length, i + 6)).map((l) => l.replace(/#.*$/, "")).join("\n");
    if (GATE_WATCH.test(window)) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}
function shellScripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? shellScripts(path.join(dir, e.name))
    : e.name.endsWith(".sh") ? [path.join(dir, e.name)] : []);
}

test("no script under tools/ sleeps in a loop watching a gate; the check itself catches one", () => {
  const offenders = [];
  for (const file of shellScripts(path.join(HUB, "tools"))) {
    const rel = path.relative(HUB, file);
    if (rel === "tools/gate-wait.sh") continue;
    let text = fs.readFileSync(file, "utf8");
    if (rel === "tools/era-gate.sh") {
      const admit = text.match(/^gate_admit\(\)\s*\{[\s\S]*?\n\}/m);
      assert.ok(admit, "era-gate.sh still has its admission wait");
      text = text.replace(admit[0], admit[0].replace(/[^\n]/g, ""));
    }
    for (const hit of sleepLoopsWatchingAGate(text)) offenders.push(`${rel}:${hit}`);
  }
  assert.deepEqual(offenders, [], "wait for a gate with tools/gate-wait.sh, never a sleep loop");
  assert.equal(sleepLoopsWatchingAGate('until grep -q "== era-gate:" "$LOG"; do\n  sleep 30\ndone\n').length, 1);
  assert.equal(sleepLoopsWatchingAGate('while kill -0 "$pid"; do sleep 60; tail -1 gate.log; done\n').length, 1);
  assert.equal(sleepLoopsWatchingAGate('for i in 1 2 3; do\n  curl -s "$url" && break\n  sleep 1\ndone\n').length, 0);
  assert.match(fs.readFileSync(WAIT, "utf8"), /^exec node "\$\(dirname "\$0"\)\/testing\/gate-wait\.mjs" "\$@"$/m);
});
