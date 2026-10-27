/*
 * playit.js — Play it (spec 2026-10-12 §5.1, §5.2, §5.6): the week's instrument, played with her eyes.
 *
 *   mountPlayit(host, playit, { say, log, sound, clockMs }) -> { destroy() }
 *
 *   playit = { instrument, q, answer }   (validated by the hub: answer < the instrument's positions)
 *   sound  = { play(name), note(midi, voice), muffled(on) }   (sounds.js, or anything shaped like it)
 *
 * Each instrument is an ORDERED LIST OF POSITIONS (spec §5.6's table; the engine's prompt names the
 * same list, so `answer` means the same thing to both):
 *
 *   harmonica         10 holes, left -> right, MIDI 60 62 64 65 67 69 71 72 74 76; a hole plays its
 *                     note and the reed strip above it shakes while it sounds
 *   xylophone         10 bars, longest -> shortest, left -> right, the same notes; the bar rings and bounces
 *   string-telephone  [tight, loose]: two state tiles, two cups and a string; her cup (left) "talks":
 *                     a wave runs the string (900 ms) and the far cup says hello, clear when tight,
 *                     faint and muffled when loose
 *   shadow-puppet     [closer to the lamp, farther from it]: a lamp, a puppet, a wall; the shadow
 *                     scales 1.6 (closer) or 0.7 (farther) from 1.0; four shape tiles under the scene
 *
 * The one runner every instrument shares: FREE PLAY first. The clock (clockMs, 60 s) starts at her
 * FIRST pick — a page nobody touches never asks. When it runs out the question appears in the strip
 * and is said; her next pick of a position answers it. Right -> the position comes alive with the
 * cheer (confetti + praise + "cheer"). First miss -> the position does its own thing and the
 * question is said again with the instrument's hint. Second miss -> the right position lights and
 * sounds by itself with the cheer. Then free play goes on and the question never comes back.
 *
 * Never a test (ux-contract §14-16): nothing says "no", nothing is red, nothing is counted. Every
 * pick is handed to log(): a free-play pick {instrument, pick}; an answer {instrument, pick, right,
 * strike}; her cup {instrument, talk: true, string}; a puppet shape {instrument, shape}.
 *
 * A module with no page globals (as which.js / sort.js); shapes are inline SVG and CSS; its styles
 * are injected once.
 */
import { confetti, makeShuffleBag, PRAISE_PLAIN } from "../lib/celebrate.js";

