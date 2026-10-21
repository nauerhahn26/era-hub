/*
 * sort.js — Sort it (spec 2026-10-12 §5.1, §5.2, §5.6): the week's card sort, one thing at a time.
 *
 *   mountSort(host, sort, { say, log, sound, onItem, onDone, idleMs }) -> { destroy() }
 *
 * The question in a strip across the top (text first, >= 32 pt): "Is <item> <bin 0> or <bin 1>?".
 * Under it three fixed seats: bin 0 LEFT, the current item in the CENTRE (glyph + its word, inert —
 * never a dwell target), bin 1 RIGHT. Each bin is a dwell tile (glyph + its word) with a tray that
 * grows one small glyph for every thing that lands in it.
 *
 * Never a test (ux-contract §14-16): the right bin -> the item slides into it (500 ms; reduced
 * motion: it simply appears there), "pop", the next item. A first miss: the item wobbles toward
 * the picked bin and back to the middle, the question is said again, both bins stay live. A
 * second miss: the item slides into the right bin by itself with the cheer (confetti + praise +
 * "cheer"), then the next item. Nothing says "no", nothing is red, nothing is counted on screen.
 * After the last item, onDone() — the page owns the bigger cheer and the way back to the menu.
 *
 * Every pick is handed to log({item, pick, right, strike}) — item is the MANIFEST index, pick the
 * bin's index, strike the misses so far on this item (0, 1, or 2 on the second miss).
 * onItem(i) runs whenever item i is up. The question is said on each item and once more after
 * idleMs (20 s) with no pick; any pick restarts that wait.
 *
 * A module with no page globals (as which.js); its styles are injected once.
 */
import { confetti, makeShuffleBag, PRAISE_PLAIN } from "../lib/celebrate.js";

const PRAISE = makeShuffleBag(PRAISE_PLAIN.filter((p) => !/read|spell|challenge/i.test(p)));
const SLIDE_MS = 500, WOBBLE_MS = 500, NEXT_MS = 250, CHEER_MS = 1300;

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const s = document.createElement("style");
  s.dataset.sort = "";
  s.textContent = `
.so-host{min-width:0; min-height:0}
.so{display:grid; grid-template-rows:auto minmax(0,1fr); gap:14px; width:100%; height:100%; min-height:0; box-sizing:border-box}
.so-q{margin:0; padding:10px 18px; border-radius:16px; background:#FFFFFF; color:#17272E; text-align:center;
      font:750 clamp(44px, 3.86vw, 74px)/1.15 "Segoe UI", system-ui, sans-serif; overflow-wrap:anywhere}
.so-row{display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; min-height:0}
.so-bin{appearance:none; border:0; margin:0; padding:12px 10px; border-radius:16px; box-sizing:border-box; cursor:pointer;
        min-width:0; min-height:0; overflow:hidden; background:#0F7C8A; color:#FFFFFF;
        display:grid; grid-template-rows:auto minmax(0,1fr); gap:10px; font-family:"Segoe UI", system-ui, sans-serif}
.so-head{display:flex; flex-direction:column; align-items:center; gap:4px}
.so-bin .so-glyph{font-size:clamp(48px, 5vw, 96px); line-height:1.1}
.so-bin .so-label{font-size:clamp(44px, 3.86vw, 74px); font-weight:750; line-height:1.1; text-align:center; overflow-wrap:anywhere}
.so-tray{min-height:0; border-radius:12px; background:rgba(255,255,255,.18); padding:8px;
         display:flex; flex-wrap:wrap; align-content:flex-end; justify-content:center; gap:6px; overflow:hidden}
.so-chip{font-size:clamp(32px, 3vw, 56px); line-height:1.1}
.so-mid{min-width:0; min-height:0; display:grid; place-items:center}
.so-item{width:100%; max-height:100%; box-sizing:border-box; padding:16px 12px; border-radius:16px; background:#FFFFFF; color:#17272E;
         display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; overflow:hidden;
         font-family:"Segoe UI", system-ui, sans-serif; position:relative; z-index:2;
         transition:transform 500ms ease-in, opacity 500ms ease-in}
.so-item .so-glyph{font-size:clamp(80px, 9vw, 180px); line-height:1.1}
.so-item .so-label{font-size:clamp(44px, 3.86vw, 74px); font-weight:750; line-height:1.1; text-align:center; overflow-wrap:anywhere}
.so-item.snap{transition:none}
.so-item.landing{opacity:0}
.so-item.wobble{animation:so-wobble 500ms ease-in-out}
@keyframes so-wobble{0%{transform:translateX(0) rotate(0)} 35%{transform:translateX(var(--wob, 0px)) rotate(-5deg)}
                     65%{transform:translateX(calc(var(--wob, 0px) * .4)) rotate(4deg)} 100%{transform:translateX(0) rotate(0)}}
@media (prefers-reduced-motion: reduce){
  .so-item, .so-item.wobble, .so-bin{transition:none; animation:none}
}`;
  document.head.appendChild(s);
}

