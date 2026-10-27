// A small RFC 6455 WebSocket for the hub (real-time chat spec 2026-10-27 §3.1):
// the server side carries the Chat page's held-question audio, the client side
// is how the hub talks to a streaming transcription service. No dependency.
//   acceptWebSocket(req, socket, head, { maxPayload, fragments }) -> connection | null
//   connectWebSocket(url, { headers, timeoutMs, maxPayload })     -> Promise<connection>
// A connection emits 'message' (string for text, Buffer for binary, isBinary)
// and 'close' ({ code, reason }) exactly once; send(), ping(), close(code,
// reason) and terminate() never throw. Frames from a client must be masked and
// frames from a server must not be. Fragmented messages are refused with 1003
// unless `fragments` is true (the client side takes them: a service may split).
'use strict';
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX = 1 << 20;

function encodeFrame(opcode, payload, mask, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const length = data.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  header[1] = (mask ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(length, 2);
  else if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  key.copy(header, 2 + extra);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, masked]);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, { client = false, maxPayload = DEFAULT_MAX, fragments = false, head = null } = {}) {
    super();
    this.socket = socket; this.client = client; this.maxPayload = maxPayload; this.fragments = fragments;
    this.readyState = 'open';
    // Bytes that came with the handshake are parsed once the caller has had
    // its turn to listen; later socket data always queues behind them.
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    if (this.buffer.length) setImmediate(() => this._data(Buffer.alloc(0))); this.parts = null; this.partsOpcode = 0; this.partsBytes = 0;
    this.closeSent = false; this.closeEvent = null; this.closeTimer = null;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    socket.setNoDelay?.(true);
    socket.on('data', chunk => this._data(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this._finished());
    socket.on('end', () => { try { socket.end(); } catch {} });
  }
  get bufferedAmount() { return this.socket.writableLength || 0; }
  _write(opcode, payload) {
    if (this.readyState !== 'open' || this.socket.destroyed) return false;
    try { this.socket.write(encodeFrame(opcode, payload, this.client)); return true; } catch { return false; }
  }
  send(data) { return typeof data === 'string' ? this._write(0x1, Buffer.from(data, 'utf8')) : this._write(0x2, Buffer.from(data)); }
  ping(payload = Buffer.alloc(0)) { return this._write(0x9, payload); }
  close(code = 1000, reason = '') {
    if (this.readyState === 'closed') return;
    if (!this.closeSent && !this.socket.destroyed) {
      const text = Buffer.from(String(reason || '').slice(0, 120), 'utf8').subarray(0, 123);
      const payload = Buffer.alloc(2 + text.length); payload.writeUInt16BE(code, 0); text.copy(payload, 2);
      try { this.socket.write(encodeFrame(0x8, payload, this.client)); } catch {}
      this.closeSent = true;
      this.closeEvent ||= { code, reason: String(reason || '') };
    }
    this.readyState = 'closing';
    clearTimeout(this.closeTimer);
    // The peer echoes the close; a peer that never does is cut off.
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1000);
    this.closeTimer.unref?.();
  }
  terminate() { this.closeEvent ||= { code: 1006, reason: '' }; this.socket.destroy(); }
  _fail(code, reason) { this.close(code, reason); try { this.socket.end(); } catch {} }
  _finished() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed'; clearTimeout(this.closeTimer);
    this.emit('close', this.closeEvent || { code: 1006, reason: '' });
  }
  _data(chunk) {
    if (this.readyState === 'closed') return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.readyState !== 'closed') {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), rsv = b[0] & 0x70, opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let length = b[1] & 0x7f, offset = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) { this._fail(1009, 'too-large'); return; }
        length = Number(big); offset = 10;
      }
      if (rsv) { this._fail(1002, 'protocol-error'); return; }
      if (masked !== !this.client) { this._fail(1002, 'protocol-error'); return; }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) { this._fail(1002, 'protocol-error'); return; }
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) { this._fail(1002, 'protocol-error'); return; }
      if (length > this.maxPayload || (!control && this.partsBytes + length > this.maxPayload)) { this._fail(1009, 'too-large'); return; }
      const total = offset + (masked ? 4 : 0) + length;
      if (b.length < total) return;
      let payload = b.subarray(offset + (masked ? 4 : 0), total);
      if (masked) {
        const key = b.subarray(offset, offset + 4), plain = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) plain[i] = payload[i] ^ key[i & 3];
        payload = plain;
      } else payload = Buffer.from(payload);
      this.buffer = b.subarray(total);
      if (!this._frame(fin, opcode, payload)) return;
    }
  }
  _frame(fin, opcode, payload) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      let reason = '';
      try { reason = payload.length > 2 ? this.decoder.decode(payload.subarray(2)) : ''; } catch {}
      this.closeEvent ||= { code, reason };
      if (!this.closeSent) {
        const echo = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0);
        try { this.socket.write(encodeFrame(0x8, echo, this.client)); } catch {}
        this.closeSent = true;
      }
      this.readyState = 'closing';
      try { this.socket.end(); } catch {}
      return false;
    }
    if (opcode === 0x9) { this._write(0xa, payload); return true; }
    if (opcode === 0xa) return true;
    if (!fin || opcode === 0x0) {
      if (!this.fragments) { this._fail(1003, 'fragmentation-unsupported'); return false; }
      if (opcode !== 0x0) {
        if (this.parts) { this._fail(1002, 'protocol-error'); return false; }
        this.parts = [payload]; this.partsOpcode = opcode; this.partsBytes = payload.length;
        return true;
      }
      if (!this.parts) { this._fail(1002, 'protocol-error'); return false; }
      this.parts.push(payload); this.partsBytes += payload.length;
      if (!fin) return true;
      payload = Buffer.concat(this.parts); opcode = this.partsOpcode; this.parts = null; this.partsBytes = 0;
    } else if (this.parts) { this._fail(1002, 'protocol-error'); return false; }
    if (opcode === 0x1) {
      let text;
      try { text = this.decoder.decode(payload); } catch { this._fail(1007, 'invalid-text'); return false; }
      this.emit('message', text, false);
    } else this.emit('message', payload, true);
    return this.readyState === 'open';
  }
}

