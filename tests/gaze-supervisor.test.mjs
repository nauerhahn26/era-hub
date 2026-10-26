// gaze-supervisor.test.mjs — the hub keeps the gaze engine alive (dad 10/26:
// "when I open the device in the morning, ERA Gaze is not working... it should
// already have a restart function if it turns itself off, unless purposely
// deactivated"). Tablet 10/25 18:49: a second hand-launch of the engine lost
// the bind for the 49155 bus to the instance it replaced, the old one exited,
// the new one ran on without a bus, and seven hub restarts overnight never
// noticed — the hub only ever started the engine when it INSTALLED it. The
// supervisor polls the bus; silent past the threshold, it stops our build and
// starts it again, with backoff, and says so in /status. A stop made on
// purpose (Settings' "Stop ERAgaze completely") holds it off.
// Pure state machine: time, the bus, and the process are all injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGazeSupervisor } from "../gaze-supervisor.js";

const MIN = 60 * 1000;
function harness(over = {}) {
  const h = { t: 1_000_000, alive: true, enabled: true, busy: false, marker: null, started: 0, stopped: 0, logs: [] };
  h.sup = createGazeSupervisor({
    now: () => h.t,
    enabled: () => h.enabled,
    busy: () => h.busy,
    isAlive: async () => h.alive,
    start: async () => { h.started++; },
    stopOurs: async () => { h.stopped++; },
    marker: { read: () => h.marker, write: (m) => { h.marker = m; }, clear: () => { h.marker = null; } },
    log: (m) => h.logs.push(m),
    graceMs: MIN, downMs: 30_000, backoffMs: [30_000, 60_000, 120_000], healthyMs: 2 * MIN,
    ...over,
  });
  // advance the clock and poll once
  h.tick = async (dt = 10_000) => { h.t += dt; await h.sup.tick(); };
  return h;
}

test("an engine answering the bus is watched and never restarted", async () => {
  const h = harness();
  for (let i = 0; i < 30; i++) await h.tick();
  const s = h.sup.status();
  assert.equal(s.state, "watching");
  assert.equal(s.alive, true);
  assert.equal(s.restarts, 0);
  assert.equal(h.started, 0);
  assert.equal(h.stopped, 0);
});

