import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createChoicesAdapter, createChoicesServer, adapterPort } from '../tools/chat-choices-adapter.mjs';

const env = { ERA_CHAT_TEXT_URL: 'https://text.example/responses', ERA_CHAT_TEXT_MODEL: 'configured', ERA_CHAT_TEXT_TOKEN: 'private-value' };
const choices = [{ label: 'Games', say: "Let's talk about games." }, { label: 'Something else', say: "I'd like to talk about something else." }];
const response = value => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));

test('adapter is disabled without explicit runtime configuration and never calls a service', async () => {
  let calls = 0;
  const adapter = createChoicesAdapter({ env: {}, fetch: async () => { calls++; } });
  assert.equal(adapter.available, false);
  await assert.rejects(adapter.generate({ text: 'What shall we talk about?' }), /unavailable/);
  assert.equal(calls, 0);
});

test('structured request carries bounded context, no persistence and no automatic speech', async () => {
  let calls = 0;
  const adapter = createChoicesAdapter({ env, fetch: async (url, options) => {
    calls++;
    assert.equal(url, env.ERA_CHAT_TEXT_URL);
    assert.equal(options.headers.Authorization, 'Bearer ' + env.ERA_CHAT_TEXT_TOKEN);
    const body = JSON.parse(options.body);
    assert.equal(body.model, env.ERA_CHAT_TEXT_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.properties.choices.maxItems, 4);
    assert.deepEqual(JSON.parse(body.input), { question: 'What next?', context: ['Me: I like games.'] });
    assert.match(body.instructions, /Do not invent/i);
    assert.ok(!('tools' in body) && !('audio' in body));
    return response({ choices });
  } });
  const result = await adapter.generate({ text: 'What next?', context: ['Me: I like games.'] });
  assert.equal(calls, 1);
  assert.deepEqual(result.choices, choices);
  assert.equal(result.kind, 'generated');
  assert.ok(result.timings.totalMs >= 0);
  assert.ok(!JSON.stringify(result).includes('private-value'));
});

test('request validation rejects excess context or invalid text before a paid call', async () => {
  const adapter = createChoicesAdapter({ env, fetch: () => { throw Error('must not call'); } });
  for (const input of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 'Question?', context: [null] },
    { text: 'Question?', context: Array(9).fill('turn') }, { text: 'Question?', context: ['x'.repeat(501)] }])
    await assert.rejects(adapter.generate(input), /invalid/);
});

const REPAIRS = ['Can you give me a clue?', 'Let me tell you another way.', "I don't remember.", "I don't want to answer now."];
test('a recall question goes to the model with its shape; an asserted past activity throws the batch out for the fixed repairs', async () => {
  const bodies = [];
  const run = (value, input) => createChoicesAdapter({ env, fetch: async (_, options) => { bodies.push(JSON.parse(options.body)); return response(value); } }).generate(input);
  const invented = { choices: [{ label: 'The park', say: 'I went to the park.' }, { label: 'Fun', say: 'It was fun.' }, { label: 'Not now', say: 'Not now.' }] };
  for (const input of [{ text: 'What did you do last weekend?', shape: 'recall' },
    { text: 'What happened in your book?', shape: 'recall', context: ['Me: I read a book about a dragon.'] },
    { text: 'What did you do last weekend?', shape: 'recall', context: ['Partner: You played outside.'] }]) {
    const result = await run(invented, input);
    assert.equal(JSON.parse(bodies.at(-1).input).shape, 'recall', 'the request carries the shape');
    assert.equal(result.kind, 'guarded');
    assert.equal(result.generated, false);
    assert.equal(result.recallRejected, true);
    assert.deepEqual(result.choices.map(x => x.say), REPAIRS);
  }
  for (const say of ['We played tag.', 'I also saw a dog.', 'It was at the beach.', 'We were at grandma’s house.', 'I ate cake.'])
    assert.equal((await run({ choices: [{ label: 'One', say }, { label: 'Two', say: 'It was fun.' }] }, { text: 'What did you do?', shape: 'recall' })).recallRejected, true, say);
  for (const say of ['I had pizza.', 'We had a party.', 'I did a puzzle.'])
    assert.equal((await run({ choices: [{ label: 'One', say }, { label: 'Two', say: 'It was fun.' }] }, { text: 'What did you do?', shape: 'recall' })).recallRejected, true, say);
  // A feeling is not an event: these pass the recall check.
  for (const say of ['I had fun.', 'I had a good time.', 'I had a great day.', 'I did not like it.', "I didn't want to."]) {
    const result = await run({ choices: [{ label: 'One', say }, { label: 'Two', say: 'Can you give me a clue?' }] }, { text: 'What did you do?', shape: 'recall' });
    assert.equal(result.kind, 'generated', say); assert.equal('recallRejected' in result, false, say);
  }
  const clean = { choices: [{ label: 'Fun', say: 'It was fun.' }, { label: 'Tell you', say: 'I want to tell you.' },
    { label: 'A clue', say: 'Can you give me a clue?' }, { label: 'Not now', say: 'Not now.' }] };
  const passed = await run(clean, { text: 'What did you do last weekend?', shape: 'recall' });
  assert.equal(passed.kind, 'generated');
  assert.equal(passed.generated, true);
  assert.equal('recallRejected' in passed, false);
  assert.deepEqual(passed.choices.map(x => x.say), clean.choices.map(x => x.say));
  // Without the recall shape the same words are not checked: a proposal may say "we played".
  assert.equal((await run(invented, { text: 'What next?' })).kind, 'generated');
});

