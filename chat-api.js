// Ephemeral Chat sessions. Audio and transcripts are never written to disk.
'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn: spawnProcess } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLoopback } = require('./update.js');
const { createChoicesAdapter } = require('./chat-choices.js');
const { withSymbols, symbolRejected, pictureCandidates, createPictureWarmer } = require('./chat-symbols.js');
const { acceptWebSocket, refuseUpgrade } = require('./chat-ws.js');
const { createStreamTranscriber, streamSettings, loadKeyterms, keytermsFired } = require('./chat-stream.js');
const { createKeepAliveFetch } = require('./keepalive-fetch.js');
const { createWindow, energyGate, wakeQuestion, WINDOW_LIMITS } = require('./chat-window.js');

const PREFIX = '/chat/api';
const DEFAULTS = Object.freeze({ sessions: 2, idleMs: 90000, lifetimeMs: 1800000,
  bodyBytes: 8192, audioBytes: 64000, utteranceBytes: 640000, sessionBytes: 19200000,
  runtimeLineBytes: 16384, runtimeQueueBytes: 256000, adapterBytes: 32768,
  adapterMs: 15000, choices: 2, writeMs: 3000,
  // The audio socket (spec 2026-10-27 §3.1): one hold may carry 16 s of PCM16
  // at 16 kHz (the page stops at 15 s); finish waits this long for frames.
  turnBytes: 512000, drainMs: 2000,
  // A button-press listening window (design 2026-10-27 §4.4) holds up to 60 s:
  // ~62 s of PCM16; the hub, not the page, caps each utterance.
  windowBytes: 2000000,
  // The window's own clock (design §4.4): one utterance, the silence that
  // closes the window, the window's cap; the machine is ticked this often.
  windowUtteranceMs: WINDOW_LIMITS.utteranceMs, windowSilenceMs: WINDOW_LIMITS.silenceMs, windowCapMs: WINDOW_LIMITS.capMs, windowTickMs: 100,
  // A second press or the cap finalizes the utterance in flight; its final is waited for at most this long.
  windowFinalMs: 2000,
  // The wake word's ear (stable frame §8): its stream turn starts afresh after
  // a seal once it is this old (the service's running text never grows without
  // bound); a bare wake name makes the next utterance within earWakeMs the question.
  earRollMs: 60000, earWakeMs: 8000,
  // The streaming transcription socket (§3.1): closed after this long idle
  // (null: 60 s for a connection-billed service, 5 min otherwise); the final
  // must arrive this long after release or the hold falls back to one-shot.
  streamIdleMs: null, streamFinalMs: 4000, streamKeepAliveMs: 5000,
  // The page's command stream (button press to ask, design 2026-10-27 §4.2).
  commandPingMs: 15000, commandNonceMs: 30000 });
const FRAME_HEADER = 8;
// The byte budget of the current turn: a listening window's, or one hold's.
function turnByteLimit(turn, limits) { return turn && turn.window === true ? limits.windowBytes : limits.turnBytes; }

// The Chat page's command stream (button press to ask, design 2026-10-27 §4.2):
// one subscriber, the page, connected from load and before any session. The
// hub pushes {type:'ask', pressAt, key, nonce?}, {type:'end'} and
// {type:'cancel'}; a newer connection replaces the older ({type:'replaced'}).
// A relaunched kiosk opens /chat/?ask=<nonce>: the page connects with that
// nonce and the press is replayed as `ask` once (30 s, then gone). The page
// reports its visibility at connect (?visible=0|1) and on every change. It
// lives outside the per-configuration API so a configuration reload never
// drops the page's stream.
function createCommands(options = {}) {
  const clock = options.clock || Date.now;
  const pingMs = options.pingMs ?? DEFAULTS.commandPingMs, nonceMs = options.nonceMs ?? DEFAULTS.commandNonceMs;
  const nonces = new Map(), waiters = new Set();
  let subscriber = null;
  const write = (sub, value) => { try { sub.res.write('data: ' + JSON.stringify(value) + '\n\n'); return true; } catch { return false; } };
  const sweepNonces = () => { const now = clock(); for (const [nonce, entry] of nonces) if (now - entry.issuedAt > nonceMs) nonces.delete(nonce); };
  const settleWaiters = () => { if (!subscriber || subscriber.visible !== true) return; for (const waiter of [...waiters]) waiter(true); };
  function drop(sub) {
    clearInterval(sub.ping);
    if (subscriber === sub) subscriber = null;
  }
  return {
    connect(res, { nonce = null, visible = null } = {}) {
      if (subscriber) { const old = subscriber; write(old, { type: 'replaced' }); drop(old); try { old.res.end(); } catch {} }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      const sub = { res, visible: typeof visible === 'boolean' ? visible : null, ping: null };
      subscriber = sub;
      if (pingMs > 0) { sub.ping = setInterval(() => write(sub, { type: 'ping' }), pingMs); sub.ping.unref?.(); }
      res.once('close', () => drop(sub));
      sweepNonces();
      const entry = typeof nonce === 'string' && nonces.get(nonce);
      if (entry) { nonces.delete(nonce); write(sub, { type: 'ask', pressAt: entry.pressAt, key: entry.key, nonce }); }
      settleWaiters();
    },
    push(command) { return subscriber ? write(subscriber, command) : false; },
    issue({ pressAt, key }) {
      sweepNonces();
      const nonce = randomBytes(8).toString('hex');
      nonces.set(nonce, { pressAt, key, issuedAt: clock() });
      return nonce;
    },
    pending(nonce) { sweepNonces(); return nonces.has(nonce); },
    revoke(nonce) { nonces.delete(nonce); },
    setVisible(visible) {
      if (!subscriber) return false;
      subscriber.visible = visible; settleWaiters(); return true;
    },
    state() { return { connected: !!subscriber, visible: subscriber ? subscriber.visible : null }; },
    waitVisible(ms) {
      if (subscriber && subscriber.visible === true) return Promise.resolve(true);
      return new Promise(resolve => {
        const timer = setTimeout(() => done(false), ms);
        const done = value => { clearTimeout(timer); waiters.delete(done); resolve(value); };
        waiters.add(done);
      });
    },
    close() {
      for (const waiter of [...waiters]) waiter(false);
      if (subscriber) { const sub = subscriber; drop(sub); try { sub.res.end(); } catch {} }
      nonces.clear();
    },
  };
}

function chatVariables(env) {
  const result = {};
  for (const [key, value] of Object.entries(env || {}))
    if (/^ERA_CHAT_[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value.length <= 8192) result[key] = value;
  return result;
}
function literalValue(raw) {
  if (raw.startsWith("'")) {
    const match = /^'([^']*)'(?:\s*#.*)?$/.exec(raw);
    return match ? match[1] : null;
  }
  if (raw.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s*#.*)?$/.exec(raw);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch { return null; }
  }
  return raw.replace(/\s+#.*$/, '').trim();
}
function loadChatEnvironment(options = {}) {
  const overrides = chatVariables(options.env === undefined ? process.env : options.env);
  if (overrides.ERA_CHAT_CONFIG_DISABLED === '1') return overrides;
  const file = options.file === undefined ? path.join(os.homedir(), '.config', 'ai', 'ai.env') : options.file;
  const fromFile = {};
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536) return overrides;
    const bytes = Buffer.alloc(65537), size = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > 65536) return overrides;
    for (const line of bytes.subarray(0, size).toString('utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(ERA_CHAT_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const value = literalValue(match[2]);
      if (typeof value === 'string' && value.length <= 8192) fromFile[match[1]] = value;
    }
  } catch { /* Missing or unreadable private configuration means unconfigured. */ }
  finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
  return { ...fromFile, ...overrides };
}
function speechEnvironment(chat, system, builtIn) {
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PYTHONPATH', 'VIRTUAL_ENV'])
    if (typeof system[key] === 'string') result[key] = system[key];
  for (const [key, value] of Object.entries(chat))
    // The streaming service's credentials and keyterms stay in the hub (spec §3.1).
    if (builtIn ? key.startsWith('ERA_CHAT_SPEECH_') : !/^ERA_CHAT_(?:TEXT|CHOICES|STREAM)_/.test(key)) result[key] = value;
  return result;
}
function transportUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

function fault(status, code) { return Object.assign(new Error(code), { status, code }); }
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function ownRequest(req) {
  if (!isLoopback(req.socket && req.socket.remoteAddress)) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  try {
    const target = new URL('http://' + req.headers.host);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && !isLoopback(host)) return false;
    if (req.headers.origin && new URL(req.headers.origin).origin !== target.origin) return false;
    return true;
  } catch { return false; }
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], done = false;
    const stop = error => { if (!done) { done = true; chunks = []; reject(error); } };
    req.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > cap) { stop(fault(413, 'body-too-large')); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('aborted', () => stop(fault(400, 'request-aborted')));
    req.on('error', () => stop(fault(400, 'request-aborted')));
  });
}
async function readJson(req, cap) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw fault(415, 'json-required');
  try {
    const value = JSON.parse(String(await readBody(req, cap)));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw fault(400, 'invalid-json');
    return value;
  } catch (error) { if (error.code) throw error; throw fault(400, 'invalid-json'); }
}
function cleanText(value, cap) {
  if (typeof value !== 'string' || !value.trim() || value.length > cap || /[\x00-\x08\x0b-\x1f<>]/.test(value)) return null;
  return value.trim().replace(/\s+/g, ' ');
}
// Ask a question / Make a comment without a reply model (stable frame §3).
const MODES = ['ask', 'comment'];
const MODE_FALLBACK = Object.freeze({ ask: ['Why?', 'What do you mean?', 'Can you tell me more?', 'What happens next?'],
  comment: ["That's cool!", "I'm not sure", 'I like that', 'No way!'] });
