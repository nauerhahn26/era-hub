import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/chat/voice.js', import.meta.url), 'utf8');
const { createChatVoice } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(extra = {}) {
  const values = new Map(), spoken = [], played = [], revoked = [], calls = [];
  let nextUrl = 0, selected = 'configured-first';
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const synth = { cancel() {}, getVoices: () => [], speak(u) { spoken.push(u.text); queueMicrotask(() => { u.onstart?.(); u.onend?.(); }); } };
  const voice = createChatVoice({ storage, synth, makeUtterance: text => ({ text }),
    createObjectURL: () => `prepared-${++nextUrl}`, revokeObjectURL: url => revoked.push(url),
    makeAudio: url => ({ pause() {}, play() { played.push(url); queueMicrotask(() => { this.onplaying?.(); this.onended?.(); }); return Promise.resolve(); } }),
    fetch: async (url, init) => { calls.push({ url, init }); return url === '/voices'
      ? Response.json({ enabled: true, current: selected }) : new Response(new Blob(['audio'], { type: 'audio/mpeg' })); }, ...extra });
  return { voice, values, storage, spoken, played, revoked, calls, select: value => { selected = value; } };
}

test('saved voice is the default and explicit browser preference persists across instances', () => {
  const s = setup();
  assert.equal(s.voice.getPreference(), 'saved');
  s.voice.setPreference('local');
  const next = setup({ storage: s.storage });
  assert.equal(next.voice.getPreference(), 'local');
  next.voice.setPreference('saved');
  assert.equal(setup({ storage: s.storage }).voice.getPreference(), 'saved');
  const denied = setup({ storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } } });
  assert.equal(denied.voice.getPreference(), 'saved');
  denied.voice.setPreference('local'); assert.equal(denied.voice.getPreference(), 'local');
  s.voice.dispose(); next.voice.dispose(); denied.voice.dispose();
});

test('saved audio taking over 800ms never silently switches to device speech', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = deferred(), spoken = [], played = [];
  const s = setup({ fetch: url => url === '/voices' ? Promise.resolve(Response.json({ enabled: true, current: 'configured' })) : waiting.promise,
    synth: { cancel() {}, getVoices: () => [], speak(u) { spoken.push(u.text); } },
    makeAudio: () => ({ pause() {}, play() { played.push(true); queueMicrotask(() => { this.onplaying?.(); this.onended?.(); }); return Promise.resolve(); } }) });
  let completed = false;
  const saying = s.voice.say('My chosen words').then(result => { completed = true; return result; });
  await flush(); t.mock.timers.tick(801); await flush();
  assert.equal(completed, false); assert.deepEqual(spoken, []); assert.deepEqual(played, []);
  waiting.resolve(new Response(new Blob(['audio'], { type: 'audio/mpeg' })));
  assert.equal(await saying, true); assert.equal(played.length, 1); assert.deepEqual(spoken, []);
  s.voice.dispose();
});

test('saved preparation failure is explicit and device speech requires an explicit preference', async () => {
  const s = setup({ fetch: async url => url === '/voices' ? Response.json({ enabled: true, current: 'configured' }) : new Response('', { status: 503 }) });
  await assert.rejects(s.voice.say('Keep these words'), error => error.code === 'saved-voice-unavailable');
  assert.deepEqual(s.spoken, []); assert.deepEqual(s.played, []);
  s.voice.setPreference('local');
  assert.equal(await s.voice.say('Keep these words'), true); assert.deepEqual(s.spoken, ['Keep these words']);
  s.voice.dispose();
});

test('disabled saved setup fails without any clip request or automatic fallback', async () => {
  const urls = [], s = setup({ fetch: async url => { urls.push(url); return Response.json({ enabled: false, current: 'configured' }); } });
  await assert.rejects(s.voice.say('My response'), /Saved voice unavailable/);
  assert.deepEqual(urls, ['/voices']); assert.deepEqual(s.spoken, []); assert.deepEqual(s.played, []);
  s.voice.dispose();
});

test('current hub voice is checked before cache reuse and changed selection invalidates clips', async () => {
  const s = setup();
  await s.voice.say('The same words');
  await s.voice.say('The same words');
  assert.equal(s.calls.filter(x => x.url === '/tts').length, 1);
  s.select('configured-second');
  await s.voice.say('The same words');
  assert.equal(s.calls.filter(x => x.url === '/tts').length, 2);
  assert.deepEqual(s.played, ['prepared-1', 'prepared-1', 'prepared-2']);
  assert.deepEqual(s.revoked, ['prepared-1']);
  s.voice.dispose();
});

