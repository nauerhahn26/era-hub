// gate-stamp.test.mjs — what a green era-gate.sh stamps (9/17).
//
// `worktree.sh land <repo> <slug>` merges a branch only when a green stamp
// exists for THAT repo's branch tree ($ERA_GATE_STAMPS/<tree sha>). A gate run
// with ERA_WT_SUFFIX set really does run the sibling worktrees' suites against
// the sibling worktrees' code (sib() sources them), so those trees are gated
// too — but the gate used to stamp only the hub's tree, and landing
// era-core/era-board/era-making-words/era-pencil then failed with "no green
// gate under 2 h for this tree" after a 20-minute run that had just proved it.
//
// The stamping is exercised for real, and cheaply: the gate itself is a
// 20-minute machine-wide-locked run, so the two functions that do the stamping
// (sib + stamp_tree/write_green_stamp) are lifted out of the script TEXT and
// run under bash against a throwaway workspace of tiny git repos. That keeps
// this a test of the shipped source — if the functions are renamed or the loop
// stops going through sib(), the extraction below finds nothing and fails.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HUB = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCRATCH = "/tmp/claude-1001/-home-claude-new-era-era-hub/2276ba86-de6c-4d29-b131-08ebe6621244/scratchpad";
const GATE = fs.readFileSync(path.join(HUB, "tools/era-gate.sh"), "utf8");

// the function definitions, straight out of the script: sib() (a one-liner) and
// every multi-line helper the stamping needs. A `}` in column 1 ends a block.
function fn(name) {
  const re = new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n?\\}\\s*$`, "m");
  const m = GATE.match(re);
  assert.ok(m, `tools/era-gate.sh defines ${name}()`);
  return m[0];
}
const FUNCS = ["sib", "stamp_tree", "write_green_stamp"].map(fn).join("\n");

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t",
    "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

// a workspace shaped like /home/claude/new-era: the hub, era-core with a
// worktree beside it, and era-pencil with none.
function fakeRoot() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, "gate-stamp-"));
  for (const repo of ["era-hub", "era-core", "era-core--wt-x", "era-pencil"]) {
    const d = path.join(root, repo);
    fs.mkdirSync(d, { recursive: true });
    // distinct content per repo: two identical trees would share a stamp name
    fs.writeFileSync(path.join(d, "file.txt"), `${repo}\n`);
    const init = spawnSync("git", ["-C", d, "init", "-q"], { encoding: "utf8" });
    assert.equal(init.status, 0, `git init in ${d}: ${init.stderr}`);
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", `init ${repo}`);
  }
  fs.mkdirSync(path.join(root, "era-hub/tools"), { recursive: true });
  fs.copyFileSync(path.join(HUB, "tools/era-gate.sh"), path.join(root, "era-hub/tools/era-gate.sh"));
  return root;
}

// run write_green_stamp over that workspace; returns {dir, stamps: Set of names}
function stamp(root, suffix) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "gate-stamps-"));
  const env = {
    ...process.env,
    ROOT: root,
    HUB: path.join(root, "era-hub"),
    ERA_GATE_STAMPS: dir,
    pass: "3", fail: "0", failed: "",
  };
  if (suffix === undefined) delete env.ERA_WT_SUFFIX;
  else env.ERA_WT_SUFFIX = suffix;
  const r = spawnSync("bash", ["-c", `${FUNCS}\nwrite_green_stamp`], { env, encoding: "utf8" });
  assert.equal(r.status, 0, `write_green_stamp failed: ${r.stderr}`);
  return { dir, out: r.stdout, files: fs.readdirSync(dir).sort() };
}

const tree = (d) => git(d, "rev-parse", "HEAD^{tree}");
const head = (d) => git(d, "rev-parse", "HEAD");
const read = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");

test("the hub's own stamp keeps the shape the readers were written against", () => {
  const root = fakeRoot();
  const hub = path.join(root, "era-hub");
  const { dir, files } = stamp(root, "--wt-x");
  assert.ok(files.includes(tree(hub)), "the hub tree is stamped");
  const s = read(dir, tree(hub));
  assert.equal(s, `== era-gate: 3 passed, 0 failed ==\nhead=${head(hub)}\nat=${
    s.match(/^at=(\d+)$/m)[1]}\nhub=${hub}\n`);
  assert.doesNotMatch(s, /^repo=/m, "the hub stamp carries no repo= line");
  assert.doesNotMatch(s, /^dirty=1$/m);
});

test("every sibling worktree the gate sourced is stamped too", () => {
  const root = fakeRoot();
  const wt = path.join(root, "era-core--wt-x");
  const { dir, out, files } = stamp(root, "--wt-x");
  assert.ok(files.includes(tree(wt)), "era-core--wt-x's tree is stamped");
  const s = read(dir, tree(wt));
  // head= is ITS head, not the hub's: land keys on the tree but reads head=
  assert.match(s, new RegExp(`^head=${head(wt)}$`, "m"));
  assert.match(s, new RegExp(`^repo=${wt}$`, "m"), "…and says which checkout it is");
  assert.match(s, /^== era-gate: 3 passed, 0 failed ==$/m, "the summary line, verbatim");
  assert.match(s, /^at=\d+$/m);
  assert.doesNotMatch(s, /^dirty=1$/m);
  assert.match(out, new RegExp(`^stamp: era-core--wt-x ${tree(wt).slice(0, 7)}`, "m"),
    "and the run says so, before the summary line");
});

test("main checkouts sourced through the fallback are NOT stamped", () => {
  const root = fakeRoot();
  // era-pencil has no worktree here and era-core's main checkout was not read:
  // nothing on master's tree was tested by this run, and land never merges
  // master into itself.
  const { dir, files } = stamp(root, "--wt-x");
  assert.equal(files.length, 2, `exactly the hub and era-core--wt-x: ${files.join(" ")}`);
  assert.ok(!fs.existsSync(path.join(dir, tree(path.join(root, "era-core")))),
    "the era-core MAIN checkout is not stamped");
  assert.ok(!fs.existsSync(path.join(dir, tree(path.join(root, "era-pencil")))),
    "era-pencil (no worktree) is not stamped");
});

test("a dirty sibling marks ITS stamp dirty, and only its own", () => {
  const root = fakeRoot();
  const wt = path.join(root, "era-core--wt-x");
  fs.writeFileSync(path.join(wt, "file.txt"), "edited, never committed\n");
  const { dir, out } = stamp(root, "--wt-x");
  assert.match(read(dir, tree(wt)), /^dirty=1$/m, "the sibling stamp is refused by land");
  assert.doesNotMatch(read(dir, tree(path.join(root, "era-hub"))), /^dirty=1$/m,
    "the hub's own tree was clean — its stamp stays good");
  assert.match(out, /era-core--wt-x.*uncommitted tracked changes/,
    "the WARNING names the repo it is about");
});

test("without ERA_WT_SUFFIX nothing changes: one stamp, the hub's", () => {
  const root = fakeRoot();
  const hub = path.join(root, "era-hub");
  const { dir, out, files } = stamp(root, undefined);
  assert.deepEqual(files, [tree(hub)]);
  assert.equal(read(dir, tree(hub)),
    `== era-gate: 3 passed, 0 failed ==\nhead=${head(hub)}\nat=${
      read(dir, tree(hub)).match(/^at=(\d+)$/m)[1]}\nhub=${hub}\n`);
  assert.doesNotMatch(out, /^stamp:/m, "and nothing extra is printed");
});