function refuse(socket, status) {
  try { socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  setTimeout(() => socket.destroy(), 1000).unref?.();
  return null;
}
// The handshake checks here are the protocol's own; who may connect is the caller's check.
function acceptWebSocket(req, socket, head, options = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  let decoded = null;
  try { decoded = Buffer.from(key, 'base64'); } catch {}
  if (req.method !== 'GET' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
    !/\bupgrade\b/i.test(String(req.headers.connection || '')) || req.headers['sec-websocket-version'] !== '13' ||
    !decoded || decoded.length !== 16 || decoded.toString('base64') !== key) return refuse(socket, 400);
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConnection(socket, { client: false, maxPayload: options.maxPayload || DEFAULT_MAX, fragments: options.fragments === true, head });
}

function connectWebSocket(target, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target); } catch { reject(Object.assign(new Error('ws-url'), { code: 'ws-url' })); return; }
    if (!['ws:', 'wss:'].includes(url.protocol)) { reject(Object.assign(new Error('ws-url'), { code: 'ws-url' })); return; }
    const key = crypto.randomBytes(16).toString('base64');
    const transport = url.protocol === 'wss:' ? https : http;
    let settled = false;
    const fail = (code, extra = {}) => { if (!settled) { settled = true; clearTimeout(timer); reject(Object.assign(new Error(code), { code, ...extra })); } };
    const request = transport.request({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || (url.protocol === 'wss:' ? 443 : 80),
      path: url.pathname + url.search, method: 'GET', agent: false, servername: url.hostname,
      headers: { ...options.headers, Host: url.host, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    const timer = setTimeout(() => { request.destroy(); fail('ws-timeout'); }, options.timeoutMs || 10000);
    timer.unref?.();
    request.on('response', response => { response.resume(); fail('ws-handshake', { status: response.statusCode }); });
    request.on('error', error => fail('ws-connect', { cause: error.code }));
    request.on('upgrade', (response, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) { socket.destroy(); fail('ws-handshake', { status: response.statusCode }); return; }
      if (settled) { socket.destroy(); return; }
      settled = true; clearTimeout(timer);
      resolve(new WebSocketConnection(socket, { client: true, maxPayload: options.maxPayload || DEFAULT_MAX, fragments: true, head }));
    });
    request.end();
  });
}

module.exports = { acceptWebSocket, connectWebSocket, encodeFrame, refuseUpgrade: refuse, WebSocketConnection };
