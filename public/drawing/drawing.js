/*
 * Drawing — make a picture with your eyes (spec docs/superpowers/specs/2026-09-30-drawing-design.md).
 *
 * Two screens: THE SHELF (/drawing/) — her pictures newest first, a New picture tile — and THE RING
 * (/drawing/#p=<id>) — eight sticker tiles down both sides, her picture in the middle, Undo and
 * Done either side of a black rest tile. One dwell on a sticker speaks its word and the sticker
 * flies into a sensible place by itself ("pick and it lands"). Her picture is inert: looking at
 * it does nothing (EyeDraw's Midas-touch lesson). A grown-up's finger may move a sticker.
 *
 * Laws (spec §7): one dwell per user, only the two doors are 2x; Speech.stop() before every
 * action of hers; never "wrong", never "sent"; nothing times out; zero layout shift; a picture is
 * never lost (memory + localStorage until the hub has it).
 */
"use strict";
const EC = window.EllieContract.CONTRACT;
const SC = window.DrawingScene;
const $ = (id) => document.getElementById(id);

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9][a-z0-9-]{0,39}$/;   // drawings.js ID_RE, the same
const MAX_ITEMS = 200;          // drawings.js LIMITS.items: the hub refuses more
const HISTORY_MAX = 60;         // spec §2.2
const SAVE_MS = 800;            // spec §4: autosave debounce
const POLL_MS = 60000;          // the shelf notices a picture another device made
const BOOK_CELLS = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 4], [3, 2], [3, 3], [3, 4]];   // reader.js:489
const PER_PAGE = BOOK_CELLS.length;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAIL_LINES = {
  sent: "Sent to your family",
  "no-email": "Saved — no family email set up yet",
  failed: "Saved — mail failed, will not retry",
  unchanged: "Saved — already sent, nothing new to send",
  empty: "Saved — the picture is empty, nothing sent",
};
const BAR_DOORS = new Set(["barDoor", "barTalk"]);

const S = {
  ready: false, table: { stickers: [], zones: {} }, stickers: new Map(), images: {},
  screen: null, id: null, scene: null, history: [], dirty: false, saveTimer: null, finishing: false,
  paused: false, wasPaused: false,
  index: [], shelfPage: 0, shelfPages: 1, shelfIds: [], painted: "", pollTimer: null,
  lastMail: null, said: [], park: null, session: "s" + Date.now(),
};
let BAR = null;
let frozen = [];                 // the .dwell targets the grown-up's sheet put to sleep
const mailWatchers = [];

// ---------- small things ----------
function log(event, detail) {
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), session: S.session, app: "drawing", event, ...detail }) }).catch(() => {});
}
function hush() { try { if (window.Speech) Speech.stop(); } catch {} }
// every voice the app has goes through here; S.said is the tests' (and a grown-up's) record
function say(text) {
  S.said.push(text);
  if (S.said.length > 20) S.said.shift();
  if (S.paused || !window.Speech) return Promise.resolve();
  return Speech.say(text, "long");
}
function suppress(ms) { try { if (window.Dwell && Dwell.suppress) Dwell.suppress(ms); } catch {} }
function confetti(n) { try { window.EllieCelebrate.confetti(n); } catch {} }

// ---------- local safety net (spec §4 rule 4) ----------
const stashKey = (id) => "drawing_scene_" + id;
function stash() {
  if (!S.id || !S.scene) return;
  try { localStorage.setItem(stashKey(S.id), JSON.stringify({ scene: S.scene, dirty: S.dirty, at: Date.now() })); } catch {}
}
function readStash(id) {
  try {
    const j = JSON.parse(localStorage.getItem(stashKey(id)) || "null");
    return j && j.scene && Array.isArray(j.scene.items) ? j : null;
  } catch { return null; }
}

// ---------- screens ----------
function show(which) {
  S.screen = which;
  $("sShelf").classList.toggle("show", which === "shelf");
  $("sRing").classList.toggle("show", which === "ring");
  document.body.dataset.screen = which;
}

