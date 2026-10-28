// The button-press listening window (design 2026-10-27 §4.4; plan T3.1, T3.3):
// a pure state machine with an injected clock. A press opens a window; speech
// is cut into utterances; each one that sounds complete seals (its words join
// the window's text and a choice request runs on the whole window text); the
// window closes on her pick, a second press, 10 s without new words, 60 s, or
// a cancel. Nothing said submits nothing. No sockets, no page, no timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createWindow, energyGate, WINDOW_LIMITS } = require('../chat-window.js');

function machine(limits = {}, { drain } = {}) {
  let now = 1000;
  const seals = [], closes = [];
  const w = createWindow({ clock: () => now, limits, seal: info => seals.push(info), close: (reason, info) => closes.push({ reason, ...info }), ...(drain ? { drain } : {}) });
  const at = ms => { now = 1000 + ms; w.tick(); };
  // n frames of 100 ms each: energetic or quiet, the clock moving with them.
  const frames = (n, energetic) => { for (let i = 0; i < n; i++) { now += 100; w.speech(energetic); } };
  return { w, seals, closes, at, frames, get now() { return now; } };
}

test('the limits are the design §4.4 numbers', () => {
  assert.deepEqual({ ...WINDOW_LIMITS }, { quietFrames: 15, speechFrames: 2, utteranceMs: 15000, silenceMs: 10000, capMs: 60000 });
  assert.ok(Object.isFrozen(WINDOW_LIMITS));
});

test('the service end of turn seals the utterance; the choice text is the whole window text; listening continues', () => {
  const m = machine();
  m.frames(5, true);
  m.w.partial('do you want chicken');
  m.w.partial('do you want chicken or fish');
  m.w.turnEnd('do you want chicken or fish');
  assert.deepEqual(m.seals, [{ seq: 1, text: 'do you want chicken or fish', windowText: 'do you want chicken or fish', reason: 'turn-end' }]);
  assert.equal(m.w.state, 'open');
  m.frames(4, true);
  m.w.partial('do you want chicken or fish or pasta');
  m.w.turnEnd('or pasta');
  assert.deepEqual(m.seals[1], { seq: 2, text: 'or pasta', windowText: 'do you want chicken or fish or pasta', reason: 'turn-end' });
  assert.equal(m.closes.length, 0);
});

test('a turn end with no partial before it still joins the window text', () => {
  const m = machine();
  m.w.turnEnd('chicken or fish');
  m.w.turnEnd('or pasta');
  assert.deepEqual(m.seals.map(s => s.windowText), ['chicken or fish', 'chicken or fish or pasta']);
});

test('silence after speech seals: 15 quiet frames after at least 2 energetic ones (the fallback when no end of turn comes)', () => {
  const m = machine();
  m.frames(6, true);
  m.w.partial('would you like music');
  m.frames(14, false);
  assert.equal(m.seals.length, 0, '1.4 s of quiet is still inside the question');
  m.frames(1, false);
  assert.deepEqual(m.seals, [{ seq: 1, text: 'would you like music', windowText: 'would you like music', reason: 'silence' }]);
});

test('a pause shorter than 1.5 s stays one utterance', () => {
  const m = machine();
  m.frames(5, true); m.w.partial('would you like');
  m.frames(10, false);
  m.frames(5, true); m.w.partial('would you like music or a story');
  m.frames(15, false);
  assert.equal(m.seals.length, 1);
  assert.equal(m.seals[0].text, 'would you like music or a story');
});

test('one energetic frame is not speech; quiet with no new words seals nothing until the words arrive', () => {
  const m = machine();
  m.frames(1, true); m.frames(20, false);
  assert.equal(m.seals.length, 0, 'a click is not speech');
  m.frames(3, true); m.frames(16, false);
  assert.equal(m.seals.length, 0, 'no words yet: nothing to seal');
  m.w.partial('can you hear me');
  assert.equal(m.seals.length, 1, 'the late words seal at once');
  assert.equal(m.seals[0].reason, 'silence');
});

