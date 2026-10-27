// Profile-local Chat preferences, explicit stories and content-free durations.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ownRequest } = require('./chat-api.js');
const ROUTE = '/chat/api/state';
const MAX_BYTES = 65536;
const queues = new Map();
const KINDS = new Set(['hold', 'typed', 'fixed', 'reply']);
const STATUSES = new Set(['open', 'completed', 'cancelled', 'failed']);
const REASONS = new Set(['cancel', 'short', 'closed', 'interrupted', 'superseded', 'reload', 'timeout', 'capture', 'recognition', 'choices', 'speech', 'connection', 'other']);
const DURATIONS = new Set(['holdMs', 'releaseToDrainedMs', 'drainToFinishSentMs', 'finishRoundTripMs',
  'finishToTranscriptMs', 'releaseToTranscriptMs', 'transcriptToChoicesMs', 'choicesToRevealMs',
  'revealToSelectMs', 'selectionToPlaybackMs', 'playbackMs', 'releaseToPlaybackMs', 'workerActivityMs',
  'workerCloudMs', 'workerFinalMs', 'audioMs', 'choicesServerMs', 'totalMs']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const fault = (status, code, extra) => Object.assign(new Error(code), { status, code, ...extra });
const invalid = () => { throw fault(400, 'invalid_state'); };
const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const defaults = () => ({ voicePreference: 'saved', stories: [], timings: [] });

function cleanPatch(value, complete = false) {
  if (!keys(value, ['voicePreference', 'stories', 'timings']) || !Object.keys(value).length) invalid();
  if (complete && !['voicePreference', 'stories', 'timings'].every(key => Object.hasOwn(value, key))) invalid();
  const result = {};
  if (Object.hasOwn(value, 'voicePreference')) {
    if (!['saved', 'local'].includes(value.voicePreference)) invalid();
    result.voicePreference = value.voicePreference;
  }
  if (Object.hasOwn(value, 'stories')) {
    if (!Array.isArray(value.stories) || value.stories.length > 4) invalid();
    result.stories = value.stories.map(story => {
      if (!keys(story, ['label', 'say']) || typeof story.label !== 'string' || story.label.length > 55 ||
          typeof story.say !== 'string' || story.say.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(story.label + story.say)) invalid();
      return { label: story.label, say: story.say };
    });
  }
  if (Object.hasOwn(value, 'timings')) {
    if (!Array.isArray(value.timings) || value.timings.length > 40) invalid();
    result.timings = value.timings.map(row => {
      if (!keys(row, ['kind', 'status', 'reason', 'timings']) || !KINDS.has(row.kind) || !STATUSES.has(row.status) || !object(row.timings)) invalid();
      const failed = row.status === 'cancelled' || row.status === 'failed';
      if (failed ? !REASONS.has(row.reason) : Object.hasOwn(row, 'reason')) invalid();
      const timings = {};
      for (const [key, number] of Object.entries(row.timings)) {
        if (!DURATIONS.has(key) || !Number.isFinite(number) || number < 0 || number > 3600000) invalid();
        timings[key] = number;
      }
      return { kind: row.kind, status: row.status, ...(failed ? { reason: row.reason } : {}), timings };
    });
  }
  return result;
}
function cleanUpdate(value) {
  if (!keys(value, ['version', 'expectedRevision', 'patch']) || value.version !== 1 || !revision(value.expectedRevision)) invalid();
  return { expectedRevision: value.expectedRevision, patch: cleanPatch(value.patch) };
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, 'json_required');
  if (Number(req.headers['content-length']) > MAX_BYTES) { req.resume(); throw fault(413, 'body_too_large'); }
  const bytes = await new Promise((resolve, reject) => {
    let chunks = [], size = 0, ended = false;
    const fail = error => { if (!ended) { ended = true; chunks = []; reject(error); } };
    req.on('data', chunk => {
      if (ended) return;
      size += chunk.length;
      if (size > MAX_BYTES) { fail(fault(413, 'body_too_large')); req.resume(); }
      else chunks.push(chunk);
    });
    req.on('end', () => { if (!ended) { ended = true; resolve(Buffer.concat(chunks)); } });
    req.on('aborted', () => fail(fault(400, 'request_aborted')));
    req.on('error', () => fail(fault(400, 'request_aborted')));
  });
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw fault(400, 'invalid_json'); }
}

