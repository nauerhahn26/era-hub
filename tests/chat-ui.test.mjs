import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/chat/controller.js', import.meta.url), 'utf8');
const { createChatController, isPartnerTouch, createPCM16Resampler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const voiceSource = await readFile(new URL('../public/chat/voice.js', import.meta.url), 'utf8');
const { createChatVoice } = await import(`data:text/javascript;base64,${Buffer.from(voiceSource).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const choice = (id, say = id) => ({ id, label: id, say });

test('a sealed batch is revealed at once, with the 250 ms settle first, and stays immutable (spec §4, 10/27 evening)', async () => {
  const order = [];
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('one'), choice('two')] }),
    beforeChoices: () => order.push(`settle:${c.state.choices.length}`), onTiming: name => order.push(name) });
  assert.equal('neutral' in c, false, 'no neutral-boundary gate remains'); // (a press window's replacement swap is swapReplacement, never a first batch)
  await c.prepare('a question');
  assert.equal(c.state.phase, 'Your turn');
  assert.deepEqual(c.state.choices.map(x => x.label), ['one', 'two']);
  assert.deepEqual(order, ['choicesReady', 'settle:0', 'revealed'], 'dwell settles before the batch lands');
  assert.equal('staged' in c.state, false, 'there is no hidden staged batch');
  assert.ok(Object.isFrozen(c.state.choices));
  assert.ok(Object.isFrozen(c.state.choices[0]));
});

test('late older answers cannot overwrite a newer turn', async () => {
  const old = deferred(), fresh = deferred(); let n = 0;
  const c = createChatController({ requestChoices: () => (++n === 1 ? old.promise : fresh.promise) });
  const a = c.prepare('old'); const b = c.prepare('new');
  fresh.resolve({ choices: [choice('new')] }); await b;
  old.resolve({ choices: [choice('old')] }); await a;
  assert.equal(c.state.question, 'new');
  assert.deepEqual(c.state.choices.map(x => x.label), ['new']);
});

test('new turn stops speech, invalidates old selection and ignores old completion', async () => {
  const playing = deferred(); let stops = 0;
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('answer')] }), speak: () => playing.promise, stopSpeech: () => { stops++; } });
  await c.prepare('question');
  const oldChoice = c.state.choices[0];
  const speaking = c.select(oldChoice.id);
  assert.equal(c.state.phase, 'Speaking');
  c.ask();
  assert.equal(c.state.phase, 'Capturing question');
  assert.equal(c.state.choices.length, 0);
  assert.equal(await c.select(oldChoice.id), false);
  playing.resolve(); await speaking;
  assert.equal(c.state.phase, 'Capturing question');
  assert.ok(stops >= 2);
});

test('pause clears ephemeral conversation and aborts preparing while fixed phrases survive', async () => {
  const waiting = deferred(); let signal, spoken = '';
  const c = createChatController({ requestChoices: ({ signal: s }) => { signal = s; return waiting.promise; }, speak: async c => { spoken = c.say; } });
  const pending = c.prepare('private conversation'); c.stop();
  assert.equal(signal.aborted, true);
  waiting.resolve({ choices: [choice('late')] }); await pending;
  assert.equal(c.state.question, ''); assert.equal(c.state.choices.length, 0); assert.equal(c.state.phase, 'Off');
  await c.sayFixed('Please give me more time.');
  assert.equal(spoken, 'Please give me more time.');
  assert.equal(c.state.phase, 'Off');
});

test('engine failure does not fabricate listening or remove already displayed answers', async () => {
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('answer')] }) });
  await c.prepare('question'); c.fail('Microphone unavailable');
  assert.equal(c.state.phase, 'Your turn'); assert.equal(c.state.engineReady, false);
  assert.equal(c.state.choices[0].label, 'answer');
});

test('partner touch excludes gaze clicks, native mouse injection and generic clicks', () => {
  assert.equal(isPartnerTouch({ isTrusted: true, pointerType: 'touch' }), true);
  for (const e of [{ isTrusted: false, pointerType: 'touch' }, { isTrusted: true, pointerType: 'mouse' }, { isTrusted: true }, {}]) assert.equal(isPartnerTouch(e), false);
});

test('streaming resampler preserves ordered mono samples and emits signed 16k PCM frames', () => {
  const frames = []; const r = createPCM16Resampler(48000, b => frames.push(b));
  for (let i = 0; i < 10; i++) r.push(new Float32Array(480).fill(i % 2 ? -0.5 : 0.5));
  assert.equal(frames.length, 1); assert.equal(frames[0].byteLength, 3200);
  const v = new DataView(frames[0]);
  assert.equal(v.getInt16(0, true), 16384);
  assert.equal(v.getInt16(160 * 2, true), -16384);
  r.push(new Float32Array(480).fill(1)); r.flush();
  assert.equal(frames.length, 2); assert.equal(frames[1].byteLength, 320);
});

test('late older fixed speech completion cannot end the newer utterance state', async () => {
  const a = deferred(), b = deferred(); let n = 0;
  const c = createChatController({ speak: () => (++n === 1 ? a.promise : b.promise) });
  const old = c.sayFixed('first'); const fresh = c.sayFixed('second');
  a.resolve(); await old; assert.equal(c.state.phase, 'Speaking');
  b.resolve(); await fresh; assert.equal(c.state.phase, 'Off');
});

test('saved audio arriving after cancellation never plays', async () => {
  const fetch = deferred(); let plays = 0;
  const voice = createChatVoice({ fetch: () => fetch.promise, makeAudio: () => ({ play() { plays++; return Promise.resolve(); }, pause() {} }) });
  voice.setPreference('saved');
  const speaking = voice.say('A response'); voice.stop();
  fetch.resolve({ ok: true, blob: async () => new Blob(['audio']) }); await speaking;
  assert.equal(plays, 0); voice.dispose();
});

test('saved voice failure requires an explicit device voice choice', async () => {
  const spoken = [];
  const voice = createChatVoice({ fetch: async () => { throw new Error('offline'); },
    synth: { cancel() {}, getVoices() { return []; }, speak(u) { spoken.push(u.text); queueMicrotask(() => u.onend()); } },
    makeUtterance: text => ({ text }) });
  voice.setPreference('saved'); voice.prefetch([{ say: 'A response' }]);
  await assert.rejects(voice.say('A response'), /Saved voice unavailable/);
  assert.deepEqual(spoken, []);
  voice.setPreference('local');
  await voice.say('A response');
  assert.deepEqual(spoken, ['A response']); voice.dispose();
});

test('replies sealed while a fixed phrase speaks are shown at once, never spoken, and the turn is hers when speech ends', async () => {
  const answering = deferred(), speaking = deferred(); const said = [];
  const c = createChatController({ requestChoices: () => answering.promise, speak: item => { said.push(item.say); return speaking.promise; } });
  const prep = c.prepare('question'); const saying = c.sayFixed('Give me more time.');
  answering.resolve({ choices: [choice('answer')] }); await prep;
  assert.deepEqual(c.state.choices.map(x => x.label), ['answer'], 'shown while the phrase still plays');
  assert.equal(c.state.phase, 'Speaking', 'the phrase keeps playing');
  assert.deepEqual(said, ['Give me more time.'], 'the reveal speaks nothing');
  speaking.resolve(); await saying;
  assert.equal(c.state.phase, 'Your turn');
});

test('a fixed phrase spoken while replies are still on their way returns to Preparing, then the batch shows', async () => {
  const answering = deferred();
  const c = createChatController({ requestChoices: () => answering.promise, speak: async () => true });
  const prep = c.prepare('question');
  await c.sayFixed('Give me more time.');
  assert.equal(c.state.phase, 'Preparing'); assert.equal(c.state.choices.length, 0);
  answering.resolve({ choices: [choice('answer')] }); await prep;
  assert.equal(c.state.phase, 'Your turn'); assert.deepEqual(c.state.choices.map(x => x.label), ['answer']);
});

test('recognition ready defaults to hold-only and speech returns to ready without enabling wake', async () => {
  const c = createChatController({ speak: async () => {} });
  c.ready(); assert.equal(c.state.engineReady, true); assert.equal(c.state.phase, 'Ready to ask');
  assert.equal(c.state.wakeEnabled, false);
  await c.sayFixed('Hello.'); assert.equal(c.state.phase, 'Ready to ask'); assert.equal(c.state.wakeEnabled, false);
});

test('fractional device sample rates produce the same PCM across input block boundaries', () => {
  const full = [], split = [], samples = new Float32Array(4410).fill(0.25);
  const a = createPCM16Resampler(44100, b => full.push(Buffer.from(b)));
  const b = createPCM16Resampler(44100, b => split.push(Buffer.from(b)));
  a.push(samples); a.flush();
  for (let i = 0; i < samples.length; i += 257) b.push(samples.subarray(i, i + 257));
  b.flush();
  assert.equal(Buffer.concat(full).length, 3200);
  assert.deepEqual(Buffer.concat(full), Buffer.concat(split));
  assert.equal(Buffer.concat(full).readInt16LE(0), 8192);
});

test('current choices failure stops listening truthfully and requests session cleanup while fixed phrases work', async () => {
  let cleanup = 0, spoken = '';
  const c = createChatController({ requestChoices: async () => { throw new Error('choices-unavailable'); },
    onChoicesError: () => { cleanup++; }, speak: async item => { spoken = item.say; } });
  c.ready(); await c.prepare('a question');
  assert.equal(c.state.phase, 'Off'); assert.equal(c.state.engineReady, false); assert.equal(c.state.wakeEnabled, false);
  assert.equal(cleanup, 1); assert.ok(c.state.error.includes('phrases still work'));
  await c.sayFixed('Yes.'); assert.equal(spoken, 'Yes.'); assert.equal(c.state.phase, 'Off');
});

test('late failed choices from an older turn cannot shut down the newer turn', async () => {
  const old = deferred(); let cleanup = 0, n = 0;
  const c = createChatController({ requestChoices: () => ++n === 1 ? old.promise : Promise.resolve({ choices: [choice('new')] }),
    onChoicesError: () => { cleanup++; } });
  c.ready(); const previous = c.prepare('old question'); await c.prepare('new question');
  old.reject(new Error('old choices failure')); await previous;
  assert.equal(cleanup, 0); assert.equal(c.state.engineReady, true); assert.equal(c.state.phase, 'Your turn');
  assert.equal(c.state.choices[0].label, 'new');
});

test('failed choices from a closed session cannot shut down a restarted session', async () => {
  const old = deferred(); let cleanup = 0;
  const c = createChatController({ requestChoices: () => old.promise, onChoicesError: () => { cleanup++; } });
  c.ready(); const pending = c.prepare('old question'); c.stop(); c.ready();
  old.reject(new Error('closed session failure')); await pending;
  assert.equal(cleanup, 0); assert.equal(c.state.phase, 'Ready to ask'); assert.equal(c.state.engineReady, true);
});

test('microphone worklet retains no idle audio and release flushes one bounded hold', async () => {
  const source = await readFile(new URL('../public/chat/pcm-worklet.js', import.meta.url), 'utf8');
  let Processor; const sent = [];
  class Base { constructor() { this.port = { onmessage: null, postMessage: data => sent.push(data) }; } }
  vm.runInNewContext(source, { AudioWorkletProcessor: Base, registerProcessor: (_name, value) => { Processor = value; }, Float32Array });
  const processor = new Processor();
  processor.process([[new Float32Array(2048).fill(0.9)]]);
  assert.equal(sent.length, 0, 'idle samples never leave the processor');
  processor.port.onmessage({ data: { type: 'capture', turn: 7 } });
  processor.process([[new Float32Array(500).fill(0.25)]]);
  processor.port.onmessage({ data: { type: 'flush', turn: 7 } });
  assert.equal(sent.length, 2); assert.equal(sent[0].turn, 7);
  assert.equal(sent[0].samples.length, 500); assert.ok(sent[0].samples.every(x => x === 0.25));
  assert.equal(sent[1].flushed, true);
  processor.process([[new Float32Array(2048).fill(0.9)]]);
  assert.equal(sent.length, 2, 'nothing is captured after release');
  processor.port.onmessage({ data: { type: 'capture', turn: 8 } });
  processor.process([[new Float32Array(2048).fill(-0.5)]]);
  assert.equal(sent.at(-1).turn, 8); assert.ok(sent.at(-1).samples.every(x => x === -0.5));
});

test('a revealed choice keeps the hub picture word and id; anything else about the picture is dropped', async () => {
  const c = createChatController({ requestChoices: async () => ({ choices: [
    { label: 'Pizza', say: 'Pizza please.', symbol: 'pizza', symbolId: 2527 },
    { label: 'Odd', say: 'Odd.', symbol: 42, symbolId: 'x', extra: 'dropped' },
    { label: 'Long', say: 'Long.', symbol: 'x'.repeat(65), symbolId: -3 }] }) });
  await c.prepare('question');
  assert.deepEqual(c.state.choices.map(x => ({ ...x })), [
    { id: `${c.state.turn}:0`, label: 'Pizza', say: 'Pizza please.', symbol: 'pizza', symbolId: 2527 },
    { id: `${c.state.turn}:1`, label: 'Odd', say: 'Odd.' }, { id: `${c.state.turn}:2`, label: 'Long', say: 'Long.' }]);
  assert.ok(Object.isFrozen(c.state.choices[0]));
});

// ---- a press window's replacement batches (design 2026-10-27 §4.5; plan T4.1-T4.2) ----
// stageReplacement() stages one for a neutral moment; replace() (Something else,
// stable frame 2026-10-28 §3) is her own request and shows at once: the last test of the group pins both.
const food = (...labels) => ({ choices: labels.map(label => ({ label, say: `${label}.` })) });
async function showing(labels, deps = {}) {
  const c = createChatController({ requestChoices: async () => food(...labels), ...deps });
  // A first batch shows the moment it is sealed (spec 2026-10-27 §4): no swapReplacement() needed.
  await c.prepare('do you want chicken or fish');
  assert.equal(c.state.phase, 'Your turn');
  return c;
}
const cells = c => c.state.choices.map(x => [x.label, x.cell ?? null]);

test('a replacement waits for a neutral moment: the shown batch stays as it was until swapReplacement()', async () => {
  const c = await showing(['Chicken', 'Fish']);
  const shown = c.state.choices;
  assert.equal(c.stageReplacement(food('Chicken', 'Fish', 'Pasta').choices), true);
  assert.equal(c.state.replacing, true);
  assert.equal(c.state.choices, shown, 'nothing changes before the neutral moment');
  assert.equal(c.state.phase, 'Your turn');
  assert.equal(c.swapReplacement(), true);
  assert.equal(c.state.replacing, false);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish', 'Pasta']);
  assert.ok(Object.isFrozen(c.state.choices) && c.state.choices.every(Object.isFrozen), 'the swapped batch is sealed');
  assert.ok(Object.isFrozen(shown) && shown.every(Object.isFrozen), 'the earlier batch was never touched');
  assert.equal(new Set(c.state.choices.map(x => x.id)).size, 3);
  assert.ok(c.state.choices.every(x => !shown.some(old => old.id === x.id)), 'a replacement is a new batch: new ids');
  assert.equal(c.swapReplacement(), false, 'one swap per replacement');
});

test('a newer replacement supersedes a pending one unseen', async () => {
  const timings = [];
  const c = await showing(['Chicken', 'Fish'], { onTiming: name => timings.push(name) });
  c.stageReplacement(food('Chicken', 'Fish', 'Pasta').choices);
  c.stageReplacement(food('Chicken', 'Fish', 'Soup').choices);
  assert.equal(timings.filter(name => name === 'replacementSuperseded').length, 1);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish']);
  c.swapReplacement();
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish', 'Soup'], 'pasta was never shown');
  assert.equal(timings.at(-1), 'replaced');
});

test('her pick discards a pending replacement: the spoken tile is the shown one', async () => {
  const spoken = [];
  const c = await showing(['Chicken', 'Fish'], { speak: async choice => { spoken.push(choice.say); } });
  c.stageReplacement(food('Pasta').choices);
  await c.select(c.state.choices[1].id);
  assert.deepEqual(spoken, ['Fish.']);
  assert.equal(c.state.replacing, false);
  assert.equal(c.swapReplacement(), false);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish']);
});

test('a replacement needs a shown batch in Your turn; anything else is refused', async () => {
  let release;
  const c = createChatController({ requestChoices: () => new Promise(resolve => { release = () => resolve(food('Chicken')); }) });
  assert.equal(c.stageReplacement(food('Pasta').choices), false, 'nothing shown');
  const preparing = c.prepare('question');
  assert.equal(c.state.phase, 'Preparing');
  assert.equal(c.stageReplacement(food('Pasta').choices), false, 'still being prepared, nothing shown yet');
  release(); await preparing;
  assert.deepEqual([c.state.phase, c.state.choices.map(x => x.label)], ['Your turn', ['Chicken']], 'the first batch showed at once');
  assert.equal(c.stageReplacement([]), false, 'an empty batch');
  assert.equal(c.stageReplacement([{ label: 'x' }]), false, 'nothing sayable');
  c.stageReplacement(food('Pasta').choices); c.ask();
  assert.equal(c.state.replacing, false, 'a new turn drops it');
});

test('chicken and fish stay put when pasta arrives', async () => {
  const c = await showing(['Chicken', 'Fish']);
  c.stageReplacement(food('Pasta', 'Fish', 'Chicken').choices); c.swapReplacement();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Fish', 1], ['Pasta', 2]]);
});

test('removed leaves an empty cell until the next replacement; new labels take free cells in order', async () => {
  const c = await showing(['Chicken', 'Fish', 'Pasta']);
  c.stageReplacement(food('Chicken', 'Pasta').choices); c.swapReplacement();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Pasta', 2]], 'cell 1 is empty');
  c.stageReplacement(food('Chicken', 'Soup', 'Pasta').choices); c.swapReplacement();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Soup', 1], ['Pasta', 2]], 'the next replacement may fill it');
  c.stageReplacement(food('Rice', 'Chicken', 'Pasta', 'Soup').choices); c.swapReplacement();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Soup', 1], ['Pasta', 2], ['Rice', 3]]);
  c.stageReplacement(food('Chicken', 'Bread').choices); c.swapReplacement();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Bread', 1]], 'with no free cell left, a vacated one; the rest stay empty');
});

test('a press keeps the last turn\'s tiles, stale and never spoken, until clearStale(); a hold clears them at once (review fix)', async () => {
  const c = await showing(['Chicken', 'Fish']);
  c.ready();
  const shown = c.state.choices;
  c.ask({ keepShown: true });
  assert.equal(c.state.phase, 'Capturing question', 'listening starts at once');
  assert.equal(c.state.choices, shown, 'the shown tiles stay as they were');
  assert.equal(c.state.stale, true);
  assert.equal(await c.select(shown[0].id, c.state.turn), false, 'a stale tile is never spoken under a later turn');
  assert.equal(c.stageReplacement(food('Pasta').choices), false, 'a stale batch is not a window batch to replace');
  assert.equal(c.clearStale(), true);
  assert.deepEqual([c.state.choices.length, c.state.stale, c.state.phase], [0, false, 'Capturing question']);
  assert.equal(c.clearStale(), false);
  const d = await showing(['Chicken', 'Fish']);
  d.ask();
  assert.deepEqual([d.state.choices.length, d.state.stale], [0, false], 'the hold path is unchanged');
});

// The maintainer's rule (10/29), over design 2026-10-27 §4.4: her eyes never
// interfere with how the voice is processed. A pick speaks; the window listens on.
test('a completed dwell on a still-shown old tile after a press speaks it; the window keeps listening (maintainer 10/29)', async () => {
  const spoken = [];
  const c = await showing(['Chicken', 'Fish'], { speak: async choice => { spoken.push(choice.say); } });
  c.ready();
  const shown = c.state.choices, tileTurn = c.state.turn;
  // The press: listening starts at once, the old tiles stay stale.
  c.ask({ keepShown: true });
  assert.equal(c.state.stale, true);
  assert.equal(c.state.staleTurn, tileTurn, 'the stale tiles remember the turn they were drawn in');
  assert.equal(await c.select(shown[1].id, c.state.turn), false, 'a later turn never speaks a stale tile');
  assert.equal(await c.select(shown[1].id, tileTurn), true, 'her dwell on the old tile speaks it');
  assert.deepEqual(spoken, ['Fish.']);
  assert.equal(c.state.phase, 'Capturing question', 'the window is still listening after the pick');
  assert.equal(c.state.replacing, false);
  assert.equal(c.state.choices, shown, 'the old tiles are not redrawn by the pick');
  assert.equal(c.swapReplacement(), false, 'nothing waits to be swapped in');
});

test('a dwell on an old tile while the window\'s batch is being prepared speaks and leaves that batch alone; it still shows (maintainer 10/29)', async () => {
  const spoken = [];
  let calls = 0, aborted = false;
  const c = createChatController({ speak: async choice => { spoken.push(choice.say); },
    requestChoices: ({ signal }) => (++calls === 1 ? Promise.resolve(food('Chicken', 'Fish'))
      : new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        setTimeout(() => resolve(food('Pasta', 'Rice')), 20); })) });
  await c.prepare('do you want chicken or fish'); c.ready();
  const shown = c.state.choices, tileTurn = c.state.turn;
  c.ask({ keepShown: true });
  const preparing = c.prepare('or pasta');
  assert.equal(c.state.phase, 'Preparing');
  assert.equal(await c.select(shown[0].id, tileTurn), true);
  await preparing;
  assert.equal(aborted, false, 'the window\'s request goes on');
  assert.deepEqual(spoken, ['Chicken.']);
  assert.equal(c.state.error, '');
  assert.deepEqual(c.state.choices.map(x => x.label), ['Pasta', 'Rice'], 'the window\'s batch still shows');
  assert.equal(c.state.phase, 'Your turn');
});

test('a pick is recorded only when select accepts it: onSelected runs before speech for an accepted pick, never for a refused one (review fix)', async () => {
  const order = [];
  const c = await showing(['Chicken', 'Fish'], { speak: async choice => { order.push(`spoke ${choice.say}`); } });
  const shown = c.state.choices, tileTurn = c.state.turn;
  assert.equal(await c.select(shown[0].id, tileTurn + 1, choice => order.push(`logged ${choice.label}`)), false, 'a pick from another turn is refused');
  assert.equal(await c.select('nope', tileTurn, choice => order.push(`logged ${choice.label}`)), false, 'an unknown tile is refused');
  assert.deepEqual(order, [], 'a refused pick is never recorded');
  assert.equal(await c.select(shown[1].id, tileTurn, choice => order.push(`logged ${choice.label}`)), true);
  assert.deepEqual(order, ['logged Fish', 'spoke Fish.']);
  // The page hands the turn-log write to select, not before it.
  const app = await readFile(new URL('../public/chat/app.js', import.meta.url), 'utf8');
  assert.match(app, /controller\.select\(item\.id, selectedTurn, \w+ => turnLog\.content\(\w+, \{ selected: \w+ \}\)\)/);
  assert.doesNotMatch(app, /turnLog\.content\(questionMetric, \{ selected: item \}\); controller\.select/);
});

test('a press window\'s first batch shows the moment it is sealed, over the stale tiles, wherever her gaze is (spec 2026-10-27 §4)', async () => {
  const c = await showing(['Chicken', 'Fish'], { beforeChoices: () => {} });
  c.ready();
  const old = c.state.choices;
  c.ask({ keepShown: true });
  assert.equal(c.state.stale, true);
  const prepared = c.prepare('pasta or soup');
  assert.equal(c.state.phase, 'Preparing');
  assert.equal(c.state.choices, old, 'the stale tiles stay while the batch is prepared');
  await prepared;
  assert.equal(c.state.phase, 'Your turn');
  assert.equal(c.state.stale, false, 'no stale tile survives the first batch');
  assert.ok(c.state.choices.every(x => !old.some(o => o.id === x.id)), 'the sealed batch replaced them at once');
  assert.equal(c.swapReplacement(), false, 'nothing waited for a neutral moment');
});

test('replace (Something else) shows the fresh batch at once; stageReplacement (a press window) waits for swapReplacement(); her own request drops a waiting one', async () => {
  const prefetched = [];
  const c = await showing(['Chicken', 'Fish'], { prefetch: next => prefetched.push(next.map(x => x.label)) });
  assert.equal(c.replace(food('Rice', 'Beans').choices, c.state.turn), true);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Rice', 'Beans'], 'her own request shows the moment it lands');
  assert.equal(c.state.replacing, false);
  assert.ok(c.state.choices.every(x => x.cell === undefined), 'a fresh batch carries no cells: the frame draws it by count');
  assert.equal(c.stageReplacement(food('Rice', 'Beans', 'Soup').choices), true);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Rice', 'Beans'], 'a window batch waits for a neutral moment');
  assert.equal(c.state.replacing, true);
  assert.deepEqual(prefetched.at(-1), ['Rice', 'Beans', 'Soup'], 'a staged batch warms its voices while it waits');
  assert.equal(c.replace(food('Corn').choices, c.state.turn), true);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Corn'], 'Something else while a window batch waits: hers shows');
  assert.equal(c.state.replacing, false, 'the waiting batch is dropped unseen');
  assert.equal(c.swapReplacement(), false, 'nothing waits');
  assert.equal(c.stageReplacement(food('Corn', 'Peas').choices), true);
  assert.equal(c.swapReplacement(), true);
  assert.deepEqual(cells(c), [['Corn', 0], ['Peas', 1]], 'the swapped batch keeps Corn in its cell');
  assert.equal(c.replace(food('Late').choices, c.state.turn - 1), false, 'replace still refuses another turn');
});

test('a glyph choice (a letter or a number) keeps its glyph mark; nothing else claims one', async () => {
  const c = createChatController({ requestChoices: async () => ({ choices: [
    { label: 'A', say: 'A', glyph: true }, { label: 'B', say: 'B', glyph: 'yes' }] }) });
  await c.prepare('Is it A or B?');
  assert.deepEqual(c.state.choices.map(x => ({ ...x })), [
    { id: `${c.state.turn}:0`, label: 'A', say: 'A', glyph: true }, { id: `${c.state.turn}:1`, label: 'B', say: 'B' }]);
});

test('a dropped hold returns to Ready to ask with a partner hint, keeps the engine ready, and the next hold clears the hint', async () => {
  let stops = 0;
  const c = createChatController({ speak: async () => {}, stopSpeech: () => { stops++; } });
  c.ready(); c.ask(); const held = c.state.turn;
  c.retry('Let go too soon — hold while you speak.');
  assert.equal(c.state.phase, 'Ready to ask'); assert.equal(c.state.engineReady, true);
  assert.equal(c.state.hint, 'Let go too soon — hold while you speak.'); assert.equal(c.state.error, '');
  assert.ok(c.state.turn > held, 'the dropped hold is invalidated'); assert.deepEqual(c.state.choices, []);
  assert.ok(stops >= 2, 'nothing keeps speaking from the dropped hold');
  c.ask(); assert.equal(c.state.hint, '');
  c.retry('Hold while you speak, let go when done.'); await c.sayFixed('Yes.');
  assert.equal(c.state.phase, 'Ready to ask'); assert.equal(c.state.hint, '', 'speaking clears the hint');
  c.fail('Speech stopped.'); assert.equal(c.state.hint, '');
  // Without a ready engine there is nothing to return to.
  const off = createChatController(); off.retry('Hold while you speak, let go when done.'); assert.equal(off.state.phase, 'Off');
});

// No Start Chat (maintainer, 10/27 evening): a session that ended by itself
// (the 30-minute lifetime, a hub restart) leaves Chat standing by. A hold there
// starts a new session; a hold dropped while it starts keeps Ready to ask and its hint.
test('a quietly ended session stands by at Ready to ask; a dropped hold there keeps its hint; stop and fail end the standby', async () => {
  const c = createChatController({ speak: async () => {} });
  c.ready(); c.standby();
  assert.equal(c.state.phase, 'Ready to ask'); assert.equal(c.state.engineReady, false, 'no session is live');
  assert.equal(c.state.error, '');
  c.ask(); assert.equal(c.state.phase, 'Capturing question');
  c.retry('Chat could not get ready. Hold Ask again while you speak.');
  assert.equal(c.state.phase, 'Ready to ask'); assert.match(c.state.hint, /could not get ready/);
  await c.sayFixed('Yes.'); assert.equal(c.state.phase, 'Ready to ask', 'a phrase spoken while standing by returns there');
  c.ready(); assert.equal(c.state.engineReady, true); assert.equal(c.state.phase, 'Ready to ask');
  c.stop(); c.retry('x'); assert.equal(c.state.phase, 'Off', 'a stopped Chat has nothing to stand by for');
  c.standby(); c.fail('Speech stopped.'); c.retry('x'); assert.equal(c.state.phase, 'Off', 'a failure ends the standby');
  // Answers already on the board stay hers.
  const shown = createChatController({ requestChoices: async () => ({ choices: [{ label: 'Yes', say: 'Yes.' }] }) });
  shown.ready(); await shown.prepare('Do you want to?'); shown.standby();
  assert.equal(shown.state.phase, 'Your turn'); assert.equal(shown.state.choices.length, 1);
});

test('replace swaps the current turn\'s replies for a fresh batch (Something else), with new ids, the settle first, and only for that turn', async () => {
  const order = [], prefetched = [];
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('one'), choice('two')] }),
    beforeChoices: () => order.push('settle'), prefetch: next => prefetched.push(next.map(x => x.label)) });
  await c.prepare('a question');
  const turn = c.state.turn, before = c.state.choices.map(x => x.id);
  order.length = 0;
  assert.equal(c.replace([choice('three'), { label: 'bad' }, choice('four'), choice('five'), choice('six'), choice('seven')], turn), true);
  assert.deepEqual(c.state.choices.map(x => x.label), ['three', 'four', 'five', 'six'], 'cleaned like a batch: at most four');
  assert.equal(c.state.question, 'a question'); assert.equal(c.state.turn, turn); assert.equal(c.state.phase, 'Your turn');
  assert.ok(c.state.choices.every(x => !before.includes(x.id)), 'a replaced batch never reuses an id');
  assert.ok(Object.isFrozen(c.state.choices));
  assert.deepEqual(order, ['settle']); assert.deepEqual(prefetched.at(-1), ['three', 'four', 'five', 'six']);
  // The new batch selects like any other.
  let spoken = ''; const d = createChatController({ requestChoices: async () => ({ choices: [choice('a')] }), speak: async x => { spoken = x.say; } });
  await d.prepare('q'); d.replace([choice('b')], d.state.turn);
  assert.equal(await d.select(d.state.choices[0].id), true); assert.equal(spoken, 'b');
  // A late batch for an older turn, an empty batch, or no turn of replies changes nothing.
  assert.equal(c.replace([choice('late')], turn - 1), false);
  assert.equal(c.replace([], turn), false);
  c.ask();
  assert.equal(c.replace([choice('late')], turn), false);
  assert.equal(c.replace([choice('late')], c.state.turn), false, 'nothing to replace while capturing');
  assert.equal(c.state.choices.length, 0);
});

test('sayFixed passes an echo mark through to speak so the strip\'s repeat of the question is not her words', async () => {
  const said = [];
  const c = createChatController({ speak: async x => { said.push(x); } });
  await c.sayFixed('Yes.'); await c.sayFixed('What did you eat?', { echo: true });
  assert.deepEqual(said, [{ say: 'Yes.' }, { say: 'What did you eat?', echo: true }]);
});

test('restore brings a kept batch back as a new turn: its question and replies, new ids, the settle first, Your turn', async () => {
  const order = []; let stops = 0;
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('now')] }), beforeChoices: () => order.push('settle'), stopSpeech: () => { stops++; } });
  await c.prepare('the second question');
  const before = c.state.turn, ids = c.state.choices.map(x => x.id);
  order.length = 0;
  assert.equal(c.restore({ question: 'the first question', choices: [choice('one'), { label: 'bad' }, choice('two')] }), true);
  assert.ok(c.state.turn > before, 'a new turn: older selections and replies cannot land on it');
  assert.equal(c.state.question, 'the first question'); assert.equal(c.state.phase, 'Your turn');
  assert.deepEqual(c.state.choices.map(x => x.label), ['one', 'two']);
  assert.ok(c.state.choices.every(x => !ids.includes(x.id)));
  assert.deepEqual(order, ['settle']); assert.ok(stops >= 1, 'speech stops');
  let spoken = ''; const d = createChatController({ speak: async x => { spoken = x.say; } });
  assert.equal(d.restore({ question: 'q', choices: [choice('x')] }), true);
  assert.equal(await d.select(d.state.choices[0].id), true); assert.equal(spoken, 'x');
  assert.equal(c.restore({ question: 'q', choices: [] }), false, 'nothing to restore');
  c.ask(); assert.equal(c.restore({ question: 'q', choices: [choice('x')] }), false, 'never while a question is captured');
});
