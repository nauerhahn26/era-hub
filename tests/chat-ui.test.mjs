import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/chat/controller.js', import.meta.url), 'utf8');
const { createChatController, isPartnerTouch, createPCM16Resampler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const voiceSource = await readFile(new URL('../public/chat/voice.js', import.meta.url), 'utf8');
const { createChatVoice } = await import(`data:text/javascript;base64,${Buffer.from(voiceSource).toString('base64')}`);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
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

test('device voice does not wait for failed cloud prefetch', async () => {
  const spoken = [];
  const voice = createChatVoice({ fetch: async () => { throw new Error('offline'); },
    synth: { cancel() {}, getVoices() { return []; }, speak(u) { spoken.push(u.text); queueMicrotask(() => u.onend()); } },
    makeUtterance: text => ({ text }) });
  voice.setPreference('saved'); voice.prefetch([{ say: 'A response' }]);
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

test('recognition ready without wake support never claims wake listening', async () => {
  const c = createChatController({ speak: async () => {} });
  c.ready(false); assert.equal(c.state.engineReady, true); assert.equal(c.state.phase, 'Off');
  await c.sayFixed('Hello.'); assert.equal(c.state.phase, 'Off');
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
