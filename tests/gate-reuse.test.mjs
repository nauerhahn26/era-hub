// gate-reuse.test.mjs — restart intelligence for the gate (gate-speed plan
// 2026-10-26, phase 3; design section 3.2). A red gate used to cost a full
// rerun even when one fixture was wrong or one suite raced; now a gate keeps a
// run store ($ERA_GATE_RUNS), reuses each suite's qualifying pass while its key
// holds, retries one failed suite once (FLAKY), and composes the same 4-line
// stamp from reused and fresh passes.
//
// Proved here, without running a gate: one negative test per part of the key
// (change it and the key changes, change anything else and it does not); the
// 24-hour bound; a FLAKY pass never qualifies; a shared-state change
// disqualifies the shared readers of its run; --rerun-failed reruns exactly
// the failed set and refuses when a pass there no longer stands; --restamp
// refuses when any key differs or evidence is too old; a resource failure and
// a second failure on one key are never retried; the gate's tally counts reused
// and FLAKY passes as passes; the stamp keeps its shape and the summary line
// stays last. The key logic is tools/testing/reuse.mjs; the retry is
// tools/testing/lanes.mjs, exercised with a fake `node` first on PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as reuse from "../tools/testing/reuse.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REUSE = path.join(HUB, "tools", "testing", "reuse.mjs");
const RUNNER = path.join(HUB, "tools", "testing", "lanes.mjs");
const GATE_SCRIPT = fs.readFileSync(path.join(HUB, "tools", "era-gate.sh"), "utf8");
const HOUR = 3600 * 1000;
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const lines = (text) => text.split("\n").filter(Boolean);

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "era-gate-reuse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
const fnOf = (name) => {
  const m = GATE_SCRIPT.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(m, `era-gate.sh defines ${name}`);
  return m[0];
};

// ---- a synthetic checkout, collected gate dir and inputs manifest ---------------
// Three suites: a and b are plain; c names the registry in its source, so its
// key carries the whole registry and durations.json.
const SUITES = ["a.test.mjs", "b.test.mjs", "c.test.mjs"];
function world(t, { hubs = {} } = {}) {
  const root = scratch(t);
  const hub = path.join(root, "era-hub"), gate = path.join(hub, "gate"), store = path.join(root, "store");
  put(path.join(hub, "tools/era-gate.sh"), "# the gate\n");
  put(path.join(hub, "tools/test-suite.mjs"), "// the jobs cli\n");
  put(path.join(hub, "tools/testing/lanes.mjs"), "// the lanes\n");
  put(path.join(root, "era-family/tools/era-scan.sh"), "PATTERNS='x'\n");
  put(path.join(root, "node_modules/playwright/package.json"), { name: "playwright", version: "1.0.0" });
  put(path.join(root, "node_modules/playwright-core/package.json"), { name: "playwright-core", version: "1.0.0" });
  put(path.join(root, "node_modules/playwright-core/browsers.json"), { browsers: [
    { name: "chromium", revision: "100" }, { name: "chromium-headless-shell", revision: "100" }] });
  const map = [], plan = [];
  for (const name of SUITES) {
    put(path.join(gate, name), name === "c.test.mjs" ? "// reads tools/testing/registry.json\n" : `// ${name}\n`);
    map.push(`era-hub:tests/${name}\t${name}`);
  }
  put(path.join(gate, "helper.mjs"), "export const helper = 1;\n");
  put(path.join(gate, "fixtures/data.json"), "{}\n");
  map.push("era-hub:tests/helper.mjs\thelper.mjs", "era-hub:tests/fixtures/data.json\tfixtures/data.json");
  put(path.join(gate, ".source-map.tsv"), map.join("\n") + "\n");
  const w = { root, hub, gate, store, registryFile: path.join(hub, "tools/testing/registry.json"), inputs: path.join(root, "inputs.json") };
  w.freeze = () => put(path.join(gate, ".execution-plan.tsv"), SUITES.map((name) =>
    [`era-hub:tests/${name}`, name, digest(fs.readFileSync(path.join(gate, name)))].join("\t")).join("\n") + "\n");
  w.freeze();
  w.registry = { version: 1, suites: SUITES.map((name) => ({ id: `era-hub:tests/${name}`, purpose: name, hub: hubs[name] || "none", ports: [] })) };
  w.saveRegistry = () => put(w.registryFile, JSON.stringify(w.registry, null, 1));
  w.saveRegistry();
  put(path.join(hub, "tools/testing/durations.json"), { default_s: 1, suites: {} });
  const file = (hash) => ({ kind: "file", hash, executable: false });
  w.manifest = {
    version: 2, node: "v0", platform: "linux", arch: "x64",
    repositories: {
      "era-hub": { root: hub, head: "h1", index: "i1", files: {
        "server.js": file("server-1"), "docs/notes.md": file("docs-1"), "tests/a.test.mjs": file("test-1"),
        "tools/testing/registry.json": file("registry-1"), "tools/testing/durations.json": file("durations-1") } },
      "era-board": { root: path.join(root, "era-board"), head: "h2", index: "i2", files: { "app/board.js": file("board-1") } },
    },
    configuration: { seedDir: path.join(root, "seed"), testPort: "8378", suffix: "", mode: "full",
      seed: { kind: "directory", hash: "seed-1", entries: {} }, gateEnvironment: null },
    servedFarm: { "public/board": { kind: "source-link", target: path.join(root, "era-board/app"), content: { kind: "directory", hash: "farm-1" } } },
    hash: "manifest-1",
  };
  w.saveManifest = () => put(w.inputs, JSON.stringify(w.manifest));
  w.saveManifest();
  w.env = { ERA_DATA_DIR: path.join(root, "data-1"), ERA_HUB_SRC: hub, ERA_GAZE_SRC: path.join(root, "era-gaze"),
    TZ: "UTC", LANG: "C.UTF-8", ERA_GATE_LANES: "2" };
  return w;
}
const keysOf = (w, { env = w.env, node = "v22.0.0" } = {}) =>
  reuse.computeKeys({ gate: w.gate, hub: w.hub, manifest: w.manifest, env, registryFile: w.registryFile, node });

// ---- the key ------------------------------------------------------------------------

