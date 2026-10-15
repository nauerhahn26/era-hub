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
// exe_of: an installer is found by the name its own dist's latest.json records
// (`installer_file`, 9/26 rename: New-ERA-Setup.exe -> Our-Era-Comms-Setup.exe);
// a dist that predates the field is a New-ERA-Setup.exe cut.
const exeOf = lines.find((l) => l.startsWith("exe_of() {"));
// the picker block, between its two marker comments: the candidate's installer
// name, the patch pair (a patch release re-attaches an older signed installer,
// so $DIST's own Setup.exe IS what the family runs and leg B starts from it),
// the live installer release.sh downloaded into $DIST/prev/, and the scan of
// the other tagged dist dirs.
const start = lines.findIndex((l) => l.startsWith("# ---- leg B's starting installer"));
const end = lines.findIndex((l, i) => i > start && l.startsWith("# ---- end of leg B's starting installer"));
const picker = lines.slice(start, end + 1).join("\n");
// the banner sits indented in the non---post-publish branch, and the UNTAGGED
// mark it carries is assembled on the line immediately above it (PREV_NOTE), so
// both lines are taken together — one without the other prints nothing useful
const bannerAt = lines.findIndex((l) => l.trim().startsWith('echo "== vm-e2e: candidate'));
const noteAt = bannerAt - 1;
const banner = [lines[noteAt], lines[bannerAt]].map((l) => l.trim()).join("\n");

