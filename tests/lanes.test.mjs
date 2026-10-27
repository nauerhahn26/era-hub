// lanes.test.mjs — the lane runner inside era-gate.sh (gate-speed plan
// 2026-10-26, phase 2; design section 3.1). tools/testing/lanes.mjs takes the
// frozen plan (gate/.execution-plan.tsv), the registry's classes and
// durations.json, and runs ERA_GATE_LANES suites at once.
//
// The rules proved here: longest known duration first (unknown suites take
// default_s), solo suites first and alone, two heavy suites never together, a
// quiet suite never beside a heavy one, two suites claiming one fixed port
// never together (the gaze engine's 49155 included, read from the collected
// copy when the registry has not caught up), and a memory floor that holds a
// lane but never the last running one. ERA_GATE_LANES=1 is the serial loop:
// frozen order, one at a time, the same lines.
//
// The runner is exercised for real against synthetic gate dirs, with a fake
// `node` (and a pass-through `timeout`) first on PATH: each synthetic suite
// says how long to "run" and how to exit, so the whole file takes seconds.
// MemAvailable is read from a file the test writes, never the host's.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canStart, classesFor, queueOrder, readPlan, simulate, estimate,
} from "../tools/testing/lanes.mjs";
import { ENGINE_PORT } from "../tools/testing/suite-source.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(HUB, "tools", "testing", "lanes.mjs");
const GATE_SCRIPT = fs.readFileSync(path.join(HUB, "tools", "era-gate.sh"), "utf8");
const REAL_TIMEOUT = spawnSync("sh", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout.trim();
const GIB = 1024 * 1024; // kB in a GiB, the unit /proc/meminfo uses

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "era-lanes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- synthetic suites -------------------------------------------------------
// A suite: { name, id?, seconds (the "run" time), exit, heavy, solo, quiet,
// ports (registry), code (extra source lines), estimate (durations.json),
// printEnv (it prints its environment into its .out) }.
function gateDir(t, suites, { defaultS = 1 } = {}) {
  const root = scratch(t), gate = path.join(root, "gate"), bin = path.join(root, "bin");
  fs.mkdirSync(gate); fs.mkdirSync(bin);
  // fake node: the last argument is ./<suite>; it echoes how it was started
  // (into the suite's .out), optionally leaves a detached grandchild, sleeps
  // and exits as the suite's header says.
  fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh
for a; do f="$a"; done
echo "argv: $*"
echo "cwd: $(pwd)"
s=$(sed -n 's|^// SLEEP=||p' "$f"); e=$(sed -n 's|^// EXIT=||p' "$f")
if grep -q '^// PRINTENV' "$f"; then env; fi
if grep -q '^// DETACH' "$f"; then
  setsid sleep 30 & echo $! >"$f.grandchild"
  echo $$ >"$f.child"
fi
sleep "\${s:-0}"
exit "\${e:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "timeout"), `#!/bin/sh\necho "timeout: $1"\nexec ${REAL_TIMEOUT} "$@"\n`, { mode: 0o755 });
  const registry = { suites: [] }, durations = { default_s: defaultS, suites: {} }, plan = [];
  for (const s of suites) {
    const id = s.id || `era-hub:tests/${s.name}`;
    const body = [`// SLEEP=${s.seconds ?? 0.1}`, `// EXIT=${s.exit ?? 0}`, ...(s.detach ? ["// DETACH"] : []), ...(s.printEnv ? ["// PRINTENV"] : []), ...(s.code || [])].join("\n") + "\n";
    fs.writeFileSync(path.join(gate, s.name), body);
    const digest = crypto.createHash("sha256").update(s.changed ? "something else" : body).digest("hex");
    plan.push([id, s.name, digest].join("\t"));
    registry.suites.push({ id, hub: "none", ports: s.ports || [], browsers: 0, heavy: !!s.heavy, solo: !!s.solo, quiet: !!s.quiet, retry: false, owner: "" });
    if (s.estimate !== undefined) durations.suites[id] = { median_s: s.estimate };
  }
  fs.writeFileSync(path.join(gate, ".execution-plan.tsv"), plan.join("\n") + "\n");
  const files = { registry: path.join(root, "registry.json"), durations: path.join(root, "durations.json"), meminfo: path.join(root, "meminfo") };
  fs.writeFileSync(files.registry, JSON.stringify(registry));
  fs.writeFileSync(files.durations, JSON.stringify(durations));
  setMemory(files.meminfo, 16 * GIB);
  return { root, gate, bin, ...files };
}
function setMemory(file, availableKb) {
  fs.writeFileSync(file, `MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:   ${availableKb} kB\n`);
}
function runnerArgs(g, extra = []) {
  return [RUNNER, g.gate, "--registry", g.registry, "--durations", g.durations, "--meminfo", g.meminfo,
    "--hold-ms", "100", "--grace-ms", "1000", ...extra];
}
function runnerEnv(g, env = {}) {
  const out = { ...process.env, PATH: `${g.bin}:${process.env.PATH}`, ...env };
  delete out.NODE_TEST_CONTEXT;
  if (!("ERA_GATE_LANES" in env)) delete out.ERA_GATE_LANES;
  return out;
}
function run(g, extra = [], env = {}) {
  const r = spawnSync(process.execPath, runnerArgs(g, extra), { cwd: g.gate, env: runnerEnv(g, env), encoding: "utf8", timeout: 60_000 });
  assert.equal(r.error, undefined);
  const results = fs.existsSync(path.join(g.gate, "results.jsonl"))
    ? fs.readFileSync(path.join(g.gate, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const summary = fs.existsSync(path.join(g.gate, ".lane-results.tsv"))
    ? fs.readFileSync(path.join(g.gate, ".lane-results.tsv"), "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, results, summary };
}
const lines = (text) => text.split("\n").filter(Boolean);
const suiteLines = (text) => lines(text).filter((l) => /^(RUN|PASS|FAIL) /.test(l));
const span = (row) => [Date.parse(row.startedAt), Date.parse(row.endedAt)];
const overlap = (a, b) => { const [as, ae] = span(a), [bs, be] = span(b); return as < be && bs < ae; };
const byName = (results) => new Map(results.map((r) => [r.file, r]));
function overlapping(results) {
  const pairs = [];
  for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++)
    if (overlap(results[i], results[j])) pairs.push([results[i].file, results[j].file].sort().join("+"));
  return pairs.sort();
}

// ---- the pure scheduler --------------------------------------------------------

const suite = (name, extra = {}) => ({ index: 0, id: `era-hub:tests/${name}`, name, heavy: false, solo: false, quiet: false, ports: [], ...extra });

test("longest known duration first; an unknown suite takes default_s; solo suites lead; ties keep the frozen order", () => {
  const plan = ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs", "e.test.mjs", "f.test.mjs"].map((n, index) => suite(n, { index }));
  plan[4].solo = true;
  const durations = { default_s: 20, suites: { [plan[0].id]: { median_s: 5 }, [plan[1].id]: { median_s: 40 }, [plan[2].id]: { median_s: 20 }, [plan[4].id]: { median_s: 1 } } };
  const estimated = estimate(plan, durations);
  assert.deepEqual(estimated.map((s) => s.seconds), [5, 40, 20, 20, 1, 20], "d and f are unknown: default_s");
  assert.deepEqual(queueOrder(estimated, 2).map((s) => s.name),
    ["e.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs", "f.test.mjs", "a.test.mjs"]);
  assert.deepEqual(queueOrder(estimated, 1).map((s) => s.name), plan.map((s) => s.name), "one lane keeps the frozen order");
});

test("which suite may start beside which", () => {
  const plain = suite("plain"), reader = suite("reader", { hub: "shared-reader" });
  const heavy = suite("heavy", { heavy: true }), heavy2 = suite("heavy2", { heavy: true });
  const quiet = suite("quiet", { quiet: true }), quiet2 = suite("quiet2", { quiet: true });
  const solo = suite("solo", { solo: true, heavy: true });
  const port = suite("port", { ports: [8401] }), port2 = suite("port2", { ports: [8402, 8401] });
  const engine = suite("engine", { ports: [ENGINE_PORT] }), engine2 = suite("engine2", { ports: [8403, ENGINE_PORT] });
  assert.equal(canStart(solo, []), true, "solo starts when nothing runs");
  for (const other of [plain, reader, quiet]) {
    assert.equal(canStart(solo, [other]), false, "solo never starts beside anything");
    assert.equal(canStart(other, [solo]), false, "nothing starts beside a solo suite");
  }
  assert.equal(canStart(heavy2, [heavy]), false, "two heavy suites never together");
  assert.equal(canStart(quiet, [heavy]), false, "quiet never beside heavy");
  assert.equal(canStart(heavy, [quiet]), false, "heavy never beside quiet");
  assert.equal(canStart(quiet2, [quiet]), true, "two quiet suites may share the host");
  assert.equal(canStart(heavy, [plain, reader]), true);
  assert.equal(canStart(port2, [port]), false, "one fixed port, one suite at a time");
  assert.equal(canStart(engine2, [engine]), false, "the engine's bus is a fixed port too");
  assert.equal(canStart(engine, [port]), true);
  assert.equal(canStart(reader, [plain, heavy, quiet]), true, "a shared-hub reader runs beside anything");
});

test("the committed registry and durations simulate without breaking a rule, and one lane is the plain sum", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(HUB, "tools/testing/registry.json"), "utf8"));
  const durations = JSON.parse(fs.readFileSync(path.join(HUB, "tools/testing/durations.json"), "utf8"));
  const plan = registry.suites.map((s, index) => ({ index, id: s.id, name: path.basename(s.id.split(":")[1]) }));
  const suites = estimate(classesFor(plan, { registry }), durations);
  const sum = suites.reduce((n, s) => n + s.seconds, 0);
  const one = simulate(suites, 1);
  assert.ok(Math.abs(one.makespan - sum) < 1e-6, "one lane: every suite end to end");
  assert.deepEqual(one.schedule.map((r) => r.id), suites.map((s) => s.id), "in the frozen order");
  for (const lanes of [2, 3]) {
    const { makespan, schedule } = simulate(suites, lanes);
    assert.ok(makespan < sum && makespan >= sum / lanes - 1e-6, `${lanes} lanes: ${makespan}`);
    assert.equal(new Set(schedule.map((r) => r.id)).size, suites.length, "every suite once");
    for (const a of schedule) for (const b of schedule) {
      if (a === b || !(a.start < b.end && b.start < a.end)) continue;
      assert.ok(canStart(a.suite, [b.suite]), `${lanes} lanes ran ${a.id} beside ${b.id}`);
    }
    assert.ok(Math.max(...schedule.map((r) => r.lane)) <= lanes);
  }
});