test("every part of the key changes the keys it should and nothing else does", (t) => {
  const base = keysOf(world(t)).suites;
  const ALL = ["a.test.mjs", "b.test.mjs", "c.test.mjs"];
  const changed = (w, options) => {
    const after = keysOf(w, options).suites;
    return Object.keys(base).filter((id) => base[id].key !== after[id].key).map((id) => path.basename(id)).sort();
  };
  const cases = [
    // runtime: product content, by content only
    ["a product file", ALL, (w) => { w.manifest.repositories["era-hub"].files["server.js"].hash = "server-2"; }],
    ["a sibling repo's app file", ALL, (w) => { w.manifest.repositories["era-board"].files["app/board.js"].hash = "board-2"; }],
    ["the seed's contents", ALL, (w) => { w.manifest.configuration.seed.hash = "seed-2"; }],
    ["the served farm's contents", ALL, (w) => { w.manifest.servedFarm["public/board"].content.hash = "farm-2"; }],
    ["the private gate environment file", ALL, (w) => { w.manifest.configuration.gateEnvironment = "env-file-2"; }],
    ["a docs file", [], (w) => { w.manifest.repositories["era-hub"].files["docs/notes.md"].hash = "docs-2"; }],
    ["a repo root's markdown (README.md, AGENTS.md, CONTRIBUTING.md)", [], (w) => {
      Object.assign(w.manifest.repositories["era-hub"].files, { "README.md": { kind: "file", hash: "readme-2" }, "AGENTS.md": { kind: "file", hash: "agents-2" } });
      w.manifest.repositories["era-board"].files["CONTRIBUTING.md"] = { kind: "file", hash: "pointer-2" };
    }],
    ["markdown below a repo root is not docs", ALL, (w) => { w.manifest.repositories["era-board"].files["app/help.md"] = { kind: "file", hash: "help-2" }; }],
    ["a tests/ file seen through the manifest (its content is in the collected copies)", [],
      (w) => { w.manifest.repositories["era-hub"].files["tests/a.test.mjs"].hash = "test-2"; }],
    ["the registry and durations as manifest files", [], (w) => {
      w.manifest.repositories["era-hub"].files["tools/testing/registry.json"].hash = "registry-2";
      w.manifest.repositories["era-hub"].files["tools/testing/durations.json"].hash = "durations-2";
    }],
    ["the git index and head (not content)", [], (w) => { w.manifest.repositories["era-hub"].head = "h9"; w.manifest.repositories["era-hub"].index = "i9"; }],
    ["the test port, seed path and mode as configuration", [], (w) => {
      Object.assign(w.manifest.configuration, { testPort: "8388", seedDir: "/elsewhere", mode: "affected" });
    }],
    // external: outside the six roots
    ["the private scanner", ALL, (w) => put(path.join(w.root, "era-family/tools/era-scan.sh"), "PATTERNS='y'\n")],
    // helpers: any collected non-suite file
    ["a helper module", ALL, (w) => put(path.join(w.gate, "helper.mjs"), "export const helper = 2;\n")],
    ["a fixture", ALL, (w) => put(path.join(w.gate, "fixtures/data.json"), "{\"x\":1}\n")],
    // harness
    ["the lane runner", ALL, (w) => put(path.join(w.hub, "tools/testing/lanes.mjs"), "// the lanes, changed\n")],
    ["the gate script", ALL, (w) => put(path.join(w.hub, "tools/era-gate.sh"), "# the gate, changed\n")],
    // runtime versions
    ["playwright", ALL, (w) => put(path.join(w.root, "node_modules/playwright/package.json"), { version: "1.0.1" })],
    ["the chromium revision", ALL, (w) => put(path.join(w.root, "node_modules/playwright-core/browsers.json"), { browsers: [{ name: "chromium", revision: "101" }] })],
    // one suite's own parts
    ["a's collected copy (a port rewrite included)", ["a.test.mjs"], (w) => { put(path.join(w.gate, "a.test.mjs"), "// a, at 8388\n"); w.freeze(); }],
    ["a's registry entry (c reads the registry)", ["a.test.mjs", "c.test.mjs"], (w) => { w.registry.suites[0].purpose = "changed"; w.saveRegistry(); }],
    ["b's registry entry", ["b.test.mjs", "c.test.mjs"], (w) => { w.registry.suites[1].heavy = true; w.saveRegistry(); }],
    ["durations.json (only c names it)", ["c.test.mjs"], (w) => put(path.join(w.hub, "tools/testing/durations.json"), { default_s: 9, suites: {} })],
  ];
  for (const [what, expected, mutate] of cases) {
    const w = world(t);
    mutate(w);
    assert.deepEqual(changed(w), expected, what);
  }
  const env = (extra, drop = []) => { const w = world(t); const e = { ...w.env, ...extra }; for (const k of drop) delete e[k]; return changed(w, { env: e }); };
  assert.deepEqual(changed(world(t), { node: "v22.0.1" }), ALL, "node");
  assert.deepEqual(env({ TZ: "America/New_York" }), ALL, "TZ");
  assert.deepEqual(env({ LANG: "en_US.UTF-8" }), ALL, "LANG");
  assert.deepEqual(env({ ERA_NEW_SEAM: "1" }), ALL, "an ERA_ variable a suite can read");
  assert.deepEqual(env({ ERA_GATE_LANES: "3", ERA_GATE_RUNS: "/x", ERA_WT_SUFFIX: "--wt-y", ERA_TEST_JOBS: "/y" }), [], "harness-only variables");
  assert.deepEqual(env({ ERA_DATA_DIR: "/tmp/another-owned-copy" }), [], "the owned data dir's path");
  assert.deepEqual(env({}, ["ERA_GATE_LANES"]), [], "a harness variable unset");
});

