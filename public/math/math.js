import { mountDoorBar } from '../lib/doorbar.js';
import { createState, restoreState, serializeState, navigate, step, transfer,
  selectNumber, numberWord, quantityGroups, pickerNumbers, STORAGE_KEY } from './state.js';

const appLocked = () => window.AppLock?.isLocked() || false;
const screen = document.getElementById('mathScreen');
const dwellOrigins = new WeakSet();
let S = createState();
try { S = restoreState(localStorage.getItem(STORAGE_KEY)); } catch { /* storage may be unavailable */ }
let bar, canvas, renderedView = '', ready = false;
let paused = false, gone = false;
let generation = 0, counting = false, countIndex = -1, modelTimer = null, modelResolve = null;

function persist() {
  try { localStorage.setItem(STORAGE_KEY, serializeState(S)); } catch { /* exploration stays usable */ }
}

function log(event, input = 'unknown', extra = {}, keepalive = false) {
  const body = { app: 'math', event, input, support: 'unknown', view: S.view,
    number: S.number, whole: S.whole, left: S.left, right: S.whole - S.left, ...extra };
  try { fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), ...(keepalive ? { keepalive: true } : {}) }).catch(() => {}); } catch {}
}

function stopActivity() {
  generation++;
  counting = false;
  countIndex = -1;
  if (modelTimer !== null) { clearTimeout(modelTimer); modelTimer = null; }
  if (modelResolve) { const resolve = modelResolve; modelResolve = null; resolve(); }
  screen.querySelectorAll('.counting').forEach(el => el.classList.remove('counting'));
  if (canvas) canvas.classList.remove('total-emphasis');
  try { if (window.Speech) window.Speech.stop(); } catch {}
}

function visualBeat() {
  // Only a missing voice needs a visual rhythm; spoken models follow speech completion.
  return new Promise(resolve => {
    modelResolve = resolve;
    modelTimer = setTimeout(() => { modelTimer = null; modelResolve = null; resolve(); }, 450);
  });
}

async function say(text, model = false) {
  if (appLocked()) return;
  try {
    if (window.Speech) await window.Speech.say(text, 'long');
  } catch { /* quantities and written words remain available */ }
  if (model && (!window.Speech || window.Speech.mode() === 'off')) await visualBeat();
}

function suppress() {
  try {
    if (!window.Dwell) return;
    // A visibility event must not shorten the shared door bar's longer return pause.
    const remaining = window.Dwell.state().suppressedMs;
    window.Dwell.suppress(Math.max(remaining, window.Dwell.config.settleMs));
  } catch {}
}

function syncDwell() {
  if (!window.Dwell) return;
  // A pending Talk request can leave this page visible. Freeze its math while
  // keeping the shared Exit door available by gaze if the request never finishes.
  for (const control of screen.querySelectorAll('.math-control')) {
    if (appLocked() || paused || control.disabled) control.setAttribute('data-dwell-disabled', '');
    else control.removeAttribute('data-dwell-disabled');
  }
  if (gone || document.visibilityState !== 'visible') window.Dwell.disable();
  else window.Dwell.enable();
}

function button(action, lines, { nav = false, symbol = '', number, range } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'math-control dwell' + (nav ? ' nav' : '');
  el.dataset.action = action;
  if (number !== undefined) el.dataset.number = String(number);
  if (range !== undefined) el.dataset.range = String(range);
  el.setAttribute('aria-label', lines.join(' '));
  el.dataset.dwellSay = lines.join(' ');
  if (symbol) {
    const glyph = document.createElement('span');
    glyph.className = 'symbol'; glyph.setAttribute('aria-hidden', 'true'); glyph.textContent = symbol;
    el.append(glyph);
  }
  for (const line of lines) {
    const span = document.createElement('span'); span.className = 'label-line'; span.textContent = line; el.append(span);
  }
  el.addEventListener('click', event => {
    const input = dwellOrigins.has(el) ? 'gaze' : event.isTrusted ? (event.detail ? 'pointer' : 'keyboard') : 'unknown';
    dwellOrigins.delete(el);
    actionFor(action, number !== undefined ? number : range, input);
  });
  return el;
}

function rest() {
  const el = document.createElement('div'); el.className = 'math-rest'; el.setAttribute('aria-hidden', 'true'); return el;
}

function disable(action, off) {
  const el = screen.querySelector(`[data-action="${action}"]`);
  if (!el) return;
  el.disabled = off;
  if (off) el.setAttribute('data-dwell-disabled', ''); else el.removeAttribute('data-dwell-disabled');
}

