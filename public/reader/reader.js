// Book Reader v2 — the OLD Book-Reader UI (dad: "I like my old layout. Please
// match.") ported from components/reader-client.tsx + library-client.tsx onto
// the hub's LOCAL package data layer (which stays exactly as v1 shipped it):
// /books/index.json + /books/<slug>/manifest.json, recorded mp3 narration with
// manifest words[] word-sync (binary search, MONOTONIC), interpolation
// fallback, /settings dwell knobs, pool /log events, localStorage resume.
// This app NEVER calls speechSynthesis.
//
// THE OLD READER'S RULES (ported 1:1 — the "pauses with the arrow" behavior):
//  * A page auto-reads when it appears (page turns queue auto-play; the very
//    first page reads on open).
//  * When narration ENDS the reader PAUSES ON THE PAGE: the next-arrow grows
//    to the big center-right ready-arrow (pulsing after 5s) and WAITS for
//    her. The page NEVER turns itself. (v1 auto-advanced 600ms after audio —
//    that is the regression dad called out.)
//  * Activating an arrow MID-NARRATION stops the current page's narration
//    before turning — the story never talks across a page turn.
//  * Triggering the ready arrow on a page WITH a video plays the video first
//    (overlaid on the page image, old outro presentation; the big arrow
//    shrinks back to the corner so her gaze on the video can't re-arm it);
//    the video's end turns the page. On the LAST page the video auto-plays
//    when audio ends, since there is no arrow left to trigger it.
//  * End of book: the Library button grows 5x at left-center and pulses —
//    the invitation back to the shelf. No "The End" screen.
//  * A textless/silent page is "finished" the moment it shows (ready arrow
//    immediately) — she is never stuck.
//  * Read/Pause pill: pauses mid-word, resumes in place, restarts after end.
// Missing index/manifest degrades to an empty shelf / page 1 — never a dead
// app (8/19 law). Every page render suppresses dwell for the settle window
// (D51) — a fresh page never inherits her gaze.
"use strict";

const S = {
  session: "r" + Date.now(),
  index: [],          // /books/index.json rows {slug,title,cover,pages,hasVideo,authored}
  manifest: null,     // the open book's manifest
  slug: null,
  page: 0,
  wordSpans: [],      // current page's word-token <span>s, in reading order
  words: null,        // resolved [{word,start,end}] — manifest's or interpolated
  activeIdx: -1,      // word-sync cursor: NEVER decreases within one playback
  reading: false,     // narration currently playing
  paused: false,      // narration paused mid-page (Read/Pause pill)
  finished: false,    // narration done on this page -> big ready-arrow waits
  bookFinished: false,// last page done -> big pulsing Library button
  playingOutro: false,// page video overlay currently showing
  pulseTimer: null,   // 5s ready -> pulse timer (old reader's nudge)
  ignorePause: null,  // one-tick latch: our own stop must not read as "Paused"
  renderGen: 0,       // bumps per render — stale async media outcomes are ignored
};

const $ = (id) => document.getElementById(id);
const narration = $("narration");
const video = $("pageVideo");

function log(event, detail) {
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), session: S.session, app: "reader", event, ...detail }) }).catch(() => {});
}
function suppress() { if (window.Dwell && Dwell.suppress) Dwell.suppress(); }

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("show"));
  $(id).classList.add("show");
  document.body.classList.toggle("reading", id === "sRead");
  suppress();                                    // new surface: settle before gaze arms
}

