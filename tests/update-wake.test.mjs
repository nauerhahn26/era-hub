// update-wake.test.mjs — wake detection for the self-updater (spec 2026-10-20
// §4.2). Node timers cannot be suspended in a test, so the decision is a pure
// function driven here with numbers: a heartbeat every `hb` ms that sees a gap
// longer than hb + gap means the machine slept (or the clock jumped), and the
// hub checks the feed once, shortly after waking. No ports, no hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { wokeUp } = require("../update.js");

const HB = 30 * 1000, GAP = 2 * 60 * 1000;

test("a heartbeat on time, or late by less than the gap, is not a wake", () => {
  assert.equal(wokeUp(1000, 1000 + HB, HB, GAP), false);
  assert.equal(wokeUp(1000, 1000 + HB + GAP, HB, GAP), false, "exactly at the threshold is not a wake");
  assert.equal(wokeUp(1000, 1000 + HB + 5000, HB, GAP), false, "a busy event loop is not a wake");
});

test("a gap longer than heartbeat + gap is a wake", () => {
  assert.equal(wokeUp(1000, 1000 + HB + GAP + 1, HB, GAP), true);
  assert.equal(wokeUp(1000, 1000 + 3 * 60 * 60 * 1000, HB, GAP), true, "a night asleep");
});

test("a clock that went backwards counts as a wake (the check is harmless)", () => {
  assert.equal(wokeUp(100000, 50000, HB, GAP), true);
});