const PRAISE = makeShuffleBag(PRAISE_PLAIN.filter((p) => !/read|spell|challenge/i.test(p)));
export const NOTES = Object.freeze([60, 62, 64, 65, 67, 69, 71, 72, 74, 76]);
const NAMES = { "harmonica": "Harmonica", "xylophone": "Xylophone", "string-telephone": "String telephone", "shadow-puppet": "Shadow puppet" };
const NOTE_MS = { harmonica: 700, xylophone: 500 };
const CHEER_MS = 1300, QUESTION_GONE_MS = 1600, SECOND_MS = 450, WAVE_MS = 900, MOVE_MS = 600;
const BAR_COLOURS = ["#D94F4F", "#E8793A", "#E9A93A", "#C9B92E", "#6DAF3F", "#2E9C6E", "#2B8FB0", "#3E6FC4", "#6A55C2", "#9A4FB8"];
const SHAPES = [["bat", "🦇", "Bat"], ["bird", "🐦", "Bird"], ["rabbit", "🐰", "Rabbit"], ["dog", "🐕", "Dog"]];
const STRING_D = { null: "M0,60 Q500,95 1000,60", 0: "M0,60 L1000,60", 1: "M0,60 Q500,170 1000,60" };

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const s = document.createElement("style");
  s.dataset.playit = "";
  s.textContent = `
.pi-host{min-width:0; min-height:0}
.pi{display:grid; grid-template-rows:auto minmax(0,1fr); gap:14px; width:100%; height:100%; min-height:0; box-sizing:border-box;
    font-family:"Segoe UI", system-ui, sans-serif}
.pi-name, .pi-q{margin:0; padding:10px 18px; border-radius:16px; text-align:center; overflow-wrap:anywhere;
    font:750 clamp(44px, 3.86vw, 74px)/1.15 "Segoe UI", system-ui, sans-serif}
.pi-name{background:rgba(255,255,255,.12); color:#FFFFFF}
.pi-q{background:#FFFFFF; color:#17272E}
.pi-body{min-width:0; min-height:0; display:grid}
.pi-pos, .pi-tile{appearance:none; border:0; margin:0; padding:0; cursor:pointer; font:inherit; min-width:0; min-height:0;
    box-sizing:border-box; transition:transform 200ms ease, box-shadow 200ms ease}
.pi-tile{border-radius:16px; background:#0F7C8A; color:#FFFFFF; padding:10px; overflow:hidden;
    display:flex; align-items:center; justify-content:center; gap:14px}
.pi-tile.col{flex-direction:column; gap:6px}
.pi-glyph{font-size:clamp(48px, 4.6vw, 96px); line-height:1.1}
.pi-word{font-size:clamp(44px, 3.86vw, 74px); font-weight:750; line-height:1.1; text-align:center; white-space:nowrap}
.pi-pupmain .pi-word{font-size:clamp(44px, 3.2vw, 62px)}
.pi-tile.alive{transform:scale(1.05); box-shadow:0 0 0 6px #FFFFFF, 0 0 34px 12px rgba(255,255,255,.55)}
.pi-tile.on{box-shadow:inset 0 0 0 6px #FFFFFF}

/* ---- harmonica: a silver body, ten holes, a brass reed strip over each ---- */
.pi-harm{align-self:center; height:min(100%, 400px); border-radius:28px; padding:clamp(22px, 3.4vh, 40px) 14px; box-sizing:border-box;
    background:linear-gradient(#F2F5F7, #B9C3C9 18%, #E5EAED 50%, #A9B4BB 82%, #DDE3E6);
    box-shadow:0 10px 30px rgba(0,0,0,.45); display:grid; grid-template-columns:repeat(10, minmax(0,1fr)); gap:14px}
.pi-hole{border-radius:14px; background:#3B4950; display:grid; grid-template-rows:26% minmax(0,1fr); gap:10px; padding:10px;
    box-shadow:inset 0 0 0 3px #26323A}
.pi-reed{border-radius:6px; background:linear-gradient(90deg, #A97A1E, #E9C35A 45%, #B8862A); transform-origin:50% 100%}
.pi-cell{border-radius:10px; background:radial-gradient(ellipse at 50% 40%, #0B1013 55%, #1E282E)}
.pi-hole.alive{box-shadow:inset 0 0 0 3px #26323A, 0 0 0 5px #FFFFFF, 0 0 30px 10px rgba(255,236,170,.7)}
.pi-hole.alive .pi-reed{animation:pi-shake 90ms linear infinite}
@keyframes pi-shake{0%{transform:translateY(0) scaleY(1)} 25%{transform:translateY(-3px) scaleY(1.06)}
    50%{transform:translateY(0) scaleY(.94)} 75%{transform:translateY(3px) scaleY(1.04)} 100%{transform:translateY(0) scaleY(1)}}

/* ---- xylophone: ten bars on two rails, longest (lowest) left ---- */
.pi-xylo{position:relative; display:grid; grid-template-columns:repeat(10, minmax(0,1fr)); gap:14px; align-items:center; min-height:0}
.pi-rail{position:absolute; left:0; right:0; height:16px; border-radius:8px; background:#6B4A2B; box-shadow:0 3px 6px rgba(0,0,0,.4)}
.pi-bar{position:relative; z-index:1; border-radius:14px; box-shadow:inset 0 -8px 0 rgba(0,0,0,.18), 0 6px 12px rgba(0,0,0,.35)}
.pi-bar::before, .pi-bar::after{content:""; position:absolute; left:50%; width:16px; height:16px; margin-left:-8px; border-radius:50%;
    background:rgba(255,255,255,.75)}
.pi-bar::before{top:12%} .pi-bar::after{bottom:12%}
.pi-bar.alive{animation:pi-bounce 500ms ease-out; box-shadow:0 0 0 5px #FFFFFF, 0 0 30px 10px rgba(255,255,255,.6)}
@keyframes pi-bounce{0%{transform:translateY(0)} 30%{transform:translateY(-16px)} 60%{transform:translateY(4px)} 100%{transform:translateY(0)}}

/* ---- string telephone: her cup, the string, the far cup; tight / loose under them ---- */
.pi-tel{display:grid; grid-template-rows:minmax(0,1fr) clamp(110px, 20vh, 220px); gap:14px; min-height:0}
.pi-telscene{display:grid; grid-template-columns:clamp(150px, 17vw, 300px) minmax(0,1fr) clamp(150px, 17vw, 300px); gap:14px;
    align-items:center; min-height:0; border-radius:16px; background:rgba(255,255,255,.06); padding:14px; box-sizing:border-box}
.pi-cup{height:100%; max-height:420px; flex-direction:column; gap:6px}
.pi-cup svg{width:80%; flex:1 1 auto; min-height:0}
.pi-far{height:100%; max-height:420px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
    position:relative}
.pi-far svg{width:80%; flex:1 1 auto; min-height:0}
.pi-bubble{position:absolute; top:-6px; left:50%; transform:translateX(-50%); padding:4px 16px; border-radius:20px;
    background:#FFFFFF; color:#17272E; font-size:clamp(44px, 3.86vw, 74px); font-weight:750; white-space:nowrap;
    opacity:0; transition:opacity 200ms}
.pi-bubble.show{opacity:1}
.pi-bubble.faint{opacity:.45; filter:blur(1.5px)}
.pi-string{height:100%; min-height:0; display:flex; align-items:center}
.pi-string svg{width:100%; height:60%; overflow:visible}
.pi-string .base{fill:none; stroke:#F2E3C2; stroke-width:6; vector-effect:non-scaling-stroke; transition:d 400ms ease}
.pi-string .pulse{fill:none; stroke:#FFE36E; stroke-width:14; stroke-linecap:round; vector-effect:non-scaling-stroke;
    stroke-dasharray:90 2000; stroke-dashoffset:90; opacity:0; transition:d 400ms ease}
.pi-string.wave .pulse{opacity:1; animation:pi-wave 900ms linear forwards}
@keyframes pi-wave{from{stroke-dashoffset:90} to{stroke-dashoffset:-1000}}
.pi-states{display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:14px; min-height:0}

/* ---- shadow puppet: Closer | the scene (lamp, puppet, wall) | Farther; four shapes underneath ---- */
.pi-pup{display:grid; grid-template-rows:minmax(0,1fr) clamp(90px, 13vh, 150px); gap:14px; min-height:0}
.pi-pupmain{display:grid; grid-template-columns:clamp(180px, 17vw, 320px) minmax(0,1fr) clamp(180px, 17vw, 320px); gap:14px; min-height:0}
.pi-scene{position:relative; overflow:hidden; border-radius:16px; min-height:0;
    background:linear-gradient(90deg, #2A2418 0%, #14161A 60%)}
.pi-lamp{position:absolute; left:3%; top:50%; width:12%; aspect-ratio:1; transform:translateY(-50%)}
.pi-lamp .bulb{position:absolute; inset:18%; border-radius:50%; background:radial-gradient(circle, #FFFBE0, #FFD84A 60%, #E0A21A);
    box-shadow:0 0 40px 18px rgba(255,220,90,.55)}
.pi-lamp .shade{position:absolute; left:-20%; top:8%; width:46%; height:84%; border-radius:12px 0 0 12px; background:#5A6168}
.pi-beam{position:absolute; left:10%; top:0; bottom:0; right:22%; pointer-events:none;
    background:linear-gradient(90deg, rgba(255,235,150,.30), rgba(255,235,150,.08));
    clip-path:polygon(0 42%, 100% 0, 100% 100%, 0 58%)}
.pi-wall{position:absolute; right:0; top:0; bottom:0; width:24%; background:linear-gradient(90deg, #E9DCC0, #F6EEDC)}
.pi-puppet{position:absolute; top:50%; left:48%; transform:translate(-50%, -50%); font-size:clamp(56px, 6vw, 120px); line-height:1;
    transition:left 600ms ease}
.pi-puppet::after{content:""; position:absolute; left:50%; top:90%; width:6px; height:120%; margin-left:-3px; background:#8B6B45; border-radius:3px}
.pi-puppet[data-at="0"]{left:30%} .pi-puppet[data-at="1"]{left:62%}
.pi-shadow{position:absolute; right:12%; top:50%; transform:translate(50%, -50%) scale(1); transform-origin:50% 50%;
    font-size:clamp(56px, 6vw, 120px); line-height:1; filter:brightness(0); opacity:.8; transition:transform 600ms ease}
.pi-shapes{display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:14px; min-height:0}
.pi-shape .pi-glyph{font-size:clamp(40px, 3.6vw, 72px)}

@media (prefers-reduced-motion: reduce){
  .pi-pos, .pi-tile, .pi-pos.alive, .pi-hole.alive .pi-reed, .pi-bar.alive, .pi-puppet, .pi-shadow, .pi-bubble,
  .pi-string .base, .pi-string .pulse{transition:none; animation:none}
  .pi-string.wave .pulse{animation:none; stroke-dasharray:none; opacity:1}
}`;
  document.head.appendChild(s);
}

