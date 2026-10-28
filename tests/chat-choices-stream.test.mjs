// Streamed structured choices (real-time chat spec 2026-10-27 §3.3): the reply
// service streams its strict JSON, each choice is parsed the moment its object
// closes (the bake-off's incremental parser, tools/chat-reply-bakeoff.mjs), and
// the finished batch passes every post-check of the published path before it
// counts. The fast processing tier rides as one body field when configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChoicesAdapter, createChoiceStream } = require('../chat-choices.js');
const env = { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'reply-model', ERA_CHAT_TEXT_TOKEN: 'private-value' };
const reply = { choices: [{ label: 'Music', say: 'Music, please.', symbol: 'music', picture: 'headphones' }, { label: 'A story', say: 'A story, please.', symbol: 'book' }, { label: 'Not sure', say: 'I am not sure.', symbol: 'chat', picture: 'shrug' }] };

// A streamed reply the test releases piece by piece.
function streamed(events) {
  let push, done;
  const body = new ReadableStream({ start(controller) {
    push = event => controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
    done = () => controller.close();
  } });
  return { response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }), push: e => push(e), end: () => done(), events };
}
const deltas = (text, size = 7) => { const out = []; for (let i = 0; i < text.length; i += size) out.push({ type: 'response.output_text.delta', delta: text.slice(i, i + size) }); return out; };
const completed = { type: 'response.completed', response: { usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 60 } } };

test('the parser yields each choice when its object closes, across arbitrary chunk boundaries', () => {
  const got = []; let closed = 0;
  const parser = createChoiceStream({ onChoice: c => got.push(c.label), onClose: () => closed++ });
  const text = JSON.stringify({ choices: [{ label: 'A "quoted" }{', say: 'x' }, { label: 'B', say: 'y' }] });
  for (const ch of text) parser.push(ch);
  assert.deepEqual(got, ['A "quoted" }{', 'B']); assert.equal(closed, 1); assert.equal(parser.text(), text);
});

test('streaming asks for a stream on the fast tier and hands each choice over before the reply ends', async () => {
  let body, stream;
  const adapter = createChoicesAdapter({ env: { ...env, ERA_CHAT_TEXT_SERVICE_TIER: 'priority' }, fetch: async (url, init) => { body = JSON.parse(init.body); stream = streamed(); return stream.response; } });
  const seen = [];
  const working = adapter.generateStream({ text: 'Would you rather hear music or a story today?' }, { onChoice: choice => seen.push(choice) });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(body.stream, true); assert.equal(body.service_tier, 'priority'); assert.equal(body.model, 'reply-model');
  const text = JSON.stringify(reply), cut = text.indexOf('}') + 1;
  for (const event of deltas(text.slice(0, cut))) stream.push(event);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(seen.map(c => c.label), ['Music'], 'the first choice is staged while the reply is still streaming');
  for (const event of deltas(text.slice(cut))) stream.push(event);
  stream.push(completed); stream.end();
  const result = await working;
  assert.deepEqual(seen.map(c => c.label), ['Music', 'A story', 'Not sure']);
  assert.deepEqual(seen.map(c => c.picture), ['headphones', undefined, 'shrug'], 'each staged choice carries the model\'s picture words');
  assert.deepEqual(result.choices.map(c => c.picture), ['headphones', undefined, 'shrug']);
  assert.deepEqual(result.choices.map(c => c.say), reply.choices.map(c => c.say));
  assert.equal(result.kind, 'generated'); assert.equal(result.generated, true);
  assert.deepEqual(result.usage, { model: 'reply-model', inputTokens: 900, cachedTokens: 0, outputTokens: 60 });
  assert.ok(Number.isFinite(result.timings.firstChoiceMs) && result.timings.firstChoiceMs <= result.timings.totalMs);
});

test('without a tier setting the body carries none; an unknown tier word is ignored', async () => {
  for (const tier of [undefined, 'PRIORITY!']) {
    let body;
    const adapter = createChoicesAdapter({ env: { ...env, ...(tier ? { ERA_CHAT_TEXT_SERVICE_TIER: tier } : {}) }, fetch: async (url, init) => {
      body = JSON.parse(init.body); const s = streamed(); for (const e of deltas(JSON.stringify(reply))) s.push(e); s.push(completed); s.end(); return s.response; } });
    await adapter.generateStream({ text: 'Music or a story, which one now?' });
    assert.equal('service_tier' in body, false);
  }
});