test("the engine's bus is read from the collected copy when the registry does not list it", (t) => {
  const g = gateDir(t, [
    { name: "a.test.mjs", code: [`engine.listen(${ENGINE_PORT}, "127.0.0.1", () => {});`] },
    { name: "b.test.mjs", ports: [8401], code: [`// an engine lives on ${ENGINE_PORT} on her PC`, `await ctx.route("http://127.0.0.1:${ENGINE_PORT}/**", (r) => r.abort());`] },
  ]);
  const registry = JSON.parse(fs.readFileSync(g.registry, "utf8"));
  const [a, b] = classesFor(readPlan(g.gate), { registry, sourceOf: (name) => fs.readFileSync(path.join(g.gate, name), "utf8") });
  assert.deepEqual(a.ports, [ENGINE_PORT]);
  assert.deepEqual(b.ports, [8401], "a comment and a browser route intercept bind nothing");
});

// ---- the runner, for real ----------------------------------------------------------

test("two lanes run suites side by side and keep every exclusion", (t) => {
  const g = gateDir(t, [
    { name: "h1.test.mjs", heavy: true, seconds: 0.6, estimate: 60 },
    { name: "h2.test.mjs", heavy: true, seconds: 0.3, estimate: 50 },
    { name: "q1.test.mjs", quiet: true, seconds: 0.3, estimate: 40 },
    { name: "p1.test.mjs", ports: [8401], seconds: 0.4, estimate: 30 },
    { name: "p2.test.mjs", ports: [8401], seconds: 0.2, estimate: 29 },
    // e1's registry entry does not know it binds the engine's bus; its copy does
    { name: "e1.test.mjs", seconds: 0.3, estimate: 28, code: [`s.listen(${ENGINE_PORT}, "127.0.0.1");`] },
    { name: "e2.test.mjs", ports: [ENGINE_PORT], seconds: 0.2, estimate: 27 },
    { name: "s1.test.mjs", solo: true, heavy: true, seconds: 0.3, estimate: 5 },
    { name: "n1.test.mjs", seconds: 0.3, estimate: 20 },
    { name: "n2.test.mjs", seconds: 0.3, estimate: 19 },
    { name: "n3.test.mjs", seconds: 0.3, estimate: 18 },
  ]);
  const r = run(g, ["--lanes", "2"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.results.length, 11, "one results.jsonl line per suite");
  assert.equal(new Set(r.results.map((x) => x.suite)).size, 11);
  for (const x of r.results) {
    assert.equal(x.status, "pass"); assert.equal(x.exit, 0);
    assert.ok(x.lane === 1 || x.lane === 2, `lane ${x.lane}`);
    assert.ok(x.seconds > 0 && Number.isFinite(Date.parse(x.startedAt)) && Number.isFinite(Date.parse(x.endedAt)));
  }
  const pairs = overlapping(r.results);
  assert.ok(pairs.length > 0, "two lanes actually ran side by side");
  const rows = byName(r.results);
  for (const pair of pairs) {
    const [a, b] = pair.split("+").map((n) => rows.get(n));
    assert.ok(!a.file.startsWith("s1") && !b.file.startsWith("s1"), `solo ran beside another: ${pair}`);
    assert.notEqual(pair, "h1.test.mjs+h2.test.mjs", "two heavy suites ran together");
    assert.ok(!/h\d.*q1|q1.*h\d/.test(pair), `quiet ran beside heavy: ${pair}`);
    assert.notEqual(pair, "p1.test.mjs+p2.test.mjs", "two suites shared port 8401");
    assert.notEqual(pair, "e1.test.mjs+e2.test.mjs", "two suites shared the engine's bus");
  }
  assert.equal(r.results.reduce((first, x) => Date.parse(x.startedAt) < Date.parse(first.startedAt) ? x : first).file,
    "s1.test.mjs", "the solo suite runs first, alone");
  const out = suiteLines(r.stdout);
  for (const x of r.results) {
    assert.equal(out.filter((l) => l === `RUN ${x.file}`).length, 1);
    assert.equal(out.filter((l) => l === `PASS ${x.file}`).length, 1);
    assert.ok(out.indexOf(`RUN ${x.file}`) < out.indexOf(`PASS ${x.file}`));
  }
  assert.match(r.stdout, /^lanes: 2\b/m, "the lane count is announced");
});

test("ERA_GATE_LANES=1 is the serial loop: frozen order, one at a time, its lines, commands and outputs", (t) => {
  const g = gateDir(t, [
    { name: "run.js", id: "era-making-words:tests/run.js", seconds: 0.1, estimate: 1 },
    { name: "parts.js", id: "era-making-words:tests/parts.js", seconds: 0.1, exit: 3, estimate: 2 },
    { name: "a.test.mjs", seconds: 0.1, estimate: 3 },
    { name: "b.test.mjs", seconds: 0.2, heavy: true, estimate: 90 },
    { name: "c.test.mjs", seconds: 0.1, exit: 1, estimate: 50 },
  ]);
  const r = run(g, [], { ERA_GATE_LANES: "1" });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    "RUN run.js", "PASS run",
    "RUN parts.js", "FAIL parts (see gate/parts.out)",
    "RUN a.test.mjs", "PASS a.test.mjs",
    "RUN b.test.mjs", "PASS b.test.mjs",
    "RUN c.test.mjs", "FAIL c.test.mjs (see gate/c.test.out)",
  ], "byte for byte what the serial loop printed, and nothing else");
  assert.deepEqual(overlapping(r.results), [], "never two at once");
  assert.deepEqual(r.results.map((x) => x.file), ["run.js", "parts.js", "a.test.mjs", "b.test.mjs", "c.test.mjs"]);
  assert.ok(r.results.every((x) => x.lane === 1));
  const out = (name) => fs.readFileSync(path.join(g.gate, name), "utf8");
  assert.equal(out("run.out"), `timeout: 420\nargv: ./run.js\ncwd: ${g.gate}\n`, "legacy: timeout 420 node ./X > X.out");
  assert.equal(out("a.test.out"), `timeout: 900\nargv: --test ./a.test.mjs\ncwd: ${g.gate}\n`, "modern: timeout 900 node --test ./X > X.test.out");
  assert.equal(r.results.find((x) => x.file === "parts.js").exit, 3);
});

