// The Windows guest a VM leg drives (tools/vm-e2e.sh --profile; release.sh
// picks it: a patch quiet, a signed cut full), and the readiness check that
// replaces the quiet wait on the quiet profile. Pure: vm.mjs drives it, and
// tests-vm/guest-profile.test.mjs checks it without a VM.
//
// full  = the template's pristine snapshot, as a family PC has it: Defender on.
//         Every revert boots signatures weeks out of date, so Defender pulls an
//         update and scans while a Windows servicing job runs: vm.quiet() waits
//         that out (407 s before leg B's first check on 10/26). Every signed cut.
// quiet = the template's separately named `quiet` snapshot, made from the
//         pristine one (aac-board-builder/docs/vm-e2e.md says how, and how to
//         remake it when the pristine one is re-saved): tamper protection off,
//         then real-time protection, scheduled and catch-up scans, signature
//         updates and Windows Update off by policy. A patch ships no installer,
//         only app files under the signed one, so its leg B needs no Defender.
// Why a snapshot and not a switch after the revert (measured 10/26 on the
// pristine guest): tamper protection is on and silently ignores
// Set-MpPreference -DisableRealtimeMonitoring and the policy key alike, the
// in-flight MpCmdRun refuses taskkill (access denied), and Defender's script
// scan blocked a switch script outright as malicious content.

export const PROFILES = Object.freeze({
  full: Object.freeze({ snapshot: null }),      // whatever /root/vm-revert.sh reverts to by default
  quiet: Object.freeze({ snapshot: "quiet" }),
});

/** the profile named by VM_GUEST_PROFILE (vm-e2e.sh exports it); full when unset */
export function guestProfile(env = process.env) {
  const p = String(env.VM_GUEST_PROFILE || "full").trim();
  if (!Object.hasOwn(PROFILES, p)) throw new Error(`VM_GUEST_PROFILE is full or quiet, not "${p}"`);
  return p;
}

// What keeps a freshly reverted guest busy: Defender's signature update, the
// per-user OneDrive setup, a Windows servicing job. vm.quiet() waits for these
// on the full profile; on the quiet one they get READY_BUDGET_MS at most.
export const BUSY_IMAGES = Object.freeze(["MpSigStub.exe", "OneDriveSetup.exe", "TiWorker.exe"]);
export const READY_BUDGET_MS = 120000;

/** the readiness verdict from one guest readout: `tasklist /fo csv /nh` rows,
 *  a `QUIET_POLICY=<1|0>` line (1 only where the quiet snapshot's policy turns
 *  real-time protection off) and a `DEFENDER_RTP=<True|False|unavailable>` line.
 *  notQuiet = the guest is not the quiet snapshot: no policy marker, or real-time
 *  protection on. The marker decides, because the readback alone can lie: the
 *  pristine guest read RTP False while Defender was still starting (10/27). A
 *  missing line is unknown, never a pass. Images match by exact name: every
 *  tasklist row opens with it. */
export function readiness(text) {
  const t = String(text || "");
  const policy = (t.match(/^QUIET_POLICY=([01])/m) || [])[1] || "unknown";
  const rtp = (t.match(/^DEFENDER_RTP=(\S+)/m) || [])[1] || "unknown";
  const defenderOn = /^true$/i.test(rtp);
  const notQuiet = policy === "0" || defenderOn;
  const busy = BUSY_IMAGES.filter((exe) => new RegExp('^"' + exe.replace(/\./g, "\\.") + '"', "im").test(t)).sort();
  return { ready: policy === "1" && !defenderOn && rtp !== "unknown" && busy.length === 0, notQuiet, policy, defenderOn, rtp, busy };
}
