// notify.js — one sentence to the parent's own screen, when the hub needs to
// say something the family will not see by opening a page (plan T6b.3).
//
// The one thing it says today is "out of allowance": the family never adds a
// card to Google and buys ElevenLabs by the month, so a book stopping to wait
// is the NORMAL path (spec §4 "Design target") — and a parent who is not
// sitting in Settings has, until now, had no way at all of knowing it happened.
// A toast is the smallest honest way to tell them: it costs nothing, it stays
// in Windows' own notification centre, and it is ignorable, which matters
// because waiting really is a perfectly good answer.
//
// THE APPID IS POWERSHELL'S OWN. A toast is only shown if it comes from an
// application Windows already knows about — a Start-menu AppUserModelID. The
// hub has none (it is a node process behind a scheduled task, and a
// scheduled-task session is exactly where an unknown AppId is dropped in
// silence), and registering one is an installer change with no way to prove it
// from here. PowerShell's own AppId is registered on every Windows box, so the
// toast is raised as PowerShell and appears.
//
// THE SEAM. ERA_TOAST_CMD names a command to hand the toast to INSTEAD of the
// Windows shell — it is spawned with the title and the body as its two
// arguments. That is how the tests see a toast on a Linux box without
// PowerShell existing; it is never set on a family's machine, where the
// platform check below is the whole rule. The command is split on spaces (a
// test's own path, never a family's), and nothing about it is read back.
//
// Nothing here is ever handed a key: the callers build a sentence for a parent.
"use strict";
const { spawn } = require("child_process");

// PowerShell 5.1's registered AppUserModelID — present on every Windows 10/11
// install, which is the point of borrowing it.
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

// One line of text, safe to drop inside a PowerShell single-quoted string.
// Newlines and control characters would end the statement, and a lone
// apostrophe ("Ellie's book") would end the string — PowerShell escapes that
// by doubling it, which is also what appShortcut/stepAsideFromKiosk rely on.
// NO DOUBLE QUOTES ANYWHERE (server.js:281): node's argument re-quoting mangled
// them and the whole script silently matched nothing (VM QA 9/1).
function line(s) {
  // Cut to length BEFORE the doubling, or a title trimmed mid-escape ends on a
  // lone apostrophe and the whole script is a syntax error.
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"/g, "")
    .slice(0, 200)
    .trim()
    .replace(/'/g, "''");
}

// Raise one toast. Returns true when it was handed off, false when there is
// nowhere to show it — which is the normal answer on the Linux boxes this repo
// is developed and gated on, and never an error.
//
// opts.cmd / opts.platform exist for the tests; a caller passes neither.
function toast(title, body, opts) {
  const o = opts || {};
  const cmd = o.cmd != null ? o.cmd : (process.env.ERA_TOAST_CMD || "");
  const platform = o.platform || process.platform;
  const t = line(title), b = line(body);
  if (!t && !b) return false;

  if (cmd) {
    const parts = String(cmd).split(" ").filter(Boolean);
    try {
      spawn(parts[0], parts.slice(1).concat([t, b]), { stdio: "ignore" })
        .on("error", (e) => console.error("[notify] toast: " + e.message))
        .unref();
      return true;
    } catch (e) { console.error("[notify] toast: " + e.message); return false; }
  }
  if (platform !== "win32") return false;

  // The canonical WinRT toast, in the one spawn shape proven from the
  // production (detached, console-less) hub: -Command, not detached,
  // windowsHide. ToastText02 is a bold first line and a wrapping second, which
  // is exactly "<Book> is waiting" over "out of X allowance until Y".
  const ps =
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; " +
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; " +
    "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); " +
    "$n = $x.GetElementsByTagName('text'); " +
    "$n.Item(0).AppendChild($x.CreateTextNode('" + t + "')) > $null; " +
    "$n.Item(1).AppendChild($x.CreateTextNode('" + b + "')) > $null; " +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + APP_ID + "')" +
    ".Show([Windows.UI.Notifications.ToastNotification]::new($x))";
  try {
    spawn("powershell.exe", ["-NoProfile", "-Command", ps],
      { stdio: "ignore", windowsHide: true })
      .on("error", (e) => console.error("[notify] toast: " + e.message))
      .unref();
    return true;
  } catch (e) { console.error("[notify] toast: " + e.message); return false; }
}

module.exports = { toast, APP_ID };
