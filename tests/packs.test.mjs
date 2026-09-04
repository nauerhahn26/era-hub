// packs.test.mjs — the pack map (packs.js) and the installer must agree, or
// an unticked app's files land anyway (or a ticked app's cut-out engine is
// missing). Dad 9/3 on the installer's components page: "when you reduce the
// apps you install the size stays the same" — the 21 MB garment cut-out
// runtime rode with the core. Now it is part of the board pack, and this
// test pins that the NSIS script excludes every pack path from the core
// section and lays each down in exactly one pack section.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PACKS, packInstalled, packOf, ytDlp } = require("../packs.js");
const NSI = fs.readFileSync(new URL("../tools/installer.nsi", import.meta.url), "utf8");
const DIST = fs.readFileSync(new URL("../tools/build-dist.sh", import.meta.url), "utf8");
const PAYLOAD = fs.readFileSync(new URL("../tools/build-payload.sh", import.meta.url), "utf8");
const PIN = fs.readFileSync(new URL("../tools/yt-dlp.pin", import.meta.url), "utf8");

test("every pack path is excluded from the core section and shipped by a pack section", () => {
  const core = NSI.match(/File \/r ((?:\/x \S+ )+)"\$\{PAYLOAD\}\/\*"/);
  assert.ok(core, "core section uses File /r /x ... PAYLOAD/*");
  const excluded = [...core[1].matchAll(/\/x (\S+)/g)].map(m => m[1]);
  const all = Object.values(PACKS).flat();
  for (const p of all) {
    const base = path.posix.basename(p);
    assert.ok(excluded.includes(base), base + " is excluded from the core section");
    const laid = NSI.match(new RegExp('File(?: /r)? "\\$\\{PAYLOAD\\}/' + p.replace(/\//g, "\\/") + '"', "g")) || [];
    assert.equal(laid.length, 1, p + " is laid down by exactly one section");
  }
  // nothing excluded that no pack claims — that would silently ship nothing
  for (const x of excluded)
    assert.ok(all.some(p => path.posix.basename(p) === x), "/x " + x + " belongs to a pack");
});

test("the garment cut-out runtime is part of the board pack, not the core", () => {
  const board = PACKS.board;
  for (const p of ["vendor/onnxruntime-web", "vendor/models", "vendor/libheif.js"])
    assert.ok(board.includes(p), p + " ships with the board pack");
  assert.equal(packOf("vendor/onnxruntime-web/dist/ort.node.min.js"), "board");
  assert.equal(packOf("vendor" + path.sep + "libheif.js"), "board");
  assert.equal(packOf("vendor/jpeg-js/index.js"), null);   // jpeg-js is core (photo tiles everywhere)
  assert.equal(packOf("public/pencil/index.html"), "pencil");
  assert.equal(packOf("public/pencil-extra/x"), null);     // prefix must be a whole path segment
  assert.equal(packOf("server.js"), null);
});

test("packInstalled reads the pack's presence marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "era-packs-"));
  try {
    assert.equal(packInstalled(root, "reader"), false);
    fs.mkdirSync(path.join(root, "public", "reader"), { recursive: true });
    assert.equal(packInstalled(root, "reader"), true);
    assert.equal(packInstalled(root, "board"), false);
    assert.equal(packInstalled(root, "nope"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("uninstall clears vendor\\ (the cut-out runtime used to be left behind)", () => {
  assert.match(NSI, /RMDir \/r "\$INSTDIR\\vendor"/);
});

// The installer's hover text says where the megabytes are, and those numbers
// come from build-dist.sh's du over the payload. That list was a HAND-MADE
// second copy of packs.js: add a pack there and forget it here and the new
// megabytes are silently counted as "engine". This is the only thing that
// keeps the two equal.
test("every pack path is measured by build-dist.sh, so the sizes on the page are true", () => {
  for (const p of Object.values(PACKS).flat())
    assert.ok(DIST.includes('"$P/' + p + '"'), p + " is measured (and subtracted from SZ_CORE) in build-dist.sh");
  for (const term of ["SZ_BOARD", "SZ_MEDIA"]) {
    assert.ok(DIST.includes("-D" + term + "="), term + " is handed to makensis");
    assert.ok(NSI.includes("${" + term + "}"), term + " is named in the components page text");
  }
});

// Adding a song from the web needs yt-dlp: one ~18 MB standalone binary, its
// own pack, nobody else's business. It is NOT in the repo (see the pin file);
// a build fetches it, checks its sha256, and lays it under vendor/.
test("the media-tools pack is yt-dlp, and it is nobody else's pack", () => {
  assert.deepEqual(PACKS["media-tools"], ["vendor/yt-dlp"]);
  assert.equal(packOf("vendor/yt-dlp/yt-dlp.exe"), "media-tools");
  assert.equal(packOf("vendor" + path.sep + "yt-dlp" + path.sep + "yt-dlp.exe"), "media-tools");
  assert.equal(packOf("vendor/yt-dlp-notes.txt"), null);   // whole path segment only
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "era-packs-"));
  try {
    assert.equal(packInstalled(root, "media-tools"), false);
    fs.mkdirSync(path.join(root, "vendor", "yt-dlp"), { recursive: true });
    assert.equal(packInstalled(root, "media-tools"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The binary is pinned by version AND hash in one committed file; the build
// reads it, verifies what it downloaded, and refuses to cut if the hash is
// wrong (the <2 GB free rule, applied to a download).
test("yt-dlp is pinned by version and sha256, and the build verifies before it copies", () => {
  const pin = Object.fromEntries([...PIN.matchAll(/^([A-Z0-9_]+)=(\S+)$/gm)].map(m => [m[1], m[2]]));
  assert.match(pin.YTDLP_VERSION, /^\d{4}\.\d{2}\.\d{2}$/, "a real yt-dlp release tag");
  assert.match(pin.YTDLP_EXE_SHA256, /^[0-9a-f]{64}$/, "the sha256 from that release's SHA2-256SUMS");
  assert.ok(PAYLOAD.includes("tools/yt-dlp.pin"), "build-payload.sh reads the pin");
  assert.ok(PAYLOAD.includes("$YTDLP_EXE_SHA256"), "build-payload.sh checks the hash it pinned");
  assert.ok(PAYLOAD.includes('"$OUT/vendor/yt-dlp/yt-dlp.exe"'), "and lays it where packs.js says");
  assert.ok(/releases\/download\/\$YTDLP_VERSION\/yt-dlp\.exe/.test(PAYLOAD), "from the PINNED release, never 'latest'");
});

// yt-dlp solves YouTube's JS challenges in a real JavaScript runtime. Only
// deno is enabled by default and no family PC has one — but every New ERA
// install ships its own Node, which is what runs the hub.
test("yt-dlp is pointed at the Node the hub is running on", () => {
  const win = ytDlp("C:\\Users\\x\\AppData\\Local\\New ERA", "win32");
  assert.equal(win.bin, path.join("C:\\Users\\x\\AppData\\Local\\New ERA", "vendor", "yt-dlp", "yt-dlp.exe"));
  assert.deepEqual(win.args, ["--js-runtimes", "node:" + process.execPath]);
  // no quotes around the path: yt-dlp splits the value on its FIRST colon and
  // uses the rest verbatim as the program to run, so a quote would land inside
  // the filename. The space in "New ERA" is safe — we spawn an argv array.
  assert.ok(!win.args[1].includes('"'), "the runtime path is never quoted");
  assert.equal(ytDlp("/opt/era", "linux").bin, "/opt/era/vendor/yt-dlp/yt-dlp");
});
