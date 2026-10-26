// suite-classes.test.mjs — the registry's per-suite classes (gate-speed plan
// 2026-10-26, item 1.5) are complete, typed, and equal to what
// tools/testing/classify-suites.mjs derives from the suite sources today.
//
// The lane scheduler (phase 2) reads `hub`, `ports`, `browsers`, `heavy`,
// `solo` and `quiet`; the result store (phase 3) reads `retry` and `owner`.
// A class that drifts from its source is worse than none: the scheduler would
// run a shared-hub writer beside its readers, or two segmentation suites
// beside a quiet one. So the transform re-derives every class from the
// sources, its judgment calls live in one commented table inside it, and this
// suite fails the moment the committed registry and the derivation disagree
// (the fix is always `node tools/testing/classify-suites.mjs`, then review
// the diff).
//
// The live hub's port is written as 8300 + 77 throughout: the gate rewrites
// that literal in every collected file, this one included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claims } from "../tools/testing/suite-source.mjs";
import {
  CLASS_FIELDS, HUBS, BOILERPLATE, DERIVED_RESOURCES, analyseSource, classifyRegistry, validateClasses,
  serialize, sourceReader,
} from "../tools/testing/classify-suites.mjs";
import { resolveRoots } from "../tools/testing/suite-runner.mjs";

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = path.join(HUB, "tools", "testing", "registry.json");
const TOOL = path.join(HUB, "tools", "testing", "classify-suites.mjs");
const LIVE = 8300 + 77;
const LIVE_URL = `http://127.0.0.1:${LIVE}`;
const id = (name) => `era-hub:tests/${name}.test.mjs`;
const committed = () => JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
const byId = (registry) => new Map(registry.suites.map((s) => [s.id, s]));
const ids = (registry, field) => registry.suites.filter((s) => s[field] === true).map((s) => s.id).sort();

// The suites that run the garment cut-out (segment.js, ONNX Runtime wasm,
// single-threaded) for a meaningful stretch. Measured 10/26 by running each
// clothing suite under a preload hook that logged every cutOut call:
// clothing.test.mjs 24 in 350 s (it also requires segment.js itself),
// clothing-accessories 11 in 181 s, clothing-responsive 6 in 58 s. clothing-share (2) and
// clothing-weather (1) touch it for a second or two and are not heavy.
const SEGMENTATION = [id("clothing"), id("clothing-accessories"), id("clothing-responsive")].sort();
const QUIET = ["drawing-ui", "games-ui", "math-ui", "play-ui", "presence", "update-boot"].map(id).sort();

