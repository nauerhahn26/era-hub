// invariants.mjs — contract-enforcing invariant audit for ANY app page.
//
// Phase 2.3 (shared-architecture-plan.md): generalizes the board pixel gate
// (board-pixel.test.mjs) from board-specific states into a page-agnostic audit
// driven entirely by public/lib/contract.js — the law. Given one or more app
// paths ("/", "/pencil/", "/board/"), it loads each HERMETICALLY against the
// live :8377 server (route /tts -> 503, /voices -> disabled, /log -> 204,
// window.__testHooks set before any page script) at every CONTRACT.gateViewports
// entry, and MEASURES THE DOM (never screenshots). Every measurement floor is
// derived from CONTRACT so nothing is invented here (whitelist principle).
//
// Importable:  import { runInvariants, auditPath } from "./invariants.mjs";
// CLI:         node tests/invariants.mjs /  /pencil/  /board/
//
// Laws enforced per visible .dwell target / page (see comments at each check):
//   1. size floor + fully on-screen + center not occluded + gap-or-adjacency
//   2. data-dwell-ms on the hold ladder (unknown-but-in-band = warn)
//   3. park corner is inert (not a .dwell target)
//   4. no h-scroll; font floors (44 absolute; 74 text-tile @1920 unless reduced)
//   5. word-integrity CSS on labels (word-break normal, no partial words)
//
// Terse violation/warn strings mirror board-pixel's style:
//   OFFSCREEN / OCCLUDED / MINGAP / HSCROLL / PARK_TARGET / SIZE /
//   FONT_MIN / FONT_FLOOR / BREAK_CSS / PARTIAL_WORD   (violations)
//   GAP / HOLD_ODD / FONT_REDUCED / FONT_SUB            (warns)

import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CONTRACT } from "../public/lib/contract.js";

export const BASE = process.env.INVARIANTS_BASE || "http://localhost:8377";

// ---------------------------------------------------------------------------
// FLOORS DERIVED FROM CONTRACT (stated derivations — nothing invented here).
// ---------------------------------------------------------------------------
const H = CONTRACT.holds;
const S = CONTRACT.sizes;

// Target size floor (law 1). Derivation: the smallest box that can still render
// ONE floor-height text line without clipping. A fontFloor (74px) glyph line at
// its natural ~1.16em box is ~86px tall; round up to a stable 5px grid => 90px.
// This equals the brief's "min(w,h) >= 90px at 1920". It sits far below the
// ~127px natural tile of a 12-wide 1920 row ((1920 - 2*40 sidePad - 11*28 gap)/12),
// so it flags only genuinely undersized targets, not normal layout variance.
// At narrower gate viewports tiles legitimately shrink, so the floor scales
// linearly with viewport width relative to the 1920 reference (=> 60px @1280).
const SIZE_FLOOR_1920 = Math.ceil((S.fontFloor * 1.16) / 5) * 5; // = 90

// The hold ladder (law 2): the real tile-hold rungs. navBonus(400) is a bonus,
// not a standalone hold; tuneMax(3000) is the ceiling; holdForDoor is a fn — all
// excluded from the ladder set. boardRuntimeMin(600) IS a valid hold (§E-6
// exception to the 800 floor), so it is a ladder rung. Exact match => OK; a
// value inside [floor, tuneMax] but off-ladder => warn (HOLD_ODD, listed);
// anything outside => violation (HOLD_OOR).
const HOLD_LADDER = [
  H.boardRuntimeMin, H.floor, H.supportRead, H.content,
  H.answer, H.backspace, H.clear, H.send, H.exit,
]; // 600, 800, 1000, 1200, 1600, 1800, 2000, 2200, 2400

// Config handed to the in-page MEASURE fn (page.evaluate can't import the module).
function measureConfig(vp) {
  return {
    sizeFloor: +(SIZE_FLOOR_1920 * (vp.w / 1920)).toFixed(1),
    is1920: vp.w >= 1920,
    fontMin: S.fontMin,        // 44 absolute floor
    fontFloor: S.fontFloor,    // 74 text-tile floor (@1920)
    photoFontMin: S.photoFontMin, // 24 photo-plate floor (exempt from text floors)
    gapFloor: S.gapFloor,      // 28 sliver boundary
    gapWarn: S.gapWarn,        // 34 warn boundary
    park: CONTRACT.parkCorner, // {x01, y01}
    ladder: HOLD_LADDER,
    holdBandLo: H.floor,       // 800
    holdBandHi: H.tuneMax,     // 3000
    adjEps: 1.5,               // touching/shared-edge tolerance (full-bleed rows)
  };
}