test('cancellation settles pending saved speech promptly and late audio never plays or reports success', async () => {
  const waiting = deferred(), s = setup({ fetch: url => url === '/voices' ? Promise.resolve(Response.json({ enabled: true, current: 'configured' })) : waiting.promise });
  const saying = s.voice.say('Old words'); await flush(); s.voice.stop();
  assert.equal(await Promise.race([saying, new Promise((_, reject) => setTimeout(() => reject(Error('cancel did not settle')), 50))]), false);
  waiting.resolve(new Response(new Blob(['audio'], { type: 'audio/mpeg' }))); await flush();
  assert.deepEqual(s.played, []); s.voice.dispose();
});

test('actual playback events report start and end once and stale events remain silent', async () => {
  const audios = [], reports = [];
  const s = setup({ makeAudio: () => { const audio = { pause() {}, play: async () => {} }; audios.push(audio); return audio; } });
  const first = s.voice.say('First', { onStart: () => reports.push('first-start'), onEnd: () => reports.push('first-end') });
  await flush(); assert.deepEqual(reports, []);
  audios[0].onplaying(); audios[0].onplaying(); assert.deepEqual(reports, ['first-start']);
  s.voice.stop(); assert.equal(await first, false);
  audios[0].onended(); assert.deepEqual(reports, ['first-start']);
  const second = s.voice.say('Second', { onStart: () => reports.push('second-start'), onEnd: () => reports.push('second-end') });
  await flush(); audios[1].onplaying(); audios[1].onended(); audios[1].onended();
  assert.equal(await second, true); assert.deepEqual(reports, ['first-start', 'second-start', 'second-end']);
  s.voice.setPreference('local');
  await s.voice.say('Device', { onStart: () => reports.push('local-start'), onEnd: () => reports.push('local-end') });
  assert.deepEqual(reports.slice(-2), ['local-start', 'local-end']); s.voice.dispose();
});

test('late playback events after an audio failure cannot report a successful start or end', async () => {
  let audio; const reports = [];
  const s = setup({ makeAudio: () => { audio = { pause() {}, play: async () => {} }; return audio; } });
  const saying = s.voice.say('Selected words', { onStart: () => reports.push('start'), onEnd: () => reports.push('end') });
  await flush(); audio.onerror(); await assert.rejects(saying, /Saved voice unavailable/);
  audio.onplaying(); audio.onended(); assert.deepEqual(reports, []);
  s.voice.dispose();
});

test('ended without an actual playback start never confirms a spoken response', async () => {
  const reports = [];
  const s = setup({ makeAudio: () => ({ pause() {}, play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); } }),
    synth: { cancel() {}, getVoices: () => [], speak(utterance) { queueMicrotask(() => utterance.onend?.()); } } });
  const callbacks = { onStart: () => reports.push('start'), onEnd: () => reports.push('end') };
  assert.equal(await s.voice.say('Chosen words', callbacks), false);
  s.voice.setPreference('local');
  assert.equal(await s.voice.say('Chosen words', callbacks), false);
  assert.deepEqual(reports, []); s.voice.dispose();
});

test('prefetch is silent, deduplicated, bounded and gives selected words queue priority', async () => {
  const waiting = [], texts = []; let active = 0, peak = 0;
  const s = setup({ limits: { concurrent: 1, queued: 3 }, fetch: (url, init) => {
    if (url === '/voices') return Promise.resolve(Response.json({ enabled: true, current: 'configured' }));
    texts.push(JSON.parse(init.body).text); active++; peak = Math.max(peak, active);
    return new Promise(resolve => { waiting.push(() => { active--; resolve(new Response(new Blob(['audio'], { type: 'audio/mpeg' }))); }); });
  } });
  s.voice.prefetch([{ say: 'Phrase 0' }, ...Array.from({ length: 100 }, (_, i) => ({ say: `Phrase ${i}` }))]);
  await flush(); assert.equal(texts.length, 1); assert.equal(peak, 1); assert.deepEqual(s.played, []); assert.deepEqual(s.spoken, []);
  const selected = s.voice.say('Selected words'); await flush();
  waiting.shift()(); await flush();
  assert.deepEqual(texts.slice(0, 2), ['Phrase 0', 'Selected words']);
  waiting.shift()(); assert.equal(await selected, true);
  for (let i = 0; i < 6; i++) { await flush(); if (waiting.length) waiting.shift()(); }
  assert.ok(texts.length <= 5, 'prefetch queue stays capped even for oversized input');
  assert.equal(texts.filter(text => text === 'Phrase 0').length, 1);
  assert.equal(peak, 1); s.voice.dispose();
});