test("the key's parts are printed once per gate, short enough to compare by eye", (t) => {
  const w = world(t);
  const shared = keysOf(w).shared;
  assert.deepEqual(Object.keys(shared), ["runtime", "external", "helpers", "harness", "node", "playwright", "env"]);
  assert.equal(shared.playwright, "1.0.0/1.0.0/chromium-100/headless-100");
  const r = plan(w);
  assert.equal(r.status, 0, r.stderr);
  const key = lines(r.stdout).find((l) => l.startsWith("reuse: key = "));
  assert.match(key, /^reuse: key = runtime [0-9a-f]{8} \+ external [0-9a-f]{8} \+ helpers [0-9a-f]{8} \+ harness [0-9a-f]{8} \+ node v\d+\.\d+\.\d+ \+ playwright 1\.0\.0\/1\.0\.0\/chromium-100\/headless-100 \+ env [0-9a-f]{8} \+ each suite's collected copy and registry entry \(and the files its keyInputs name\)$/);
});

// ---- what qualifies --------------------------------------------------------------

const NOW = Date.now();
const finished = (extra = {}) => ({ id: "R1", receipt: { checks: { inputs: "ok", hub: "ok", execution: "ok" }, guard: { changed: [] }, ...extra } });
const passLine = (extra = {}) => ({ suite: "x", key: "k", status: "pass", endedAt: new Date(NOW - HOUR).toISOString(), ...extra });

test("a pass qualifies for 24 hours, and not a second longer", () => {
  assert.equal(reuse.qualifies(passLine(), finished(), { now: NOW }), null);
  assert.equal(reuse.qualifies(passLine({ endedAt: new Date(NOW - 23.9 * HOUR).toISOString() }), finished(), { now: NOW }), null);
  assert.match(reuse.qualifies(passLine({ endedAt: new Date(NOW - 24 * HOUR - 1000).toISOString() }), finished(), { now: NOW }), /older than 24 h/);
  assert.match(reuse.qualifies(passLine({ endedAt: new Date(NOW + HOUR).toISOString() }), finished(), { now: NOW }), /not believable/);
  assert.match(reuse.qualifies(passLine({ endedAt: "never" }), finished(), { now: NOW }), /not believable/);
});

test("a FLAKY pass, a failure and a pass older than a failure on its key never qualify", () => {
  assert.match(reuse.qualifies(passLine({ flaky: true }), finished(), { now: NOW }), /FLAKY/);
  assert.match(reuse.qualifies(passLine({ status: "fail" }), finished(), { now: NOW }), /failed in R1/);
  assert.match(reuse.qualifies(passLine(), finished(), { now: NOW, lastFailure: NOW - 0.5 * HOUR }), /failed on these inputs after/);
  assert.equal(reuse.qualifies(passLine(), finished(), { now: NOW, lastFailure: NOW - 2 * HOUR }), null, "a pass after the failure stands");
});

test("a change to the shared hub's data disqualifies that run's shared readers, and only them", () => {
  const tainted = finished({ guard: { changed: ["writings/x.json"] } });
  assert.match(reuse.qualifies(passLine(), tainted, { now: NOW, hub: "shared-reader" }), /shared hub's data changed during R1/);
  assert.equal(reuse.qualifies(passLine(), tainted, { now: NOW, hub: "own" }), null);
  assert.equal(reuse.qualifies(passLine(), tainted, { now: NOW, hub: "none" }), null);
  assert.match(reuse.qualifies(passLine(), finished({ checks: { inputs: "ok", hub: "lost", execution: "ok" } }), { now: NOW, hub: "shared-reader" }), /lost its shared hub/);
  const crashed = { id: "R1", receipt: null };
  assert.match(reuse.qualifies(passLine(), crashed, { now: NOW, hub: "shared-reader" }), /did not finish/);
  assert.equal(reuse.qualifies(passLine(), crashed, { now: NOW, hub: "none" }), null, "a crashed run's own-process passes still count");
  assert.match(reuse.qualifies(passLine(), finished({ checks: { inputs: "changed", hub: "ok", execution: "ok" } }), { now: NOW }), /inputs changed/);
  assert.match(reuse.qualifies(passLine(), finished(), { now: NOW, hub: "shared-writer" }), /never reused/);
});

test("the guard ignores the hub's own bookkeeping and names every other changed file", (t) => {
  const data = scratch(t);
  for (const [file, text] of [["logs/hub.log", "a"], ["writings/one.json", "a"], ["recipes/today.json", "a"],
    ["pool/devices/gate.json", "a"], ["profile.json", "a"]]) put(path.join(data, file), text);
  const before = reuse.snapshotData(data);
  put(path.join(data, "logs/hub.log"), "b");
  put(path.join(data, "recipes/today.json"), "b");
  put(path.join(data, "pool/devices/gate.json"), "b");
  put(path.join(data, "presence/beacon.json"), "b");
  put(path.join(data, ".weather-cache.json"), "b");
  assert.deepEqual(reuse.guardChanges(before, reuse.snapshotData(data)), [], "the hub's own files");
  put(path.join(data, "writings/one.json"), "b");
  put(path.join(data, "content/new.json"), "b");
  fs.rmSync(path.join(data, "profile.json"));
  assert.deepEqual(reuse.guardChanges(before, reuse.snapshotData(data)), ["content/new.json", "profile.json", "writings/one.json"]);
});

test("resource failures are told apart from test failures", () => {
  assert.equal(reuse.classifyFailure({ exit: 124 }).resource, true);
  assert.equal(reuse.classifyFailure({ exit: 137 }).resource, true);
  assert.equal(reuse.classifyFailure({ exit: 1, output: "FATAL ERROR: Reached heap limit - JavaScript heap out of memory" }).resource, true);
  assert.equal(reuse.classifyFailure({ exit: 1, output: "Error: listen EADDRINUSE: address already in use" }).resource, true);
  assert.equal(reuse.classifyFailure({ exit: 1, output: "not ok 3 - the board shows six outfits" }).resource, false);
});

// ---- the plan over a store ---------------------------------------------------------

function plan(w, args = [], env = {}) {
  fs.rmSync(path.join(w.gate, ".reuse.json"), { force: true });
  fs.rmSync(path.join(w.gate, ".reuse-to-run"), { force: true });
  const r = spawnSync(process.execPath, [REUSE, "plan", w.gate, w.inputs, "--hub", w.hub, "--registry", w.registryFile, ...args], {
    env: { PATH: process.env.PATH, ...w.env, ERA_GATE_RUNS: w.store, ...env }, encoding: "utf8", timeout: 30_000,
  });
  const file = path.join(w.gate, ".reuse.json");
  const plan = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const decision = (name) => plan?.suites[`era-hub:tests/${name}`];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, plan, decision };
}
// What a gate run under that plan would have left: one results line per
// outcome ("pass", "fail", "flaky", "resource"; absent = did not finish) and,
// unless crashed, a receipt.
function finish(w, p, outcomes, { endedAt = new Date(Date.now() - HOUR).toISOString(), crashed = false, checks } = {}) {
  const runDir = p.plan.runDir;
  const rows = [];
  for (const [name, outcome] of Object.entries(outcomes)) {
    const id = `era-hub:tests/${name}`;
    const line = { suite: id, file: name, status: outcome === "pass" || outcome === "flaky" ? "pass" : "fail", exit: outcome === "resource" ? 137 : outcome === "fail" ? 1 : 0,
      seconds: 1, lane: 1, startedAt: endedAt, endedAt, key: p.plan.suites[id].key, attempt: 1 };
    if (outcome === "flaky") line.flaky = true;
    if (outcome === "resource") line.resource = true;
    rows.push(JSON.stringify(line));
  }
  fs.writeFileSync(path.join(runDir, "results.jsonl"), rows.join("\n") + "\n");
  if (!crashed) {
    const suites = {};
    for (const [id, d] of Object.entries(p.plan.suites)) if (d.decision === "reuse") suites[id] = { result: "reused", run: d.from, endedAt: d.endedAt };
    put(path.join(runDir, "receipt.json"), { version: 1, run: p.plan.run, checks: checks || { inputs: "ok", hub: "ok", execution: "ok" }, guard: { changed: [] }, suites });
  }
  return p.plan.run;
}

test("a cache-aware gate reuses what still qualifies, runs the rest, and says why", (t) => {
  const w = world(t);
  const first = plan(w);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(SUITES.map((n) => first.decision(n).decision), ["run", "run", "run"]);
  assert.match(first.stdout, /^reuse: 0 suites reused, 3 to run$/m);
  assert.match(first.stdout, /^reuse: to run, no earlier run of it: a\.test\.mjs, b\.test\.mjs, c\.test\.mjs$/m);
  assert.equal(fs.readFileSync(path.join(w.gate, ".reuse-to-run"), "utf8"), "3\n");
  const keys = JSON.parse(fs.readFileSync(path.join(first.plan.runDir, "keys.json"), "utf8"));
  assert.equal(keys.suites["era-hub:tests/a.test.mjs"].key, first.decision("a.test.mjs").key, "the run's record holds every key");
  for (const file of ["inputs.json", "plan.tsv", "env.json"]) assert.ok(fs.existsSync(path.join(first.plan.runDir, file)), file);
  const r1 = finish(w, first, { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "fail" });

  const second = plan(w);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.decision("a.test.mjs"), { key: first.decision("a.test.mjs").key, decision: "reuse", from: r1,
    endedAt: second.decision("a.test.mjs").endedAt });
  assert.equal(second.decision("b.test.mjs").decision, "reuse");
  assert.equal(second.decision("c.test.mjs").decision, "run");
  assert.equal(second.decision("c.test.mjs").priorFailures, 1, "its pass now would be FLAKY, its failure final");
  assert.match(second.stdout, /^reuse: 2 suites reused, 1 to run$/m);
  assert.match(second.stdout, new RegExp(`^reuse: to run, it failed in ${r1}: c\\.test\\.mjs$`, "m"));
  assert.equal(fs.readFileSync(path.join(w.gate, ".reuse-to-run"), "utf8"), "1\n");

  // a product change reruns everything, and says what changed
  w.manifest.repositories["era-hub"].files["server.js"].hash = "server-2"; w.saveManifest();
  const third = plan(w);
  assert.deepEqual(SUITES.map((n) => third.decision(n).decision), ["run", "run", "run"]);
  assert.match(third.stdout, new RegExp(`^reuse: to run, product files changed since ${r1}: a\\.test\\.mjs, b\\.test\\.mjs, c\\.test\\.mjs$`, "m"));

  // --no-cache reads nothing back: no reuse, no ledger
  w.manifest.repositories["era-hub"].files["server.js"].hash = "server-1"; w.saveManifest();
  const fresh = plan(w, ["--no-cache"]);
  assert.deepEqual(SUITES.map((n) => [fresh.decision(n).decision, fresh.decision(n).priorFailures]), [["run", 0], ["run", 0], ["run", 0]]);
  assert.match(fresh.stdout, /^reuse: to run, --no-cache: a\.test\.mjs, b\.test\.mjs, c\.test\.mjs$/m);
});

test("two failures on one key end its retries: the third gate refuses it without running it", (t) => {
  const w = world(t);
  finish(w, plan(w), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "fail" });
  const second = plan(w);
  finish(w, second, { "c.test.mjs": "fail" });
  const third = plan(w);
  assert.equal(third.decision("c.test.mjs").decision, "blocked");
  assert.equal(third.decision("c.test.mjs").priorFailures, 2);
  assert.match(third.stdout, /^reuse: 2 suites reused, 0 to run, 1 refused \(failed twice on these inputs\)$/m);
  // resource failures say nothing about the suite and never count
  const v = world(t);
  finish(v, plan(v), { "a.test.mjs": "resource", "b.test.mjs": "pass", "c.test.mjs": "pass" });
  finish(v, plan(v), { "a.test.mjs": "resource" });
  const next = plan(v);
  assert.deepEqual([next.decision("a.test.mjs").decision, next.decision("a.test.mjs").priorFailures], ["run", 0]);
  // a later failure outweighs an earlier pass on the same key
  const u = world(t);
  finish(u, plan(u), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "pass" }, { endedAt: new Date(Date.now() - 3 * HOUR).toISOString() });
  finish(u, plan(u, ["--no-cache"]), { "a.test.mjs": "fail", "b.test.mjs": "pass", "c.test.mjs": "pass" });
  assert.equal(plan(u).decision("a.test.mjs").decision, "run");
});