// ---------------------------------------------------------------------------
// MEASURE — runs INSIDE the page. Pure DOM measurement; returns plain data.
// Ported from board-pixel's helpers (vis/lbl/gap math) and generalized to any
// page: no board-specific classes, floors come from `C` (the measureConfig).
// ---------------------------------------------------------------------------
function MEASURE(C) {
  const vw = innerWidth, vh = innerHeight;
  const vis = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && cs.display !== "none" && cs.visibility !== "hidden" &&
      r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  };
  const lbl = (el) => el.id || el.getAttribute("aria-label") ||
    (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 18) || String(el.className).slice(0, 18);

  const targets = [...document.querySelectorAll(".dwell")].filter(
    (el) => vis(el) && !el.hasAttribute("data-dwell-disabled") && el.getAttribute("aria-disabled") !== "true");
  const rects = targets.map((el) => ({ el, r: el.getBoundingClientRect(), label: lbl(el) }));

  const violations = [], warns = [];
  const V = (code, detail) => violations.push({ code, detail });
  const W = (code, detail) => warns.push({ code, detail });

  // is this target a photo tile? (contract has an explicit photo-tile concept:
  // photoFontMin/photoPlateMin/photoLabelShare — text-tile font floors don't
  // apply; §E#20 "photo tiles are exempt".) Generic detection: the tile or its
  // label opts into the photo plate convention.
  const isPhoto = (el) =>
    el.matches(".photo, .tile.photo") || !!el.querySelector(".plate, .tile-label.plate");

  // --- law 1: size, on-screen, occlusion ---
  for (const { el, r, label } of rects) {
    const mn = Math.min(r.width, r.height);
    if (mn < C.sizeFloor - 0.5)
      V("SIZE", `${label} min=${mn.toFixed(0)}<${C.sizeFloor.toFixed(0)}`);
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5)
      V("OFFSCREEN", `${label} [${r.left.toFixed(0)},${r.top.toFixed(0)},${r.right.toFixed(0)},${r.bottom.toFixed(0)}]`);
    // center pixel must resolve to this target (not chrome/overlay on top of it)
    const cx = Math.min(vw - 1, Math.max(1, (r.left + r.right) / 2));
    const cy = Math.min(vh - 1, Math.max(1, (r.top + r.bottom) / 2));
    const top = document.elementsFromPoint(cx, cy)[0];
    if (top && top !== el && !el.contains(top) && !top.contains(el))
      V("OCCLUDED", `${label} by ${(top.id || String(top.className)).slice(0, 30)}`);
  }

  // --- law 1: gap-or-adjacency (never a sliver 1..gapFloor-1) ---
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i].r, b = rects[j].r;
    const dx = Math.max(a.left - b.right, b.left - a.right);
    const dy = Math.max(a.top - b.bottom, b.top - a.bottom);
    const d = (dx < 0 && dy < 0) ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    if (d <= C.adjEps) continue;             // touching / shared-edge => allowed (full-bleed rows)
    if (d < C.gapFloor - 0.5)
      V("MINGAP", `${rects[i].label}|${rects[j].label} ${d.toFixed(1)}`);
    else if (d < C.gapWarn - 0.5)
      W("GAP", `${rects[i].label}|${rects[j].label} ${d.toFixed(1)}`);
  }

  // --- law 2: data-dwell-ms on the hold ladder ---
  for (const { el, label } of rects) {
    const raw = el.getAttribute("data-dwell-ms");
    if (raw == null) continue;               // inherits engine default — not a per-tile claim
    const ms = Number(raw);
    if (!Number.isFinite(ms)) { V("HOLD_OOR", `${label} "${raw}"`); continue; }
    if (C.ladder.includes(ms)) continue;     // exact ladder rung => OK
    if (ms >= C.holdBandLo && ms <= C.holdBandHi) W("HOLD_ODD", `${label} ${ms}`);
    else V("HOLD_OOR", `${label} ${ms}`);
  }

  // --- law 3: park corner inert ---
  // Exception (ux-contract §B, 8/1): a page that DECLARES data-park-override on
  // <html> has moved the park to its own inert rest zone (it POSTs /app/park at
  // boot; /app/exit restores the corner). The Ring is the first such page — its
  // layout legitimately owns the corner, so the corner check doesn't apply.
  if (!document.documentElement.dataset.parkOverride) {
    const px = Math.min(vw - 1, Math.round(C.park.x01 * vw));
    const py = Math.min(vh - 1, Math.round(C.park.y01 * vh));
    const parkTop = document.elementFromPoint(px, py);
    const parkDwell = parkTop && parkTop.closest && parkTop.closest(".dwell");
    if (parkDwell && !parkDwell.hasAttribute("data-dwell-disabled") &&
        parkDwell.getAttribute("aria-disabled") !== "true")
      V("PARK_TARGET", `${lbl(parkDwell)} at ${(C.park.x01 * 100).toFixed(1)}/${(C.park.y01 * 100).toFixed(1)}%`);
  }

  // --- law 4: no horizontal scroll ---
  if (document.documentElement.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1)
    V("HSCROLL", `${Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)}>${vw}`);

  // --- law 4: font floors (measured on the tile's headline text element) ---
  // Effective text size = largest computed font-size among the target and its
  // descendants that carry direct visible text. No direct text => "no text" =>
  // skip (glyph-only/icon targets, e.g. an SVG door).
  const directText = (el) => {
    for (const n of el.childNodes)
      if (n.nodeType === 3 && /[A-Za-z0-9]/.test(n.textContent)) return true;  // READABLE text only (§20) — pure glyphs (door, speaker, backspace) are symbols, not reading
    return false;
  };
  for (const { el, label } of rects) {
    let fs = null, fsEl = null;
    for (const node of [el, ...el.querySelectorAll("*")]) {
      if (!vis(node) || !directText(node)) continue;
      const f = parseFloat(getComputedStyle(node).fontSize);
      if (f > (fs || 0)) { fs = f; fsEl = node; }
    }
    if (fs == null) continue;                // no text
    const reduced = (fsEl.dataset && fsEl.dataset.fontReduced === "1") ||
                    (el.dataset && el.dataset.fontReduced === "1");
    if (isPhoto(el)) {                        // photo tile: own floor only (§E#20 exempt)
      if (fs < C.photoFontMin - 0.5) V("FONT_MIN", `${label} photo ${fs.toFixed(0)}<${C.photoFontMin}`);
      continue;
    }
    if (fs < C.fontMin - 0.5) { V("FONT_MIN", `${label} ${fs.toFixed(0)}<${C.fontMin}`); continue; }
    if (fs < C.fontFloor - 0.5) {
      if (reduced) W("FONT_REDUCED", `${label} ${fs.toFixed(0)}`);      // marked fallback => allowed (listed)
      else if (C.is1920) V("FONT_FLOOR", `${label} ${fs.toFixed(0)}<${C.fontFloor}`); // room is plentiful @1920
      else W("FONT_SUB", `${label} ${fs.toFixed(0)}`);                  // tolerated at narrow viewports
    }
  }

  // --- law 5: word-integrity CSS on labels (port from board-pixel) ---
  // A label is any visible direct-text element inside a target: no break-word /
  // anywhere / hyphens (partial words are forbidden — she is learning to read),
  // and no horizontal overflow (a whole word never exceeds its line box).
  const seen = new Set();
  for (const { el } of rects) {
    for (const node of [el, ...el.querySelectorAll("*")]) {
      if (seen.has(node) || !vis(node) || !directText(node)) continue;
      seen.add(node);
      const cs = getComputedStyle(node);
      const t = (node.textContent || "").trim().slice(0, 16);
      if (cs.wordBreak !== "normal" || cs.hyphens === "auto" ||
          (cs.overflowWrap && cs.overflowWrap !== "normal"))
        V("BREAK_CSS", `${t} wb=${cs.wordBreak} ow=${cs.overflowWrap} hy=${cs.hyphens}`);
      if (node.scrollWidth > node.clientWidth + 1)
        V("PARTIAL_WORD", `${t} sw=${node.scrollWidth}>cw=${node.clientWidth}`);
    }
  }

  return { vw, vh, nTargets: rects.length, violations, warns };
}