test('a confirmed earlier utterance with the same time anchor goes first and three model choices stay behind it', async () => {
  const clean = { choices: [{ label: 'Fun', say: 'It was fun.' }, { label: 'Tell you', say: 'I want to tell you.' },
    { label: 'A clue', say: 'Can you give me a clue?' }, { label: 'Not now', say: 'Not now.' }] };
  const adapter = createChoicesAdapter({ env, fetch: async () => response(clean) });
  const known = await adapter.generate({ text: 'What did you do last weekend?', shape: 'recall', context: ['Me: Last weekend I read a book.'] });
  assert.deepEqual(known.choices.map(x => x.say), ['Last weekend I read a book.', 'It was fun.', 'I want to tell you.', 'Can you give me a clue?']);
  assert.equal(known.choices[0].label, 'My earlier words');
  const other = await adapter.generate({ text: 'What did you do yesterday?', shape: 'recall', context: ['Me: Last weekend I read a book.'] });
  assert.equal(other.choices.length, 4, 'a different anchor quotes nothing');
  assert.ok(!other.choices.some(x => x.say === 'Last weekend I read a book.'));
  const rejected = await createChoicesAdapter({ env, fetch: async () => response({ choices: [{ label: 'Zoo', say: 'We went to the zoo.' }, { label: 'Fun', say: 'It was fun.' }] }) })
    .generate({ text: 'What did you do last weekend?', shape: 'recall', context: ['Me: Last weekend I read a book.'] });
  assert.equal(rejected.recallRejected, true);
  assert.deepEqual(rejected.choices.map(x => x.say), ['Last weekend I read a book.', ...REPAIRS.slice(0, 3)]);
});

test('an open shape and the device likes reach the model; four are asked for, three are accepted', async () => {
  let body;
  const three = { choices: [{ label: 'Draw', say: 'I want to draw.' }, { label: 'Outside', say: 'Let us play outside.' }, { label: 'A show', say: 'I want to watch a show.' }] };
  const adapter = createChoicesAdapter({ env, fetch: async (_, options) => { body = JSON.parse(options.body); return response(three); } });
  const result = await adapter.generate({ text: 'What do you want to do today?', shape: 'want', likes: ['draw', 'play outside', 'x'.repeat(31), 7, 'watch a show'] });
  assert.deepEqual(JSON.parse(body.input), { question: 'What do you want to do today?', context: [], shape: 'want', likes: ['draw', 'play outside', 'watch a show'] });
  assert.match(body.instructions, /Do not invent/i);
  assert.match(body.instructions, /exactly four/i);
  assert.equal(result.kind, 'generated');
  assert.equal(result.choices.length, 3);
  for (const junk of ['wonder', 7, null]) {
    await adapter.generate({ text: 'What next?', shape: junk, likes: 'draw' });
    assert.deepEqual(JSON.parse(body.input), { question: 'What next?', context: [] }, 'an unknown shape and a non-list of likes are dropped');
  }
  await adapter.generate({ text: 'What next?', shape: 'open', likes: Array.from({ length: 20 }, (_, i) => 'like ' + i) });
  assert.equal(JSON.parse(body.input).likes.length, 12);
});