test('the service end of turn wins when it comes first; the silence after it does not seal again', () => {
  const m = machine();
  m.frames(5, true); m.w.partial('music or a story'); m.w.turnEnd('music or a story');
  m.frames(20, false);
  assert.equal(m.seals.length, 1);
  assert.equal(m.seals[0].reason, 'turn-end');
  m.w.turnEnd('music or a story');
  assert.equal(m.seals.length, 1, 'the same words never seal twice');
});

test('an utterance is capped at 15 s: sealed, and listening continues', () => {
  const m = machine();
  // He talks on without a pause; the service gives no end of turn.
  for (let k = 1; k <= 150; k++) { m.frames(1, true); if (k % 10 === 2) m.w.partial('and then we went ' + k); }
  assert.equal(m.seals.length, 0, '14.9 s since the first speech frame');
  m.frames(1, true);
  assert.equal(m.seals.length, 1);
  assert.equal(m.seals[0].reason, 'cap');
  assert.equal(m.w.state, 'open');
});

test('10 s without new words after the last seal closes the window: silence', () => {
  const m = machine();
  m.w.partial('chicken or fish'); m.w.turnEnd('chicken or fish');
  m.at(9900);
  assert.equal(m.closes.length, 0);
  m.at(10000);
  assert.deepEqual(m.closes, [{ reason: 'silence', seals: 1, windowText: 'chicken or fish' }]);
  assert.equal(m.w.state, 'closed');
});

test('noise without words never holds the window open past 10 s of no words', () => {
  const m = machine();
  m.w.partial('chicken or fish'); m.w.turnEnd('chicken or fish');
  m.frames(100, true);
  assert.equal(m.closes[0]?.reason, 'silence');
});

test('words not yet sealed are sealed before a silence close', () => {
  const m = machine();
  m.w.partial('chicken or fish');
  m.frames(99, true); // a noisy room: the energy gate never goes quiet
  assert.equal(m.closes.length, 0);
  m.frames(1, true);
  assert.deepEqual(m.seals.map(s => s.reason), ['close']);
  assert.equal(m.closes[0].reason, 'silence');
  assert.equal(m.closes[0].seals, 1);
});

test('60 s since the press closes the window: cap', () => {
  const m = machine();
  for (let s = 1; s < 60; s++) { m.w.partial('word '.repeat(s).trim()); m.at(s * 1000); }
  assert.equal(m.closes.length, 0);
  m.at(60000);
  assert.equal(m.closes[0].reason, 'cap');
  assert.ok(m.seals.length >= 1, 'the words heard so far were sealed');
  assert.equal(m.seals.at(-1).reason, 'cap', 'the utterance in flight at the cap seals with reason cap');
});

test('the 60 s cap with no utterance open closes without a seal', () => {
  const m = machine();
  m.frames(5, true); m.w.turnEnd('chicken or fish');
  assert.equal(m.seals.length, 1);
  m.at(60000);
  assert.deepEqual(m.closes.map(c => [c.reason, c.seals]), [['cap', 1]]);
  assert.equal(m.seals.length, 1, 'nothing new was heard: no second seal');
});

test('a second press seals what was heard and closes: press', () => {
  const m = machine();
  m.frames(5, true); m.w.partial('chicken or fish');
  m.w.press();
  assert.deepEqual(m.seals.map(s => [s.reason, s.windowText]), [['press', 'chicken or fish']]);
  assert.deepEqual(m.closes, [{ reason: 'press', seals: 1, windowText: 'chicken or fish' }]);
});

test('a second press with no utterance open (everything heard is sealed) closes without a seal', () => {
  const m = machine();
  m.frames(5, true); m.w.turnEnd('chicken or fish');
  m.w.press();
  assert.deepEqual(m.seals.map(s => s.reason), ['turn-end']);
  assert.deepEqual(m.closes, [{ reason: 'press', seals: 1, windowText: 'chicken or fish' }]);
  const empty = machine();
  empty.w.press();
  assert.deepEqual([empty.seals.length, empty.closes[0].reason, empty.closes[0].seals], [0, 'press', 0]);
});