// Every choice leaves the hub with a decorative picture: { symbol, symbolId }.
// A glyph choice (a letter or a number, spec §3) has no picture: the page
// shows the character itself, big.
function choiceList(items) {
  const choices = items.map((item, index) => typeof item === 'string' ?
    { id: `choice-${index + 1}`, label: item, say: item } :
    { id: `choice-${index + 1}`, label: item.label, say: item.say, ...(item.glyph === true ? { glyph: true } : {
      ...(typeof item.symbol === 'string' ? { symbol: item.symbol } : {}), ...(typeof item.picture === 'string' ? { picture: item.picture } : {}) }) });
  const pictured = withSymbols(choices.filter(choice => !choice.glyph));
  return choices.map(choice => choice.glyph ? choice : pictured.shift());
}
function safeTimings(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of ['audioMs', 'captureWallMs', 'activityMs', 'cloudMs', 'firstPartialMs', 'finalDecodeMs', 'turnMs', 'finalizeMs', 'connectMs', 'settledMs', 'wordsSettledMs']) {
    if (Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 3600000) result[key] = value[key];
    else if (key === 'firstPartialMs' && value[key] === null) result[key] = null;
  }
  return result;
}
// The built-in reply core's token usage, for Chat test mode only: numbers and
// the configured model id. Production timing rows never take it.
function cleanUsage(value) {
  const count = x => Number.isSafeInteger(x) && x >= 0;
  if (!value || typeof value !== 'object' || !count(value.inputTokens) || !count(value.cachedTokens) || !count(value.outputTokens)) return null;
  return { model: typeof value.model === 'string' && value.model.length <= 128 ? value.model : null,
    inputTokens: value.inputTokens, cachedTokens: value.cachedTokens, outputTokens: value.outputTokens };
}
// The alternatives of an either/or are the things offered, not the sentence
// around them: "mom or dad to feed you" offers Mom and Dad; "to eat now or
// later" offers Now and Later; "pizza tonight or pasta tonight" Pizza and Pasta.
// A leading verb only the first alternative carries is shared and dropped (with
// a following preposition); in every alternative a clause or time word after
// its first word ends it.
const SHARED_VERB = /^(?:eat|drink|have|play|go|read|watch|listen|sing|do|make|see|visit|wear|sit|take|get|draw|paint|build|write|run|swim|ride|dance|cook|bake|stay|come|sleep|rest|walk|jump|climb)$/i;
const OBJECT = /^(?:a|an|the|some|my|your|this|that|these|those)$/i;
const PARTICLE = /^(?:with|to|for|at|in|on)$/i;
const TAIL = /^(?:to|for|at|in|on|with|from|after|before|tonight|today|tomorrow|now|later|first|next|please|because|so|when|feed|feeds|help|helps|read|reads|play|plays|take|takes|come|comes|bring|brings|sit|sits)$/i;
function alternativesOf(parts) {
  const words = parts.map(part => part.trim().split(/\s+/).filter(Boolean));
  let shared = false;
  if (words.length >= 2 && words[0].length > 1 && SHARED_VERB.test(words[0][0]) && words.slice(1).every(w => w.length && !SHARED_VERB.test(w[0]))) {
    // Shared only when what follows the verb is the same kind of thing as the
    // other alternatives (as long, and not the verb's own object: "play a
    // game or draw pictures" offers two activities).
    let rest = words[0].slice(1);
    if (rest.length > 1 && PARTICLE.test(rest[0])) rest = rest.slice(1);
    // A leading article or possessive is parallel only when every other
    // alternative starts with the same one ("play with my X or my Y").
    const parallel = !OBJECT.test(rest[0]) || words.slice(1).every(w => w[0].toLowerCase() === rest[0].toLowerCase());
    if (parallel && words.slice(1).every(w => w.length === rest.length)) { words[0] = rest; shared = true; }
  }
  return words.map((list, index) => {
    // A verb phrase keeps its verb, a preposition and article right after it,
    // and its object: "go to the park so we can run" is "go to the park",
    // "go outside to play" is "go outside". Elsewhere a clause or time word
    // after the first word ends the alternative.
    let from = 1;
    if (!(shared && index === 0) && list.length > 1 && SHARED_VERB.test(list[0])) {
      while (from < list.length - 1 && (PARTICLE.test(list[from]) || OBJECT.test(list[from]))) from++;
      from++;
    }
    // A clause word right after "and" (or "and then") is joined, not a clause:
    // "go outside and play" stays whole.
    const joined = i => /^and$/i.test(list[i - 1] || '') || (/^then$/i.test(list[i - 1] || '') && /^and$/i.test(list[i - 2] || ''));
    const cut = list.findIndex((word, i) => i >= from && TAIL.test(word) && !joined(i));
    const kept = cut > 0 ? list.slice(0, cut) : list;
    // Never a dangling "to", "the", "a", "and", "or" or "and then".
    const dangling = () => PARTICLE.test(kept.at(-1)) || OBJECT.test(kept.at(-1)) || /^(?:and|or)$/i.test(kept.at(-1)) ||
      (/^then$/i.test(kept.at(-1)) && /^and$/i.test(kept.at(-2) || ''));
    while (kept.length > 1 && dangling()) kept.pop();
    return kept.join(' ');
  });
}
// The partner's "my" is the communicator's "your" (and the other way round):
// she never claims the partner's things. A leading possessive or article that
// every alternative shares leaves the labels ("my dinosaurs or my blocks" is
// Dinosaurs / Blocks); the say keeps a flipped possessive ("Your dinosaurs").
function spokenAlternatives(parts) {
  const capital = text => text[0].toUpperCase() + text.slice(1);
  const flip = text => text.replace(/\b(my|your)\b/gi, word => /^my$/i.test(word) ? 'your' : 'my');
  const lists = parts.map(part => part.split(' '));
  const lead = lists[0][0].toLowerCase();
  const shared = OBJECT.test(lead) && lists.every(list => list.length > 1 && list[0].toLowerCase() === lead);
  return lists.map(list => {
    if (!shared) { const text = capital(flip(list.join(' '))); return { label: text, say: text }; }
    const rest = flip(list.slice(1).join(' '));
    return { label: capital(rest), say: /^(?:my|your)$/.test(lead) ? capital(flip(lead) + ' ' + rest) : capital(rest) };
  });
}
// A partner who restarts ("You want chicken and fruit? Chicken and rice.
// Meatballs or beef and mushrooms?") is read from the last question sentence
// on, together with an opener sentence just before it ("What do you like?
// Music or a story?"). Words after that question still count: they may refuse.
function lastQuestion(text, opener) {
  const sentences = text.match(/[^.?!]+[.?!]*\s*/g) || [text];
  let index = -1;
  sentences.forEach((sentence, i) => { if (/\?\s*$/.test(sentence)) index = i; });
  if (index <= 0) return text;
  if (opener.test(sentences[index - 1].trim())) index--;
  return sentences.slice(index).join('').trim();
}
// A trailing list of two to four single letters or numbers ("Is the answer A,
// B, C, or D?", "A or B?", "Which one, 1, 2 or 3?"), under any stem or none.
// Each item stands alone between commas, "or" and the end, and the list starts
// the sentence or follows a comma, a colon or a stem word, so "a" the article
// ("a cookie or a banana") is never a letter. Offered as glyphs: no picture.
const GLYPH = String.raw`(?:[a-z]|\d{1,2})`;
const GLYPH_LIST = new RegExp(String.raw`(?:^|[,:]\s*|\b(?:answer|one|it|is|be|was|pick|choose|between|either|want|like|need|prefer|rather|number|letter|plan|option|options|choice|choices|group|team|door|box|card|or)\s+)` +
  String.raw`(${GLYPH}(?:\s*,\s*(?:or\s+)?${GLYPH}|\s+or\s+${GLYPH}){1,3})$`, 'i');
function glyphChoices(text) {
  const match = GLYPH_LIST.exec(text);
  if (!match) return null;
  const items = match[1].split(/\s*,\s*(?:or\s+)?|\s+or\s+/i).map(item => /^\d+$/.test(item) ? String(Number(item)) : item.toUpperCase());
  if (items.length < 2 || items.length > 4 || new Set(items).size !== items.length) return null;
  return { kind: 'alternatives', choices: choiceList(items.map(item => ({ label: item, say: item, glyph: true }))) };
}
// "Who do you want, Mom, Dad, Lisa, or Sam?", "Which one do you want: the red
// one or the blue one?": a who / which / what question that ends, after a
// comma or colon, in an either/or list of two to four short items (one to
// three words, no question stem or auxiliary inside) offers those items.
const NAMED_STEM = /^(?:who|whom|which|what)\b/i;
const NAMED_STOP = /^(?:do|does|did|is|are|am|was|were|be|would|should|could|can|will|shall|may|might|must|want|wanna|need|like|prefer|have|has|had|to|you|we|it|if)$/i;
function namedChoices(text) {
  if (!NAMED_STEM.test(text)) return null;
  for (const separator of text.matchAll(/[,:]/g)) {
    const tail = text.slice(separator.index + 1).trim();
    const ors = tail.split(/\s+or\s+/i);
    if (ors.length < 2) continue;
    const last = ors.pop().replace(/\s*,.*$/, '');
    const items = [...ors.flatMap(part => part.replace(/\s*,\s*$/, '').split(/\s*,\s*/)), last].map(item => item.trim());
    // The first separator after which every item is a short name decides:
    // five or more of them is the model's, never a shorter tail of the list.
    if (!items.every(item => item && item.length <= 30 && !/[.!?;:]/.test(item) && item.split(/\s+/).length <= 3 &&
      !item.split(/\s+/).some(word => NAMED_STOP.test(word)))) continue;
    return items.length >= 2 && items.length <= 4 ? { kind: 'alternatives', choices: choiceList(spokenAlternatives(items)) } : null;
  }
  return null;
}
const STEM = /^(?:or\s+)?(?:do you (?:want|need)(?: to)?|do you wanna|would you (?:like|prefer)(?: to)?|would you rather|should we|shall we|can we)\s+/i;
const CHOICE_PROMPT = String.raw`(?:(?:would|do) you (?:like|want|prefer|choose)(?: to)?|do you wanna|would you rather|(?:shall|should|can|could|would) we|(?:which|what) (?:would|do) you (?:like|want|prefer|choose)(?: to)?|is it)`;
const OPENER = new RegExp(String.raw`^(?:(?:hey[\s,!.?:]+)?ellie[\s,!.?:]+)?` + CHOICE_PROMPT + String.raw`\s*[:,.!?]*$`, 'i');
// The question as the shortcuts read it: the last question sentence (with its
// opener), no closing punctuation, and no leading wake address.
function addressed(text) {
  let trimmed = lastQuestion(text, OPENER).replace(/[?.!]+$/, '').trim();
  const explicitAddress = /^hey[\s,!.?:]+ellie[\s,!.?:]+(.+)$/i.exec(trimmed) ||
    /^ellie\s*[,!.?:]+\s*(.+)$/i.exec(trimmed);
  const questionAddress = /^ellie\s+(.+)$/i.exec(trimmed);
  // Explicit addresses also precede statements. Without punctuation, a lone
  // name is removed only before a clear question, preserving name subjects and
  // possessives. Only local parsing changes; the transcript is kept.
  if (explicitAddress) trimmed = explicitAddress[1];
  else if (questionAddress && /^(?:(?:what|which|why|where|when|how|who|hi|hello|hey)\b|(?:do|does|did|can|could|would|will|have|has|had|shall|should|may|are|were)\s+(?:you|we)\b|(?:is|was)\s+(?:it|this|that|there)\b)/i.test(questionAddress[1]))
    trimmed = questionAddress[1];
  return trimmed;
}
// An open-ended question's shape (dad, 10/28): what the model is asked for
// when no shortcut answers. want: something to do, eat, play; feel: how she
// is or how it was; recall: what she did (checked, never invented); open: any
// other question word or "tell me". A statement has no shape. Only consulted
// after localChoices has found nothing.
const WANT = [/\b(?:what|which|where)\b.*\b(?:do you want|would you like|do you feel like|should we|shall we|are we (?:going to|gonna)|do you wanna|you want to)\b/,
  /\bwhat (?:do you want|would you like|should we|shall we) to (?:do|play|eat|watch|read|make|have|wear)\b/,
  /\bwhat do you want for (?:lunch|dinner|breakfast|snack)\b/, /\bwhat (?:game|book|show|song) (?:do you want|should we)\b/];
