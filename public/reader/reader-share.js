// reader-share.js — hold a finger on a book, send it to another family
// (spec 2026-09-22 §4, plan T3.2). Modelled line for line on era-board's
// board-edit.js, which is the reference for every hold in this house.
//
// Dad, 9/18: "I want a way to share a book with another family using book
// reader app. Not public. Person to person sharing." And on the UX, 9/19:
// "this is something only a touch user would use. So you would hold to touch
// the book and it would give you the option to share." So: a grown-up holds a
// FINGER on a finished book's card for 1.6 s and gets a sheet with three ways
// to send the file. The file itself is the hub's business (erabook.js,
// books-share.js); this file owns the gesture and the sheet.
//
// WHY TOUCH ONLY, AGAIN — and on this screen it matters more than anywhere.
// The bookshelf is the one surface a non-verbal six-year-old drives with her
// eyes, and ERAgaze moves the REAL cursor: a parked gaze and a parked mouse are
// the same pointer at the DOM. A hold that answered `mouse` would be a sheet
// SHE could open by looking at her own book for two seconds. `pointerType ===
// "touch"` is the entire filter — the same one board-edit.js and board-lock.js
// use, for the same reason. Nothing this file adds ever wears `.dwell` or a
// `data-dwell-*` attribute either: every control here is a grown-up's.
//
// WHY THIS LISTENS ON `window`, IN CAPTURE. era-core/dwell.js has a TAP-RESCUE:
// its own document-capture `pointerdown` remembers `e.target.closest(".dwell")`
// and, on release, fires `el.click()` 150 ms later — the click Windows owes a
// long press past ~600 ms. A shelf card's button IS a .dwell, so without this
// every completed hold would ALSO open the book underneath the sheet. Dropping
// .dwell inside our own handler is only worth anything if we get there FIRST,
// and the capture path is window -> document -> …: a capture listener on
// `window` runs before dwell.js's on `document`. dwell.js then finds no .dwell,
// records no tap, and schedules no rescue.
//
// AND WHY IT NEVER TOUCHES A TAP. A SHORT press is her book opening — the whole
// point of the shelf — so the native click path is left completely alone and the
// browser's own tap keeps working. What this module does instead is SWALLOW the
// click on the way out of a press that was a HOLD: the one a completed hold
// sends into whatever is now under the finger, and the one an ABANDONED long
// press would otherwise turn into an opened book. A quick tap is never swallowed
// and never replayed. The Windows press-and-hold furniture that preventDefault
// would have covered is handled where it belongs: `contextmenu` here, and
// touch-action / -webkit-touch-callout on .shelf-card in index.html.
//
// ONE DIFFERENCE FROM board-edit.js, and it is load bearing here. A board tile
// is always born awake, so the board's rearm() can simply add `.dwell` and
// remove `data-dwell-disabled`. A shelf card is NOT: reader.js draws a pile of
// photos and a book still being made with `.dwell` AND `data-dwell-disabled`
// together (the class so a grown-up's slow press and the contextmenu
// suppression still match, the attribute so her gaze can never arm on it). A
// rearm that removed the attribute unconditionally would WAKE one of those —
// a grown-up's hold handing her gaze the "Build a book" button, which is the
// one press in the reader that spends a family's AI allowance. So the press
// records what it found, BOTH halves, and gives back exactly that.
//
// THE FREEZE IS reader.js's, BORROWED. While the sheet is open the shelf and
// the bar's two doors sleep, because a full-screen backdrop hides nothing from
// dwell.js's targetAt() — it walks the whole elementsFromPoint stack for the
// first `.dwell:not([data-dwell-disabled])` and steps straight over anything
// without the class. reader.js already owns that switch for the Build ask
// (freezeShelf / thawShelf / LIVE_TARGETS) and lends it here rather than
// growing a second list over the same nodes: two switches over one list means
// the last one to close wakes what the other put to sleep.
//
// A classic script (reader.js is one, and the suites reach its globals), so
// everything is inside an IIFE: two classic scripts share one global scope and
// a bare `const sheet` here would be a name collision waiting for its turn.
(function () {
  "use strict";

  // The finger hold. THE TWIN of board-edit.js's HOLD_MS (which is itself the
  // twin of board-lock.js's): one number a grown-up has learned, now in three
  // modules that must not drift. Change one and change the others. It is not
  // the dwell contract's business — a gaze never opens this.
  var HOLD_MS = 1600;
  // Past ~600 ms Windows has committed the touch to its press-and-hold gesture
  // and stops owing the page a click (dwell.js's own comment). That is the
  // honest line between a tap and an abandoned hold: shorter and the browser's
  // own click is hers, untouched; longer and the press was a hold that changed
  // its mind, which fires nothing at all — so the click Chromium still sends on
  // release is swallowed.
  var TAP_MAX_MS = 600;
  var EXT = ".erabook";

  // The sentences. Every refusal a parent reads comes from the HUB (books-share.js
  // owns them, and it knows why better than we do); these two are for the states
  // the hub never hears about.
  var OFFLINE = "Couldn't reach New ERA — try again in a moment.";
  var UNKNOWN = "Something went wrong with that book, so New ERA did not send it.";
  // books-share.js's own words for a book with no manifest to walk. Said here
  // rather than fetched because there is nothing to ask the hub about: the card
  // itself is the answer, and a grown-up should not wait on a round trip to be
  // told a pile of photos is a pile of photos.
  var NOT_FINISHED = "This book isn't finished yet.";
  // Spec §4.2, in a parent's words. "New ERA Content" is drive.js's own name for
  // the folder its one-tap setup makes (drive.js CONTENT_FOLDER); the literal
  // path is in the hub's answer if anyone ever needs it, but a path is not a
  // sentence somebody can follow on their phone.
  var IN_DRIVE = "It's in your Google Drive, in New ERA Content › shared. " +
                 "Open Drive on your phone and send it to them.";
  var READYING = "Getting the book ready…";

  var press = null;        // the finger we are tracking
  var holdTimer = null;
  var sheet = null;        // the open sheet, or null
  var gridWatch = null;    // re-freeze after a repaint under an open sheet

  // ---- the shelf's own shapes ---------------------------------------------
  // A finished book's card carries `.shelf-card-button`; the two cards that are
  // not books yet (reader.js notYetCard: a pile of photos, a book being made)
  // carry `.shelf-card-box`. That is reader.js's own distinction, read rather
  // than restated — a second rule about which card is which would drift.
  function cardOf(target) {
    return (target && target.closest) ? target.closest("#shelfGrid .shelf-card") : null;
  }
  function buttonOf(card) {
    return card && (card.querySelector(".shelf-card-button") || card.querySelector(".shelf-card-box"));
  }
  function isFinished(card) {
    return !!(card && card.querySelector(".shelf-card-button"));
  }

  // What the sheet needs to show and to ask for, taken off the card itself: the
  // shelf already drew the cover and the title out of /books/index.json, and
  // reading them back is one source of truth rather than two.
  function bookOf(card) {
    var img = card.querySelector(".shelf-cover img");
    var name = card.querySelector(".shelf-title");
    var title = (name && name.textContent) || "";
    return {
      slug: card.dataset.slug || "",
      title: title,
      cover: (img && img.getAttribute("src")) || "",
      // Only ever the label on a download and the name in the canShare probe.
      // The bytes on disk are named by books-share.js's cleanName(), which is
      // the authority; this is the browser's copy of the same idea.
      filename: (title.replace(/[\\/:*?"<>|]/g, "").replace(/[\x00-\x1f\x7f]/g, "")
                      .replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "") || "book") + EXT,
    };
  }

  // ---- arm / disarm --------------------------------------------------------

  function disarm(p) {
    if (p.hadDwell) p.btn.classList.remove("dwell");
    p.btn.setAttribute("data-dwell-disabled", "");
  }
  // Exactly what was found, both halves — see the header. A pile card is born
  // asleep and must go back to sleep.
  function rearm(p) {
    if (!p.btn.isConnected) return;
    if (p.hadDwell) p.btn.classList.add("dwell");
    if (!p.hadDisabled) p.btn.removeAttribute("data-dwell-disabled");
  }

  function stopRing(p) {
    p.card.classList.remove("holding");
    p.card.style.removeProperty("--hold-ms");
  }

  function inside(el, e) {
    var r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  // Any grown-up's sheet already on screen owns the shelf — this one, the Add a
  // book sheet (reader-strip.js), or reader.js's Build ask. A second sheet over
  // the first would freeze a shelf that is already frozen and thaw it twice.
  function shelfBusy() {
    if (sheet) return true;
    if (document.querySelector(".grown-sheet")) return true;
    try { return !!(window.Reader && window.Reader.isAsking && window.Reader.isAsking()); }
    catch (e) { return false; }
  }

  function onDown(e) {
    // Mouse and pen do nothing — see the header: gaze IS the mouse here.
    if (e.pointerType !== "touch") return;
    if (press || shelfBusy()) return;              // one finger, one sheet
    var card = cardOf(e.target);
    if (!card) return;
    var btn = buttonOf(card);
    if (!btn) return;
    // NO preventDefault (see the header): the browser's own tap is hers and is
    // left exactly as it was. The contextmenu handler below is the half of the
    // Windows press-and-hold gesture that does have to be refused.
    press = { card: card, btn: btn, t0: Date.now(), id: e.pointerId,
              fired: false, ended: false, swallow: false,
              hadDwell: btn.classList.contains("dwell"),
              hadDisabled: btn.hasAttribute("data-dwell-disabled") };
    disarm(press);                                 // …before dwell.js's pointerdown looks
    card.classList.add("holding");
    // the fill runs on the CSS side off this one custom property, so the hold
    // length is stated once, here, from the contract.
    card.style.setProperty("--hold-ms", HOLD_MS + "ms");
    clearTimeout(holdTimer);
    holdTimer = setTimeout(fire, HOLD_MS);
  }

  // pointerup / pointercancel / pointerleave — board-edit.js's cancel set
  // exactly. On a touch pointer Chromium takes IMPLICIT POINTER CAPTURE at
  // pointerdown, so boundary events are suppressed for the duration and a finger
  // that drifts a few px inside a 330 px card never sees `pointerleave` at all;
  // the release point is checked against the card's own box instead.
  function onEnd(e) {
    if (!press || press.ended) return;
    if (e && e.pointerId != null && e.pointerId !== press.id) return;
    // This listens on `window` (it has to — see the header), so `pointerleave`
    // arrives here for every element on the page. Only the pressed card's own
    // leave is this press's business.
    if (e && e.type === "pointerleave" && e.target !== press.card) return;
    clearTimeout(holdTimer); holdTimer = null;
    var p = press;
    p.ended = true;
    if (!p.fired) {
      stopRing(p);
      rearm(p);
      // A QUICK press is still a tap: her shelf is not hold-only, so the
      // browser's own click goes through untouched and opens the book. A LONG
      // one that was let go is a hold that changed its mind — it opens nothing,
      // which on Chromium means eating the click the touch sequence sends
      // anyway. (On Windows past ~600 ms there is no click to eat, and dwell.js's
      // tap-rescue — the thing that would have invented one — never saw a .dwell
      // to remember. Both platforms end in the same silence.)
      var held = Date.now() - p.t0;
      if (held >= TAP_MAX_MS || !e || e.type !== "pointerup" ||
          !p.card.isConnected || !inside(p.card, e)) p.swallow = true;
      try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch (x) { /* bare page */ }
    }
    // Keep the claim alive a moment after the release: the click is still on its
    // way, and it belongs to this press, not to the shelf. The window is short
    // on purpose — a grown-up reaching straight for a button on the sheet that
    // just opened must not have that tap eaten by a click that never came.
    p.swallowUntil = Date.now() + 250;
    setTimeout(function () { if (press === p) press = null; }, 500);
  }

  // The release click of a hold lands on whatever is under the finger by then —
  // the card, or the sheet that just opened over it. So a press that was a HOLD
  // eats one click; a press that was a TAP eats none.
  function onClick(e) {
    if (!press || !press.swallow) return;
    if (press.swallowUntil && Date.now() > press.swallowUntil) { press.swallow = false; return; }
    press.swallow = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onContextMenu(e) {
    if (!press || press.ended) return;
    if (cardOf(e.target) === press.card) e.preventDefault();
  }

  function fire() {
    holdTimer = null;
    if (!press || press.ended) return;
    press.fired = true;
    press.swallow = true;          // the release click belongs to the hold, not the shelf
    stopRing(press);
    var card = press.card;
    // Hand the armed card back FIRST, so the sheet's freeze claims it like
    // every other card and the thaw gives it back with them. One list, one
    // owner, no special case.
    rearm(press);
    // Dad, 9/19: a pile of photos and a book still being made have no manifest
    // to walk, so there is nothing to send — and the sheet says so rather than
    // offering three buttons that would all refuse.
    openSheet(isFinished(card) ? bookOf(card) : null);
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
    var m = sheet.querySelector(".share-msg");
    if (m) { m.textContent = text || ""; m.classList.toggle("show", !!text); }
  }

  function enable(on) {
    if (!sheet) return;
    var bs = sheet.querySelectorAll(".share-out");
    for (var i = 0; i < bs.length; i++) bs[i].disabled = !on;
  }

  // NEVER A BUTTON THAT DOES NOTHING (spec §4.2). Asked with a REAL File,
  // because bare `canShare()` answers a different question — "can you share
  // anything at all?" — and answers it yes on browsers that refuse every file.
  // The probe carries the real name and type, which is what the platform
  // actually judges. Absent on the i13's Edge; the nicest path in the house
  // where it is there.
  function canShareFile(name) {
    try {
      if (!navigator.share || !navigator.canShare) return false;
      var probe = new File([new Blob([new Uint8Array([0])])], name,
                           { type: "application/octet-stream" });
      return !!navigator.canShare({ files: [probe] });
    } catch (e) { return false; }
  }

  // The hub's own sentence, whole. Every refusal on this path was written in
  // books-share.js for a parent to read; a code or a status number is not one.
  function sentenceOf(res) {
    return res.json().then(function (j) {
      return (j && typeof j.message === "string" && j.message) ||
             (j && typeof j.error === "string" && j.error.indexOf(" ") > 0 && j.error) || UNKNOWN;
    }, function () { return UNKNOWN; });
  }

  function openSheet(book) {
    if (sheet) return;
    sheet = mk("div", "grown-sheet");
    sheet.id = "shareSheet";
    sheet.setAttribute("role", "dialog");
    var card = mk("div", "share-card");

    if (book) {
      var cover = mk("div", "share-cover");
      if (book.cover) {
        var img = document.createElement("img");
        img.alt = "";
        img.onerror = function () { img.remove(); };
        img.src = book.cover;
        cover.appendChild(img);
      }
      // textContent, never innerHTML: a book's title is family text.
      card.append(cover, mk("div", "share-title", book.title));
      var outs = mk("div", "share-outs");
      // SPEC §4.2's ORDER, which is the order of how well the hardware actually
      // delivers them — not an alphabet and not a preference.
      if (canShareFile(book.filename)) {
        var send = mk("button", "share-out", "Send it now");
        send.id = "shareSend";
        send.addEventListener("click", function () { sendNow(book); });
        outs.append(send);
      }
      var drive = mk("button", "share-out primary", "Put it in my Drive");
      drive.id = "shareDrive";
      drive.addEventListener("click", function () { putInDrive(book); });
      var save = mk("button", "share-out", "Save a copy");
      save.id = "shareSave";
      save.addEventListener("click", function () { saveCopy(book); });
      outs.append(drive, save);
      card.append(outs);
    }
    // …and on a card that is not a finished book, NOTHING ELSE: no heading, no
    // cover, no buttons that would all refuse. Dad 9/19 — one sentence and a
    // way out (set below, once the message element exists).

    var msg = mk("div", "share-msg");
    card.append(msg);
    var foot = mk("div", "share-foot");
    var close = mk("button", "share-btn", "Close");
    close.id = "shareClose";
    close.addEventListener("click", function () { closeSheet(); });
    foot.append(close);
    card.append(foot);
    sheet.append(card);
    document.body.appendChild(sheet);
    if (!book) setMsg(NOT_FINISHED);

    freeze();
    // A repaint under an open sheet hands back fresh cards that all wear
    // .dwell — reader.js's own poll does it every twenty seconds while a book
    // is being made. board-arrange.js met this first and answered it the same
    // way: watch the grid and put the new cards straight back to sleep.
    var grid = document.getElementById("shelfGrid");
    if (grid && window.MutationObserver) {
      gridWatch = new MutationObserver(function () { if (sheet) freeze(); });
      gridWatch.observe(grid, { childList: true });
    }
  }

  function freeze() {
    try { if (window.Reader && window.Reader.freezeShelf) window.Reader.freezeShelf(sheet); }
    catch (e) { /* never a dead app (8/19): a sheet that cannot freeze still opens */ }
  }

  function closeSheet() {
    if (gridWatch) { gridWatch.disconnect(); gridWatch = null; }
    if (sheet) { sheet.remove(); sheet = null; }
    try { if (window.Reader && window.Reader.thawShelf) window.Reader.thawShelf(); } catch (e) {}
    // a finger (or a gaze) may be parked on a card as the sheet closes: give the
    // shelf a settle window so it does not inherit a hold nobody started.
    try { if (window.Dwell && window.Dwell.suppress) window.Dwell.suppress(600); } catch (e) {}
  }

  // ---- the three outs ------------------------------------------------------

  // The archive, as a File the page can hand to the platform. Export of a
  // forty-megabyte book off a tablet's disk is a second or two, not instant —
  // hence the line and the disabled buttons while it runs.
  function fetchBook(book) {
    return fetch("/books/" + encodeURIComponent(book.slug) + EXT).then(function (res) {
      if (!res.ok) return sentenceOf(res).then(function (s) { throw { said: s }; });
      return res.blob();
    }).then(function (blob) {
      return new File([blob], book.filename, { type: "application/octet-stream" });
    });
  }

  // A FAILURE KEEPS THE SHEET OPEN with a sentence a parent can act on (spec
  // §4.2). Never a stack, never a status code, never a silent nothing.
  function failed(e) {
    if (!sheet) return;
    setMsg((e && e.said) || OFFLINE);
    enable(true);
  }

  function busy() {
    setMsg(READYING);
    enable(false);
  }

  function sendNow(book) {
    busy();
    fetchBook(book).then(function (file) {
      return navigator.share({ files: [file], title: book.title });
    }).then(function () {
      closeSheet();                       // the platform took it from here
    }, function (e) {
      // A grown-up who backed out of the Windows share sheet has not had a
      // failure and must not be told they did.
      if (e && e.name === "AbortError") { setMsg(""); enable(true); return; }
      failed(e);
    });
  }

  // THE OUT THAT SURVIVES A FORTY-MEGABYTE BOOK, and the one dad named ("saves
  // it somewhere for sharing"): the bytes go into the family's own Drive folder,
  // which Google Drive for Windows uploads by itself — and then the sheet says
  // WHERE, because a file a parent cannot find is not a file they can send.
  function putInDrive(book) {
    busy();
    // application/json, and a body the hub drains: server.js's ownDoor() guards
    // this route on the content type (it writes into the family's folder), so a
    // bare POST would come back 403 and read as a fault.
    fetch("/books/" + encodeURIComponent(book.slug) + "/share-to-drive", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }).then(function (res) {
      if (!res.ok) return sentenceOf(res).then(function (s) { throw { said: s }; });
      return res.json().catch(function () { return {}; });
    }).then(function () {
      if (!sheet) return;
      setMsg(IN_DRIVE);
      enable(true);
    }, failed);
  }

  // For a grown-up browsing the hub from their own phone or PC rather than
  // standing at Rae's tablet. FETCHED rather than linked straight at the route,
  // because a refusal has to be a sentence on this sheet — a plain <a href>
  // would hand them a downloaded file containing the word "not-finished".
  function saveCopy(book) {
    busy();
    fetchBook(book).then(function (file) {
      var url = URL.createObjectURL(file);
      var a = document.createElement("a");
      a.href = url;
      a.download = book.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      if (!sheet) return;
      setMsg("Saved — look in this computer's downloads.");
      enable(true);
    }, failed);
  }

  // ---- mount ---------------------------------------------------------------

  // capture on WINDOW: ahead of era-core/dwell.js's document-capture handlers
  // (see the header — this is the whole reason the tap-rescue stays quiet).
  window.addEventListener("pointerdown", onDown, true);
  var ends = ["pointerup", "pointercancel", "pointerleave"];
  for (var i = 0; i < ends.length; i++) window.addEventListener(ends[i], onEnd, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("contextmenu", onContextMenu, true);

  // the suite's seam, mirroring window.__editTest: a test needs the hold it must
  // out-wait without restating 1600 anywhere of its own, and a door into the
  // sheet that does not depend on CDP.
  window.__shareTest = {
    holdMs: HOLD_MS,
    open: function (slug) {
      var card = document.querySelector('#shelfGrid .shelf-card[data-slug="' + slug + '"]');
      if (!card) return false;
      openSheet(isFinished(card) ? bookOf(card) : null);
      return true;
    },
    close: closeSheet,
    isOpen: function () { return !!sheet; },
  };
})();
