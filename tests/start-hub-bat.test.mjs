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

test("the page renders at the panel's real size (--force-device-scale-factor=1)", () => {
  // Her I-13 is 1920x1080 at 150% text scaling: without this flag the browser
  // hands the page a 1280x720 window and every tile, letter row and book cover
  // is 1.5x oversized (dad 9/6: Making Words AND the Book Reader). The old
  // suite forced it (aac-studio/install/windows-device.ps1) and the gaze
  // engine's own kiosk still does (ERAgaze.cs LaunchStreamingKiosk).
  assert.ok(kioskLine.includes("--force-device-scale-factor=1"), "kiosk forces scale 1");
  assert.ok(kioskLine.indexOf("--force-device-scale-factor=1") < kioskLine.indexOf("--kiosk"),
    "the scale flag comes before --kiosk");
});

test("a relaunch closes our own kiosk first, and only ours", () => {
  // Chromium with the SAME --user-data-dir does not start a browser: it hands
  // the url to the running one, which ignores --kiosk on that hand-off and
  // opens a plain window with the taskbar over its bottom row (dad 9/6). The
  // gaze engine already guards its streaming kiosk this way (ERAgaze.cs
  // KillChromeByCmd, "a same-profile relaunch would JOIN the existing Chrome").
  const kill = bat.split("\n").find((l) => /^wmic process where /.test(l));
  assert.ok(kill, "the launcher closes any kiosk on our profile before launching");
  assert.ok(bat.indexOf(kill) < bat.indexOf(kioskLine), "it runs BEFORE the kiosk launch");
  // scoped to the two browsers we launch — wmic must never match itself
  assert.ok(/name='msedge\.exe' or name='chrome\.exe'/.test(kill), "scoped to msedge/chrome only");
  // OUR marker only: the gaze engine's own profile dirs are "streaming-profile"
  // and "<its base dir name>-profile", neither of which contains this marker —
  // and the engine itself identifies the hub's kiosks by exactly this string.
  assert.ok(/commandline like '%%kiosk-profile%%'/.test(kill), "matched on the kiosk-profile marker");
  assert.ok(!/streaming-profile/.test(kill), "never touches the gaze engine's own kiosks");
  // %% is how a .bat writes a literal % — a single % would be read as a variable
  assert.ok(!/like '%kiosk-profile%'/.test(kill), "the LIKE wildcards are doubled for cmd");
  assert.ok(/^timeout \/t \d+ \/nobreak >nul$/m.test(bat.slice(bat.indexOf(kill))),
    "and gives the old window a moment to go away before launching");
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

test("an app path with ?recipe= survives the launcher (Music/Movies shortcuts, VM QA 9/5)", () => {
  // The shortcut passes the page quoted: 8377 "/board/?recipe=songs". cmd
  // strips nothing, so `if "%2"==""` re-quotes an already-quoted argument —
  // `""/board/?recipe=songs""` — and the `=` now sits OUTSIDE quotes, where
  // cmd reads it as a delimiter: "songs""=="" was unexpected at this time",
  // and the Music/Movies desktop icons did nothing at all. `%~2` strips the
  // shortcut's quotes first, so the re-quote is a single clean pair.
  assert.ok(/^if "%~2"=="" \(set OPEN=\/home\/\) else \(set OPEN=%~2\)$/m.test(bat),
    "the page argument is compared as \"%~2\" (quotes stripped, then one pair)");
  assert.ok(!/"%2"/.test(bat), "never re-quote the raw %2");
});

test("no comment in a generated launcher carries a percent sign (T7.6b: the fix's own rem killed the icons)", () => {
  // cmd expands %-variables inside `rem` lines too. The 9/5 fix above was
  // right and DEAD: its explanatory comment said "%~2, not %2", a bare
  // expansion of "/board/?recipe=songs" put an = on the rem line, and cmd
  // aborted the file — "songs was unexpected at this time" — before the if
  // ever ran. Music and Movies still did nothing on a clean install, and the
  // text-only assertions above stayed green. A comment never expands anything.
  const launchers = SH.slice(SH.indexOf("cat > \"$OUT/start-hub.bat\""));
  const rems = launchers.split("\n").filter((l) => /^\s*rem(\s|$)/i.test(l));
  assert.ok(rems.length > 5, "the launcher is commented");
  for (const l of rems) assert.ok(!l.includes("%"), "no % in a rem line: " + l);
});