function renderShell() {
  screen.replaceChildren();
  canvas = null;
  if (S.view === 'menu') {
    const menu = document.createElement('section'); menu.className = 'math-menu';
    menu.append(button('numbers', ['Numbers'], { symbol: '1 2 3' }),
      button('partners', ['Number', 'partners'], { symbol: '3 + 4' }), rest());
    screen.append(menu);
  } else if (S.view === 'picker' || S.view === 'ranges') {
    const grid = document.createElement('section'); grid.className = 'number-picker';
    grid.setAttribute('aria-label', S.view === 'ranges' ? 'Choose a number range' : 'Pick a number');
    const seats = Array.from({ length: 16 }, rest);
    seats[0] = button('back', ['Back'], { nav: true });
    if (S.view === 'picker') {
      pickerNumbers(S.rangeStart, S.returnView).forEach((n, i) => {
        if (n === null) return;
        const el = button('select-number', [String(n)], { number: n }); el.classList.add('numeral-choice'); seats[i + 1] = el;
      });
      seats[12] = button('ranges', ['Other', 'numbers'], { nav: true });
    } else {
      const max = 50;
      for (let start = 0; start <= max; start += 10) {
        const end = Math.min(max, start + 9);
        const label = start === end ? String(start) : `${start}–${end}`;
        const el = button('select-range', [label], { range: start });
        el.classList.add('range-choice'); seats[start / 10 + 1] = el;
      }
    }
    grid.append(...seats); screen.append(grid);
  } else {
    const workspace = document.createElement('section'); workspace.className = 'workspace';
    const left = document.createElement('nav'); left.className = 'math-rail'; left.setAttribute('aria-label', 'Math controls');
    left.append(button('back', ['Back'], { nav: true }), button('pick', ['Pick a', 'number']), button('count', ['Count']));
    canvas = document.createElement('section'); canvas.id = 'mathStage'; canvas.className = 'math-canvas';
    const right = document.createElement('div'); right.className = 'math-rail';
    if (S.view === 'numbers') right.append(button('more', ['One', 'more'], { symbol: '+1' }), button('fewer', ['One', 'fewer'], { symbol: '−1' }), rest());
    else right.append(button('move-left', ['Move', 'left'], { symbol: '←' }), button('move-right', ['Move', 'right'], { symbol: '→' }), rest());
    workspace.append(left, canvas, right); screen.append(workspace);
  }
  // In every view the screen's literal bottom-right remains black, outside all targets.
  renderedView = S.view;
  suppress();
}

function textElement(className, text) {
  const el = document.createElement('div'); el.className = className; el.textContent = text; return el;
}

function frame(quantity, firstIndex, className = 'ten-frame') {
  const el = document.createElement('div'); el.className = className; el.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 10; i++) {
    const cell = document.createElement('div'); cell.className = 'math-cell';
    if (i < quantity) {
      const counter = document.createElement('span'); counter.className = 'math-counter';
      counter.dataset.countIndex = String(firstIndex + i); cell.append(counter);
    }
    el.append(cell);
  }
  return el;
}