// ---------------------------------------------------------------------------
// Driver — hermetic load of one path at one viewport, returns measurement.
// ---------------------------------------------------------------------------
// In-lesson state setups (Phase 3.1): each is a self-contained async fn passed to
// page.evaluate — it may only use the page's own globals (same entry calls the
// legacy suites use: sortfix.js drives startSort() this way). States let the
// audit measure the screens she actually works in, not just front doors.
export const STATES = [
  { id: "/", path: "/" },
  { id: "/#spell", path: "/", setup: async () => {         // mid-lesson spelling: stage + letter tray
      const db = await (await fetch("lessons.json")).json();
      buildDict(db);
      S.lesson = db.lessons.find((l) => l.lesson === 11); S.tts = false; S.part = "all";
      buildTray(S.lesson.letters, true);      // the real lesson path (studio.js:1284)
      show("stage"); startMakeWord();
      await new Promise((r) => setTimeout(r, 700));
    } },
  { id: "/#sort", path: "/", setup: async () => {          // sorting: heads + word stacks + choice tray
      const db = await (await fetch("lessons.json")).json();
      buildDict(db);
      S.lesson = db.lessons.find((l) => l.lesson === 11); S.tts = false; S.part = "all";
      show("stage"); startSort();
      await new Promise((r) => setTimeout(r, 400));
      const c = document.querySelectorAll("#bigRow .action")[0]; if (c) c.click();
      await new Promise((r) => setTimeout(r, 600));
    } },
  { id: "/pencil/", path: "/pencil/" },
  { id: "/pencil/#write", path: "/pencil/", setup: async () => {  // the Ring, groups page
      S.tts = false; showScreen("page"); renderGroups(); renderText();
      await new Promise((r) => setTimeout(r, 500));
    } },
  { id: "/pencil/#letters", path: "/pencil/", setup: async () => { // widest letter page (i-n)
      S.tts = false; showScreen("page"); renderGroups(); renderText(); openGroup(2);
      await new Promise((r) => setTimeout(r, 500));
    } },
  { id: "/board/", path: "/board/" },
];

