// The touch "Hold to ask" path stays exactly as shipped (button press to ask,
// design 2026-10-27 §2; plan T0.3). The text of beginAsk, finishAsk, cancelAsk
// and the line that binds them to the Ask button is hashed against a fixture
// written once, before any button-press page work. To change these functions,
// amend the design first, then rewrite the fixture in the same commit.
// Since the 10/28 sync of master the fixture guards master's v1.0.31 hold path
// (no Start Chat, a slipped hold keeps the session); the press path never edits it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const app = readFileSync(new URL('../public/chat/app.js', import.meta.url), 'utf8');
const fixture = new URL('./fixtures/chat-hold-path.sha256', import.meta.url);

// A top-level function's text: its header up to the first closing brace at column 0.
function functionText(source, header) {
  const at = source.indexOf(header);
  assert.ok(at >= 0, `${header} is in public/chat/app.js`);
  assert.equal(source.indexOf(header, at + 1), -1, `${header} appears once`);
  const end = source.indexOf('\n}\n', at);
  assert.ok(end > at, `${header} has a closing brace at column 0`);
  return source.slice(at, end + 2);
}
const BIND = "touchButton($('ask'), beginAsk, finishAsk, cancelAsk);";

function holdPathHash(source = app) {
  const pieces = ['async function beginAsk() {', 'async function finishAsk() {', 'function cancelAsk() {'].map(header => functionText(source, header));
  const lines = source.split('\n').filter(line => line === BIND);
  assert.equal(lines.length, 1, 'the Ask button binding is one line, at column 0');
  return createHash('sha256').update([...pieces, BIND].join('\n\u0000\n')).digest('hex');
}

test('the hold path (beginAsk, finishAsk, cancelAsk and the Ask binding) is unchanged', () => {
  const expected = readFileSync(fixture, 'utf8').trim();
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(holdPathHash(), expected, 'the hold path changed — design §2 says it stays as shipped');
});

test('the pin notices a one-character change in any pinned piece', () => {
  const pinned = holdPathHash();
  for (const [from, to] of [["controller.ask(); finishedTurn = -1;", "controller.ask(); finishedTurn = -2;"],
    ["metrics.mark(timing, 'drained');", "metrics.mark(timing, 'drain');"],
    ["dropHold({ reason: 'cancel', hint: HINT_SLIP });", "dropHold({ reason: 'cancel', hint: HINT_SHORT });"]]) {
    assert.ok(app.includes(from), from);
    assert.notEqual(holdPathHash(app.replace(from, to)), pinned, from);
  }
  assert.throws(() => holdPathHash(app.replace(BIND, "touchButton($('ask'), beginAsk, finishAsk);")));
});
