// start-hub-bat.test.mjs — the kiosk launcher the family double-clicks. The
// unattended VM e2e (docs/e2e-deploy-gate-plan.md, 9/3) drives the REAL kiosk
// window over the Chrome DevTools Protocol, which needs one extra flag — and
// a family must never get that flag: it is added only when ERA_QA_CDP is set
// in the environment of the launcher. Also holds the 8/29 Defender law:
// nothing in the payload invokes PowerShell.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SH = fs.readFileSync(new URL("../tools/build-payload.sh", import.meta.url), "utf8");
const bat = SH.slice(SH.indexOf("cat > \"$OUT/start-hub.bat\""), SH.indexOf("\nBAT\n", SH.indexOf("cat > \"$OUT/start-hub.bat\"")));
const kioskLine = bat.split("\n").find((l) => l.includes("--kiosk"));

test("the kiosk line exists and carries the family flags", () => {
  assert.ok(kioskLine, "start-hub.bat launches a --kiosk window");
  for (const f of ["--user-data-dir=\"%~dp0data\\kiosk-profile\"", "--no-first-run", "--autoplay-policy=no-user-gesture-required"])
    assert.ok(kioskLine.includes(f), "kiosk keeps " + f);
});

test("CDP is opt-in via ERA_QA_CDP and never a bare port", () => {
  assert.ok(/if defined ERA_QA_CDP set CDP=--remote-debugging-port=%ERA_QA_CDP%/.test(bat),
    "the flag is built only when ERA_QA_CDP is defined");
  assert.ok(kioskLine.includes(" %CDP%"), "the kiosk line takes the (usually empty) %CDP%");
  assert.ok(!/remote-debugging-port=\d/.test(bat), "no hard-coded debugging port");
  assert.ok(/^set CDP=$/m.test(bat), "CDP is cleared before the guard (a stale env var never leaks in)");
});

test("no PowerShell anywhere in the generated launchers (Defender 8/29)", () => {
  // the generated files only — the shell script's own comments may say the word
  const launchers = SH.slice(SH.indexOf("cat > \"$OUT/start-hub.bat\"")).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/powershell/i.test(launchers));
});
