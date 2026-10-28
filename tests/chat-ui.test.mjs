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

test('new choices wait for a fresh neutral event and remain immutable during reading', async () => {
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('one'), choice('two')] }) });
  await c.prepare('a question');
  assert.equal(c.state.phase, 'Preparing');
  assert.equal(c.state.choices.length, 0);
  c.neutral();
  assert.equal(c.state.phase, 'Your turn');
  assert.deepEqual(c.state.choices.map(x => x.label), ['one', 'two']);
  assert.ok(Object.isFrozen(c.state.choices));
  assert.ok(Object.isFrozen(c.state.choices[0]));
});

test('late older answers cannot overwrite a newer turn', async () => {
  const old = deferred(), fresh = deferred(); let n = 0;
  const c = createChatController({ requestChoices: () => (++n === 1 ? old.promise : fresh.promise) });
  const a = c.prepare('old'); const b = c.prepare('new');
  fresh.resolve({ choices: [choice('new')] }); await b; c.neutral();
  old.resolve({ choices: [choice('old')] }); await a; c.neutral();
  assert.equal(c.state.question, 'new');
  assert.deepEqual(c.state.choices.map(x => x.label), ['new']);
});

test('new turn stops speech, invalidates old selection and ignores old completion', async () => {
  const playing = deferred(); let stops = 0;
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('answer')] }), speak: () => playing.promise, stopSpeech: () => { stops++; } });
  await c.prepare('question'); c.neutral();
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
  waiting.resolve({ choices: [choice('late')] }); await pending; c.neutral();
  assert.equal(c.state.question, ''); assert.equal(c.state.choices.length, 0); assert.equal(c.state.phase, 'Off');
  await c.sayFixed('Please give me more time.');
  assert.equal(spoken, 'Please give me more time.');
  assert.equal(c.state.phase, 'Off');
});

