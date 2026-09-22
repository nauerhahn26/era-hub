// reader-strip.js — "+ Add a book": the door a shared book comes in through
// (spec 2026-09-22 §5, plan T4.2).
//
// Dad, 9/19: "we have the header now and we already have the ability kind of
// with the music player on the top right to add a book … there's like a few
// other reading tools there that we could eventually allow people to add books
// through so let's start with the file system but just something to think
// about." So: a strip at the RIGHT END of the reader's door bar, one button,
// and a sheet that lists SOURCES — today exactly one, a file.
//
// THE SAME CONSTRUCTION AS era-board's mountPartnerStrip(), deliberately:
// buttons made with NO `.dwell` and NO `data-dwell-*`, which is what makes them
// a grown-up's control on a screen a child drives with her eyes. Mouse OR
// finger, though — a grown-up may be at a keyboard, and only the *hold*
// (reader-share.js) is finger-only, because only the hold shares a surface with
// her gaze. There is nothing here she can arm by looking at it, so there is
// nothing to take away from a mouse.
//
// THE 🚪 MUST NOT MOVE. lib/doorbar.js's header states the law this strip lives
// under: "a touch-only strip may sit at the bar's right end (it is never
// .dwell), and it is why the 💬 is absolutely CENTRED on the bar rather than
// packed after the 🚪: her motor plan for it must not move when a board grows a
// strip." The 🚪 is the first flex item and the 💬 is out of the flow
// altogether, so a right-anchored strip (margin-left:auto) moves neither — and
// reader-strip.test.mjs measures both doors with the strip in and with it out
// rather than trusting that sentence.
//
// SHELF SCREEN ONLY (spec §5.1). While a book is open the bar belongs to 🚪 and
// 💬: a child mid-story must not find a grown-up's control in the one strip she
// has learned. reader.js already stamps `body.reading` on the reading screen,
// so the rule is one line of CSS in index.html rather than a second listener
// here guessing at the same state.
//
// WHAT IS *NOT* BUILT. The sheet is a list of one, but it is a LIST, and
// `source=file` is on the wire from this first commit. When one of dad's other
// reading tools arrives it is a new row here and a new word there — not a
// redesign. Nothing speculative is built for it now: no adapter interface, no
// registry, no second source stubbed out (spec §5.2, §9).
//
// THE FILE GOES UP AS THE RAW BODY — `fetch(url, {method:"POST", body:file})`.
// There is no multipart parser anywhere in this hub and there must never be
// one; server.js's readBinaryBody streams the body straight to a temp file and
// counts the bytes. A FormData here would have been a parser there.
//
// EVERY REFUSAL IS ONE SENTENCE, and it is the HUB's sentence, whole:
// books-share.js wrote every one of them for a parent standing at a tablet
// holding a file somebody sent them (spec §5.2). This file never invents a
// reason and never prints a code — except for the two states the hub never
// hears about, which are named below.
//
// A classic script, like reader.js and reader-share.js, wrapped in an IIFE:
// classic scripts share one global scope and a bare `const sheet` in two of
// them is a collision waiting for its turn.
(function () {
  "use strict";

  var OFFLINE = "Couldn't reach New ERA — try again in a moment.";
  // A refusal nobody wrote a sentence for must STILL be a sentence. An older
  // hub, a proxy, a bug: a parent gets a line they can act on, never an error
  // object on a six-year-old's bookshelf.
  var UNKNOWN = "New ERA could not add that book. Ask them to send it again.";

  var sheet = null;
  var gridWatch = null;

  // ---- the strip -----------------------------------------------------------

  function mountStrip() {
    var bar = document.querySelector("#bar .msgbar");
    // Never a dead app (8/19): a reader whose bar did not mount still reads
    // books, it just has no door for a new one.
    if (!bar || document.getElementById("readerStrip")) return;
    var strip = document.createElement("div");
    strip.id = "readerStrip";
    var btn = document.createElement("button");
    btn.type = "button";                 // never a submit inside somebody's form
    btn.id = "stripAddBook";
    btn.className = "stripbtn";
    btn.textContent = "+ Add a book";    // deliberately NO .dwell, NO data-dwell-*
    strip.appendChild(btn);
    bar.appendChild(strip);
    btn.addEventListener("click", openSheet);
  }

  // reader.js mounts the bar synchronously at the top of boot(), before its
  // first await, and this file is a later `defer` script — so the bar is there.
  // The retry is for the order changing under us one day, not for today.
  mountStrip();
  if (!document.getElementById("readerStrip")) {
    var tries = 0;
    var again = setInterval(function () {
      mountStrip();
      if (document.getElementById("readerStrip") || ++tries > 40) clearInterval(again);
    }, 100);
  }

  // ---- the sheet -----------------------------------------------------------

  function mk(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (tag === "button") el.type = "button";    // deliberately NO .dwell, NO data-dwell-*
    if (text != null) el.textContent = text;
    return el;
  }

  function setMsg(text) {
    if (!sheet) return;
    var m = sheet.querySelector(".add-msg");
    if (m) { m.textContent = text || ""; m.classList.toggle("show", !!text); }
  }

  // Spec §5.2 row 5 is the only refusal with somewhere to send them, and the
  // hub says so itself (`settings` on the answer) rather than this file knowing
  // which row that is.
  function setLink(href) {
    if (!sheet) return;
    var old = sheet.querySelector(".add-link");
    if (old) old.remove();
    if (!href) return;
    var a = document.createElement("a");
    a.className = "add-link";
    a.href = href;
    a.textContent = "Set up your content folder";
    sheet.querySelector(".add-card").insertBefore(a, sheet.querySelector(".add-foot"));
  }

  function setCover(src) {
    if (!sheet) return;
    var box = sheet.querySelector(".add-cover");
    if (!box) return;
    box.innerHTML = "";
    if (!src) return;
    var img = document.createElement("img");
    img.alt = "";
    img.onerror = function () { img.remove(); };
    img.src = src;
    box.appendChild(img);
  }

  function enable(on) {
    if (!sheet) return;
    var bs = sheet.querySelectorAll(".add-source");
    for (var i = 0; i < bs.length; i++) bs[i].disabled = !on;
  }

  function busy() {
    return !!document.querySelector(".grown-sheet");
  }

  function openSheet() {
    // A grown-up's sheet already on screen owns the shelf — the send sheet, or
    // reader.js's Build ask. Two sheets over one frozen shelf would thaw it
    // twice and hand her gaze a shelf the other one is still using.
    if (sheet || busy()) return;
    sheet = mk("div", "grown-sheet");
    sheet.id = "addSheet";
    sheet.setAttribute("role", "dialog");
    var card = mk("div", "add-card");
    card.append(mk("div", "add-title", "Add a book"));

    // THE LIST. One row today; the shape is what makes a second one a row.
    var list = mk("div", "add-sources");
    var pick = mk("button", "add-source", "📁 Choose a file");
    pick.id = "addPickFile";
    var input = document.createElement("input");
    input.type = "file";
    input.id = "addFile";
    // Explorer on Windows, the file picker on a phone. `.zip` as well as
    // `.erabook` because a mail client or a phone may have renamed it on the
    // way — the envelope inside is what actually decides (books-share.js).
    input.accept = ".erabook,.zip";
    input.hidden = true;
    pick.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      // the same file twice in a row must still fire a change
      input.value = "";
      if (f) addFile(f);
    });
    list.append(pick, input);
    card.append(list);

    card.append(mk("div", "add-cover"), mk("div", "add-msg"));
    var foot = mk("div", "add-foot");
    var close = mk("button", "add-btn", "Close");
    close.id = "addClose";
    close.addEventListener("click", function () { closeSheet(); });
    foot.append(close);
    card.append(foot);
    sheet.append(card);
    document.body.appendChild(sheet);

    freeze();
    // A repaint under an open sheet hands back fresh cards that all wear
    // .dwell — reader.js's own poll does it, and so does this sheet's own
    // success. Watch the grid and put the new cards straight back to sleep.
    var grid = document.getElementById("shelfGrid");
    if (grid && window.MutationObserver) {
      gridWatch = new MutationObserver(function () { if (sheet) freeze(); });
      gridWatch.observe(grid, { childList: true });
    }
  }

  // reader.js's OWN freeze (the Build ask's), borrowed rather than copied: while
  // a grown-up's sheet is open the shelf and the bar's two doors sleep, because
  // a full-screen backdrop hides nothing from dwell.js's targetAt().
  function freeze() {
    try { if (window.Reader && window.Reader.freezeShelf) window.Reader.freezeShelf(sheet); }
    catch (e) { /* never a dead app (8/19) */ }
  }

  function closeSheet() {
    if (gridWatch) { gridWatch.disconnect(); gridWatch = null; }
    if (sheet) { sheet.remove(); sheet = null; }
    try { if (window.Reader && window.Reader.thawShelf) window.Reader.thawShelf(); } catch (e) {}
    try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch (e) {}
  }

  // ---- adding --------------------------------------------------------------

  // The only title we have before the hub answers is the one on the file, so
  // that is the one the waiting line says. The sentence that follows uses the
  // BOOK's own title, off the manifest, which is what the shelf will show.
  function titleOf(name) {
    return String(name || "").replace(/\.(erabook|zip)$/i, "") || "the book";
  }

  // The hub's own sentence, whole — it knows why better than we do.
  function sentenceOf(res) {
    return res.json().then(function (j) {
      return {
        said: (j && typeof j.message === "string" && j.message) || UNKNOWN,
        settings: (j && typeof j.settings === "string") ? j.settings : "",
      };
    }, function () { return { said: UNKNOWN, settings: "" }; });
  }

  function addFile(file) {
    setLink("");
    setCover("");
    setMsg("Adding " + titleOf(file.name) + "…");
    enable(false);
    // RAW BODY. See the header: there is no multipart parser in the hub.
    // `source` rides on the query string from this first commit (spec §9's
    // only seam) so a second source is a word, not a redesign.
    fetch("/books/import?source=file", { method: "POST", body: file })
      .then(function (res) {
        if (!res.ok) return sentenceOf(res).then(function (r) { throw r; });
        return res.json().catch(function () { throw { said: UNKNOWN, settings: "" }; });
      })
      .then(function (j) {
        if (!j || !j.ok) throw { said: UNKNOWN, settings: "" };
        // Dad, 9/18: "should land arrive on their bookshelf ready to read." The
        // hub has already mirrored the one book onto this device's shelf, so the
        // shelf behind the sheet is repainted NOW rather than at the next
        // ten-minute tick — and the grid watcher above puts the fresh cards
        // straight back to sleep under the open sheet.
        return repaint().then(function () { return j; });
      })
      .then(function (j) {
        if (!sheet) return;
        enable(true);
        var title = j.title || titleOf(file.name);
        // The cover the shelf itself just drew, by slug — one source of truth,
        // and honest when the mirror has not put the book there yet (no
        // picture rather than an invented URL).
        var card = j.slug
          ? document.querySelector('#shelfGrid .shelf-card[data-slug="' + j.slug + '"] .shelf-cover img')
          : null;
        setCover(card ? card.getAttribute("src") : "");
        setMsg(title + " is on the shelf.");
      })
      .catch(function (e) {
        if (!sheet) return;
        enable(true);
        setCover("");
        setMsg((e && e.said) || OFFLINE);
        setLink((e && e.settings) || "");
      });
  }

  function repaint() {
    try {
      if (window.Reader && window.Reader.repaintShelf)
        return Promise.resolve(window.Reader.repaintShelf());
    } catch (e) { /* the sentence matters more than the picture */ }
    return Promise.resolve();
  }

  // the suite's seam, mirroring window.__shareTest: a door into the sheet that
  // does not depend on the strip having been drawn yet.
  window.__addTest = {
    open: openSheet,
    close: closeSheet,
    isOpen: function () { return !!sheet; },
  };
})();