function paintQuantity() {
  if (!canvas) return;
  canvas.replaceChildren();
  canvas.className = 'math-canvas' + (S.view === 'partners' ? ' partners-canvas' : '');
  if (S.view === 'numbers') {
    canvas.setAttribute('aria-label', `${numberWord(S.number)}. ${S.number} objects.`);
    canvas.append(textElement('math-numeral', String(S.number)), textElement('math-number-word', numberWord(S.number)));
    const groups = document.createElement('div'); const values = quantityGroups(S.number);
    groups.className = 'math-groups' + (values.length > 2 ? ' many' : '');
    groups.style.setProperty('--frame-rows', String(values.length > 2 ? Math.ceil(values.length / 2) : values.length));
    values.forEach((q, i) => groups.append(frame(q, i * 10)));
    canvas.append(groups);
    if (S.number > 10) canvas.append(textElement('place-value', `${Math.floor(S.number / 10)} ${Math.floor(S.number / 10) === 1 ? 'ten' : 'tens'} + ${S.number % 10} ones`));
    disable('more', S.number === 50); disable('fewer', S.number === 0);
  } else {
    const right = S.whole - S.left;
    canvas.setAttribute('aria-label', `Whole ${S.whole}. Left part ${S.left}. Right part ${right}.`);
    canvas.append(textElement('whole-number', String(S.whole)));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('math-branches'); svg.setAttribute('viewBox', '0 0 650 96'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M325 0V18L85 85M325 18L565 85'); svg.append(path); canvas.append(svg);
    const parts = document.createElement('div'); parts.className = 'math-parts';
    for (const [side, n, index] of [['left', S.left, 0], ['right', right, S.left]]) {
      const part = document.createElement('div'); part.className = `math-part ${side}`;
      const groups = document.createElement('div'); const quantities = quantityGroups(n);
      groups.className = 'part-groups';
      groups.style.setProperty('--part-rows', String(quantities.length));
      quantities.forEach((q, i) => groups.append(frame(q, index + i * 10, 'part-tray')));
      part.append(textElement('part-number', String(n)), groups); parts.append(part);
    }
    canvas.append(parts, textElement('math-equation', `${S.left} + ${right} = ${S.whole}`));
    disable('move-left', right === 0); disable('move-right', S.left === 0);
  }
}

function render(force = false) {
  // Quantity changes replace passive content only. Replacing action buttons here would
  // destroy the shared engine's target identity and risk a repeated stationary selection.
  if (force || renderedView !== S.view) renderShell();
  paintQuantity();
}

async function count(input) {
  if (appLocked()) return;
  const myGeneration = generation, total = S.view === 'partners' ? S.whole : S.number;
  counting = true;
  log('count', input, { support: 'model', total });
  const counters = [...screen.querySelectorAll('.math-counter')];
  for (let i = 0; i < counters.length; i++) {
    if (myGeneration !== generation) return;
    countIndex = i; counters[i].classList.add('counting');
    await say(numberWord(i + 1), true);
    if (myGeneration !== generation) return;
    counters[i].classList.remove('counting');
  }
  if (myGeneration !== generation) return;
  countIndex = -1;
  if (canvas) canvas.classList.add('total-emphasis');
  await say(total === 0 ? 'Zero. No objects.' : `${numberWord(total)} altogether.`, true);
  if (myGeneration !== generation) return;
  counting = false;
  log('count-complete', input, { support: 'model', total });
}

function actionFor(action, arg, input = 'unknown') {
  if (appLocked() || paused || gone || document.visibilityState !== 'visible') return;
  stopActivity();
  if (action === 'count') {
    if (S.view === 'numbers' || S.view === 'partners') void count(input);
    return;
  }
  const before = S;
  if (action === 'more' || action === 'fewer') S = step(S, action === 'more' ? 1 : -1);
  else if (action === 'move-left' || action === 'move-right') S = transfer(S, action === 'move-left' ? 'left' : 'right');
  else if (action === 'select-number') S = selectNumber(S, arg);
  else if (action === 'select-range') S = navigate(S, 'range', arg);
  else S = navigate(S, action, arg);
  persist();
  const pickerChanged = ['picker', 'ranges'].includes(S.view) && (S.view !== before.view || S.rangeStart !== before.rangeStart);
  render(pickerChanged);
  log(action, input);
  if (before.number !== S.number || action === 'select-number' && S.view === 'numbers') void say(numberWord(S.number));
  else if (before.left !== S.left || before.whole !== S.whole || action === 'select-number' && S.view === 'partners')
    void say(`${numberWord(S.left)} and ${numberWord(S.whole - S.left)} make ${numberWord(S.whole)}.`);
  else if (action === 'numbers') void say('Numbers');
  else if (action === 'partners') void say('Number partners');
}

document.addEventListener('dwell:activate', event => { if (event.target instanceof Element) dwellOrigins.add(event.target); });

bar = mountDoorBar(document.body, {
  appPath: '/math/',
  onLock() { stopActivity(); persist(); syncDwell(); },
  onUnlock() { syncDwell(); },
  onLeave() { stopActivity(); gone = true; syncDwell(); persist(); log('exit', 'unknown', {}, true); },
  onPause() { stopActivity(); paused = true; syncDwell(); persist(); log('talk', 'unknown', {}, true); },
  onResume() { stopActivity(); paused = false; syncDwell(); log('resume'); },
});
render();
persist();
ready = true;

window.MathApp = {
  state: () => ({ ...S, ready, counting, countIndex, paused, right: S.whole - S.left }),
  storageKey: STORAGE_KEY,
};
if (window.__testHooks) window.MathApp.action = (name, arg) => actionFor(name, arg, 'test');

try {
  if (window.Speech) Promise.resolve(window.Speech.init('Math')).then(mode => {
    document.getElementById('voiceWarning').hidden = mode !== 'off';
  }).catch(() => {});
} catch {}

fetch('/settings').then(r => r.ok ? r.json() : null).then(settings => {
  if (!settings) return;
  if (Number.isFinite(settings.dwellMs) && settings.dwellMs > 0) {
    if (window.Dwell) window.Dwell.setMs(settings.dwellMs);
    bar.setDwell(settings.dwellMs);
  }
  if (window.Dwell && Number.isFinite(settings.settleMs)) window.Dwell.set({ settleMs: Math.max(0, Math.min(2000, settings.settleMs)) });
  bar.setPause(settings.pauseGoes === 'tdsnap');
}).catch(() => { /* local defaults remain available */ });

addEventListener('resize', () => { stopActivity(); bar.sizeBar(); suppress(); });
addEventListener('pagehide', () => { stopActivity(); persist(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { stopActivity(); persist(); }
  syncDwell();
  if (document.visibilityState === 'visible' && !paused && !gone) suppress();
});
log('open');
