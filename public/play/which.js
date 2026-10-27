/*
 * which.js — Which one? (spec 2026-10-12 §5.1, §5.2, §5.6): one item, mounted into a host.
 *
 *   mountWhich(host, item, { say, log, sound, onDone, idleMs }) -> { destroy() }
 *
 * The question in a strip across the top (text first, >= 32 pt), the choices as big tiles in fixed
 * seats: two -> one tall row, left + right (the middle seat black); three -> the triangle (§5.6
 * amended 2026-10-25), two rows of three: answer 0 top-left, 1 top-right, 2 bottom-centre, black in
 * the other three seats; a yes/no item (both labels yes/no, any case) is re-seated yes LEFT, no
 * RIGHT whatever order the manifest lists them (D5 in app form). Each tile = glyph + its word.
 *
 * Arming (§5.6 amended 2026-10-25): the tiles are painted at once but inert (data-dwell-disabled)
 * and muted (.wh-waiting) while the question's first reading plays; they arm together the moment
 * the promise say() returned settles, or after ARM_CAP_MS when it never does. A say() that returns
 * no promise (speech off, paused, or a host that does not hand the reading back) arms at once. A
 * pick before arming does nothing and logs nothing; the re-readings never disarm.
 *
 * Never a test (ux-contract §14-16): a right pick comes alive (scale + glow), sounds, confetti and
 * a praise line, then onDone() after 1200 ms. A first miss: the picked tile does its small thing
 * (wiggle + its sound), the question is said again with "Look for <the right label>", every tile
 * stays live. A second miss: the right tile comes alive by itself with the cheer, then onDone().
 * Nothing says "no", nothing is red, nothing is counted on screen. Every pick is handed to
 * log({item, pick, right, strike}) — pick is the MANIFEST index, strike the misses so far
 * (0, 1, or 2 on the second miss).
 *
 * The question is said on mount and once more after idleMs (20 s) with no pick.
 *
 * A module with no page globals: the Play app and the watch page (its `before` step) both mount
 * it, each handing in its own say/log/sound. Its styles are injected once, so a page that links
 * nothing for it still lays it out.
 */
import { confetti, makeShuffleBag, PRAISE_PLAIN } from "../lib/celebrate.js";

const PRAISE = makeShuffleBag(PRAISE_PLAIN.filter((p) => !/read|spell|challenge/i.test(p)));
const DONE_MS = 1200, WIGGLE_MS = 400;
export const ARM_CAP_MS = 8000;

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const s = document.createElement("style");
  s.dataset.which = "";
  s.textContent = `
.wh{display:grid; grid-template-rows:auto minmax(0,1fr); gap:14px; width:100%; height:100%; min-height:0; box-sizing:border-box}
.wh-q{margin:0; padding:10px 18px; border-radius:16px; background:#FFFFFF; color:#17272E; text-align:center;
      font:750 clamp(44px, 3.86vw, 74px)/1.15 "Segoe UI", system-ui, sans-serif; overflow-wrap:anywhere}
.wh-seats{display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); grid-template-rows:minmax(0,1fr); gap:14px; min-height:0}
.wh-seats[data-rows="2"]{grid-template-rows:repeat(2, minmax(0,1fr))}
.wh-seat{min-width:0; min-height:0; border-radius:16px; box-sizing:border-box}
.wh-black{background:#000}
.wh-tile{appearance:none; border:0; margin:0; padding:12px 10px; background:#FFFFFF; color:#17272E; cursor:pointer;
         display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
         container-type:size; overflow:hidden; font-family:"Segoe UI", system-ui, sans-serif;
         transition:transform 300ms ease, box-shadow 300ms ease, opacity 120ms ease, filter 120ms ease}
.wh-tile.wh-waiting{opacity:.55; filter:saturate(.6); cursor:default}
.wh-glyph{flex:1 1 auto; min-height:0; display:flex; align-items:center; justify-content:center;
          font-size:min(42cqh, 62cqw); line-height:1}
.wh-label{flex:0 0 auto; font-size:clamp(44px, 3.86vw, 74px); font-weight:750; line-height:1.1; text-align:center;
          overflow-wrap:anywhere}
.wh-tile.alive{transform:scale(1.05); z-index:3;
               box-shadow:0 0 0 6px #0F7C8A, 0 0 34px 12px rgba(15,124,138,.6); animation:wh-alive 600ms ease-out}
.wh-tile.wiggle{animation:wh-wiggle 400ms ease-in-out}
@keyframes wh-alive{0%{transform:scale(1)} 45%{transform:scale(1.12)} 100%{transform:scale(1.05)}}
@keyframes wh-wiggle{0%,100%{transform:rotate(0)} 25%{transform:rotate(-4deg)} 75%{transform:rotate(4deg)}}
@media (prefers-reduced-motion: reduce){
  .wh-tile, .wh-tile.alive, .wh-tile.wiggle{transition:none; animation:none}
}`;
  document.head.appendChild(s);
}