test('a streamed batch that fails the post-checks is replaced or refused as a whole', async () => {
  const run = async (value, extra = []) => {
    const adapter = createChoicesAdapter({ env, fetch: async () => { const s = streamed(); for (const e of deltas(JSON.stringify(value))) s.push(e); for (const e of extra) s.push(e); s.push(completed); s.end(); return s.response; } });
    return adapter.generateStream({ text: 'Which one do you want now?' });
  };
  await assert.rejects(run({ choices: [{ label: 'Same', say: 'Same.' , symbol: 'chat' }, { label: 'Same', say: 'Same.', symbol: 'chat' }] }), error => error.code === 'generation-invalid');
  await assert.rejects(run(reply, [{ type: 'response.refusal.delta', delta: 'no' }]), error => error.code === 'generation-refused');
  const adapter = createChoicesAdapter({ env, fetch: async () => { const s = streamed(); for (const e of deltas(JSON.stringify({ choices: [{ label: 'Mine', say: 'I have my drawing too.', symbol: 'chat' }, { label: 'Sad', say: 'That is sad.', symbol: 'sad' }] }))) s.push(e); s.push(completed); s.end(); return s.response; } });
  const seen = [];
  const guarded = await adapter.generateStream({ text: 'Have you seen my drawing anywhere?' }, { onChoice: c => seen.push(c) });
  assert.equal(seen.length, 2, 'staged as they came');
  assert.equal(guarded.kind, 'guarded', 'the sealed batch keeps ownership: the communicator never claims the partner\'s loss');
  const incomplete = createChoicesAdapter({ env, fetch: async () => { const s = streamed(); for (const e of deltas(JSON.stringify(reply).slice(0, 30))) s.push(e); s.push({ type: 'response.incomplete', response: {} }); s.end(); return s.response; } });
  await assert.rejects(incomplete.generateStream({ text: 'Music or story, what now?' }), error => error.status === 502);
});

test('cancelling a streamed request aborts it and reports cancelled', async () => {
  let signal;
  const adapter = createChoicesAdapter({ env, fetch: async (url, init) => { signal = init.signal; return streamed().response; } });
  const controller = new AbortController();
  const working = adapter.generateStream({ text: 'Music or a story, what now?' }, { signal: controller.signal });
  await new Promise(r => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(working, error => error.code === 'generation-cancelled');
  assert.equal(signal.aborted, true);
});

test('a streamed recall batch that asserts a past activity is sealed as the four fixed repairs', async () => {
  const invented = { choices: [{ label: 'The park', say: 'I went to the park.', symbol: 'chat' }, { label: 'Fun', say: 'It was fun.', symbol: 'chat' }, { label: 'Not now', say: 'Not now.', symbol: 'chat' }] };
  let body;
  const adapter = createChoicesAdapter({ env, fetch: async (url, init) => { body = JSON.parse(init.body); const s = streamed(); for (const e of deltas(JSON.stringify(invented))) s.push(e); s.push(completed); s.end(); return s.response; } });
  const seen = [];
  const result = await adapter.generateStream({ text: 'What did you do last weekend?', shape: 'recall' }, { onChoice: c => seen.push(c) });
  assert.equal(JSON.parse(body.input).shape, 'recall');
  assert.equal(seen.length, 3, 'staged as they came; only the sealed batch is ever shown');
  assert.equal(result.kind, 'guarded'); assert.equal(result.generated, false); assert.equal(result.recallRejected, true);
  assert.deepEqual(result.choices.map(c => c.say), ['Can you give me a clue?', 'Let me tell you another way.', "I don't remember.", "I don't want to answer now."]);
  assert.deepEqual(result.usage, { model: 'reply-model', inputTokens: 900, cachedTokens: 0, outputTokens: 60 });
  assert.ok(Number.isFinite(result.timings.firstChoiceMs));
});

test('a streamed recall batch that names something from world is kept; world travels in the streamed request', async () => {
  const world = 'Today: Wednesday, October 28.\nLast week at school: "Magnets!". Science: magnets. Words: magnet, pull, push.';
  const known = { choices: [{ label: 'Magnets', say: 'I learned about magnets.', symbol: 'chat' }, { label: 'Fun', say: 'It was fun.', symbol: 'chat' }, { label: 'Not now', say: 'Not now.', symbol: 'chat' }] };
  const run = async (value, input) => {
    let body;
    const adapter = createChoicesAdapter({ env, fetch: async (url, init) => { body = JSON.parse(init.body); const s = streamed(); for (const e of deltas(JSON.stringify(value))) s.push(e); s.push(completed); s.end(); return s.response; } });
    return { result: await adapter.generateStream(input, { onChoice: () => {} }), input: JSON.parse(body.input) };
  };
  const kept = await run(known, { text: 'What did you learn last week?', shape: 'recall', world });
  assert.equal(kept.input.world, world);
  assert.equal(kept.result.kind, 'generated'); assert.equal('recallRejected' in kept.result, false);
  assert.deepEqual(kept.result.choices.map(c => c.say), known.choices.map(c => c.say));
  const zoo = { choices: [{ label: 'Zoo', say: 'I went to the zoo.', symbol: 'chat' }, { label: 'Fun', say: 'It was fun.', symbol: 'chat' }] };
  assert.equal((await run(zoo, { text: 'What did you learn last week?', shape: 'recall', world })).result.recallRejected, true);
});
