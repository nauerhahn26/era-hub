// assemble-suffix.test.mjs — ERA_WT_SUFFIX, the sibling-worktree seam (9/17).
//
// A feature that spans repos (pause-to-talk) keeps one worktree per repo next
// to the main checkouts: era-core--wt-pause-to-talk, era-board--wt-…, and so
// on. The three scripts that reach sideways — assemble.sh (the dev symlink
// farm), era-gate.sh (the suite collector) and build-payload.sh (the cut) —
// read `$ROOT/<repo>`, i.e. the MAIN checkouts, so the hub worktree's gate and
// dist would test and ship master's siblings while the feature sits unseen in
// theirs. `sib <repo>` resolves `$ROOT/<repo>$ERA_WT_SUFFIX` when that
// directory exists and falls back to `$ROOT/<repo>` otherwise — per repo, so a
// feature that only touches era-core still gets master's pencil.
//
// assemble.sh is exercised for real against a fake $ROOT (it only makes
// symlinks, so it is cheap); the other two are pinned as text — spawning the
// gate or a payload cut here would cost minutes and a network fetch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HUB = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCRATCH = "/tmp/claude-1001/-home-claude-new-era-era-hub/2276ba86-de6c-4d29-b131-08ebe6621244/scratchpad";

// a throwaway workspace shaped like /home/claude/new-era: the four module
// repos, an era-core worktree, and a hub holding nothing but this script and
// an empty public/.
function fakeRoot() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, "assemble-suffix-"));
  const mk = (p) => fs.mkdirSync(path.join(root, p), { recursive: true });
  const touch = (p) => fs.writeFileSync(path.join(root, p), "// fake\n");
  for (const core of ["era-core", "era-core--wt-x"]) {
    mk(`${core}/lib`);
    touch(`${core}/lib/contract.js`);
    touch(`${core}/dwell.js`);
    touch(`${core}/speech.js`);
  }
  mk("era-making-words/app");
  touch("era-making-words/app/index.html");
  touch("era-making-words/app/studio.js");
  mk("era-pencil/app");
  mk("era-board/app");
  mk("era-hub/tools");
  mk("era-hub/public");
  fs.copyFileSync(path.join(HUB, "tools/assemble.sh"), path.join(root, "era-hub/tools/assemble.sh"));
  return root;
}

function assemble(root, suffix) {
  const env = { ...process.env, ERA_DATA_DIR: path.join(root, "data") };
  if (suffix === undefined) delete env.ERA_WT_SUFFIX;
  else env.ERA_WT_SUFFIX = suffix;
  const r = spawnSync("bash", [path.join(root, "era-hub/tools/assemble.sh")], { env, encoding: "utf8" });
  assert.equal(r.status, 0, `assemble.sh failed: ${r.stderr}`);
  return (p) => fs.readlinkSync(path.join(root, "era-hub/public", p));
}

test("no ERA_WT_SUFFIX: the links are exactly what they have always been", () => {
  const root = fakeRoot();
  const link = assemble(root, undefined);
  assert.equal(link("lib"), "../../era-core/lib");
  assert.equal(link("dwell.js"), "../../era-core/dwell.js");
  assert.equal(link("speech.js"), "../../era-core/speech.js");
  assert.equal(link("index.html"), "../../era-making-words/app/index.html");
  assert.equal(link("studio.js"), "../../era-making-words/app/studio.js");
  assert.equal(link("pencil"), "../../era-pencil/app");
  assert.equal(link("board"), "../../era-board/app");
});

test("ERA_WT_SUFFIX points a repo that HAS a worktree at the worktree", () => {
  const root = fakeRoot();
  const link = assemble(root, "--wt-x");
  assert.equal(link("lib"), "../../era-core--wt-x/lib");
  assert.equal(link("dwell.js"), "../../era-core--wt-x/dwell.js");
  assert.equal(link("speech.js"), "../../era-core--wt-x/speech.js");
  // still relative, and still resolving — an absolute link would work on this
  // box and break the moment the workspace moves.
  assert.ok(fs.existsSync(path.join(root, "era-hub/public/lib/contract.js")),
    "the suffixed link resolves to a real lib/");
});