test("a failing suite is one FAIL, one results line, and one failure in the gate's count", (t) => {
  const g = gateDir(t, [
    { name: "a.test.mjs", seconds: 0.2 },
    { name: "b.test.mjs", seconds: 0.1, exit: 1 },
    { name: "c.test.mjs", seconds: 0.1 },
    { name: "d.test.mjs", seconds: 0.1, changed: true },
  ]);
  const r = run(g, ["--lanes", "2"]);
  assert.equal(r.status, 1);
  assert.equal(suiteLines(r.stdout).filter((l) => l.startsWith("FAIL b.test.mjs")).length, 1);
  assert.ok(lines(r.stdout).includes("FAIL b.test.mjs (see gate/b.test.out)"));
  assert.ok(lines(r.stdout).includes("FAIL d.test.mjs (collected suite missing or changed)"), "a changed copy is refused");
  assert.ok(!lines(r.stdout).includes("RUN d.test.mjs"), "and never started");
  assert.deepEqual(r.results.filter((x) => x.file === "b.test.mjs").map((x) => [x.status, x.exit]), [["fail", 1]]);
  assert.deepEqual(r.results.filter((x) => x.file === "d.test.mjs").map((x) => x.status), ["changed"]);
  assert.deepEqual(r.results.filter((x) => /^[bd]\./.test(x.file)).map((x) => x.line).sort(),
    ["FAIL b.test.mjs (see gate/b.test.out)", "FAIL d.test.mjs (collected suite missing or changed)"],
    "each results line carries the verdict line it printed (tools/gate-wait.sh repeats it)");
  assert.deepEqual(r.summary.map((row) => [row[0], row[1], row[3]]), [
    ["pass", "0", "era-hub:tests/a.test.mjs"], ["fail", "1", "era-hub:tests/b.test.mjs"],
    ["pass", "2", "era-hub:tests/c.test.mjs"], ["changed", "3", "era-hub:tests/d.test.mjs"],
  ], "the gate's tally, in the frozen order");

  // the gate's own bash counts it, through the functions it ships
  const fn = (name) => {
    const m = GATE_SCRIPT.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
    assert.ok(m, `era-gate.sh defines ${name}`);
    return m[0];
  };
  const script = [
    "set -uo pipefail", ...["gate_error", "gate_record_execution", "gate_verify_execution", "gate_record_results"].map(fn),
    'EXPECTED_IDS=(); EXPECTED_FILES=(); EXPECTED_HASHES=(); declare -gA EXECUTED_COUNT=()',
    'while IFS=$\'\\t\' read -r id name digest; do EXPECTED_IDS+=("$id"); EXPECTED_FILES+=("$name"); EXPECTED_HASHES+=("$digest"); done <"$GATE/.execution-plan.tsv"',
    'pass=0; fail=0; failed=""',
    'gate_record_results "$STATUS"',
    'gate_verify_execution || { fail=$((fail+1)); failed="$failed execution-set"; }',
    'echo "== era-gate: $pass passed, $fail failed${failed:+ →$failed} =="',
  ].join("\n");
  const tally = (status) => spawnSync("bash", ["-c", script], { env: { ...process.env, GATE: g.gate, STATUS: String(status) }, encoding: "utf8" });
  const counted = tally(r.status);
  assert.equal(counted.stdout.trim(), "== era-gate: 2 passed, 3 failed → b.test.mjs d.test.mjs execution-set ==",
    "b once by its label; d once by its file and never as executed, as the serial loop counted them");
  assert.match(counted.stderr, /collected suite changed before execution: era-hub:tests\/d\.test\.mjs/);
  assert.equal(tally(143).stdout.trim(), "== era-gate: 2 passed, 4 failed → b.test.mjs d.test.mjs lanes execution-set ==",
    "a runner that did not finish is a failure of its own");
  fs.rmSync(path.join(g.gate, ".lane-results.tsv"));
  assert.match(tally(2).stdout.trim(), /^== era-gate: 0 passed, 2 failed → lanes execution-set ==$/, "no tally, no pass");
});