// ---------- old DwellButton ring: mirror the engine's fill into the conic
// progress ring (--dwell-progress, 0..360deg — dwell.js stays untouched) ----
new MutationObserver((muts) => {
  for (const mu of muts) {
    const el = mu.target;
    if (!el.classList || !el.classList.contains("dwell-fill")) continue;
    const host = el.closest(".dwell");
    if (!host) continue;
    const pct = parseFloat(el.style.height) || 0;
    host.style.setProperty("--dwell-progress", (pct * 3.6).toFixed(1) + "deg");
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });

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

// ---------- shelf (old library-client structure: shelf-card grid, coral rim
// on authored books, Back-to-TD-Snap tile as the exit affordance) ----------
function renderShelf() {
  const grid = $("shelfGrid");
  grid.innerHTML = "";
  $("shelfEmpty").hidden = S.index.length > 0;
  for (const b of S.index) {
    const card = document.createElement("div");
    card.className = b.authored === true ? "shelf-card is-authored" : "shelf-card";
    const btn = document.createElement("div");
    btn.className = "dwell dwell-button shelf-card-button";
    btn.setAttribute("data-dwell-say", b.title);
    btn.setAttribute("aria-label",
      b.authored === true ? "Read " + b.title + " — Ellie's story" : "Read " + b.title);
    const cover = document.createElement("span");
    cover.className = "shelf-cover";
    const img = document.createElement("img");
    img.alt = "";
    img.onerror = () => {
      img.remove();
      const fb = document.createElement("span");
      fb.className = "shelf-cover-fallback muted";
      fb.textContent = "No cover";
      cover.appendChild(fb);
    };
    img.src = b.cover;
    cover.appendChild(img);
    const name = document.createElement("span");
    name.className = "shelf-title";
    name.textContent = b.title;
    btn.appendChild(cover);
    btn.appendChild(name);
    btn.addEventListener("click", () => openBook(b.slug));
    card.appendChild(btn);
    if (b.authored === true) {
      const badge = document.createElement("span");
      badge.className = "shelf-authored-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 2.5l2.1 5.6 5.9.3-4.6 3.7 1.6 5.7L12 14.6 6.9 17.8l1.6-5.7L3.9 8.4l5.9-.3Z"/></svg>' +
        "Ellie's story";
      card.appendChild(badge);
    }
    grid.appendChild(card);
  }
  // Back to TD Snap — old shelf's exit tile; leaving the app is the
  // highest-consequence hold (EXIT_HOLD_MS 2400, ux-contract §C).
  const exitCard = document.createElement("div");
  exitCard.className = "shelf-card";
  const exitBtn = document.createElement("div");
  exitBtn.id = "btnExit";
  exitBtn.className = "dwell dwell-button shelf-tdsnap-button";
  exitBtn.setAttribute("data-dwell-ms", "2400");
  exitBtn.setAttribute("data-dwell-say", "back to TD Snap");
  exitBtn.setAttribute("aria-label", "Back to TD Snap");
  exitBtn.innerHTML = '<span class="shelf-tdsnap-icon" aria-hidden="true">\u{1F4AC}</span>' +
    '<span class="shelf-title">Back to TD Snap</span>';
  exitBtn.addEventListener("click", exitApp);
  exitCard.appendChild(exitBtn);
  grid.appendChild(exitCard);
}

async function exitApp() {
  log("door", {});
  try {
    const r = await fetch("http://127.0.0.1:49155/app/exit", { method: "POST" });
    if (r.ok) return;                            // ERAgaze closes this kiosk now
  } catch { /* no engine here — web fallback */ }
  location.reload();
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
function clearPulse() {
  if (S.pulseTimer) { clearTimeout(S.pulseTimer); S.pulseTimer = null; }
  $("btnNext").classList.remove("reader-next-button-pulse");
}

function stopMedia() {
  clearPulse();
  // stopIgnorePause latch (old reader): our own pause() must not flip the UI
  // into "Paused" — give the synchronous pause event a tick, then unlatch.
  S.ignorePause = true;
  try { narration.pause(); narration.currentTime = 0; } catch {}
  setTimeout(() => { S.ignorePause = false; }, 0);
  S.playingOutro = false;
  video.onended = video.onerror = null;
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  video.classList.remove("reader-outro-video-playing");
}

function setDisabled(el, disabled) {
  el.classList.toggle("is-disabled", disabled);
  if (disabled) el.setAttribute("data-dwell-disabled", "");
  else el.removeAttribute("data-dwell-disabled");
}

// Old reader's status line: "Page 3 of 16 · Reading aloud"
function updateUi() {
  const m = S.manifest;
  if (!m) return;
  const p = m.pages[S.page];
  const label = S.reading && !S.paused ? "Reading aloud"
    : S.paused ? "Paused"
    : !p.audio ? "No voice for this page yet"
    : "Ready to read";
  $("pageMeta").textContent = "Page " + (S.page + 1) + " of " + m.pages.length + " · " + label;
  $("btnReadLabel").textContent = S.reading && !S.paused ? "Pause" : "Read";
  setDisabled($("btnRead"), !p.audio);
  setDisabled($("btnPrev"), S.page === 0);
  setDisabled($("btnNext"), S.page >= m.pages.length - 1);
  // Once she triggers the ready arrow (starting the video), it shrinks back
  // to the corner so her gaze on the video can't re-arm it (old reader).
  const ready = S.finished && !S.playingOutro && !S.bookFinished;
  $("btnNext").classList.toggle("reader-next-button-ready", ready);
  if (!ready) $("btnNext").classList.remove("reader-next-button-pulse");
  $("btnLibrary").classList.toggle("reader-library-button-finished", S.bookFinished);
}

function resetHighlight() {
  S.activeIdx = -1;
  for (const el of S.wordSpans) el.classList.remove("active");
}

function renderTokens(text) {
  const holder = $("pageText");
  holder.innerHTML = "";
  S.wordSpans = [];
  const parts = (text || "").split(/(\s+)/);
  let any = false;
  for (const part of parts) {
    if (!part) continue;
    any = true;
    const isWord = /[\p{L}\p{N}]/u.test(part);
    const s = document.createElement("span");
    s.className = isWord ? "reader-token" : "reader-token-gap";
    if (!isWord) s.setAttribute("aria-hidden", "true");
    s.textContent = part;
    holder.appendChild(s);
    if (isWord) S.wordSpans.push(s);
  }
  if (!any) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "No page text yet.";
    holder.appendChild(empty);
  }
}

function renderPage() {
  stopMedia();
  const gen = ++S.renderGen;      // a fast page turn aborts the old play(); its
                                  // rejection must not mark THIS page ready
  const m = S.manifest, p = m.pages[S.page];
  const base = "/books/" + S.slug + "/";
  S.reading = false; S.paused = false; S.finished = false;
  S.bookFinished = false; S.playingOutro = false;
  $("bookTitle").textContent = m.title;

  // Page image — robust both ways (the old layout's guarantee): the image
  // frame owns its grid row, so a missing/failed image shows the fallback
  // card and the text panel NEVER swallows the page (the v1 collapse that
  // left a broken-image glyph with text filling the screen).
  const img = $("pageImg"), fallback = $("imgFallback");
  if (p.image) {
    img.hidden = false; fallback.hidden = true;
    img.onerror = () => { if (gen !== S.renderGen) return; img.hidden = true; fallback.hidden = false; };
    img.src = base + p.image;
  } else {
    img.removeAttribute("src");
    img.hidden = true; fallback.hidden = false;
  }

  renderTokens(p.text);
  S.activeIdx = -1;
  S.words = (Array.isArray(p.words) && p.words.length)
    ? p.words.slice().sort((a, b) => a.start - b.start)
    : null;                                    // may be interpolated on loadedmetadata

  if (p.audio) {
    narration.src = base + p.audio;            // auto-read: the page reads as it appears
    narration.play().catch(() => {
      // autoplay blocked: show the way forward (ready arrow) instead of a stuck page
      if (gen === S.renderGen) markReadyForNext();
    });
  } else {
    narration.removeAttribute("src");
    markReadyForNext();                        // textless/silent page: ready NOW (old law)
  }

  updateUi();
  savePos(S.slug, S.page);
  suppress();                                  // page-settle: fresh page never inherits her gaze
}

// Narration done on this page. NOT last page: the big ready-arrow waits for
// her (pulse after 5s — the old reader's gentle nudge). LAST page: the outro
// video auto-plays if there is one (no arrow left to trigger it), otherwise
// the book is finished and the Library button becomes the invitation.
function markReadyForNext() {
  clearPulse();
  const m = S.manifest;
  if (!m) return;
  const p = m.pages[S.page];
  if (S.page >= m.pages.length - 1) {
    if (p.video && !S.playingOutro) { startOutro(p); return; }
    setBookFinished();
    return;
  }
  S.finished = true;
  S.pulseTimer = setTimeout(() => {
    if (S.finished && !S.playingOutro) $("btnNext").classList.add("reader-next-button-pulse");
  }, 5000);
  updateUi();
}

function setBookFinished() {
  S.finished = false;
  S.playingOutro = false;
  S.bookFinished = true;
  clearPos(S.slug);                            // next open starts fresh
  log("book-done", { slug: S.slug });
  updateUi();
}

// interpolation fallback: audio but no word timings -> spread the words evenly
narration.addEventListener("loadedmetadata", () => {
  if (S.words || !S.wordSpans.length) return;
  const dur = narration.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const n = S.wordSpans.length;
  S.words = S.wordSpans.map((el, i) =>
    ({ word: el.textContent, start: i * dur / n, end: (i + 1) * dur / n }));
});

// word sync: binary search for the last word started by t; MONOTONIC —
// the active index never decreases within a playback (repeat/page reset it).
// Visual = the old reader's yellow token highlight.
function syncWords(t) {
  const words = S.words;
  if (!words || !words.length || !S.wordSpans.length) return;
  let lo = 0, hi = words.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit <= S.activeIdx) return;
  S.activeIdx = hit;
  const spanIdx = Math.min(hit, S.wordSpans.length - 1);
  for (let i = 0; i < S.wordSpans.length; i++)
    S.wordSpans[i].classList.toggle("active", i === spanIdx);
  const active = S.wordSpans[spanIdx];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (window.__testHooks)
    (window.__hlSeq = window.__hlSeq || []).push({ page: S.page, idx: hit });
}
narration.addEventListener("timeupdate", () => syncWords(narration.currentTime));