const isYesNo = (choices) => choices.length === 2 &&
  choices.every((c) => /^(yes|no)$/i.test(String(c.label).trim())) &&
  choices.some((c) => /^yes$/i.test(String(c.label).trim()));

// seats in reading order -> manifest index or null (a black seat): three seats are one row, six
// are two rows of three (the triangle)
export function seatsFor(choices) {
  if (choices.length === 3) return [0, null, 1, null, 2, null];
  if (isYesNo(choices)) {
    const yes = choices.findIndex((c) => /^yes$/i.test(String(c.label).trim()));
    return [yes, null, 1 - yes];
  }
  return [0, null, 1];
}

export function mountWhich(host, item, { say = () => {}, log = () => {}, sound = () => false, onDone = () => {}, idleMs = 20000 } = {}) {
  injectCss();
  let lockPaused = false, pendingDone = false;
  const blocked = () => lockPaused || window.AppLock?.isLocked();
  const choices = item.choices;
  const rightIdx = choices.findIndex((c) => c.right === true);
  let strike = 0, finished = false, idleUsed = false, idleTimer = null, doneTimer = null, armed = false;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!blocked()) fn(); }, ms); timers.add(t); return t; };

  host.textContent = "";
  const root = document.createElement("div");
  root.className = "wh";
  const q = document.createElement("p");
  q.className = "wh-q";
  q.textContent = item.q;
  const row = document.createElement("div");
  row.className = "wh-seats";
  const seats = seatsFor(choices);
  row.dataset.rows = String(seats.length / 3);
  root.append(q, row);
  const tiles = [];
  seats.forEach((idx, seat) => {
    if (idx === null) {
      const b = document.createElement("div");
      b.className = "wh-seat wh-black";
      b.dataset.seat = String(seat);
      b.setAttribute("aria-hidden", "true");
      row.appendChild(b);
      return;
    }
    const c = choices[idx];
    const t = document.createElement("button");
    t.type = "button";
    t.className = "wh-seat wh-tile dwell wh-waiting";
    t.setAttribute("data-dwell-disabled", "");
    t.dataset.seat = String(seat);
    t.dataset.i = String(idx);
    t.setAttribute("aria-label", c.label);
    t.dataset.dwellSay = c.label;
    const g = document.createElement("span");
    g.className = "wh-glyph"; g.setAttribute("aria-hidden", "true"); g.textContent = c.glyph;
    const w = document.createElement("span");
    w.className = "wh-label"; w.textContent = c.label;
    t.append(g, w);
    t.addEventListener("click", () => pick(idx));
    row.appendChild(t);
    tiles[idx] = t;
  });
  host.appendChild(root);

  function voice(c) { if (!(typeof c.sound === "string" && sound(c.sound))) sound("pop"); }
  function armIdle() {
    clearTimeout(idleTimer);
    if (idleUsed || finished) return;
    idleTimer = later(() => { if (!finished && !idleUsed) { idleUsed = true; say(item.q); } }, idleMs);
  }
  function freeze() { for (const t of tiles) if (t) t.setAttribute("data-dwell-disabled", ""); }
  function arm() {
    if (blocked() || armed || finished) return;
    armed = true;
    for (const t of tiles) if (t) { t.classList.remove("wh-waiting"); t.removeAttribute("data-dwell-disabled"); }
  }
  function cheer(idx) {
    const t = tiles[idx];
    t.classList.remove("wiggle");
    t.classList.add("alive");
    voice(choices[idx]);
    try { confetti(24); } catch {}
    say(PRAISE());
    doneTimer = later(() => onDone(), DONE_MS);
  }
  function pick(idx) {
    if (blocked()) return;
    if (pendingDone) { pendingDone = false; onDone(); return; }
    if (finished || !armed) return;
    clearTimeout(idleTimer);
    if (idx === rightIdx) {
      finished = true; freeze();
      log({ item: item.id, pick: idx, right: true, strike });
      cheer(idx);
      return;
    }
    strike += 1;
    log({ item: item.id, pick: idx, right: false, strike });
    const t = tiles[idx];
    if (strike >= 2) {
      finished = true; freeze();
      cheer(rightIdx);
      return;
    }
    t.classList.remove("wiggle");
    void t.offsetWidth;                       // restart the wiggle if it is still running
    t.classList.add("wiggle");
    later(() => t.classList.remove("wiggle"), WIGGLE_MS);
    voice(choices[idx]);
    say(item.q + " Look for " + choices[rightIdx].label);
    armIdle();
  }

  // arm when the first reading ends (a rejection counts: speech failed), or at the cap
  let reading;
  try { reading = say(item.q); } catch { reading = null; }
  if (reading && typeof reading.then === "function") {
    Promise.race([Promise.resolve(reading).catch(() => {}), new Promise((res) => later(res, ARM_CAP_MS))]).then(arm);
  } else arm();
  armIdle();
  return {
    pause() { lockPaused = true; pendingDone = finished; for (const t of timers) clearTimeout(t); timers.clear(); freeze(); },
    resume() { lockPaused = false; armed = false; finished = false; arm(); },
    destroy() {
      finished = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      host.textContent = "";
    },
  };
}