// ---------- the gaze park (spec §2; deviation 6: the shelf's rest is its black centre) ----------
function tellPark() {
  try {
    let r = null;
    if (S.screen === "ring") r = $("restTile").getBoundingClientRect();
    else {
      const a = document.querySelector('#shelfGrid [data-cell="2,2"]'), b = document.querySelector('#shelfGrid [data-cell="2,3"]');
      if (a && b) {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        r = { left: ra.left, top: ra.top, width: rb.right - ra.left, height: rb.bottom - ra.top };
      }
    }
    if (!r || !r.width) return;
    const x = +((r.left + r.width / 2) / innerWidth).toFixed(3);
    const y = +((r.top + r.height / 2) / innerHeight).toFixed(3);
    S.park = { x, y };
    fetch(EC.parkOverride.endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y }) }).catch(() => {});
  } catch {}
}

// ---------- the shared bar: 🚪 leave and 💬 pause to talk ----------
function onLeave() { log("door", {}); hush(); save({ keepalive: true }); }
function onPause() { log("talk", {}); hush(); S.wasPaused = S.paused; S.paused = true; save({ keepalive: true }); }
function onResume() { S.paused = S.wasPaused; log("talk_resume", {}); tellPark(); }

// ---------- the ring's tiles, from stickers.json (seats fixed forever) ----------
function splatSample() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", SC.splatPath(7));
  p.setAttribute("fill", SC.SPLAT_COLOURS[0]);
  svg.appendChild(p);
  return svg;
}
function buildTiles() {
  const ring = $("sRing");
  for (const st of S.table.stickers) {
    S.stickers.set(st.id, st);
    const b = document.createElement("button");
    b.type = "button";
    b.id = "tile-" + st.id;
    b.className = "cell tile photo dwell";
    b.dataset.s = st.id;
    b.setAttribute("aria-label", st.word);
    b.style.gridRow = String(st.at[0]);
    b.style.gridColumn = String(st.at[1]);
    let pic;
    if (st.src) { pic = document.createElement("img"); pic.src = st.src; pic.alt = ""; pic.draggable = false; }
    else pic = splatSample();
    pic.classList.add("pic");
    const word = document.createElement("span");
    word.className = "word plate";
    word.textContent = st.word;
    b.append(pic, word);
    b.addEventListener("click", () => place(st.id, b));
    ring.appendChild(b);
    if (st.src) { const im = new Image(); im.src = st.src; S.images[st.id] = im; }   // for the PNG
  }
}
function paintScene() { SC.renderScene($("scene"), S.scene, { table: S.table }); }

// ---------- routing ----------
async function route() {
  const m = /^#p=([^&]+)$/.exec(location.hash || "");
  let id = null;
  try { id = m ? decodeURIComponent(m[1]) : null; } catch {}
  if (id && ID_RE.test(id)) await openRing(id); else await openShelf();
}
function go(id) {
  if (id) { location.hash = "p=" + encodeURIComponent(id); return; }     // hashchange -> route()
  history.replaceState(null, "", location.pathname + location.search);
  route();
}
async function loadScene(id) {
  const local = readStash(id);
  if (local && local.dirty) { S.dirty = true; return local.scene; }       // unsaved work wins (rule 4)
  S.dirty = false;
  try {
    const r = await fetch("/drawings/" + encodeURIComponent(id) + "/scene.json", { cache: "no-store" });
    if (r.ok) { const sc = await r.json(); if (sc && Array.isArray(sc.items)) return sc; }
  } catch {}
  if (local) return local.scene;
  return { v: 1, id, backdrop: "meadow", items: [] };
}
async function openRing(id) {
  if (S.screen === "ring" && S.id && S.id !== id && S.dirty) await save();
  stopPoll();
  S.id = id;
  S.history = [];
  S.scene = await loadScene(id);
  show("ring");
  paintScene();
  suppress();
  tellPark();
  if (S.dirty) scheduleSave();
  log("open", { id, items: S.scene.items.length });
}