narration.addEventListener("play", () => {
  S.reading = true; S.paused = false;
  updateUi();
});
narration.addEventListener("pause", () => {
  if (S.ignorePause) return;
  if (narration.ended || !narration.src) return;
  S.paused = true; S.reading = false;          // Read/Pause pill paused mid-page
  updateUi();
});
narration.addEventListener("ended", () => {
  S.reading = false; S.paused = false;
  // old reader clears the highlight when the page finishes reading
  for (const el of S.wordSpans) el.classList.remove("active");
  markReadyForNext();
  updateUi();
});

// ---------- controls (old reader semantics) ----------
function advance() {
  if (!S.manifest || S.page >= S.manifest.pages.length - 1) return;
  S.page++;
  renderPage();                                // stops old narration; new page auto-reads
}
function goNext() {
  const m = S.manifest;
  if (!m || S.page >= m.pages.length - 1) return;   // last page: Library finishes the book
  const p = m.pages[S.page];
  // Ready arrow on a page WITH a video: play the video first (old outro
  // behavior); its end turns the page.
  if (S.finished && p.video && !S.playingOutro) { startOutro(p); return; }
  advance();                                   // mid-narration: the arrow PAUSES the story
}
function goPrev() {
  if (!S.manifest || S.page === 0) return;
  S.page--;
  renderPage();
}
function toggleRead() {
  const p = S.manifest && S.manifest.pages[S.page];
  if (!p || !p.audio) return;
  if (S.reading && !S.paused) { narration.pause(); return; }
  clearPulse();
  S.finished = false;
  if (S.paused && narration.src && !narration.ended && narration.currentTime > 0) {
    narration.play().catch(() => {});          // resume exactly where she paused
  } else {
    resetHighlight();                          // read it again from the top
    try { narration.currentTime = 0; } catch {}
    narration.play().catch(() => {});
    log("repeat", { slug: S.slug, page: S.page });
  }
  updateUi();
}
function goLibrary() {
  stopMedia();
  S.manifest = null; S.slug = null;
  S.finished = false; S.bookFinished = false;
  show("sShelf"); renderShelf(); log("shelf", {});
}