function tool(args, opts = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", timeout: 60_000, ...opts });
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "era-suite-classes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- the derivation, on synthetic sources -----------------------------------

test("a shared-hub suite is read from what it connects to, not from what it mentions", () => {
  const reader = analyseSource([
    `// drives the shared hub at :${LIVE}`,
    `const BASE = "http://localhost:${LIVE}/board/";`,
    "await page.goto(BASE + '?recipe=x');",
  ].join("\n"));
  assert.equal(reader.shared, true);
  assert.deepEqual(reader.writes, []);

  const literal = analyseSource(`const r = await fetch(\`${LIVE_URL}/predict?left=a\`);`);
  assert.equal(literal.shared, true, "a live URL as a call's first argument connects");

  const derived = analyseSource([
    `export const BASE = process.env.SEAM_BASE || "http://localhost:${LIVE}";`,
    "const url = BASE + path;",
    "await page.goto(url, { waitUntil: 'load' });",
  ].join("\n"));
  assert.equal(derived.shared, true, "an identifier built from the base connects too");
  assert.deepEqual(derived.seams, ["SEAM_BASE"]);

  const comment = analyseSource(`// never the live ${LIVE}; this suite owns 8463\nconst PORT = 8463;`);
  assert.equal(comment.shared, false, "a comment naming the live hub is not a connection");

  const expectation = analyseSource([
    "const cases = [",
    `  { line: "start \\"${LIVE_URL}/board/\\"", swept: false },`,
    "];",
    `const plan = reconcile({ dir, port: ${LIVE} });`,
  ].join("\n"));
  assert.equal(expectation.shared, false, "an expected string or a port argument is data, not a connection");
});

test("a non-GET to the shared hub makes a writer; one to the suite's own hub does not", () => {
  const writer = analyseSource([
    `const BASE = "${LIVE_URL}";`,
    "const s = await (await fetch(`${BASE}/settings`)).json();",
    "await fetch(`${BASE}/setup`, { method: \"POST\", body: \"{}\" });",
  ].join("\n"));
  assert.equal(writer.shared, true);
  assert.equal(writer.writes.length, 1);
  assert.match(writer.writes[0].text, /setup/);
  assert.equal(writer.writes[0].line, 3);

  const own = analyseSource([
    `const BASE = "http://localhost:${LIVE}/board/";`,
    "const PORT = 8407;",
    "child = spawn(\"node\", [\"server.js\", String(PORT)], { cwd: HUB });",
    "await page.goto(BASE);",
    "await fetch(`http://127.0.0.1:${PORT}/clothing/regenerate`, { method: \"POST\" });",
  ].join("\n"));
  assert.equal(own.shared, true);
  assert.equal(own.own, true);
  assert.deepEqual(own.writes, [], "the POST goes to the suite's own hub on its own port");
});

test("an own hub is a spawned server.js; a createRequire anchored on it is not", () => {
  const spawned = analyseSource([
    "const SERVER = path.join(HUB, \"server.js\");",
    "const args = [SERVER, String(PORT)];",
    "hub = spawn(process.execPath, args, { env });",
  ].join("\n"));
  assert.equal(spawned.own, true, "followed through two identifiers");
  const required = analyseSource([
    "const require = createRequire(path.join(HUB, \"server.js\"));",
    "const clothing = require(\"./clothing.js\");",
    "const child = spawn(process.execPath, [require.resolve(\"./x.js\")]);",
  ].join("\n"));
  assert.equal(required.own, false);
  assert.equal(analyseSource("// spawn(\"node\", [\"server.js\"]) in a comment\n").own, false);
  assert.equal(analyseSource("spawn(process.execPath, [\"fake-server.js\"]);").own, false, "another file named like the hub");
});

test("browsers count launch call sites; segmentation is a direct load of the runtime", () => {
  const facts = analyseSource([
    "before(async () => { browser = await chromium.launch(); });",
    "const ctx = await chromium.launchPersistentContext(dir);",
    "// chromium.launch() in a comment",
    "const s = \"chromium.launch()\";",
    "const seg = require(\"./segment.js\");",
    "await page.waitForTimeout(300); await page.waitForTimeout(50);",
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), \"x-\"));",
  ].join("\n"));
  assert.equal(facts.browsers, 2);
  assert.equal(facts.segmentation, true);
  assert.equal(facts.waits, 2);
  assert.equal(facts.temporary, true);
  assert.equal(analyseSource("const list = [\"vendor/models/u2netp.onnx\", \"segment.js\"];").segmentation, false,
    "a packaging list that names the runtime does not run it");
});

test("ports are suite-ports' claims, deduplicated and sorted", () => {
  const src = "const PORT = 8463, AI = 8458;\nconst NEXT = PORT + 1;\nconst AGAIN = 8458;\n";
  assert.deepEqual(analyseSource(src).ports, [8458, 8463, 8464]);
});

// ---- the registry-level transform, on a synthetic registry -------------------

function synthetic() {
  const sources = new Map([
    [id("reader"), `const BASE = "${LIVE_URL}";\nawait page.goto(BASE); const b = await chromium.launch();\n`],
    [id("helper-user"), "import { auditPath } from \"./audit.mjs\";\nawait auditPath(b, \"/\");\n"],
    [id("seamed"), "process.env.AUDIT_BASE = BASE;\nconst { auditPath } = await import(\"./audit.mjs\");\n"],
    [id("owner"), "const PORT = 8463;\nconst hub = spawn(process.execPath, [\"server.js\", String(PORT)]);\nconst d = fs.mkdtempSync(\"x\");\n"],
    [id("plain"), "assert.equal(1 + 1, 2);\n"],
    ["era-hub:tests/audit.mjs", `export const BASE = process.env.AUDIT_BASE || "http://localhost:${LIVE}";\nexport const auditPath = (b, p) => page.goto(BASE + p);\n`],
  ]);
  const suite = (name, resources = [...BOILERPLATE]) => ({ id: id(name), purpose: name, group: "g", dependencies: ["x"], lane: "linux", resources, level: "l" });
  const registry = { version: 1, suites: [
    suite("reader"), suite("helper-user"), suite("seamed"), suite("owner"),
    suite("plain", ["in-process-doubles", "hand-written"]),
  ] };
  return { registry, read: (key) => sources.get(key) ?? null };
}

