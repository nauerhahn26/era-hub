import { createChatController, isPartnerTouch } from './controller.js';
import { createMicrophone } from './capture.js';
import { createChatVoice } from './voice.js';
import { createTurnMetrics } from './metrics.js';
import { createChatStorage } from './storage.js';
import { attachSymbol, resolveSymbol, loadVocabulary, hasVocabulary, planPictures, attachPicture } from './symbols.js';
import { fitTile } from './tile-fit.js';
import { createTurnLog, observeMetrics, stageChoices } from './turnlog.js';
import { mountDoorBar } from '/lib/doorbar.js';
import { connectCommands } from './commands.js';
import { createTones } from './tones.js';

const $ = id => document.getElementById(id);
const API = '/chat/api';
const appLocked = () => window.AppLock?.isLocked() || false;
const persistence = createChatStorage();
let appReady = false, pageOnlyVoice = false, voicePreferenceIntent = 0;
document.body.dataset.storageReady = 'false';
for (const id of ['startChat', 'desktopStart', 'desktopAsk', 'typedAsk', 'voicePreference', 'saveStory', 'clearStories', 'clearTimings']) $(id).disabled = true;
const storageStatus = document.createElement('p'); storageStatus.id = 'storageStatus'; storageStatus.setAttribute('role', 'status');
$('engineNote').insertAdjacentElement('afterend', storageStatus);
persistence.subscribe(state => {
  document.body.dataset.storageAvailable = String(state.available);
  storageStatus.textContent = state.state === 'conflict' ? 'Saved Chat settings changed in another window. Reload Chat before saving.'
    : state.state === 'unsaved' ? 'Chat is using unsaved changes. They have not been saved on this computer. Try again or reload Chat.'
      : state.state === 'saving' ? 'Saving Chat changes…' : state.state === 'loading' ? 'Loading saved Chat settings…' : 'Chat settings are up to date on this computer.';
  if (pageOnlyVoice) storageStatus.textContent += ' The current voice choice applies to this page only; it has not been saved.';
});
const bar = mountDoorBar($('app'), {
  onLock: () => { if (appReady) void shutdown('close'); },
  onLeave: () => { if (appReady) void shutdown('close'); return persistence.flush({ keepalive: true, timeoutMs: 850 }); },
  onPause: () => { if (appReady) void shutdown('pause'); },
  onResume: () => { if (appReady) notice('Chat is off. A partner can start a new session.'); },
});
const savedSettings = await persistence.hydrate();
// Library pictures (spec 2026-10-27 §6); without the table the drawn pictures stay.
// ?pictures=bw|emoji shows the black-and-white or emoji style for comparison.
await loadVocabulary();
const pictureVariant = ['bw', 'emoji'].find(name => name === new URLSearchParams(location.search).get('pictures')) || 'color';
// Test mode (spec 2026-10-27 §5): a separate record per turn while this
// device's switch is on. The production rows below are written exactly as
// before and stay content-free in both modes.
let testMode = false, stagedMeta = null;
const turnLog = createTurnLog({ enabled: () => testMode,
  health: () => fetch(`${API}/health`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
  onPosted: () => { if (testMode) refreshTestSummary(); } });
const voice = createChatVoice({ storage: persistence.voiceStorage,
  // Characters are charged to the turn whose choices or spoken words they are; warming the fixed phrases is no turn's.
  onFetch: (chars, words) => { turnLog.fetched(speechMetric, chars, words) || turnLog.fetched(questionMetric, chars, words); } });
const metrics = observeMetrics(createTurnMetrics({ storage: persistence.metricsStorage, limit: 40 }), turnLog);
if (JSON.stringify(metrics.snapshot().turns) !== JSON.stringify(savedSettings.timings)) persistence.stageTimings(metrics.snapshot().turns);
const AUDIO_POST_MS = 2000;
let questionMetric = null, speechMetric = null, pendingSpeechMetric = null, pressMetric = null;
let screen = 'chat', config = null, session = null, events = null, mic = null;
let lifecycle = 0, sequence = 0, workerGeneration = -1, uploadEpoch = 0;
let mode = 'blocked', starting = false, closing = false, holding = false, askTimer = null, finishedTurn = -1;
let uploadChain = Promise.resolve(), queued = 0, sessionAbort = null, readyTimer = null;
let askPending = false, askAcknowledged = Promise.resolve(), captureGeneration = null;
let gridKey = '', currentSpeech = 0, captureIntent = 0, pendingFrames = [], heartbeat = null;
let recentConversation = [];
let remoteFinal = false, remoteStreaming = false, questionSending = false;
// The held question's audio travels on one WebSocket per session when the hub
// offers it (spec 2026-10-27 §3.1); per-frame POSTs remain for an older hub.
let audioSocket = null, socketSeq = 0;
// Streaming sessions (spec §3.3): the hub prepares a held question's replies
// itself and stages them over the event stream; the page reveals only the
// sealed batch. `staging` is the current held turn's batch in the making.
let stagedChoices = false, staging = null;
const STAGING_MS = 20000;
const SOCKET_BUFFER_LIMIT = 256000;
let stories = savedSettings.stories;
// A button-press listening window (design 2026-10-27 §4.3-§4.4): `press` is the
// window this page opened, from the control reply until it closes. The hub's
// window machine decides when it ends; the page listens, shows, and plays the tones.
let press = null, pressBusy = false, pickSent = Promise.resolve();
const tones = createTones();
const FRAMES_AFTER_TONE_MS = 200;

const fixed = {
  chat: ["Hi!", "What's up?", 'How are you?', 'Come sit with me.'],
  reactions: ["That's funny!", 'I love that!', 'No way!', "That's not fair!"],
  repair: ['Give me more time.', "That's not what I meant.", 'Ask me yes or no.', 'Let me try again.'],
};

function warmPhrases() {
  voice.prefetch([...Object.values(fixed).flat(), 'Yes.', 'No.', 'Tell me more.', ...stories.map(story => story.say), ...controller.state.choices.map(choice => choice.say)].map(say => ({ say })));
}
function timingEvent(name) {
  if (name === 'choicesReady' || name === 'revealed') {
    metrics.mark(questionMetric, name);
    if (name === 'revealed') turnLog.sample(questionMetric, 'reveal'); // never awaited: the reveal is not delayed
  }
  else if (name === 'selected') {
    pendingSpeechMetric = metrics.isActive(questionMetric) && speechMetric !== questionMetric ? questionMetric : metrics.begin('reply');
    metrics.mark(pendingSpeechMetric, 'selected');
  } else if (name === 'speechRequested') {
    if (!pendingSpeechMetric && metrics.isActive(questionMetric) && controller.state.phase === 'Your turn') pendingSpeechMetric = questionMetric;
    speechMetric = pendingSpeechMetric || metrics.begin('fixed'); pendingSpeechMetric = null;
    metrics.mark(speechMetric, 'selected');
  }
}
function waitForAudioDrain(pending, timeoutMs = 4000) {
  let timer;
  return Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The audio connection did not finish. Start Chat again.')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function json(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || 'The speech service is unavailable.');
  return body;
}
const notice = text => { $('notice').textContent = text || ''; };
function paintPhase(state = controller.state) {
  if (press && !press.closed) { $('phase').textContent = press.listening ? 'Listening' : 'Starting to listen'; return; }
  $('phase').textContent = state.staged && state.phase === 'Preparing' ? 'Replies ready'
    : state.phase === 'Capturing question' && ((remoteStreaming && mode !== 'opening') || questionSending) ? 'Sending question' : state.phase;
}
function setMode(value) {
  mode = value; document.body.dataset.listening = 'false';
  document.body.dataset.capturing = String(['opening', 'capture'].includes(value));
  paintPhase();
}
async function control(type, extra = {}) {
  if (!session) return null;
  const mine = lifecycle, id = session;
  const reply = await json(`${API}/sessions/${encodeURIComponent(id)}/control`, { method: 'POST', body: JSON.stringify({ type, ...extra }), signal: AbortSignal.any([sessionAbort.signal, AbortSignal.timeout(2000)]) });
  if (mine !== lifecycle || id !== session) return null;
  if (Number.isFinite(reply.generation)) workerGeneration = Math.max(workerGeneration, reply.generation);
  return reply;
}
function diagnostic(text) { $('diagnostics').textContent = text; }

const controller = createChatController({
  onTiming: timingEvent,
  requestChoices: async ({ text, signal }) => {
    const timing = questionMetric;
    const context = recentConversation.slice(-8);
    recentConversation = [...recentConversation, `Partner: ${text}`.slice(0, 500)].slice(-8);
    let result;
    const held = staging && !staging.claimed && staging.text === text ? staging : null;
    if (held) held.claimed = true;
    try { result = held ? await stagedBatch(held, signal) : await json(`${API}/choices`, { method: 'POST', body: JSON.stringify({ text, context }), signal }); }
    catch (error) { turnLog.error(timing, error.message); throw error; }
    metrics.observe(timing, { choicesServerMs: result.timings?.totalMs });
    stagedMeta = { handle: timing, kind: result.kind, usage: result.usage };
    return result;
  },
  onChoicesError: () => { metrics.end(questionMetric, 'failed', 'choices'); return shutdown('cancel', true); },
  stopSpeech: () => { currentSpeech++; metrics.end(speechMetric, 'cancelled', 'interrupted'); speechMetric = null; voice.stop(); },
  prefetch: choices => {
    voice.prefetch(choices);
    // Test mode only, after the real work, and never able to throw into prepare().
    if (stagedMeta?.handle === questionMetric) stageChoices(turnLog, questionMetric, choices, stagedMeta,
      choice => choice.symbol || resolveSymbol({ label: choice.label, type: 'response', say: choice.say }));
  },
  // The reveal redraw settles for the contract's 250 ms (spec §4).
  beforeChoices: () => { revealRender = true; window.Dwell?.suppress(REVEAL_SETTLE_MS); },
  async speak(choice, { signal }) {
    if (appLocked()) return;
    const mine = lifecycle, spoken = ++currentSpeech;
    const timing = speechMetric;
    if (holding || askPending) metrics.end(questionMetric, 'cancelled', 'interrupted');
    captureIntent++; holding = false; askPending = false; pendingFrames = []; captureGeneration = null;
    clearTimeout(askTimer); $('ask').classList.remove('held'); mic?.cancel();
    setMode('blocked'); uploadEpoch++;
    const canceled = session ? control('cancel').catch(() => null) : Promise.resolve();
    if (signal.aborted || spoken !== currentSpeech) return;
    let completed;
    turnLog.content(timing, { spoken: choice.say });
    try {
      completed = await voice.say(choice.say, { signal, onClip: value => turnLog.usage(timing, { voice: value }),
        onStart: () => { if (!signal.aborted && spoken === currentSpeech && mine === lifecycle) metrics.mark(timing, 'playbackStart'); },
        onEnd: () => { if (!signal.aborted && spoken === currentSpeech && mine === lifecycle) metrics.mark(timing, 'playbackEnd'); },
      });
    } catch (error) { metrics.end(timing, 'failed', 'speech'); void persistence.flush(); throw error; }
    if (completed === true && !signal.aborted && spoken === currentSpeech && mine === lifecycle) {
      metrics.end(timing, 'completed');
      recentConversation = [...recentConversation, `Me: ${choice.say}`.slice(0, 500)].slice(-8);
    } else metrics.end(timing, 'cancelled', 'interrupted');
    void persistence.flush();
    await canceled;
  },
});

fetch('/settings').then(r => r.json()).then(s => {
  testMode = s.chatTestMode === true; paintTestMode();
  const dwell = Math.max(600, Math.min(3000, Number(s.dwellMs) || 1200));
  window.Dwell?.set({ ms: dwell }); bar.setDwell(dwell); bar.setPause(s.pauseGoes === 'tdsnap');
}).catch(() => {});

const REVEAL_SETTLE_MS = 250;
let revealRender = false;
const pictureOf = new WeakMap();
function tile(label, type, action, position, say, pick = {}) {
  const el = document.createElement(action ? 'button' : 'div');
  el.className = `tile ${type}${action ? ' dwell' : ''}`;
  el.style.gridColumn = String(position[0] + 1); el.style.gridRow = String(position[1] + 1);
  if (action) { el.type = 'button'; el.addEventListener('click', action); }
  const text = document.createElement('span'); text.className = 'label'; text.textContent = label;
  el.appendChild(text);
  if (hasVocabulary()) pictureOf.set(el, { label, type, say, symbol: pick.symbol, symbolId: pick.symbolId });
  else attachSymbol(el, { label, type, say });
  return el;
}
// Pictures are planned for the whole page at once so no two tiles share one.
function paintPictures(grid) {
  if (!hasVocabulary()) return;
  const tiles = [...grid.children];
  const plan = planPictures(tiles.map(el => pictureOf.get(el) || { type: 'rest' }), { variant: pictureVariant });
  tiles.forEach((el, i) => attachPicture(el, plan[i], fitTile));
}
function go(next) { screen = next; gridKey = ''; renderGrid(controller.state); }
function fitLabels() {
  for (const el of $('grid').querySelectorAll('.tile:not(.rest)')) fitTile(el);
}
function renderGrid(state) {
  const key = `${screen}|${state.turn}|${state.choices.map(c => c.id).join(',')}|${state.phase === 'Capturing question' || state.phase === 'Preparing'}|${stories.length}`;
  if (key === gridKey) return;
  gridKey = key;
  window.Dwell?.suppress(revealRender ? REVEAL_SETTLE_MS : 600); revealRender = false;
  const grid = $('grid'); grid.replaceChildren();
  grid.append(tile('yes', 'yes', () => controller.sayFixed('Yes.'), [0, 0]), tile('no', 'no', () => controller.sayFixed('No.'), [3, 0]));
  grid.append(tile('', 'rest', null, [1, 1]), tile('', 'rest', null, [2, 1]));
  const positions = [[1, 0], [2, 0], [0, 1], [3, 1]];
  let words;
  if (screen === 'news') words = stories;
  else if (screen !== 'chat') words = (fixed[screen] || []).map(say => ({ label: say, say }));
  else if (state.choices.length) words = state.choices;
  else if (['Capturing question', 'Preparing'].includes(state.phase)) words = [];
  else words = fixed.chat.map(say => ({ label: say, say }));
  for (let i = 0; i < 4; i++) {
    const item = words[i];
    if (item) {
      const selectedTurn = state.turn;
      const el = tile(item.label, screen === 'chat' && state.choices.length ? 'response' : 'static', () => {
        if (item.id) { turnLog.content(questionMetric, { selected: item }); controller.select(item.id, selectedTurn); } else controller.sayFixed(item.say);
      }, positions[i], item.say, item);
      if (item.id) el.dataset.choiceId = item.id;
      grid.append(el);
    } else grid.append(tile(screen === 'news' && i === 0 ? 'Your stories go here' : '', screen === 'news' ? 'emptyStory' : 'waiting', null, positions[i]));
  }
  const bottom = screen === 'chat'
    ? [['Tell me more', () => controller.sayFixed('Tell me more.')], ['Reactions', () => go('reactions')], ['My news', () => go('news')], ['Help me say it', () => go('repair')]]
    : [['Tell me more', () => controller.sayFixed('Tell me more.')], ['Reactions', () => go('reactions')], ['My news', () => go('news')], ['Back to Chat', () => go('chat')]];
  bottom.forEach(([label, action], i) => grid.append(tile(label, i === 0 ? 'static' : 'route', action, [i, 2])));
  paintPictures(grid);
  requestAnimationFrame(fitLabels);
}
controller.subscribe(state => {
  document.body.dataset.phase = state.phase;
  paintPhase(state);
  document.body.dataset.ready = String(state.engineReady && ['Ready to ask', 'Your turn'].includes(state.phase));
  if (state.error) notice(state.error);
  else if (state.staged) notice('Replies ready. Look at the black space.');
  else if (state.phase === 'Capturing question') notice('Keep holding while you speak. Release to finish.');
  else if (state.phase === 'Ready to ask') notice('Hold to ask. Voice activation is off.');
  else if (state.phase === 'Your turn') notice('');
  renderGrid(state);
});

// The reveal gate (spec 2026-10-27 §4, dad's decision): a staged batch is
// revealed by a gaze in the black centre. A gaze already resting there when
// the batch seals counts as the neutral boundary; a gaze on any tile cell must
// still move into the centre. A batch never lands under a dwelling gaze.
let pointerAt = null;
const restingInCentre = () => {
  if (!pointerAt) return false;
  const el = document.elementFromPoint(pointerAt.x, pointerAt.y);
  return !!el?.closest?.('#grid .rest');
};
document.addEventListener('pointermove', e => {
  // The partner's finger is not her gaze: only gaze and mouse pointers rest.
  if (e.pointerType !== 'touch') pointerAt = { x: e.clientX, y: e.clientY };
  if (screen !== 'chat' || !controller.state.staged) return;
  if (e.target.closest?.('.rest')) controller.neutral();
}, { passive: true });
document.documentElement.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') pointerAt = null; });
let wasStaged = false;
controller.subscribe(state => {
  const sealed = state.staged && !wasStaged; wasStaged = state.staged;
  if (sealed) queueMicrotask(() => { if (screen === 'chat' && controller.state.staged && restingInCentre()) controller.neutral(); });
});

function sendFrame(bytes) {
  if (!session) return;
  turnLog.audio(questionMetric, bytes);
  if (mode === 'opening') {
    if (pendingFrames.length >= 20) { failSession('Capture did not become ready. Release and start Chat again.'); return; }
    pendingFrames.push(bytes); return;
  }
  if (mode === 'capture' || mode === 'draining') queueFrame(bytes);
}
function queueFrame(bytes) {
  if (audioSocket) { socketFrame(bytes); return; }
  const mine = lifecycle, epoch = uploadEpoch, id = session;
  if (++queued > 20) { queued--; failSession('Question capture could not keep up. Start again when ready.'); return; }
  uploadChain = uploadChain.then(async () => {
    if (mine !== lifecycle || epoch !== uploadEpoch || mode === 'blocked') return;
    const r = await fetch(`${API}/sessions/${encodeURIComponent(id)}/audio?seq=${sequence}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      signal: AbortSignal.any([sessionAbort.signal, AbortSignal.timeout(AUDIO_POST_MS)]),
    });
    if (r.ok && mine === lifecycle) sequence++;
    if (mine !== lifecycle || epoch !== uploadEpoch) return;
    if (r.status === 409) {
      const error = await r.json().catch(() => ({}));
      if (error.error === 'capture-inactive') throw new Error('Question capture stopped. Release and start Chat again.');
      throw new Error('Audio sequence changed. Start a new listening session.');
    }
    if (!r.ok) throw new Error('The audio connection stopped.');
  }).catch(e => { if (mine === lifecycle && e.name !== 'AbortError') failSession(e.name === 'TimeoutError' ? 'The audio connection took too long. Start Chat again.' : e.message, e.name === 'TimeoutError' ? 'timeout' : 'connection'); })
    .finally(() => { if (mine === lifecycle) queued--; });
}
// One frame: an 8-byte header {generation, seq} (little endian) and the PCM16.
function socketFrame(bytes) {
  if (mode === 'blocked' || !Number.isFinite(captureGeneration)) return;
  if (audioSocket.readyState !== WebSocket.OPEN) { failSession('The audio connection stopped. Start Chat again.'); return; }
  if (audioSocket.bufferedAmount > SOCKET_BUFFER_LIMIT) { failSession('Question capture could not keep up. Start again when ready.'); return; }
  const frame = new Uint8Array(8 + bytes.byteLength), header = new DataView(frame.buffer);
  header.setUint32(0, captureGeneration, true); header.setUint32(4, socketSeq++, true);
  frame.set(new Uint8Array(bytes), 8);
  audioSocket.send(frame.buffer);
}
// Settles once: true when the socket is open, false when the hub refused it or
// it did not open in time (the POST path is used for this session instead).
function openAudioSocket(id) {
  const mine = lifecycle;
  return new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/sessions/${encodeURIComponent(id)}/audio`); }
    catch { resolve(false); return; }
    ws.binaryType = 'arraybuffer';
    let opened = false;
    const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} resolve(false); } }, 2000);
    ws.onopen = () => {
      clearTimeout(timer);
      if (mine !== lifecycle || id !== session) { try { ws.close(1000); } catch {} resolve(false); return; }
      opened = true; audioSocket = ws; socketSeq = 0; resolve(true);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(timer);
      if (!opened) { resolve(false); return; }
      if (audioSocket === ws) { audioSocket = null; if (mine === lifecycle && session) failSession('The audio connection closed. Your phrases still work; start Chat again.'); }
    };
  });
}
function closeAudioSocket() {
  const ws = audioSocket; audioSocket = null; socketSeq = 0;
  if (ws) { ws.onclose = null; try { ws.close(1000, 'closed'); } catch {} }
}
function startHeartbeat() {
  clearTimeout(heartbeat);
  const mine = lifecycle, id = session;
  async function tick() {
    if (mine !== lifecycle || id !== session || document.visibilityState !== 'visible') return;
    try {
      await json(`${API}/sessions/${encodeURIComponent(id)}`, { signal: AbortSignal.any([sessionAbort.signal, AbortSignal.timeout(2000)]) });
      if (mine === lifecycle && id === session) heartbeat = setTimeout(tick, 30000);
    } catch (e) {
      if (mine === lifecycle && id === session) failSession('This Chat session ended. Your phrases still work; start Chat again when ready.');
    }
  }
  heartbeat = setTimeout(tick, 30000);
}
// The sealed batch of a held turn, as the hub sealed it; staged choices before
// it only warm their voice clips. Cancelled with the turn.
function stagedBatch(record, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(new Error('Replies took too long. Your phrases still work.')), STAGING_MS);
    const settle = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (record.settled) return; record.settled = true; error ? reject(error) : resolve(record.sealed); };
    const abort = () => settle(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    signal?.addEventListener('abort', abort, { once: true });
    record.done = settle;
    if (record.sealed || record.error) settle(record.error);
  });
}
function stagingEvent(data) {
  const record = staging;
  if (!record || data.generation !== record.generation || record.sealed || record.error) return;
  if (data.type === 'choice-staged') {
    const choice = data.choice;
    if (!choice || typeof choice.say !== 'string' || typeof choice.label !== 'string') return;
    record.choices.push(choice);
    // Invisible: the clip warms now so the voice is ready before she looks.
    voice.prefetch([choice], { urgent: true });
    turnLog.stagedOne(questionMetric, choice);
  } else if (data.type === 'batch-sealed') {
    record.sealed = { kind: data.kind, generated: data.generated, choices: data.choices, usage: data.usage, timings: data.timings };
    record.done?.();
  } else if (data.type === 'choices-error') {
    record.error = new Error('Replies are unavailable. Your phrases still work.');
    record.done?.(record.error);
  }
}
function announceReady() {
  $('engineNote').textContent = 'Voice activation is off. Audio is collected only while you hold Ask. '
    + (remoteStreaming ? 'The held question is sent for live transcription. Release stops collection and finishes the question.'
      : remoteFinal ? 'The held question is captured here, then sent for transcription after release. Audio outside the hold is not sent.'
        : 'Question recognition also stays on this device.');
  controller.ready();
}
function receiveEvent(event) {
  let data; try { data = JSON.parse(event.data); } catch { return; }
  // Voice activation is disabled for the hold-only pilot. An unsolicited wake
  // cannot change capture state OR poison a later turn's generation check.
  if (data.type === 'wake') return;
  if (['choice-staged', 'batch-sealed', 'choices-error'].includes(data.type)) { stagingEvent(data); return; }
  if (['socket', 'settled', 'speculation'].includes(data.type)) {
    if (askPending || captureGeneration === null || data.generation !== captureGeneration) return;
    if (data.type === 'socket') turnLog.mark(questionMetric, 'socketConnect');
    else if (data.type === 'settled') turnLog.mark(questionMetric, 'settled');
    else if (['start', 'keep', 'discard'].includes(data.state)) turnLog.mark(questionMetric, 'speculative' + data.state[0].toUpperCase() + data.state.slice(1));
    return;
  }
  if (['partial', 'final'].includes(data.type) && (askPending || controller.state.phase !== 'Capturing question' || captureGeneration === null)) return;
  if (Number.isFinite(data.generation)) {
    if (data.generation < workerGeneration) return;
    workerGeneration = data.generation;
  }
  if (data.type === 'ready') {
    clearTimeout(readyTimer);
    remoteFinal = data.capabilities?.remoteFinal === true;
    remoteStreaming = data.capabilities?.remoteStreaming === true;
    stagedChoices = data.capabilities?.stagedChoices === true;
    if (data.capabilities?.audioSocket === true && typeof WebSocket === 'function' && !audioSocket) {
      const mine = lifecycle;
      openAudioSocket(session).then(() => { if (mine === lifecycle && session) announceReady(); });
      return;
    }
    announceReady();
  }
  else if (data.type === 'partial') {
    if (askPending || (Number.isFinite(captureGeneration) && data.generation !== captureGeneration)) return;
    controller.partial(data.text); turnLog.partial(questionMetric, data.text);
    diagnostic(`Heard so far: ${String(data.text || '').slice(0, 600)}`);
  } else if (data.type === 'final') {
    if (askPending || controller.state.phase !== 'Capturing question' || (Number.isFinite(captureGeneration) && data.generation !== captureGeneration)) return;
    if (holding || finishedTurn !== controller.state.turn) { failSession('Capture ended before release. Your phrases still work; start Chat again.'); return; }
    clearTimeout(askTimer); holding = false; $('ask').classList.remove('held');
    questionSending = false;
    setMode('blocked'); uploadEpoch++;
    metrics.mark(questionMetric, 'transcript'); metrics.observe(questionMetric, data.timings);
    turnLog.content(questionMetric, { transcript: String(data.text || '') });
    if (['stream', 'one-shot'].includes(data.mode)) turnLog.set(questionMetric, { mode: data.mode, setting: data.setting });
    if (data.usage) turnLog.usage(questionMetric, { stream: data.usage });
    const question = String(data.text || '').trim().slice(0, 600);
    staging = stagedChoices ? { generation: data.generation, text: question, choices: [], sealed: null, error: null, claimed: false, settled: false, done: null } : null;
    diagnostic(`Question: ${String(data.text || '').slice(0, 600)}`);
    controller.prepare(data.text);
  } else if (data.type === 'error') {
    diagnostic(`Listening: ${String(data.message || data.error || 'unavailable').slice(0, 300)}`);
    failSession(data.error === 'no-speech' ? 'No question was heard. Start again, or use a phrase.' : 'Speech recognition stopped. Your phrases still work.', 'recognition');
  }
}

