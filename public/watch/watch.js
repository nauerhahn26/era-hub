/*
 * watch.js — /watch/?w=<week_of>&v=<id> (spec 2026-10-12 §3.3, amended 2026-10-21; §5.4).
 *
 * Dad 10/13: a video is "like the music player: another screen, with pause and back" — never a
 * second window. The board takes the same kiosk window here. The page:
 *   - the shared door bar on top (🚪 leaves as everywhere; 💬 pauses the video in place and goes
 *     to talk, coming back picks it up);
 *   - a left rail: Back (to the Watch grid) on top, Pause / Play below it (one tile whose word and
 *     glyph follow the video), a black rest box;
 *   - the video filling the rest, letterboxed on black, its volume musicVolCap / 100.
 * Ended -> log, then the Watch grid. Cannot play -> log, a second, the Watch grid. Bad params ->
 * the Watch grid after a second, so a broken tile never strands her.
 *
 * `before` (§5.4): play.json's before[<id>] is one Which-one item, mounted with the Play app's
 * which.js over the video area first (the video there, paused and hidden; the Pause tile rests),
 * two-strike and never wrong; once it is done the question is cleared and the video plays.
 *
 * Every step POSTs /log {app:"this-week", door:"watch", week_of, id, event, ms} with event in
 * open|ended|error|paused|resumed|before (before adds item, pick, right, strike); ms = the
 * milliseconds of video played. The ones that precede a navigation go keepalive.
 *
 * Laws: one dwell per user, only the two doors hold 2x (the bar does that); Speech.stop() before
 * every say; nothing says "wrong". The page talks to this hub only — no gaze-engine call, no
 * fullscreen request, nothing that can launch twice.
 */
import { holdFor } from "../lib/contract.js";
import { mountDoorBar } from "../lib/doorbar.js";
import { createSounds } from "../play/sounds.js";
import { mountWhich } from "../play/which.js";

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const GRID = "/board/?recipe=this-week&board=watch";
const $ = (id) => document.getElementById(id);

const q = new URLSearchParams(location.search);
const week_of = q.get("w") || "", id = q.get("v") || "";
const video = $("video");
// phase: boot -> (before) -> watching -> gone
const S = { phase: "boot", talkPaused: false, failed: false, volCap: 1, ready: false };
let BAR = null, SOUNDS = createSounds({ volCap: 1 }), WHICH = null;

// ---------- small things ----------
function hush() { try { if (window.Speech) Speech.stop(); } catch {} }
function say(text) {
  if (window.__testHooks) (window.__speechLog = window.__speechLog || []).push({ call: "say", text });
  if (!window.Speech) return;
  hush();
  try { return Speech.say(text, "long"); } catch {}
}
function playedMs() {
  let ms = 0;
  try { const r = video.played; for (let i = 0; i < r.length; i++) ms += (r.end(i) - r.start(i)) * 1000; } catch {}
  return Math.round(ms);
}
function log(event, extra = {}, keepalive = false) {
  const body = { app: "this-week", door: "watch", week_of, id, event, ms: playedMs(), ...extra };
  try {
    return fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), ...(keepalive ? { keepalive: true } : {}) }).catch(() => {});
  } catch { return Promise.resolve(); }
}
function toGrid() {
  if (S.phase === "gone") return;
  S.phase = "gone";
  for (const b of [$("btnBack"), $("btnPause")]) b.setAttribute("data-dwell-disabled", "");
  try { video.pause(); } catch {}
  hush();
  location.assign(GRID);
}

// ---------- the Pause / Play tile ----------
function paint() {
  const t = $("btnPause");
  const resting = S.phase !== "watching";
  t.classList.toggle("resting", resting);
  if (resting) t.setAttribute("data-dwell-disabled", ""); else t.removeAttribute("data-dwell-disabled");
  const playing = !video.paused && !video.ended;
  t.querySelector(".glyph").textContent = playing ? "⏸" : "▶";
  t.querySelector(".word").textContent = playing ? "Pause" : "Play";
  t.setAttribute("aria-label", playing ? "Pause" : "Play");
  t.dataset.dwellSay = playing ? "Pause" : "Play";
}
function start() {
  video.play().catch(() => {});   // the kiosk lets a video start with its sound; a refusal leaves "Play"
}
function toggle() {
  if (S.phase !== "watching") return;
  if (video.paused) { start(); log("resumed"); }
  else { video.pause(); log("paused"); }
}

