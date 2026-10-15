// era-scan-parity.test.mjs — six copies of one scanner. The repo scan CI runs
// is .github/era-scan.sh; the copy that gates the SHIPPED payload
// (tools/build-payload.sh, "never ship what hasn't been scanned") is the
// private era-family one, and the sibling repos carry their own. On 9/5 the
// Google AIza… / AQ.… and fal key shapes landed only in this repo's copy —
// the cut's scanner could not see the keys the content pipelines introduced
// (Phase 7 review). Every copy present on this box must carry the same
// PATTERNS line; copies that are not checked out are skipped, so CI (which
// has only this repo) still passes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const HUB = path.resolve(new URL("..", import.meta.url).pathname);
const NEW_ERA = path.resolve(HUB, "..");
const patternsOf = (f) => (fs.readFileSync(f, "utf8").match(/^PATTERNS='[^\n]*'$/m) || [null])[0];

const own = patternsOf(path.join(HUB, ".github/era-scan.sh"));

test("this repo's era-scan carries the 9/5 key shapes", () => {
  assert.ok(own, "PATTERNS line present");
  for (const shape of ["AIza[0-9A-Za-z_-]{35}", "AQ\\.[A-Za-z0-9_-]{30,}", "[0-9a-f]{12}:[0-9a-f]{32}"])
    assert.ok(own.includes(shape), "scanner knows " + shape);
});

test("every era-scan copy on this box carries the same PATTERNS line", () => {
  const copies = [
    "era-family/tools/era-scan.sh",
    "era-core/.github/era-scan.sh",
    "era-board/.github/era-scan.sh",
    "era-pencil/.github/era-scan.sh",
    "era-making-words/.github/era-scan.sh",
  ].map((p) => path.join(NEW_ERA, p)).filter((p) => fs.existsSync(p));
  for (const f of copies) assert.equal(patternsOf(f), own, "drifted: " + f);
});