test('with a drain hook, a press while an utterance is open waits for the final, then seals it (press) and closes (press)', () => {
  const drained = [];
  const m = machine({}, { drain: reason => drained.push(reason) });
  m.frames(5, true); m.w.partial('chicken or');
  assert.equal(m.w.pending, true, 'speech heard since the last seal');
  m.w.press();
  assert.deepEqual(drained, ['press']);
  assert.equal(m.w.state, 'ending');
  assert.deepEqual([m.seals.length, m.closes.length], [0, 0], 'nothing seals before the final arrives');
  m.w.press(); m.frames(3, true); m.at(30000);
  assert.deepEqual([drained.length, m.seals.length, m.closes.length], [1, 0, 0], 'a third press, frames and ticks wait too');
  m.w.partial('chicken or fish');
  m.w.end('chicken or fish please');
  assert.deepEqual(m.seals, [{ seq: 1, text: 'chicken or fish please', windowText: 'chicken or fish please', reason: 'press' }]);
  assert.deepEqual(m.closes, [{ reason: 'press', seals: 1, windowText: 'chicken or fish please' }]);
  m.w.end('more'); assert.equal(m.seals.length, 1, 'end once');
});

test('with a drain hook: words in flight but energy only (no partial yet) still drain; a press with nothing open closes at once', () => {
  const drained = [];
  const m = machine({}, { drain: reason => drained.push(reason) });
  m.frames(1, true); m.w.turnEnd('chicken or fish');
  m.frames(3, true);
  assert.equal(m.w.pending, true);
  m.w.press();
  assert.deepEqual(drained, ['press']);
  m.w.end('chicken or fish or pasta');
  assert.deepEqual(m.seals.map(s => [s.reason, s.text, s.windowText]), [['turn-end', 'chicken or fish', 'chicken or fish'], ['press', 'or pasta', 'chicken or fish or pasta']]);
  const idle = machine({}, { drain: reason => drained.push(reason) });
  idle.frames(1, true); idle.w.turnEnd('chicken or fish');
  assert.equal(idle.w.pending, false);
  idle.w.press();
  assert.equal(drained.length, 1, 'no drain: nothing in flight');
  assert.deepEqual(idle.closes.map(c => c.reason), ['press']);
});

test('with a drain hook: the final never comes, so end() seals the latest partial; nothing heard at all seals nothing', () => {
  const m = machine({}, { drain: () => {} });
  m.frames(5, true); m.w.partial('is it lunch');
  m.w.press();
  m.w.partial('is it lunch time');
  m.w.end();
  assert.deepEqual(m.seals.map(s => [s.reason, s.windowText]), [['press', 'is it lunch time']]);
  assert.equal(m.closes[0].reason, 'press');
  const quiet = machine({}, { drain: () => {} });
  quiet.frames(5, true);
  quiet.w.press();
  assert.equal(quiet.w.state, 'ending');
  quiet.w.end('');
  assert.deepEqual([quiet.seals.length, quiet.closes[0].reason, quiet.closes[0].seals], [0, 'press', 0]);
});

test('with a drain hook: the 60 s cap drains the utterance in flight and seals it as cap', () => {
  const drained = [];
  const m = machine({}, { drain: reason => drained.push(reason) });
  m.frames(5, true); m.w.partial('do you want');
  m.at(60000);
  assert.deepEqual(drained, ['cap']);
  assert.equal(m.closes.length, 0);
  m.w.end('do you want a story');
  assert.deepEqual(m.seals.map(s => [s.reason, s.windowText]), [['cap', 'do you want a story']]);
  assert.deepEqual(m.closes.map(c => c.reason), ['cap']);
});

test('with a drain hook: cancel or her pick while waiting for the final seals nothing', () => {
  for (const how of ['cancel', 'pick']) {
    const m = machine({}, { drain: () => {} });
    m.frames(5, true); m.w.partial('chicken or fish');
    m.w.press();
    m.w[how]();
    m.w.end('chicken or fish');
    assert.deepEqual([m.seals.length, m.closes.map(c => c.reason)], [0, [how]], how);
  }
});

test('cancel closes with no seal, whatever was heard', () => {
  const m = machine();
  m.frames(5, true); m.w.partial('chicken or fish');
  m.w.cancel();
  assert.equal(m.seals.length, 0);
  assert.deepEqual(m.closes, [{ reason: 'cancel', seals: 0, windowText: '' }]);
});

