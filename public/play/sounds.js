/*
 * sounds.js — Play's voices, synthesised with Web Audio (spec 2026-10-12 §5.6). No files, no
 * licence, works offline; the instruments need pitched notes anyway.
 *
 *   createSounds({ volCap }) -> { play(name), note(midi, voice), muffled(on), unlock(), state() }
 *
 * One AudioContext, created lazily on the first unlock()/play() (the page calls unlock() on her
 * first dwell or a grown-up's click — the autoplay policy). Everything runs through one master
 * GainNode at volCap (/settings musicVolCap / 100), then a low-pass "muffle" filter (the string
 * telephone's loose string), then the speakers.
 *
 * play(name) -> true when the library knows the name (it then sounds), false otherwise — an
 * unknown name is nothing, never a throw (a manifest `sound` the library lacks is ignored).
 * Where the browser has no AudioContext (or it cannot start), every call still answers and logs;
 * it is simply silent.
 *
 * Test hook: window.__soundLog (names as strings, notes as their MIDI number, "muffled"/"clear")
 * when the page runs under tests (window.__testHooks / __ERA_TEST, or a driven browser).
 */

const VOICES = {
  "drum-low": (c, out, t) => thump(c, out, t, 80, 0.3),
  "drum-high": (c, out, t) => thump(c, out, t, 180, 0.2),
  "bell-low": (c, out, t) => bell(c, out, t, 392),
  "bell-high": (c, out, t) => bell(c, out, t, 784),
  "string-pluck": (c, out, t) => pluck(c, out, t, 220),
  "whoosh-up": (c, out, t) => whoosh(c, out, t, 300, 3000),
  "whoosh-down": (c, out, t) => whoosh(c, out, t, 3000, 300),
  "pop": (c, out, t) => pop(c, out, t),
  "cheer": (c, out, t) => { [72, 76, 79].forEach((m, i) => tone(c, out, t + i * 0.13, hz(m), 0.32, "triangle", 0.5)); },
  "hello": (c, out, t) => hello(c, out, t),
};
export const VOICE_NAMES = Object.freeze(Object.keys(VOICES));

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

function env(c, t, peak, dur) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}
function tone(c, out, t, f, dur, type, peak) {
  const o = c.createOscillator(), g = env(c, t, peak, dur);
  o.type = type; o.frequency.setValueAtTime(f, t);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
}
function thump(c, out, t, f, dur) {
  const o = c.createOscillator(), g = env(c, t, 0.9, dur);
  o.type = "sine"; o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
}
function bell(c, out, t, f) {
  tone(c, out, t, f, 1.2, "sine", 0.6);
  tone(c, out, t, f * 3, 0.8, "sine", 0.18);          // the 3rd harmonic, dying sooner
}
function noise(c, dur) {
  const n = Math.max(1, Math.floor(c.sampleRate * dur)), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource(); s.buffer = buf; return s;
}
// Karplus-Strong in the graph: a noise burst into a short delay that feeds itself back, damped
function pluck(c, out, t, f) {
  const burst = noise(c, 0.02), d = c.createDelay(0.05), fb = c.createGain(), lp = c.createBiquadFilter(), g = env(c, t, 0.7, 1.0);
  d.delayTime.value = 1 / f; fb.gain.value = 0.96; lp.type = "lowpass"; lp.frequency.value = 3000;
  burst.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(g); g.connect(out);
  burst.start(t); burst.stop(t + 0.02);
  setTimeout(() => { try { fb.disconnect(); } catch {} }, 1200);
}
function whoosh(c, out, t, f0, f1) {
  const s = noise(c, 0.6), bp = c.createBiquadFilter(), g = env(c, t, 0.5, 0.6);
  bp.type = "bandpass"; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + 0.55);
  s.connect(bp); bp.connect(g); g.connect(out); s.start(t); s.stop(t + 0.6);
}
function pop(c, out, t) {
  const o = c.createOscillator(), g = env(c, t, 0.7, 0.12);
  o.type = "sine"; o.frequency.setValueAtTime(400, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.06);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.14);
}
// "hello" (the string telephone's far cup): a breathy h, then two voiced vowels ("eh", "oh") made of
// a buzzing source through two formant band-passes, the pitch lifting then falling like a greeting.
// Under muffled(true) the low-pass takes the second formant and the buzz away: faint and muffled.
function vowel(c, out, t, dur, f0a, f0b, F1, F2, peak) {
  const src = c.createOscillator(), g = c.createGain(), b1 = c.createBiquadFilter(), b2 = c.createBiquadFilter();
  src.type = "sawtooth"; src.frequency.setValueAtTime(f0a, t); src.frequency.linearRampToValueAtTime(f0b, t + dur);
  b1.type = "bandpass"; b1.frequency.value = F1; b1.Q.value = 6;
  b2.type = "bandpass"; b2.frequency.value = F2; b2.Q.value = 8;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.03);
  g.gain.setValueAtTime(peak, t + dur - 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(b1); src.connect(b2); b1.connect(g); b2.connect(g); g.connect(out);
  src.start(t); src.stop(t + dur + 0.02);
}
function hello(c, out, t) {
  const h = noise(c, 0.09), hp = c.createBiquadFilter(), hg = env(c, t, 0.25, 0.09);
  hp.type = "highpass"; hp.frequency.value = 1200;
  h.connect(hp); hp.connect(hg); hg.connect(out); h.start(t); h.stop(t + 0.1);
  vowel(c, out, t + 0.06, 0.2, 210, 250, 530, 1840, 1.6);      // "heh"
  vowel(c, out, t + 0.28, 0.38, 250, 180, 570, 840, 1.8);      // "loh"
}
// harmonica: sawtooth + 5 Hz vibrato + a band-pass reed colour, 700 ms
function harmonica(c, out, t, f) {
  const o = c.createOscillator(), lfo = c.createOscillator(), depth = c.createGain(), bp = c.createBiquadFilter();
  const g = c.createGain();
  o.type = "sawtooth"; o.frequency.setValueAtTime(f, t);
  lfo.frequency.value = 5; depth.gain.value = f * 0.012; lfo.connect(depth); depth.connect(o.frequency);
  bp.type = "bandpass"; bp.frequency.value = f * 2; bp.Q.value = 0.9;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.06);
  g.gain.setValueAtTime(0.5, t + 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  o.connect(bp); bp.connect(g); g.connect(out);
  o.start(t); lfo.start(t); o.stop(t + 0.72); lfo.stop(t + 0.72);
}
// xylophone: sine + a decaying 4th harmonic, 500 ms
function xylophone(c, out, t, f) {
  tone(c, out, t, f, 0.5, "sine", 0.7);
  tone(c, out, t, f * 4, 0.12, "sine", 0.25);
}