test('partner feelings and possessions never become unsupported first-person child claims', async () => {
  for (const bad of ['I lost my drawing.', 'I feel sad because my drawing is lost.', 'Can we find my lost drawing?']) {
    const adapter = createChoicesAdapter({ env, fetch: async () => response({ choices: [{ label: 'Tell you', say: bad }, choices[1]] }) });
    const result = await adapter.generate({ text: 'I feel sad because I lost my drawing. What could we do?' });
    assert.equal(result.kind, 'guarded');
    assert.equal(result.generated, false);
    assert.ok(result.choices.every(x => !/my.*drawing|I (?:feel sad|lost)/i.test(x.say)));
  }
});

test('explicit reasoning configuration is passed without choosing a model in code', async () => {
  const adapter = createChoicesAdapter({ env: { ...env, ERA_CHAT_TEXT_REASONING: 'none' }, fetch: async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).reasoning, { effort: 'none' });
    return response({ choices });
  } });
  await adapter.generate({ text: 'What next?' });
});

test('invalid structures, duplicate meanings, oversized replies and refusals fail explicitly', async () => {
  const bodies = [
    { choices: [choices[0]] }, { choices: [choices[0], choices[0]] },
    { choices: [{ label: 'x'.repeat(41), say: 'words' }, choices[1]] },
    { choices: [{ label: 'Unsafe', say: '<markup>' }, choices[1]] },
    { choices: [{ label: 'First', say: 'x'.repeat(181) }, choices[1]] },
  ];
  for (const body of bodies) {
    const adapter = createChoicesAdapter({ env, fetch: async () => response(body) });
    await assert.rejects(adapter.generate({ text: 'What next?' }), /invalid/);
  }
  for (const reply of [new Response('x'.repeat(70000)), new Response('bad-json'),
    new Response(JSON.stringify({ status: 'incomplete', output: [] })),
    new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private text' }] }] }))]) {
    const adapter = createChoicesAdapter({ env, fetch: async () => reply });
    await assert.rejects(adapter.generate({ text: 'What next?' }), /invalid|refused/);
  }
});

test('service errors are sanitized and requests are cancelled on timeout or caller abort', async () => {
  const bad = createChoicesAdapter({ env, fetch: async () => { throw Error('private upstream details'); } });
  await assert.rejects(bad.generate({ text: 'What next?' }), error => error.message === 'generation-unavailable');
  const adapter = createChoicesAdapter({ env, limits: { timeoutMs: 20 }, fetch: async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Error('aborted')));
  }) });
  await assert.rejects(adapter.generate({ text: 'What next?' }), /unavailable/);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(adapter.generate({ text: 'What next?' }, { signal: signal.signal }), /cancelled/);
});

test('HTTP adapter rejects cross-origin traffic, caps payloads and closes pending generation', async t => {
  let calls = 0;
  const server = createChoicesServer({ env, fetch: async () => { calls++; return response({ choices }); } });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://localhost:${server.address().port}`;
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.available, true);
  assert.ok(!JSON.stringify(health).includes('private-value'));
  const request = (body, headers = {}) => fetch(base + '/choices', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await request({ text: 'What next?' }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request({ text: 'x'.repeat(17000) })).status, 413);
  assert.equal((await fetch(base + '/choices', { method: 'POST', body: 'text=data' })).status, 415);
  const result = await request({ text: 'What next?' });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).choices, choices);
  assert.equal(calls, 1);
  // A full question with a full context and a world at the digest cap still fits.
  const full = await request({ text: 'W'.repeat(2000), context: Array(8).fill('Me: ' + 'c'.repeat(496)), shape: 'open', world: 'Today: x.\n' + 'w'.repeat(3990) });
  assert.equal(full.status, 200); assert.equal(calls, 2);
  assert.equal(adapterPort({}), 8385);
  assert.throws(() => adapterPort({ ERA_CHAT_TEXT_PORT: String(8300 + 77) }));
});

