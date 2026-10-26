// Exercise the real symbol lookup/cache path with controlled fetch responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const constants = ['ARASAAC_API', 'ARASAAC_IMG'].map(name => {
  const found = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
  assert.ok(found, `symbol endpoint ${name} is defined`);
  return found[0];
}).join('\n');
const lookup = source.match(/^async function fetchSymbolToCache\(name\) \{[\s\S]*?\n\}/m)?.[0];
assert.ok(lookup, 'production symbol cache function is available');

function setup(t, hits = [{ _id: 41 }]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'era-symbol-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const bytes = Buffer.from('synthetic image bytes');
  const context = vm.createContext({
    fs, path, Buffer, SYMBOLS_CACHE: directory,
    process: { env: { ERA_SYMBOL_SEARCH_URL: 'http://stand-in/search/',
      ERA_SYMBOL_IMAGE_URL: 'http://stand-in/images/{id}/{id}.png' } },
    fetch: async url => {
      calls.push(url);
      return { ok: true, json: async () => hits,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    console: { error() {} },
  });
  vm.runInContext(constants + '\n' + lookup, context);
  return { context, directory, calls, bytes };
}

test('a symbol miss uses injected search/image endpoints and writes the returned bytes', async t => {
  const { context, directory, calls, bytes } = setup(t);
  const result = await context.fetchSymbolToCache('apple');
  assert.equal(result, path.join(directory, 'apple.png'));
  assert.deepEqual(calls, ['http://stand-in/search/apple', 'http://stand-in/images/41/41.png']);
  assert.deepEqual(fs.readFileSync(result), bytes);
});

test('a pinned numeric symbol uses only the injected image endpoint', async t => {
  const { context, calls } = setup(t);
  assert.ok(await context.fetchSymbolToCache('41'));
  assert.deepEqual(calls, ['http://stand-in/images/41/41.png']);
});

test('an empty search writes no cache entry and makes no image request', async t => {
  const { context, calls, directory } = setup(t, []);
  assert.equal(await context.fetchSymbolToCache('missing'), null);
  assert.deepEqual(calls, ['http://stand-in/search/missing']);
  assert.deepEqual(fs.readdirSync(directory), []);
});
