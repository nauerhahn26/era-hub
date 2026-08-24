// Book Reader v1 — manifest-driven reading room (era-book-reader M3, Piece 3).
//
// Books are immutable local packages the hub serves at /books/<slug>/ (index at
// /books/index.json). Narration is the package's RECORDED audio; words highlight
// in sync with it (manifest `words` timings; interpolation when a page has audio
// but no timings). This app never calls speechSynthesis.
//
// Rules of the room: she turns pages by gaze or touch; when narration ends the
// page turns for her (auto-advance, via the page's optional video first); a
// silent/textless page shows the advance arrow IMMEDIATELY so she is never
// stuck. Every page render suppresses dwell for the settle window (D51) — a
// fresh page never inherits her gaze.
//
// Progress: every page render appends a book-progress event to the pool via
// POST /log (app-log kind) and mirrors it to localStorage for local resume.
// Resume-from-pool (cross-device read-back) is a follow-up; with nothing
// available client-side a book opens at page 1. Missing index/manifest/pool
// degrades to an empty shelf / page 1 — never a dead app (8/19 law).
"use strict";

const S = {
  session: "r" + Date.now(),
  index: [],          // /books/index.json rows {slug,title,cover,pages,hasVideo}
  shelfPage: 0,
  manifest: null,     // the open book's manifest
  slug: null,
  page: 0,
  pageText: [],       // current page's word tokens (spans in #pageText, same order)
  words: null,        // resolved [{word,start,end}] — manifest's or interpolated
  activeIdx: -1,      // word-sync cursor: NEVER decreases within one playback
  advTimer: null,     // pending auto-advance beat after narration ends
  videoDone: null,    // finish/skip continuation while the page video shows
  renderGen: 0,       // bumps per render — stale async media outcomes are ignored
};

const $ = (id) => document.getElementById(id);
const narration = $("narration");
const video = $("pageVideo");

const PER_SHELF = 8;  // covers per shelf screen: 8 + More + door stays under 12 targets

function log(event, detail) {
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), session: S.session, app: "reader", event, ...detail }) }).catch(() => {});
}
function suppress() { if (window.Dwell && Dwell.suppress) Dwell.suppress(); }

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("show"));
  $(id).classList.add("show");
  $("advanceArrow").classList.remove("show");   // only renderPage may raise it
  suppress();                                    // new surface: settle before gaze arms
}

// ---------- progress (pool event + local mirror for resume) ----------
const posKey = (slug) => "era-reader:pos:" + slug;
function savePos(slug, page) {
  try { localStorage.setItem(posKey(slug), String(page)); } catch {}
  log("book-progress", { slug, page });          // the durable record (merged pool)
}
function loadPos(slug, maxPage) {
  try {
    const n = parseInt(localStorage.getItem(posKey(slug)), 10);
    if (isFinite(n) && n >= 0 && n <= maxPage) return n;
  } catch {}
  return 0;   // nothing available client-side -> page 1 (resume-from-pool = follow-up)
}
function clearPos(slug) { try { localStorage.removeItem(posKey(slug)); } catch {} }

// ---------- shelf ----------
function renderShelf() {
  const shelf = $("shelf");
  shelf.innerHTML = "";
  $("shelfEmpty").style.display = S.index.length ? "none" : "block";
  const start = S.shelfPage * PER_SHELF;
  for (const b of S.index.slice(start, start + PER_SHELF)) {
    const d = document.createElement("div");
    d.className = "book dwell";
    d.setAttribute("data-dwell-say", b.title);
    const img = document.createElement("img");
    img.className = "cover"; img.alt = ""; img.src = b.cover;
    const name = document.createElement("div");
    name.className = "name"; name.textContent = b.title;
    d.appendChild(img); d.appendChild(name);
    d.addEventListener("click", () => openBook(b.slug));
    shelf.appendChild(d);
  }
  // black rest cell — plain and inert; a safe place to park her gaze
  const rest = document.createElement("div");
  rest.className = "restCell";
  rest.setAttribute("aria-hidden", "true");
  shelf.appendChild(rest);
  if (S.index.length > PER_SHELF) {
    const more = document.createElement("div");
    more.className = "book more dwell";
    more.setAttribute("data-dwell-say", "more books");
    more.textContent = "more ▶";
    more.addEventListener("click", () => {
      S.shelfPage = (S.shelfPage + 1) % Math.ceil(S.index.length / PER_SHELF);
      renderShelf();
      suppress();
    });
    shelf.appendChild(more);
  }
}

