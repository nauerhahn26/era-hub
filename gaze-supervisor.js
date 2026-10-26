// gaze-supervisor.js — keeps OUR gaze engine on its bus.
//
// Dad 10/26: "when I open the device in the morning, ERA Gaze is not working
// ... it should already have a restart function if it turns itself off,
// unless purposely deactivated." Until now the hub started the engine exactly
// once — when it installed or recompiled it — and never looked again. Tablet
// 10/25 18:49: a hand launch of the desktop icon started a second instance
// while the first still held port 49155; the new one's bus bind failed, the
// old one saw the owner file change and exited, and the new one ran on deaf
// (cursor moving, every door and dwell dead) through seven hub restarts.
//
// The hub polls the bus (/status on 127.0.0.1:49155). Silent for `downMs`
// past the boot grace, it stops our build (by path — a family build is never
// ours to touch; a deaf instance that is still a process must go before a
// fresh one can bind) and starts it again, waiting a growing backoff between
// tries, resetting once the engine has answered for `healthyMs`. A stop made
// on purpose (Settings' "Stop ERAgaze completely") is written to a marker
// that outlives a hub restart and holds the supervisor off until the engine
// is started again, reappears by hand, or `stoppedForMs` pass.
//
// Everything that touches the world is injected (time, the bus probe, the
// process start/stop, the marker file), so tests/gaze-supervisor.test.mjs
// drives it with a clock; server.js wires the real ones.
"use strict";

const DEFAULTS = {
  graceMs: 60 * 1000,                  // after boot: the Startup link's engine may still be coming up
  downMs: 30 * 1000,                   // silence that counts as "gone"
  backoffMs: [30_000, 60_000, 120_000, 300_000, 600_000],
  healthyMs: 2 * 60 * 1000,            // answered this long → the ladder starts over
  stoppedForMs: 8 * 60 * 60 * 1000,    // a forgotten "stop completely" expires
};

function createGazeSupervisor(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const marker = o.marker || { read: () => null, write: () => {}, clear: () => {} };
  const bootAt = now();
  const st = {
    state: "off", alive: null, lastSeen: null, downSince: null,
    restarts: 0, lastRestart: null, nextRetry: null, attempt: 0, healthySince: null, lastError: null,
  };
  let inFlight = false;

  // the stop marker, or null when there is none / it has expired
  function stoppedOnPurpose() {
    let m = null;
    try { m = marker.read(); } catch { m = null; }
    if (!m || !m.at) return null;
    const at = Date.parse(m.at);
    if (!Number.isFinite(at) || now() - at > o.stoppedForMs) { try { marker.clear(); } catch {} return null; }
    return m;
  }

  async function step() {
    const t = now();
    if (!o.enabled()) { st.state = "off"; st.downSince = null; st.alive = null; return; }
    const stopped = stoppedOnPurpose();
    const alive = await o.isAlive();
    st.alive = !!alive;
    if (alive) {
      st.lastSeen = t; st.downSince = null;
      if (stopped) { try { marker.clear(); } catch {} log("engine is back on the bus — the stop is over"); }
      if (st.healthySince == null) st.healthySince = t;
      if (st.attempt && t - st.healthySince >= o.healthyMs) { st.attempt = 0; st.nextRetry = null; }
      st.state = "watching";
      return;
    }
    st.healthySince = null;
    if (stopped) { st.state = "stopped"; return; }
    if (o.busy && o.busy()) { st.state = "installing"; return; }
    if (t - bootAt < o.graceMs) { st.state = "starting"; return; }
    if (st.downSince == null) st.downSince = t;
    if (t - st.downSince < o.downMs) { st.state = "down"; return; }
    if (st.nextRetry != null && t < st.nextRetry) { st.state = "waiting"; return; }
    st.attempt++; st.restarts++; st.lastRestart = t;
    const wait = o.backoffMs[Math.min(st.attempt - 1, o.backoffMs.length - 1)];
    st.nextRetry = t + wait;
    st.state = "restarting";
    log("engine silent for " + Math.round((t - st.downSince) / 1000) + " s — restart #" + st.restarts +
        " (next try in " + Math.round(wait / 1000) + " s if still silent)");
    await o.stopOurs();
    await o.start();
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try { await step(); }
    catch (e) { st.lastError = e && e.message ? e.message : String(e); log("supervisor: " + st.lastError); }
    finally { inFlight = false; }
  }

  function status() {
    return { ...st, bootAt, stoppedOnPurpose: !!stoppedOnPurpose() };
  }

  // Settings' "Stop ERAgaze completely": remembered on disk, so a hub restart
  // (a self-update lands most nights) does not bring the engine back under a
  // tester's other eye-gaze software.
  function stopOnPurpose(by) {
    marker.write({ at: new Date(now()).toISOString(), by: by || "" });
    st.state = "stopped"; st.downSince = null; st.nextRetry = null; st.attempt = 0;
    log("stopped on purpose (" + (by || "?") + ") — not supervised until started again, or " +
        Math.round(o.stoppedForMs / 3600000) + " h pass");
  }

  async function resume(by) {
    try { marker.clear(); } catch {}
    st.downSince = null; st.nextRetry = null; st.attempt = 0;
    if (await o.isAlive()) { st.state = "watching"; st.alive = true; return false; }
    st.restarts++; st.lastRestart = now(); st.state = "restarting";
    log("started again (" + (by || "?") + ")");
    await o.start();
    return true;
  }

  return { tick, status, stopOnPurpose, resume };
}

module.exports = { createGazeSupervisor, DEFAULTS };