// ---- keyInputs: a suite that reads other suites' files ----------------------------
// tests/** is outside the runtime part on purpose: an unrelated test edit must
// not rerun every product suite. A suite that SCANS the other suites
// (suite-ports reads every collected suite for port claims and kill-by-name
// text; suite-classes derives the registry from every registered source)
// names what it reads in its registry entry, and those files' content joins
// its key alone. Without it, a fixed neighbour left suite-ports refused on an
// unchanged key, and a green suite-ports would be reused past a new pkill.

const SCANS = ["era-hub:tests/**", "era-board:tests/**"];
function scanningWorld(t) {
  const w = world(t);
  w.registry.suites[0].keyInputs = [...SCANS];
  w.saveRegistry();
  const file = (hash) => ({ kind: "file", hash, executable: false });
  Object.assign(w.manifest.repositories["era-hub"].files, { "tests/vm-e2e.test.mjs": file("vm-1"), "tests/fixtures/x.json": file("fx-1") });
  w.manifest.repositories["era-board"].files["tests/board.test.mjs"] = file("bt-1");
  w.manifest.repositories["era-core"] = { root: path.join(w.root, "era-core"), head: "h3", index: "i3", files: { "tests/core.test.mjs": file("ct-1") } };
  w.saveManifest();
  return w;
}

test("a suite with keyInputs re-keys when a matching file elsewhere changes, and only then", (t) => {
  const base = keysOf(scanningWorld(t)).suites;
  const changed = (mutate) => {
    const w = scanningWorld(t);
    mutate(w);
    const after = keysOf(w).suites;
    return Object.keys(base).filter((id) => base[id].key !== after[id].key).map((id) => path.basename(id)).sort();
  };
  const files = (w, repo) => w.manifest.repositories[repo].files;
  assert.deepEqual(changed((w) => { files(w, "era-hub")["tests/vm-e2e.test.mjs"].hash = "vm-2"; }), ["a.test.mjs"],
    "another suite's text in a scanned repo (tonight's fix in vm-e2e)");
  assert.deepEqual(changed((w) => { files(w, "era-board")["tests/board.test.mjs"].hash = "bt-2"; }), ["a.test.mjs"], "a scanned sibling repo");
  assert.deepEqual(changed((w) => { files(w, "era-hub")["tests/new.test.mjs"] = { kind: "file", hash: "new-1" }; }), ["a.test.mjs"],
    "a new test file (a kill by name or a duplicate port) can never ride a reused pass");
  assert.deepEqual(changed((w) => { delete files(w, "era-board")["tests/board.test.mjs"]; }), ["a.test.mjs"], "a removed one");
  assert.deepEqual(changed((w) => { files(w, "era-hub")["tests/fixtures/x.json"].executable = true; }), ["a.test.mjs"], "by content and mode, like the manifest");
  assert.deepEqual(changed((w) => { files(w, "era-core")["tests/core.test.mjs"].hash = "ct-2"; }), [], "a repo it does not name");
  assert.deepEqual(changed((w) => { files(w, "era-hub")["docs/notes.md"].hash = "docs-2"; }), [], "a file outside its patterns");
});

test("a suite without keyInputs keeps today's key for the same edits", (t) => {
  const w = scanningWorld(t);
  const before = keysOf(w);
  for (const id of ["era-hub:tests/b.test.mjs", "era-hub:tests/c.test.mjs"]) {
    const s = before.suites[id];
    assert.equal("scans" in s, false, `${id}: no scans part`);
    assert.equal(s.key, reuse.suiteKey(before.shared, { suite: s.suite, registry: s.registry }), `${id}: the key it had before keyInputs existed`);
  }
  w.manifest.repositories["era-hub"].files["tests/vm-e2e.test.mjs"].hash = "vm-2";
  w.manifest.repositories["era-board"].files["tests/board.test.mjs"].hash = "bt-2";
  const after = keysOf(w);
  assert.equal(after.suites["era-hub:tests/b.test.mjs"].key, before.suites["era-hub:tests/b.test.mjs"].key);
  assert.equal(after.suites["era-hub:tests/c.test.mjs"].key, before.suites["era-hub:tests/c.test.mjs"].key);
  assert.match(after.suites["era-hub:tests/a.test.mjs"].scans, /^[0-9a-f]{64}$/);
  assert.equal(reuse.PART_NAMES.scans, "the files it scans");
});

test("a scanner whose neighbour changed reruns, and the plan says why", (t) => {
  const w = scanningWorld(t);
  const r1 = finish(w, plan(w), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "pass" });
  w.manifest.repositories["era-hub"].files["tests/new.test.mjs"] = { kind: "file", hash: "new-1" }; w.saveManifest();
  const next = plan(w);
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(SUITES.map((n) => next.decision(n).decision), ["run", "reuse", "reuse"]);
  assert.match(next.stdout, new RegExp(`^reuse: to run, the files it scans changed since ${r1}: a\\.test\\.mjs$`, "m"));
});

test("the registry check accepts keyInputs and refuses a malformed one; the scanners carry it", async () => {
  const { validateClasses } = await import("../tools/testing/classify-suites.mjs");
  const entry = (keyInputs) => ({ version: 1, suites: [{ id: "era-hub:tests/x.test.mjs", retry: false, owner: "", keyInputs }] });
  assert.deepEqual(validateClasses(entry(["era-hub:tests/**", "era-board:tests/*.test.mjs"])), []);
  assert.deepEqual(validateClasses({ version: 1, suites: [{ id: "era-hub:tests/x.test.mjs", retry: false, owner: "" }] }), [], "absent is fine");
  for (const bad of [[], "era-hub:tests/**", ["tests/**"], ["era-hub:"], [7], ["era-hub:tests/**", "era-hub:tests/**"]]) {
    assert.equal(validateClasses(entry(bad)).length, 1, `refused: ${JSON.stringify(bad)}`);
  }
  const registry = JSON.parse(fs.readFileSync(path.join(HUB, "tools/testing/registry.json"), "utf8"));
  const every = ["era-board", "era-core", "era-hub", "era-making-words", "era-pencil"].map((r) => `${r}:tests/**`);
  const scanners = registry.suites.filter((s) => s.keyInputs).map((s) => s.id).sort();
  assert.deepEqual(scanners, ["era-hub:tests/suite-classes.test.mjs", "era-hub:tests/suite-ports.test.mjs"]);
  for (const id of scanners) assert.deepEqual(registry.suites.find((s) => s.id === id).keyInputs, every, id);
});