async function startChat() {
    if (appLocked()) return;
  if (starting || closing || session || document.visibilityState !== 'visible') return;
  await openSession();
}
// The session start Start Chat and the partner's button share: microphone,
// session, events, then the hub says when speech is ready. True when a
// session was opened. `denied` is the line shown when the microphone is refused.
async function openSession({ denied = 'Microphone permission was not granted. Your phrases still work.' } = {}) {
  if (!config?.runtime?.available) { controller.fail('Speech is not set up. Prepared phrases and stories still work.'); return false; }
  starting = true; const mine = ++lifecycle; sessionAbort = new AbortController();
  $('startChat').disabled = true; notice('Starting the microphone…');
  try {
    mic = createMicrophone({ onFrame: sendFrame, onError: e => { if (mine === lifecycle) failSession(e.message); } });
    await mic.start(); // Called directly by the explicit partner gesture.
    voice.refresh(); // the hub's voice is read again once per Chat start
    if (mine !== lifecycle) return;
    const reply = await json(`${API}/sessions`, { method: 'POST', body: '{}', signal: sessionAbort.signal });
    if (mine !== lifecycle) { fetch(`${API}/sessions/${encodeURIComponent(reply.id)}`, { method: 'DELETE', keepalive: true }); return; }
    session = reply.id; sequence = 0; workerGeneration = -1; uploadEpoch++; queued = 0; uploadChain = Promise.resolve();
    startHeartbeat();
    events = new EventSource(`${API}/sessions/${encodeURIComponent(session)}/events`);
    events.onmessage = event => { if (mine === lifecycle && session) receiveEvent(event); };
    events.onerror = () => { if (mine === lifecycle) failSession('The speech connection closed. Your phrases still work.'); };
    readyTimer = setTimeout(() => failSession('Speech did not become ready. Your phrases still work.'), 20000);
    $('endChat').disabled = false; notice('Waiting for speech to become ready…');
    return true;
  } catch (e) {
    if (mine === lifecycle) { await shutdown('close'); controller.fail(e.name === 'NotAllowedError' ? denied : e.message); }
    return false;
  } finally {
    if (mine === lifecycle) { starting = false; $('startChat').disabled = !!session; }
  }
}
// ---- the partner's button (design 2026-10-27 §4.3-§4.6) ----
// An `ask` from the hub does what Start Chat and a hold do, with no touch:
// session if needed, a listening window at the hub, the listening tone, then
// frames 200 ms after the tone has ended (the tone is never transcribed).
const STREAMING_LINE = 'Streaming speech is not set up on this device';
const MICROPHONE_LINE = 'Touch Start Chat once to allow the microphone';
const NOTHING_HEARD_LINE = "Didn't hear a question";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function engineReadyWithin(ms) {
  if (controller.state.engineReady) return Promise.resolve(true);
  const mine = lifecycle;
  return new Promise(resolve => {
    let off = null;
    const done = value => { clearTimeout(timer); off?.(); resolve(value); };
    const timer = setTimeout(() => done(false), ms);
    off = controller.subscribe(state => { if (state.engineReady) queueMicrotask(() => done(true)); else if (mine !== lifecycle) queueMicrotask(() => done(false)); });
  });
}
async function askFromButton(command = {}) {
  if (appLocked() || document.visibilityState !== 'visible') return;
  // One press at a time: a second press while listening is the hub's to end.
  if (pressBusy || (press && !press.closed) || starting || closing) return;
  pressBusy = true;
  try {
    await configReady;
    if (document.visibilityState !== 'visible') return;
    if (!config?.runtime?.available || config.runtime.capabilities?.streaming !== true) { notice(STREAMING_LINE); return; }
    if (screen !== 'chat') go('chat');
    if (!session && !await openSession({ denied: MICROPHONE_LINE })) return;
    if (!await engineReadyWithin(20000) || !session) return;
    if (!remoteStreaming) { await shutdown('close'); notice(STREAMING_LINE); return; }
    if (holding || askPending || mode !== 'blocked' || !['Ready to ask', 'Your turn', 'Preparing'].includes(controller.state.phase)) return;
    await openPressWindow(command);
  } finally { pressBusy = false; }
}
async function openPressWindow(command) {
  const mine = lifecycle, intent = ++captureIntent;
  metrics.end(questionMetric, 'cancelled', 'superseded');
  // A press is recorded in the test-mode turn log only (kind `press`); the
  // content-free production rows keep their four kinds.
  questionMetric = {}; pressMetric = questionMetric;
  const ago = Number.isFinite(command.pressAt) ? Date.now() - command.pressAt : null;
  turnLog.begin(questionMetric, 'press', { mode: 'stream', session, ago });
  pendingFrames = []; captureGeneration = null; finishedTurn = -1;
  press = { windowId: null, generation: null, listening: false, closed: false, seals: 0, question: '' };
  setMode('opening'); uploadEpoch++; controller.ask();
  let reply = null;
  try { reply = await control('window', { context: recentConversation.slice(-8) }); }
  catch { if (mine === lifecycle && intent === captureIntent) failSession('Listening could not start. Your phrases still work; press again.'); return; }
  if (!reply || mine !== lifecycle || intent !== captureIntent || !press || press.closed) return;
  press.windowId = reply.windowId; press.generation = reply.generation; captureGeneration = reply.generation;
  turnLog.mark(questionMetric, 'tone');
  await tones.listening();
  await pause(FRAMES_AFTER_TONE_MS);
  if (mine !== lifecycle || intent !== captureIntent || !press || press.closed) return;
  if (!mic?.begin()) { failSession('The microphone is not ready. Start Chat again.'); return; }
  setMode('capture'); press.listening = true; document.body.dataset.listening = 'true'; paintPhase();
  turnLog.mark(questionMetric, 'listening');
  notice('Listening. Ask the question; Chat stops listening when you stop talking.');
}
async function beginAsk() {
    if (appLocked()) return;
  if (!session || !controller.state.engineReady || holding || askPending || mode === 'draining' || closing || !['Ready to ask', 'Your turn'].includes(controller.state.phase)) return;
  holding = true; askPending = true; captureGeneration = null; questionSending = false; const mine = lifecycle;
  const intent = ++captureIntent; pendingFrames = [];
  metrics.end(questionMetric, 'cancelled', 'superseded'); questionMetric = metrics.begin('hold');
  turnLog.set(questionMetric, { mode: remoteStreaming ? 'stream' : remoteFinal ? 'one-shot' : 'local', session });
  // Test mode: measure the service round trips now, at touch-down, not while the question is sent (cached 30 s).
  if (turnLog.tracking(questionMetric)) fetch(`${API}/health/warm`, { cache: 'no-store' }).catch(() => {});
  setMode('opening'); uploadEpoch++; controller.ask(); finishedTurn = -1; $('ask').classList.add('held');
  const questionTurn = controller.state.turn;
  if (!mic?.begin()) { failSession('The microphone is not ready. Start Chat again.'); return; }
  clearTimeout(askTimer);
  askTimer = setTimeout(() => { if (mine === lifecycle && intent === captureIntent) failSession('That question was too long. Release and try a shorter question.', 'timeout'); }, 15000);
  try {
    askAcknowledged = control('ask', stagedChoices ? { context: recentConversation.slice(-8) } : {});
    const reply = await askAcknowledged;
    if (reply && mine === lifecycle && intent === captureIntent && questionTurn === controller.state.turn) {
      askPending = false; captureGeneration = reply.generation;
      setMode(holding ? 'capture' : 'draining');
      const frames = pendingFrames; pendingFrames = []; frames.forEach(queueFrame);
    }
  } catch (e) { if (mine === lifecycle && intent === captureIntent) failSession('Question capture could not start. Your phrases still work; start Chat again.'); }
}
async function finishAsk() {
    if (appLocked()) return;
  clearTimeout(askTimer);
  if (!session || !['opening', 'capture'].includes(mode) || controller.state.phase !== 'Capturing question') return;
  if (finishedTurn === controller.state.turn) return;
  finishedTurn = controller.state.turn;
  const timing = questionMetric; metrics.mark(timing, 'release'); turnLog.sample(timing, 'release');
  holding = false; $('ask').classList.remove('held');
  const mine = lifecycle, intent = captureIntent;
  // Stop collecting at release, even if the local Ask acknowledgement is slow.
  try { await mic?.flush(); }
  catch (e) { if (mine === lifecycle && intent === captureIntent) failSession(e.message); return; }
  await askAcknowledged.catch(() => {});
  if (mine !== lifecycle || intent !== captureIntent || !session) return;
  setMode('draining');
  try { await waitForAudioDrain(uploadChain); }
  catch (error) { if (mine === lifecycle && intent === captureIntent) failSession(error.message, 'timeout'); return; }
  if (mine !== lifecycle || intent !== captureIntent || !session) return;
  metrics.mark(timing, 'drained');
  setMode('blocked');
  if (remoteFinal) { questionSending = true; $('phase').textContent = 'Sending question'; }
  metrics.mark(timing, 'finishSent');
  try { await control('finish', audioSocket ? { seq: socketSeq } : {}); metrics.mark(timing, 'finishAck'); }
  catch (e) {
    // The hub had already ended this hold (cancelled, over budget, frames lost):
    // the partner sees the recovery steps, never a hub code.
    if (mine === lifecycle && intent === captureIntent) failSession(/^(?:capture-inactive|audio-sequence)$/.test(e.message)
      ? 'That question did not finish. Your phrases still work; start Chat again and wait for Ready to ask.' : e.message);
  }
}
function cancelAsk() {
  if (finishedTurn === controller.state.turn) return;
  if (!holding && !askPending) return;
  mic?.cancel(); pendingFrames = []; captureIntent++;
  metrics.end(questionMetric, 'cancelled', 'cancel');
  failSession('Question canceled. Your phrases still work; start Chat again.');
}
async function shutdown(type = 'close', preserveAnswers = false) {
  metrics.end(questionMetric, 'cancelled', 'closed'); metrics.end(speechMetric, 'cancelled', 'closed');
  const saved = persistence.flush({ keepalive: true });
  pendingSpeechMetric = null;
  const id = session; session = null; lifecycle++; uploadEpoch++;
  const mine = lifecycle; closing = true;
  recentConversation = [];
  captureIntent++; pendingFrames = [];
  if (press) press.closed = true;
  press = null;
  setMode('blocked'); starting = false; holding = false; askPending = false; captureGeneration = null;
  remoteFinal = false; remoteStreaming = false; questionSending = false; stagedChoices = false;
  if (staging) { const record = staging; staging = null; record.error ||= new Error('Chat is off.'); record.done?.(record.error); }
  clearTimeout(askTimer); clearTimeout(readyTimer); clearTimeout(heartbeat); heartbeat = null; sessionAbort?.abort();
  events?.close(); events = null; closeAudioSocket();
  if (id) {
    fetch(`${API}/sessions/${encodeURIComponent(id)}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }), keepalive: true }).catch(() => {});
    fetch(`${API}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
  if (!preserveAnswers) controller.stop();
  const oldMic = mic; mic = null; await oldMic?.stop();
  if (mine !== lifecycle) return;
  closing = false;
  voice.dispose(); queued = 0; uploadChain = Promise.resolve();
  diagnostic(''); $('ask').classList.remove('held'); $('ask').disabled = true;
  $('startChat').disabled = false; $('endChat').disabled = true;
  return saved;
}
async function failSession(message, reason = 'connection') {
  turnLog.error(questionMetric, message); turnLog.error(speechMetric, message);
  metrics.end(questionMetric, 'failed', reason); metrics.end(speechMetric, 'failed', reason);
  controller.fail(message); await shutdown('cancel', true);
}

controller.subscribe(state => { $('ask').disabled = !session || !state.engineReady; });
function touchButton(el, down, up, cancel) {
  let pointer = null;
  el.addEventListener('pointerdown', e => {
    if (!isPartnerTouch(e) || pointer !== null) return;
    pointer = e.pointerId;
    e.preventDefault(); el.setPointerCapture(e.pointerId); down?.();
  });
  el.addEventListener('pointerup', e => {
    if (!isPartnerTouch(e) || e.pointerId !== pointer) return;
    pointer = null; up?.();
  });
  for (const type of ['pointercancel', 'lostpointercapture']) el.addEventListener(type, e => {
    if (!isPartnerTouch(e) || e.pointerId !== pointer) return;
    pointer = null; cancel?.();
  });
  // No click handler: both app gaze clicks and native mouse injection are inert.
}
touchButton($('startChat'), startChat);
touchButton($('ask'), beginAsk, finishAsk, cancelAsk);
touchButton($('endChat'), () => shutdown());
for (const [id, down, up] of [['desktopStart', startChat, null], ['desktopAsk', beginAsk, finishAsk]]) {
  $(id).addEventListener('keydown', e => { if (e.isTrusted && e.code === 'Space' && !e.repeat) { e.preventDefault(); down(); } });
  $(id).addEventListener('keyup', e => { if (e.isTrusted && e.code === 'Space') { e.preventDefault(); up?.(); } });
}
$('desktopAsk').addEventListener('blur', cancelAsk);
$('partnerOpen').addEventListener('click', () => {
  // The dialog itself is not a gaze shield: remove underlying dwell targets.
  for (const el of $('grid').querySelectorAll('.dwell')) { el.classList.remove('dwell'); el.dataset.dwellDisabled = ''; }
  $('partnerDialog').showModal(); renderTestPanel();
});
$('partnerDialog').addEventListener('close', () => { gridKey = ''; renderGrid(controller.state); });
$('typedAsk').addEventListener('click', () => {
  const text = $('typedQuestion').value.trim(); if (!text) return;
  captureIntent++; holding = false; askPending = false; pendingFrames = []; mic?.cancel(); clearTimeout(askTimer);
  setMode('blocked'); uploadEpoch++; if (session) control('cancel').catch(() => {});
  metrics.end(questionMetric, 'cancelled', 'superseded'); questionMetric = metrics.begin('typed'); metrics.mark(questionMetric, 'transcript');
  turnLog.content(questionMetric, { transcript: text });
  go('chat'); $('partnerDialog').close(); controller.prepare(text); $('typedQuestion').value = '';
});
$('voicePreference').value = voice.getPreference();
$('voicePreference').addEventListener('change', async e => {
  const selected = e.target.value, intent = ++voicePreferenceIntent; e.target.disabled = true;
  voice.setPreference(selected); warmPhrases(); pageOnlyVoice = true;
  try {
    await persistence.update({ voicePreference: selected });
    if (intent === voicePreferenceIntent) { pageOnlyVoice = false; storageStatus.textContent = 'Voice choice saved on this computer.'; }
  } catch { if (intent === voicePreferenceIntent) storageStatus.textContent = 'This voice choice works on this page only. It was not saved; try again or reload Chat.'; }
  finally { if (intent === voicePreferenceIntent) e.target.disabled = false; }
});
warmPhrases();
metrics.subscribe(value => {
  const counts = value.summary.counts;
  $('timingSummary').textContent = `${value.turns.length} recent turns: ${counts.completed} completed, ${counts.cancelled} cancelled, ${counts.failed} failed, ${counts.open} in progress. All durations below are milliseconds.`;
  $('timingDetails').textContent = JSON.stringify({ recent: value.turns.slice(-10), completedTurnAggregates: value.summary.groups }, null, 2);
});
// ---- test mode: the partner's switch, the banner, the live panel ----
function paintTestMode() {
  $('testModeBanner').hidden = !testMode; $('testModePanel').hidden = !testMode;
  $('testModeToggle').textContent = testMode ? 'Turn off test mode' : 'Turn on test mode';
  $('testModeToggle').setAttribute('aria-pressed', String(testMode));
  if (testMode) refreshTestSummary();
}
const since = stage => stage.sinceRelease !== null ? `+${stage.sinceRelease} ms` : `${stage.ms} ms from start`;
function stageAt(record, name) {
  const release = record.stages.find(stage => stage.name === 'release'), stage = record.stages.find(item => item.name === name);
  return stage ? `${Math.round(stage.ms - (release && stage.ms >= release.ms ? release.ms : 0))} ms` : '–';
}
// Drawn only while a partner is looking at the timings panel.
function renderTestPanel() {
  if (!testMode || !$('partnerDialog').open || !$('turnTimings').open) return;
  const live = turnLog.live(), recent = turnLog.recent();
  $('liveTimeline').textContent = live ? live.stages.map(stage => `${stage.name.padEnd(18)} ${since(stage)}${stage.text ? `  “${stage.text}”` : ''}`).join('\n') : 'No turn in progress.';
  $('recentTurns').textContent = recent.slice().reverse().map(record => [
    `${record.startedAt.slice(11, 19)} ${record.kind} ${record.outcome}${record.reason ? ` (${record.reason})` : ''}${record.error ? `: ${record.error}` : ''}`,
    `  heard: ${record.content?.transcript || '–'}`,
    `  replies: ${(record.content?.choices || []).map(choice => choice.label).join(' | ') || '–'}`,
    `  chose: ${record.content?.selected?.label || '–'}; said: ${record.content?.spoken || '–'}`,
    `  transcript ${stageAt(record, 'transcript')}, first choice ${stageAt(record, 'firstChoiceStaged')}, revealed ${stageAt(record, 'revealed')}, first audio ${stageAt(record, 'firstAudio')}`,
    ...(record.cost ? [`  estimated cost ${record.cost.total} ${record.cost.currency}${record.cost.complete ? '' : ' (some parts unpriced)'}`] : []),
  ].join('\n')).join('\n\n') || 'No recorded turns yet.';
}
turnLog.subscribe(() => renderTestPanel());
$('turnTimings').addEventListener('toggle', renderTestPanel);
let summaryRequest = 0;
async function refreshTestSummary() {
  const mine = ++summaryRequest;
  try {
    const value = await json(`${API}/turns`);
    if (mine !== summaryRequest || !testMode) return;
    const lines = [];
    for (const [build, kinds] of Object.entries(value.summary?.builds || {})) for (const [kind, group] of Object.entries(kinds)) {
      lines.push(`${build} · ${kind} · ${group.turns} turns`);
      for (const [stage, stat] of Object.entries(group.stages)) lines.push(`  ${stage.padEnd(18)} p50 ${stat.p50}  p95 ${stat.p95}  (n=${stat.n})`);
    }
    for (const [day, cost] of Object.entries(value.summary?.costPerDay || {})) lines.push(`${day}: estimated ${cost.usd} for ${cost.turns} turns${cost.unpriced ? `, ${cost.unpriced} unpriced` : ''}`);
    $('buildSummary').textContent = lines.join('\n') || 'No recorded turns yet.';
  } catch { if (mine === summaryRequest) $('buildSummary').textContent = 'Recorded turns are unavailable.'; }
}
// Partner controls stay touch-only (gaze and injected mouse clicks are inert);
// a trusted keyboard press is the desktop tester's way, as for the Ask button.
function partnerAction(el, action) {
  touchButton(el, null, action);
  el.addEventListener('keydown', e => { if (e.isTrusted && (e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); action(); } });
}
let testModeBusy = false, deleteArmed = null;
partnerAction($('testModeToggle'), async () => {
  if (testModeBusy) return;
  testModeBusy = true; $('testModeToggle').disabled = true;
  const next = !testMode;
  try {
    const saved = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatTestMode: next }) });
    if (!saved.ok) throw new Error();
    testMode = (await (await fetch('/settings', { cache: 'no-store' })).json()).chatTestMode === true;
    $('testModeNote').textContent = testMode ? 'Test mode is on. Chat turns on this computer are being recorded.' : 'Test mode is off. Nothing new is recorded; earlier recordings are kept until you delete them.';
  } catch { $('testModeNote').textContent = 'Test mode was not changed. Try again.'; }
  finally { testModeBusy = false; $('testModeToggle').disabled = false; paintTestMode(); }
});
partnerAction($('deleteRecordings'), async () => {
  if (!deleteArmed) {
    $('deleteRecordings').textContent = 'Touch again to delete test recordings';
    deleteArmed = setTimeout(() => { deleteArmed = null; $('deleteRecordings').textContent = 'Delete test recordings'; }, 5000);
    return;
  }
  clearTimeout(deleteArmed); deleteArmed = null; $('deleteRecordings').textContent = 'Delete test recordings';
  try {
    const result = await json(`${API}/turns`, { method: 'DELETE' });
    const failed = result.deleted.failed || [];
    $('testModeNote').textContent = `Deleted ${result.deleted.days} days of test records, ${result.deleted.recordings} recordings and ${result.deleted.poolLines} turn lines this computer had copied to the family data folder.`
      + (failed.length ? ` ${failed.length} family data file${failed.length === 1 ? ' was' : 's were'} busy and still hold${failed.length === 1 ? 's' : ''} turn lines (${failed.join(', ')}). Try again in a moment.` : '');
    if (testMode) refreshTestSummary();
  } catch { $('testModeNote').textContent = 'Test recordings were not deleted. Try again.'; }
});
$('clearTimings').addEventListener('click', async e => {
  e.target.disabled = true; metrics.clear();
  const saved = await persistence.flush();
  storageStatus.textContent = saved ? 'Turn timings cleared on this computer.' : 'Timing changes were not saved. Reload Chat before relying on the clear.';
  e.target.disabled = false;
});
$('exportTimings').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([metrics.exportJSON()], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'chat-timings.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('saveStory').addEventListener('click', async () => {
  const label = $('storyLabel').value.trim(), say = $('storyMessage').value.trim();
  if (!label || !say) { $('storyNote').textContent = 'Add a label and the words to speak.'; return; }
  if (stories.length >= 4) { $('storyNote').textContent = 'Four stories are saved. Clear them before adding new stories.'; return; }
  $('saveStory').disabled = $('clearStories').disabled = true;
  try {
    const saved = await persistence.update({ stories: [...stories, { label, say }] });
    stories = saved.stories; gridKey = ''; warmPhrases();
    $('storyNote').textContent = 'Story saved on this computer.';
    $('storyLabel').value = ''; $('storyMessage').value = '';
  } catch { $('storyNote').textContent = 'Story was not saved. Your words remain here; try again or reload Chat.'; }
  finally { $('saveStory').disabled = $('clearStories').disabled = false; }
});
$('clearStories').addEventListener('click', async () => {
  $('saveStory').disabled = $('clearStories').disabled = true;
  try { const saved = await persistence.update({ stories: [] }); stories = saved.stories; gridKey = ''; $('storyNote').textContent = 'Saved stories cleared.'; }
  catch { $('storyNote').textContent = 'Stories were not cleared. Try again or reload Chat.'; }
  finally { $('saveStory').disabled = $('clearStories').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') shutdown('pause'); });
window.addEventListener('pagehide', () => shutdown('close'));
window.addEventListener('resize', () => { window.Dwell?.suppress(600); fitLabels(); });
const configReady = json(`${API}/config`).then(value => {
  config = value;
  $('engineNote').textContent = value.runtime?.available
    ? (value.runtime.kind === 'built-in' ? 'Cloud speech is set up. Start Chat to check the microphone, then wait for Ready to ask.' : 'Speech is set up. Start Chat to check the microphone, then wait for Ready to ask.')
    : 'Speech is not set up on this computer. Prepared phrases and stories work. A maintainer can finish speech setup.';
}).catch(() => { $('engineNote').textContent = 'Speech is unavailable. Prepared phrases and stories work.'; });
appReady = true;
document.body.dataset.storageReady = 'true';
for (const id of ['startChat', 'desktopStart', 'desktopAsk', 'typedAsk', 'voicePreference', 'saveStory', 'clearStories', 'clearTimings']) $(id).disabled = false;
if (persistence.status().state === 'unsaved' || persistence.status().state === 'conflict') notice(storageStatus.textContent);
// The partner's button (design 2026-10-27 §4.2): the hub's command stream, open before any session.
connectCommands({ onCommand: command => { if (command.type === 'ask') void askFromButton(command); } });