test("the transform fills every class field, follows helpers, and honours a helper's base seam", () => {
  const { registry, read } = synthetic();
  const out = byId(classifyRegistry(registry, { read, overrides: [] }).registry);
  assert.equal(out.get(id("reader")).hub, "shared-reader");
  assert.equal(out.get(id("reader")).browsers, 1);
  assert.equal(out.get(id("helper-user")).hub, "shared-reader", "reaches the shared hub through ./audit.mjs");
  assert.equal(out.get(id("seamed")).hub, "none", "points the helper's AUDIT_BASE seam elsewhere first");
  assert.equal(out.get(id("owner")).hub, "own");
  assert.deepEqual(out.get(id("owner")).ports, [8463]);
  assert.equal(out.get(id("plain")).hub, "none");
  for (const s of out.values()) {
    assert.deepEqual(Object.keys(s).slice(-CLASS_FIELDS.length), CLASS_FIELDS, `${s.id}: class fields last, in order`);
    assert.equal(s.retry, false); assert.equal(s.owner, "");
  }
  assert.deepEqual(out.get(id("reader")).resources, ["shared-hub", "browser"], "the boilerplate triple is replaced");
  assert.deepEqual(out.get(id("owner")).resources, ["own-hub", "fixed-ports", "temporary-data"]);
  assert.deepEqual(out.get(id("plain")).resources, ["in-process-doubles", "hand-written"], "a reviewed list is kept verbatim");
});

test("an override must still be true of its source, and must name a registered suite", () => {
  const { registry, read } = synthetic();
  const quiet = { id: id("plain"), set: { quiet: true }, why: "timing", witness: /1 \+ 1/ };
  assert.equal(byId(classifyRegistry(registry, { read, overrides: [quiet] }).registry).get(id("plain")).quiet, true);
  assert.throws(() => classifyRegistry(registry, { read, overrides: [{ ...quiet, witness: /dwellMs/ }] }),
    /plain\.test\.mjs.*witness/i);
  assert.throws(() => classifyRegistry(registry, { read, overrides: [{ ...quiet, id: id("gone") }] }),
    /gone\.test\.mjs.*not registered/i);
});

test("retry stays a reviewed decision: true needs an owner, an owner needs retry", () => {
  const { registry, read } = synthetic();
  const out = classifyRegistry(registry, { read, overrides: [] }).registry;
  assert.deepEqual(validateClasses(out), []);
  const flagged = structuredClone(out);
  flagged.suites[0].retry = true;
  assert.match(validateClasses(flagged).join("\n"), /reader\.test\.mjs.*retry.*owner/);
  flagged.suites[0].owner = "games";
  assert.deepEqual(validateClasses(flagged), []);
  const kept = byId(classifyRegistry(flagged, { read, overrides: [] }).registry).get(id("reader"));
  assert.equal(kept.retry, true, "the transform keeps a reviewed retry decision");
  assert.equal(kept.owner, "games");
  const orphan = structuredClone(out);
  orphan.suites[1].owner = "someone";
  assert.match(validateClasses(orphan).join("\n"), /helper-user\.test\.mjs.*owner.*retry/);
  const ownerless = structuredClone(flagged);
  ownerless.suites[0].owner = "";
  assert.throws(() => classifyRegistry(ownerless, { read, overrides: [] }), /reader\.test\.mjs.*retry.*owner/,
    "the transform refuses to write a retry nobody owns");
});

// ---- the committed registry ---------------------------------------------------

