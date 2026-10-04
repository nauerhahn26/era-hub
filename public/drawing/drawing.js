/*
 * Drawing — make a picture with your eyes (spec docs/superpowers/specs/2026-09-30-drawing-design.md).
 *
 * Two screens: THE SHELF (/drawing/) — her pictures newest first, a New picture tile — and THE RING
 * (/drawing/#p=<id>) — eight sticker tiles down both sides, her picture in the middle, Undo and
 * Done either side of a black rest tile. One dwell on a sticker speaks its word and the sticker
 * flies into a sensible place by itself ("pick and it lands"). Her picture is never a target by
 * accident (EyeDraw's Midas-touch lesson): in Draw mode, idle, a dwell on it starts a line; in the
 * other modes only placed items' hit boxes are targets (a dwell lifts one), and while she draws or
 * carries, the landing spot is the only target on it (spec 2026-10-02 §3, §6). A grown-up's finger
 * may move a sticker. Trash mode (dad 10/4): the 🗑 tile in the door bar's top-right corner turns it on;
 * then every sticker, person and stroke is a target and a dwell removes it, until the tile again.
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
// v2 (spec 2026-10-02 §1): four modes, fixed forever; each palette fills the same eight seats.
const MODES = ["draw", "people", "stickers", "places"];
const SEATS = [[1, 1], [2, 1], [3, 1], [4, 1], [1, 3], [2, 3], [3, 3], [4, 3]];
const MODE_KEY = "drawing_mode";
const ROUTE_RE = /^#p=([^&]+)(?:&mode=([a-z]+))?$/;

const S = {
  ready: false, table: { stickers: [], zones: {} }, stickers: new Map(), images: {},
  screen: null, id: null, scene: null, history: [], dirty: false, saveTimer: null, finishing: false,
  paused: false, wasPaused: false,
  index: [], shelfPage: 0, shelfPages: 1, shelfIds: [], painted: "", pollTimer: null,
  lastMail: null, said: [], park: null, session: "s" + Date.now(),
  mode: "stickers", people: [], gaze: null, pen: null, carry: null, cool: null, spot: null, swallowUntil: 0,
  leaveTimer: null, restTimer: null, peoplePage: 0, peoplePages: 1,
  trash: false, gone: null,
};
let BAR = null;
let frozen = [];                 // the .dwell targets the grown-up's sheet put to sleep
let sheetUp = false;             // the sheet is open: every newly drawn target is put to sleep too
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
  const t = $("trashTile");
  if (t) t.classList.toggle("away", which !== "ring");      // the shelf has nothing to throw away
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
function onLeave() { settle(); trashOff(); log("door", {}); hush(); save({ keepalive: true }); }
function onPause() { settle(); trashOff(); log("talk", {}); hush(); S.wasPaused = S.paused; S.paused = true; save({ keepalive: true }); }
function onResume() { S.paused = S.wasPaused; log("talk_resume", {}); tellPark(); }

// ---------- the ring's tiles, from stickers.json (seats fixed forever) ----------
const splatSample = () => SC.splatSvg(SC.splatPath(7), SC.SPLAT_COLOURS[0]);   // scene.js's one splat
// Every palette and mode tile: a photo cell — its picture, its word on a plate, her dwell's click.
function photoTile(id, cls, word, pic, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = "cell " + cls + " photo dwell";
  b.setAttribute("aria-label", word);
  pic.classList.add("pic");
  const w = document.createElement("span");
  w.className = "word plate";
  w.textContent = word;
  b.append(pic, w);
  b.addEventListener("click", () => onClick(b));
  return b;
}
function imgPic(src) { const im = document.createElement("img"); im.src = src; im.alt = ""; im.draggable = false; return im; }
function spanPic(child) { const sp = document.createElement("span"); sp.appendChild(child); return sp; }
function stickerTile(st) {
  const b = photoTile("tile-" + st.id, "tile", st.word, st.src ? imgPic(st.src) : splatSample(), (el) => place(st.id, el));
  b.dataset.s = st.id;
  return b;
}
function loadStickers() {
  for (const st of S.table.stickers) {
    S.stickers.set(st.id, st);
    if (st.src) { const im = new Image(); im.src = st.src; S.images[st.id] = im; }   // for the PNG
  }
}

// ---------- the mode row (spec 2026-10-02 §1) ----------
function readMode() { try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : "stickers"; } catch { return "stickers"; } }
function buildModes() {
  const row = $("modeRow");
  for (const m of S.table.modes || []) {
    const b = photoTile("mode-" + m.id, "mode", m.word, imgPic(m.src), () => setMode(m.id));
    b.dataset.mode = m.id;
    b.style.gridColumn = String(m.seat);
    row.appendChild(b);
  }
}
// A mode tile is her dwell. The active one does nothing; a switch speaks the mode word, swaps the
// palette in its fixed seats and is remembered. A live stroke ends / a carried item goes back first.
function setMode(m) {
  if (!MODES.includes(m) || S.screen !== "ring" || !S.scene) return;
  settle();
  if (m === S.mode) return;
  trashOff();
  hush();
  S.mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch {}
  const mo = (S.table.modes || []).find((x) => x.id === m);
  say(m === "people" && !S.people.length ? "No people yet" : (mo ? mo.word : m));
  renderPalette();
  applyTargets();
  suppress();
  log("mode", { mode: m });
}
function blackPal() {
  const d = document.createElement("div");
  d.className = "pal-black";
  d.setAttribute("aria-hidden", "true");
  return d;
}
// The eight seats of the current mode. Every cell is rebuilt (a mode switch is a page change for her:
// setMode suppresses), and each lands in SEATS[k] — positions never move.
function paletteCells() {
  if (S.mode === "stickers") return S.table.stickers.map(stickerTile);
  if (S.mode === "places") return placeCells();
  if (S.mode === "draw") return crayonCells();
  return peopleCells();
}
function renderPalette() {
  const ring = $("sRing");
  for (const el of [...ring.querySelectorAll(":scope > .pal")]) el.remove();
  paletteCells().forEach((el, k) => {
    const [r, c] = SEATS[k];
    el.classList.add("pal");
    el.dataset.seat = r + "," + c;
    el.style.gridRow = String(r);
    el.style.gridColumn = String(c);
    ring.appendChild(el);
  });
  markOn();
  refreeze();
}
// ---------- People (spec 2026-10-02 §4) ----------
// The private library the hub serves from the family's Drive folder. No library (Drive off on this
// device, nothing cut out yet): People shows black seats and says so — the picture never errors.
async function loadPeople() {
  try {
    const j = await (await fetch("/characters/index.json", { cache: "no-store" })).json();
    S.people = Array.isArray(j) ? j : [];
  } catch { S.people = []; }
  S.table = SC.withPeople(S.table, S.people);
  for (const p of S.people) {
    const im = new Image();
    im.src = "/characters/" + encodeURIComponent(p.slug) + ".png";
    S.images["person:" + p.slug] = im;                                // for the PNG (same origin: exportable)
  }
}
function personTile(p) {
  const id = "person:" + p.slug, st = SC.stickerById(S.table, id);
  const b = photoTile("person-" + p.slug, "person", p.word, imgPic(st.src), (el) => place(id, el));
  b.dataset.s = id;
  return b;
}
// The Reader's More rule: past eight people, seven a page and More in the last seat; it loops.
function peopleMoreTile() {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "peopleMore";
  b.className = "cell text dwell";
  b.setAttribute("aria-label", "More people");
  const g = document.createElement("span"); g.className = "glyph"; g.setAttribute("aria-hidden", "true"); g.textContent = "▶";
  const w = document.createElement("span"); w.className = "word"; w.textContent = "More";
  b.append(g, w);
  b.addEventListener("click", () => {
    settle(); hush();
    S.peoplePage = (S.peoplePage + 1) % S.peoplePages;
    renderPalette(); suppress();
    log("people-page", { page: S.peoplePage });
  });
  return b;
}
function peopleCells() {
  const n = S.people.length, seats = SEATS.length;
  S.peoplePages = n > seats ? Math.ceil(n / (seats - 1)) : 1;
  if (S.peoplePage >= S.peoplePages) S.peoplePage = 0;
  const per = S.peoplePages > 1 ? seats - 1 : seats;
  const slice = S.people.slice(S.peoplePage * per, S.peoplePage * per + per);
  const cells = SEATS.map((_, k) => (slice[k] ? personTile(slice[k]) : blackPal()));
  if (S.peoplePages > 1) cells[seats - 1] = peopleMoreTile();
  return cells;
}

// ---------- Places (spec 2026-10-02 §5) ----------
function placeCells() {
  return S.table.backdrops.map((b) => {
    const el = photoTile("place-" + b.id, "place", b.word,
      spanPic(window.DrawingBackdrops.backdropSvg(b.id)), () => pickPlace(b.id));     // backdrops.js's one painter
    el.dataset.place = b.id;
    return el;
  });
}
// A dwell swaps her picture's place and keeps every item where it is (a horse in the sea is hers to
// move). Undo restores the previous place. The current place: its word, nothing else.
function pickPlace(id) {
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  settle();
  const b = S.table.backdrops.find((x) => x.id === id);
  if (!b) return;
  hush();
  say(b.word);
  if ((S.scene.backdrop || "meadow") === id) return;
  push({ t: "backdrop", from: S.scene.backdrop || "meadow" });
  S.scene.backdrop = id;
  paintScene();
  markOn();
  changed();
  log("backdrop", { id });
}
// ---------- Draw (spec 2026-10-02 §3) ----------
function crayonCells() {
  return S.table.crayons.map((cr) => {
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.setProperty("--sw", cr.hex);
    const el = photoTile("crayon-" + cr.id, "crayon", cr.word, spanPic(sw), () => pickCrayon(cr));
    el.dataset.hex = cr.hex;
    return el;
  });
}
// A dwell picks the crayon for her next line, says its word and glows; the picture remembers it.
function pickCrayon(cr) {
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  settle();
  hush();
  say(cr.word);
  if ((S.scene.crayon || "").toLowerCase() === cr.hex.toLowerCase()) return;
  S.scene.crayon = cr.hex;
  markOn();
  changed();
  log("crayon", { id: cr.id });
}

// ---------- her gaze (spec 2026-10-02 §3, §6) ----------
// dwell.js keeps the gaze point to itself (dwell.js:380-384), so the page follows the pointer too.
// ERAgaze moves the OS cursor — a "mouse" pointer. A finger is "touch": its taps land (touch
// parity), its moves never ink (deviation 17).
const LEAVE_EXTRA_MS = 600;
const floorPx = () => Math.ceil(90 * innerWidth / 1920) + 1;     // above invariants' 90 x vw/1920 at every width
const leaveMs = () => ((window.Dwell && Dwell.config.graceMs) || 400) + LEAVE_EXTRA_MS;
const restMs = () => (window.Dwell ? Dwell.config.ms : EC.holds.content);
function toScene(cx, cy) {
  const r = $("scene").getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (cx - r.left) / r.width)), y: Math.min(1, Math.max(0, (cy - r.top) / r.height)),
           inside: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom };
}
function onPointer(e) {
  S.gaze = { cx: e.clientX, cy: e.clientY, type: e.pointerType || "mouse" };
  // a finger is not her gaze: it never ends the cool-down (nor rebuilds the hit boxes mid-drag)
  if (e.pointerType === "touch") return;
  if ((S.cool !== null || S.gone) && !S.carry && S.scene) coolCheck();
  if (e.type !== "pointermove") return;
  if (S.pen) penFollow();
  else if (S.carry) carryFollow();
  if (S.pen || S.carry) restWatch();
}
// THE LANDING SPOT (deviation 1): a fresh element whenever her gaze leaves its square, so dwell.js
// starts a new dwell (dwell.js:259) — only a real REST fills it. Its centre is where the line ends.
function placeSpot(cx, cy) {
  const r = $("scene").getBoundingClientRect(), F = floorPx();
  const x = Math.min(r.width - F / 2, Math.max(F / 2, cx - r.left)), y = Math.min(r.height - F / 2, Math.max(F / 2, cy - r.top));
  removeSpot();
  const el = document.createElement("div");
  el.id = "spot";
  el.className = "spot dwell";
  el.setAttribute("aria-label", "Here");
  Object.assign(el.style, { left: x - F / 2 + "px", top: y - F / 2 + "px", width: F + "px", height: F + "px" });
  const at = { x: x / r.width, y: y / r.height };
  el.addEventListener("click", (e) => { e.stopPropagation(); land(at); });
  // dwell.js's document-capture mouseleave (dwell.js:331-333) hears ANY element's mouseleave as her
  // gaze leaving: a fresh spot under a STILL cursor makes the browser's hover update send #art one,
  // and with no further movement the spot would never fill. Once the hover has settled on the new
  // spot, hand dwell.js her current point again (its own scroll handler does the same).
  el.addEventListener("mouseenter", () => {
    if (S.gaze && S.spot) document.dispatchEvent(new MouseEvent("mousemove", { clientX: S.gaze.cx, clientY: S.gaze.cy }));
  });
  $("scene").appendChild(el);
  S.spot = { cx: r.left + x, cy: r.top + y, F };
  refreeze();
}
function removeSpot() { const s = $("spot"); if (s) s.remove(); S.spot = null; }
function followSpot(cx, cy) {
  const s = S.spot;
  if (!s || Math.abs(cx - s.cx) > s.F / 2 || Math.abs(cy - s.cy) > s.F / 2) placeSpot(cx, cy);
}
function land(at) { if (S.pen) endStroke(at); else if (S.carry) drop(at, "ellie"); }
// The rest tile is inert (no .dwell, ever): resting on it is watched here, for her dwell (deviation 5).
function restWatch() {
  const r = $("restTile").getBoundingClientRect(), g = S.gaze;
  if (!(g.cx >= r.left && g.cx <= r.right && g.cy >= r.top && g.cy <= r.bottom)) { stopRestWatch(); return; }
  if (!S.restTimer) S.restTimer = setTimeout(() => { S.restTimer = null; log("rest", {}); settle(); }, restMs());
}
function stopRestWatch() { clearTimeout(S.restTimer); S.restTimer = null; }

// A dwell (or a tap) on her picture. Draw idle: a stroke starts where she looks. While a stroke is
// live or something is carried, only a FINGER tap lands here — her own landing is the spot.
function onSceneClick() {
  if (Date.now() < S.swallowUntil || !S.gaze || S.screen !== "ring" || !S.scene) return;
  const p = toScene(S.gaze.cx, S.gaze.cy);
  if (!p.inside) return;
  if (S.pen || S.carry) { if (S.gaze.type === "touch") land(p); return; }
  if (S.mode === "draw" && !S.trash) startStroke(p);                  // trash on: the backdrop does nothing
}
function startStroke(p) {
  if (S.paused || S.scene.items.length >= MAX_ITEMS) return;
  const room = SC.penRoom(JSON.stringify(S.scene).length);
  if (room < 2) { log("ink_full", {}); return; }                  // deviation 11: silent, like the 200 cap
  hush();
  S.pen = SC.penStart(p.x, p.y, room);
  S.pen.c = S.scene.crayon || S.table.crayonDefault;
  drawPen();
  applyTargets();
  placeSpot(S.gaze.cx, S.gaze.cy);
  log("stroke_start", {});
}
function drawPen() {
  const box = $("pen");
  if (!S.pen) { box.replaceChildren(); return; }
  const pts = S.pen.pts.length > 1 ? S.pen.pts : S.pen.pts.concat(S.pen.pts);      // a dot until she moves
  box.replaceChildren(SC.strokeSvg(SC.strokePath(pts), S.pen.c, SC.PEN.width));
}
function penFollow() {
  const g = S.gaze, p = toScene(g.cx, g.cy);
  if (!p.inside) {
    removeSpot();
    if (!S.leaveTimer) S.leaveTimer = setTimeout(() => { S.leaveTimer = null; endStroke(null); }, leaveMs());
    return;
  }
  clearTimeout(S.leaveTimer); S.leaveTimer = null;
  if (SC.penMove(S.pen, p.x, p.y)) drawPen();
  if (S.pen.pts.length >= S.pen.room) { endStroke(null); return; }   // 400 points (or the ink budget)
  followSpot(g.cx, g.cy);
}
// One stroke = one item = one Undo. Fewer than two points is not a line: dropped silently.
function endStroke(landing) {
  if (!S.pen) return;
  clearTimeout(S.leaveTimer); S.leaveTimer = null;
  stopRestWatch();
  const pen = S.pen;
  S.pen = null;
  const pts = SC.penEnd(pen, landing);
  drawPen();
  removeSpot();
  if (pts.length >= 2) {
    S.scene.items.push({ s: "stroke", c: pen.c, w: SC.PEN.width, pts, by: "ellie" });
    push({ t: "place" });
    paintScene();
    changed();
    log("stroke", { n: pts.length });
  }
  applyTargets();
}

// The glow: the active mode, the picture's crayon and the picture's place.
function markOn() {
  for (const el of document.querySelectorAll("#modeRow .mode")) el.classList.toggle("on", el.dataset.mode === S.mode);
  for (const el of document.querySelectorAll("#sRing > .crayon")) el.classList.toggle("on", !!S.scene && el.dataset.hex.toLowerCase() === (S.scene.crayon || "").toLowerCase());
  for (const el of document.querySelectorAll("#sRing > .place")) el.classList.toggle("on", !!S.scene && el.dataset.place === (S.scene.backdrop || "meadow"));
}
// In Draw mode, idle, her picture itself is the dwell target (spec §3). Never while a stroke is live
// (the spot is) and never in the other modes.
function applyTargets() {
  const sc = $("scene");
  const want = S.screen === "ring" && !!S.scene && S.mode === "draw" && !S.pen && !S.carry && !S.trash;
  if (!want) { sc.classList.remove("dwell"); sc.removeAttribute("data-dwell-disabled"); frozen = frozen.filter((el) => el !== sc); }
  else if (!sc.hasAttribute("data-dwell-disabled")) sc.classList.add("dwell");
  paintHits();
  refreeze();
}
function settle() { if (S.pen) endStroke(null); if (S.carry) putBack(); }
// A repaint while she carries something (a finger's move of ANOTHER item commits) keeps hers lifted.
function paintScene() {
  SC.renderScene($("art"), S.scene, { table: S.table });
  if (S.carry) { const a = document.querySelector('#art [data-i="' + S.carry.i + '"]'); if (a) a.classList.add("carried"); }
  paintHits();
}

// ---------- gaze-move (spec 2026-10-02 §6) ----------
// In Stickers, People and Places every placed sticker or person has a hit box; Draw mode has none
// (her picture is the target there), ink never has one, and while she carries something only the
// spot is a target. Until her gaze has left the item she just dropped there are no hit boxes at
// all (deviation 13): dropped ON another item, that one's box would lie under her resting gaze and
// lift it straight back (review 10/3 #3). Trash mode (dad 10/4): the same boxes in EVERY mode, plus one
// per stroke (its bounds grown to F, scene.js strokeBounds) — a dwell removes, never lifts — and the
// same guard after a removal (S.gone): what lay under the item she just removed waits for her gaze to leave.
function paintHits() {
  const box = $("hits");
  const show = S.screen === "ring" && !!S.scene && (S.trash || S.mode !== "draw") && !S.carry && !S.pen
    && S.cool === null && !S.gone;
  if (!show) { box.replaceChildren(); return; }
  const r = $("scene").getBoundingClientRect();
  if (!r.width) return;
  const F = floorPx(), kids = [];
  for (const op of SC.sceneOps(S.scene, S.table)) {
    const ink = op.kind === "stroke";
    if (ink && !S.trash) continue;
    const b = SC.hitBox(ink ? SC.strokeBounds(S.scene.items[op.i]) : op, r.width, r.height, F);
    const el = document.createElement("div");
    el.className = "hit dwell";
    el.dataset.hit = String(op.i);
    el.setAttribute("aria-label", ink ? "Line" : SC.itemWord(S.table, op.s) || "Picture");
    Object.assign(el.style, { left: b.left + "px", top: b.top + "px", width: b.width + "px", height: b.height + "px" });
    el.addEventListener("click", (e) => { e.stopPropagation(); if (S.trash) removeItem(op.i); else lift(op.i); });
    kids.push(el);                                   // item order: the latest is on top and wins
  }
  box.replaceChildren(...kids);
  refreeze();
}
// LIFT: her full dwell on an item. It says its word, grows a little, and follows her gaze.
function lift(i) {
  if (Date.now() < S.swallowUntil) return;
  if (S.screen !== "ring" || !S.scene || S.paused || S.mode === "draw" || S.pen || S.carry || S.trash) return;
  const it = S.scene.items[i];
  if (!it || it.s === "stroke") return;
  hush();
  say(SC.itemWord(S.table, it.s));
  S.carry = { i, sx: it.x, sy: it.y, x: it.x, y: it.y };
  const art = document.querySelector('#art [data-i="' + i + '"]');
  if (art) art.classList.add("carried");
  applyTargets();
  const g = S.gaze, r = $("scene").getBoundingClientRect();
  if (g && toScene(g.cx, g.cy).inside) placeSpot(g.cx, g.cy);
  else placeSpot(r.left + it.x * r.width, r.top + it.y * r.height);
  log("lift", { s: it.s });
}
// CARRY: the centre tracks her gaze (smoothed like the pen), clamped so it never leaves the picture.
// Nothing is stored until it lands. No timer — she can carry it as long as she likes.
function carryFollow() {
  const c = S.carry, it = S.scene.items[c.i], g = S.gaze, p = toScene(g.cx, g.cy);
  c.sx += SC.PEN.alpha * (p.x - c.sx);
  c.sy += SC.PEN.alpha * (p.y - c.sy);
  const at = SC.clampItem({ x: c.sx, y: c.sy, w: it.w });
  c.x = at.x; c.y = at.y;
  const art = document.querySelector('#art [data-i="' + c.i + '"]');
  if (art) { art.style.left = (at.x - it.w / SC.ASPECT / 2) * 100 + "%"; art.style.top = (at.y - it.w / 2) * 100 + "%"; }
  if (p.inside) followSpot(g.cx, g.cy); else removeSpot();
}
function drop(at, by) {
  const c = S.carry;
  if (!c) return;
  stopRestWatch(); removeSpot();
  S.carry = null;
  const it = S.scene.items[c.i], to = SC.clampItem({ x: at.x, y: at.y, w: it.w });
  push({ t: "move", i: c.i, from: { x: it.x, y: it.y, by: it.by } });
  it.x = to.x; it.y = to.y; it.by = by;
  S.cool = c.i;
  paintScene(); applyTargets(); changed();
  log("drop", { s: it.s, by });
}
function putBack() {
  if (!S.carry) return;
  stopRestWatch(); removeSpot();
  S.carry = null;
  paintScene(); applyTargets();
  log("put_back", {});
}
// partner.js: a finger took the carried item (touch wins). The art stays where it is; the drag commits.
function releaseCarry() {
  const c = S.carry;
  if (!c) return null;
  stopRestWatch(); removeSpot();
  S.carry = null;
  return { i: c.i, x: c.x, y: c.y };
}
// Per gaze sample: only the cooling item's own box (never every stroke's outline) — the item she just
// dropped, or the box of the one she just removed.
function coolCheck() {
  const it = S.cool !== null ? S.scene.items[S.cool] : null, r = $("scene").getBoundingClientRect();
  const op = S.cool === null ? S.gone : it ? SC.sceneOps({ items: [it] }, S.table)[0] : null;
  const cooled = () => { S.cool = null; S.gone = null; paintHits(); };
  if (!op || !r.width) { cooled(); return; }
  const b = SC.hitBox(op, r.width, r.height, floorPx()), x = S.gaze.cx - r.left, y = S.gaze.cy - r.top;
  if (x < b.left || x > b.left + b.width || y < b.top || y > b.top + b.height) cooled();
}
function swallowClicks(ms) { S.swallowUntil = Date.now() + (ms || 400); }

// ---------- trash mode (dad 10/3-10/4) ----------
// A 🗑 Trash tile in the TOP-RIGHT CORNER of the door bar; the grown-ups' tab sits left of it. This
// AMENDS the bar law "🚪 and 💬 are the bar's only dwell targets" on dad's word (10/4): the 🗑 is the
// bar's third dwell target, and it holds HER dwell (CONTRACT.holds.content — no data-dwell-ms), because
// it never takes her off the screen. A photo tile (glyph >= 4/5 of it, plate "Trash"), the bar's inner
// height like the doors, at least twice as wide as tall (the bar's audit floor). Appended at the bar's
// end once stickers.json lands — after partner.js's tab, which therefore sits left of it.
function buildTrash() {
  const b = (S.table.bar || []).find((x) => x.id === "trash");
  if (!b || !BAR || $("trashTile")) return;
  const el = photoTile("trashTile", "trash", b.word, imgPic(b.src), () => toggleTrash());
  el.classList.toggle("away", S.screen !== "ring");
  BAR.bar.appendChild(el);
}
// One dwell turns it on (teal glow, "Trash on") — a live stroke ends and a carried item goes back
// first; the next turns it off ("Trash off"). Per session: never remembered.
function toggleTrash() {
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  if (!S.trash) settle();
  hush();
  say(S.trash ? "Trash off" : "Trash on");
  setTrash(!S.trash);
  suppress();                       // the picture's targets just changed under her gaze: the page-settle guard
  log("trash", { on: S.trash });
}
function setTrash(on) {
  S.trash = on;
  S.gone = null;
  const t = $("trashTile");
  if (t) t.classList.toggle("on", on);
  applyTargets();
}
// Off by itself, silently, whenever she leaves what she was trashing: Done, 🚪, 💬, a mode switch,
// opening a picture or the shelf, the sheet opening, pagehide. (Undo, a palette tile: trash stays on.)
function trashOff() { if (S.trash) setTrash(false); }
// A dwell on an item while trash is on: it goes ("Bye, horse"; a person by name; ink is "line"), as one
// history event Undo brings back in place. She keeps going, item after item.
function byeWord(it) {
  if (it.s === "stroke") return "line";
  const st = SC.stickerById(S.table, it.s);
  return st ? (st.person ? st.word : st.word.toLowerCase()) : "";
}
function removeItem(i) {
  if (Date.now() < S.swallowUntil) return;                 // a finger drag's release is not a tap
  if (S.screen !== "ring" || !S.scene || S.paused || !S.trash || S.pen || S.carry) return;
  const it = S.scene.items[i];
  if (!it) return;
  const op = it.s === "stroke" ? SC.strokeBounds(it) : SC.sceneOps({ items: [it] }, S.table)[0];
  hush();
  say("Bye, " + byeWord(it));
  S.scene.items.splice(i, 1);
  push({ t: "remove", i, item: it });
  S.cool = null;
  S.gone = op || null;
  paintScene();
  changed();
  log("remove", { s: it.s, n: S.scene.items.length });
}

// ---------- routing ----------
async function route() {
  const m = ROUTE_RE.exec(location.hash || "");
  let id = null;
  try { id = m ? decodeURIComponent(m[1]) : null; } catch {}
  // test-only (spec 2026-10-02 §9): invariants and the suites open a mode directly; a device never does
  if (m && m[2] && window.__testHooks && MODES.includes(m[2])) S.mode = m[2];
  if (id && ID_RE.test(id)) await openRing(id); else await openShelf();
}
function go(id) {
  if (id) { location.hash = "p=" + encodeURIComponent(id); return; }     // hashchange -> route()
  history.replaceState(null, "", location.pathname + location.search);
  route();
}
// Unsaved work here wins (rule 4) — but only when it is newer than the hub's copy: another device or
// another tab may have changed the picture since (review 9/30 #8). No hub copy: it is all there is.
async function loadScene(id) {
  const local = readStash(id);
  let hub = null;
  try {
    const r = await fetch("/drawings/" + encodeURIComponent(id) + "/scene.json", { cache: "no-store" });
    if (r.ok) { const sc = await r.json(); if (sc && Array.isArray(sc.items)) hub = sc; }
  } catch {}
  if (local && local.dirty && (!hub || local.at > (Date.parse(hub.updated) || 0))) { S.dirty = true; return local.scene; }
  S.dirty = false;
  if (hub) return hub;
  if (local) return local.scene;
  return { v: 1, id, backdrop: "meadow", items: [] };
}
async function openRing(id) {
  settle();                               // whatever her gaze was doing on the previous picture ends there
  trashOff();
  if (S.screen === "ring" && S.id && S.id !== id && S.dirty) await save();
  stopPoll();
  S.id = id;
  S.history = [];
  S.cool = null; S.gone = null;
  S.scene = await loadScene(id);
  S.scene.backdrop = S.scene.backdrop || "meadow";
  S.scene.crayon = S.scene.crayon || S.table.crayonDefault || "#0F7C8A";
  show("ring");
  renderPalette();
  paintScene();
  applyTargets();
  suppress();
  tellPark();
  if (S.dirty) scheduleSave();
  log("open", { id, items: S.scene.items.length });
}

// ---------- placing, undo, autosave (spec §2.1, §2.2, §4) — T8 ----------
function push(ev) { S.history.push(ev); if (S.history.length > HISTORY_MAX) S.history.shift(); }
function place(id, tile) {
  settle();
  if (S.screen !== "ring" || !S.scene || S.paused) return;
  const st = SC.stickerById(S.table, id);
  if (!st) return;
  hush();
  say(st.word);
  if (S.scene.items.length >= MAX_ITEMS) { log("place_full", { s: id }); return; }   // the hub's cap
  const spot = SC.landing(id, S.scene.items, S.table, Math.random, SC.horizonOf(S.scene.backdrop));
  if (!spot) return;
  const item = { s: id, x: spot.x, y: spot.y, w: spot.w, by: "ellie" };
  if (id === "splat") { item.c = spot.c; item.seed = spot.seed; }
  S.scene.items.push(item);
  push({ t: "place" });
  paintScene();
  flyIn(tile, S.scene.items.length - 1);
  log("place", { s: id, n: S.scene.items.length });
  changed();
}
// The sticker appears at its tile and flies into its slot (~450 ms, ease-out); reduced motion:
// it simply appears. A fixed-position copy flies; the real one waits hidden, so the scene's clip
// never swallows the start of the flight.
function flyIn(tile, index) {
  try {
    if (!tile || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = document.querySelector('#scene [data-i="' + index + '"]');
    const from = tile.querySelector(".pic");
    if (!target || !from || !target.animate) return;
    const a = from.getBoundingClientRect(), b = target.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const fly = target.cloneNode(true);
    fly.removeAttribute("data-i");
    fly.setAttribute("class", "flyer");
    Object.assign(fly.style, { left: b.left + "px", top: b.top + "px", width: b.width + "px", height: b.height + "px" });
    document.body.appendChild(fly);
    target.style.visibility = "hidden";
    const s = Math.min(a.width / b.width, a.height / b.height);
    fly.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${s})` }, { transform: "none" }],
                { duration: 450, easing: "ease-out" })
      .finished.catch(() => {}).then(() => { fly.remove(); target.style.visibility = ""; });
  } catch {}
}
function undo() {
  settle();
  if (S.screen !== "ring" || !S.scene || !S.history.length) return;   // nothing, and silence (§2.2)
  hush();
  say("Undo");
  const ev = S.history.pop();
  S.cool = null; S.gone = null;       // an index into the items that just changed
  if (ev.t === "place") S.scene.items.pop();
  else if (ev.t === "remove") S.scene.items.splice(Math.min(ev.i, S.scene.items.length), 0, ev.item);   // back in place
  else if (ev.t === "move" && S.scene.items[ev.i]) Object.assign(S.scene.items[ev.i], ev.from);
  else if (ev.t === "backdrop") { S.scene.backdrop = ev.from; markOn(); }
  paintScene();
  log("undo", { t: ev.t });
  changed();
}
function changed() { S.dirty = true; stash(); scheduleSave(); }
function scheduleSave() { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(() => { save(); }, SAVE_MS); }
// Last write wins. A failed save logs one line and keeps the picture (memory + localStorage,
// dirty); the next change — or the next open of this picture — tries again. Once the hub has the
// body the local copy goes: localStorage is one quota shared by every hub app (review 10/3 #2).
// keepalive only under Chromium's ~64 KB keepalive cap — a heavier body ("Failed to fetch" with
// keepalive) goes as a normal fetch, with the dirty local copy as its net (review 10/3 #1).
const KEEPALIVE_MAX = 65000;
async function save(opts = {}) {
  clearTimeout(S.saveTimer);
  S.saveTimer = null;
  if (!S.dirty || !S.id || !S.scene) return true;
  const id = S.id, body = JSON.stringify(S.scene);
  try {
    const r = await fetch("/drawings/" + encodeURIComponent(id) + "/scene.json", { method: "PUT",
      headers: { "Content-Type": "application/json" }, body, keepalive: !!opts.keepalive && body.length < KEEPALIVE_MAX });
    if (!r.ok) throw new Error("PUT " + r.status);
    if (S.id === id && JSON.stringify(S.scene) === body) {
      S.dirty = false;
      try { localStorage.removeItem(stashKey(id)); } catch {}
    }
    return true;
  } catch (e) {
    log("save_failed", { id, why: String(e && e.message) });
    return false;
  }
}

// ---------- the grown-up's hands (partner.js calls these; spec §2.4) — T9 ----------
function itemAt(i) { const it = S.scene && S.scene.items[i]; return it ? { ...it } : null; }
function moveItem(i, x, y) {
  const it = S.scene && S.scene.items[i];
  if (!it) return;
  if (S.carry && S.carry.i === i) releaseCarry();
  const c = SC.clampItem({ x, y, w: it.w });
  push({ t: "move", i, from: { x: it.x, y: it.y, by: it.by } });
  it.x = c.x; it.y = c.y; it.by = "partner";
  paintScene();
  log("partner", { action: "move", s: it.s });
  changed();
}
async function clearPicture() {
  if (S.screen !== "ring" || !S.scene) return;
  S.scene.items = [];
  S.history = [];                     // not undoable: it had its own two-stage confirm
  S.cool = null; S.gone = null;
  paintScene();
  log("partner", { action: "clear" });
  changed();
  hush();
  await say("All clear! A fresh picture.");
}
function tuneDwell(d) {
  const cur = window.Dwell ? Dwell.config.ms : EC.holds.content;
  const ms = Math.max(EC.holds.floor, Math.min(EC.holds.tuneMax, cur + d));
  if (window.Dwell) Dwell.setMs(ms);
  if (BAR) BAR.setDwell(ms);          // the doors stay 2 x the dwell she is actually on
  log("partner", { action: "dwell", ms });
  return ms;
}
// A full-screen sheet hides nothing from dwell.js (board-partner.js:53-71): every target but the
// two doors loses .dwell and gains data-dwell-disabled while it is up.
function freeze() {
  settle();
  trashOff();
  sheetUp = true;
  const live = [...document.querySelectorAll(".dwell")].filter((el) => !BAR_DOORS.has(el.id));
  for (const el of live) { el.classList.remove("dwell"); el.setAttribute("data-dwell-disabled", ""); }
  frozen = frozen.concat(live);
}
function thaw() {
  sheetUp = false;
  for (const el of frozen) { el.classList.add("dwell"); el.removeAttribute("data-dwell-disabled"); }
  frozen = [];
  suppress(600);
}
// Every render of targets while the sheet is up sweeps again: the freeze is not a one-time sweep
// (Done -> the shelf under an open sheet drew live cells beneath it; review 9/30 #4).
function refreeze() { if (sheetUp) freeze(); }
function mailLine() {
  const m = S.lastMail;
  if (!m) return "No picture finished yet";
  if (m.saved === false) return "Not saved — the hub did not answer";
  return MAIL_LINES[m.mail] || "Saved";
}
function setMail(res) {
  S.lastMail = res;
  try { localStorage.setItem("drawing_mail_last", JSON.stringify(res)); } catch {}
  for (const cb of mailWatchers) { try { cb(mailLine()); } catch {} }
}

// ---------- the shelf (spec §3) — T10 ----------
async function refreshIndex() {
  try {
    const j = await (await fetch("/drawings/index.json", { cache: "no-store" })).json();
    S.index = Array.isArray(j) ? j : [];
  } catch { S.index = []; }
}
const shelfSig = () => JSON.stringify(S.index.map((p) => [p.id, p.updated, p.items]));
function plate(when) {
  const d = new Date(when);
  if (!Number.isFinite(d.getTime())) return "";
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
}
function blackCell() {
  const d = document.createElement("div");
  d.className = "shelf-black";
  d.setAttribute("aria-hidden", "true");
  return d;
}
function picCell(p) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cell shelf-pic photo dwell";
  b.dataset.id = p.id;
  const when = plate(p.created);
  b.setAttribute("aria-label", "Picture " + when);
  const box = document.createElement("span");
  box.className = "thumbBox";
  const th = document.createElement("span");
  th.className = "scene thumb";
  SC.renderScene(th, p.scene, { table: S.table });      // the same renderer as the ring
  box.appendChild(th);
  const pl = document.createElement("span");
  pl.className = "plate";
  pl.textContent = when;
  b.append(box, pl);
  b.addEventListener("click", () => { hush(); go(p.id); });
  return b;
}
function moreCell(pages) {
  const b = document.createElement("button");
  b.type = "button";
  b.id = "shelfMore";
  b.className = "cell text dwell";
  b.setAttribute("aria-label", "More pictures");
  const w = document.createElement("span");
  w.className = "word";
  w.textContent = "More ▶";
  b.appendChild(w);
  b.addEventListener("click", () => turnShelf((S.shelfPage + 1) % pages));   // the last page loops
  return b;
}
function renderShelf() {
  const pages = Math.max(1, Math.ceil(S.index.length / PER_PAGE));
  if (S.shelfPage >= pages) S.shelfPage = pages - 1;
  if (S.shelfPage < 0) S.shelfPage = 0;
  S.shelfPages = pages;
  const slice = S.index.slice(S.shelfPage * PER_PAGE, (S.shelfPage + 1) * PER_PAGE);
  const at = new Map();
  BOOK_CELLS.forEach(([r, c], i) => at.set(r + "," + c, slice[i] ? picCell(slice[i]) : blackCell()));
  at.set("2,2", blackCell());
  at.set("2,3", blackCell());
  at.set("3,1", pages > 1 ? moreCell(pages) : blackCell());
  const kids = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) {
    const el = at.get(r + "," + c);
    el.dataset.cell = r + "," + c;
    el.style.gridRow = String(r);
    el.style.gridColumn = String(c);
    kids.push(el);
  }
  $("shelfGrid").replaceChildren(...kids);
  S.shelfIds = slice.map((p) => p.id);
  S.painted = shelfSig();
  refreeze();
}
function turnShelf(page) {
  hush();
  S.shelfPage = page;
  renderShelf();
  suppress();
  log("shelf-page", { page });
}
async function openShelf() {
  settle();
  trashOff();
  const fresh = S.screen !== "shelf";
  // A sticker placed in the last moments (her gaze drifting from Done to Splat mid-celebration) goes
  // to the hub before the ring forgets it; if the hub does not take it, localStorage still holds it
  // dirty and the next open of this picture retries (review 9/30 #3).
  if (S.dirty) await save();
  S.id = null; S.scene = null; S.history = []; S.dirty = false;
  await refreshIndex();
  if (fresh) S.shelfPage = 0;                           // every return lands on page 1: newest first
  show("shelf");
  applyTargets();                                       // the hidden ring keeps no live targets
  renderShelf();
  suppress();
  tellPark();
  startPoll();
}
function startPoll() { stopPoll(); S.pollTimer = setInterval(pollShelf, POLL_MS); }
function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
// Repaint ONLY when something changed (a rebuild throws away an in-flight dwell — reader.js's
// lesson), and never under a grown-up's open sheet.
async function pollShelf() {
  if (S.screen !== "shelf" || frozen.length) return;
  await refreshIndex();
  if (shelfSig() === S.painted) return;
  renderShelf();
  suppress();
  tellPark();
}
async function newPicture() {
  hush();
  try {
    const r = await fetch("/drawings", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    if (r.ok && j && ID_RE.test(j.id)) { log("new", { id: j.id }); go(j.id); return; }
  } catch {}
  log("new_failed", {});             // the hub did not answer: she stays on her shelf, nothing is said
}

// ---------- Done (spec §2.3) — T11 ----------
async function exportPng(scene) {
  await Promise.all(Object.values(S.images).map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
  const c = document.createElement("canvas");
  c.width = 1600; c.height = 900;
  SC.renderScene(c.getContext("2d"), scene, { table: S.table, images: S.images });
  return new Promise((res) => c.toBlob(res, "image/png"));
}
async function done() {
  if (S.screen !== "ring" || !S.scene || S.finishing) return;
  settle();
  trashOff();
  S.finishing = true;
  hush();
  const id = S.id, scene = JSON.parse(JSON.stringify(S.scene));
  const saved = save();                                  // her last sticker first
  // The PNG and the mail run alongside the celebration (deviation 9); the answer goes to the
  // partner line only — never spoken (the Pencil's truth rule). Only once her scene is on the hub:
  // the hub judges the mail from ITS scene, so a PNG after a failed save would be mailed (or called
  // "already sent") against a picture she has since changed (review 9/30 #9). She is celebrated anyway.
  const posted = saved.then((ok) => (!ok ? { saved: false, mail: "failed", reason: "scene not saved" }
    : exportPng(scene)
      .then((blob) => fetch("/drawings/" + encodeURIComponent(id) + "/done",
        { method: "POST", headers: { "Content-Type": "image/png" }, body: blob }))
      .then((r) => (r.ok ? r.json() : { saved: false, mail: "failed", reason: "hub " + r.status }))))
    .catch(() => ({ saved: false, mail: "failed", reason: "no answer" }))
    .then((res) => { setMail({ id, ...res }); log("done", { id, mail: res.mail }); return res; });
  confetti(24);
  try {
    await say(SC.describe(scene.items, S.table));        // what she DID
    await saved;
  } finally { S.finishing = false; }                     // Done can never stay latched
  go(null);                                               // the shelf: this picture first once the hub has its change
  return posted;
}

// ---------- the page's own surface: tests, partner.js, field debugging ----------
window.Drawing = {
  state: () => ({
    ready: S.ready, screen: S.screen, id: S.id,
    items: S.scene ? S.scene.items.map((i) => ({ ...i })) : [],
    history: S.history.length, events: S.history.map((e) => e.t), dirty: S.dirty, lastMail: S.lastMail,
    shelfPage: S.shelfPage, shelfPages: S.shelfPages, shelfIds: S.shelfIds.slice(),
    said: S.said.slice(), park: S.park, paused: S.paused,
    crayon: S.scene ? S.scene.crayon || null : null, pen: S.pen ? { n: S.pen.pts.length, c: S.pen.c } : null,
    people: S.people.map((p) => p.slug), peoplePage: S.peoplePage, peoplePages: S.peoplePages,
    carrying: S.carry ? S.carry.i : null, cool: S.cool,
    mode: S.mode, backdrop: S.scene ? S.scene.backdrop || "meadow" : null, trash: S.trash, gone: !!S.gone,
  }),
  setMode, settle, releaseCarry, swallowClicks,
  itemAt, moveItem, clamp: (o) => SC.clampItem(o), clearPicture, repaint: () => { if (S.scene) paintScene(); },
  tuneDwell, dwellMs: () => (window.Dwell ? Dwell.config.ms : EC.holds.content),
  freeze, thaw, say: (t) => { hush(); return say(t); },
  mailLine, onMail: (cb) => { mailWatchers.push(cb); },
  pollShelf, flush: () => save(),
  exportPng: () => exportPng(S.scene),
};
// Test-only (spec 2026-10-02 §9): the contract audit paints a seeded scene on the gate hub's
// never-saved ring WITHOUT a PUT (no changed(), so nothing reaches the gate's data dir) and lifts one.
if (window.__testHooks) Object.assign(window.Drawing, {
  __show(scene) {
    S.scene = { v: 1, backdrop: "meadow", ...scene, items: (scene.items || []).map((i) => ({ ...i })) };
    S.scene.crayon = S.scene.crayon || S.table.crayonDefault;
    renderPalette(); paintScene(); applyTargets();
  },
  __lift: (i) => lift(i),
});

// ---------- boot ----------
async function boot() {
  // THE DOOR IS UP BEFORE ANY FETCH (the board's 9/3 rule): a hub that will not answer never
  // leaves her on a screen she cannot leave. partner.js finds the bar the moment it runs.
  BAR = window.DoorBar.mountDoorBar(document.body, { onLeave, onPause, onResume });
  try { if (window.Speech) Speech.init("Let's make a picture!"); } catch {}
  try { S.lastMail = JSON.parse(localStorage.getItem("drawing_mail_last") || "null"); } catch {}
  try { S.table = await (await fetch("stickers.json")).json(); } catch { S.table = { stickers: [], zones: {} }; }
  S.mode = readMode(); loadStickers(); await loadPeople(); buildModes(); buildTrash();
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
  addEventListener("resize", () => { if (BAR) BAR.sizeBar(); tellPark(); if (S.spot && S.gaze) placeSpot(S.gaze.cx, S.gaze.cy); paintHits(); });
  addEventListener("pagehide", () => { settle(); trashOff(); save({ keepalive: true }); });
  document.addEventListener("pointermove", onPointer, true);
  document.addEventListener("pointerdown", onPointer, true);
  $("scene").addEventListener("click", onSceneClick);
  await route();
  S.ready = true;
  try { if (window.Speech) Speech.preload(S.table.stickers.map((s) => s.word)
    .concat((S.table.modes || []).map((m) => m.word), (S.table.backdrops || []).map((b) => b.word),
      (S.table.crayons || []).map((c) => c.word), S.people.map((p) => p.word),
      ["Undo", "No people yet", "Trash on", "Trash off", "Bye, line"],
      S.table.stickers.map((s) => "Bye, " + s.word.toLowerCase()), S.people.map((p) => "Bye, " + p.word))); } catch {}
  log("boot", {});
}
boot();