test("the fallback is per repo: only era-core has a worktree here", () => {
  const root = fakeRoot();
  const link = assemble(root, "--wt-x");
  assert.equal(link("pencil"), "../../era-pencil/app");
  assert.equal(link("board"), "../../era-board/app");
  assert.equal(link("index.html"), "../../era-making-words/app/index.html");
});

test("a suffix nothing matches falls all the way back", () => {
  const root = fakeRoot();
  const link = assemble(root, "--wt-nope");
  assert.equal(link("lib"), "../../era-core/lib");
  assert.equal(link("pencil"), "../../era-pencil/app");
});

// ---- era-gate.sh and build-payload.sh: text-level, same seam ----------------
const GATE = fs.readFileSync(path.join(HUB, "tools/era-gate.sh"), "utf8");
const PAYLOAD = fs.readFileSync(path.join(HUB, "tools/build-payload.sh"), "utf8");
const MODULES = ["era-core", "era-making-words", "era-pencil", "era-board"];

test("all three scripts define sib()", () => {
  for (const [name, sh] of [["era-gate.sh", GATE], ["build-payload.sh", PAYLOAD],
    ["assemble.sh", fs.readFileSync(path.join(HUB, "tools/assemble.sh"), "utf8")]]) {
    assert.match(sh, /^sib\(\)\s*\{/m, `${name} defines sib()`);
    assert.match(sh, /ERA_WT_SUFFIX:-/, `${name}'s sib() reads ERA_WT_SUFFIX with a default`);
  }
});

test("build-payload.sh copies every module repo through sib()", () => {
  for (const m of MODULES) assert.ok(PAYLOAD.includes(`$(sib ${m})`), `build-payload.sh uses $(sib ${m})`);
});

test("era-gate.sh collects the module suites through sib()", () => {
  // the collector loops over the repo names, so one `sib "$repo"` covers all
  // four (era-hub is overridden to $HUB on the next line as before).
  assert.ok(/sib "\$repo"/.test(GATE) || MODULES.every((m) => GATE.includes(`sib ${m}`)),
    "era-gate.sh routes the collector's source through sib()");
});

test("the gate re-assembles public/ when the farm points at the wrong siblings", () => {
  // "already there" is not "already right": a worktree assembled before the
  // suffix existed keeps a public/pencil -> ../../era-pencil/app, and the gate
  // would serve master's apps to every browser suite.
  assert.match(GATE, /readlink "\$HUB\/public\/pencil"/, "the gate compares the existing link");
  assert.ok(GATE.includes('basename "$(sib era-pencil)"'), "…against the sibling sib() picked");
});

test("no module repo is read from the main checkout any more", () => {
  const bare = /\$ROOT\/era-(core|making-words|pencil|board)\b/;
  assert.doesNotMatch(GATE, bare, "era-gate.sh has no bare $ROOT/<module>");
  assert.doesNotMatch(PAYLOAD, bare, "build-payload.sh has no bare $ROOT/<module>");
  assert.doesNotMatch(PAYLOAD, /\$HUB\/\.\.\/era-core\b/, "…nor the $HUB/.. spelling of it");
});

test("era-gaze and era-family keep pointing at the main checkouts", () => {
  // neither has a feature worktree; era-family is the private data/cache repo
  // and era-gaze ships the engine source. A blanket sed would have caught them.
  assert.ok(PAYLOAD.includes("$ROOT/era-gaze/device/ERAgaze.cs"), "the gaze source still comes from $ROOT");
  assert.ok(PAYLOAD.includes("$ROOT/era-family/cache/"), "the yt-dlp/node cache still comes from $ROOT");
  assert.ok(GATE.includes("$ROOT/era-family/"), "the gate's private env still comes from $ROOT");
});
