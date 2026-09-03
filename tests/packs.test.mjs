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
const { PACKS, packInstalled, packOf } = require("../packs.js");
const NSI = fs.readFileSync(new URL("../tools/installer.nsi", import.meta.url), "utf8");

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
