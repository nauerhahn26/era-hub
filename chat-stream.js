// The hub's streaming transcription client (real-time chat spec 2026-10-27
// §3.1-§3.2). One protocol-neutral interface over the wire shapes measured in
// the phase-0 bake-off (tools/chat-bakeoff.py), named by shape, never by
// vendor. Configuration and credentials are private settings only; the page
// never sees them. Audio and transcripts live in memory for one hold.
//
//   const stream = createStreamTranscriber({ protocol, url, model, token, keyterms, query, idleCloseMs, ... })
//   stream.open()          warm the socket (Start Chat); resolves with the connect ms
//   stream.begin()         a hold starts (reconnects at touch-down when the socket was closed)
//   stream.begin({ window: true })  a button-press listening window starts: the
//                          service's end of turn is surfaced as 'turn-end' per
//                          utterance and nothing is finalized until finalize()
//   stream.sendPcm(pcm)    PCM16 16 kHz mono, in order; queued until the socket is open
//   stream.finalize()      release: the hold's words are complete
//   stream.cancel()        the hold is discarded; nothing of it is ever reported
//   stream.close()         Chat ended
//   events: 'partial' {text}, 'settled' {text}, 'final' {text, timings},
//           'error' {code, beforeAudio}, 'socket' {warm, connectMs},
//           'turn-end' {text} (window turns only: one utterance's words)
//
// ws-streaming-turns  settings in the query, the token in Authorization, binary
//   PCM (every message 20-1000 ms of audio), `Turn` messages. Release sends
//   ForceEndpoint and Terminate together: the service may apply the endpoint
//   before queued audio, so the question's tail can arrive as a further turn;
//   the final is every turn joined when Termination arrives. "settled" is the
//   moment no turn is open after the forced endpoint (a hint, not a commit).
//   A warm socket is reopened at once for the next hold; idle sockets close.
// ws-listen-query  settings and repeated keyterm params in the query, "Token"
//   auth, `Results` messages (is_final segments plus an interim); release sends
//   Finalize, answered by a from_finalize Results: the final. The socket stays
//   open across holds with KeepAlive while idle.
'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { connectWebSocket } = require('./chat-ws.js');

const RATE = 16000, MIN_CHUNK = 640, MAX_CHUNK = 32000;
const KEYTERMS = { count: 100, length: 50, fileBytes: 65536 };

function withQuery(base, entries) {
  const url = new URL(base);
  for (const [key, value] of entries) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.href;
}