test("a refused suite's message names what its key covers and the way out", (t) => {
  const w = world(t);
  const r0 = finish(w, plan(w), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "pass" }, { endedAt: new Date(Date.now() - 3 * HOUR).toISOString() });
  put(path.join(w.gate, "c.test.mjs"), "// reads tools/testing/registry.json, edited\n"); w.freeze();
  const r1 = finish(w, plan(w), { "c.test.mjs": "fail" }, { endedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
  const r2 = finish(w, plan(w), { "c.test.mjs": "fail" });
  const third = plan(w);
  assert.equal(third.decision("c.test.mjs").decision, "blocked");
  assert.match(third.stdout, /^reuse: 2 suites reused, 0 to run, 1 refused \(failed twice on these inputs\)$/m, "the count line keeps its shape");
  const line = lines(third.stdout).find((l) => l.startsWith("reuse: refused c.test.mjs: "));
  assert.ok(line, third.stdout);
  assert.ok(line.includes(`last in ${r2}`), line);
  assert.ok(line.includes(`since its last pass (${r0}) the suite changed`), line);
  assert.ok(line.includes("--only c.test.mjs") && line.includes("--no-cache"), line);
  assert.equal(third.decision("c.test.mjs").refusal, line.slice("reuse: refused c.test.mjs: ".length), "the lanes print the same words");
  void r1;
});

test("--rerun-failed reruns exactly what failed or did not finish, and refuses when a pass there no longer stands", (t) => {
  const w = world(t);
  const r1 = finish(w, plan(w), { "a.test.mjs": "pass", "b.test.mjs": "fail" }, { crashed: true });
  const again = plan(w, ["--rerun-failed", r1]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(SUITES.map((n) => again.decision(n).decision), ["reuse", "run", "run"], "b failed there; c never finished");
  assert.equal(again.plan.mode, "rerun-failed");
  assert.equal(again.plan.from, r1);
  assert.match(again.stdout, new RegExp(`^reuse: store .*; this run \\S+ \\(rerun-failed from ${r1}\\)$`, "m"));
  assert.equal(plan(w, ["--rerun-failed", "latest"]).status, 0, "latest names this checkout's newest run");
  const elsewhere = world(t);
  assert.match(plan(elsewhere, ["--rerun-failed", "latest"], { ERA_GATE_RUNS: w.store }).stderr, /no earlier gate run of .* under/,
    "another worktree's runs share the store but are never its latest");
  assert.equal(plan(w, ["--rerun-failed", path.join(w.store, r1)]).status, 0, "or its directory");

  put(path.join(w.gate, "a.test.mjs"), "// a, edited\n"); w.freeze();
  const refused = plan(w, ["--rerun-failed", r1]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`^FATAL: --rerun-failed ${r1}: 1 suite that passed there cannot be reused now`, "m"));
  assert.match(refused.stderr, new RegExp(`^  a\\.test\\.mjs: the suite changed since ${r1}$`, "m"));
  assert.equal(refused.plan, null, "nothing planned, nothing recorded");
  assert.match(plan(w, ["--rerun-failed", "2026-01-01T00-00-00Z-0000000"]).stderr, /no gate run/);
});

test("--restamp writes no plan unless every suite has a qualifying pass inside the evidence bound", (t) => {
  const w = world(t);
  const r1 = finish(w, plan(w), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "pass" });
  const ok = plan(w, ["--restamp", r1]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(path.join(w.gate, ".reuse-to-run"), "utf8"), "0\n", "nothing runs, so no hub starts");
  assert.match(ok.stdout, /^reuse: restamp: every suite has a qualifying pass; nothing runs$/m);
  // a restamp's own record cites its sources, so it can be restamped from in turn
  const r2 = finish(w, ok, {});
  assert.equal(plan(w, ["--restamp", r2]).status, 0);

  put(path.join(w.gate, "helper.mjs"), "export const helper = 3;\n");
  const changedKey = plan(w, ["--restamp", r1]);
  assert.equal(changedKey.status, 1);
  assert.match(changedKey.stderr, /^FATAL: --restamp \S+: 3 suites have no qualifying pass, so a stamp needs a run:$/m);
  assert.match(changedKey.stderr, /^  a\.test\.mjs: test helpers changed since/m);

  const old = world(t);
  const stale = finish(old, plan(old), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "pass" }, { endedAt: new Date(Date.now() - 25 * HOUR).toISOString() });
  const tooOld = plan(old, ["--restamp", stale]);
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.stderr, /older than 24 h/);

  const flaky = world(t);
  const withFlake = finish(flaky, plan(flaky), { "a.test.mjs": "pass", "b.test.mjs": "flaky", "c.test.mjs": "pass" });
  assert.match(plan(flaky, ["--restamp", withFlake]).stderr, /^  b\.test\.mjs: its pass in \S+ came after a failure \(FLAKY\)$/m);
});