const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

export function mountSort(host, sort, { say = () => {}, log = () => {}, sound = () => false, onItem = () => {},
                                        onDone = () => {}, idleMs = 20000 } = {}) {
  injectCss();
  const { bins, items } = sort;
  let idx = 0, strike = 0, busy = false, gone = false, idleUsed = false, idleTimer = null;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!gone) fn(); }, ms); timers.add(t); return t; };
  const question = (i) => "Is " + items[i].label + " " + bins[0].label + " or " + bins[1].label + "?";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  host.textContent = "";
  const root = el("div", "so");
  const q = el("p", "so-q");
  const row = el("div", "so-row");
  const binEls = bins.map((b, i) => {
    const t = el("button", "so-bin dwell");
    t.type = "button"; t.id = "bin" + i; t.dataset.seat = i === 0 ? "0" : "2";
    t.setAttribute("aria-label", b.label); t.dataset.dwellSay = b.label;
    const head = el("span", "so-head");
    const g = el("span", "so-glyph", b.glyph); g.setAttribute("aria-hidden", "true");
    head.append(g, el("span", "so-label", b.label));
    const tray = el("span", "so-tray"); tray.setAttribute("aria-hidden", "true");
    t.append(head, tray);
    t.addEventListener("click", () => pick(i));
    return t;
  });
  const mid = el("div", "so-mid"); mid.dataset.seat = "1";
  const card = el("div", "so-item"); card.id = "sortItem";
  const cGlyph = el("span", "so-glyph"); cGlyph.setAttribute("aria-hidden", "true");
  const cWord = el("span", "so-label");
  card.append(cGlyph, cWord);
  mid.appendChild(card);
  row.append(binEls[0], mid, binEls[1]);
  root.append(q, row);
  host.appendChild(root);

  function setLive(on) { for (const b of binEls) on ? b.removeAttribute("data-dwell-disabled") : b.setAttribute("data-dwell-disabled", ""); }
  function armIdle() {
    clearTimeout(idleTimer);
    if (idleUsed || busy) return;
    const at = idx;
    idleTimer = later(() => { if (!busy && !idleUsed && idx === at) { idleUsed = true; say(question(idx)); } }, idleMs);
  }
  function show(i) {
    idx = i; strike = 0; busy = false; idleUsed = false;
    card.classList.add("snap");
    card.classList.remove("landing", "wobble");
    card.style.transform = "";
    void card.offsetWidth;                    // back in the middle with no slide
    card.classList.remove("snap");
    cGlyph.textContent = items[i].glyph;
    cWord.textContent = items[i].label;
    q.textContent = question(i);
    setLive(true);
    onItem(i);
    say(question(i));
    armIdle();
  }
  // the item slides into bin b's tray, then a small glyph stays there
  function land(b, after) {
    busy = true; setLive(false); clearTimeout(idleTimer);
    card.classList.remove("wobble");
    const from = card.getBoundingClientRect(), to = binEls[b].querySelector(".so-tray").getBoundingClientRect();
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2), dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    card.style.transform = "translate(" + Math.round(dx) + "px, " + Math.round(dy) + "px) scale(.3)";
    card.classList.add("landing");
    later(() => {
      const chip = el("span", "so-chip", items[idx].glyph);
      binEls[b].querySelector(".so-tray").appendChild(chip);
      after();
    }, reduced() ? 0 : SLIDE_MS);
  }
  function next(ms) {
    later(() => { if (idx + 1 < items.length) show(idx + 1); else onDone(); }, ms);
  }
  function pick(b) {
    if (busy || gone) return;
    clearTimeout(idleTimer);
    const right = items[idx].bin;
    if (b === right) {
      log({ item: idx, pick: b, right: true, strike });
      land(b, () => { sound("pop"); next(NEXT_MS); });
      return;
    }
    strike += 1;
    log({ item: idx, pick: b, right: false, strike });
    if (strike >= 2) {
      land(right, () => {
        sound("cheer");
        try { confetti(24); } catch {}
        say(PRAISE());
        next(CHEER_MS);
      });
      return;
    }
    card.style.setProperty("--wob", (b === 0 ? -1 : 1) * 60 + "px");
    card.classList.remove("wobble");
    void card.offsetWidth;                    // restart the wobble if it is still running
    card.classList.add("wobble");
    later(() => card.classList.remove("wobble"), WOBBLE_MS);
    say(question(idx));
    armIdle();
  }

  show(0);
  return {
    destroy() {
      gone = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      host.textContent = "";
    },
  };
}