async function openBook(slug) {
  stopMedia();
  let m;
  try { m = await (await fetch("/books/" + slug + "/manifest.json")).json(); }
  catch { log("book-open-failed", { slug }); return; }   // stay on the shelf, never break
  if (!m || !Array.isArray(m.pages) || !m.pages.length) { log("book-open-failed", { slug }); return; }
  S.manifest = m; S.slug = slug;
  S.page = loadPos(slug, m.pages.length - 1);
  log("book-open", { slug, page: S.page });
  show("sRead");
  renderPage();
}

// ---------- reading ----------
function stopMedia() {
  if (S.advTimer) { clearTimeout(S.advTimer); S.advTimer = null; }
  try { narration.pause(); } catch {}
  closeVideo();
}

function renderPage() {
  stopMedia();
  const m = S.manifest, p = m.pages[S.page];
  const base = "/books/" + S.slug + "/";
  $("bookTitle").textContent = m.title;
  $("pageNum").textContent = (S.page + 1) + " / " + m.pages.length;

  const img = $("pageImg");
  if (p.image) { img.src = base + p.image; img.style.display = ""; }
  else { img.removeAttribute("src"); img.style.display = "none"; }

  const holder = $("pageText");
  holder.innerHTML = "";
  S.pageText = (p.text || "").split(/\s+/).filter(Boolean);
  for (const w of S.pageText) {
    const s = document.createElement("span");
    s.className = "w";
    s.textContent = w;
    holder.appendChild(s);
  }
  S.activeIdx = -1;
  S.words = (Array.isArray(p.words) && p.words.length)
    ? p.words.slice().sort((a, b) => a.start - b.start)
    : null;                                    // may be interpolated on loadedmetadata

  $("btnPrev").style.visibility = S.page === 0 ? "hidden" : "visible";
  $("btnRepeat").style.visibility = p.audio ? "visible" : "hidden";
  $("btnNext").textContent = S.page === m.pages.length - 1 ? "The End ▶" : "next ▶";

  const arrow = $("advanceArrow");
  const gen = ++S.renderGen;      // a fast page turn aborts the old play(); its
                                  // rejection must not raise the arrow HERE
  if (p.audio) {
    arrow.classList.remove("show");
    narration.src = base + p.audio;
    narration.play().catch(() => {
      if (gen === S.renderGen) arrow.classList.add("show");  // audio blocked: she can still advance
    });
  } else {
    narration.removeAttribute("src");
    arrow.classList.add("show");               // textless/silent page: the way forward shows NOW
  }

  savePos(S.slug, S.page);
  suppress();                                  // page-settle: fresh page never inherits her gaze
}

// interpolation fallback: audio but no word timings -> spread the words evenly
narration.addEventListener("loadedmetadata", () => {
  if (S.words || !S.pageText.length) return;
  const dur = narration.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const n = S.pageText.length;
  S.words = S.pageText.map((w, i) => ({ word: w, start: i * dur / n, end: (i + 1) * dur / n }));
});

// word sync: binary search for the last word started by t; MONOTONIC —
// the active index never decreases within a playback (repeat/page reset it).
function syncWords(t) {
  const words = S.words;
  if (!words || !words.length) return;
  let lo = 0, hi = words.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit <= S.activeIdx) return;
  S.activeIdx = hit;
  const spans = $("pageText").children;
  for (let i = 0; i < spans.length; i++) {
    spans[i].classList.toggle("hl", i === hit);
    spans[i].classList.toggle("read", i < hit);
  }
  if (window.__testHooks)
    (window.__hlSeq = window.__hlSeq || []).push({ page: S.page, idx: hit });
}
narration.addEventListener("timeupdate", () => syncWords(narration.currentTime));

narration.addEventListener("ended", () => {
  const p = S.manifest && S.manifest.pages[S.page];
  if (!p) return;
  syncWords(Infinity);                         // land on the final word
  if (p.video) return playVideo(p);
  S.advTimer = setTimeout(advance, 600);       // a beat to finish looking, then the page turns
});

