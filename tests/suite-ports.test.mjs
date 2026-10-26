// suite-ports.test.mjs — a fixed listener port belongs to ONE suite and sits
// inside the suite band, and no suite stops a process by its command line
// (gate-speed plan 2026-10-26, items 1.1 and 1.2).
//
// The gate copies all five repos' suites flat into one directory and runs them
// in a row; the plan's lanes run them side by side. Two suites that bind the
// same fixed port only coexist while the order keeps them apart (8424, 8441
// and 8469 were each claimed twice until 10/26), and a suite that runs
// `pkill -f "server[.]js <port>"` stops whichever hub matches — another
// session's included — not the one it started. So this suite reads the suite
// files that sit beside it (import.meta.dirname: in a gate, the collection
// directory with every repo's suites; in a plain run, this repo's tests/) and
// refuses:
//   (a) a port claimed by two different files;
//   (b) a claimed port in a reserved band: the live hub, the gate hub (8378),
//       the manual test hubs and the isolated runner (8380-8389), the scratch
//       hubs and the device ssh tunnels (8480 and up);
//   (c) pkill or killall anywhere in a suite's code (kill by pid instead).
// The live hub's port is written as 8300 + 77 throughout: the gate rewrites
// that literal in every collected file, this one included.
//
// A claim is a declaration or assignment whose value is a port literal in
// 8300-8599, in the forms the suites use:
//   const PORT = 8463;                const PORT = 8458, AI_PORT = 8459;
//   const PORT = Number(process.env.ERA_TEST_HUB_PORT) || 8469;
//   const PORT = Number(process.env.ERA_BOARD_ROUTE_PORT || 8390);
//   const PORT2 = PORT + 1;           (resolved within the same file)
//   const A = makeHub("a", 8473);     (a literal port as a call's last argument)
//   FEED2_PORT = 8412;                (a bare assignment)
// Comments, strings and regular expressions are blanked first, so a header
// that documents a neighbour's port is not a claim. One file reusing its own
// port for successive cases (update.test.mjs's 8412) is one claim. The
// extractor lives in tools/testing/suite-source.mjs so the registry's `ports`
// field (tools/testing/classify-suites.mjs) is read by the same code.
//
// No shared-port allowlist: after the 10/26 moves no two suites share a fixed
// listener on purpose. A harness that genuinely must would be named here with
// its reason. The one tolerated exception is PREDATING_HIGH below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { stopHubOnPort, listenerPid } from "./hub-port.mjs";
import { blank, claims } from "../tools/testing/suite-source.mjs";

const DIR = import.meta.dirname;
const LIVE = 8300 + 77;                        // written as a sum: see the header
const reserved = (p) => p === LIVE || p === 8378 || (p >= 8380 && p <= 8389) || p >= 8480;
const KILL_BY_NAME = /\b(?:pkill|killall)\b/;
// Claims in the 8480+ band that predate this suite. 8480-8499 is
// push-device.sh's feed range and 8500+ the device tunnels, so each is an
// exposure, not a design. On 10/26 the band 8390-8479 had three unclaimed ports
// left (8425; 8465, held back in clothing-accessories' notes; 8470), too few for
// these four, so they stay until the suite band is widened or the gaze bus
// stand-in takes a kernel-assigned port. Nothing joins this list without
// review, and an entry no longer claimed fails, so the list only shrinks.
const PREDATING_HIGH = ["gaze-status.test.mjs:8489", "gaze-status.test.mjs:8491",
  "presence.test.mjs:8486", "presence.test.mjs:8487"];

// The suite files beside this one: node --test suites, the legacy .js scripts
// and the helper modules they import.
function suiteFiles() {
  return fs.readdirSync(DIR).filter((f) => /\.(?:mjs|js)$/.test(f)).sort()
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(DIR, f), "utf8") }));
}

test("the extractor reads every claim form and nothing in comments, strings or comparisons", () => {
  const sample = [
    "// const COMMENTED = 8401;",
    "/* const BLOCK = 8402; */",
    "const PORT = 8458, AI_PORT = 8459;   // two declarators",
    "const ENVED = Number(process.env.ERA_TEST_HUB_PORT) || 8460;",
    "const INNER = Number(process.env.ERA_BOARD_ROUTE_PORT || 8461);",
    "const NEXT = ENVED + 2;",
    "const A = makeHub(\"a\", 8463);",
    "let LATER; LATER = 8464;",
    "const TEXT = \"const HIDDEN = 8465;\";",
    "const SUM = String(8300 + 99);",
    "if (p === 8466 || p >= 8467) ok();",
    "const fn = (x) => 8468;",
    "const RATIO = 0.8469;",
    "const MS = 1500;",
    "assert.match(s, hubLinkRx(\"x\", 8470));",
  ].join("\n");
  assert.deepEqual(claims(sample).map((c) => [c.name, c.port, c.line]), [
    ["PORT", 8458, 3], ["AI_PORT", 8459, 3], ["ENVED", 8460, 4], ["INNER", 8461, 5],
    ["NEXT", 8462, 6], ["A", 8463, 7], ["LATER", 8464, 8],
  ]);
  const word = ["pk", "ill"].join("");
  assert.match(blank(`spawnSync("${word}", []);`, { keepStrings: true }), KILL_BY_NAME, "a kill-by-name call in a string is code");
  assert.doesNotMatch(blank(`assert.doesNotMatch(s, /${word}/); // ${word}`, { keepStrings: true }), KILL_BY_NAME,
    "a pattern or a comment that names it is not a call");
});