const FEEL = [/^how are you\b/, /\bhow was your \w+/, /\bhow do you feel\b/, /\bhow was it\b/, /\bdid you (?:like|enjoy) \w+/];
const RECALL = [/\b(?:what|where|who|when|how)\b.*\b(?:did you|have you|were you|you do|you went|you see)\b/, /\bwhat happened\b/,
  /\bwhat was your (?:favourite|favorite) part\b/, /\btell me about your (?:day|weekend|holiday|birthday|book|story|trip)\b/];
const OPEN = /^(?:who|what|where|when|why|how|which|tell me|tell us|say|describe|what about)\b/;
// Several questions at once (home device, 10/31): "do you want water? Do you
// want to wait? Do you want something else?" is a list of alternatives, never a
// yes/no on its first clause. Two or more question marks or yes/no stems, or a
// long utterance whose yes/no clause is only part of it.
const YES_NO_STEM = /\b(?:do you want|do you wanna|would you like|do you|are you|is it|is that|can you|could you|would you|will you|should we|can we|are we)\b/gi;
// A partner who restarts ("No wait.", "Sorry.", "Hmm, okay.") means the last question only.
const RESTART = /\b(?:no wait|sorry|actually|never mind|nevermind|scratch that|i mean|hmm,? okay|let me ask again)\b/i;
// Two or more question sentences with no restart between them; a bare choice
// prompt ("What do you like? Music or a story?") only opens the one question.
const questionsInRow = text => typeof text === 'string' && !RESTART.test(text) &&
  (text.match(/[^.?!]+[.?!]*/g) || []).filter(part => /\?\s*$/.test(part) && !OPENER.test(part.trim())).length >= 2;
function severalQuestions(text) {
  if (typeof text !== 'string' || RESTART.test(text)) return false;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if ((text.match(/\?/g) || []).length >= 2 || (text.match(YES_NO_STEM) || []).length >= 2) return true;
  const clause = addressed(text).split(/\s+/).filter(Boolean).length;
  return words > 12 && clause < words;
}
function openShape(text) {
  if (typeof text !== 'string') return null;
  const question = addressed(text).toLowerCase().replace(/[’]/g, "'").replace(/[?.!,;:]+$/, '').trim();
  if (!question) return null;
  if (WANT.some(pattern => pattern.test(question))) return 'want';
  if (FEEL.some(pattern => pattern.test(question))) return 'feel';
  if (RECALL.some(pattern => pattern.test(question))) return 'recall';
  return OPEN.test(question) || severalQuestions(text) ? 'open' : null;
}
function localChoices(text) {
  let trimmed = addressed(text);
  const glyphs = glyphChoices(trimmed);
  if (glyphs) return glyphs;
  if (/\bor\b/i.test(trimmed)) {
    // Questions in a row ("Do you want water? Do you want to wait, or …?") are
    // one list for the model; the last question's halves alone would drop the first.
    if (questionsInRow(text)) return null;
    const named = namedChoices(trimmed);
    if (named) return named;
    const prefix = new RegExp('^' + CHOICE_PROMPT + String.raw`\s*[:,.!?]?\s+`, 'i');
    // Unrecognised question forms need context and factual grounding. Splitting
    // them can turn half a question into the communicator's spoken answer.
    // "Are you hot or are you cold?": a stem that pairs every alternative.
    const paired = /^(is it|are you)\s+/i.exec(trimmed)?.[1].toLowerCase();
    const pairedStem = paired && new RegExp(String.raw`^${paired}\s+`, 'i');
    const later = trimmed.split(/\s+or\s+/i).slice(1);
    const everyPaired = !!paired && later.every(part => pairedStem.test(part.replace(/^[\s,]+/, '')));
    if (paired && !everyPaired && later.some(part => pairedStem.test(part))) return null;
    if (!prefix.test(trimmed) && !(paired === 'are you' && everyPaired)) {
      if (/^(?:did|have|had|were|was)\s+you\b/i.test(trimmed))
        return { kind: 'guarded', generated: false, choices: choiceList([
          'Can you give me a clue?', 'Let me tell you another way.', "I don't want to answer now.",
        ]) };
      return null;
    }
    const stripped = (paired === 'are you' && everyPaired ? trimmed.replace(pairedStem, '') : trimmed.replace(prefix, '')).replace(/^either\s+/i, '');
    // "A, B, or C", "A, B or C", "A or B or C": commas list alternatives only
    // before the last "or"; after it a comma starts a clause ("dad, to help").
    const ors = stripped.split(/\s+or\s+/i), last = ors.pop().replace(/\s*,.*$/, '');
    // A question stem repeated in a later alternative ("…, or do you want to
    // stay inside?") is not part of what is offered.
    const unstem = part => part.replace(STEM, '').replace(everyPaired ? pairedStem : /^$/, '');
    const parts = alternativesOf([...ors.flatMap(part => part.replace(/\s*,\s*$/, '').split(/\s*,\s*/)), last]
      .map(part => unstem(part.replace(/[,;:]+$/, '').trim())));
    if (parts.length >= 2 && parts.length <= 4 && parts.every(p => p.length > 0 && p.length <= 55 && !/[.!?;:]/.test(p))) {
      return { kind: 'alternatives', choices: choiceList(spokenAlternatives(parts)) };
    }
    return null;
  }
  if (/^(?:is|are|was|were|do|does|did|can|could|would|will|have|has|should|may)\b/i.test(trimmed) && !severalQuestions(text))
    return { kind: 'yes-no', choices: choiceList(['Yes', 'No', "I'm not sure", 'Please say that again']) };
  if (/^(hi|hello|hey)(?:\b|!)/i.test(trimmed))
    return { kind: 'comments', choices: choiceList(['Hello!', "It's good to see you", 'How are you?']) };
  if (/^how are you\b/i.test(trimmed))
    return { kind: 'comments', choices: choiceList(["I'm good", "I'm tired", "I'm not sure", 'How are you?']) };
  return null;
}