function createChatStore(options = {}) {
  const io = options.io || fs;
  const directory = typeof options.dataDir === 'string' && options.dataDir ? path.resolve(options.dataDir) : null;
  const file = directory && path.join(directory, 'chat-state.json');
  const available = () => { if (!file) throw fault(503, 'state_unavailable'); };
  // One queue per fixed path also protects callers that recreate a store in this process.
  function serialized(work) {
    try { available(); } catch (error) { return Promise.reject(error); }
    const previous = queues.get(file) || Promise.resolve();
    const job = previous.catch(() => {}).then(work);
    const tail = job.catch(() => {});
    queues.set(file, tail);
    tail.finally(() => { if (queues.get(file) === tail) queues.delete(file); });
    return job;
  }
  async function read() {
    let bytes;
    try {
      const stat = await io.lstat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw fault(503, 'state_corrupt');
      bytes = await io.readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, exists: false, value: defaults() };
      if (error.code === 'state_corrupt') throw error;
      throw fault(503, 'state_read_failed');
    }
    try {
      if (bytes.length > MAX_BYTES) throw new Error();
      const value = JSON.parse(bytes.toString('utf8'));
      if (!keys(value, ['version', 'revision', 'value']) || value.version !== 1 || !revision(value.revision)) throw new Error();
      return { version: 1, revision: value.revision, exists: true, value: cleanPatch(value.value, true) };
    } catch { throw fault(503, 'state_corrupt'); }
  }
  const get = () => serialized(read);
  function put(value) {
    let update;
    try { update = cleanUpdate(value); } catch (error) { return Promise.reject(error); }
    return serialized(async () => {
      const current = await read();
      if (current.revision !== update.expectedRevision) throw fault(409, 'revision_conflict', { state: current });
      if (!revision(current.revision + 1)) throw fault(503, 'state_write_failed');
      const next = { version: 1, revision: current.revision + 1, value: { ...current.value, ...update.patch } };
      const bytes = JSON.stringify(next);
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw fault(413, 'body_too_large');
      const temporary = path.join(directory, '.chat-state-' + randomUUID() + '.tmp');
      let descriptor;
      try {
        await io.mkdir(directory, { recursive: true });
        descriptor = await io.open(temporary, 'wx', 0o600);
        await descriptor.writeFile(bytes, 'utf8');
        await descriptor.sync();
        await descriptor.close(); descriptor = null;
        await io.rename(temporary, file);
      } catch {
        throw fault(503, 'state_write_failed');
      } finally {
        if (descriptor) try { await descriptor.close(); } catch {}
        try { await io.unlink(temporary); } catch {}
      }
      return { ...next, exists: true };
    });
  }
  function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (url.pathname !== ROUTE) return false;
    if (!ownRequest(req)) { json(res, 403, { error: 'forbidden' }); return true; }
    if (url.search) { json(res, 400, { error: 'invalid_state' }); return true; }
    if (!['GET', 'PUT'].includes(req.method)) { json(res, 405, { error: 'method_not_allowed' }); return true; }
    Promise.resolve().then(async () => {
      available();
      return req.method === 'GET' ? get() : put(await body(req));
    }).then(value => json(res, 200, value), error => {
      const known = ['state_unavailable', 'state_corrupt', 'state_read_failed', 'state_write_failed', 'revision_conflict',
        'invalid_state', 'body_too_large', 'request_aborted', 'json_required', 'invalid_json'].includes(error.code);
      json(res, known ? error.status : 503, { error: known ? error.code : 'state_unavailable',
        ...(error.code === 'revision_conflict' ? { state: error.state } : {}) });
    });
    return true;
  }
  return { get, put, handle };
}
module.exports = { createChatStore };