function advance() {
  if (S.advTimer) { clearTimeout(S.advTimer); S.advTimer = null; }
  if (!S.manifest) return;
  if (S.page >= S.manifest.pages.length - 1) return finishBook();
  S.page++;
  renderPage();
}
function prev() {
  if (!S.manifest || S.page === 0) return;
  S.page--;
  renderPage();
}
function repeat() {
  const p = S.manifest && S.manifest.pages[S.page];
  if (!p || !p.audio) return;
  if (S.advTimer) { clearTimeout(S.advTimer); S.advTimer = null; }
  S.activeIdx = -1;
  for (const s of $("pageText").children) s.classList.remove("hl", "read");
  narration.currentTime = 0;
  narration.play().catch(() => {});
  log("repeat", { slug: S.slug, page: S.page });
}

// ---------- optional per-page video (after narration; dwell skips) ----------
function playVideo(p) {
  $("videoWrap").classList.add("show");
  suppress();
  let fired = false;
  const done = () => {
    if (fired) return;
    fired = true;
    closeVideo();
    advance();
  };
  S.videoDone = done;
  video.onended = done;
  video.onerror = done;                        // a broken video never strands her
  video.src = "/books/" + S.slug + "/" + p.video;
  video.play().catch(done);
  log("video", { slug: S.slug, page: S.page });
}
function closeVideo() {
  S.videoDone = null;
  video.onended = video.onerror = null;
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  $("videoWrap").classList.remove("show");
}

// ---------- the end ----------
function finishBook() {
  stopMedia();
  clearPos(S.slug);                            // next open starts fresh
  log("book-done", { slug: S.slug });
  $("endSub").textContent = "You read " + S.manifest.title + "!";
  show("sEnd");
}

// ---------- boot ----------
async function boot() {
  try {
    const st = await (await fetch("/settings")).json();
    if (window.Dwell) {
      if (typeof st.dwellMs === "number" && isFinite(st.dwellMs))
        Dwell.setMs(Math.max(600, Math.min(3000, st.dwellMs)));
      if (typeof st.settleMs === "number" && isFinite(st.settleMs))
        Dwell.set({ settleMs: Math.max(0, Math.min(2000, st.settleMs)) });
    }
    if (st.childName) $("shelfTitle").textContent = "\u{1F4DA} " + st.childName + "'s Books";
  } catch { /* defaults stand — never block the shelf on settings */ }

  try {
    const idx = await (await fetch("/books/index.json")).json();
    S.index = Array.isArray(idx) ? idx : [];
  } catch { S.index = []; }                    // degraded law: empty shelf, alive app
  renderShelf();
  suppress();

  $("btnNext").addEventListener("click", advance);
  $("btnPrev").addEventListener("click", prev);
  $("btnRepeat").addEventListener("click", repeat);
  $("advanceArrow").addEventListener("click", advance);
  $("btnSkip").addEventListener("click", () => { if (S.videoDone) S.videoDone(); });
  $("btnAgain").addEventListener("click", () => { S.page = 0; show("sRead"); renderPage(); });
  $("btnShelf").addEventListener("click", () => {
    stopMedia(); S.manifest = null; S.slug = null;
    show("sShelf"); renderShelf(); log("shelf", {});
  });
  $("door").addEventListener("click", async () => {
    if (!$("sShelf").classList.contains("show")) {   // in a book: back to the shelf (place saved)
      stopMedia(); S.manifest = null; S.slug = null;
      show("sShelf"); renderShelf(); log("shelf", {});
      return;
    }
    log("door", {});                                 // on the shelf: leave the app
    try {
      const r = await fetch("http://127.0.0.1:49155/app/exit", { method: "POST" });
      if (r.ok) return;                              // ERAgaze closes this kiosk now
    } catch { /* no engine here — web fallback */ }
    location.reload();
  });

  log("boot", { books: S.index.length });
}
boot();

// introspection surface (mirrors window.Board) — tests + field debugging
window.Reader = {
  version: "1.0-manifest",
  state: () => ({
    screen: (document.querySelector(".screen.show") || {}).id || null,
    slug: S.slug, page: S.page,
    activeIdx: S.activeIdx,
    words: S.words ? S.words.length : 0,
    audio: narration.paused ? "paused" : "playing",
    audioTime: narration.currentTime,
    arrow: $("advanceArrow").classList.contains("show"),
    videoShowing: $("videoWrap").classList.contains("show"),
    shelfCount: S.index.length,
  }),
  open: openBook,
};