function testing() {
  try { return !!(window.__testHooks || window.__ERA_TEST || (navigator && navigator.webdriver)); } catch { return false; }
}

export function createSounds({ volCap = 1 } = {}) {
  const cap = Number.isFinite(volCap) ? Math.max(0, Math.min(1, volCap)) : 1;
  let ctx = null, master = null, muff = null, failed = false, isMuffled = false;
  if (testing()) try { window.__soundLog = window.__soundLog || []; } catch {}
  function record(x) {
    if (!testing()) return;
    try { (window.__soundLog = window.__soundLog || []).push(x); } catch {}
  }
  function ensure() {
    if (ctx || failed) return ctx;
    const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) { failed = true; return null; }
    try {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = cap;
      muff = ctx.createBiquadFilter(); muff.type = "lowpass"; muff.frequency.value = isMuffled ? 700 : 20000;
      master.connect(muff); muff.connect(ctx.destination);
    } catch { ctx = null; master = null; muff = null; failed = true; }
    return ctx;
  }
  function run(fn) {
    const c = ensure();
    if (!c) return;
    try {
      if (c.state === "suspended") c.resume().catch(() => {});
      fn(c, master, c.currentTime + 0.01);
    } catch { /* a voice that cannot sound is silent, never a throw */ }
  }
  function play(name) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(VOICES, name)) return false;
    record(name);
    run(VOICES[name]);
    return true;
  }
  function note(midi, voice = "harmonica") {
    if (!Number.isFinite(midi)) return false;
    record(midi);
    const f = hz(midi);
    run((c, out, t) => (voice === "xylophone" ? xylophone : harmonica)(c, out, t, f));
    return true;
  }
  function muffled(on) {
    isMuffled = !!on;
    record(isMuffled ? "muffled" : "clear");
    if (muff && ctx) try { muff.frequency.setValueAtTime(isMuffled ? 700 : 20000, ctx.currentTime); } catch {}
  }
  function unlock() {
    const c = ensure();
    if (c && c.state === "suspended") try { c.resume().catch(() => {}); } catch {}
  }
  function state() { return { ctx: !!ctx, gain: master ? master.gain.value : null, volCap: cap, muffled: isMuffled }; }
  return { play, note, muffled, unlock, state };
}
