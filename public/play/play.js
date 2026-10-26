/*
 * play.js — the Play app's shell, menu and router (spec 2026-10-12 §5.1, §5.2, §5.6).
 *
 * /play/?w=<week_of> reads GET /this-week/<w>/play.json (the hub validated it; the page never
 * reads the raw manifest) and opens the MENU: the shared door bar, Back in the rail (to the This
 * week board), and up to three engine tiles in the triangle (§5.6 amended 2026-10-25), two rows of
 * three seats — Which one? top-left, Sort it top-right, Play it bottom-centre, black in the other
 * three; an engine with no content this week has no tile, its seat black. A 404 or a bad
 * w: the menu with no engine tiles and "Nothing to play yet", said once.
 *
 * The URL hash names the page (#menu, #which, #sort, #playit) so a reload lands on the same page
 * at its first item; state lives in memory. On an engine page Back returns to the menu.
 * Play it (playit.js) mounts the week's one instrument; its 60 s free-play clock is the module's,
 * shortened under tests by window.__clockMs as the 20 s re-say is by window.__idleMs.
 *
 * Laws: one dwell per user, only the two doors hold 2x (the bar does that; every tile here holds
 * her dwell, holdFor("content")); Speech.stop() before every say; nothing scores, nothing says
 * "wrong"; every pick POSTs /log {app:"this-week", door:"play", week_of, engine, item, pick, right,
 * strike} silently. The page talks to this hub only.
 */
import { holdFor } from "../lib/contract.js";
import { mountDoorBar } from "../lib/doorbar.js";
import { confetti } from "../lib/celebrate.js";
import { createSounds } from "./sounds.js";
import { mountWhich } from "./which.js";
import { mountSort } from "./sort.js";
import { mountPlayit } from "./playit.js";

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOARD = "/board/?recipe=this-week";
const PAGES = ["menu", "which", "sort", "playit"];
const PLAYIT_GLYPH = { "harmonica": "🎵", "xylophone": "🎵", "string-telephone": "☎️", "shadow-puppet": "🔦" };
const $ = (id) => document.getElementById(id);

const S = {
  ready: false, page: null, week_of: null, data: null, item: null, idx: 0,
  volCap: 1, paused: false, nothingSaid: false, mounted: null,
};
let BAR = null, SOUNDS = createSounds({ volCap: 1 });

// ---------- small things ----------
function hush() { try { if (window.Speech) Speech.stop(); } catch {} }
// returns the reading's promise (Which one? arms its answers when it settles), or nothing when
// nothing is read
function say(text) {
  if (window.__testHooks) (window.__speechLog = window.__speechLog || []).push({ call: "say", text });
  if (S.paused || !window.Speech) return;
  hush();
  try { return Speech.say(text, "long"); } catch { return undefined; }
}
function suppress() { try { if (window.Dwell && Dwell.suppress) Dwell.suppress(); } catch {} }
function logPick(engine, d) {
  const body = { app: "this-week", door: "play", week_of: S.week_of, engine, ...d };
  try {
    fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .catch(() => {});
  } catch {}
}
function idleMs() { const n = Number(window.__idleMs); return Number.isFinite(n) && n > 0 ? n : 20000; }
function clockMs() { const n = Number(window.__clockMs); return Number.isFinite(n) && n > 0 ? n : 60000; }
function play() { return (S.data && S.data.play) || { which: [], sort: null, playit: null }; }
function has(page) {
  const p = play();
  if (page === "which") return p.which.length > 0;
  if (page === "sort") return !!p.sort;
  if (page === "playit") return !!p.playit;
  return page === "menu";
}

// ---------- the pages ----------
function unmount() {
  if (S.mounted) { try { S.mounted.destroy(); } catch {} S.mounted = null; }
  S.item = null;
}

function renderMenu() {
  unmount();
  S.page = "menu";
  const stage = $("stage");
  stage.textContent = "";
  const menu = document.createElement("div");
  menu.className = "menu";
  const strip = document.createElement("p");
  strip.id = "strip";
  const p = play();
  const any = p.which.length > 0 || !!p.sort || !!p.playit;
  strip.textContent = any ? (S.data.title || "This week") : "Nothing to play yet";
  const seats = document.createElement("div");
  seats.className = "seats";
  // the triangle, in reading order: null = a black rest seat
  const engines = [
    { id: "which", label: "Which one?", glyph: "❓" }, null,
    { id: "sort", label: "Sort it", glyph: "🗂️" }, null,
    { id: "playit", label: "Play it", glyph: (p.playit && PLAYIT_GLYPH[p.playit.instrument]) || "🎵" }, null,
  ];
  engines.forEach((e, seat) => {
    if (!e || !has(e.id)) {
      const b = document.createElement("div");
      b.className = "seat empty"; b.dataset.seat = String(seat); b.setAttribute("aria-hidden", "true");
      seats.appendChild(b);
      return;
    }
    const t = document.createElement("button");
    t.type = "button"; t.id = "tile-" + e.id; t.className = "seat tile dwell";
    t.dataset.seat = String(seat); t.setAttribute("aria-label", e.label); t.dataset.dwellSay = e.label;
    t.innerHTML = '<span class="big" aria-hidden="true"></span><span class="word"></span>';
    t.querySelector(".big").textContent = e.glyph;
    t.querySelector(".word").textContent = e.label;
    t.addEventListener("click", () => { location.hash = "#" + e.id; });
    seats.appendChild(t);
  });
  menu.append(strip, seats);
  stage.appendChild(menu);
  suppress();
  if (!any && !S.nothingSaid) { S.nothingSaid = true; say("Nothing to play yet"); }
}