async function measureAt(browser, path, vp, setup) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  // hermetic: no ElevenLabs, no logging, deterministic speech
  await ctx.route("**/log", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("**/outfit-event", (r) => r.fulfill({ status: 204, body: "" })); // hermetic: never write her real pick history
  await ctx.route("**/voices", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"enabled":false,"voices":[]}' }));
  await ctx.route("**/tts*", (r) => r.fulfill({ status: 503, body: "" }));
  await ctx.addInitScript(() => { window.__testHooks = true; }); // before any page script
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  const url = BASE + (path.startsWith("/") ? path : "/" + path);
  await page.goto(url, { waitUntil: "load" });
  // settle: wait for at least one dwell target if the page renders any (non-fatal)
  await page.waitForFunction(() => document.querySelectorAll(".dwell").length > 0, null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(400); // let fit/layout + any async render finish
  if (setup) await page.evaluate(setup);   // drive into an in-lesson state
  const m = await page.evaluate(MEASURE, measureConfig(vp));
  for (const e of pageErrors) m.violations.push({ code: "PAGEERROR", detail: e.slice(0, 120) });
  await ctx.close();
  return m;
}

const fmt = (arr) => arr.map((x) => `${x.code} ${x.detail}`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Audit one path across all CONTRACT.gateViewports.
// -> { path, viewports: [{ vp, nTargets, violations:[str], warns:[str] }],
//      violations:[str], warns:[str] }   (flat arrays tagged with @WxH)
export async function auditPath(browser, pathOrState) {
  const st = typeof pathOrState === "string" ? { id: pathOrState, path: pathOrState } : pathOrState;
  const viewports = [];
  const violations = [], warns = [];
  for (const vp of CONTRACT.gateViewports) {
    const m = await measureAt(browser, st.path, vp, st.setup);
    const tag = `@${vp.w}x${vp.h}`;
    const v = fmt(m.violations), w = fmt(m.warns);
    viewports.push({ vp, nTargets: m.nTargets, violations: v, warns: w });
    for (const s of v) violations.push(`${st.id}${tag} ${s}`);
    for (const s of w) warns.push(`${st.id}${tag} ${s}`);
  }
  return { path: st.id, viewports, violations, warns };
}

// Audit many paths. Launches/close its own browser unless one is supplied.
// -> { results: [auditPath...], violations:[str], warns:[str] }
export async function runInvariants(paths, { browser } = {}) {
  const own = !browser;
  browser = browser || (await chromium.launch());
  const results = [];
  try {
    for (const p of paths) results.push(await auditPath(browser, p));
  } finally {
    if (own) await browser.close();
  }
  return {
    results,
    violations: results.flatMap((r) => r.violations),
    warns: results.flatMap((r) => r.warns),
  };
}

// Codes that are LAWS every app (even pre-migration) must already satisfy.
export const HARD_CODES = ["OFFSCREEN", "HSCROLL", "PARK_TARGET", "PAGEERROR"];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  let paths = process.argv.slice(2);
  if (paths.length === 1 && paths[0] === "--states") paths = STATES;
  if (!paths.length) {
    console.error("usage: node tests/invariants.mjs <path> [<path>...]   e.g. / /pencil/ /board/");
    process.exit(2);
  }
  const { results } = await runInvariants(paths);
  let totalV = 0, totalW = 0;
  for (const r of results) {
    console.log(`\n=== ${r.path} ===`);
    for (const v of r.viewports) {
      console.log(`  ${v.vp.w}x${v.vp.h}: targets=${v.nTargets} violations=${v.violations.length} warns=${v.warns.length}`);
      for (const s of v.violations) console.log(`    ✗ ${s}`);
      for (const s of v.warns) console.log(`    ~ ${s}`);
      totalV += v.violations.length; totalW += v.warns.length;
    }
  }
  console.log(`\n---------------------------------------------\nTOTAL: ${totalV} violations, ${totalW} warns across ${paths.length} path(s)`);
  process.exit(totalV ? 1 : 0);
}

if (import.meta.url === `file://${fileURLToPath(import.meta.url)}` &&
    process.argv[1] && process.argv[1].endsWith("invariants.mjs")) {
  main().catch((e) => { console.error(e); process.exit(3); });
}
