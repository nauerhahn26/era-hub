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
const kill = bat.split("\n").find((l) => /^wmic process where /.test(l));   // the relaunch guard

test("the kiosk line exists and carries the family flags", () => {
  assert.ok(kioskLine, "start-hub.bat launches a --kiosk window");
  for (const f of ["--user-data-dir=\"%~dp0data\\kiosk-profile\"", "--no-first-run", "--autoplay-policy=no-user-gesture-required"])
    assert.ok(kioskLine.includes(f), "kiosk keeps " + f);
  // The relaunch guard below terminates the previous kiosk, which is an
  // unclean exit: without this the next launch can land on a "restore pages?"
  // bubble sitting over her first tap. Never a bubble on a child's screen.
  assert.ok(kioskLine.includes("--hide-crash-restore-bubble"), "kiosk hides the crash-restore bubble");
  assert.ok(kioskLine.indexOf("--force-device-scale-factor=1") < kioskLine.indexOf("--hide-crash-restore-bubble"),
    "it sits with the scale flag");
  // ...and BOTH ahead of --kiosk, which is where the url follows: a flag after
  // the url is a second url to Chromium, not a flag (the message here used to
  // say "ahead of --kiosk" while comparing the two flags only to each other).
  assert.ok(kioskLine.indexOf("--hide-crash-restore-bubble") < kioskLine.indexOf("--kiosk"),
    "and ahead of --kiosk, before the url");
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
  assert.ok(kill, "the launcher closes any kiosk on our profile before launching");
  assert.ok(bat.indexOf(kill) < bat.indexOf(kioskLine), "it runs BEFORE the kiosk launch");
  // A wmic that only LISTS is not a guard. The verb was never pinned here, so
  // `call terminate` -> `get processid` left the whole suite green while the
  // taskbar sat back over her letters — and the tail matters as much: this
  // window is a child's, so wmic's chatter goes to nul, and a wmic that
  // suddenly prints is a wmic that changed shape.
  assert.ok(/ call terminate\b/.test(kill), "the guard TERMINATES what it matched");
  assert.ok(/ call terminate >nul 2>&1$/.test(kill), "quietly: nothing prints on her screen");
  // scoped to the two browsers we launch — wmic must never match itself
  assert.ok(/name='msedge\.exe' or name='chrome\.exe'/.test(kill), "scoped to msedge/chrome only");
  // OUR marker only. What that sweep does and does not touch is a claim about
  // real command lines, so it is made against real command lines in the
  // fixture test below, not by looking for a word in this one line.
  assert.ok(/commandline like '%%kiosk-profile%%'/.test(kill), "matched on the kiosk-profile marker");
  // %% is how a .bat writes a literal % — a single % would be read as a variable
  assert.ok(!/like '%kiosk-profile%'/.test(kill), "the LIKE wildcards are doubled for cmd");
  // The grace period must sit BETWEEN the kill and the launch — presence alone
  // passed happily with the wait moved below `start`, i.e. a kill with no grace
  // at all, which is the exact bug (the dying browser still owns the profile
  // lock, so the new one joins it and drops out of kiosk).
  const grace = /^timeout \/t \d+ \/nobreak >nul$/m.exec(bat.slice(bat.indexOf(kill), bat.indexOf(kioskLine)));
  assert.ok(grace, "and gives the old window a moment to go away AFTER the kill and BEFORE the launch");
});