// ---------- the video ----------
function watch() {
  if (S.phase === "gone") return;
  S.phase = "watching";
  video.hidden = false;
  paint();
  if (S.failed) { failed(); return; }
  video.autoplay = true;
  start();
}
function failed() {
  if (S.phase === "gone") return;
  log("error", {}, true);
  setTimeout(toGrid, 1000);
  S.phase = "failing";
}
video.addEventListener("play", paint);
video.addEventListener("pause", paint);
video.addEventListener("ended", () => {
  if (S.phase !== "watching") return;
  // the log first (keepalive survives the navigation), then the Watch grid
  log("ended", {}, true);
  toGrid();
});
video.addEventListener("error", () => {
  // a broken file during the question: answered first, then the Watch grid
  if (S.phase === "watching") failed(); else S.failed = true;
});

// ---------- before (§5.4) ----------
function runBefore(item) {
  S.phase = "before";
  video.hidden = true;
  try { if (window.Speech) Speech.init(item.q); } catch {}
  paint();
  const host = $("before");
  host.hidden = false;
  WHICH = mountWhich(host, item, {
    say,
    sound: (name) => SOUNDS.play(name),
    log: (d) => log("before", d),
    onDone: () => {
      if (S.phase !== "before") return;
      if (WHICH) { WHICH.destroy(); WHICH = null; }
      host.hidden = true;
      hush();
      try { if (window.Dwell && Dwell.suppress) Dwell.suppress(); } catch {}
      watch();
    },
  });
  try { if (window.Dwell && Dwell.suppress) Dwell.suppress(); } catch {}
}

// ---------- the door bar's hooks ----------
function onLeave() { S.phase = "gone"; try { video.pause(); } catch {} hush(); }
function onPause() {
  hush();
  if (S.phase === "watching" && !video.paused) { S.talkPaused = true; video.pause(); log("paused", {}, true); }
}
function onResume() {
  if (S.talkPaused && S.phase === "watching") { start(); log("resumed"); }
  S.talkPaused = false;
}

// ---------- boot ----------
async function boot() {
  if (window.__testHooks) window.__speechLog = window.__speechLog || [];
  // THE DOOR IS UP BEFORE ANY FETCH (the board's 9/3 rule)
  BAR = mountDoorBar(document.body, { appPath: "/watch/", onLeave, onPause, onResume });
  paint();
  $("btnBack").addEventListener("click", toGrid);
  $("btnPause").addEventListener("click", toggle);
  addEventListener("resize", () => { if (BAR) BAR.sizeBar(); });
  addEventListener("pagehide", () => hush());
  document.addEventListener("click", () => SOUNDS.unlock(), true);

  if (!WEEK_RE.test(week_of) || !ID_RE.test(id)) { S.phase = "bad"; setTimeout(toGrid, 1000); return; }

  // the mp4 starts loading at once; nothing plays until settings (the cap) and play.json are in
  video.src = "/this-week/" + week_of + "/" + id + ".mp4";
  const settings = fetch("/settings").then((r) => r.json()).catch(() => null);
  const playJson = fetch("/this-week/" + week_of + "/play.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const st = await settings;
  if (st) {
    if (Number.isFinite(st.dwellMs) && st.dwellMs > 0) {
      if (window.Dwell) Dwell.setMs(holdFor("content", st.dwellMs));
      BAR.setDwell(st.dwellMs);
    }
    if (window.Dwell && Number.isFinite(st.settleMs)) Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
    BAR.setPause(st.pauseGoes === "tdsnap");
    if (st.childName) window.ERA_CHILD_NAME = st.childName;
    if (Number.isFinite(st.musicVolCap)) S.volCap = Math.max(0, Math.min(1, st.musicVolCap / 100));
  }
  video.volume = S.volCap;
  SOUNDS = createSounds({ volCap: S.volCap });
  const pj = await playJson;
  if (S.phase !== "boot") return;      // she left while it loaded
  log("open");
  S.ready = true;
  const item = pj && pj.before && typeof pj.before === "object" ? pj.before[id] : null;
  if (item && Array.isArray(item.choices) && !S.failed) runBefore(item);
  else watch();
}

window.Watch = { state: () => ({ ready: S.ready, phase: S.phase, volCap: S.volCap, paused: video.paused }) };
boot();
