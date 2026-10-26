// Bounded local timing records. Conversation content never enters this module.
const KEY = 'chat:timings:v1';
const KINDS = ['hold', 'typed', 'fixed', 'reply'];
const STATUSES = ['open', 'completed', 'cancelled', 'failed'];
const REASONS = ['cancel', 'closed', 'interrupted', 'superseded', 'reload', 'timeout', 'capture', 'recognition', 'choices', 'speech', 'connection', 'other'];
const PAIRS = {
  holdMs: ['begin', 'release'], releaseToDrainedMs: ['release', 'drained'], drainToFinishSentMs: ['drained', 'finishSent'],
  finishRoundTripMs: ['finishSent', 'finishAck'], finishToTranscriptMs: ['finishSent', 'transcript'], releaseToTranscriptMs: ['release', 'transcript'],
  transcriptToChoicesMs: ['transcript', 'choicesReady'], choicesToRevealMs: ['choicesReady', 'revealed'], revealToSelectMs: ['revealed', 'selected'],
  selectionToPlaybackMs: ['selected', 'playbackStart'], playbackMs: ['playbackStart', 'playbackEnd'], releaseToPlaybackMs: ['release', 'playbackStart'],
};
const OBSERVED = { activityMs: 'workerActivityMs', cloudMs: 'workerCloudMs', finalDecodeMs: 'workerFinalMs', audioMs: 'audioMs', choicesServerMs: 'choicesServerMs' };
const DURATION_KEYS = new Set([...Object.keys(PAIRS), ...Object.values(OBSERVED), 'totalMs']);
const STAGES = new Set(Object.values(PAIRS).flat().filter(name => name !== 'begin'));
const valid = number => Number.isFinite(number) && number >= 0 && number <= 3600000;
const rounded = number => Math.round(number * 10) / 10;
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return rounded(sorted[low] + (sorted[high] - sorted[low]) * (position - low));
}
function cleanRow(value) {
  if (!value || !KINDS.includes(value.kind) || !STATUSES.includes(value.status)) return null;
  const row = { kind: value.kind, status: value.status, timings: {} };
  if (value.status === 'open') { row.status = 'cancelled'; row.reason = 'reload'; }
  else if (value.status === 'cancelled' || value.status === 'failed') row.reason = REASONS.includes(value.reason) ? value.reason : 'other';
  for (const [name, number] of Object.entries(value.timings || {})) if (DURATION_KEYS.has(name) && valid(number)) row.timings[name] = rounded(number);
  return row;
}
export function createTurnMetrics(options = {}) {
  const now = options.now || (() => performance.now());
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 40)));
  let storage;
  try { storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch { /* Private browsing may block storage. */ }
  let rows = [];
  const active = new Map(), listeners = new Set();
  try {
    const text = storage?.getItem(KEY);
    if (text && text.length <= 65536) rows = (JSON.parse(text).turns || []).map(cleanRow).filter(Boolean).slice(-limit);
  } catch { /* Malformed or inaccessible data never prevents communication. */ }
  function snapshot() {
    const turns = rows.map(row => ({ kind: row.kind, status: row.status, ...(row.reason ? { reason: row.reason } : {}), timings: { ...row.timings } }));
    const counts = Object.fromEntries(STATUSES.map(status => [status, turns.filter(row => row.status === status).length]));
    const groups = {};
    for (const kind of KINDS) {
      const completed = turns.filter(row => row.kind === kind && row.status === 'completed');
      const group = {};
      for (const key of DURATION_KEYS) {
        const values = completed.map(row => row.timings[key]).filter(valid);
        if (values.length) group[key] = { samples: values.length, medianMs: values.length >= 3 ? quantile(values, .5) : null, p95Ms: values.length >= 20 ? quantile(values, .95) : null };
      }
      if (Object.keys(group).length) groups[kind] = group;
    }
    return { version: 1, retention: limit, turns, summary: { counts, groups, medianMinimumSamples: 3, p95MinimumSamples: 20 } };
  }
  function changed(save = true) {
    const value = snapshot();
    if (save) try { storage?.setItem(KEY, JSON.stringify(value)); } catch { /* Memory records still work. */ }
    for (const listener of listeners) try { listener(value); } catch { /* Diagnostics must not interrupt a turn. */ }
  }
  function derive(record) {
    for (const [key, [from, to]] of Object.entries(PAIRS)) {
      if (key === 'holdMs' && record.row.kind !== 'hold') continue;
      const start = record.marks.get(from), end = record.marks.get(to);
      if (start !== undefined && end !== undefined && valid(end - start)) record.row.timings[key] = rounded(end - start);
    }
  }
  return {
    begin(kind) {
      if (!KINDS.includes(kind)) return null;
      const handle = {}, row = { kind, status: 'open', timings: {} };
      const record = { row, marks: new Map([['begin', now()]]) };
      rows.push(row); active.set(handle, record);
      while (rows.length > limit) {
        const removed = rows.shift();
        for (const [key, value] of active) if (value.row === removed) active.delete(key);
      }
      changed(); return handle;
    },
    isActive(handle) { return active.has(handle); },
    mark(handle, stage) {
      const record = active.get(handle);
      if (!record || !STAGES.has(stage) || record.marks.has(stage)) return;
      const at = now(); if (!valid(at - record.marks.get('begin'))) return;
      record.marks.set(stage, at); derive(record); changed();
    },
    observe(handle, timings) {
      const record = active.get(handle); if (!record || !timings || typeof timings !== 'object') return;
      for (const [key, target] of Object.entries(OBSERVED)) if (valid(timings[key])) record.row.timings[target] = rounded(timings[key]);
      changed();
    },
    end(handle, status, reason) {
      const record = active.get(handle);
      if (!record || !['completed', 'cancelled', 'failed'].includes(status)) return;
      record.row.status = status;
      if (status !== 'completed') record.row.reason = REASONS.includes(reason) ? reason : 'other';
      const elapsed = now() - record.marks.get('begin'); if (valid(elapsed)) record.row.timings.totalMs = rounded(elapsed);
      active.delete(handle); changed();
    },
    snapshot,
    exportJSON() { return JSON.stringify(snapshot()); },
    subscribe(listener) { listeners.add(listener); try { listener(snapshot()); } catch {} return () => listeners.delete(listener); },
    clear() { rows = []; active.clear(); try { storage?.removeItem(KEY); } catch {} changed(false); },
  };
}
