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
import { execFileSync, spawnSync } from "node:child_process";

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

// ---- the guest profile (10/26): which Windows guest the legs drive ----
// full  = the pristine template as a family PC has it, Defender on and its
//         post-restore signature update and scan waited out. Every SIGNED cut
//         (legs A, B and C): a signed installer was once hash-flagged by Defender.
// quiet = the same guest with Defender and Windows Update kept out of the leg.
//         A patch ships no installer, only app files under the signed one, so
//         its leg B needs no Defender behaviour and skips the ~7 min quiet wait.
// Both scripts keep the decision in a block between marker comments; the blocks
// run here as bash, like the picker above. Nothing touches the VM.
const REL = fs.readFileSync(new URL("../tools/release.sh", import.meta.url), "utf8");
const relLines = REL.split("\n");
const between = (src, from, to) => {
  const ls = src.split("\n");
  const a = ls.findIndex((l) => l.startsWith(from));
  const b = ls.findIndex((l, i) => i > a && l.startsWith(to));
  assert.ok(a >= 0 && b > a, `block "${from}" … "${to}" found`);
  return ls.slice(a, b + 1).join("\n");
};
const bash = (script, args = []) => {
  const r = spawnSync("bash", ["-c", script, "t", ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

// vm-e2e.sh <dist> [prev] [--only a|b] [--post-publish] [--profile full|quiet]
const vmArgs = (...argv) => bash(`set -uo pipefail\nDIST=/d\n${between(SH, "# ---- arguments", "# ---- end of arguments")}\n` +
  'echo "ONLY=$ONLY POST=$POST PROFILE=$PROFILE PREV=$PREV"', argv);

test("vm-e2e.sh drives the full guest unless told otherwise, and says which", () => {
  assert.match(vmArgs().out, /PROFILE=full/, "no flag: today's pristine, Defender-on guest");
  assert.match(vmArgs("--only", "b").out, /ONLY=b POST=0 PROFILE=full/);
  assert.match(vmArgs("--only", "b", "--profile", "quiet").out, /ONLY=b POST=0 PROFILE=quiet/);
  assert.match(vmArgs("/x/prev.exe", "--profile", "full", "--only", "a").out, /ONLY=a POST=0 PROFILE=full PREV=\/x\/prev\.exe/,
    "the previous installer argument still lands where it did");
  assert.match(SH, /export [^\n]*VM_GUEST_PROFILE="\$PROFILE"/, "the legs read the profile from VM_GUEST_PROFILE");
  assert.match(SH, /^echo "-- guest profile: \$PROFILE/m, "the run log names the profile on a line of its own");
});

test("vm-e2e.sh refuses an unknown profile, and a quiet leg C, before it touches anything", () => {
  const bad = vmArgs("--profile", "fast");
  assert.equal(bad.code, 2, bad.out); assert.match(bad.out, /full or quiet/);
  assert.equal(vmArgs("--profile").code, 2, "a bare --profile is refused, not read as the next flag");
  const c = vmArgs("--post-publish", "--profile", "quiet");
  assert.equal(c.code, 2, c.out);
  assert.match(c.out, /leg C/i, "leg C measures what Windows shows a family: Defender stays on: " + c.out);
  assert.match(vmArgs("--post-publish").out, /ONLY=c POST=1 PROFILE=full/);
  // the refusals sit before the run deletes gate/vm-e2e or a stale VM-GREEN
  assert.ok(SH.indexOf("# ---- end of arguments") < SH.indexOf('rm -rf "$OUT"'), "argument checks come before any deletion");
});

test("VM-GREEN names the profile the legs drove", () => {
  assert.match(SH, /printf 'legs=%s\\ntarball=%s\\nat=%s\\nprofile=%s\\n'/, "a profile= line in the marker");
  assert.match(SH, /"\$\(date \+%s\)" "\$PROFILE" > "\$DIST\/VM-GREEN"/, "…holding the profile this run used");
});

// release.sh: patch → quiet, signed → full, --vm-profile=… overrides; a signed
// cut never publishes on quiet evidence.
const relParse = relLines.find((l) => l.startsWith('for a in "$@"; do case "$a" in'));
const relInit = relLines.find((l) => l.startsWith('PRE=""; DRY=0;'));
const relProfile = (...argv) => bash(`set -uo pipefail\n${relInit}\n${relParse}\n` +
  `${between(REL, "# ---- the VM guest profile", "# ---- end of the VM guest profile")}\necho "VMPROFILE=$VMPROFILE"`, argv);

test("release.sh: a patch drives the quiet guest, a signed cut the full one", () => {
  assert.ok(relParse && relInit, "the flag loop and its defaults are one line each");
  assert.match(relProfile("--patch").out, /^VMPROFILE=quiet$/m);
  assert.match(relProfile().out, /^VMPROFILE=full$/m);
  assert.match(relProfile("--dry-run").out, /^VMPROFILE=full$/m);
});

test("release.sh: --vm-profile overrides either way, but a signed cut publishes only on full", () => {
  assert.match(relProfile("--patch", "--vm-profile=full").out, /^VMPROFILE=full$/m, "a patch may take the slow, Defender-on guest");
  assert.match(relProfile("--dry-run", "--vm-profile=quiet").out, /^VMPROFILE=quiet$/m, "a signed dry run may rehearse on quiet");
  const s = relProfile("--vm-profile=quiet");
  assert.equal(s.code, 2, s.out); assert.match(s.out, /signed/i); assert.match(s.out, /full/);
  const bad = relProfile("--vm-profile=fast");
  assert.equal(bad.code, 2, bad.out); assert.match(bad.out, /full or quiet/);
});

test("release.sh hands the profile to both VM runs and leaves leg C on the full guest", () => {
  const calls = relLines.filter((l) => /tools\/vm-e2e\.sh"/.test(l));
  const patch = calls.find((l) => /--only b/.test(l)), signed = calls.find((l) => !/--only|--post-publish/.test(l)), c = calls.find((l) => /--post-publish/.test(l));
  assert.ok(patch && signed && c, "three vm-e2e.sh calls: patch, signed, leg C");
  assert.match(patch, /--profile "\$VMPROFILE"/); assert.match(signed, /--profile "\$VMPROFILE"/);
  assert.doesNotMatch(c, /--profile/, "leg C runs on vm-e2e.sh's default, the full guest");
});

// vm_green() is lifted whole and run against a scratch dist
const vmGreenFn = between(REL, "vm_green() {", "}");
function green(want, marker) {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-green-"));
  fs.writeFileSync(path.join(D, "new-era-suite-v9.tar.gz"), "bytes");
  const sha = execFileSync("sha256sum", [path.join(D, "new-era-suite-v9.tar.gz")], { encoding: "utf8" }).split(" ")[0];
  fs.writeFileSync(path.join(D, "latest.json"), JSON.stringify({ version: "v9", sha256: sha }));
  fs.writeFileSync(path.join(D, "VM-GREEN"), marker.replace("SHA", sha));
  return bash(`DIST=${JSON.stringify(D)}; V=v9\n${vmGreenFn}\nvm_green ${want} && echo ACCEPTED`);
}

test("a signed cut accepts only full-guest evidence; a patch accepts either", () => {
  assert.match(green("a,b", "legs=a,b\ntarball=SHA\nat=1\nprofile=full\n").out, /ACCEPTED/);
  const q = green("a,b", "legs=a,b\ntarball=SHA\nat=1\nprofile=quiet\n");
  assert.equal(q.code, 1); assert.doesNotMatch(q.out, /ACCEPTED/);
  assert.match(q.out, /profile=quiet/, "the refusal names the evidence it holds: " + q.out);
  assert.match(green("a,b", "legs=a,b\ntarball=SHA\nat=1\n").out, /ACCEPTED/, "a marker from before profiles was a full run");
  assert.match(green("b", "legs=b\ntarball=SHA\nat=1\nprofile=quiet\n").out, /ACCEPTED/);
  assert.match(green("b", "legs=b\ntarball=SHA\nat=1\nprofile=full\n").out, /ACCEPTED/);
  assert.match(green("b", "legs=b\ntarball=SHA\nat=1\nprofile=quiet\n").out, /profile=quiet/, "and says which evidence it is publishing on");
});

// A signed cut ships a new installer, so its gate runs every suite fresh: no
// pass reused from an earlier run (era-gate.sh --no-cache; design 2026-10-26
// 3.2, the maintainer's decision 10/27). A patch takes the cache-aware gate.
test("release.sh's gate runs fully fresh for a signed cut and cache-aware for a patch", () => {
  const REL = fs.readFileSync(new URL("../tools/release.sh", import.meta.url), "utf8");
  const choose = REL.match(/^[ \t]*GATE_ARGS=\(\); \[ "\$PATCH" = 1 \] \|\| GATE_ARGS=\(--no-cache\)$/m);
  assert.ok(choose, "release.sh chooses the gate's arguments from the cut's shape");
  const call = REL.match(/^[ \t]*bash "\$HUB\/tools\/era-gate\.sh" "\$\{GATE_ARGS\[@\]\}" \| tail -1 \| tee \/tmp\/era-release-gate\.txt$/m);
  assert.ok(call && call.index > choose.index, "and the one gate call passes them");
  assert.equal(REL.match(/tools\/era-gate\.sh"/g).length, 1, "there is no other gate call");
  for (const [patch, args] of [["0", "--no-cache"], ["1", ""]]) {
    const out = execFileSync("bash", ["-c", `set -euo pipefail\nPATCH=${patch}\n${choose[0].trim()}\necho "[\${GATE_ARGS[*]}]"`], { encoding: "utf8" });
    assert.equal(out.trim(), `[${args}]`, patch === "1" ? "a patch" : "a signed cut");
  }
});

// ---- two QA hosts at once (10/27) ----
// Two vm-e2e runs (two worktrees, or two releases) go side by side, each on its
// own QA host. What used to be machine-wide is now per run: the run slot (one
// numbered lock per host, up to QA_MAX_HOSTS), the host's address (qa.sh up's
// last line, exported as VM_DROPLET, never the shared vm.env), and the local
// DevTools tunnel (a port of its own, an ssh child whose pid is the only thing
// cleanup kills). qa.sh's own rule — a second host when every one is held by a
// live run, up to QA_MAX_HOSTS — lives in the private repo and is tested there
// (era-family tools/vm/qa-test.sh, a stub doctl); here the hub side is run as
// bash against scratch locks, a stub ssh and OS-chosen loopback ports.
const slotBlock = between(SH, "# ---- run slot", "# ---- end of run slot");
const hostBlock = between(SH, "# ---- the QA host this run leased", "# ---- end of the QA host this run leased");
const tunnelBlock = between(SH, "# ---- the DevTools tunnel", "# ---- end of the DevTools tunnel");
const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n");

test("no shared tunnel is killed by pattern, and the legs get this run's port", () => {
  assert.doesNotMatch(code, /pkill[^\n]*9222/, "no pkill of a :9222 tunnel left (it would take another run's down)");
  assert.doesNotMatch(code, /ssh -f /, "the tunnel is a child with a known pid, not a self-backgrounded ssh");
  assert.doesNotMatch(code, /killall/);
  assert.match(tunnelBlock, /^cleanup\(\) \{ \[ -n "\$TUNNEL_PID" \] && kill "\$TUNNEL_PID"/m, "cleanup kills the tunnel by its pid");
  assert.match(tunnelBlock, /export VM_CDP="http:\/\/127\.0\.0\.1:\$CDP_PORT"/, "the legs read the port from VM_CDP");
  assert.match(tunnelBlock, /trap cleanup EXIT\n# ---- end of the DevTools tunnel/, "the block ends by arming cleanup (the windows runner replaces exactly this span)");
});

// a scratch run: stub ssh on PATH that serves the -L port it was given until killed
function scratchTunnel() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-tunnel-"));
  const bin = path.join(T, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/bash
for a in "$@"; do case "$a" in 127.0.0.1:*:127.0.0.1:9223) port="\${a#127.0.0.1:}"; port="\${port%%:*}";; esac; done
echo "$$ $port" >> ${JSON.stringify(path.join(T, "ssh.log"))}
exec python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(); time.sleep(600)' "$port"
`, { mode: 0o755 });
  return { T, bin };
}
// a loopback port the OS hands out, held open by a listener for the test's life
function holdPort() {
  const r = spawnSync("python3", ["-c", "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1])"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the tunnel takes this run's own port, skips one in use, and cleanup kills only its own pid", async () => {
  const { T, bin } = scratchTunnel();
  // occupy a base port with a real listener, so the block must step past it
  const net = await import("node:net");
  const busy = net.createServer(); await new Promise((ok) => busy.listen(0, "127.0.0.1", ok));
  const base = busy.address().port;
  // a decoy shaped like the OLD shared tunnel: the old pkill pattern would hit it
  const decoy = spawnSync("bash", ["-c", "(exec -a 'ssh -f -N -L 9222:127.0.0.1:9223 root@qa' sleep 30) >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const decoyPid = Number(decoy.stdout.trim());
  try {
    const script = `set -uo pipefail\nPATH=${JSON.stringify(bin)}:$PATH\nSLOT=1 VM_CDP_BASE=${base} VM_SSH_KEY=/dev/null VM_DROPLET=qa.invalid VM_GUEST_SSH_PORT=2222\n` +
      `DROP=true; qa_release(){ echo QA_RELEASED; }\n${tunnelBlock}\necho "PORT=$CDP_PORT PID=$TUNNEL_PID CDP=$VM_CDP"\n` +
      `ss -Hltn "sport = :$CDP_PORT" | grep -q . && echo LISTENING\ntrap - EXIT; cleanup; sleep 0.3; kill -0 "$TUNNEL_PID" 2>/dev/null && echo STILL_UP || echo TUNNEL_GONE`;
    const r = bash(script);
    const m = r.out.match(/PORT=(\d+) PID=(\d+) CDP=(\S+)/);
    assert.ok(m, r.out);
    const port = Number(m[1]);
    assert.ok(port > base, `a port in use (${base}) is skipped: got ${port}`);
    assert.equal(m[3], `http://127.0.0.1:${port}`, "VM_CDP names the run's port");
    assert.match(r.out, /LISTENING/, "the block waited until the tunnel listened");
    assert.match(fs.readFileSync(path.join(T, "ssh.log"), "utf8"), new RegExp(`^${m[2]} ${port}$`, "m"), "its pid is the ssh child serving that port");
    assert.match(r.out, /TUNNEL_GONE/, "cleanup killed the tunnel");
    assert.match(r.out, /QA_RELEASED/, "and released the host");
    assert.ok(alive(decoyPid), "a tunnel-shaped process that is not this run's survived cleanup");
  } finally {
    busy.close(); try { process.kill(decoyPid); } catch {}
  }
});

test("slot 2 starts its tunnel ten ports above slot 1, so two runs never race for one port", () => {
  const { bin } = scratchTunnel();
  const base = holdPort();   // free a moment ago; slot 2 asks for base+10
  const r = bash(`set -uo pipefail\nPATH=${JSON.stringify(bin)}:$PATH\nSLOT=2 VM_CDP_BASE=${base} VM_SSH_KEY=/dev/null VM_DROPLET=qa.invalid VM_GUEST_SSH_PORT=2222\nDROP=true; qa_release(){ :; }\n${tunnelBlock}\necho "PORT=$CDP_PORT"; trap - EXIT; cleanup`);
  const port = Number((r.out.match(/PORT=(\d+)/) || [])[1]);
  assert.ok(port >= base + 10 && port < base + 20, r.out);
});

const slot = (dir, env = "") => bash(`set -uo pipefail\nVM_LOCKS=${JSON.stringify(dir)}\n${env}\n${slotBlock}\necho "SLOT=$SLOT"`);
test("a run takes the first free run slot; at QA_MAX_HOSTS it waits, then gives up", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-slot-"));
  assert.match(slot(D).out, /^SLOT=1$/m, "nothing running: slot 1");
  assert.match(SH, /slot_lock="\$\{VM_LOCKS:-\/tmp\}\/era-vm-e2e\.lock"/, "slot 1 is the historic lock file (the windows runner's legacy slot holds it)");
  // hold slot 1 the way a running vm-e2e.sh does, in a child process for the test's life
  const hold = (n) => {
    const f = path.join(D, n === 1 ? "era-vm-e2e.lock" : `era-vm-e2e.${n}.lock`);
    const p = spawnSync("bash", ["-c", `(exec 9>${JSON.stringify(f)}; flock -n 9 && exec sleep 30) >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
    return Number(p.stdout.trim());
  };
  const h1 = hold(1);
  try {
    spawnSync("sleep", ["0.3"]);
    assert.match(slot(D).out, /^SLOT=2$/m, "slot 1 busy: a second run takes slot 2");
    const one = slot(D, "QA_MAX_HOSTS=1 ERA_VM_SLOT_WAIT=0");
    assert.equal(one.code, 1, one.out);
    assert.match(one.out, /busy \(QA_MAX_HOSTS=1\)/, "QA_MAX_HOSTS=1 is the old one-run rule: " + one.out);
    const h2 = hold(2);
    try {
      spawnSync("sleep", ["0.3"]);
      const full = slot(D, "ERA_VM_SLOT_WAIT=0");
      assert.equal(full.code, 1, "both slots busy: no third run: " + full.out);
    } finally { process.kill(h2); }
  } finally { process.kill(h1); }
});

test("the run drives THE host qa.sh up leased it, exported over data/vm.env", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-host-"));
  const up = path.join(D, "qa-up.txt");
  fs.writeFileSync(up, "qa: up: every QA host is held (by 1001:vm-e2e-1) — a host of my own\nqa: up: QA host 192.0.2.2 ready in 90s\nQA_HOST=192.0.2.2 QA_HOST_ID=1002 QA_LEASE=vm-e2e-7\n");
  const r = bash(`set -uo pipefail\nQA_UP=${JSON.stringify(up)}\nVM_DROPLET=192.0.2.99\n${hostBlock}\ndeclare -p VM_DROPLET`);
  assert.match(r.out, /declare -x VM_DROPLET="192\.0\.2\.2"/, "exported, so env.sh keeps it over the file: " + r.out);
  assert.match(r.out, /QA host 1002 leased to this run/);
  fs.writeFileSync(up, "qa: status line only\n");
  const none = bash(`set -uo pipefail\nQA_UP=${JSON.stringify(up)}\nunset VM_DROPLET\n${hostBlock}\necho "[\${VM_DROPLET:-unset}]"`);
  assert.match(none.out, /no QA_HOST= line/, "a qa.sh without the line (an older private repo) says so: " + none.out);
  assert.match(none.out, /\[unset\]/, "and leaves the address to env.sh's file value");
  // the order: up (its output kept), then this block, then env.sh reads the address
  const at = (s) => SH.indexOf(s);
  assert.ok(at('bash "$VMT/qa.sh" up | tee "$QA_UP"') > 0, "qa.sh up's output is kept in the run's own dir");
  assert.ok(at('bash "$VMT/qa.sh" up | tee "$QA_UP"') < at("# ---- the QA host this run leased") &&
    at("# ---- end of the QA host this run leased") < at('. "$VMT/env.sh"'), "up → export → env.sh");
});

test("one run per tree and per dist; the gate output and VM-GREEN are never shared", () => {
  assert.match(SH, /exec 7>"\$VM_LOCKS\/era-vm-e2e-tree-\$\(lock_key "\$HUB"\)\.lock"/);
  assert.match(SH, /exec 8>"\$VM_LOCKS\/era-vm-e2e-dist-\$\(lock_key "\$DIST"\)\.lock"/);
  assert.ok(SH.indexOf("exec 7>") < SH.indexOf('rm -rf "$OUT"'), "the tree lock is held before gate/vm-e2e is wiped");
});

test("two releases never share the VM run's verdict file", () => {
  assert.doesNotMatch(REL, /\/tmp\/era-release-vm-e2e\.txt/, "no fixed /tmp file another release could overwrite mid-grep");
  assert.match(REL, /^VMLOG="\/tmp\/era-release-vm-e2e\.\$\$\.txt"$/m);
  const calls = relLines.filter((l) => /tools\/vm-e2e\.sh" "\$DIST" (--only|--profile)/.test(l));
  assert.equal(calls.length, 2); for (const c of calls) assert.match(c, /\| tee "\$VMLOG" \|/);
  assert.match(REL, /^export QA_KEEP=1$/m, "release.sh still holds its host across its legs");
  assert.match(REL, /trap 'QA_KEEP=0 bash "\$ROOT\/era-family\/tools\/vm\/qa\.sh" down \|\| true' EXIT/, "and tears it down on exit");
});

test("under ERA_WT_SUFFIX the run and its legs use the era-family worktree's VM tools", () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "era-vm-sfx-"));
  fs.mkdirSync(path.join(D, "era-family--wt-x", "tools", "vm"), { recursive: true });
  const block = lines.slice(lines.findIndex((l) => l.startsWith('VMT="$ROOT/era-family/tools/vm"')),
    lines.findIndex((l) => l.trim().startsWith('VMT="$ROOT/era-family${ERA_WT_SUFFIX}/tools/vm"')) + 2).join("\n");
  const run = (sfx) => bash(`ROOT=${JSON.stringify(D)}\nunset ERA_VM_TOOLS\n${sfx}\n${block}\necho "VMT=$VMT TOOLS=\${ERA_VM_TOOLS:-}"`).out;
  assert.match(run(""), new RegExp(`VMT=${D}/era-family/tools/vm TOOLS=$`, "m"), "no suffix: the sibling checkout, nothing exported");
  assert.match(run("ERA_WT_SUFFIX=--wt-x"), new RegExp(`VMT=${D}/era-family--wt-x/tools/vm TOOLS=${D}/era-family--wt-x/tools/vm`), "the worktree, exported for the legs");
  assert.match(run("ERA_WT_SUFFIX=--wt-none"), new RegExp(`VMT=${D}/era-family/tools/vm TOOLS=$`, "m"), "a suffix with no such worktree falls back");
  const VMLIB = fs.readFileSync(new URL("../tests-vm/lib/vm.mjs", import.meta.url), "utf8");
  assert.match(VMLIB, /path\.join\(process\.env\.ERA_VM_TOOLS \|\| VMTOOLS, args\[0\]\)/, "vm.mjs runs vm.sh from the same place");
});