test("under the memory floor a lane holds, but the last running lane never does", (t) => {
  const g = gateDir(t, ["a", "b", "c", "d"].map((n) => ({ name: `${n}.test.mjs`, seconds: 0.2 })));
  setMemory(g.meminfo, 1 * GIB);
  const r = run(g, ["--lanes", "3"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.results.length, 4, "every suite still ran");
  assert.deepEqual(overlapping(r.results), [], "with MemAvailable under 2 GiB only one suite runs at a time");
  assert.match(r.stdout, /^lanes: hold: MemAvailable 1024 MiB under the 2048 MiB floor/m, "the hold is logged");
});

test("a memory hold lifts when MemAvailable comes back", (t) => {
  const g = gateDir(t, [
    { name: "a.test.mjs", seconds: 1.5, estimate: 9 },
    { name: "b.test.mjs", seconds: 0.2, estimate: 2 },
    { name: "c.test.mjs", seconds: 0.2, estimate: 1 },
  ]);
  setMemory(g.meminfo, 1 * GIB);
  const child = spawn(process.execPath, runnerArgs(g, ["--lanes", "2"]), { cwd: g.gate, env: runnerEnv(g), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    if (/^lanes: hold/m.test(stdout)) setMemory(g.meminfo, 8 * GIB);
  });
  return new Promise((resolve) => child.on("close", resolve)).then((code) => {
    assert.equal(code, 0);
    assert.match(stdout, /^lanes: resume: MemAvailable 8192 MiB/m);
    const rows = fs.readFileSync(path.join(g.gate, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(overlapping(rows).includes("a.test.mjs+b.test.mjs"), "b started beside a once memory came back");
  });
});

test("a lane count outside 1-8 is refused before anything runs; unset or empty is 2, as in the gate", (t) => {
  const g = gateDir(t, [{ name: "a.test.mjs" }]);
  for (const lanes of ["", undefined]) {
    const r = run(g, [], lanes === undefined ? {} : { ERA_GATE_LANES: lanes });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^lanes: 2\b/m);
  }
  for (const lanes of ["0", "9", "two", "1.5", "01"]) {
    const r = run(g, [], { ERA_GATE_LANES: lanes });
    assert.equal(r.status, 2, `ERA_GATE_LANES=${JSON.stringify(lanes)}`);
    assert.match(r.stderr, /ERA_GATE_LANES/);
    assert.ok(!/^RUN /m.test(r.stdout));
  }
});

test("TERM stops every suite the runner started, by pid, detached grandchildren included", async (t) => {
  const g = gateDir(t, [
    { name: "long.test.mjs", seconds: 30, detach: true, estimate: 30 },
    { name: "other.test.mjs", seconds: 30, estimate: 29 },
  ]);
  const pids = [];
  const alive = (pid) => {
    try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
  };
  t.after(() => { for (const pid of pids) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {} });
  const child = spawn(process.execPath, runnerArgs(g, ["--lanes", "2"]), { cwd: g.gate, env: runnerEnv(g), stdio: ["ignore", "pipe", "pipe"] });
  pids.push(child.pid);
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  const grandchild = path.join(g.gate, "long.test.mjs.grandchild"), suiteShell = path.join(g.gate, "long.test.mjs.child");
  for (let i = 0; i < 100 && !(fs.existsSync(grandchild) && fs.existsSync(suiteShell) && /RUN other/.test(stdout)); i++) await new Promise((r) => setTimeout(r, 50));
  const detached = Number(fs.readFileSync(grandchild, "utf8")), shell = Number(fs.readFileSync(suiteShell, "utf8"));
  pids.push(detached, shell);
  assert.ok(alive(detached) && alive(shell), "the suite and its detached grandchild are running");
  const started = Date.now();
  child.kill("SIGTERM");
  const { code } = await closed;
  assert.equal(code, 143, stdout);
  assert.ok(Date.now() - started < 10_000, "stopped promptly, not after the suites' 30 s");
  for (let i = 0; i < 40 && (alive(detached) || alive(shell)); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(shell), false, "the suite's process is gone");
  assert.equal(alive(detached), false, "its detached grandchild (another session, unreachable by group) is gone");
  const source = fs.readFileSync(RUNNER, "utf8");
  assert.doesNotMatch(source, /\b(?:pkill|killall)\b/, "never by name");
  assert.doesNotMatch(source, /process\.kill\(\s*-|kill\s+--?\s*-\d|\bkill\s+0\b/, "never by group");
});

test("a TERM to the gate reaches the runner at once and leaves no suite process behind", async (t) => {
  // The gate's own text: its stop function and the lines that start and wait
  // for the runner, under the gate's traps, against the real lanes.mjs.
  const g = gateDir(t, [
    { name: "x.test.mjs", seconds: 30, detach: true },
    { name: "y.test.mjs", seconds: 30, detach: true },
  ]);
  const fn = (name) => GATE_SCRIPT.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"))[0];
  const from = GATE_SCRIPT.indexOf('node "$HUB/tools/testing/lanes.mjs"'), to = GATE_SCRIPT.indexOf('LANES_PID=""; LANES_ID=""\n', from);
  assert.ok(from > 0 && to > from, "the gate starts and waits for the runner");
  const script = [
    "set -uo pipefail", ...["gate_error", "gate_process_identity", "gate_stop_lanes"].map(fn),
    // the runner is the real node; the suites get the fake one on PATH
    'node() { exec "$REAL_NODE" "$@"; }',
    'LANES_PID=""; LANES_ID=""', "trap 'gate_stop_lanes' EXIT", "trap 'exit 130' INT", "trap 'exit 143' TERM",
    'cd "$GATE"', GATE_SCRIPT.slice(from, to), 'echo "runner finished: $lanes_status"',
  ].join("\n");
  const inGate = () => fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
    try { return fs.readlinkSync(`/proc/${p}/cwd`) === g.gate; } catch { return false; }
  }).map(Number);
  t.after(() => { for (const pid of inGate()) try { process.kill(pid, "SIGKILL"); } catch {} });
  const gate = spawn("bash", ["-c", script], {
    env: runnerEnv(g, { ERA_GATE_LANES: "2", HUB, GATE: g.gate, REAL_NODE: process.execPath }), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  gate.stdout.on("data", (d) => { stdout += d; });
  const closed = new Promise((resolve) => gate.on("close", (code) => resolve(code)));
  const started = () => ["x", "y"].some((n) => fs.existsSync(path.join(g.gate, `${n}.test.mjs.grandchild`)));
  for (let i = 0; i < 100 && !started(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(started(), "a suite is running");
  assert.ok(inGate().length >= 3, "runner, timeout and suite are running in the gate dir");
  const sent = Date.now();
  gate.kill("SIGTERM");
  assert.equal(await closed, 143, stdout);
  assert.ok(Date.now() - sent < 10_000, "the gate did not wait for its 30 s suites");
  assert.doesNotMatch(stdout, /runner finished/, "the TERM ended the wait, it did not outlast the runner");
  for (let i = 0; i < 40 && inGate().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(inGate(), [], "no runner, timeout or suite process is left in the gate dir");
  for (const n of ["x", "y"]) {
    const file = path.join(g.gate, `${n}.test.mjs.grandchild`);
    if (!fs.existsSync(file)) continue;
    const pid = Number(fs.readFileSync(file, "utf8"));
    assert.ok(!fs.existsSync(`/proc/${pid}`) || / Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")), `${n}'s detached grandchild is gone`);
  }
});

// The glibc malloc settings the gate gives every suite (10/27): measured on
// clothing.test.mjs, freed native memory went back to the kernel instead of
// staying with the process (peak 1115 MB to 870 MB alone). The gate's own
// text from the export to the runner's wait runs here against the real
// lanes.mjs, and a suite that prints its environment must see both values,
// with neither in the environment the gate itself was started with.
test("every suite the runner starts inherits the gate's malloc settings", (t) => {
  const g = gateDir(t, [{ name: "env.test.mjs", printEnv: true }]);
  const fn = (name) => GATE_SCRIPT.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"))[0];
  const from = GATE_SCRIPT.search(/^export MALLOC_MMAP_THRESHOLD_=/m), launch = GATE_SCRIPT.indexOf('node "$HUB/tools/testing/lanes.mjs"');
  const to = GATE_SCRIPT.indexOf('LANES_PID=""; LANES_ID=""\n', launch);
  assert.ok(from > 0 && launch > from && to > launch, "the gate exports them before it starts the runner");
  const script = [
    "set -uo pipefail", fn("gate_process_identity"),
    // the runner is the real node; the suite gets the fake one on PATH
    'node() { exec "$REAL_NODE" "$@"; }', 'cd "$GATE"', GATE_SCRIPT.slice(from, to), 'exit "$lanes_status"',
  ].join("\n");
  const env = runnerEnv(g, { ERA_GATE_LANES: "1", HUB, GATE: g.gate, REAL_NODE: process.execPath });
  delete env.MALLOC_MMAP_THRESHOLD_; delete env.MALLOC_TRIM_THRESHOLD_;
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const printed = fs.readFileSync(path.join(g.gate, "env.test.out"), "utf8");
  assert.match(printed, /^argv: --test \.\/env\.test\.mjs$/m, "the suite ran as the gate runs it");
  assert.match(printed, /^MALLOC_MMAP_THRESHOLD_=131072$/m);
  assert.match(printed, /^MALLOC_TRIM_THRESHOLD_=131072$/m);
});

test("era-gate.sh hands its frozen plan to the runner and keeps the serial tally", () => {
  assert.doesNotMatch(GATE_SCRIPT, /^\s*timeout 900 node --test/m, "the serial loop is gone from the gate");
  assert.match(GATE_SCRIPT, /^node "\$HUB\/tools\/testing\/lanes\.mjs" "\$GATE" <&0 &$/m, "the runner gets the gate dir and the gate's stdin");
  assert.match(GATE_SCRIPT, /^gate_record_results "\$lanes_status"$/m);
  assert.match(GATE_SCRIPT, /^export ERA_GATE_LANES="\$\{ERA_GATE_LANES:-2\}"$/m, "two lanes unless told otherwise");
  assert.match(GATE_SCRIPT, /^gate_finish\(\) \{\n[^\n]*\n\s*gate_stop_lanes\n/m, "an early exit stops the runner first");
});
