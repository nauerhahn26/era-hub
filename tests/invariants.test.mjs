// invariants.test.mjs — drives tests/invariants.mjs (the contract invariant
// audit) against every studio app STATE on the live :8377 server.
//
// POST-MIGRATION LAW (8/1): all apps import lib/contract.js, so every declared
// state — front doors AND in-lesson screens (MW spelling/sort, the Pencil Ring
// groups/letters, the board home) — must pass with ZERO violations at both gate
// viewports. Warns are reported, not failed. (The GAP warn band is retired as of
// 9/5 — gapWarn == gapFloor in the contract — so exact-floor pairs no longer
// list; the other warn kinds still do.)
//
// Run: node --test tests/invariants.test.mjs   (studio server must be running)
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { auditPath, STATES } from "./invariants.mjs";

function report(r) {
  const lines = [`\n=== ${r.path} ===`];
  for (const v of r.viewports) {
    lines.push(`  ${v.vp.w}x${v.vp.h}: targets=${v.nTargets} violations=${v.violations.length} warns=${v.warns.length}`);
    for (const s of v.violations) lines.push(`    VIOLATION ${s}`);
  }
  console.log(lines.join("\n"));
}

test("contract invariant audit — every app state passes clean", async () => {
  const browser = await chromium.launch();
  try {
    const all = [];
    for (const st of STATES) {
      const r = await auditPath(browser, st);
      report(r);
      all.push(...r.violations);
      // every state must actually render its screen (a broken setup would
      // "pass" by measuring nothing — targets prove the state is real)
      for (const v of r.viewports) assert.ok(v.nTargets >= 2, `${st.id}: only ${v.nTargets} targets — state did not render`);
    }
    assert.deepEqual(all, [], "contract violations:\n" + all.join("\n"));
  } finally {
    await browser.close();
  }
});
