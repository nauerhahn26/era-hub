// The guest profile a VM leg drives, and the readiness check that replaces the
// quiet wait on the quiet profile (tests-vm/lib/guest-profile.mjs). Pure: no VM.
// Run: node --test tests-vm/guest-profile.test.mjs (outside the flat Linux gate,
// like tests-vm/native-display.test.mjs). Which profile release.sh and
// vm-e2e.sh pick, and what VM-GREEN records, is pinned by tests/vm-e2e.test.mjs,
// which the gate runs.
import test from "node:test";
import assert from "node:assert/strict";
import { PROFILES, guestProfile, readiness, READY_BUDGET_MS } from "./lib/guest-profile.mjs";

const tasks = (...names) => names.map((n, i) => `"${n}","${100 + i}","Services","0","5,000 K"`).join("\r\n");
const facts = (list, rtp) => list + "\r\n" + (rtp === undefined ? "" : "DEFENDER_RTP=" + rtp + "\r\n");

test("no VM_GUEST_PROFILE is the full guest: today's pristine template, Defender on", () => {
  assert.equal(guestProfile({}), "full");
  assert.equal(guestProfile({ VM_GUEST_PROFILE: "" }), "full");
  assert.equal(PROFILES.full.snapshot, null, "full reverts to the template's own pristine snapshot (vm-revert.sh's default)");
});

test("quiet reverts to the template's separately named quiet snapshot", () => {
  assert.equal(guestProfile({ VM_GUEST_PROFILE: "quiet" }), "quiet");
  assert.equal(PROFILES.quiet.snapshot, "quiet");
  assert.notEqual(PROFILES.quiet.snapshot, "pristine3", "never the pristine snapshot itself");
});

test("an unknown profile is refused by name, never treated as full", () => {
  assert.throws(() => guestProfile({ VM_GUEST_PROFILE: "fast" }), /full or quiet.*fast/);
});

test("a quiet guest with nothing busy and real-time protection off is ready at once", () => {
  const r = readiness(facts(tasks("explorer.exe", "MsMpEng.exe", "svchost.exe"), "False"));
  assert.deepEqual(r, { ready: true, defenderOn: false, rtp: "False", busy: [] });
});

test("Defender stopped altogether (no status to read) counts as off", () => {
  const r = readiness(facts(tasks("explorer.exe"), "unavailable"));
  assert.equal(r.defenderOn, false); assert.equal(r.ready, true);
});

test("boot work still running is named and keeps the guest not-ready", () => {
  const r = readiness(facts(tasks("TiWorker.exe", "explorer.exe", "OneDriveSetup.exe", "TiWorker.exe"), "False"));
  assert.equal(r.ready, false);
  assert.deepEqual(r.busy, ["OneDriveSetup.exe", "TiWorker.exe"], "each busy image once, sorted");
  assert.deepEqual(readiness(facts(tasks("MpSigStub.exe"), "False")).busy, ["MpSigStub.exe"], "a signature update is busy work too");
});

test("real-time protection ON means this is not the quiet snapshot", () => {
  const r = readiness(facts(tasks("explorer.exe"), "True"));
  assert.equal(r.defenderOn, true); assert.equal(r.ready, false);
});

test("a readback that never arrived is unknown, not off", () => {
  const r = readiness(facts(tasks("explorer.exe")));
  assert.equal(r.rtp, "unknown"); assert.equal(r.ready, false, "no proof Defender is off, no quiet verdict");
});

test("an image name that merely contains a busy name is not busy (the 9/9 OneDriveSetup lesson)", () => {
  assert.deepEqual(readiness(facts(tasks("MyTiWorker.exe", "NotOneDriveSetup.exe"), "False")).busy, []);
});

test("the readiness check is bounded in minutes, not the full profile's quarter hour", () => {
  assert.ok(READY_BUDGET_MS > 0 && READY_BUDGET_MS <= 180000, `budget ${READY_BUDGET_MS} ms`);
});