const PROTOCOLS = {
  'ws-streaming-turns': {
    url(s) {
      const query = { sample_rate: RATE, encoding: 'pcm_s16le', format_turns: false,
        ...(s.model ? { speech_model: s.model } : {}), ...(s.keyterms.length ? { keyterms_prompt: JSON.stringify(s.keyterms) } : {}), ...s.query };
      return withQuery(s.url, Object.entries(query));
    },
    headers: s => ({ Authorization: s.token }),
    ready: message => message.type === 'Begin',
    finalize: [{ type: 'ForceEndpoint' }, { type: 'Terminate' }],
    close: [{ type: 'Terminate' }],
    closesAfterTurn: true,
    keepAlive: null,
    state: () => ({ turns: new Map(), open: null }),
    handle(s, turn, message, out) {
      if (message.type === 'Error' || message.error) { out.error('service-error'); return; }
      const formatted = s.query.format_turns === true || String(s.query.format_turns).toLowerCase() === 'true';
      const state = turn.protocol;
      const joined = () => [...state.turns.keys()].sort((a, b) => a - b).map(key => state.turns.get(key)).filter(Boolean).join(' ').trim();
      if (message.type === 'Turn') {
        const order = Number(message.turn_order) || 0, text = String(message.transcript || '').trim();
        if (message.end_of_turn && (message.turn_is_formatted || !formatted)) {
          state.turns.set(order, text); state.open = null;
          out.partial(joined());
          if (!turn.finalizing) out.turnEnd(text);
          if (turn.finalizing) out.settled(joined());
          return;
        }
        if (text) state.open = { order, text };
        out.partial([...[...state.turns.keys()].sort((a, b) => a - b).filter(key => key !== order).map(key => state.turns.get(key)), text].filter(Boolean).join(' '));
      } else if (message.type === 'Termination' && turn.finalizing) {
        if (state.open && !state.turns.has(state.open.order)) state.turns.set(state.open.order, state.open.text);
        out.final(joined());
      }
    },
  },
  'ws-listen-query': {
    url(s) {
      const query = { model: s.model, encoding: 'linear16', sample_rate: RATE, channels: 1, interim_results: true,
        language: 'en', punctuate: true, smart_format: true, ...s.query };
      return withQuery(s.url, [...Object.entries(query), ['keyterm', s.keyterms]]);
    },
    headers: s => ({ Authorization: 'Token ' + s.token }),
    ready: null,
    finalize: [{ type: 'Finalize' }],
    close: [{ type: 'CloseStream' }],
    closesAfterTurn: false,
    keepAlive: { type: 'KeepAlive' },
    state: () => ({ committed: [], interim: '', mark: 0 }),
    handle(s, turn, message, out) {
      if (message.type === 'Error' || message.type === 'FatalError') { out.error('service-error'); return; }
      if (message.type !== 'Results') return;
      const state = turn.protocol;
      const alternatives = (message.channel && message.channel.alternatives) || [{}];
      const text = String((alternatives[0] && alternatives[0].transcript) || '').trim();
      if (message.is_final) { if (text) state.committed.push(text); state.interim = ''; } else state.interim = text;
      out.partial([...state.committed, state.interim].filter(Boolean).join(' '));
      // speech_final is unverified for this shape: when it is absent no
      // turn-end comes and the hub's silence fallback ends the utterance.
      if (message.is_final && message.speech_final === true && !turn.finalizing) {
        const words = state.committed.slice(state.mark).join(' ').trim();
        state.mark = state.committed.length;
        if (words) out.turnEnd(words);
      }
      if (message.from_finalize && turn.finalizing) { const words = state.committed.join(' ').trim(); out.settled(words); out.final(words); }
    },
  },
};

function loopbackHost(hostname) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname); }
function scalarQuery(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const ok = item => ['string', 'number', 'boolean'].includes(typeof item);
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => /^[a-z_]{1,40}$/.test(key) &&
      (ok(item) || (Array.isArray(item) && item.length <= 50 && item.every(ok)))));
  } catch { return {}; }
}
// The configured stream settings, primary first, then the fallback setting.
// A setting is used only when complete; plain ws:// only to this computer.
function streamSettings(env = {}) {
  const out = [];
  for (const [prefix, defaultBilling] of [['ERA_CHAT_STREAM_', 'connection'], ['ERA_CHAT_STREAM_FALLBACK_', 'audio']]) {
    const protocol = env[prefix + 'PROTOCOL'], model = env[prefix + 'MODEL'], token = env[prefix + 'TOKEN'];
    if (!PROTOCOLS[protocol] || typeof model !== 'string' || !model.trim() || typeof token !== 'string' || !token.trim()) continue;
    let url;
    try { url = new URL(env[prefix + 'URL']); } catch { continue; }
    if (url.username || url.password || !(url.protocol === 'wss:' || (url.protocol === 'ws:' && loopbackHost(url.hostname)))) continue;
    const billing = ['connection', 'audio'].includes(env[prefix + 'BILLING']) ? env[prefix + 'BILLING'] : defaultBilling;
    out.push({ protocol, url: url.href, model: model.trim(), token: token.trim(), billing, query: scalarQuery(env[prefix + 'QUERY']) });
  }
  return out;
}
// The keyterm list is private (family names live in it): read from the file a
// private setting names, bounded, and never logged or sent anywhere but the
// transcription service's own connection.
function loadKeyterms(file) {
  if (typeof file !== 'string' || !file) return [];
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > KEYTERMS.fileBytes) return [];
    let value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && !Array.isArray(value) && typeof value === 'object') value = value.keyterms;
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const term = item.trim().replace(/\s+/g, ' ');
      if (term && term.length <= KEYTERMS.length && !/[\x00-\x1f]/.test(term)) seen.add(term);
      if (seen.size >= KEYTERMS.count) break;
    }
    return [...seen];
  } catch { return []; }
}
// How many of the keyterms appear in a transcript (a count, never the words).
function keytermsFired(text, keyterms) {
  if (typeof text !== 'string' || !Array.isArray(keyterms)) return 0;
  const lower = ' ' + text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ') + ' ';
  return keyterms.filter(term => {
    const words = term.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
    return words && lower.includes(' ' + words + ' ');
  }).length;
}