test("the picker and banner are where this test thinks they are", () => {
  assert.ok(start > 0 && end > start, "the PREV picker block was found (between its marker comments)");
  assert.ok(exeOf, "exe_of() is a one-line function the test can lift");
  assert.match(picker, /^PATCH_INSTALLER=/m, "the patch detection sits inside the block");
  assert.match(picker, /^CAND_EXE="\$\(exe_of "\$DIST"\)"$/m, "the candidate's installer is named by its own latest.json");
  assert.ok(bannerAt > 0, "the one-line banner naming candidate and previous was found");
  // a reshuffle that moves PREV_NOTE away from the banner must fail here, not
  // as a mystifying empty mark in the run-the-bash tests below
  assert.match(lines[noteAt].trim(), /^if \[ -n "\$PATCH_INSTALLER" \]; then PREV_NOTE=/,
    "the line above the banner is the one that assembles PREV_NOTE");
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
// dirs given: each entry is [dirname, tagged, installer_file?] — with a third
// element the dir gets a latest.json naming it and the exe is written under
// that name. `latest`, when given, is written into the candidate dir (with a
// stand-in installer beside it, under its installer_file or the old name) so
// the patch pair has something to read. `prev` puts that file name in
// $DIST/prev/, where release.sh leaves the live installer. Returns what the
// picker printed and the PREV it settled on.
function pick(dists, latest, { prev } = {}) {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-e2e-"));
  const HUB = path.join(ROOT, "era-hub");
  fs.mkdirSync(HUB);
  const git = (...a) => execFileSync("git", ["-C", HUB, ...a], { stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "x");
  const DIST = path.join(ROOT, "dist", "release-candidate");
  fs.mkdirSync(DIST, { recursive: true });
  if (latest) {
    fs.writeFileSync(path.join(DIST, "latest.json"), JSON.stringify(latest));
    fs.writeFileSync(path.join(DIST, latest.installer_file || "New-ERA-Setup.exe"), "stand-in");
  }
  if (prev) {
    fs.mkdirSync(path.join(DIST, "prev"));
    fs.writeFileSync(path.join(DIST, "prev", prev), "stand-in");
  }
  let t = Date.now() - 60_000 * dists.length;
  for (const [name, tagged, file] of dists) {
    const d = path.join(ROOT, "dist", "release-" + name);
    fs.mkdirSync(d, { recursive: true });
    if (file) fs.writeFileSync(path.join(d, "latest.json"), JSON.stringify({ version: name, installer_file: file }));
    const exe = path.join(d, file || "New-ERA-Setup.exe");
    fs.writeFileSync(exe, "stand-in");
    // oldest first: the script's `ls -dt` sorts the .exe files, not the dirs
    t += 60_000; fs.utimesSync(exe, new Date(t), new Date(t));
    if (tagged) git("tag", name);
  }
  const script = `set -uo pipefail\nHUB=${JSON.stringify(HUB)}\nROOT=${JSON.stringify(ROOT)}\nDIST=${JSON.stringify(DIST)}\nPREV="" PREV_UNTAGGED="" PREV_LIVE=""\nVER=v9 BUILD=b9\n${exeOf}\n${picker}\necho "CAND_EXE=$CAND_EXE"\n${banner}\n`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: "pipe" });
  return { out, ROOT, DIST };
}

test("a tagged cut is picked over a newer untagged one, quietly (9/5)", () => {
  const { out, ROOT } = pick([["v0.1.0", true], ["v0.2.0", false]]);
  assert.match(out, new RegExp("previous = " + ROOT + "/dist/release-v0.1.0/New-ERA-Setup.exe"), out);
  assert.doesNotMatch(out, /WARNING|UNTAGGED/, "nothing to warn about: " + out);
});

test("with no tagged cut the fallback is loud and the banner is marked", () => {
  const { out, ROOT } = pick([["v0.1.0", false], ["v0.2.0", false]]);
  const prev = ROOT + "/dist/release-v0.2.0/New-ERA-Setup.exe";
  assert.match(out, /^vm-e2e: WARNING/m, "a WARNING line of its own: " + out);
  assert.ok(out.includes("UNTAGGED") && out.includes(prev), "it names the untagged cut it fell back to: " + out);
  const b = out.split("\n").find((l) => l.startsWith("== vm-e2e: candidate"));
  assert.ok(b && b.includes("previous = " + prev) && b.includes("UNTAGGED"),
    "the banner never reads like the tagged case: " + b);
});

test("a patch dist starts leg B from its own re-attached installer, and says whose", () => {
  // latest.json's `installer` names an older cut: $DIST's Setup.exe is that
  // older signed installer, i.e. the one the family already runs
  const { out, DIST } = pick([["v0.1.0", true], ["v0.2.0", true]],
    { version: "v0.2.1", build: "b9", installer: "v0.2.0" });
  const b = out.split("\n").find((l) => l.startsWith("== vm-e2e: candidate"));
  assert.ok(b && b.includes("previous = " + path.join(DIST, "New-ERA-Setup.exe")),
    "leg B starts from the candidate dir's own installer: " + b);
  assert.ok(b.includes("(installer v0.2.0 re-attached)"),
    "and the banner names the cut it was re-attached from: " + b);
  assert.doesNotMatch(out, /WARNING|UNTAGGED/, "nothing fell back: " + out);
});

// ---- the rename (9/26): installers are found by the name latest.json records ----
test("a cut whose latest.json names Our-Era-Comms-Setup.exe is found under that name", () => {
  const { out, ROOT } = pick([["v0.35.0", true], ["v0.36.0", true, "Our-Era-Comms-Setup.exe"]]);
  assert.match(out, new RegExp("previous = " + ROOT + "/dist/release-v0\\.36\\.0/Our-Era-Comms-Setup\\.exe"), out);
});

test("a cut that predates installer_file is still found as New-ERA-Setup.exe", () => {
  const { out, ROOT } = pick([["v0.35.0", true], ["v0.36.0", false, "Our-Era-Comms-Setup.exe"]]);
  assert.match(out, new RegExp("previous = " + ROOT + "/dist/release-v0\\.35\\.0/New-ERA-Setup\\.exe"), out);
});

test("the candidate's own installer is the one its latest.json names", () => {
  const { out } = pick([["v0.35.0", true]], { version: "v0.36.0", build: "b9", installer: "v0.36.0", installer_file: "Our-Era-Comms-Setup.exe" });
  assert.match(out, /^CAND_EXE=Our-Era-Comms-Setup\.exe$/m, out);
  const old = pick([["v0.35.0", true]], { version: "v0.35.1", build: "b9", installer: "v0.35.0" });
  assert.match(old.out, /^CAND_EXE=New-ERA-Setup\.exe$/m, "a feed without the field is an old-name cut: " + old.out);
});

test("the live installer release.sh left in $DIST/prev/ is leg B's start, and the banner says so", () => {
  const { out, DIST } = pick([["v0.35.0", true]], { version: "v0.36.0", build: "b9", installer: "v0.36.0", installer_file: "Our-Era-Comms-Setup.exe" },
    { prev: "New-ERA-Setup.exe" });
  const b = out.split("\n").find((l) => l.startsWith("== vm-e2e: candidate"));
  assert.ok(b && b.includes("previous = " + path.join(DIST, "prev", "New-ERA-Setup.exe")), "leg B starts from the live installer: " + b);
  assert.match(b, /live/i, "and the banner says where it came from: " + b);
  assert.doesNotMatch(out, /WARNING|UNTAGGED/, "nothing fell back: " + out);
});

test("a patch dist under a renamed installer re-attaches it by ITS name", () => {
  const { out, DIST } = pick([["v0.36.0", true]], { version: "v0.36.1", build: "b9", installer: "v0.36.0", installer_file: "Our-Era-Comms-Setup.exe" });
  const b = out.split("\n").find((l) => l.startsWith("== vm-e2e: candidate"));
  assert.ok(b && b.includes("previous = " + path.join(DIST, "Our-Era-Comms-Setup.exe")), b);
});

// leg A's upgrade-over-old step: the rename path only exists for an install
// made by the OLD installer, so it runs only when release.sh left that exact
// file in $DIST/prev/, and says plainly when it does not.
test("the upgrade-over-old step is wired to $DIST/prev/New-ERA-Setup.exe and skips out loud", () => {
  assert.match(SH, /if \[ -f "\$DIST\/prev\/New-ERA-Setup\.exe" \]/, "gated on that exact file (never a loose *Setup.exe match)");
  assert.match(SH, /"\$DIST\/prev\/New-ERA-Setup\.exe" root@\$VM_DROPLET:\/root\/qa\/old\.exe/, "shipped to the QA host as old.exe");
  assert.match(SH, /VM_UPGRADE_OLD/, "leg A is told through VM_UPGRADE_OLD");
  assert.match(SH, /echo "vm-e2e: [^"]*upgrade-over-old[^"]*skip/i, "and the skip is a log line of its own");
});

test("no installer name is matched loosely (the 9/9 OneDriveSetup.exe lesson)", () => {
  const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n");   // the header's prose may say it
  assert.doesNotMatch(code, /\*Setup\*?\.exe|Setup\*\.exe/, "no glob around Setup.exe");
  assert.doesNotMatch(SH, /New-ERA-Setup\.exe missing/, "the candidate check names the installer by variable, not the old literal");
  assert.match(SH, /"\$DIST\/\$CAND_EXE" root@\$VM_DROPLET:\/root\/qa\/candidate\.exe/, "leg A installs the candidate by its recorded name");
});