const SVG_NS = "http://www.w3.org/2000/svg";
// a paper cup on its side, its mouth toward the string (flip = mouth to the left)
function cupSvg(flip) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 120 120"); svg.setAttribute("aria-hidden", "true");
  const g = document.createElementNS(SVG_NS, "g");
  if (flip) g.setAttribute("transform", "translate(120 0) scale(-1 1)");
  g.innerHTML = '<path d="M14 34 L96 14 L96 106 L14 86 Z" fill="#F6F1E7" stroke="#C9BFA9" stroke-width="3"/>' +
    '<ellipse cx="96" cy="60" rx="10" ry="46" fill="#E2D8C3" stroke="#C9BFA9" stroke-width="3"/>' +
    '<path d="M22 40 L88 24" stroke="#E8604C" stroke-width="7" stroke-linecap="round"/>' +
    '<path d="M22 80 L88 96" stroke="#E8604C" stroke-width="7" stroke-linecap="round"/>';
  svg.appendChild(g);
  return svg;
}

export function mountPlayit(host, playit, { say = () => {}, log = () => {}, sound = {}, clockMs = 60000 } = {}) {
  injectCss();
  let lockPaused = false;
  const blocked = () => lockPaused || window.AppLock?.isLocked();
  const instrument = playit.instrument, answer = playit.answer, q = playit.q;
  const S = { play: (n) => { try { return sound.play && sound.play(n); } catch { return false; } },
              note: (m, v) => { try { return sound.note && sound.note(m, v); } catch { return false; } },
              muffled: (on) => { try { if (sound.muffled) sound.muffled(on); } catch {} } };
  let gone = false, started = false, phase = "free", strike = 0, qEl = null;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!gone && !blocked()) fn(); }, ms); timers.add(t); return t; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

  host.textContent = "";
  const root = el("div", "pi");
  root.dataset.instrument = instrument;
  const name = el("p", "pi-name", NAMES[instrument] || "Play it");
  const body = el("div", "pi-body");
  root.append(name, body);
  host.appendChild(root);

  // a position tile: .dwell, 1x hold (no data-dwell-ms), its index in data-i
  function posTile(i, cls, label) {
    const t = el("button", "pi-pos dwell " + cls);
    t.type = "button"; t.dataset.i = String(i);
    if (label) { t.setAttribute("aria-label", label); t.dataset.dwellSay = label; }
    t.addEventListener("click", () => pickPos(i));
    return t;
  }
  function wordTile(cls, glyph, word, onPick) {
    const t = el("button", "pi-tile dwell " + cls);
    t.type = "button"; t.setAttribute("aria-label", word); t.dataset.dwellSay = word;
    const g = el("span", "pi-glyph", glyph); g.setAttribute("aria-hidden", "true");
    t.append(g, el("span", "pi-word", word));
    if (onPick) t.addEventListener("click", onPick);
    return t;
  }
  // light a tile for ms (restarting any light already on it)
  const lightTimers = new Map();
  function light(t, ms) {
    clearTimeout(lightTimers.get(t));
    t.classList.remove("alive"); void t.offsetWidth; t.classList.add("alive");
    lightTimers.set(t, later(() => t.classList.remove("alive"), ms));
  }

  // ---------- the four renderers: each fills body and returns { tiles, sound(i), hint } ----------
  function pitched(kind) {
    const wrap = el("div", kind === "harmonica" ? "pi-harm" : "pi-xylo");
    if (kind === "xylophone") { const r1 = el("div", "pi-rail"), r2 = el("div", "pi-rail"); r1.style.top = "34%"; r2.style.top = "64%"; wrap.append(r1, r2); }
    const tiles = NOTES.map((midi, i) => {
      const t = posTile(i, kind === "harmonica" ? "pi-hole" : "pi-bar", (NAMES[kind] + " " + (i + 1)));
      if (kind === "harmonica") t.append(el("span", "pi-reed"), el("span", "pi-cell"));
      else { t.style.height = (100 - i * 5) + "%"; t.style.background = BAR_COLOURS[i]; }
      wrap.appendChild(t);
      return t;
    });
    body.appendChild(wrap);
    const m = /\b(low|high)/i.exec(q);
    return {
      tiles,
      sound(i, ms) { S.note(NOTES[i], kind); light(tiles[i], ms || NOTE_MS[kind]); },
      hint: "Listen for the " + (m ? m[1].toLowerCase() : "low") + " one",
    };
  }

  function telephone() {
    const STATES = ["tight", "loose"];
    let state = null, calling = false, afterCall = null;
    const wrap = el("div", "pi-tel");
    const scene = el("div", "pi-telscene");
    const cup = el("button", "pi-tile dwell pi-cup");
    cup.type = "button"; cup.id = "piCup"; cup.setAttribute("aria-label", "Talk"); cup.dataset.dwellSay = "Talk";
    cup.append(cupSvg(false), el("span", "pi-word", "Talk"));
    const str = el("div", "pi-string"); str.id = "piString";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 1000 120"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
    const base = document.createElementNS(SVG_NS, "path"), pulse = document.createElementNS(SVG_NS, "path");
    base.setAttribute("class", "base"); pulse.setAttribute("class", "pulse"); pulse.setAttribute("pathLength", "1000");
    svg.append(base, pulse); str.appendChild(svg);
    const far = el("div", "pi-far"); far.id = "piFar"; far.setAttribute("aria-hidden", "true");
    const bubble = el("span", "pi-bubble", "Hello!");
    far.append(bubble, cupSvg(true));
    scene.append(cup, str, far);
    const row = el("div", "pi-states");
    const tiles = [["Tight", "➖"], ["Loose", "〰️"]].map(([word, glyph], i) => {
      const t = posTile(i, "pi-tile", word);
      t.id = "pos" + i;
      const g = el("span", "pi-glyph", glyph); g.setAttribute("aria-hidden", "true");
      t.append(g, el("span", "pi-word", word));
      row.appendChild(t);
      return t;
    });
    wrap.append(scene, row);
    body.appendChild(wrap);
    function draw() {
      const d = STRING_D[state === null ? "null" : state];
      base.setAttribute("d", d); pulse.setAttribute("d", d);
      tiles.forEach((t, i) => t.classList.toggle("on", i === state));
    }
    draw();
    cup.addEventListener("click", () => {
      if (blocked()) return;
      touched();
      if (calling) return;
      calling = true;
      log({ instrument, talk: true, string: state === null ? null : STATES[state] });
      const loose = state === 1;
      str.classList.remove("wave"); void str.getBoundingClientRect(); str.classList.add("wave");
      S.play("string-pluck");
      clearTimeout(afterCall);
      later(() => {
        str.classList.remove("wave");
        calling = false;                       // the far cup has it: she may call again at once
        S.muffled(loose);
        S.play("hello");
        bubble.classList.toggle("faint", loose);
        bubble.classList.add("show");
        afterCall = later(() => {
          bubble.classList.remove("show", "faint");
          S.muffled(false);
          afterCall = null;
        }, 1300);
      }, reduced() ? 300 : WAVE_MS);
    });
    return {
      tiles,
      sound(i, ms) { state = i; draw(); S.play(i === 0 ? "string-pluck" : "drum-low"); light(tiles[i], ms || MOVE_MS); },
      hint: "Try the " + STATES[answer] + " string",
      pause() { calling = false; afterCall = null; S.muffled(false); },
      destroy() { if (calling || afterCall) S.muffled(false); },
    };
  }

  function puppet() {
    let at = null, shape = SHAPES[0];
    const wrap = el("div", "pi-pup");
    const main = el("div", "pi-pupmain");
    const scene = el("div", "pi-scene"); scene.id = "piScene"; scene.setAttribute("aria-hidden", "true");
    const lamp = el("div", "pi-lamp"); lamp.id = "piLamp"; lamp.append(el("span", "shade"), el("span", "bulb"));
    const beam = el("div", "pi-beam");
    const wall = el("div", "pi-wall"); wall.id = "piWall";
    const pup = el("div", "pi-puppet", shape[1]); pup.id = "piPuppet";
    const shadow = el("div", "pi-shadow", shape[1]); shadow.id = "piShadow";
    scene.append(beam, wall, shadow, lamp, pup);
    const tiles = [["Closer", "⬅️"], ["Farther", "➡️"]].map(([word, glyph], i) => {
      const t = posTile(i, "pi-tile col", word);
      t.id = "pos" + i;
      const g = el("span", "pi-glyph", glyph); g.setAttribute("aria-hidden", "true");
      t.append(g, el("span", "pi-word", word));
      return t;
    });
    main.append(tiles[0], scene, tiles[1]);
    const shapes = el("div", "pi-shapes");
    for (const sh of SHAPES) {
      const t = wordTile("pi-shape", sh[1], sh[2], () => {
        touched();
        shape = sh; pup.textContent = sh[1]; shadow.textContent = sh[1];
        S.play("pop");
        light(t, 400);
        log({ instrument, shape: sh[0] });
      });
      t.dataset.shape = sh[0];
      shapes.appendChild(t);
    }
    wrap.append(main, shapes);
    body.appendChild(wrap);
    function draw() {
      const scale = at === 0 ? 1.6 : at === 1 ? 0.7 : 1;
      shadow.dataset.scale = String(scale);
      shadow.style.transform = "translate(50%, -50%) scale(" + scale + ")";
      if (at === null) delete pup.dataset.at; else pup.dataset.at = String(at);
      tiles.forEach((t, i) => t.classList.toggle("on", i === at));
    }
    draw();
    return {
      tiles,
      sound(i, ms) { at = i; draw(); S.play(i === 0 ? "whoosh-up" : "whoosh-down"); light(tiles[i], ms || MOVE_MS); },
      hint: "Move it " + ["closer", "farther"][answer],
    };
  }

  const R = instrument === "harmonica" || instrument === "xylophone" ? pitched(instrument)
    : instrument === "string-telephone" ? telephone() : puppet();

  // ---------- the runner ----------
  function touched() {
    if (started) return;
    started = true;
    later(ask, clockMs);
  }
  function ask() {
    phase = "ask";
    qEl = el("p", "pi-q", q); qEl.id = "piQ";
    name.replaceWith(qEl);
    say(q);
  }
  function retire() {
    later(() => { if (qEl) { qEl.replaceWith(name); qEl = null; } }, QUESTION_GONE_MS);
  }
  function cheer(i) {
    R.sound(i, CHEER_MS);
    S.play("cheer");
    try { confetti(24); } catch {}
    say(PRAISE());
    retire();
  }
  function pickPos(i) {
    if (gone || blocked()) return;
    touched();
    if (phase !== "ask") {
      log({ instrument, pick: i });
      R.sound(i);
      return;
    }
    if (i === answer) {
      phase = "after";
      log({ instrument, pick: i, right: true, strike });
      cheer(i);
      return;
    }
    strike += 1;
    log({ instrument, pick: i, right: false, strike });
    R.sound(i);
    if (strike >= 2) {
      phase = "after";
      later(() => cheer(answer), SECOND_MS);
      return;
    }
    say(q + " " + R.hint);
  }

  return {
    pause() { lockPaused = true; for (const t of timers) clearTimeout(t); timers.clear(); if (R.pause) R.pause(); if (phase === 'free') started = false; },
    resume() { lockPaused = false; },
    destroy() {
      gone = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (R.destroy) R.destroy();
      host.textContent = "";
    },
  };
}