test("without a writable store the gate says so once and runs every suite fresh", (t) => {
  const w = world(t);
  const noHome = spawnSync(process.execPath, [REUSE, "plan", w.gate, w.inputs, "--hub", w.hub, "--registry", w.registryFile], {
    env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(noHome.status, 0, noHome.stderr);
  assert.deepEqual(lines(noHome.stdout), ["reuse: no writable run store (neither ERA_GATE_RUNS nor HOME is set); every suite runs fresh, nothing is retried or recorded"]);
  assert.ok(!fs.existsSync(path.join(w.gate, ".reuse.json")), "no plan: the lanes run as they always did");
  const blocked = path.join(w.root, "not-a-directory");
  fs.writeFileSync(blocked, "");
  const r = plan(w, [], { ERA_GATE_RUNS: blocked });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^reuse: no writable run store \(.*not-a-directory\)/m);
  assert.equal(r.plan, null);
  const restamp = plan(w, ["--restamp", "latest"], { ERA_GATE_RUNS: blocked });
  assert.equal(restamp.status, 1);
  assert.match(restamp.stderr, /--restamp needs the run store/);
});

// ---- the lane runner's retry -------------------------------------------------------

// A gate dir for lanes.mjs with a fake node: `// EXIT=n` exits n; `// FLAKY`
// fails the first time and passes the second; `// SAY=text` prints text.
function lanesGate(t, suites, decisions = {}, { store = true } = {}) {
  const root = scratch(t), gate = path.join(root, "gate"), bin = path.join(root, "bin"), runDir = path.join(root, "store", "RUN-NOW");
  fs.mkdirSync(gate); fs.mkdirSync(bin); fs.mkdirSync(runDir, { recursive: true });
  put(path.join(bin, "node"), `#!/bin/sh
for a; do f="$a"; done
e=$(sed -n 's|^// EXIT=||p' "$f"); say=$(sed -n 's|^// SAY=||p' "$f")
[ -n "$say" ] && echo "$say"
if grep -q '^// FLAKY' "$f"; then
  if [ -f "$f.seen" ]; then exit 0; fi
  : >"$f.seen"; exit 1
fi
exit "\${e:-0}"
`);
  fs.chmodSync(path.join(bin, "node"), 0o755);
  const plan = [], registry = { suites: [] }, reuseFile = { version: 1, store: path.join(root, "store"), run: "RUN-NOW", runDir, budget: 1, suites: {} };
  for (const s of suites) {
    const id = `era-hub:tests/${s.name}`;
    const body = [`// EXIT=${s.exit ?? 0}`, ...(s.flaky ? ["// FLAKY"] : []), ...(s.say ? [`// SAY=${s.say}`] : [])].join("\n") + "\n";
    put(path.join(gate, s.name), body);
    plan.push([id, s.name, digest(body)].join("\t"));
    registry.suites.push({ id, hub: "none", ports: [], heavy: false, solo: false, quiet: false });
    reuseFile.suites[id] = { key: `key-${s.name}`, decision: "run", priorFailures: 0, lastFailure: null, ...(decisions[s.name] || {}) };
  }
  put(path.join(gate, ".execution-plan.tsv"), plan.join("\n") + "\n");
  if (store) put(path.join(gate, ".reuse.json"), reuseFile);
  const files = { registry: path.join(root, "registry.json"), durations: path.join(root, "durations.json"), meminfo: path.join(root, "meminfo") };
  put(files.registry, registry);
  put(files.durations, { default_s: 1, suites: {} });
  put(files.meminfo, "MemAvailable:   16000000 kB\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, gate, "--registry", files.registry, "--durations", files.durations, "--meminfo", files.meminfo,
    "--lanes", "2", "--hold-ms", "100", "--grace-ms", "1000"], { cwd: gate, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.error, undefined);
  const results = fs.existsSync(path.join(gate, "results.jsonl")) ? fs.readFileSync(path.join(gate, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const tally = fs.existsSync(path.join(gate, ".lane-results.tsv")) ? lines(fs.readFileSync(path.join(gate, ".lane-results.tsv"), "utf8")).map((l) => l.split("\t")) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: lines(r.stdout), results, tally, gate, runDir, plan };
}
const stateOf = (r, name) => r.tally.find((row) => row[3] === `era-hub:tests/${name}`)?.[0];

test("a suite that fails once on identical inputs runs once more, alone, at the end: FLAKY, and the gate is green", (t) => {
  const r = lanesGate(t, [{ name: "steady.test.mjs" }, { name: "racy.test.mjs", flaky: true }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.out.includes("FAIL racy.test.mjs (see gate/racy.test.out)"));
  assert.ok(r.out.includes("retry: racy.test.mjs failed once; running it again, alone, at the end of the gate"));
  assert.equal(r.out.filter((l) => l === "RUN racy.test.mjs").length, 2);
  assert.equal(r.out.at(-1), "FLAKY racy.test.mjs (passed on retry)");
  assert.equal(stateOf(r, "racy.test.mjs"), "flaky");
  assert.equal(stateOf(r, "steady.test.mjs"), "pass");
  const racy = r.results.filter((l) => l.file === "racy.test.mjs");
  assert.deepEqual(racy.map((l) => [l.status, l.attempt, !!l.flaky, l.key]), [["fail", 1, false, "key-racy.test.mjs"], ["pass", 2, true, "key-racy.test.mjs"]]);
  assert.ok(fs.existsSync(path.join(r.gate, "racy.test.out.attempt1")), "the first failure's output is kept");
  const mirrored = fs.readFileSync(path.join(r.runDir, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(mirrored, r.results, "every attempt reaches the run store as it ends");
});

test("a resource failure is never retried", (t) => {
  for (const [suite, why] of [
    [{ name: "killed.test.mjs", exit: 137 }, "it was killed (exit 137)"],
    [{ name: "slow.test.mjs", exit: 124 }, "it timed out (exit 124)"],
    [{ name: "port.test.mjs", exit: 1, say: "Error: listen EADDRINUSE: address already in use" }, "EADDRINUSE in its output"],
  ]) {
    const r = lanesGate(t, [suite]);
    assert.equal(r.status, 1);
    assert.ok(r.out.includes(`retry: ${suite.name} is not retried: ${why}`), r.stdout);
    assert.equal(r.out.filter((l) => l === `RUN ${suite.name}`).length, 1);
    assert.equal(r.results[0].resource, true, "and the ledger will not count it");
  }
});

test("a second failure on one key is red with no retry, in this run or a stored one", (t) => {
  const stored = lanesGate(t, [{ name: "again.test.mjs", flaky: true }], { "again.test.mjs": { priorFailures: 1, lastFailure: { run: "RUN-BEFORE" } } });
  assert.equal(stored.status, 1);
  assert.ok(stored.out.includes("retry: again.test.mjs failed before on these inputs (RUN-BEFORE); not retried"), stored.stdout);
  assert.equal(stored.out.filter((l) => l === "RUN again.test.mjs").length, 1);

  const twice = lanesGate(t, [{ name: "broken.test.mjs", exit: 1 }]);
  assert.equal(twice.status, 1);
  assert.equal(twice.out.at(-1), "FAIL broken.test.mjs (failed again on retry; see gate/broken.test.out)");
  assert.deepEqual(twice.results.map((l) => [l.status, l.attempt]), [["fail", 1], ["fail", 2]], "two failures on one key: the next gate refuses it");
  assert.equal(stateOf(twice, "broken.test.mjs"), "fail");

  const blocked = lanesGate(t, [{ name: "ok.test.mjs" }, { name: "done.test.mjs" }], { "done.test.mjs": { decision: "blocked", priorFailures: 2, lastFailure: { run: "RUN-BEFORE" } } });
  assert.equal(blocked.status, 1);
  assert.ok(blocked.out.includes("FAIL done.test.mjs (failed twice on these inputs, last in RUN-BEFORE; not run until it or what it tests changes)"), blocked.stdout);
  assert.ok(!blocked.out.includes("RUN done.test.mjs"));
  assert.equal(stateOf(blocked, "done.test.mjs"), "blocked");
  const at = blocked.out.indexOf("FAIL done.test.mjs (failed twice on these inputs, last in RUN-BEFORE; not run until it or what it tests changes)");
  assert.equal(blocked.out[at + 1], "refused: done.test.mjs: its key is the same at both failures; if what you fixed is not in its key," +
    " run it with --only done.test.mjs or the gate with --no-cache", "the way out, right under the refusal");
  const told = lanesGate(t, [{ name: "done.test.mjs" }], { "done.test.mjs": { decision: "blocked", priorFailures: 2, lastFailure: { run: "R" }, refusal: "the plan's words" } });
  assert.ok(told.out.includes("refused: done.test.mjs: the plan's words"), told.stdout);
});

test("one retry per gate: two failures retry nothing, and a second FLAKY pass is red", (t) => {
  const two = lanesGate(t, [{ name: "x.test.mjs", flaky: true }, { name: "y.test.mjs", flaky: true }]);
  assert.equal(two.status, 1);
  assert.ok(two.out.includes("retry: 2 suites failed, more than this gate's retry budget of 1; none is retried"), two.stdout);
  const after = { priorFailures: 1, lastFailure: { run: "RUN-BEFORE" } };
  const passes = lanesGate(t, [{ name: "p.test.mjs" }, { name: "q.test.mjs" }], { "p.test.mjs": after, "q.test.mjs": after });
  assert.equal(passes.status, 1);
  const flaky = passes.out.filter((l) => l.startsWith("FLAKY "));
  assert.equal(flaky.length, 1, passes.stdout);
  assert.match(flaky[0], /^FLAKY [pq]\.test\.mjs \(passed after a failure on these inputs in RUN-BEFORE\)$/);
  assert.equal(passes.out.filter((l) => /^FAIL [pq]\.test\.mjs \(passed only after a failure on these inputs; this gate's one retry is spent\)$/.test(l)).length, 1);
});

test("reused suites print REUSE, never start, and enter the tally with their frozen digest", (t) => {
  const at = "2026-10-27T01:02:03Z";
  const r = lanesGate(t, [{ name: "kept.test.mjs" }, { name: "new.test.mjs" }], { "kept.test.mjs": { decision: "reuse", from: "RUN-BEFORE", endedAt: at } });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.out.includes(`REUSE kept.test.mjs (from RUN-BEFORE at ${at})`));
  assert.ok(!r.out.includes("RUN kept.test.mjs"));
  const row = r.tally.find((x) => x[3] === "era-hub:tests/kept.test.mjs");
  assert.deepEqual([row[0], row[2]], ["reused", r.plan[0].split("\t")[2]]);
  assert.deepEqual(r.results.map((l) => l.file), ["new.test.mjs"], "results.jsonl holds what ran here");
  const without = lanesGate(t, [{ name: "racy.test.mjs", flaky: true }], {}, { store: false });
  assert.deepEqual(without.out, ["lanes: 2 (memory floor 2048 MiB)", "RUN racy.test.mjs", "FAIL racy.test.mjs (see gate/racy.test.out)"],
    "with no store there is no plan, no retry and no new line");
});

// ---- the gate's tally, the record, the stamp ---------------------------------------

test("the gate's tally counts reused and FLAKY passes as passes and a refused suite as a failure", (t) => {
  const gate = scratch(t);
  const names = ["kept.test.mjs", "racy.test.mjs", "plain.test.mjs", "done.test.mjs", "broken.test.mjs"];
  const plan = names.map((n) => [`era-hub:tests/${n}`, n, digest(n)]);
  put(path.join(gate, ".execution-plan.tsv"), plan.map((r) => r.join("\t")).join("\n") + "\n");
  const states = ["reused", "flaky", "pass", "blocked", "fail"];
  put(path.join(gate, ".lane-results.tsv"), plan.map((r, i) => [states[i], i, r[2], r[0]].join("\t")).join("\n") + "\n");
  const script = ["set -uo pipefail", ...["gate_error", "gate_record_execution", "gate_verify_execution", "gate_record_results"].map(fnOf),
    'EXPECTED_IDS=(); EXPECTED_FILES=(); EXPECTED_HASHES=(); declare -gA EXECUTED_COUNT=()',
    'while IFS=$\'\\t\' read -r id name digest; do EXPECTED_IDS+=("$id"); EXPECTED_FILES+=("$name"); EXPECTED_HASHES+=("$digest"); done <"$GATE/.execution-plan.tsv"',
    'pass=0; fail=0; failed=""', 'gate_record_results 1',
    'gate_verify_execution || { fail=$((fail+1)); failed="$failed execution-set"; }',
    'echo "== era-gate: $pass passed, $fail failed${failed:+ →$failed} =="'].join("\n");
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, GATE: gate }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "== era-gate: 3 passed, 2 failed → done.test.mjs broken.test.mjs ==", r.stderr);
  // all reused: the same line a fresh green gate prints
  put(path.join(gate, ".lane-results.tsv"), plan.map((r, i) => ["reused", i, r[2], r[0]].join("\t")).join("\n") + "\n");
  const green = spawnSync("bash", ["-c", script.replace("gate_record_results 1", "gate_record_results 0")], { env: { ...process.env, GATE: gate }, encoding: "utf8" });
  assert.equal(green.stdout.trim(), "== era-gate: 5 passed, 0 failed ==", green.stderr);
});

test("the record writes the receipt, the flake ledger with the first failure's last 20 lines, and one receipt line", (t) => {
  const root = scratch(t), gate = path.join(root, "gate"), store = path.join(root, "store"), runDir = path.join(store, "RUN-NOW"), data = path.join(root, "data");
  fs.mkdirSync(runDir, { recursive: true });
  put(path.join(data, "writings/one.json"), "a");
  put(path.join(gate, ".guard-start.json"), reuse.snapshotData(data));
  put(path.join(data, "writings/one.json"), "b");
  const kept = new Date(Date.now() - 2 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
  put(path.join(gate, ".reuse.json"), { version: 1, store, run: "RUN-NOW", runDir, mode: "full", from: null, noCache: false, tree: "t", head: "h", createdAt: kept,
    suites: { "era-hub:tests/kept.test.mjs": { key: "k1", decision: "reuse", from: "RUN-BEFORE", endedAt: kept },
      "era-hub:tests/racy.test.mjs": { key: "k2", decision: "run", priorFailures: 0 },
      "era-hub:tests/plain.test.mjs": { key: "k3", decision: "run", priorFailures: 0 } } });
  put(path.join(gate, ".lane-results.tsv"), ["reused\t0\td\tera-hub:tests/kept.test.mjs", "flaky\t1\td\tera-hub:tests/racy.test.mjs", "pass\t2\td\tera-hub:tests/plain.test.mjs"].join("\n") + "\n");
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  put(path.join(gate, "results.jsonl"), [
    { suite: "era-hub:tests/plain.test.mjs", file: "plain.test.mjs", status: "pass", exit: 0, seconds: 2, endedAt: at(60), key: "k3", attempt: 1 },
    { suite: "era-hub:tests/racy.test.mjs", file: "racy.test.mjs", status: "fail", exit: 1, seconds: 5, endedAt: at(50), key: "k2", attempt: 1 },
    { suite: "era-hub:tests/racy.test.mjs", file: "racy.test.mjs", status: "pass", exit: 0, seconds: 4, endedAt: at(10), key: "k2", attempt: 2, flaky: true },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  put(path.join(gate, "racy.test.out.attempt1"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  put(path.join(gate, "racy.test.out"), "ok\n");
  const r = spawnSync(process.execPath, [REUSE, "record", gate, "--data", data, "--checks", "inputs=ok,hub=ok,execution=ok", "--pass", "3", "--fail", "0",
    "--summary", "== era-gate: 3 passed, 0 failed =="], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r.stdout);
  assert.equal(out[0], "guard: the shared hub's data changed during the run (writings/one.json); this run's shared-reader passes will not be reused");
  assert.match(out[1], new RegExp(`^receipt: 1 reused, 2 run fresh \\(1 FLAKY\\); oldest reused evidence ${kept} \\(\\d+\\.\\d h old\\); ${runDir}/receipt\\.json$`));
  const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8"));
  assert.deepEqual(receipt.suites["era-hub:tests/kept.test.mjs"], { result: "reused", run: "RUN-BEFORE", endedAt: kept });
  assert.equal(receipt.suites["era-hub:tests/racy.test.mjs"].result, "flaky");
  assert.deepEqual([receipt.green, receipt.counts, receipt.oldestEvidence, receipt.guard.changed], [true, { suites: 3, reused: 1, fresh: 2, flaky: 1 }, kept, ["writings/one.json"]]);
  assert.deepEqual([receipt.summary, receipt.line], ["== era-gate: 3 passed, 0 failed ==", out[1]], "the summary and receipt lines, for tools/gate-wait.sh");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gate, "receipt.json"), "utf8")), receipt, "and a copy in gate/");
  const [flake] = fs.readFileSync(path.join(store, "flakes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(flake.suite, "era-hub:tests/racy.test.mjs");
  assert.equal(flake.key, "k2");
  assert.equal(flake.run, "RUN-NOW");
  assert.deepEqual([flake.first.seconds, flake.pass.seconds], [5, 4]);
  assert.deepEqual(flake.first.tail, Array.from({ length: 20 }, (_, i) => `line ${i + 11}`));
  assert.ok(fs.existsSync(path.join(runDir, "suites", "racy.test.out.attempt1")), "outputs are kept with the run");
});

test("composition keeps the stamp's 4 lines, prints the receipt before the summary, and the summary last", (t) => {
  // the stamp itself, from a tally of reused passes, through the shipped functions
  const root = scratch(t), hub = path.join(root, "era-hub"), stamps = path.join(root, "stamps");
  fs.mkdirSync(hub);
  put(path.join(hub, "file.txt"), "x\n");
  const git = (...args) => spawnSync("git", ["-C", hub, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "init");
  const sib = GATE_SCRIPT.match(/^sib\(\) \{[^\n]*\}$/m)[0];
  const r = spawnSync("bash", ["-c", [sib, fnOf("stamp_tree"), fnOf("write_green_stamp"), "write_green_stamp"].join("\n")], {
    env: { ...process.env, ROOT: root, HUB: hub, ERA_GATE_STAMPS: stamps, pass: "164", fail: "0", failed: "", ERA_WT_SUFFIX: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [name] = fs.readdirSync(stamps);
  const stamp = fs.readFileSync(path.join(stamps, name), "utf8");
  assert.match(stamp, new RegExp(`^== era-gate: 164 passed, 0 failed ==\\nhead=[0-9a-f]{40}\\nat=\\d+\\nhub=${hub}\\n$`));

  // the order in the shipped gate: record (guard + receipt lines), then the stamp, then the summary
  const tail = GATE_SCRIPT.slice(GATE_SCRIPT.search(/^gate_record_results "\$lanes_status"$/m));
  const record = tail.search(/^\s*gate_record_run$/m), stampAt = tail.search(/^\s*\[ "\$fail" -eq 0 \] && write_green_stamp$/m);
  const summary = tail.search(/^\s*echo "== era-gate: \$pass passed, \$fail failed\$\{failed:\+ →\$failed\} =="$/m);
  assert.ok(record > 0 && stampAt > record && summary > stampAt, "record, stamp, summary");
  assert.equal(tail.slice(summary).split("\n")[1], "else", "the summary line is the full gate's last word");
});

// ---- the gate script's options and wiring --------------------------------------------

test("the gate's options: --no-cache, --rerun-failed RUN, --restamp RUN, --only SUITES, and nothing else", () => {
  const parse = (...args) => spawnSync("bash", ["-c", `set -uo pipefail\n${fnOf("gate_error")}\n${fnOf("gate_parse_options")}\n` +
    'GATE_NO_CACHE=0; GATE_RERUN=""; GATE_RESTAMP=""; GATE_ONLY=""\ngate_parse_options "$@" || exit\n' +
    'echo "$GATE_NO_CACHE|$GATE_RERUN|$GATE_RESTAMP|$GATE_ONLY"', "gate", ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  const ok = (args, expected) => { const r = parse(...args); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), expected, args.join(" ")); };
  const refused = (args, reason) => { const r = parse(...args); assert.notEqual(r.status, 0, args.join(" ")); assert.match(r.stderr, reason, args.join(" ")); };
  ok([], "0|||");
  ok(["--no-cache"], "1|||");
  ok(["--rerun-failed", "latest"], "0|latest||");
  ok(["--restamp", "2026-10-27T03-15-22Z-abc1234"], "0||2026-10-27T03-15-22Z-abc1234|");
  ok(["--only", "lanes,gate-stamp.test.mjs"], "0|||lanes,gate-stamp.test.mjs");
  refused(["--bogus"], /unknown option: --bogus/);
  refused(["--rerun-failed"], /--rerun-failed needs a value/);
  refused(["--restamp", "--no-cache"], /--restamp needs a value/);
  refused(["--rerun-failed", "a", "--restamp", "b"], /exclude one another/);
  refused(["--no-cache", "--restamp", "b"], /--no-cache/);
});

test("--only resolves suite IDs and file names to the selection the gate's affected mode runs", (t) => {
  const file = path.join(scratch(t), "selection.json");
  const r = spawnSync(process.execPath, [REUSE, "select", "lanes,gate-stamp.test.mjs,era-pencil:tests/pencil.js,run", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), ["era-hub:tests/lanes.test.mjs", "era-hub:tests/gate-stamp.test.mjs",
    "era-pencil:tests/pencil.js", "era-making-words:tests/run.js"]);
  const unknown = spawnSync(process.execPath, [REUSE, "select", "lanes,no-such-suite", file], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown suite: no-such-suite/);
  assert.match(GATE_SCRIPT, /^\s*node "\$HUB\/tools\/testing\/reuse\.mjs" select "\$GATE_ONLY" "\$ERA_GATE_SELECTED" \|\| exit 1$/m);
  assert.match(GATE_SCRIPT, /^\s*export ERA_GATE_MODE=affected ERA_GATE_SELECTED="\$GATE\/\.only-selection\.json"$/m,
    "--only is the affected mode: named suites, no stamp, no store");
});

test("the gate plans reuse after its environment is final, starts no hub when nothing runs, and guards the hub's data", () => {
  const at = (re) => { const i = GATE_SCRIPT.search(re); assert.ok(i > 0, String(re)); return i; };
  const exported = at(/^export ERA_CHAT_CONFIG_DISABLED=1$/m);
  const planned = at(/^\s*node "\$HUB\/tools\/testing\/reuse\.mjs" plan "\$GATE" "\$ERA_GATE_INPUTS" "\$\{GATE_REUSE_ARGS\[@\]\}" \|\| exit 1$/m);
  const nothing = at(/^\s*\[ "\$\(cat "\$GATE\/\.reuse-to-run" 2>\/dev\/null\)" != 0 \] \|\| GATE_HUB=0$/m);
  const hubIf = at(/^if \[ "\$GATE_HUB" = 1 \]; then$/m);
  const launch = at(/^\s*"\$NODE_BIN" "\$HUB\/server\.js" "\$PORT" >"\$GATE\/server\.log" 2>&1 &$/m);
  const build = at(/^\s*gate_build_clothing "\$PORT" \|\| \{/m);
  const guard = at(/^\s*\[ ! -f "\$GATE\/\.reuse\.json" \] \|\| node "\$HUB\/tools\/testing\/reuse\.mjs" guard "\$DATA" "\$GATE\/\.guard-start\.json" \|\| exit 1$/m);
  const lanes = at(/^node "\$HUB\/tools\/testing\/lanes\.mjs" "\$GATE" <&0 &$/m);
  assert.ok(exported < planned && planned < nothing && nothing < hubIf && hubIf < launch && launch < build && build < guard && guard < lanes,
    "env final, then the plan, then the hub only if something runs, its one build, the guard's first look, then the suites");
  assert.match(GATE_SCRIPT, /^\s*if \[ "\$GATE_HUB" = 1 \]; then\n\s*gate_wait_server "\$SRV" "\$SRV_ID" "\$SRV_ARGS" "\$PORT" 1 \|\| \{/m,
    "the shared hub's identity is checked only when it was started");
  assert.match(GATE_SCRIPT, /^\s*\[ "\$\{ERA_GATE_MODE:-full\}" = full \] \|\| return 0$/m, "affected and --only runs neither read nor write the store");
});

test("end to end through the gate's own text: a restamp starts no hub, reuses every suite, and composes the stamp", (t) => {
  // The gate's tail from its reuse plan to its last line, under bash, against a
  // synthetic gate dir and store. verify-inputs is the one stand-in (the
  // manifest is synthetic) and write_green_stamp only says it ran (its bytes
  // are proved above); everything else is the shipped text and tools.
  const w = world(t), data = scratch(t);
  const env = { PATH: process.env.PATH, ...w.env, ERA_GATE_RUNS: w.store };
  const planned = () => {
    fs.rmSync(path.join(w.gate, ".reuse.json"), { force: true });
    const r = spawnSync(process.execPath, [REUSE, "plan", w.gate, w.inputs], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { plan: JSON.parse(fs.readFileSync(path.join(w.gate, ".reuse.json"), "utf8")) };
  };
  const r1 = finish(w, planned(), { "a.test.mjs": "pass", "b.test.mjs": "pass", "c.test.mjs": "pass" });
  const tail = GATE_SCRIPT.slice(GATE_SCRIPT.indexOf("GATE_HUB=1\n"));
  const script = ["set -uo pipefail",
    ...["gate_error", "gate_process_identity", "gate_record_execution", "gate_verify_execution", "gate_record_results",
      "gate_record_run", "gate_archive_reports"].map(fnOf),
    'write_green_stamp() { echo "stamp: written"; }',
    'node() { if [ "${2:-}" = verify-inputs ]; then return 0; fi; command node "$@"; }',
    'EXPECTED_IDS=(); EXPECTED_FILES=(); EXPECTED_HASHES=(); declare -gA EXECUTED_COUNT=()',
    'while IFS=$\'\\t\' read -r id name digest; do EXPECTED_IDS+=("$id"); EXPECTED_FILES+=("$name"); EXPECTED_HASHES+=("$digest"); done <"$GATE/.execution-plan.tsv"',
    tail].join("\n");
  const gate = (extra) => spawnSync("bash", ["-c", script], { env: { ...env, HUB, GATE: w.gate, DATA: data, ERA_GATE_INPUTS: w.inputs,
    GATE_NO_CACHE: "0", GATE_RERUN: "", GATE_RESTAMP: "", ...extra }, encoding: "utf8", timeout: 60_000 });

  const r = gate({ GATE_RESTAMP: r1 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = lines(r.stdout);
  const ended = (name) => JSON.parse(fs.readFileSync(path.join(w.store, r1, "results.jsonl"), "utf8").split("\n").find((l) => l.includes(`"${name}"`))).endedAt.replace(/\.\d{3}Z$/, "Z");
  assert.deepEqual(out.filter((l) => !l.startsWith("reuse: store ") && !l.startsWith("reuse: key = ") && !l.startsWith("receipt: ")), [
    "reuse: 3 suites reused, 0 to run",
    "reuse: restamp: every suite has a qualifying pass; nothing runs",
    "reuse: nothing to run; the shared hub is not started",
    "lanes: 2 (memory floor 2048 MiB)",
    ...SUITES.map((n) => `REUSE ${n} (from ${r1} at ${ended(n)})`),
    "stamp: written",
    "== era-gate: 3 passed, 0 failed ==",
  ]);
  const receiptAt = out.findIndex((l) => l.startsWith("receipt: "));
  assert.match(out[receiptAt], /^receipt: 3 reused, 0 run fresh; oldest reused evidence \S+ \(1\.0 h old\); \S+\/receipt\.json$/);
  assert.ok(receiptAt < out.indexOf("stamp: written"), "the receipt precedes the stamp and the summary");
  const receipt = JSON.parse(fs.readFileSync(path.join(w.gate, "receipt.json"), "utf8"));
  assert.deepEqual([receipt.mode, receipt.from, receipt.checks, receipt.green], ["restamp", r1, { inputs: "ok", hub: "none", execution: "ok" }, true]);
  assert.ok(!fs.existsSync(path.join(w.gate, "server.log")), "no shared hub was started");
  // what tools/gate-wait.sh reads back: the gate's pid in keys.json, its summary and receipt lines in receipt.json
  const keys = JSON.parse(fs.readFileSync(path.join(w.store, receipt.run, "keys.json"), "utf8"));
  assert.ok(Number.isInteger(keys.pid) && keys.pid > 1, "the gate's pid");
  assert.deepEqual([receipt.summary, receipt.line], [out.at(-1), out[receiptAt]]);

  // a refusal stops the gate before any hub or suite
  put(path.join(w.gate, "b.test.mjs"), "// b, edited\n"); w.freeze();
  const refused = gate({ GATE_RESTAMP: r1 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^FATAL: --restamp \S+: 1 suite has no qualifying pass, so a stamp needs a run:\n  b\.test\.mjs: the suite changed since /m);
  assert.doesNotMatch(refused.stdout, /^(lanes|REUSE|RUN|==)/m);
});