function renderWhich() {
  unmount();
  S.page = "which";
  S.idx = 0;
  mountItem();
}
function mountItem() {
  const items = play().which;
  const item = items[S.idx];
  const stage = $("stage");
  stage.textContent = "";
  const host = document.createElement("div");
  host.className = "wh-host";
  stage.appendChild(host);
  S.item = item.id;
  S.mounted = mountWhich(host, item, {
    say,
    log: (d) => logPick("which", d),
    sound: (name) => SOUNDS.play(name),
    idleMs: idleMs(),
    onDone: () => {
      if (S.page !== "which" || S.item !== item.id) return;
      if (S.idx + 1 < items.length) { S.mounted = null; S.idx += 1; mountItem(); return; }
      try { confetti(60); } catch {}
      say("You did them all!");
      location.hash = "#menu";
    },
  });
  suppress();
}

function renderSort() {
  unmount();
  S.page = "sort";
  S.idx = 0;
  const stage = $("stage");
  stage.textContent = "";
  const host = document.createElement("div");
  host.className = "so-host";
  stage.appendChild(host);
  let mounted = null;
  mounted = mountSort(host, play().sort, {
    say,
    log: (d) => logPick("sort", d),
    sound: (name) => SOUNDS.play(name),
    idleMs: idleMs(),
    weekOf: S.week_of,
    onItem: (i, m) => { if (S.page === "sort" && (mounted === null || S.mounted === mounted)) { S.idx = i; S.item = m; } },
    onDone: () => {
      if (S.page !== "sort" || S.mounted !== mounted) return;
      try { confetti(60); } catch {}
      say("All sorted!");
      // a moment to see the full bins under the confetti, then the menu
      setTimeout(() => { if (S.page === "sort" && S.mounted === mounted) location.hash = "#menu"; }, 1200);
    },
  });
  S.mounted = mounted;
  suppress();
}

function renderPlayit() {
  unmount();
  S.page = "playit";
  S.idx = 0;
  const stage = $("stage");
  stage.textContent = "";
  const host = document.createElement("div");
  host.className = "pi-host";
  stage.appendChild(host);
  S.item = play().playit.instrument;
  S.mounted = mountPlayit(host, play().playit, {
    say,
    log: (d) => logPick("playit", d),
    // SOUNDS is re-made once /settings answers: always reach the current one
    sound: { play: (n) => SOUNDS.play(n), note: (m, v) => SOUNDS.note(m, v), muffled: (on) => SOUNDS.muffled(on) },
    clockMs: clockMs(),
  });
  suppress();
}

function route() {
  const h = (location.hash || "").replace(/^#/, "");
  const page = PAGES.includes(h) && has(h) ? h : "menu";
  if (page !== h && h !== "") { history.replaceState(null, "", location.pathname + location.search + "#menu"); }
  if (page === "which") renderWhich();
  else if (page === "sort") renderSort();
  else if (page === "playit") renderPlayit();
  else renderMenu();
}

// ---------- the door bar's hooks ----------
function onLeave() { unmount(); hush(); }
function onPause() { S.paused = true; hush(); }
function onResume() { S.paused = false; }

// ---------- boot ----------
async function boot() {
  if (window.__testHooks) window.__speechLog = window.__speechLog || [];
  // THE DOOR IS UP BEFORE ANY FETCH (the board's 9/3 rule)
  BAR = mountDoorBar(document.body, { appPath: "/play/", onLeave, onPause, onResume });
  try { if (window.Speech) Speech.init("Let's play!"); } catch {}
  try {
    const st = await (await fetch("/settings")).json();
    if (Number.isFinite(st.dwellMs) && st.dwellMs > 0) {
      if (window.Dwell) Dwell.setMs(holdFor("content", st.dwellMs));
      BAR.setDwell(st.dwellMs);
    }
    if (window.Dwell && Number.isFinite(st.settleMs)) Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
    BAR.setPause(st.pauseGoes === "tdsnap");
    if (st.childName) window.ERA_CHILD_NAME = st.childName;
    if (Number.isFinite(st.musicVolCap)) S.volCap = Math.max(0, Math.min(1, st.musicVolCap / 100));
  } catch { /* defaults stand — never block her on settings */ }
  SOUNDS = createSounds({ volCap: S.volCap });
  // the autoplay policy: the one AudioContext starts on her first dwell (or a grown-up's click)
  document.addEventListener("click", () => SOUNDS.unlock(), true);

  const w = new URLSearchParams(location.search).get("w");
  if (w && WEEK_RE.test(w)) {
    S.week_of = w;
    try {
      const r = await fetch("/this-week/" + w + "/play.json", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.play && Array.isArray(j.play.which)) S.data = j;
      }
    } catch { /* nothing to play */ }
  }

  $("btnBack").addEventListener("click", () => {
    if (S.page === "menu") { onLeave(); location.assign(BOARD); }
    else location.hash = "#menu";
  });
  addEventListener("hashchange", route);
  addEventListener("resize", () => { if (BAR) BAR.sizeBar(); });
  addEventListener("pagehide", () => hush());
  route();
  S.ready = true;
}

window.Play = {
  state: () => ({ ready: S.ready, page: S.page, week_of: S.week_of, item: S.item, idx: S.idx,
                  volCap: S.volCap, paused: S.paused, engines: { which: has("which"), sort: has("sort"), playit: has("playit") } }),
};
boot();