test('disconnect aborts an in-flight upstream call and releases capacity', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let cancelled;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const server = createChoicesServer({ env, fetch: async (_, options) => new Promise((resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => { cancelled(); reject(Error('abort')); });
  }) });
  await new Promise(resolve => server.listen(0, 'localhost', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const controller = new AbortController();
  const pending = fetch(`http://localhost:${server.address().port}/choices`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'What next?' }), signal: controller.signal }).catch(() => {});
  await began; controller.abort(); await pending;
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(Error('not cancelled')), 500))]);
});

test('a generated batch reports the reply model\'s token usage and the configured model id, never the credential', async () => {
  const withUsage = (value, usage) => new Response(JSON.stringify({ status: 'completed', usage,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
  const adapter = createChoicesAdapter({ env, fetch: async () => withUsage({ choices }, { input_tokens: 812, input_tokens_details: { cached_tokens: 128 }, output_tokens: 57, total_tokens: 869 }) });
  const result = await adapter.generate({ text: 'What next?' });
  assert.deepEqual(result.usage, { model: 'configured', inputTokens: 812, cachedTokens: 128, outputTokens: 57 });
  assert.ok(!JSON.stringify(result).includes('private-value'));
  const noDetails = createChoicesAdapter({ env, fetch: async () => withUsage({ choices }, { input_tokens: 10, output_tokens: 5 }) });
  assert.deepEqual((await noDetails.generate({ text: 'What next?' })).usage, { model: 'configured', inputTokens: 10, cachedTokens: 0, outputTokens: 5 });
  for (const usage of [undefined, { input_tokens: -1, output_tokens: 5 }, { input_tokens: '10', output_tokens: 5 }]) {
    const adapter = createChoicesAdapter({ env, fetch: async () => withUsage({ choices }, usage) });
    assert.equal('usage' in await adapter.generate({ text: 'What next?' }), false, 'no usage is reported when the service gave none we can trust');
  }
  // A recall question is a paid call now; its usage is reported even when the batch is thrown out.
  const recall = await createChoicesAdapter({ env, fetch: async () => withUsage({ choices: [{ label: 'Park', say: 'I went to the park.' }, choices[1]] }, { input_tokens: 10, output_tokens: 5 }) })
    .generate({ text: 'What did you do last weekend?', shape: 'recall' });
  assert.equal(recall.recallRejected, true);
  assert.deepEqual(recall.usage, { model: 'configured', inputTokens: 10, cachedTokens: 0, outputTokens: 5 });
  const guarded = await createChoicesAdapter({ env, fetch: () => { throw Error('must not call'); } }).generate({ text: 'I lost my drawing. What now?' });
  assert.equal('usage' in guarded, false, 'the partner-incident guard makes no paid call and reports no usage');
});

test('recall asks for a spread, not four repairs; the repair limit names recall as its exception', async () => {
  let body;
  await createChoicesAdapter({ env, fetch: async (_, options) => { body = JSON.parse(options.body); return response({ choices }); } }).generate({ text: 'What next?' });
  assert.match(body.instructions, /Shape recall: a spread of two about how it felt \(such as 'It was fun', 'It was okay', 'Not so good'\), one wish to tell \('I want to tell you' or 'Let me tell you another way'\), and one asking for a clue or not now; never state a past activity, place or person as a fact\./);
  assert.match(body.instructions, /At most one of the four is a repair \(not sure, tell me more, another way\), never two, except for shape recall, where a clue and another way may both appear\./);
  assert.match(body.instructions, /people: the family's own names; when the question asks who, most of the four choices are names from people \(a name alone as the label, 'Mom' as the say is fine\), with at most one other choice\./);
});

test('the family\'s names go to the model only with an open who question, cleaned and capped', async () => {
  let body;
  const adapter = createChoicesAdapter({ env, fetch: async (_, options) => { body = JSON.parse(options.body); return response({ choices }); } });
  const input = () => JSON.parse(body.input);
  await adapter.generate({ text: 'Who do you want to sit with?', shape: 'want', people: ['Mom', ' Dad ', 'x'.repeat(21), 7, '<b>', 'Sam'] });
  assert.deepEqual(input().people, ['Mom', 'Dad', 'Sam']);
  await adapter.generate({ text: 'Whom shall we call?', shape: 'want', people: Array.from({ length: 20 }, (_, i) => 'Name' + i) });
  assert.equal(input().people.length, 12);
  await adapter.generate({ text: 'What do you want to do today?', shape: 'want', people: ['Mom'] });
  assert.equal('people' in input(), false, 'not a who question');
  await adapter.generate({ text: 'Who is coming?', people: ['Mom'] });
  assert.equal('people' in input(), false, 'no shape, no names');
  await adapter.generate({ text: 'Who is coming?', shape: 'open', people: 'Mom' });
  assert.equal('people' in input(), false, 'a non-list is dropped');
});

// Her world (plan "Her world as context", 10/28): known facts from the device's
// week packages, shelf, people and likes, sent with an open-ended question.
const WORLD = 'Today: Wednesday, October 28.\nThis week at school: "Magnets!". Science: magnets. Hero of the week: a famous inventor. Words: magnet, pull, push.\nShe likes: draw, music.';

test('the instructions say world is known context the model may state, drawn from the part the question points at', async () => {
  let body;
  await createChoicesAdapter({ env, fetch: async (_, options) => { body = JSON.parse(options.body); return response({ choices }); } }).generate({ text: 'What next?' });
  assert.match(body.instructions, /world: what the communicator's class is learning week by week, the books on her shelf, her people and what she likes, known facts from her family and school\. For an open-ended question about school, a week, a lesson, a book, a hero, people or what she likes, draw the four choices from the part of world the question points at \(last week means the week marked Last week; a favourite thing at school means that week's topics, words and videos\), stated plainly as things she could say, such as 'Learning about shadows', 'Wilma Rudolph', 'The Gruffalo'\. World is known, not invented, so it may be stated; beyond world the rules against invented facts stand\./);
});

test('world reaches the model with an open-ended question, newlines kept; anything else is dropped', async () => {
  let body;
  const adapter = createChoicesAdapter({ env, fetch: async (_, options) => { body = JSON.parse(options.body); return response({ choices }); } });
  const input = () => JSON.parse(body.input);
  await adapter.generate({ text: 'What was your favourite thing at school?', shape: 'open', world: WORLD });
  assert.equal(input().world, WORLD);
  await adapter.generate({ text: 'What was your favourite thing at school?', world: WORLD });
  assert.equal('world' in input(), false, 'no shape, no world');
  for (const junk of [7, '', '   ', 'x'.repeat(4001), 'Today: x.\tTab', 'Today: <b>x</b>', 'Today: x.\u0000', ['Today']]) {
    await adapter.generate({ text: 'What did you learn?', shape: 'open', world: junk });
    assert.equal('world' in input(), false, JSON.stringify(junk).slice(0, 40));
  }
  await adapter.generate({ text: 'What did you learn?', shape: 'open', world: 'x\n'.repeat(2000) });
  assert.equal(input().world.length, 3999, 'up to the digest cap of 4,000, trimmed');
});

test('the recall check passes a reply that names something from world and still throws out an activity world never mentions', async () => {
  const run = (say, world) => createChoicesAdapter({ env, fetch: async () => response({ choices: [{ label: 'One', say }, { label: 'Two', say: 'It was fun.' }] }) })
    .generate({ text: 'What did you learn at school last week?', shape: 'recall', ...(world ? { world } : {}) });
  for (const say of ['I learned about magnets.', 'We read about magnets.', 'I saw a famous inventor.', 'We played push and pull.']) {
    const passed = await run(say, WORLD);
    assert.equal(passed.kind, 'generated', say); assert.equal('recallRejected' in passed, false, say);
    assert.equal((await run(say)).recallRejected, true, 'without world the same words are thrown out: ' + say);
  }
  for (const say of ['I went to the zoo.', 'We watched a movie this week.', 'I learned about school.', 'Last week I saw a friend.'])
    assert.equal((await run(say, WORLD)).recallRejected, true, 'stop words and words outside world never pass: ' + say);
  // The day notes and teachers' lists from world.json grow the terms; their scaffolding does not.
  const notes = WORLD + '\nLast week at school she did: a leaf collage; a song about seasons.\nLast week her class worked on: counting by fives.\nYesterday at school: happy; speech, buddies. She said on her device: She wants to paint.';
  for (const say of ['I made a leaf collage.', 'We did buddies.', 'We went to speech.'])
    assert.equal((await run(say, notes)).kind, 'generated', say);
  for (const say of ['I went to the park yesterday.', 'I saw it on my device.', 'We went to class.'])
    assert.equal((await run(say, notes)).recallRejected, true, say);
});
