/*
 * partner.js — the grown-up's side of Drawing (spec 2026-09-30 §2.4).
 *
 * A tab at the RIGHT end of the shared door bar (the one slot doorbar.js lets a touch-only control
 * have — board-partner.js's strip) opens one sheet: dwell tune, Clear picture (two stages,
 * spoken), and the last Done's mail truth. And a FINGER may drag a sticker she placed to move it.
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
  if (bar) bar.appendChild(tab);

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
    const el = e.target && e.target.closest ? e.target.closest("[data-i]") : null;
    if (!el || !scene.contains(el)) return;
    const i = Number(el.getAttribute("data-i")), it = D.itemAt(i);
    if (!it) return;
    e.preventDefault();
    drag = { i, id: e.pointerId, el, x0: e.clientX, y0: e.clientY, it,
             r: scene.getBoundingClientRect(), nx: it.x, ny: it.y, moved: false };
    try { el.setPointerCapture(e.pointerId); } catch {}
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
    if (commit && d.moved) D.moveItem(d.i, d.nx, d.ny);    // one "move" in her history, autosaved
    else D.repaint();
  };
  scene.addEventListener("pointerup", end(true));
  scene.addEventListener("pointercancel", end(false));
  scene.addEventListener("contextmenu", (e) => e.preventDefault());
})();
