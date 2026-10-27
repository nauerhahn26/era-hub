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
  assert.equal('neutral' in c, false, 'no neutral-boundary gate remains');
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