test("the scan sees the suites beside it", () => {
  const files = suiteFiles();
  const claimed = files.flatMap(({ src }) => claims(src));
  assert.ok(files.length >= 50, `only ${files.length} suite files beside ${DIR}`);
  assert.ok(claimed.length >= 60, `only ${claimed.length} port claims found: the extractor no longer matches the suites`);
});

test("no fixed listener port is claimed by two suite files", () => {
  const owners = new Map();
  for (const { file, src } of suiteFiles()) {
    for (const c of claims(src)) {
      const list = owners.get(c.port) || [];
      if (!list.some((o) => o.file === file)) list.push({ file, line: c.line, name: c.name });
      owners.set(c.port, list);
    }
  }
  const shared = [...owners].filter(([, list]) => list.length > 1)
    .map(([port, list]) => `${port}: ${list.map((o) => `${o.file}:${o.line} (${o.name})`).join(", ")}`);
  assert.deepEqual(shared, [], `ports bound by more than one suite:\n  ${shared.join("\n  ")}`);
});

test("no suite claims a port in a reserved band", () => {
  const files = suiteFiles(), seen = new Set(), bad = [];
  for (const { file, src } of files) {
    for (const c of claims(src).filter((c) => reserved(c.port))) {
      if (PREDATING_HIGH.includes(`${file}:${c.port}`)) seen.add(`${file}:${c.port}`);
      else bad.push(`${file}:${c.line} ${c.name} = ${c.port}`);
    }
  }
  assert.deepEqual(bad, [], "live hub, gate hub, 8380-8389 and 8480+ are not suite ports:\n  " + bad.join("\n  "));
  const present = new Set(files.map((f) => f.file));
  const stale = PREDATING_HIGH.filter((k) => present.has(k.split(":")[0]) && !seen.has(k));
  assert.deepEqual(stale, [], "moved out of the reserved band: drop from PREDATING_HIGH");
});

test("no suite stops a process by its name: each kills the pid it owns", () => {
  const bad = [];
  for (const { file, src } of suiteFiles()) {
    blank(src, { keepStrings: true }).split("\n").forEach((line, i) => {
      if (KILL_BY_NAME.test(line)) bad.push(`${file}:${i + 1}: ${src.split("\n")[i].trim()}`);
    });
  }
  assert.deepEqual(bad, [], "kill-by-name in suites:\n  " + bad.join("\n  "));
});

// The pid-tracked replacement for pkill (tests/hub-port.mjs), exercised on
// ports the kernel hands out so this suite claims no fixed one.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
async function started(child, port) {
  for (let i = 0; i < 100; i++) {
    if (listenerPid(port) === child.pid) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${child.pid} never listened on ${port}`);
}
const exited = (child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
  : new Promise((r) => child.once("exit", r));

test("stopHubOnPort stops the hub that owns the port by pid, and nothing that merely names it", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "era-suite-ports-"));
  const hubFile = path.join(tmp, "server.js");
  fs.writeFileSync(hubFile, 'require("node:http").createServer((q, s) => s.end("hub"))' +
    '.listen(Number(process.argv[2]), "127.0.0.1");\n');
  const port = await freePort(), other = await freePort();
  const hub = spawn(process.execPath, [hubFile, String(port)], { stdio: "ignore" });
  const neighbour = spawn(process.execPath, [hubFile, String(other)], { stdio: "ignore" });
  // what `pkill -f "server[.]js <port>"` also matched: a process whose command
  // line names the hub and the port but that holds no socket at all
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "server.js", String(port)], { stdio: "ignore" });
  try {
    await started(hub, port);
    await started(neighbour, other);
    assert.deepEqual(await stopHubOnPort(port), [hub.pid], "the listener's own pid, and only it");
    await exited(hub);
    assert.equal(hub.signalCode, "SIGKILL");
    assert.equal(listenerPid(port), null, "the port is free when it returns");
    assert.equal(neighbour.exitCode ?? neighbour.signalCode, null, "a hub on another port is untouched");
    assert.equal(bystander.exitCode ?? bystander.signalCode, null, "a process that only names the port is untouched");
    assert.deepEqual(await stopHubOnPort(port), [], "nothing listening: nothing to do");
  } finally {
    for (const c of [hub, neighbour, bystander]) c.kill("SIGKILL");
    await Promise.all([hub, neighbour, bystander].map(exited));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stopHubOnPort refuses a listener that is not a hub on that port and leaves it running", async () => {
  const port = await freePort();
  const foreign = spawn(process.execPath, ["-e",
    'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1")', String(port)], { stdio: "ignore" });
  try {
    await started(foreign, port);
    await assert.rejects(stopHubOnPort(port), new RegExp(`port ${port} is held by pid ${foreign.pid} .*refusing`));
    assert.equal(foreign.exitCode ?? foreign.signalCode, null, "still running");
    assert.equal(listenerPid(port), foreign.pid);
  } finally {
    foreign.kill("SIGKILL");
    await exited(foreign);
  }
});

