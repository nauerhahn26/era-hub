// Book Reader — self-directed reading room.
// Rules of the room: SHE turns pages, we never read uninvited; looking at any
// word speaks that word (support on demand, not a quiz); "read to me" speaks
// the page; barge-in everywhere — her action always cuts our audio.
"use strict";

const S = {
  session: "r" + Date.now(),
  books: [],
  book: null,
  page: 0,
  heard: new Set(),      // words she asked for this book (goes to the log)
};

function log(event, detail) {
  fetch("/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t: Date.now(), session: S.session, app: "reader", event, ...detail }) }).catch(() => {});
}
function say(text, opts) { return window.Speech ? Speech.say(text, (opts && opts.kind) || "long") : Promise.resolve(); }
function hush() { if (window.Speech) Speech.stop(); }

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("show"));
  document.getElementById(id).classList.add("show");
  document.getElementById("door").classList.add("show");   // door on every screen: book->shelf, shelf->TD Snap
}

// ---------- shelf ----------
function renderShelf() {
  const shelf = document.getElementById("shelf");
  shelf.innerHTML = "";
  for (const b of S.books) {
    const d = document.createElement("div");
    d.className = "book dwell";
    d.setAttribute("data-dwell-ms", "1600");
    d.setAttribute("data-dwell-say", b.title);
    d.innerHTML = `<div class="cover">${b.emoji}</div><div class="name">${b.title}</div>`;
    d.addEventListener("click", () => openBook(b));
    shelf.appendChild(d);
  }
}

function openBook(b) {
  hush();
  S.book = b; S.page = 0; S.heard = new Set();
  log("book_open", { book: b.id });
  show("sRead");
  renderPage();
  say(b.title + ". " + "You read it — touch any word to hear it.");
}

// ---------- reading ----------
function renderPage() {
  const b = S.book;
  document.getElementById("bookTitle").textContent = b.emoji + " " + b.title;
  document.getElementById("pageNum").textContent = (S.page + 1) + " / " + b.pages.length;
  const holder = document.getElementById("pageText");
  holder.innerHTML = "";
  for (const raw of b.pages[S.page].split(/\s+/)) {
    const w = document.createElement("span");
    w.className = "w dwell";
    // support, not selection: a shorter hold than buttons, generous hit padding
    w.setAttribute("data-dwell-ms", "1000");
    w.setAttribute("data-dwell-pad", "16");
    w.textContent = raw;
    w.addEventListener("click", () => {
      hush();
      const clean = raw.replace(/[^a-zA-Z'’]/g, "");
      if (!clean) return;
      S.heard.add(clean.toLowerCase());
      log("word", { book: b.id, page: S.page, word: clean.toLowerCase() });
      say(clean, { kind: "word" });
    });
    holder.appendChild(w);
  }
  document.getElementById("btnBack").style.visibility = S.page === 0 ? "hidden" : "visible";
  document.getElementById("btnNext").textContent = S.page === b.pages.length - 1 ? "The End ▶" : "next ▶";
  log("page", { book: b.id, page: S.page });
}

function turn(dir) {
  hush();
  const b = S.book;
  if (dir > 0 && S.page === b.pages.length - 1) return finishBook();
  S.page = Math.max(0, Math.min(b.pages.length - 1, S.page + dir));
  renderPage();
}

function readPage() {
  hush();
  log("read_page", { book: S.book.id, page: S.page });
  say(S.book.pages[S.page], { kind: "long" });
}

// ---------- the end ----------
function finishBook() {
  hush();
  const b = S.book;
  log("book_done", { book: b.id, wordsHeard: S.heard.size });
  show("sEnd");
  document.getElementById("endSub").textContent = "You read " + b.title + "!";
  say("The end! You read the whole book. " + b.title + ". That is real reading!");
}

// ---------- boot ----------
async function boot() {
  try { const st = await (await fetch("/settings")).json(); if (st.dwellMs && window.Dwell) Dwell.setMs(st.dwellMs); } catch {}
  try { S.books = (await (await fetch("books.json")).json()).books; } catch { S.books = []; }
  renderShelf();

  document.getElementById("btnNext").addEventListener("click", () => turn(1));
  document.getElementById("btnBack").addEventListener("click", () => turn(-1));
  document.getElementById("btnHear").addEventListener("click", readPage);
  document.getElementById("btnAgain").addEventListener("click", () => { hush(); openBook(S.book); });
  document.getElementById("btnShelf").addEventListener("click", () => { hush(); show("sShelf"); log("shelf", {}); say("Pick a book!"); });
  document.getElementById("door").addEventListener("click", async () => {
    hush();
    if (!document.getElementById("sShelf").classList.contains("show")) {
      show("sShelf"); log("shelf", {}); return;      // in a book: back to the shelf
    }
    log("door", {});                                  // on the shelf: leave the app
    try {
      const r = await fetch("http://127.0.0.1:49155/app/exit", { method: "POST" });
      if (r.ok) return;                               // ERAgaze closes this kiosk now
    } catch { /* no engine here — web fallback */ }
    location.reload();
  });

  const mode = await Speech.init("Pick a book!");
  if (mode === "off") document.getElementById("ttsWarn").classList.add("show");
  log("boot", { tts: mode, books: S.books.length });
}
boot();