function createFixedChatApi(options = {}, env = chatVariables(options.env === undefined ? process.env : options.env)) {
  const spawn = options.spawn || spawnProcess;
  // The reply service is reached over connections kept warm for the hub's
  // lifetime (spec 2026-10-27 §3.3), and warmed at each session start and touch-down.
  const ownFetch = options.fetch ? null : createKeepAliveFetch();
  const fetcher = options.fetch || ownFetch;
  let warmedAt = -Infinity;
  function warmReply() {
    if (!choicesCore.available || adapterUrl || clock() - warmedAt < 30000) return;
    warmedAt = clock();
    let origin; try { origin = new URL(env.ERA_CHAT_TEXT_URL).origin + '/'; } catch { return; }
    Promise.resolve().then(() => fetcher(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) }))
      .then(response => response?.body?.cancel?.() ?? response?.body?.resume?.(), () => {});
  }
  const clock = options.clock || Date.now;
  const limits = { ...DEFAULTS, ...options.limits };
  const ownCommands = !options.commands;
  const commands = options.commands || createCommands({ clock, pingMs: limits.commandPingMs, nonceMs: limits.commandNonceMs });
  const sessions = new Map(), requests = new Set();
  let runtimeArgs = null, closed = false, activeRoutes = 0;
  try {
    const args = JSON.parse(env.ERA_CHAT_RUNTIME_ARGS || '[]');
    if (Array.isArray(args) && args.length <= 32 && args.every(x => typeof x === 'string' && x.length <= 4096)) runtimeArgs = args;
  } catch { /* invalid configuration is unavailable */ }
  const externalRuntime = typeof env.ERA_CHAT_RUNTIME === 'string' && !!env.ERA_CHAT_RUNTIME.trim();
  let speechUrl = null;
  try {
    const parsed = new URL(transportUrl(env.ERA_CHAT_SPEECH_URL));
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) speechUrl = parsed.href;
  } catch { /* Native speech permits secure remote transport or local testing. */ }
  const speechConfigured = !!(speechUrl && env.ERA_CHAT_SPEECH_MODEL && env.ERA_CHAT_SPEECH_TOKEN);
  const workerPath = path.join(__dirname, 'chat-speech-worker.js');
  const builtIn = !externalRuntime && speechConfigured;
  const runtimeKind = externalRuntime ? 'external' : builtIn ? 'built-in' : 'unconfigured';
  const runtimeConfigured = externalRuntime || builtIn;
  const runtimeAvailable = externalRuntime ? runtimeArgs !== null : builtIn && (options.workerExists || fs.existsSync)(workerPath);
  const runtimeCommand = externalRuntime ? env.ERA_CHAT_RUNTIME : process.execPath;
  if (builtIn) runtimeArgs = [workerPath];
  const childEnv = speechEnvironment(env, options.env || process.env, builtIn);
  // Streaming transcription (spec 2026-10-27 §3): rides on the one-shot
  // recognizer, which stays the fallback for any hold the stream cannot finish.
  const streams = runtimeAvailable ? streamSettings(env) : [];
  const streamConnect = options.streamConnect;
  const adapterRequested = typeof env.ERA_CHAT_CHOICES_URL === 'string' && !!env.ERA_CHAT_CHOICES_URL.trim();
  const adapterUrl = transportUrl(env.ERA_CHAT_CHOICES_URL);
  // Chat test mode only (spec 2026-10-27 §5): the model id and token counts reach the page while the switch is on.
  const reportUsage = () => { try { return options.reportUsage?.() === true; } catch { return false; } };
  // What she likes (the device's chatLikes setting): sent with an open-ended
  // question only, read when a question asks; an unreadable list costs nothing.
  const listFrom = (provider, max) => {
    try {
      const list = provider?.();
      return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim() && item.trim().length <= max && !/[\x00-\x1f<>]/.test(item))
        .map(item => item.trim()).slice(0, 12) : [];
    } catch { return []; }
  };
  const likes = () => listFrom(options.likes, 30);
  // The ear's idle time (§10): it turns itself off after this long without a wake, hold or press.
  const wakeIdleMs = () => {
    try { const value = typeof options.wakeIdleMs === 'function' ? options.wakeIdleMs() : options.wakeIdleMs; return Number.isSafeInteger(value) && value > 0 ? value : 1800000; }
    catch { return 1800000; }
  };
  // The wake name (stable frame §8): the device's chatName, 'Ellie' by default.
  const wakeName = () => {
    try { const value = typeof options.name === 'function' ? options.name() : options.name; return typeof value === 'string' && value.trim() && value.length <= 40 ? value.trim() : 'Ellie'; }
    catch { return 'Ellie'; }
  };
  // The family's own names (the Drawing library's people), for a who question only.
  const people = () => listFrom(options.people, 20);
  // Her world (chat-world.js): the device's digest of week packages, shelf,
  // people and likes; `world` is the object from createWorld or a provider of
  // { text, weeks, chars }. Anything unreadable is no world at all.
  const worldDigest = () => {
    try {
      const value = typeof options.world === 'function' ? options.world() : typeof options.world?.digest === 'function' ? options.world.digest() : null;
      if (!value || typeof value.text !== 'string' || value.text.length > 6000) return null;
      const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
      // The About me page's lines (stable frame §2): clean short strings, six at most.
      const lines = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item.trim() && item.length <= 300 && !/[\x00-\x1f<>]/.test(item)).slice(0, 6);
      return { text: value.text, weeks: count(value.weeks), days: count(value.days), chars: value.text.length, about: lines(value.about), week: lines(value.week) };
    } catch { return null; }
  };
  // Two more than the HTTP route's own limit: a streaming session's speculative
  // request and its fresh one may overlap for a moment while one aborts.
  const choicesCore = createChoicesAdapter({ env, fetch: fetcher, limits: { concurrent: limits.choices + 2, timeoutMs: Math.min(limits.adapterMs, 12000) } });
  // Pictures warmed while the partner speaks (spec §6): the things a partial
  // names and each staged choice's picture go into the hub's symbol cache in
  // the background, so the reveal's <img> usually finds them there. Nothing in
  // the reply path waits for a fetch.
  const warmer = options.pictures && typeof options.pictures.fetchOne === 'function'
    ? createPictureWarmer({ isCached: options.pictures.isCached || (() => false), fetchOne: options.pictures.fetchOne }) : null;
  function warmSpoken(session, text) {
    const turn = session.turn;
    if (!warmer || !turn || turn.generation !== session.generation) return;
    try {
      turn.pictures = turn.pictures || warmer.hold();
      for (const candidate of pictureCandidates(text)) turn.pictures.add(candidate.id);
    } catch { /* A picture never holds a turn back. */ }
  }
  const speculateMs = (() => { const value = Number(env.ERA_CHAT_SPECULATE_MS ?? 300); return Number.isFinite(value) && value >= 0 && value <= 5000 ? value : 300; })();

  function emit(session, event) {
    if (session.closed) return;
    const record = { ...event, at: clock(), elapsedMs: Math.max(0, clock() - session.created) };
    const line = 'data: ' + JSON.stringify(record) + '\n\n';
    if (session.events) {
      if (session.events.writableLength > limits.runtimeQueueBytes) { dispose(session); return; }
      session.events.write(line);
    } else if (event.type === 'ready') session.ready = record;
  }
  function dispose(session) {
    if (session.closed) return;
    session.closed = true; sessions.delete(session.id);
    clearTimeout(session.killTimer);
    if (session.window) { clearInterval(session.window.timer); clearTimeout(session.window.drainTimer); session.window = null; }
    session.ear = null;
    if (session.events) session.events.end();
    if (session.socket) { session.socket.close(1001, 'session-ended'); session.socket = null; }
    abortChoices(session);
    if (session.stream) { session.stream.close(); session.stream = null; }
    session.turn = null;
    for (const waiter of session.frameWaiters) waiter.fail();
    try { session.child.stdin.end(JSON.stringify({ type: 'close', generation: session.generation }) + '\n'); } catch {}
    // Only this session's child is signalled. No process group or session kill.
    session.killTimer = setTimeout(() => { try { session.child.kill('SIGKILL'); } catch {} }, 2000);
    session.killTimer.unref();
    try { session.child.kill('SIGTERM'); } catch {}
    session.ready = null;
  }
  function runtimeFailure(session, code = 'runtime-error') {
    emit(session, { type: 'error', error: code, generation: session.generation });
    dispose(session);
  }
  function write(session, message) {
    if (session.closed || !session.child.stdin || session.child.stdin.destroyed)
      return Promise.reject(fault(503, 'runtime-unavailable'));
    const line = JSON.stringify({ ...message, generation: session.generation }) + '\n';
    if (session.child.stdin.writableLength + Buffer.byteLength(line) > limits.runtimeQueueBytes)
      return Promise.reject(fault(429, 'runtime-busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { runtimeFailure(session); reject(fault(503, 'runtime-unavailable')); }, limits.writeMs);
      timer.unref();
      try {
        session.child.stdin.write(line, error => {
          clearTimeout(timer);
          if (error) { runtimeFailure(session); reject(fault(503, 'runtime-unavailable')); }
          else resolve();
        });
      } catch { clearTimeout(timer); runtimeFailure(session); reject(fault(503, 'runtime-unavailable')); }
    });
  }
  function startSession() {
    if (!runtimeAvailable) throw fault(503, 'runtime-unavailable');
    if (sessions.size >= limits.sessions) throw fault(429, 'session-limit');
    let child;
    try { child = spawn(runtimeCommand, runtimeArgs, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }); }
    catch { throw fault(503, 'runtime-unavailable'); }
    const session = { id: randomUUID(), child, created: clock(), touched: clock(), generation: 0,
      mode: 'paused', seq: 0, bytes: 0, utteranceBytes: 0, uploading: false, events: null, runtimeReady: false, closed: false,
      socket: null, socketSeq: 0, turnBytes: 0, frameWaiters: new Set(), stream: null, streamIndex: 0, turn: null, keyterms: [],
      staged: streams.length > 0, context: [], choiceJob: null, window: null, ear: null, controlling: false };
    sessions.set(session.id, session);
    if (streams.length) { session.keyterms = loadKeyterms(env.ERA_CHAT_STREAM_KEYTERMS); startStream(session, 0); }
    warmReply();
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (session.closed) return;
      pending += chunk;
      if (Buffer.byteLength(pending) > limits.runtimeLineBytes) { runtimeFailure(session); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { runtimeFailure(session); return; }
        if (!event || !['ready', 'wake', 'partial', 'final', 'error'].includes(event.type)) { runtimeFailure(session); return; }
        const startupError = event.type === 'error' && !session.runtimeReady && event.generation === undefined;
        if (event.type !== 'ready' && !startupError && event.generation !== session.generation) continue;
        if (event.type === 'ready') {
          session.runtimeReady = true;
          const caps = event.capabilities || {};
          const streaming = !!session.stream;
          emit(session, { type: 'ready', sampleRate: 16000, capabilities: {
            wake: caps.wake === true, partial: caps.partial === true || streaming, automaticEndpoint: caps.automaticEndpoint === true,
            remoteFinal: caps.remoteFinal === true, remoteStreaming: caps.remoteStreaming === true || streaming,
            audioSocket: true, stagedChoices: session.staged,
          } });
        } else if (event.type === 'error') {
          session.mode = 'paused';
          emit(session, { type: 'error', error: (event.error || event.message) === 'no_speech' ? 'no-speech' : 'runtime-error', generation: session.generation });
          resumeEar(session);
        } else if (event.type === 'wake') {
          if (session.mode !== 'armed') continue;
          session.mode = 'capturing'; session.utteranceBytes = 0;
          emit(session, { type: 'wake', generation: session.generation });
        } else {
          if (!['capturing', 'finishing'].includes(session.mode)) continue;
          const text = cleanText(event.text, 2000);
          if (!text) { if (event.type === 'final') { session.mode = 'paused'; emit(session, { type: 'error', error: 'no-speech', generation: session.generation }); resumeEar(session); } continue; }
          if (event.type === 'final') { session.mode = 'paused'; if (session.turn) session.turn.done = true; }
          emit(session, { type: event.type, text, generation: session.generation,
            ...(event.type === 'final' ? { timings: safeTimings(event.timings), ...(session.staged ? { mode: 'one-shot' } : {}) } : {}) });
          if (event.type === 'final') { choicesForFinal(session, text); resumeEar(session); } else warmSpoken(session, text);
        }
      }
    });
    child.stdout.on('error', () => runtimeFailure(session));
    child.stderr.on('data', () => {}); // Never log child output: it may contain speech or paths.
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => runtimeFailure(session));
    child.on('error', () => runtimeFailure(session));
    child.on('exit', () => { clearTimeout(session.killTimer); if (!session.closed) runtimeFailure(session, 'runtime-stopped'); });
    return session;
  }
  function sweep() {
    const now = clock();
    for (const session of sessions.values())
      // An ear listens for as long as the partner leaves it on: its frames keep it from idling, and no lifetime ends it.
      if (now - session.touched > limits.idleMs || (now - session.created > limits.lifetimeMs && !session.ear)) dispose(session);
  }
  const timer = setInterval(sweep, Math.min(limits.idleMs, 10000)); timer.unref();

  // ---- streaming transcription per session ----
  function startStream(session, index) {
    const settings = streams[index];
    if (!settings || session.closed) { session.stream = null; return; }
    session.streamIndex = index;
    const stream = createStreamTranscriber({ ...settings, keyterms: session.keyterms, connect: streamConnect,
      idleCloseMs: limits.streamIdleMs ?? (settings.billing === 'connection' ? 60000 : 300000),
      finalTimeoutMs: limits.streamFinalMs, keepAliveMs: limits.streamKeepAliveMs });
    session.stream = stream;
    const current = () => session.stream === stream && session.turn && session.turn.mode === 'stream' && !session.turn.done && session.turn.generation === session.generation;
    stream.on('socket', value => { if (current()) emit(session, { type: 'socket', warm: value.warm, connectMs: value.connectMs, generation: session.generation }); });
    stream.on('partial', ({ text }) => {
      const clean = cleanText(text, 2000);
      // The ear's running words are the room's: only its machine hears them, never the page or a reply request.
      if (current() && clean && session.turn.ear) { session.window?.machine.partial(clean); return; }
      if (current() && clean && ['capturing', 'finishing'].includes(session.mode)) {
        emit(session, { type: 'partial', text: clean, generation: session.generation }); speculate(session, clean, false); warmSpoken(session, clean);
        if (session.turn.window && session.window) session.window.machine.partial(clean);
      }
    });
    // A window's utterance ended at the service (design §4.4): the machine seals it.
    stream.on('turn-end', ({ text }) => {
      const clean = cleanText(text, 2000);
      if (current() && clean && session.turn.window && session.window) session.window.machine.turnEnd(clean);
    });
    stream.on('settled', ({ text }) => {
      const clean = cleanText(text, 2000);
      if (current() && clean && !session.turn.window) { emit(session, { type: 'settled', text: clean, generation: session.generation }); speculate(session, clean, true); warmSpoken(session, clean); }
    });
    stream.on('final', ({ text, timings }) => {
      if (!current()) return;
      // A window is finalized only at a second press or its cap: the final ends the utterance in flight.
      if (session.turn.window) { if (session.window?.draining) session.window.machine.end(cleanText(text, 2000)); return; }
      const turn = session.turn; turn.done = true; turn.pcm = null;
      const socketSeconds = stream.takeSocketSeconds();
      session.mode = 'paused';
      const clean = cleanText(text, 2000);
      if (!clean) { emit(session, { type: 'error', error: 'no-speech', generation: session.generation }); resumeEar(session); return; }
      emit(session, { type: 'final', text: clean, generation: session.generation, mode: 'stream', setting: index === 0 ? 'primary' : 'fallback', timings: safeTimings(timings),
        ...(reportUsage() ? { usage: { socketSeconds, keytermsFired: keytermsFired(clean, session.keyterms) } } : {}) });
      choicesForFinal(session, clean);
      resumeEar(session);
    });
    stream.on('error', ({ code, beforeAudio }) => {
      if (code === 'open-failed' && beforeAudio && streams[index + 1] && session.stream === stream) {
        // The next holds use the fallback stream setting; this one goes one-shot.
        stream.close(); startStream(session, index + 1);
      }
      if (session.turn && session.turn.mode === 'stream' && !session.turn.done && session.turn.transcriber === stream) {
        // A window has no one-shot fallback: it closes, and the partner can press again.
        // While its final is awaited, the utterance in flight seals from the latest partial.
        if (session.turn.window) { if (session.window?.draining) session.window.machine.end(); else session.window?.machine.stop('error'); return; }
        fallBack(session);
      }
    });
    stream.open().catch(() => {
      if (session.stream === stream && streams[index + 1] && !(session.turn && session.turn.transcriber === stream && !session.turn.done)) { stream.close(); startStream(session, index + 1); }
    });
  }
  // The stream could not finish this hold: the one-shot recognizer gets every
  // frame of it, in order, and the release if it already happened.
  // The replay waits for each write to flush (back-pressure): a whole hold
  // written at once could overrun the recognizer's input queue. Live frames
  // and the release queue behind it, in order.
  function fallBack(session) {
    const turn = session.turn;
    turn.mode = 'one-shot';
    const pcm = turn.pcm || []; turn.pcm = null;
    if (!session.runtimeReady || session.closed) { cancelTurn(session, 'recognition-failed'); return; }
    turn.chain = Promise.resolve();
    for (const piece of pcm) queueWrite(session, turn, { type: 'audio', pcm: piece.toString('base64') });
    if (turn.released) queueWrite(session, turn, { type: 'finish' });
  }
  function queueWrite(session, turn, message) {
    turn.chain = turn.chain.then(() => {
      if (session.turn !== turn || turn.failed || session.closed) return;
      return write(session, message);
    }).catch(() => { if (session.turn === turn && !turn.failed) { turn.failed = true; cancelTurn(session, 'runtime-busy'); } });
  }
  function endStreamTurn(session) {
    const turn = session.turn;
    if (turn && turn.mode === 'stream' && !turn.done && session.stream) { turn.done = true; session.stream.cancel(); }
    session.turn = null;
  }
  function beginTurn(session, { window = false } = {}) {
    endStreamTurn(session);
    const stream = session.stream;
    session.turn = { generation: session.generation, mode: stream ? 'stream' : 'one-shot', transcriber: stream, pcm: [], released: false, done: false, window,
      pictures: warmer ? warmer.hold() : null };
    if (stream) stream.begin({ window });
  }
  function acceptPcm(session, pcm) {
    const turn = session.turn;
    if (turn && turn.chain && turn.generation === session.generation) { queueWrite(session, turn, { type: 'audio', pcm: pcm.toString('base64') }); return; }
    if (turn && turn.mode === 'stream' && !turn.done && turn.generation === session.generation) {
      if (turn.window) { turn.transcriber.sendPcm(pcm); feedWindow(session, pcm); return; }
      turn.pcm.push(Buffer.from(pcm)); turn.transcriber.sendPcm(pcm); return;
    }
    forwardPcm(session, pcm);
  }

  // ---- the audio socket (spec 2026-10-27 §3.1) ----
  // A hold that cannot be completed honestly is cancelled: a new generation, the
  // recognizer told to drop it, never a short submit.
  function cancelTurn(session, error) {
    if (session.closed) return;
    const active = ['capturing', 'finishing'].includes(session.mode);
    if (session.window) session.window.machine.stop(error ? 'error' : 'cancel');
    abortChoices(session); endStreamTurn(session);
    session.generation++; session.mode = 'paused'; session.turnBytes = 0;
    write(session, { type: 'cancel' }).catch(() => {});
    if (error && active) emit(session, { type: 'error', error, generation: session.generation });
    resumeEar(session);
  }
  function forwardPcm(session, pcm) {
    write(session, { type: 'audio', pcm: pcm.toString('base64') }).catch(error => {
      if (error.status === 429) cancelTurn(session, 'runtime-busy');
    });
  }
  function waitForFrames(session, count) {
    if (session.socketSeq >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        check() { if (session.socketSeq >= count) { this.done(); resolve(); } },
        fail() { this.done(); reject(fault(409, 'audio-sequence')); },
        done() { clearTimeout(this.timer); session.frameWaiters.delete(this); },
      };
      waiter.timer = setTimeout(() => waiter.fail(), limits.drainMs);
      waiter.timer.unref?.();
      session.frameWaiters.add(waiter);
    });
  }
  function attachSocket(session, ws) {
    session.socket = ws; session.socketSeq = 0;
    const broken = (code, reason) => {
      if (session.socket === ws) { session.socket = null; closeEar(session, 'socket'); if (['capturing', 'finishing'].includes(session.mode)) cancelTurn(session); }
      ws.close(code, reason);
    };
    ws.on('message', (data, binary) => {
      if (session.closed || session.socket !== ws) return;
      if (!binary) { broken(1003, 'binary-only'); return; }
      if (data.length < FRAME_HEADER + 2 || (data.length - FRAME_HEADER) % 2 || data.length - FRAME_HEADER > limits.audioBytes) { broken(1008, 'invalid-pcm'); return; }
      const generation = data.readUInt32LE(0), seq = data.readUInt32LE(4);
      if (seq !== session.socketSeq) { broken(1008, 'audio-sequence'); return; }
      session.socketSeq++; session.touched = clock();
      for (const waiter of [...session.frameWaiters]) waiter.check();
      // Another generation's frame, or any frame outside a hold, is dropped here.
      if (generation !== session.generation || session.mode !== 'capturing') return;
      const pcm = data.subarray(FRAME_HEADER);
      // The ear's frames are the room's for as long as it listens: no hold or window budget applies.
      if (!session.window?.ear) {
        if (session.bytes + pcm.length > limits.sessionBytes || session.turnBytes + pcm.length > turnByteLimit(session.turn, limits)) { cancelTurn(session, 'audio-limit'); return; }
        session.bytes += pcm.length; session.turnBytes += pcm.length;
      }
      acceptPcm(session, pcm);
    });
    ws.on('close', () => {
      if (session.socket !== ws) return;
      session.socket = null;
      closeEar(session, 'socket');
      if (['capturing', 'finishing'].includes(session.mode)) cancelTurn(session);
    });
  }
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    if (closed) { refuseUpgrade(socket, 503); return true; }
    if (!ownRequest(req)) { refuseUpgrade(socket, 403); return true; }
    const match = /^\/sessions\/([a-f0-9-]+)\/audio$/.exec(url.pathname.slice(PREFIX.length));
    const session = match && sessions.get(match[1]);
    if (!session || session.closed) { refuseUpgrade(socket, 404); return true; }
    if (session.socket) { refuseUpgrade(socket, 409); return true; }
    const ws = acceptWebSocket(req, socket, head, { maxPayload: limits.audioBytes + FRAME_HEADER });
    if (ws) { session.touched = clock(); attachSocket(session, ws); }
    return true;
  }

  // The one choice path: local shortcuts first, then the external adapter or
  // the built-in reply core (streamed when `onChoice` listens), then the
  // published post-checks. Returns the page's body; throws a fault.
  // `mode` ('ask' | 'comment', stable frame §3) asks for her own turn: no local
  // shortcut, no shape, likes and world always. `avoid` (Something else) lists
  // the says already shown, and skips the local shortcut that would repeat them.
  async function produceChoices(text, context, signal, onChoice, { mode, avoid } = {}) {
    const began = clock();
    const local = mode || avoid ? null : localChoices(text);
    if (local) return { ...local, timings: { totalMs: Math.max(0, clock() - began) } };
    if (adapterRequested && !adapterUrl) throw fault(503, 'choices-unavailable');
    if (!adapterUrl && !choicesCore.available) return { kind: 'fallback', choices: choiceList(mode ? MODE_FALLBACK[mode] : [
      'Tell me more', "I'm not sure", 'Please say that again', "I don't want to answer",
    ]), ...(mode ? { mode } : {}), timings: { totalMs: Math.max(0, clock() - began) } };
    try {
      let result;
      const shape = mode ? null : openShape(text), liked = shape || mode ? likes() : [];
      const named = shape && /\bwho(?:m)?\b/i.test(text) ? people() : [];
      // Her world goes with an open-ended question or a mode only, and only when
      // it holds more than its Today line (a week, a book, people or likes).
      const known = shape || mode ? worldDigest() : null, world = known && known.text.includes('\n') ? known : null;
      const input = { text, ...(context && context.length ? { context } : {}), ...(shape ? { shape } : {}), ...(liked.length ? { likes: liked } : {}),
        ...(named.length ? { people: named } : {}), ...(world ? { world: world.text } : {}),
        ...(mode ? { mode } : {}), ...(avoid && avoid.length ? { avoid } : {}) };
      if (!adapterUrl) result = onChoice ? await choicesCore.generateStream(input, { signal, onChoice }) : await choicesCore.generate(input, { signal });
      else {
        const response = await fetcher(adapterUrl, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', ...(env.ERA_CHAT_CHOICES_TOKEN ? { Authorization: 'Bearer ' + env.ERA_CHAT_CHOICES_TOKEN } : {}) },
          body: JSON.stringify(input) });
        if (!response.ok || !response.body) throw fault(502, 'choices-unavailable');
        let size = 0, chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > limits.adapterBytes) throw fault(502, 'choices-invalid');
          chunks.push(Buffer.from(chunk));
        }
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault(502, 'choices-invalid'); }
      }
      const items = result && result.choices;
      if (!Array.isArray(items) || items.length < 2 || items.length > 6 || !items.every(item =>
        item && cleanText(item.label, 60) && cleanText(item.say, 300))) throw fault(502, 'choices-invalid');
      const unique = new Set(items.map(item => cleanText(item.say, 300).toLowerCase()));
      if (unique.size !== items.length) throw fault(502, 'choices-invalid');
      if (signal.aborted) throw fault(502, 'choices-unavailable');
      // How many model pictures the hub refused for the label's own (test mode counts them).
      const rejected = items.filter(item => symbolRejected({ label: cleanText(item.label, 60), say: cleanText(item.say, 300), symbol: item.symbol })).length;
      return { kind: ['guarded', 'generated'].includes(result.kind) ? result.kind : 'adapter',
        ...(['guarded', 'generated'].includes(result.kind) ? { generated: result.kind === 'generated' && result.generated === true } : {}),
        choices: choiceList(items.map(item => ({ label: cleanText(item.label, 60), say: cleanText(item.say, 300), symbol: item.symbol, picture: item.picture }))),
        ...(rejected ? { symbolRejected: rejected } : {}),
        ...(shape ? { shape } : {}), ...(mode ? { mode } : {}), ...(result.recallRejected === true ? { recallRejected: true } : {}),
        ...(Number.isSafeInteger(result.commentDropped) && result.commentDropped > 0 && result.commentDropped <= 4 ? { commentDropped: result.commentDropped } : {}),
        // The turn record keeps the world's size, never its text.
        ...(world ? { world: { weeks: world.weeks, days: world.days, chars: world.chars } } : {}),
        ...(!adapterUrl && reportUsage() && cleanUsage(result.usage) ? { usage: cleanUsage(result.usage) } : {}),
        timings: { totalMs: Math.max(0, clock() - began), ...(Number.isFinite(result.timings?.firstChoiceMs) ? { firstChoiceMs: result.timings.firstChoiceMs } : {}) } };
    } catch (error) { throw error.status ? error : fault(502, 'choices-unavailable'); }
  }
  function cleanContext(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 8 || !value.every(x => cleanText(x, 500))) throw fault(400, 'invalid-context');
    return value.map(x => cleanText(x, 500));
  }
  function cleanAvoid(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 8 || !value.every(x => cleanText(x, 300))) throw fault(400, 'invalid-avoid');
    return value.length ? value.map(x => cleanText(x, 300)) : undefined;
  }
  async function generate(req, res) {
    const input = await readJson(req, limits.bodyBytes);
    const text = cleanText(input.text, 2000);
    if (!text) throw fault(400, 'invalid-text');
    const context = cleanContext(input.context);
    if (input.mode !== undefined && !MODES.includes(input.mode)) throw fault(400, 'invalid-mode');
    const mode = input.mode, avoid = cleanAvoid(input.avoid);
    if (requests.size >= limits.choices && (mode || avoid || !localChoices(text))) throw fault(429, 'choices-busy');
    const controller = new AbortController(); requests.add(controller);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    const timeout = setTimeout(() => controller.abort(), limits.adapterMs); timeout.unref();
    try { json(res, 200, await produceChoices(text, context, controller.signal, undefined, { mode, avoid })); }
    finally { clearTimeout(timeout); requests.delete(controller); res.off('close', cancel); }
  }

  // ---- hub-staged choices for streaming sessions (spec 2026-10-27 §3.3) ----
  // A job runs one choice request. While unattached (speculative) nothing of
  // it leaves the hub. Attached, each choice is staged to the page as it
  // completes and the checked batch is sealed once; a newer generation drops it.
  const normalized = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  function runChoices(session, text) {
    const turn = session.turn && session.turn.generation === session.generation ? session.turn : null;
    const job = { text, norm: normalized(text), generation: session.generation, controller: new AbortController(), staged: [],
      stagedCount: 0, result: null, error: null, done: false, attached: false, sealed: false,
      pictures: turn && turn.pictures || (warmer ? warmer.hold() : null) };
    const timeout = setTimeout(() => job.controller.abort(), limits.adapterMs); timeout.unref?.();
    produceChoices(text, session.context, job.controller.signal, choice => { job.staged.push(choice); if (job.attached) stageChoice(session, job, choice); })
      .then(result => { job.result = result; }, error => { job.error = error; })
      .finally(() => { clearTimeout(timeout); job.done = true; if (job.attached) sealChoices(session, job); });
    return job;
  }
  // A window's batches carry the window and the seal they answer (seq 1 first, >1 a replacement).
  const windowOf = job => job.window ? { windowId: job.window.id, seq: job.window.seq } : {};
  const liveJob = (session, job) => !session.closed && session.choiceJob === job && job.generation === session.generation && !job.sealed;
  function stageChoice(session, job, choice) {
    if (!liveJob(session, job)) return;
    const index = job.stagedCount++;
    // A choice of a whole batch (a shortcut, the adapter) is already picked as part of
    // its batch (a glyph, a person, the second of two names): it is staged as it is.
    const picked = choice.glyph === true || Number.isSafeInteger(choice.symbolId) || typeof choice.picture?.src === 'string';
    const [pick] = picked ? [choice] : choiceList([{ label: choice.label, say: choice.say, ...(typeof choice.symbol === 'string' ? { symbol: choice.symbol } : {}),
      ...(typeof choice.picture === 'string' ? { picture: choice.picture } : {}) }]);
    emit(session, { type: 'choice-staged', generation: job.generation, ...windowOf(job), index, choice: { ...pick, id: `choice-${index + 1}` } });
    // The hub knows the picture before the page does: warm it now, behind the event.
    if (job.pictures && pick.symbolId) try { job.pictures.stage(pick.symbolId); } catch { /* decorative */ }
  }
  function sealChoices(session, job) {
    if (!liveJob(session, job)) return;
    if (job.error) { job.sealed = true; emit(session, { type: 'choices-error', error: job.error.code || 'choices-unavailable', generation: job.generation, ...windowOf(job) }); return; }
    // A batch that arrived whole (a shortcut, the adapter) stages each choice now.
    if (!job.stagedCount) for (const choice of job.result.choices) stageChoice(session, job, choice);
    job.sealed = true;
    emit(session, { type: 'batch-sealed', generation: job.generation, ...windowOf(job), ...job.result,
      ...(reportUsage() && job.pictures ? { pictureWarm: Math.min(job.pictures.count, 12) } : {}) });
  }
  function attachChoices(session, job) {
    session.choiceJob = job; job.attached = true;
    for (const choice of job.staged) stageChoice(session, job, choice);
    if (job.done) sealChoices(session, job);
  }
  function abortChoices(session) {
    const turn = session.turn;
    if (turn) { clearTimeout(turn.stableTimer); if (turn.speculation && !turn.speculation.attached) turn.speculation.controller.abort(); turn.speculation = null; }
    if (session.choiceJob) { session.choiceJob.controller.abort(); session.choiceJob = null; }
  }
  // Speculation: a partial unchanged for ERA_CHAT_SPECULATE_MS (or words the
  // service says are settled) starts a hidden request on that text.
  function speculate(session, text, now) {
    const turn = session.turn;
    if (!speculateMs || !turn || turn.mode !== 'stream' || turn.done || turn.generation !== session.generation) return;
    clearTimeout(turn.stableTimer);
    const start = () => {
      if (session.turn !== turn || turn.done || session.closed || turn.generation !== session.generation) return;
      const norm = normalized(text);
      if (!norm || (turn.speculation && turn.speculation.norm === norm)) return;
      if (turn.speculation) { turn.speculation.controller.abort(); emit(session, { type: 'speculation', state: 'discard', generation: turn.generation }); }
      turn.speculation = runChoices(session, text);
      emit(session, { type: 'speculation', state: 'start', generation: turn.generation });
    };
    if (now) start(); else { turn.stableTimer = setTimeout(start, speculateMs); turn.stableTimer.unref?.(); }
  }
  // The final transcript is the only thing the choices commit to.
  function choicesForFinal(session, text) {
    if (!session.staged) return;
    const turn = session.turn, spec = turn && turn.speculation;
    if (turn) { clearTimeout(turn.stableTimer); turn.speculation = null; }
    if (spec && spec.norm === normalized(text) && spec.generation === session.generation && !(spec.done && spec.error)) {
      emit(session, { type: 'speculation', state: 'keep', generation: session.generation });
      attachChoices(session, spec); return;
    }
    if (spec) { spec.controller.abort(); emit(session, { type: 'speculation', state: 'discard', generation: session.generation }); }
    attachChoices(session, runChoices(session, text));
  }
  // ---- the button-press listening window (design 2026-10-27 §4.4) ----
  // One stream turn for the whole window, never finalized per utterance: the
  // machine (chat-window.js) seals each utterance that sounds complete, and each
  // seal runs the choice request on the whole window text. Frames feed the
  // hub's energy gate (the silence fallback); the machine is ticked for its
  // deadlines. A second press or the cap with an utterance in flight finalizes
  // the stream turn first (drain): its final, or the latest partial after
  // windowFinalMs, seals that utterance, and only then the window closes.
  // Closing cancels the stream turn and pauses capture; the last seal's batch
  // still arrives (the generation is not advanced).
  function openWindow(session, context) {
    abortChoices(session); endStreamTurn(session);
    session.generation++; session.context = context; session.mode = 'capturing'; session.utteranceBytes = 0; session.turnBytes = 0;
    beginTurn(session, { window: true });
    const win = { id: randomBytes(6).toString('hex'), generation: session.generation, gate: energyGate(), machine: null, timer: null, draining: false, drainTimer: null };
    win.machine = createWindow({ clock, limits: { utteranceMs: limits.windowUtteranceMs, silenceMs: limits.windowSilenceMs, capMs: limits.windowCapMs },
      seal: info => windowSeal(session, win, info), close: (reason, info) => windowClosed(session, win, reason, info),
      drain: () => windowDrain(session, win) });
    session.window = win;
    win.timer = setInterval(() => win.machine.tick(), limits.windowTickMs); win.timer.unref?.();
    emit(session, { type: 'window-open', windowId: win.id, generation: win.generation });
    return win;
  }
  function feedWindow(session, pcm) {
    const win = session.window;
    if (!win) return;
    for (const energetic of win.gate(pcm)) { if (session.window !== win) return; win.machine.speech(energetic); }
  }
  // Finalize the transcriber for the utterance in flight; the machine ends on
  // its final (the 'final' handler) or on this deadline with the latest partial.
  function windowDrain(session, win) {
    const turn = session.turn;
    if (session.window !== win || session.closed || !turn || !turn.window || turn.mode !== 'stream' || turn.done) { win.machine.end(); return; }
    win.draining = true;
    win.drainTimer = setTimeout(() => win.machine.end(), limits.windowFinalMs); win.drainTimer.unref?.();
    turn.transcriber.finalize();
  }
  function windowSeal(session, win, { seq, text, windowText, reason }) {
    if (session.window !== win || session.closed) return;
    emit(session, { type: 'utterance-sealed', windowId: win.id, seq, text, windowText, reason, generation: win.generation });
    const turn = session.turn;
    let job = null;
    if (turn && turn.window) {
      clearTimeout(turn.stableTimer);
      const spec = turn.speculation; turn.speculation = null;
      if (spec && spec.norm === normalized(windowText) && spec.generation === session.generation && !(spec.done && spec.error)) {
        emit(session, { type: 'speculation', state: 'keep', generation: session.generation }); job = spec;
      } else if (spec) { spec.controller.abort(); emit(session, { type: 'speculation', state: 'discard', generation: session.generation }); }
    }
    // A newer seal supersedes a batch still in the making; a sealed batch stays as it was.
    const previous = session.choiceJob;
    if (previous && !previous.sealed) previous.controller.abort();
    job ||= runChoices(session, windowText);
    job.window = { id: win.id, seq };
    attachChoices(session, job);
  }
  function windowClosed(session, win, reason, { seals }) {
    if (session.window !== win) return;
    clearInterval(win.timer); clearTimeout(win.drainTimer); win.draining = false; session.window = null;
    // Cancel, her pick and a failure discard whatever is still being made.
    if (['cancel', 'pick', 'error'].includes(reason)) abortChoices(session);
    else { const turn = session.turn; if (turn) { clearTimeout(turn.stableTimer); if (turn.speculation && !turn.speculation.attached) turn.speculation.controller.abort(); turn.speculation = null; } }
    if (session.turn && session.turn.window) endStreamTurn(session);
    session.mode = 'paused'; session.turnBytes = 0;
    emit(session, { type: 'window-closed', windowId: win.id, reason, seals, generation: win.generation });
    resumeEar(session);
  }
  function openWindowOf() {
    // An ear is never pressed: the button's second press and cancel belong to a button window.
    for (const session of sessions.values()) if (session.window && !session.window.ear && !session.closed) return session.window;
    return null;
  }

  // ---- the wake word's ear (stable frame design 2026-10-28 §8) ----
  // One listening window that never closes on silence or cap (its utterance
  // cap stays). Every utterance it seals is checked for the wake name: a match
  // is a question, sealed as `utterance-sealed {ear: true}` with its own
  // windowId and seq 1, and goes through the staged choices like a button
  // window's first batch; anything else is dropped here, never emitted, never
  // asked of the reply model. A hold or a button window pauses the ear (its
  // frames are theirs) and it resumes after, in the generation it left off at.
  function startEarTurn(session, ear) {
    endStreamTurn(session);
    session.mode = 'capturing'; session.turnBytes = 0; session.utteranceBytes = 0;
    beginTurn(session, { window: true });
    session.turn.ear = true;
    const win = { id: ear.id, ear, generation: session.generation, gate: energyGate(), machine: null, timer: null, draining: false, drainTimer: null, startedAt: clock() };
    win.machine = createWindow({ clock, limits: { utteranceMs: limits.windowUtteranceMs, silenceMs: Infinity, capMs: Infinity },
      seal: info => earSeal(session, win, info), close: reason => { if (session.window === win) closeEar(session, reason); } });
    session.window = win;
    win.timer = setInterval(() => { win.machine.tick(); if (session.window === win) earTick(session, ear); }, limits.windowTickMs); win.timer.unref?.();
    return win;
  }
  // Auto-off (§10): warnings at two minutes and one minute left, then off as
  // idle; the hub saves the switch off (onWakeIdle) so a reload does not reopen it.
  function earActive(ear) { ear.activeAt = clock(); ear.warned = []; }
  function earTick(session, ear) {
    const remaining = wakeIdleMs() - (clock() - ear.activeAt);
    if (remaining <= 0) {
      closeEar(session, 'idle');
      try { options.onWakeIdle?.(); } catch { /* the page's switch still reads off */ }
      return;
    }
    for (const mark of [120000, 60000]) if (remaining <= mark && !ear.warned.includes(mark)) {
      ear.warned.push(mark);
      if (remaining > mark - 60000) emit(session, { type: 'ear', state: 'warning', remainingMs: mark, earId: ear.id, generation: session.generation });
    }
  }
  function openEar(session, context) {
    abortChoices(session); endStreamTurn(session);
    session.generation++; session.context = context;
    const ear = { id: randomBytes(6).toString('hex'), paused: false, pendingAt: null, activeAt: 0, warned: [] };
    earActive(ear);
    session.ear = ear;
    startEarTurn(session, ear);
    emit(session, { type: 'ear', state: 'listening', earId: ear.id, generation: session.generation });
    return ear;
  }
  function pauseEar(session, reason) {
    const win = session.window;
    if (!win || !win.ear) return;
    clearInterval(win.timer); session.window = null; win.ear.paused = true; win.ear.pendingAt = null; earActive(win.ear);
    if (session.turn && session.turn.ear) endStreamTurn(session);
    emit(session, { type: 'ear', state: 'off', reason, earId: win.ear.id, generation: session.generation });
  }
  function resumeEar(session) {
    const ear = session.ear;
    if (!ear || !ear.paused || session.window || session.closed || session.controlling || ['capturing', 'finishing'].includes(session.mode)) return;
    ear.paused = false; earActive(ear);
    startEarTurn(session, ear);
    emit(session, { type: 'ear', state: 'listening', earId: ear.id, generation: session.generation, resumed: true });
  }
  function closeEar(session, reason) {
    const ear = session.ear;
    if (!ear) return;
    session.ear = null;
    const win = session.window && session.window.ear ? session.window : null;
    if (win) {
      clearInterval(win.timer); session.window = null;
      if (session.turn && session.turn.ear) endStreamTurn(session);
      session.mode = 'paused'; session.turnBytes = 0;
    }
    emit(session, { type: 'ear', state: 'off', reason, earId: ear.id, generation: session.generation });
  }
  function earSeal(session, win, { text, reason }) {
    if (session.window !== win || session.closed) return;
    const ear = win.ear, now = clock();
    const found = wakeQuestion(text, wakeName());
    let question = null;
    if (found && found.question) question = found.question;
    else if (found) ear.pendingAt = now;
    else if (ear.pendingAt !== null && now - ear.pendingAt <= limits.earWakeMs) question = cleanText(text, 2000);
    if (question) {
      ear.pendingAt = null; earActive(ear);
      const id = randomBytes(6).toString('hex');
      emit(session, { type: 'utterance-sealed', windowId: id, earId: ear.id, ear: true, seq: 1, text: question, windowText: question, reason, generation: session.generation });
      // A new wake supersedes a reply still in the making, as a new hold does.
      const previous = session.choiceJob;
      if (previous && !previous.sealed) previous.controller.abort();
      const job = runChoices(session, question);
      job.window = { id, seq: 1 };
      attachChoices(session, job);
    }
    // An old stream turn starts afresh between utterances (bounded memory at
    // the service and here); the ear itself never closes for it.
    if (now - win.startedAt >= limits.earRollMs) setImmediate(() => {
      if (session.window !== win || session.closed || win.machine.pending) return;
      clearInterval(win.timer); session.window = null;
      startEarTurn(session, ear);
    });
  }

  // One control for a session (the hold's and the button window's), with the
  // ear paused for a hold or a press and closed by pause, arm or close.
  async function control(session, body, res) {
    if (session.window?.ear) {
      if (body.type === 'ask' || body.type === 'window') pauseEar(session, body.type === 'ask' ? 'hold' : 'press');
      // Her pick and a cancel leave the ear listening; a cancel drops a reply still in the making.
      else if (body.type === 'pick') return json(res, 200, { ok: true, generation: session.generation });
      else if (body.type === 'cancel') { abortChoices(session); return json(res, 200, { ok: true, generation: session.generation }); }
      else if (body.type === 'finish') throw fault(409, 'capture-inactive');
      else closeEar(session, body.type);
    } else if (session.ear && ['pause', 'arm', 'close'].includes(body.type)) closeEar(session, body.type);
    // A listening window is ended by a press, a cancel, her pick or its own
    // clock; a hold's controls never finish or restart it (plan T3.2).
    if (session.window && ['ask', 'finish', 'window'].includes(body.type)) throw fault(409, 'window-open');
    if (body.type === 'pick') { session.window?.machine.pick(); return json(res, 200, { ok: true, generation: session.generation }); }
    if (body.type === 'window') {
      if (!session.stream) throw fault(409, 'stream-unavailable');
      const context = cleanContext(body.context) || [];
      const win = openWindow(session, context);
      warmReply();
      // The recognizer hears the new generation and drops anything older.
      await write(session, { type: 'cancel' });
      return json(res, 200, { ok: true, generation: session.generation, windowId: win.id });
    }
    if (session.window) session.window.machine.cancel();
    if (body.type === 'close') { dispose(session); return json(res, 200, { closed: true }); }
    if (body.type === 'finish' && body.seq !== undefined) {
      if (!Number.isSafeInteger(body.seq) || body.seq < 0) throw fault(400, 'invalid-control');
      // The page's frames travel on the socket, this request on another
      // connection: finish waits for every frame the page says it sent.
      const generation = session.generation;
      try { await waitForFrames(session, body.seq); }
      catch (error) { if (generation === session.generation) cancelTurn(session); throw error; }
      if (session.closed || generation !== session.generation) throw fault(409, 'capture-inactive');
    }
    // A hold the hub already ended (cancelled, failed, over budget) is never finished.
    if (body.type === 'finish' && session.mode !== 'capturing') throw fault(409, 'capture-inactive');
    const context = body.type === 'ask' ? cleanContext(body.context) || [] : null;
    if (body.type !== 'finish') { abortChoices(session); endStreamTurn(session); session.generation++; }
    if (context) session.context = context;
    session.mode = body.type === 'ask' ? 'capturing' : body.type === 'arm' && body.enabled ? 'armed' : body.type === 'finish' ? 'finishing' : 'paused';
    if (body.type !== 'finish') { session.utteranceBytes = 0; session.turnBytes = 0; }
    if (body.type === 'ask') { beginTurn(session); warmReply(); }
    if (body.type === 'finish' && session.turn && session.turn.generation === session.generation) {
      session.turn.released = true;
      if (session.turn.mode === 'stream' && !session.turn.done) {
        // Release finalizes the stream; the recognizer's own capture is left unused.
        session.turn.transcriber.finalize();
        return json(res, 200, { ok: true, generation: session.generation });
      }
      if (session.turn.chain) { queueWrite(session, session.turn, { type: 'finish' }); return json(res, 200, { ok: true, generation: session.generation }); }
    }
    await write(session, { type: body.type, ...(body.type === 'arm' ? { enabled: body.enabled } : {}) });
    return json(res, 200, { ok: true, generation: session.generation });
  }

  async function route(req, res, url) {
    if (closed) throw fault(503, 'chat-unavailable');
    if (!ownRequest(req)) throw fault(403, 'local-only');
    const routePath = url.pathname.slice(PREFIX.length);
    if (req.method === 'GET' && routePath === '/config') return json(res, 200, {
      wakeName: wakeName(), runtime: { available: !!runtimeAvailable, configured: !!runtimeConfigured, kind: runtimeKind,
        status: runtimeAvailable ? 'configured' : runtimeConfigured ? 'unavailable' : 'unconfigured', capabilities: { wake: streams.length > 0, streaming: streams.length ? true : null } },
      choices: { available: true, kind: adapterRequested ? 'adapter' : choicesCore.available ? 'built-in' : 'local', generated: adapterRequested ? !!adapterUrl : choicesCore.available },
    });
    if (req.method === 'POST' && routePath === '/choices') return generate(req, res);
    if (req.method === 'GET' && routePath === '/commands') {
      const visible = url.searchParams.get('visible');
      commands.connect(res, { nonce: url.searchParams.get('nonce'), visible: visible === '1' ? true : visible === '0' ? false : null });
      return;
    }
    if (req.method === 'POST' && routePath === '/commands/visibility') {
      const body = await readJson(req, limits.bodyBytes);
      if (typeof body.visible !== 'boolean') throw fault(400, 'invalid-visibility');
      if (!commands.setVisible(body.visible)) throw fault(409, 'no-page');
      return json(res, 200, { ok: true });
    }
    // What Chat knows this week, for the partner dialog's read-only preview.
    if (req.method === 'GET' && routePath === '/world') return json(res, 200, worldDigest() || { text: '', weeks: 0, days: 0, chars: 0, about: [], week: [] });
    if (req.method === 'POST' && routePath === '/sessions') {
      await readBody(req, limits.bodyBytes);
      const session = startSession(); return json(res, 201, { id: session.id });
    }
    const match = /^\/sessions\/([a-f0-9-]+)(?:\/(events|control|audio))?$/.exec(routePath);
    if (!match) throw fault(404, 'not-found');
    const session = sessions.get(match[1]);
    if (!session || session.closed) throw fault(404, 'session-not-found');
    session.touched = clock();
    if (req.method === 'GET' && !match[2]) return json(res, 200, { ready: session.runtimeReady, mode: session.mode });
    if (req.method === 'DELETE' && !match[2]) { dispose(session); return json(res, 200, { closed: true }); }
    if (req.method === 'GET' && match[2] === 'events') {
      if (session.events) throw fault(409, 'events-already-open');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n'); session.events = res;
      if (session.ready) { res.write('data: ' + JSON.stringify(session.ready) + '\n\n'); session.ready = null; }
      res.once('close', () => dispose(session)); return;
    }
    if (req.method === 'POST' && match[2] === 'control') {
      const body = await readJson(req, limits.bodyBytes);
      if (!['arm', 'ask', 'finish', 'cancel', 'pause', 'close', 'window', 'pick'].includes(body.type) ||
        (body.type === 'arm' && typeof body.enabled !== 'boolean') ||
        (body.type === 'window' && body.ear !== undefined && typeof body.ear !== 'boolean')) throw fault(400, 'invalid-control');
      // The wake word's ear (stable frame §8): on with ear:true, off with ear:false.
      if (body.type === 'window' && body.ear !== undefined) {
        if (!body.ear) { closeEar(session, 'off'); return json(res, 200, { ok: true, generation: session.generation }); }
        if (!session.stream) throw fault(409, 'stream-unavailable');
        if (session.window && !session.window.ear) throw fault(409, 'window-open');
        const context = cleanContext(body.context);
        // Already on: the same ear; a context brings the conversation so far up to date.
        if (session.ear) { if (context) session.context = context; return json(res, 200, { ok: true, generation: session.generation, earId: session.ear.id }); }
        const ear = openEar(session, context || []);
        warmReply();
        await write(session, { type: 'cancel' });
        return json(res, 200, { ok: true, generation: session.generation, earId: ear.id });
      }
      session.controlling = true;
      try { return await control(session, body, res); }
      finally { session.controlling = false; resumeEar(session); }
    }
    if (req.method === 'POST' && match[2] === 'audio') {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) throw fault(415, 'pcm-required');
      if (!['armed', 'capturing'].includes(session.mode)) throw fault(409, 'capture-inactive');
      const seq = url.searchParams.get('seq');
      if (!/^\d+$/.test(seq || '') || !Number.isSafeInteger(Number(seq)) || Number(seq) !== session.seq || session.uploading) throw fault(409, 'audio-sequence');
      const generation = session.generation; session.uploading = true;
      try {
        const audio = await readBody(req, limits.audioBytes);
        if (session.closed || generation !== session.generation || !['armed', 'capturing'].includes(session.mode)) throw fault(409, 'capture-inactive');
        if (!audio.length || audio.length % 2) throw fault(400, 'invalid-pcm');
        if (session.bytes + audio.length > limits.sessionBytes ||
          (session.mode === 'capturing' && session.utteranceBytes + audio.length > limits.utteranceBytes)) {
          session.generation++; session.mode = 'paused'; await write(session, { type: 'cancel' }); throw fault(413, 'audio-limit');
        }
        session.bytes += audio.length;
        if (session.mode === 'capturing') session.utteranceBytes += audio.length;
        const turn = session.turn;
        if (turn && turn.generation === session.generation && (turn.chain || (turn.mode === 'stream' && !turn.done))) acceptPcm(session, audio);
        else await write(session, { type: 'audio', pcm: audio.toString('base64') });
        session.seq++; return json(res, 200, { ok: true, seq: session.seq });
      } finally { session.uploading = false; }
    }
    throw fault(405, 'method-not-allowed');
  }
  return {
    handle(req, res) {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
      if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
      activeRoutes++;
      route(req, res, url).catch(error => json(res, error.status || 500, { error: error.code || 'chat-error' }))
        .finally(() => { activeRoutes--; });
      return true;
    },
    upgrade,
    sweep,
    commands,
    // The open listening window, for the button dispatcher: the second press and cancel.
    window() {
      const win = openWindowOf();
      return win && { id: win.id, press: () => win.machine.press(), cancel: () => win.machine.cancel() };
    },
    isIdle() { return sessions.size === 0 && requests.size === 0 && activeRoutes === 0; },
    close() { closed = true; if (ownCommands) commands.close(); clearInterval(timer); for (const session of sessions.values()) dispose(session); for (const request of requests) request.abort(); choicesCore.close(); ownFetch?.close(); },
  };
}