class StreamTranscriber extends EventEmitter {
  constructor(options) {
    super();
    const protocol = PROTOCOLS[options.protocol];
    if (!protocol) throw new Error('stream-protocol');
    this.protocol = protocol;
    this.settings = { url: options.url, model: options.model || '', token: options.token || '', query: options.query || {},
      keyterms: Array.isArray(options.keyterms) ? options.keyterms : [] };
    this.connect = options.connect || connectWebSocket;
    this.clock = options.clock || (() => performance.now());
    this.idleCloseMs = options.idleCloseMs ?? 60000;
    this.keepAliveMs = options.keepAliveMs ?? 5000;
    this.finalTimeoutMs = options.finalTimeoutMs ?? 4000;
    this.openTimeoutMs = options.openTimeoutMs ?? 5000;
    this.state = 'closed'; this.ws = null; this.opening = null; this.turn = null; this.closed = false;
    this.openSince = null; this.accrued = 0; this.idleTimer = null; this.keepAliveTimer = null;
  }
  emitSafe(type, value) { try { this.emit(type, value); } catch { /* a listener never breaks the stream */ } }
  open() {
    if (this.closed) return Promise.reject(Object.assign(new Error('closed'), { code: 'closed' }));
    if (this.state === 'open') return Promise.resolve(0);
    if (this.opening) return this.opening;
    const began = this.clock();
    this.state = 'connecting';
    const attempt = (async () => {
      const ws = await this.connect(this.protocol.url(this.settings), { headers: this.protocol.headers(this.settings), timeoutMs: this.openTimeoutMs });
      if (this.closed) { ws.terminate(); throw Object.assign(new Error('closed'), { code: 'closed' }); }
      if (this.protocol.ready) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('ready-timeout')); }, this.openTimeoutMs);
        const onMessage = (data, binary) => {
          if (binary) return;
          let message; try { message = JSON.parse(data); } catch { return; }
          if (this.protocol.ready(message)) { cleanup(); resolve(); }
          else if (message && (message.error || message.type === 'Error')) { cleanup(); reject(new Error('refused')); }
        };
        const onClose = () => { cleanup(); reject(new Error('closed-early')); };
        const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); };
        ws.on('message', onMessage); ws.on('close', onClose);
      }).catch(error => { ws.terminate(); throw error; });
      return ws;
    })();
    this.opening = attempt.then(ws => {
      this.opening = null;
      if (this.closed) { ws.terminate(); throw Object.assign(new Error('closed'), { code: 'closed' }); }
      this.attach(ws);
      return Math.round((this.clock() - began) * 10) / 10;
    }, error => {
      this.opening = null; this.state = 'closed';
      throw Object.assign(new Error('open-failed'), { code: 'open-failed', cause: error && (error.code || error.message) });
    });
    return this.opening;
  }
  attach(ws) {
    this.ws = ws; this.state = 'open'; this.openSince = this.clock();
    ws.on('message', (data, binary) => {
      if (binary || ws !== this.ws) return;
      let message; try { message = JSON.parse(data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      const turn = this.turn;
      if (!turn || turn.done) return;
      this.protocol.handle(this.settings, turn, message, this.outlet(turn));
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.detach();
      const turn = this.turn;
      if (turn && !turn.done && !turn.cancelled) this.fail(turn, 'socket-lost');
    });
    if (this.protocol.keepAlive && this.keepAliveMs > 0) {
      this.keepAliveTimer = setInterval(() => { if (!this.turn || this.turn.done) this.sendJson(this.protocol.keepAlive); }, this.keepAliveMs);
      this.keepAliveTimer.unref?.();
    }
    if (!this.turn || this.turn.done) this.armIdle();
  }
  detach() {
    if (this.openSince !== null) { this.accrued += this.clock() - this.openSince; this.openSince = null; }
    clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; clearTimeout(this.idleTimer); this.idleTimer = null;
    this.ws = null; this.state = 'closed';
  }
  sendJson(value) { return this.ws ? this.ws.send(JSON.stringify(value)) : false; }
  armIdle() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (!(this.idleCloseMs > 0) || this.state !== 'open') return;
    this.idleTimer = setTimeout(() => { if (!this.turn || this.turn.done) this.shut(); }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }
  // Close the service socket politely (its own close message first).
  shut() {
    const ws = this.ws;
    if (!ws) return;
    for (const message of this.protocol.close) ws.send(JSON.stringify(message));
    this.detach();
    const timer = setTimeout(() => ws.close(1000, 'idle'), 300); timer.unref?.();
  }
  outlet(turn) {
    return {
      partial: text => {
        if (turn !== this.turn || turn.done || !text || text === turn.shown) return;
        turn.shown = text; turn.history.push([this.clock(), text]);
        if (turn.firstPartialAt === null) turn.firstPartialAt = this.clock();
        this.emitSafe('partial', { text });
      },
      settled: text => {
        if (turn !== this.turn || turn.done || turn.settledAt !== null) return;
        turn.settledAt = this.clock(); this.emitSafe('settled', { text });
      },
      final: text => this.complete(turn, text),
      // A window's utterance ended at the service. Hold turns never see it.
      turnEnd: text => {
        if (turn !== this.turn || turn.done || !turn.window || !text) return;
        this.emitSafe('turn-end', { text });
      },
      error: code => this.fail(turn, code),
    };
  }
  begin(options = {}) {
    if (this.closed) return;
    if (this.turn && !this.turn.done) this.cancel();
    clearTimeout(this.idleTimer); this.idleTimer = null;
    const turn = { began: this.clock(), queue: [], tail: Buffer.alloc(0), audioBytes: 0, sentAny: false, finalizing: false, finalizeAt: null,
      firstPartialAt: null, settledAt: null, shown: '', history: [], connectMs: null, done: false, ended: false, cancelled: false,
      timer: null, window: options.window === true, protocol: this.protocol.state() };
    this.turn = turn;
    if (this.state === 'open') { turn.connectMs = 0; this.emitSafe('socket', { warm: true, connectMs: 0 }); return; }
    this.open().then(connectMs => {
      if (this.turn !== turn || turn.done) return;
      turn.connectMs = connectMs; this.emitSafe('socket', { warm: false, connectMs });
      this.flush(turn);
      if (turn.finalizing) this.sendFinalize(turn);
    }, () => { if (this.turn === turn && !turn.done) this.fail(turn, 'open-failed'); });
  }
  sendPcm(pcm) {
    const turn = this.turn;
    if (!turn || turn.done || turn.finalizing || !Buffer.isBuffer(pcm) || !pcm.length) return;
    turn.audioBytes += pcm.length;
    turn.tail = turn.tail.length ? Buffer.concat([turn.tail, pcm]) : Buffer.from(pcm);
    if (turn.tail.length >= MIN_CHUNK) { this.chunk(turn, turn.tail); turn.tail = Buffer.alloc(0); }
    this.flush(turn);
  }
  chunk(turn, bytes) {
    for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) {
      let piece = bytes.subarray(offset, offset + MAX_CHUNK);
      // A last piece under 20 ms joins the one before it.
      if (piece.length < MIN_CHUNK && turn.queue.length && turn.queue.at(-1).length + piece.length <= MAX_CHUNK) { turn.queue[turn.queue.length - 1] = Buffer.concat([turn.queue.at(-1), piece]); continue; }
      turn.queue.push(piece);
    }
  }
  flush(turn) {
    if (this.state !== 'open' || turn !== this.turn) return;
    while (turn.queue.length) { if (this.ws.send(turn.queue.shift())) turn.sentAny = true; }
  }
  finalize() {
    const turn = this.turn;
    if (!turn || turn.done || turn.finalizing) return;
    turn.finalizing = true; turn.finalizeAt = this.clock();
    if (turn.tail.length) {
      const padded = turn.tail.length < MIN_CHUNK ? Buffer.concat([turn.tail, Buffer.alloc(MIN_CHUNK - turn.tail.length)]) : turn.tail;
      this.chunk(turn, padded); turn.tail = Buffer.alloc(0);
    }
    turn.timer = setTimeout(() => this.fail(turn, 'final-timeout'), this.finalTimeoutMs);
    turn.timer.unref?.();
    if (this.state === 'open') this.sendFinalize(turn);
  }
  sendFinalize(turn) {
    this.flush(turn);
    for (const message of this.protocol.finalize) this.sendJson(message);
  }
  complete(turn, text) {
    if (turn !== this.turn || turn.done) return;
    if (turn.settledAt === null) { turn.settledAt = this.clock(); this.emitSafe('settled', { text }); }
    turn.done = true; turn.ended = true; clearTimeout(turn.timer);
    const now = this.clock(), ms = value => value === null ? null : Math.round(value * 10) / 10;
    // When the shown words last became the final's words (the bake-off's "settled").
    let wordsAt = now;
    const target = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').replace(/\s+/g, ' ').trim();
    for (let i = turn.history.length - 1; i >= 0; i--) {
      if (turn.history[i][1].toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').replace(/\s+/g, ' ').trim() !== target) break;
      wordsAt = turn.history[i][0];
    }
    const timings = { connectMs: turn.connectMs, firstPartialMs: turn.firstPartialAt === null ? null : ms(turn.firstPartialAt - turn.began),
      finalizeMs: ms(now - turn.finalizeAt), settledMs: ms(Math.max(0, turn.settledAt - turn.finalizeAt)),
      wordsSettledMs: ms(wordsAt - turn.finalizeAt), audioMs: Math.round(turn.audioBytes / 32), turnMs: ms(now - turn.began) };
    if (this.protocol.closesAfterTurn) {
      // Terminate ended this socket's session: the service closes it. The
      // next hold gets a fresh warm socket, opened now.
      const ws = this.ws;
      if (ws) { this.detach(); const timer = setTimeout(() => ws.close(1000, 'done'), 1000); timer.unref?.(); }
      if (!this.closed) this.open().catch(() => {});
    } else this.armIdle();
    this.emitSafe('final', { text, timings });
  }
  fail(turn, code) {
    if (turn !== this.turn || turn.done) return;
    turn.done = true; clearTimeout(turn.timer);
    // The socket's state for this hold is unknown now: start the next one clean.
    if (this.ws) { const ws = this.ws; this.detach(); ws.terminate(); }
    this.emitSafe('error', { code, beforeAudio: !turn.sentAny });
  }
  cancel() {
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.done = true; turn.cancelled = true; clearTimeout(turn.timer);
    // Whatever the service already heard of this hold must not reach the next:
    // the socket goes, and the next hold opens a fresh one.
    this.shut();
  }
  takeSocketSeconds() {
    const now = this.clock();
    const total = this.accrued + (this.openSince !== null ? now - this.openSince : 0);
    this.accrued = 0; if (this.openSince !== null) this.openSince = now;
    return Math.round(total) / 1000;
  }
  close() {
    if (this.closed) return;
    if (this.turn && !this.turn.done) { this.turn.done = true; this.turn.cancelled = true; clearTimeout(this.turn.timer); }
    this.shut();
    this.closed = true;
    if (this.ws) { const ws = this.ws; this.detach(); ws.terminate(); }
  }
}

function createStreamTranscriber(options) { return new StreamTranscriber(options); }

module.exports = { createStreamTranscriber, streamSettings, loadKeyterms, keytermsFired, PROTOCOLS };