test('her pick closes: pick, and wins over a seal that was about to happen', () => {
  const m = machine();
  m.w.partial('chicken or fish'); m.w.turnEnd('chicken or fish');
  m.frames(3, true); m.w.partial('chicken or fish or pasta');
  m.frames(14, false);
  m.w.pick();
  m.frames(5, false);
  m.w.turnEnd('or pasta');
  assert.equal(m.seals.length, 1, 'the pending words never seal after her pick');
  assert.deepEqual(m.closes, [{ reason: 'pick', seals: 1, windowText: 'chicken or fish' }]);
});

test('nothing said: 10 s with no words closes with zero seals', () => {
  const m = machine();
  m.frames(30, false);
  m.frames(3, true); // a cough
  m.frames(66, false);
  assert.equal(m.closes.length, 0);
  m.frames(1, false);
  assert.deepEqual(m.closes, [{ reason: 'nothing-said', seals: 0, windowText: '' }]);
  assert.equal(m.seals.length, 0);
});

test('a closed window ignores everything; it closes once', () => {
  const m = machine();
  m.w.cancel(); m.w.cancel(); m.w.press(); m.w.pick();
  m.w.partial('late words'); m.w.turnEnd('late words'); m.frames(30, false); m.at(70000);
  assert.equal(m.closes.length, 1);
  assert.equal(m.seals.length, 0);
});

test('stop(reason) closes from outside (a lost stream) with no seal', () => {
  const m = machine();
  m.w.partial('chicken');
  m.w.stop('error');
  assert.deepEqual(m.closes, [{ reason: 'error', seals: 0, windowText: '' }]);
});

test('limits can be shortened for tests; the clock is the only time source', () => {
  const m = machine({ silenceMs: 500, capMs: 2000 });
  m.at(499); assert.equal(m.closes.length, 0);
  m.at(500); assert.equal(m.closes[0].reason, 'nothing-said');
});

// ---- the energy gate (T3.3): the worker's `measure`, ported ----
const pcm = (samples, value) => { const b = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) b.writeInt16LE(value(i), i * 2); return b; };
const tone = samples => pcm(samples, i => Math.round(Math.sin(i * Math.PI * 2 * 440 / 16000) * 1200));

test('energy gate: 100 ms frames, variance floor .003 squared; a tone is energetic, zeros and DC are not', () => {
  const gate = energyGate();
  assert.deepEqual(gate(tone(1600)), [true]);
  assert.deepEqual(gate(pcm(1600, () => 0)), [false]);
  assert.deepEqual(gate(pcm(1600, () => 20000)), [false], 'DC has no variance');
  assert.deepEqual(gate(pcm(1600, i => (i % 2 ? 1 : -1) * Math.round(.0029 * 32768))), [false], 'just under the floor');
  assert.deepEqual(gate(pcm(1600, i => (i % 2 ? 1 : -1) * Math.round(.0031 * 32768))), [true], 'just over the floor');
});

test('energy gate: frames are counted across chunk edges', () => {
  const gate = energyGate();
  assert.deepEqual(gate(tone(1000)), []);
  assert.deepEqual(gate(tone(1000)), [true]);
  assert.deepEqual(gate(tone(3200)), [true, true]);
});

test('tone then zeros through the gate into the machine: the silence fallback seals after 1.5 s', () => {
  const m = machine(), gate = energyGate();
  const feed = bytes => { for (const energetic of gate(bytes)) { m.w.speech(energetic); } };
  for (let i = 0; i < 10; i++) feed(tone(1600));
  m.w.partial('is it time for lunch');
  for (let i = 0; i < 14; i++) feed(pcm(1600, () => 0));
  assert.equal(m.seals.length, 0);
  feed(pcm(1600, () => 0));
  assert.equal(m.seals.length, 1);
  assert.equal(m.seals[0].reason, 'silence');
});

test('the hub never loads the speech activity model for a window', () => {
  const source = fs.readFileSync(new URL('../chat-window.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /onnx|SpeechActivity|require\([^)]*speech-worker/i);
  const api = fs.readFileSync(new URL('../chat-api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /onnx|SpeechActivity/i);
});