function createChatApi(options = {}) {
  // Explicit environments stay isolated unless the caller names a private file.
  if (options.env !== undefined && options.configPath === undefined) return createFixedChatApi(options);
  const load = () => loadChatEnvironment({ env: options.env, file: options.configPath });
  const stamp = env => JSON.stringify(Object.keys(env).sort().map(key => [key, env[key]]));
  const initial = load();
  // One command stream for the hub's lifetime: a reload replaces the API inside, never the page's stream.
  const limits = { ...DEFAULTS, ...options.limits };
  const commands = options.commands || createCommands({ clock: options.clock, pingMs: limits.commandPingMs, nonceMs: limits.commandNonceMs });
  options = { ...options, commands };
  let fingerprint = stamp(initial), inner = createFixedChatApi(options, initial), closed = false;
  return {
    handle(req, res) {
      let boundary = false;
      try {
        const url = new URL(req.url, 'http://localhost');
        boundary = req.method === 'GET' && url.pathname === PREFIX + '/config' ||
          req.method === 'POST' && url.pathname === PREFIX + '/sessions';
      } catch { /* The inner router handles malformed URLs. */ }
      if (!closed && boundary && inner.isIdle() && ownRequest(req)) {
        const next = load(), nextFingerprint = stamp(next);
        if (nextFingerprint !== fingerprint) {
          const replacement = createFixedChatApi(options, next);
          inner.close(); inner = replacement; fingerprint = nextFingerprint;
        }
      }
      return inner.handle(req, res);
    },
    upgrade(req, socket, head) { return inner.upgrade(req, socket, head); },
    sweep() { inner.sweep(); },
    commands,
    window() { return inner.window(); },
    close() { closed = true; inner.close(); commands.close(); },
  };
}
module.exports = { createChatApi, createCommands, loadChatEnvironment, ownRequest, turnByteLimit, DEFAULTS, localChoices, alternativesOf, openShape };