test('clip cache is bounded and disposal releases every prepared object URL', async () => {
  const s = setup({ limits: { cached: 2 } });
  for (const text of ['First', 'Second', 'Third', 'Second', 'First']) await s.voice.say(text);
  assert.equal(s.calls.filter(call => call.url === '/tts').length, 4);
  assert.deepEqual(s.revoked, ['prepared-1', 'prepared-3']);
  s.voice.dispose(); assert.deepEqual([...s.revoked].sort(), ['prepared-1', 'prepared-2', 'prepared-3', 'prepared-4']);
  await s.voice.say('First');
  assert.equal(s.calls.filter(call => call.url === '/tts').length, 5, 'a later Chat session can reuse the voice object after disposal');
  s.voice.dispose();
});

test('invalid and oversized audio responses fail before playback and never use device speech', async () => {
  for (const response of [new Response('{}', { headers: { 'content-type': 'application/json' } }), new Response(new Blob([])),
    new Response(new Blob([new Uint8Array(2097153)], { type: 'audio/mpeg' }))]) {
    const s = setup({ fetch: async url => url === '/voices' ? Response.json({ enabled: true, current: 'configured' }) : response });
    await assert.rejects(s.voice.say('My chosen words'), /Saved voice unavailable/);
    assert.deepEqual(s.spoken, []); assert.deepEqual(s.played, []); s.voice.dispose();
  }
});

test('oversized streamed audio is cancelled before the remaining response is buffered', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(524288)); if (pulls === 10) controller.close(); }, cancel() { cancelled = true; } });
  const s = setup({ fetch: async url => url === '/voices' ? Response.json({ enabled: true, current: 'configured' }) : new Response(body, { headers: { 'content-type': 'audio/mpeg' } }) });
  await assert.rejects(s.voice.say('Chosen words'), /Saved voice unavailable/);
  assert.equal(cancelled, true); assert.ok(pulls < 10); assert.deepEqual(s.played, []); s.voice.dispose();
});

test('diagnostic callback failure cannot prevent successful playback completion', async () => {
  const s = setup({ makeAudio: () => ({ pause() {}, play() {
    queueMicrotask(() => { try { this.onplaying?.(); } catch {} });
    queueMicrotask(() => { try { this.onended?.(); } catch {} });
    return Promise.resolve();
  } }) });
  const fail = () => { throw Error('diagnostics unavailable'); };
  const saying = s.voice.say('Chosen words', { onStart: fail, onEnd: fail });
  assert.equal(await Promise.race([saying, new Promise((_, reject) => setTimeout(() => reject(Error('completion was blocked')), 50))]), true);
  s.voice.dispose();
});

test('prefetch timeouts and disposal abort pending work without playback', async () => {
  let aborted = 0;
  const s = setup({ limits: { fetchMs: 10 }, fetch: (url, init) => url === '/voices'
    ? Promise.resolve(Response.json({ enabled: true, current: 'configured' }))
    : new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted++; reject(Error('private upstream error')); })) });
  await assert.rejects(s.voice.say('Timeout words'), error => error.code === 'saved-voice-unavailable' && !error.message.includes('private'));
  s.voice.prefetch([{ say: 'Prepared words' }]); await flush(); s.voice.dispose(); await flush();
  assert.ok(aborted >= 2); assert.deepEqual(s.played, []); assert.deepEqual(s.spoken, []);
});

test('selected preparation has one overall deadline across metadata, queued work and download', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meta = deferred(), clip = deferred(); let outcome = 'pending', calls = 0;
  const s = setup({ limits: { prepareMs: 80, fetchMs: 100 }, fetch: url => {
    if (url === '/voices') return meta.promise;
    calls++; return clip.promise;
  } });
  t.after(() => s.voice.dispose());
  s.voice.say('Chosen words').then(() => { outcome = 'resolved'; }, error => { outcome = error.code; });
  await flush(); t.mock.timers.tick(60);
  meta.resolve(Response.json({ enabled: true, current: 'configured' })); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(21); await flush();
  assert.equal(outcome, 'saved-voice-unavailable', 'the download cannot start a new full preparation deadline');
  clip.resolve(new Response(new Blob(['audio'], { type: 'audio/mpeg' }))); await flush();
  assert.deepEqual(s.played, []); assert.deepEqual(s.spoken, []);
});

test('expired queued selected words never start a later request when background capacity returns', async t => {
  const background = deferred(), texts = [];
  const s = setup({ limits: { concurrent: 1, prepareMs: 10, fetchMs: 1000 }, fetch: (url, init) => {
    if (url === '/voices') return Promise.resolve(Response.json({ enabled: true, current: 'configured' }));
    texts.push(JSON.parse(init.body).text); return background.promise;
  } });
  t.after(() => s.voice.dispose());
  s.voice.prefetch([{ say: 'Background words' }]); await flush();
  await assert.rejects(s.voice.say('Expired selected words'), error => error.code === 'saved-voice-unavailable');
  background.resolve(new Response(new Blob(['audio'], { type: 'audio/mpeg' }))); await flush();
  assert.deepEqual(texts, ['Background words']); assert.deepEqual(s.played, []);
});
