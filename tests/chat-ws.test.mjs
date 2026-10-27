// chat-ws.js: the hub's own RFC 6455 WebSocket (real-time chat spec
// 2026-10-27 §3.1). No dependency: the page's audio channel is served by it
// and the hub's streaming-transcription client connects with it. Owned
// loopback servers only; a raw TCP client plays the browser where the test
// needs to send frames a well-behaved client never would.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acceptWebSocket, connectWebSocket, encodeFrame } = require('../chat-ws.js');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function server(t, onSocket, options = {}) {
  const sockets = [];
  const srv = http.createServer((req, res) => res.writeHead(404).end());
  srv.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head, options);
    if (ws) { sockets.push(ws); onSocket?.(ws, req); }
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const ws of sockets) ws.terminate(); srv.closeAllConnections?.(); await new Promise(resolve => srv.close(resolve)); });
  return { port: srv.address().port, sockets };
}
// A raw client: writes the handshake and then whatever bytes the test wants.
async function raw(port, { key = crypto.randomBytes(16).toString('base64'), headers = {} } = {}) {
  const socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect');
  const lines = [`GET /chat HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  let received = Buffer.alloc(0);
  socket.on('data', chunk => { received = Buffer.concat([received, chunk]); });
  const closed = once(socket, 'close');
  return { socket, key, closed, bytes: () => received };
}
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
// Server frames are never masked: parse them back for assertions.
function frames(bytes) {
  const out = []; let offset = bytes.indexOf('\r\n\r\n') + 4;
  while (offset + 2 <= bytes.length) {
    const b0 = bytes[offset], b1 = bytes[offset + 1]; let length = b1 & 0x7f, at = offset + 2;
    if (length === 126) { length = bytes.readUInt16BE(at); at += 2; } else if (length === 127) { length = Number(bytes.readBigUInt64BE(at)); at += 8; }
    if (at + length > bytes.length) break;
    out.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, masked: !!(b1 & 0x80), payload: bytes.subarray(at, at + length) });
    offset = at + length;
  }
  return out;
}
const closeCode = frame => frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;

test('handshake answers 101 with the RFC accept value; a bad key or version is refused with 400', async t => {
  const s = await server(t);
  const good = await raw(s.port);
  await until(() => good.bytes().includes('\r\n\r\n'));
  const head = good.bytes().toString('latin1');
  assert.match(head, /^HTTP\/1\.1 101 /);
  assert.ok(head.includes('Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(good.key + GUID).digest('base64')));
  good.socket.destroy();
  for (const bad of [{ key: 'short' }, { headers: { 'Sec-WebSocket-Version': '8' } }]) {
    const client = await raw(s.port, bad);
    await client.closed;
    assert.match(client.bytes().toString('latin1'), /^HTTP\/1\.1 400 /, JSON.stringify(bad));
  }
  assert.equal(s.sockets.length, 1);
});

test('the client and server exchange text and binary in order, masking only client frames', async t => {
  const got = [];
  const s = await server(t, ws => ws.on('message', (data, binary) => { got.push([binary, binary ? [...data] : data]); ws.send(binary ? Buffer.from([9, ...data]) : 'echo:' + data); }));
  const client = await connectWebSocket(`ws://127.0.0.1:${s.port}/x?y=1`, { headers: { Authorization: 'secret' } });
  const echoes = []; client.on('message', (data, binary) => echoes.push(binary ? [...data] : data));
  client.send('one'); client.send(Buffer.from([1, 2, 3])); client.send('three'); client.send(Buffer.alloc(70000, 7));
  await until(() => echoes.length === 4);
  assert.deepEqual(got.slice(0, 3), [[false, 'one'], [true, [1, 2, 3]], [false, 'three']]);
  assert.equal(got[3][1].length, 70000);
  assert.deepEqual(echoes.slice(0, 3), ['echo:one', [9, 1, 2, 3], 'echo:three']);
  assert.equal(echoes[3].length, 70001);
  client.close(1000, 'done');
  const [{ code, reason }] = await once(client, 'close');
  assert.equal(code, 1000); assert.equal(reason, 'done');
});

test('the client sends custom headers and rejects a refused handshake with its status', async t => {
  let seen;
  const srv = http.createServer((req, res) => res.writeHead(404).end());
  srv.on('upgrade', (req, socket, head) => {
    seen = req;
    if (req.url.includes('refuse')) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    acceptWebSocket(req, socket, head);
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.closeAllConnections?.(); srv.close(resolve); }));
  const port = srv.address().port;
  const ok = await connectWebSocket(`ws://127.0.0.1:${port}/ok?q=a%20b`, { headers: { Authorization: 'Token abc' } });
  assert.equal(seen.headers.authorization, 'Token abc'); assert.equal(seen.url, '/ok?q=a%20b');
  ok.terminate();
  await assert.rejects(connectWebSocket(`ws://127.0.0.1:${port}/refuse`), error => error.code === 'ws-handshake' && error.status === 401);
  await assert.rejects(connectWebSocket('ftp://127.0.0.1/'), error => error.code === 'ws-url');
});