test("the sweep closes our kiosks and nothing else (real command lines)", () => {
  // The scoping claim, made where it can fail. Everything below is a command
  // line that really exists on her I-13 while New ERA is running, checked
  // against the WQL this launcher actually generates — because the guard is
  // one unanchored LIKE over every msedge/chrome on the machine, and the
  // windows it must not touch belong to the gaze engine, the old suite and
  // dad's own browsing.
  const where = /^wmic process where "([^"]+)"/.exec(kill || "")?.[1];
  const shape = /^\(name='([^']+)' or name='([^']+)'\) and commandline like '([^']+)'$/.exec(where || "");
  assert.ok(shape, "the guard is still <two exact exe names> AND <one commandline LIKE>; " +
    "any other shape needs these fixtures re-checked by hand: " + where);
  const names = [shape[1], shape[2]];
  // A backslash would make this a question about escaping (wmic unescapes the
  // where-clause, and WQL unescapes again), and an over-escaped LIKE matches
  // NOTHING while still looking right — the guard would fail silently and dad
  // 9/6 comes back. Prove the doubling on a real Windows box before adding one.
  assert.ok(!shape[3].includes("\\"), "no backslash in the WQL pattern (escaping unproven)");
  // WQL LIKE as wmic receives it: %% is the .bat's way of writing one literal
  // %, % matches any run, _ matches one character. Nothing else is special.
  const rx = new RegExp("^" + shape[3].replace(/%%/g, "%").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]") + "$", "i");

  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const GAZE = "C:\\Users\\Public\\ERAgaze";           // the engine's BaseDir
  // ours, built FROM the launcher's own kiosk line: rename the profile dir
  // there and forget the WQL here, and this fixture stops matching.
  const ours = kioskLine.replace(/^start "" /, "").replace(/%B%/g, EDGE)
    .replace(/%~dp0/g, "C:\\Users\\Family\\AppData\\Local\\New ERA\\")
    .replace(/%PORT%/g, "8377").replace(/%OPEN%/g, "/home/").replace(/%CDP%/g, "").trim();
  const gazeKiosk = "--force-device-scale-factor=1 --no-first-run --disable-pinch " +
    "--overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --kiosk";
  const fixtures = [
    { exe: "msedge.exe", cmd: ours, swept: true, why: "our own kiosk (Edge)" },
    { exe: "chrome.exe", cmd: ours.replace(EDGE, CHROME), swept: true, why: "our own kiosk (Chrome)" },
    // ERAgaze.cs LaunchStreamingKiosk: a movie is playing in this one.
    { exe: "chrome.exe", cmd: "\"" + CHROME + "\" " + gazeKiosk + " --user-data-dir=\"" + GAZE +
        "\\streaming-profile\" \"https://example.com/watch\"", swept: false, why: "the engine's streaming kiosk" },
    // its picker kiosk — the family build's marker is <BaseDir name>-profile
    { exe: "chrome.exe", cmd: "\"" + CHROME + "\" " + gazeKiosk + " --user-data-dir=\"" + GAZE +
        "\\ERAgaze-profile\" \"http://127.0.0.1:8377/board/\"", swept: false, why: "the engine's picker kiosk" },
    // the old suite's launchers (aac-studio/install/windows-device.ps1), still
    // installed alongside on a device mid-migration
    { exe: "chrome.exe", cmd: "\"" + CHROME + "\" " + gazeKiosk + " \"http://127.0.0.1:8080/\" --user-data-dir=" +
        GAZE + "\\studio-profile", swept: false, why: "the old suite's Making Words" },
    { exe: "chrome.exe", cmd: "\"" + CHROME + "\" " + gazeKiosk + " \"http://127.0.0.1:8080/board/?recipe=songs\" " +
        "--user-data-dir=" + GAZE + "\\music-profile", swept: false, why: "the old suite's Music" },
    // TD Snap is never touched: it is UWP and its browser host is a DIFFERENT
    // exe name, which only an exact-equality name filter keeps out.
    { exe: "msedgewebview2.exe", cmd: "\"C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe\"" +
        " --embedded-browser-webview=1 --user-data-dir=\"C:\\Users\\Family\\AppData\\Local\\Packages" +
        "\\Snap.Windows.WinUI.OEM\\EBWebView\"", swept: false, why: "TD Snap's WebView2 host" },
    { exe: "msedge.exe", cmd: "\"" + EDGE + "\" --profile-directory=Default", swept: false, why: "dad's own browser window" },
    // wmic's own process carries the marker in its command line — the sweep
    // would kill itself mid-sweep if it went by command line alone.
    { exe: "wmic.exe", cmd: kill, swept: false, why: "the sweep itself" },
  ];
  for (const f of fixtures)
    assert.equal(names.includes(f.exe) && rx.test(f.cmd), f.swept,
      (f.swept ? "the sweep must close " : "the sweep must NEVER close ") + f.why + ": " + f.cmd);
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