test("every registered suite carries every class field with the right type", () => {
  const registry = committed();
  assert.ok(registry.suites.length >= 160, `only ${registry.suites.length} suites`);
  const bad = [];
  for (const s of registry.suites) {
    if (!HUBS.includes(s.hub)) bad.push(`${s.id}: hub ${JSON.stringify(s.hub)}`);
    if (!Array.isArray(s.ports) || s.ports.some((p) => !Number.isInteger(p)) ||
        s.ports.some((p, i) => i && p <= s.ports[i - 1])) bad.push(`${s.id}: ports ${JSON.stringify(s.ports)}`);
    if (!Number.isInteger(s.browsers) || s.browsers < 0) bad.push(`${s.id}: browsers ${JSON.stringify(s.browsers)}`);
    for (const f of ["heavy", "solo", "quiet", "retry"]) if (typeof s[f] !== "boolean") bad.push(`${s.id}: ${f} ${JSON.stringify(s[f])}`);
    if (typeof s.owner !== "string") bad.push(`${s.id}: owner ${JSON.stringify(s.owner)}`);
    if (JSON.stringify(s.resources) === JSON.stringify(BOILERPLATE)) bad.push(`${s.id}: still the boilerplate resources triple`);
  }
  assert.deepEqual(bad, []);
  assert.deepEqual(validateClasses(registry), []);
});

test("solo is clothing-responsive alone; quiet is the six timing-sensitive suites; heavy holds the segmentation suites", () => {
  const registry = committed();
  assert.deepEqual(ids(registry, "solo"), [id("clothing-responsive")]);
  assert.deepEqual(ids(registry, "quiet"), QUIET);
  const heavy = ids(registry, "heavy");
  for (const s of SEGMENTATION) assert.ok(heavy.includes(s), `${s} runs the segmentation runtime but is not heavy`);
  const quietHeavy = registry.suites.filter((s) => s.quiet && (s.heavy || s.solo)).map((s) => s.id);
  assert.deepEqual(quietHeavy, [], "a quiet suite that is also heavy or solo cannot be scheduled");
});

test("a reviewed resources list agrees with the derived browser count", () => {
  // Lists with a word outside the derived vocabulary were written by a
  // reviewer and are kept verbatim; they must still not contradict the source.
  const curated = committed().suites.filter((s) => s.resources.some((r) => !DERIVED_RESOURCES.includes(r) && !BOILERPLATE.includes(r)));
  assert.ok(curated.length >= 20, `only ${curated.length} reviewed resources lists`);
  const off = curated.filter((s) => s.resources.includes("chromium") !== s.browsers > 0)
    .map((s) => `${s.id}: resources ${JSON.stringify(s.resources)}, ${s.browsers} launch sites`);
  assert.deepEqual(off, []);
});

test("no suite writes to the shared hub", () => {
  const writers = committed().suites.filter((s) => s.hub === "shared-writer").map((s) => s.id);
  assert.deepEqual(writers, [], "lanes run shared-hub suites side by side; a writer changes what the others read");
});

test("ports agree with suite-ports' extraction of each suite's own source", () => {
  const read = sourceReader(resolveRoots(HUB));
  const off = [];
  for (const s of committed().suites) {
    const expected = [...new Set(claims(read(s.id)).map((c) => c.port))].sort((a, b) => a - b);
    if (JSON.stringify(expected) !== JSON.stringify(s.ports)) off.push(`${s.id}: registry ${JSON.stringify(s.ports)}, source ${JSON.stringify(expected)}`);
  }
  assert.deepEqual(off, []);
});

test("the committed registry is exactly what the transform derives from today's sources", () => {
  const result = tool(["--check"]);
  assert.equal(result.status, 0, `registry.json is out of date with the suite sources; run\n` +
    `  node tools/testing/classify-suites.mjs\nand review the diff.\n${result.stdout}${result.stderr}`);
});

test("the transform is idempotent and overwrites a hand edit that contradicts the sources", (t) => {
  const dir = scratch(t), copy = path.join(dir, "registry.json");
  const original = fs.readFileSync(REGISTRY, "utf8");
  const edited = JSON.parse(original);
  const pick = (pred) => edited.suites.find(pred);
  pick((s) => s.hub === "shared-reader").hub = "none";
  pick((s) => s.browsers > 0).browsers = 99;
  pick((s) => s.ports.length).ports = [8301];
  pick((s) => !s.quiet && !s.heavy).quiet = true;
  pick((s) => s.heavy).heavy = false;
  pick((s) => s.resources.includes("shared-hub")).resources = [...BOILERPLATE];
  fs.writeFileSync(copy, serialize(edited));
  const first = tool(["--registry", copy]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(copy, "utf8"), original, "every contradicted field is restored from the sources");
  const before = fs.statSync(copy).mtimeMs;
  const second = tool(["--registry", copy]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(copy, "utf8"), original, "a second run changes nothing");
  assert.equal(fs.statSync(copy).mtimeMs, before, "and does not even rewrite the file");
});