test('an unmasked client frame is a protocol error (1002) and closes the socket', async t => {
  const closes = [];
  const s = await server(t, ws => ws.on('close', event => closes.push(event)));
  const client = await raw(s.port);
  await until(() => client.bytes().includes('\r\n\r\n'));
  client.socket.write(encodeFrame(0x2, Buffer.from([1, 2]), false));
  await client.closed;
  const close = frames(client.bytes()).find(frame => frame.opcode === 0x8);
  assert.equal(closeCode(close), 1002);
  await until(() => closes.length === 1);
  assert.equal(closes[0].code, 1002);
});

test('fragmented messages are refused cleanly with 1003 when the server does not take them', async t => {
  const messages = [];
  const s = await server(t, ws => ws.on('message', data => messages.push(data)));
  const client = await raw(s.port);
  await until(() => client.bytes().includes('\r\n\r\n'));
  client.socket.write(encodeFrame(0x2, Buffer.from([1]), true, false)); // FIN clear: a first fragment
  await client.closed;
  assert.equal(closeCode(frames(client.bytes()).find(frame => frame.opcode === 0x8)), 1003);
  assert.equal(messages.length, 0);
});

test('the client side reassembles fragments a service may send', async t => {
  const s = await server(t, ws => {
    ws.socket.write(Buffer.concat([encodeFrame(0x1, Buffer.from('{"a":'), false, false), encodeFrame(0x0, Buffer.from('1}'), false, true)]));
  });
  const client = await connectWebSocket(`ws://127.0.0.1:${s.port}/`);
  const [data, binary] = await once(client, 'message');
  assert.equal(binary, false); assert.equal(data, '{"a":1}');
  client.terminate();
});

test('ping is answered with a pong carrying the same payload; oversize frames close with 1009; bad UTF-8 with 1007', async t => {
  const s = await server(t, null, { maxPayload: 1024 });
  const client = await raw(s.port);
  await until(() => client.bytes().includes('\r\n\r\n'));
  client.socket.write(encodeFrame(0x9, Buffer.from('hi'), true));
  await until(() => frames(client.bytes()).some(frame => frame.opcode === 0xa));
  assert.equal(String(frames(client.bytes()).find(frame => frame.opcode === 0xa).payload), 'hi');
  client.socket.write(encodeFrame(0x2, Buffer.alloc(2000), true));
  await client.closed;
  assert.equal(closeCode(frames(client.bytes()).find(frame => frame.opcode === 0x8)), 1009);
  const second = await raw(s.port);
  await until(() => second.bytes().includes('\r\n\r\n'));
  second.socket.write(encodeFrame(0x1, Buffer.from([0xff, 0xfe]), true));
  await second.closed;
  assert.equal(closeCode(frames(second.bytes()).find(frame => frame.opcode === 0x8)), 1007);
});

test('a frame split across many TCP writes is still one message', async t => {
  const messages = [];
  const s = await server(t, ws => ws.on('message', (data, binary) => messages.push([binary, data.length])));
  const client = await raw(s.port);
  await until(() => client.bytes().includes('\r\n\r\n'));
  const frame = encodeFrame(0x2, Buffer.alloc(3208, 3), true);
  for (let i = 0; i < frame.length; i += 7) { client.socket.write(frame.subarray(i, i + 7)); await new Promise(r => setImmediate(r)); }
  await until(() => messages.length === 1);
  assert.deepEqual(messages, [[true, 3208]]);
  client.socket.destroy();
});

test('a close from the peer is echoed and both sides report it once', async t => {
  let serverSide;
  const s = await server(t, ws => { serverSide = ws; });
  const client = await connectWebSocket(`ws://127.0.0.1:${s.port}/`);
  await until(() => serverSide);
  const serverClosed = once(serverSide, 'close'), clientClosed = once(client, 'close');
  serverSide.close(4000, 'leaving');
  const [[clientEvent], [serverEvent]] = await Promise.all([clientClosed, serverClosed]);
  assert.equal(clientEvent.code, 4000); assert.equal(clientEvent.reason, 'leaving'); assert.equal(serverEvent.code, 4000);
  assert.equal(client.readyState, 'closed'); assert.equal(serverSide.send('late'), false);
});
