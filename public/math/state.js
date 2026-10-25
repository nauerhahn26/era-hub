// Math state: quantities and two parts of a fixed whole. No browser dependencies.
export const STORAGE_KEY = 'era.math.v1';
const VIEWS = ['menu', 'numbers', 'partners', 'picker', 'ranges'];
const WORKSPACES = ['numbers', 'partners'];
const integerIn = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function createState() {
  return { version: 1, view: 'menu', number: 7, whole: 7, left: 3,
    returnView: 'numbers', rangeStart: 0 };
}

export function restoreState(raw) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || Array.isArray(s) || s.version !== 1 || !VIEWS.includes(s.view) ||
        !integerIn(s.number, 0, 50) || !integerIn(s.whole, 0, 10) ||
        !integerIn(s.left, 0, s.whole) || !WORKSPACES.includes(s.returnView) ||
        !integerIn(s.rangeStart, 0, 50) || s.rangeStart % 10 !== 0 ||
        (['picker', 'ranges'].includes(s.view) && s.returnView === 'partners' && s.rangeStart > 10))
      return createState();
    return { version: 1, view: s.view, number: s.number, whole: s.whole,
      left: s.left, returnView: s.returnView, rangeStart: s.rangeStart };
  } catch { return createState(); }
}

export function serializeState(state) { return JSON.stringify(restoreState(state)); }

export function navigate(s, action, rangeStart) {
  if (WORKSPACES.includes(action)) return { ...s, view: action };
  if (action === 'pick' && WORKSPACES.includes(s.view)) {
    const n = s.view === 'partners' ? s.whole : s.number;
    return { ...s, view: 'picker', returnView: s.view, rangeStart: Math.floor(n / 10) * 10 };
  }
  if (action === 'ranges' && s.view === 'picker') return { ...s, view: 'ranges' };
  if (action === 'range' && s.view === 'ranges' && integerIn(rangeStart, 0,
      s.returnView === 'partners' ? 10 : 50) && rangeStart % 10 === 0)
    return { ...s, view: 'picker', rangeStart };
  if (action === 'back') {
    if (s.view === 'ranges') return { ...s, view: 'picker' };
    if (s.view === 'picker') return { ...s, view: s.returnView };
    if (WORKSPACES.includes(s.view)) return { ...s, view: 'menu' };
  }
  return s;
}

export function step(s, delta) {
  return s.view === 'numbers' && (delta === 1 || delta === -1)
    ? { ...s, number: Math.max(0, Math.min(50, s.number + delta)) } : s;
}

export function transfer(s, direction) {
  if (s.view !== 'partners' || !['left', 'right'].includes(direction)) return s;
  return { ...s, left: Math.max(0, Math.min(s.whole, s.left + (direction === 'left' ? 1 : -1))) };
}

export function selectNumber(s, n) {
  if (s.view !== 'picker' || !integerIn(n, 0, s.returnView === 'partners' ? 10 : 50)) return s;
  return s.returnView === 'partners'
    ? { ...s, view: 'partners', whole: n, left: Math.floor(n / 2) }
    : { ...s, view: 'numbers', number: n };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
export function numberWord(n) {
  if (!integerIn(n, 0, 50)) return '';
  if (n < 20) return WORDS[n];
  return ['', '', 'twenty', 'thirty', 'forty', 'fifty'][Math.floor(n / 10)] +
    (n % 10 ? '-' + WORDS[n % 10] : '');
}

export function quantityGroups(n) {
  if (!integerIn(n, 0, 50)) return [];
  return Array.from({ length: Math.max(1, Math.ceil(n / 10)) }, (_, i) => Math.min(10, n - i * 10));
}

export function pickerNumbers(start, mode) {
  const max = mode === 'partners' ? 10 : 50;
  return Array.from({ length: 10 }, (_, i) => integerIn(start, 0, max) && start % 10 === 0 && start + i <= max ? start + i : null);
}
