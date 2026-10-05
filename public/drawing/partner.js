/*
 * partner.js — the grown-up's side of Drawing (spec 2026-09-30 §2.4).
 *
 * A tab at the right of the shared door bar (the one slot doorbar.js lets a touch-only control
 * have — board-partner.js's strip), just LEFT of her 🗑 Trash tile in the corner (dad 10/4), opens one sheet: dwell tune, Clear picture (two stages,
 * spoken), and the last Done's mail truth. And a FINGER may drag a sticker she placed to move it —
 * also one she is carrying with her gaze (touch wins, spec 2026-10-02 §6); ink is never dragged.
 * Nothing here is .dwell or carries a data-dwell-*: ERAgaze moves a MOUSE, so her gaze can never
 * open the sheet or drag a sticker.
 */
"use strict";
(function () {
  const D = window.Drawing;
  const $ = (id) => document.getElementById(id);
  const sheet = $("partnerSheet");

  const tab = document.createElement("button");
  tab.type = "button";
  tab.id = "partnerTab";
  tab.textContent = "⚙ grown-ups";                 // deliberately NO .dwell, NO data-dwell-*
  const bar = document.querySelector(".msgbar");
  if (bar) bar.insertBefore(tab, document.getElementById("trashTile"));   // left of the 🗑 (null: the end)

  let clearArmed = false;
  function paint() {
    $("pDwell").textContent = D.dwellMs() + " ms";
    $("pMail").textContent = D.mailLine();
    $("pClearRow").hidden = D.state().screen !== "ring";
    $("pClear").textContent = clearArmed ? "Clear the whole picture?" : "🗑 Clear picture";
    $("pClearYes").hidden = !clearArmed;
    $("pPeople").hidden = !(D.state().screen === "ring" && D.state().people.length === 0);
  }
  function open() { if (!sheet.hidden) return; clearArmed = false; D.freeze(); sheet.hidden = false; paint(); }
  function close() { if (sheet.hidden) return; sheet.hidden = true; clearArmed = false; D.thaw(); }
  tab.addEventListener("click", () => (sheet.hidden ? open() : close()));
  $("pClose").addEventListener("click", close);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });     // the backdrop
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  $("pSlower").addEventListener("click", () => { D.tuneDwell(+200); paint(); });
  $("pFaster").addEventListener("click", () => { D.tuneDwell(-200); paint(); });
  $("pClear").addEventListener("click", () => {
    if (clearArmed) return;
    clearArmed = true;
    paint();
    D.say("Clear the whole picture?");
  });
  $("pClearYes").addEventListener("click", async () => {
    clearArmed = false;
    paint();
    await D.clearPicture();
  });
  D.onMail(() => { if (!sheet.hidden) paint(); });

  // ---- the finger drag: pointerType "touch" only (a mouse = her gaze, never drags) ----
  const scene = $("scene");
  let drag = null;
  scene.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    // Trash on (dad 10/5): a finger REMOVES what it touches — its click is her dwell (tap parity), so it
    // never starts a drag here. A drag's end swallowed that click (a roll of a px or two is a "move").
    if (D.state().trash) return;
    const carrying = D.state().carrying;
    let i;
    if (carrying !== null) {
      // While she carries something, a finger ON it takes it (touch wins); anywhere else the tap is her
      // landing (drawing.js). Hit-tested by the art's own box: the spot may lie on top of it.
      const art = scene.querySelector('#art [data-i="' + carrying + '"]'), r = art && art.getBoundingClientRect();
      if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      i = carrying;
    } else {
      const el = e.target && e.target.closest ? e.target.closest("[data-i], [data-hit]") : null;
      if (!el || !scene.contains(el)) return;
      i = Number(el.hasAttribute("data-hit") ? el.getAttribute("data-hit") : el.getAttribute("data-i"));
    }
    let it = D.itemAt(i);
    if (!it || it.s === "stroke") return;                     // ink is never dragged
    const wasCarried = carrying === i;
    if (wasCarried) { const c = D.releaseCarry(); if (c) it = { ...it, x: c.x, y: c.y }; }
    const art = scene.querySelector('#art [data-i="' + i + '"]');
    if (!art) return;
    e.preventDefault();
    drag = { i, id: e.pointerId, el: art, x0: e.clientX, y0: e.clientY, it, r: scene.getBoundingClientRect(),
             nx: it.x, ny: it.y, moved: false, wasCarried };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  });
  scene.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const c = D.clamp({ x: drag.it.x + (e.clientX - drag.x0) / drag.r.width,
                        y: drag.it.y + (e.clientY - drag.y0) / drag.r.height, w: drag.it.w });
    drag.nx = c.x; drag.ny = c.y; drag.moved = true;
    drag.el.style.transform = `translate(${(c.x - drag.it.x) * drag.r.width}px, ${(c.y - drag.it.y) * drag.r.height}px)`;
  });
  const end = (commit) => (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    // One "move" in her history. Swallow the click a drag's release may still produce — a cancel's
    // too (Windows' press-and-hold: dwell.js's long-press rescue clicks the picture): it must never
    // lift the item again, start a stroke in Draw mode, or land something (spec 2026-10-02 §6;
    // review 10/3 #4). A plain tap (up, unmoved) keeps its click: touch parity.
    const moved = d.moved || d.wasCarried;
    if (!commit || moved) D.swallowClicks(400);
    if (commit && moved) D.moveItem(d.i, d.nx, d.ny);
    else D.repaint();
  };
  scene.addEventListener("pointerup", end(true));
  scene.addEventListener("pointercancel", end(false));
  scene.addEventListener("contextmenu", (e) => e.preventDefault());
})();