// ---------- per-page video (old outro presentation: overlaid on the page
// image inside the frame; the video's end turns the page) ----------
function startOutro(p) {
  S.playingOutro = true;
  clearPulse();
  updateUi();                                  // big arrow shrinks back to the corner
  suppress();
  const gen = S.renderGen;
  const done = () => {
    if (gen !== S.renderGen) return;           // page changed under the video
    S.playingOutro = false;
    video.onended = video.onerror = null;
    try { video.pause(); } catch {}
    video.removeAttribute("src");
    video.classList.remove("reader-outro-video-playing");
    if (S.page >= S.manifest.pages.length - 1) setBookFinished();
    else advance();
  };
  video.onended = done;
  video.onerror = done;                        // a broken video never strands her
  video.src = "/books/" + S.slug + "/" + p.video;
  video.classList.add("reader-outro-video-playing");
  video.play().catch(done);
  log("video", { slug: S.slug, page: S.page });
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
    if (st.childName) $("shelfTitle").textContent = st.childName + "'s Bookshelf";
  } catch { /* defaults stand — never block the shelf on settings */ }

  try {
    const idx = await (await fetch("/books/index.json")).json();
    S.index = Array.isArray(idx) ? idx : [];
  } catch { S.index = []; }                    // degraded law: empty shelf, alive app
  renderShelf();
  suppress();

  $("btnNext").addEventListener("click", goNext);
  $("btnPrev").addEventListener("click", goPrev);
  $("btnRead").addEventListener("click", toggleRead);
  $("btnLibrary").addEventListener("click", goLibrary);

  log("boot", { books: S.index.length });
}
boot();

// introspection surface (mirrors window.Board) — tests + field debugging
window.Reader = {
  version: "2.0-old-ui",
  state: () => ({
    screen: (document.querySelector(".screen.show") || {}).id || null,
    slug: S.slug, page: S.page,
    activeIdx: S.activeIdx,
    words: S.words ? S.words.length : 0,
    audio: narration.paused ? "paused" : "playing",
    audioTime: narration.currentTime,
    arrow: S.finished && !S.playingOutro && !S.bookFinished,  // the big ready-arrow
    finished: S.finished,
    bookFinished: S.bookFinished,
    videoShowing: S.playingOutro,
    shelfCount: S.index.length,
  }),
  open: openBook,
};