// ---------- placing, undo, autosave (spec §2.1, §2.2, §4) — T8 ----------
// T8 replaces this section.
function place() {}
function undo() {}
function changed() {}
function scheduleSave() {}
async function save() { return true; }

// ---------- the grown-up's hands (partner.js calls these; spec §2.4) — T9 ----------
// T9 replaces this section.
function itemAt() { return null; }
function moveItem() {}
async function clearPicture() {}
function tuneDwell() { return window.Dwell ? Dwell.config.ms : EC.holds.content; }
function freeze() {}
function thaw() {}
function mailLine() { return ""; }
function setMail(res) { S.lastMail = res; }

// ---------- the shelf (spec §3) — T10 ----------
// T10 replaces this section. Until then the shelf is an empty screen the router can land on.
async function openShelf() { S.id = null; S.scene = null; S.history = []; S.dirty = false; show("shelf"); suppress(); tellPark(); }
function stopPoll() {}
async function pollShelf() {}
async function newPicture() {}

// ---------- Done (spec §2.3) — T11 ----------
// T11 replaces this section.
async function done() {}

// ---------- the page's own surface: tests, partner.js, field debugging ----------
window.Drawing = {
  state: () => ({
    ready: S.ready, screen: S.screen, id: S.id,
    items: S.scene ? S.scene.items.map((i) => ({ ...i })) : [],
    history: S.history.length, dirty: S.dirty, lastMail: S.lastMail,
    shelfPage: S.shelfPage, shelfPages: S.shelfPages, shelfIds: S.shelfIds.slice(),
    said: S.said.slice(), park: S.park, paused: S.paused,
  }),
  itemAt, moveItem, clamp: (o) => SC.clampItem(o), clearPicture, repaint: () => { if (S.scene) paintScene(); },
  tuneDwell, dwellMs: () => (window.Dwell ? Dwell.config.ms : EC.holds.content),
  freeze, thaw, say: (t) => { hush(); return say(t); },
  mailLine, onMail: (cb) => { mailWatchers.push(cb); },
  pollShelf, flush: () => save(),
};

// ---------- boot ----------
async function boot() {
  // THE DOOR IS UP BEFORE ANY FETCH (the board's 9/3 rule): a hub that will not answer never
  // leaves her on a screen she cannot leave. partner.js finds the bar the moment it runs.
  BAR = window.DoorBar.mountDoorBar(document.body, { onLeave, onPause, onResume });
  try { if (window.Speech) Speech.init("Let's make a picture!"); } catch {}
  try { S.lastMail = JSON.parse(localStorage.getItem("drawing_mail_last") || "null"); } catch {}
  try { S.table = await (await fetch("stickers.json")).json(); } catch { S.table = { stickers: [], zones: {} }; }
  buildTiles();
  SC.renderScene($("newThumb"), { v: 1, backdrop: "meadow", items: [] }, { table: S.table });
  try {
    const st = await (await fetch("/settings")).json();
    if (Number.isFinite(st.dwellMs) && st.dwellMs > 0) { if (window.Dwell) Dwell.setMs(st.dwellMs); BAR.setDwell(st.dwellMs); }
    if (window.Dwell && Number.isFinite(st.settleMs)) Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
    BAR.setPause(st.pauseGoes === "tdsnap");
    if (st.childName) window.ERA_CHILD_NAME = st.childName;
  } catch { /* defaults stand — never block her on settings */ }
  $("btnUndo").addEventListener("click", () => undo());
  $("btnDone").addEventListener("click", () => { done(); });
  $("railNew").addEventListener("click", () => { newPicture(); });
  addEventListener("hashchange", () => { route(); });
  addEventListener("resize", () => { if (BAR) BAR.sizeBar(); tellPark(); });
  addEventListener("pagehide", () => { save({ keepalive: true }); });
  await route();
  S.ready = true;
  try { if (window.Speech) Speech.preload(S.table.stickers.map((s) => s.word).concat(["Undo"])); } catch {}
  log("boot", {});
}
boot();