test("silent past the threshold: our build is stopped and started again, once, and the log says so", async () => {
  const h = harness();
  await h.tick(2 * MIN);           // past the boot grace, alive
  h.alive = false;
  await h.tick();                  // first miss: down, counting from here
  assert.equal(h.sup.status().state, "down");
  assert.equal(h.started, 0, "one miss is not a restart");
  await h.tick(10_000);            // 10 s silent
  await h.tick(10_000);            // 20 s silent
  assert.equal(h.started, 0);
  await h.tick(10_000);            // 30 s silent — the threshold
  assert.equal(h.stopped, 1, "our own process is stopped first (a deaf instance may still be running)");
  assert.equal(h.started, 1);
  const s = h.sup.status();
  assert.equal(s.state, "restarting");
  assert.equal(s.restarts, 1);
  assert.equal(s.nextRetry, h.t + 30_000, "the first retry waits the first backoff step");
  assert.ok(h.logs.some(l => /silent for 30 s/.test(l) && /restart #1/.test(l)), h.logs.join("\n"));
});

test("still silent: the next restart waits the backoff, which grows and caps", async () => {
  const h = harness();
  await h.tick(2 * MIN);
  h.alive = false;
  await h.tick(10_000);            // the first miss
  await h.tick(30_000);            // 30 s silent: restart #1
  assert.equal(h.started, 1);
  await h.tick(10_000); await h.tick(10_000);
  assert.equal(h.started, 1, "inside the 30 s backoff nothing happens");
  await h.tick(10_000);            // 30 s after restart #1
  assert.equal(h.started, 2);
  assert.equal(h.sup.status().nextRetry, h.t + 60_000, "second step");
  await h.tick(60_000);
  assert.equal(h.started, 3);
  assert.equal(h.sup.status().nextRetry, h.t + 120_000, "third step");
  await h.tick(120_000);
  assert.equal(h.started, 4);
  assert.equal(h.sup.status().nextRetry, h.t + 120_000, "capped at the last step");
  assert.equal(h.sup.status().restarts, 4);
});

test("back on the bus and healthy for two minutes, the backoff resets", async () => {
  const h = harness();
  await h.tick(2 * MIN);
  h.alive = false;
  await h.tick(10_000); await h.tick(30_000); await h.tick(30_000);   // miss, restart #1, restart #2
  assert.equal(h.started, 2);
  h.alive = true;
  await h.tick(); await h.tick(2 * MIN);        // healthy ≥ 2 min
  assert.equal(h.sup.status().state, "watching");
  h.alive = false;
  await h.tick(10_000); await h.tick(30_000);   // miss, then 30 s silent again
  assert.equal(h.started, 3);
  assert.equal(h.sup.status().nextRetry, h.t + 30_000, "the ladder starts over");
});

test("a lapse before the boot grace is over is not acted on (the Startup link's engine is still coming up)", async () => {
  const h = harness();
  h.alive = false;
  await h.tick(10_000); await h.tick(10_000); await h.tick(10_000); await h.tick(10_000);   // 40 s after boot
  assert.equal(h.started, 0);
  assert.equal(h.sup.status().state, "starting");
  await h.tick(30_000);            // 70 s: grace over, the silence counts from here
  assert.equal(h.sup.status().state, "down");
  assert.equal(h.started, 0);
  await h.tick(30_000);
  assert.equal(h.started, 1);
});

test("the engine turned off in Settings, or a family build on the bus, is never ours to restart", async () => {
  const h = harness();
  h.enabled = false; h.alive = false;
  for (let i = 0; i < 20; i++) await h.tick(30_000);
  assert.equal(h.started, 0);
  assert.equal(h.sup.status().state, "off");
  // turned back on: supervised again
  h.enabled = true;
  await h.tick(); await h.tick(30_000);         // miss, then 30 s silent
  assert.equal(h.started, 1);
});

test("an install or recompile in flight holds the supervisor off", async () => {
  const h = harness();
  await h.tick(2 * MIN);
  h.alive = false; h.busy = true;
  for (let i = 0; i < 10; i++) await h.tick(30_000);
  assert.equal(h.started, 0);
  assert.equal(h.sup.status().state, "installing");
  h.busy = false;
  await h.tick(); await h.tick(30_000);
  assert.equal(h.started, 1);
});

test("stopped on purpose: no restarts until it is started again, the engine reappears by hand, or eight hours pass", async () => {
  const h = harness();
  await h.tick(2 * MIN);
  h.sup.stopOnPurpose("settings");
  assert.ok(h.marker && h.marker.at, "the stop is written down (it must outlive a hub restart)");
  assert.equal(h.marker.by, "settings");
  h.alive = false;
  for (let i = 0; i < 20; i++) await h.tick(30_000);
  assert.equal(h.started, 0);
  const s = h.sup.status();
  assert.equal(s.state, "stopped");
  assert.equal(s.stoppedOnPurpose, true);
  // a hand launch (the desktop icon) puts it back on the bus: the stop is over
  h.alive = true;
  await h.tick();
  assert.equal(h.marker, null);
  assert.equal(h.sup.status().stoppedOnPurpose, false);
  assert.equal(h.sup.status().state, "watching");
  // eight hours later a forgotten stop expires on its own
  h.sup.stopOnPurpose("settings");
  h.alive = false;
  await h.tick(8 * 60 * MIN + 1000);           // the miss that finds the stop expired
  assert.equal(h.marker, null, "expired");
  await h.tick(30_000);                         // 30 s silent
  assert.equal(h.started, 1);
});

test("resume() clears the stop and starts the engine when it is not on the bus", async () => {
  const h = harness();
  await h.tick(2 * MIN);
  h.sup.stopOnPurpose("settings");
  h.alive = false;
  await h.tick(30_000);
  await h.sup.resume("settings");
  assert.equal(h.marker, null);
  assert.equal(h.started, 1);
  assert.equal(h.sup.status().stoppedOnPurpose, false);
  // and does nothing when it already answers
  h.alive = true;
  await h.sup.resume("settings");
  assert.equal(h.started, 1);
});

test("a stop written by an earlier hub run is honoured after a restart", async () => {
  const at = new Date(1_000_000 + 2 * MIN).toISOString();
  const h = harness({ marker: { read: () => ({ at, by: "settings" }), write: () => {}, clear: () => {} } });
  h.alive = false;
  for (let i = 0; i < 10; i++) await h.tick(30_000);
  assert.equal(h.started, 0);
  assert.equal(h.sup.status().stoppedOnPurpose, true);
});

test("a poll that is still in flight is not doubled", async () => {
  let release;
  const h = harness({ isAlive: () => new Promise(r => { release = r; }) });
  h.t += 2 * MIN;
  const first = h.sup.tick();
  await h.sup.tick();              // returns at once
  release(true);
  await first;
  assert.equal(h.sup.status().alive, true);
});

test("a throwing dependency never kills the loop; the error is reported", async () => {
  const h = harness({ isAlive: async () => { throw new Error("boom"); } });
  await h.tick(2 * MIN);
  assert.equal(h.sup.status().lastError, "boom");
  assert.ok(h.logs.some(l => /boom/.test(l)));
});
