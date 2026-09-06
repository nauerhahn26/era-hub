// vm-e2e.test.mjs — which installer leg B starts from. release.sh refuses to
// publish unless tools/vm-e2e.sh is green, and leg B is the family's real
// upgrade path: the release they HAVE self-updating to the candidate. On 9/5
// v0.32.1's leg B picked the unpublished v0.32.0 cut over the v0.31.7 in the
// field, so the picker now wants a dist dir whose version is TAGGED. But when
// nothing is tagged (a checkout without tags fetched, or the build box pruned
// the old cuts to free disk, as it did on 9/3) it falls back to the newest
// untagged cut — the exact pre-9/5 behaviour — and the fallback must never be
// silent: a green run on an upgrade path no family has is worse than no run.
//
// The picker block is run here as the script's own bash, against a scratch
// ROOT/HUB (a throwaway git repo with one tag and two dist dirs). Nothing
// touches the VM, the lock, or era-family. The script itself is never run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SH = fs.readFileSync(new URL("../tools/vm-e2e.sh", import.meta.url), "utf8");
const lines = SH.split("\n");
// the picker: from `if [ -z "$PREV" ]; then` to the `fi` before the file check
const start = lines.findIndex((l) => l.startsWith('if [ -z "$PREV" ]; then'));
const end = lines.findIndex((l, i) => i > start && l === "fi");
const picker = lines.slice(start, end + 1).join("\n");
const banner = lines.find((l) => l.startsWith('echo "== vm-e2e: candidate'));

test("the picker and banner are where this test thinks they are", () => {
  assert.ok(start > 0 && end > start, "the PREV picker block was found");
  assert.ok(banner, "the one-line banner naming candidate and previous was found");
  assert.match(picker, /git -C "\$HUB" tag -l/, "a previous is one whose version is tagged");
});

test("the untagged fallback says so out loud, and the banner never reads like the tagged case", () => {
  // the warning names the fallback and the reason it matters: leg B starts
  // from a build no family has
  assert.match(picker, /echo "vm-e2e: WARNING[^"]*UNTAGGED[^"]*\$PREV/,
    "the fallback prints a WARNING line naming the untagged cut it picked");
  assert.match(picker, /no family/i, "and says what that means for leg B");
  // the banner is the line that did not catch the 9/5 mistake: it must read
  // differently when the fallback fired
  assert.match(banner, /PREV_UNTAGGED/, "the banner carries the untagged mark");
  assert.match(banner, /UNTAGGED/, "spelled so it cannot be missed in a log");
});

// A scratch ROOT with HUB=ROOT/era-hub (a git repo with one tag) and the dist
// dirs given: each entry is [dirname, tagged]. Returns what the picker printed
// and the PREV it settled on.
function pick(dists) {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-e2e-"));
  const HUB = path.join(ROOT, "era-hub");
  fs.mkdirSync(HUB);
  const git = (...a) => execFileSync("git", ["-C", HUB, ...a], { stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "x");
  const DIST = path.join(ROOT, "dist", "release-candidate");
  fs.mkdirSync(DIST, { recursive: true });
  let t = Date.now() - 60_000 * dists.length;
  for (const [name, tagged] of dists) {
    const d = path.join(ROOT, "dist", "release-" + name);
    fs.mkdirSync(d, { recursive: true });
    const exe = path.join(d, "New-ERA-Setup.exe");
    fs.writeFileSync(exe, "stand-in");
    // oldest first: the script's `ls -dt` sorts the .exe files, not the dirs
    t += 60_000; fs.utimesSync(exe, new Date(t), new Date(t));
    if (tagged) git("tag", name);
  }
  const script = `set -uo pipefail\nHUB=${JSON.stringify(HUB)}\nROOT=${JSON.stringify(ROOT)}\nDIST=${JSON.stringify(DIST)}\nPREV="" PREV_UNTAGGED=""\nVER=v9 BUILD=b9\n${picker}\n${banner}\n`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: "pipe" });
  return { out, ROOT };
}

test("a tagged cut is picked over a newer untagged one, quietly (9/5)", () => {
  const { out, ROOT } = pick([["v0.1.0", true], ["v0.2.0", false]]);
  assert.match(out, new RegExp("previous " + ROOT + "/dist/release-v0.1.0/New-ERA-Setup.exe"), out);
  assert.doesNotMatch(out, /WARNING|UNTAGGED/, "nothing to warn about: " + out);
});

test("with no tagged cut the fallback is loud and the banner is marked", () => {
  const { out, ROOT } = pick([["v0.1.0", false], ["v0.2.0", false]]);
  const prev = ROOT + "/dist/release-v0.2.0/New-ERA-Setup.exe";
  assert.match(out, /^vm-e2e: WARNING/m, "a WARNING line of its own: " + out);
  assert.ok(out.includes("UNTAGGED") && out.includes(prev), "it names the untagged cut it fell back to: " + out);
  const b = out.split("\n").find((l) => l.startsWith("== vm-e2e: candidate"));
  assert.ok(b && b.includes("previous " + prev) && b.includes("UNTAGGED"),
    "the banner never reads like the tagged case: " + b);
});