test('engine failure does not fabricate listening or remove already displayed answers', async () => {
  const c = createChatController({ requestChoices: async () => ({ choices: [choice('answer')] }) });
  await c.prepare('question'); c.neutral(); c.fail('Microphone unavailable');
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

test('staged replies stay hidden until speech ends and another neutral event occurs', async () => {
  const answering = deferred(), speaking = deferred();
  const c = createChatController({ requestChoices: () => answering.promise, speak: () => speaking.promise });
  const prep = c.prepare('question'); const said = c.sayFixed('Give me more time.');
  answering.resolve({ choices: [choice('answer')] }); await prep;
  assert.equal(c.neutral(), false); assert.equal(c.state.choices.length, 0);
  speaking.resolve(); await said;
  assert.equal(c.state.phase, 'Preparing'); assert.equal(c.neutral(), true);
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
  c.ready(); const previous = c.prepare('old question'); await c.prepare('new question'); c.neutral();
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
  await c.prepare('question'); c.neutral();
  assert.deepEqual(c.state.choices.map(x => ({ ...x })), [
    { id: `${c.state.turn}:0`, label: 'Pizza', say: 'Pizza please.', symbol: 'pizza', symbolId: 2527 },
    { id: `${c.state.turn}:1`, label: 'Odd', say: 'Odd.' }, { id: `${c.state.turn}:2`, label: 'Long', say: 'Long.' }]);
  assert.ok(Object.isFrozen(c.state.choices[0]));
});

// ---- replacement batches (design 2026-10-27 §4.5; plan T4.1-T4.2) ----
const food = (...labels) => ({ choices: labels.map(label => ({ label, say: `${label}.` })) });
async function showing(labels, deps = {}) {
  const c = createChatController({ requestChoices: async () => food(...labels), ...deps });
  await c.prepare('do you want chicken or fish'); c.neutral();
  assert.equal(c.state.phase, 'Your turn');
  return c;
}
const cells = c => c.state.choices.map(x => [x.label, x.cell ?? null]);

test('a replacement waits for a neutral moment: the shown batch stays as it was until neutral()', async () => {
  const c = await showing(['Chicken', 'Fish']);
  const shown = c.state.choices;
  assert.equal(c.replace(food('Chicken', 'Fish', 'Pasta').choices), true);
  assert.equal(c.state.replacing, true);
  assert.equal(c.state.choices, shown, 'nothing changes before the neutral moment');
  assert.equal(c.state.phase, 'Your turn');
  assert.equal(c.neutral(), true);
  assert.equal(c.state.replacing, false);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish', 'Pasta']);
  assert.ok(Object.isFrozen(c.state.choices) && c.state.choices.every(Object.isFrozen), 'the swapped batch is sealed');
  assert.ok(Object.isFrozen(shown) && shown.every(Object.isFrozen), 'the earlier batch was never touched');
  assert.equal(new Set(c.state.choices.map(x => x.id)).size, 3);
  assert.ok(c.state.choices.every(x => !shown.some(old => old.id === x.id)), 'a replacement is a new batch: new ids');
  assert.equal(c.neutral(), false, 'one swap per replacement');
});

test('a newer replacement supersedes a pending one unseen', async () => {
  const timings = [];
  const c = await showing(['Chicken', 'Fish'], { onTiming: name => timings.push(name) });
  c.replace(food('Chicken', 'Fish', 'Pasta').choices);
  c.replace(food('Chicken', 'Fish', 'Soup').choices);
  assert.equal(timings.filter(name => name === 'replacementSuperseded').length, 1);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish']);
  c.neutral();
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish', 'Soup'], 'pasta was never shown');
  assert.equal(timings.at(-1), 'replaced');
});

test('her pick discards a pending replacement: the spoken tile is the shown one', async () => {
  const spoken = [];
  const c = await showing(['Chicken', 'Fish'], { speak: async choice => { spoken.push(choice.say); } });
  c.replace(food('Pasta').choices);
  await c.select(c.state.choices[1].id);
  assert.deepEqual(spoken, ['Fish.']);
  assert.equal(c.state.replacing, false);
  assert.equal(c.neutral(), false);
  assert.deepEqual(c.state.choices.map(x => x.label), ['Chicken', 'Fish']);
});

test('a replacement needs a shown batch in Your turn; anything else is refused', async () => {
  const c = createChatController({ requestChoices: async () => food('Chicken') });
  assert.equal(c.replace(food('Pasta').choices), false, 'nothing shown');
  await c.prepare('question');
  assert.equal(c.replace(food('Pasta').choices), false, 'staged, not yet revealed');
  c.neutral();
  assert.equal(c.replace([]), false, 'an empty batch');
  assert.equal(c.replace([{ label: 'x' }]), false, 'nothing sayable');
  c.replace(food('Pasta').choices); c.ask();
  assert.equal(c.state.replacing, false, 'a new turn drops it');
});

test('chicken and fish stay put when pasta arrives', async () => {
  const c = await showing(['Chicken', 'Fish']);
  c.replace(food('Pasta', 'Fish', 'Chicken').choices); c.neutral();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Fish', 1], ['Pasta', 2]]);
});

test('removed leaves an empty cell until the next replacement; new labels take free cells in order', async () => {
  const c = await showing(['Chicken', 'Fish', 'Pasta']);
  c.replace(food('Chicken', 'Pasta').choices); c.neutral();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Pasta', 2]], 'cell 1 is empty');
  c.replace(food('Chicken', 'Soup', 'Pasta').choices); c.neutral();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Soup', 1], ['Pasta', 2]], 'the next replacement may fill it');
  c.replace(food('Rice', 'Chicken', 'Pasta', 'Soup').choices); c.neutral();
  assert.deepEqual(cells(c), [['Chicken', 0], ['Soup', 1], ['Pasta', 2], ['Rice', 3]]);
  c.replace(food('Chicken', 'Bread').choices); c.neutral();
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
  assert.equal(await c.select(shown[0].id, c.state.turn), false, 'a stale tile is never spoken');
  assert.equal(c.replace(food('Pasta').choices), false, 'a stale batch is not a window batch to replace');
  assert.equal(c.clearStale(), true);
  assert.deepEqual([c.state.choices.length, c.state.stale, c.state.phase], [0, false, 'Capturing question']);
  assert.equal(c.clearStale(), false);
  const d = await showing(['Chicken', 'Fish']);
  d.ask();
  assert.deepEqual([d.state.choices.length, d.state.stale], [0, false], 'the hold path is unchanged');
});
