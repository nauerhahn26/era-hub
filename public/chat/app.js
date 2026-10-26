import { createChatController, isPartnerTouch } from './controller.js';
import { createMicrophone } from './capture.js';
import { createChatVoice } from './voice.js';
import { mountDoorBar } from '/lib/doorbar.js';

const $ = id => document.getElementById(id);
const API = '/chat/api';
const appLocked = () => window.AppLock?.isLocked() || false;
const voice = createChatVoice();
let screen = 'chat', config = null, session = null, events = null, mic = null;
let lifecycle = 0, sequence = 0, workerGeneration = -1, uploadEpoch = 0;
let mode = 'blocked', starting = false, closing = false, holding = false, askTimer = null, finishedTurn = -1;
let uploadChain = Promise.resolve(), queued = 0, sessionAbort = null, readyTimer = null;
let askPending = false, askAcknowledged = Promise.resolve(), captureGeneration = null;
let gridKey = '', currentSpeech = 0, captureIntent = 0, pendingFrames = [], heartbeat = null;
let recentConversation = [];
let remoteFinal = false, remoteStreaming = false, questionSending = false;
let stories = [];
try { stories = JSON.parse(localStorage.getItem('chat:stories') || '[]').filter(x => typeof x.label === 'string' && typeof x.say === 'string').slice(0, 4); } catch {}

const fixed = {
  chat: ["Hi!", "What's up?", 'How are you?', 'Come sit with me.'],
  reactions: ["That's funny!", 'I love that!', 'No way!', "That's not fair!"],
  repair: ['Give me more time.', "That's not what I meant.", 'Ask me yes or no.', 'Let me try again.'],
};

async function json(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || 'The speech service is unavailable.');
  return body;
}
const notice = text => { $('notice').textContent = text || ''; };
function paintPhase(state = controller.state) {
  $('phase').textContent = state.phase === 'Capturing question' && ((remoteStreaming && mode !== 'opening') || questionSending) ? 'Sending question' : state.phase;
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
  requestChoices: ({ text, signal }) => {
    const context = recentConversation.slice(-8);
    recentConversation = [...recentConversation, `Partner: ${text}`.slice(0, 500)].slice(-8);
    return json(`${API}/choices`, { method: 'POST', body: JSON.stringify({ text, context }), signal });
  },
  onChoicesError: () => shutdown('cancel', true),
  stopSpeech: () => { currentSpeech++; voice.stop(); },
  prefetch: choices => voice.prefetch(choices),
  beforeChoices: () => window.Dwell?.suppress(600),
  async speak(choice, { signal }) {
    if (appLocked()) return;
    const mine = lifecycle, spoken = ++currentSpeech;
    captureIntent++; holding = false; askPending = false; pendingFrames = []; captureGeneration = null;
    clearTimeout(askTimer); $('ask').classList.remove('held'); mic?.cancel();
    setMode('blocked'); uploadEpoch++;
    const canceled = session ? control('cancel').catch(() => null) : Promise.resolve();
    if (signal.aborted || spoken !== currentSpeech) return;
    if (appLocked()) return;
    await voice.say(choice.say, { signal });
    if (!signal.aborted && spoken === currentSpeech && mine === lifecycle) recentConversation = [...recentConversation, `Me: ${choice.say}`.slice(0, 500)].slice(-8);
    await canceled;
  },
});

const bar = mountDoorBar($('app'), {
  onLock: () => { void shutdown('close'); },
  onLeave: () => { shutdown('close'); },
  onPause: () => { shutdown('pause'); },
  onResume: () => { notice('Chat is off. A partner can start a new session.'); },
});
fetch('/settings').then(r => r.json()).then(s => {
  const dwell = Math.max(600, Math.min(3000, Number(s.dwellMs) || 1200));
  window.Dwell?.set({ ms: dwell }); bar.setDwell(dwell); bar.setPause(s.pauseGoes === 'tdsnap');
}).catch(() => {});

function tile(label, type, action, position) {
  const el = document.createElement(action ? 'button' : 'div');
  el.className = `tile ${type}${action ? ' dwell' : ''}`;
  el.style.gridColumn = String(position[0] + 1); el.style.gridRow = String(position[1] + 1);
  if (action) { el.type = 'button'; el.addEventListener('click', action); }
  const text = document.createElement('span'); text.className = 'label'; text.textContent = label;
  el.appendChild(text); return el;
}
function go(next) { screen = next; gridKey = ''; renderGrid(controller.state); }
function fitLabels() {
  for (const el of $('grid').querySelectorAll('.tile:not(.rest)')) {
    const label = el.querySelector('.label');
    el.style.fontSize = ''; delete el.dataset.fontReduced;
    const style = getComputedStyle(el), padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    let size = parseFloat(style.fontSize);
    while (size > 44 && (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > el.clientHeight - padding + 1)) {
      size = Math.max(44, size - 2); el.style.fontSize = `${size}px`;
    }
    if (size < 74) el.dataset.fontReduced = 'true';
  }
}
function renderGrid(state) {
  const key = `${screen}|${state.turn}|${state.choices.map(c => c.id).join(',')}|${state.phase === 'Capturing question' || state.phase === 'Preparing'}|${stories.length}`;
  if (key === gridKey) return;
  gridKey = key;
  window.Dwell?.suppress(600);
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
        if (item.id) controller.select(item.id, selectedTurn); else controller.sayFixed(item.say);
      }, positions[i]);
      if (item.id) el.dataset.choiceId = item.id;
      grid.append(el);
    } else grid.append(tile(screen === 'news' && i === 0 ? 'Your stories go here' : '', screen === 'news' ? 'emptyStory' : 'waiting', null, positions[i]));
  }
  const bottom = screen === 'chat'
    ? [['Tell me more', () => controller.sayFixed('Tell me more.')], ['Reactions', () => go('reactions')], ['My news', () => go('news')], ['Help me say it', () => go('repair')]]
    : [['Tell me more', () => controller.sayFixed('Tell me more.')], ['Reactions', () => go('reactions')], ['My news', () => go('news')], ['Back to Chat', () => go('chat')]];
  bottom.forEach(([label, action], i) => grid.append(tile(label, i === 0 ? 'static' : 'route', action, [i, 2])));
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

// Only an actual movement into the inert rest area releases a staged batch.
// A newly arrived batch cannot inherit a gaze that was already on a response.
document.addEventListener('pointermove', e => {
  if (screen !== 'chat' || !controller.state.staged) return;
  if (e.target.closest?.('.rest')) controller.neutral();
}, { passive: true });

function sendFrame(bytes) {
  if (!session) return;
  if (mode === 'opening') {
    if (pendingFrames.length >= 20) { failSession('Capture did not become ready. Release and start Chat again.'); return; }
    pendingFrames.push(bytes); return;
  }
  if (mode === 'capture' || mode === 'draining') queueFrame(bytes);
}
function queueFrame(bytes) {
  const mine = lifecycle, epoch = uploadEpoch, id = session;
  if (++queued > 20) { queued--; failSession('Question capture could not keep up. Start again when ready.'); return; }
  uploadChain = uploadChain.then(async () => {
    if (mine !== lifecycle || epoch !== uploadEpoch || mode === 'blocked') return;
    const r = await fetch(`${API}/sessions/${encodeURIComponent(id)}/audio?seq=${sequence}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, signal: sessionAbort.signal,
    });
    if (r.ok && mine === lifecycle) sequence++;
    if (mine !== lifecycle || epoch !== uploadEpoch) return;
    if (r.status === 409) {
      const error = await r.json().catch(() => ({}));
      if (error.error === 'capture-inactive') throw new Error('Question capture stopped. Release and start Chat again.');
      throw new Error('Audio sequence changed. Start a new listening session.');
    }
    if (!r.ok) throw new Error('The audio connection stopped.');
  }).catch(e => { if (mine === lifecycle && e.name !== 'AbortError') failSession(e.message); })
    .finally(() => { if (mine === lifecycle) queued--; });
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
function receiveEvent(event) {
  let data; try { data = JSON.parse(event.data); } catch { return; }
  // Voice activation is disabled for the hold-only pilot. An unsolicited wake
  // cannot change capture state OR poison a later turn's generation check.
  if (data.type === 'wake') return;
  if (['partial', 'final'].includes(data.type) && (askPending || controller.state.phase !== 'Capturing question' || captureGeneration === null)) return;
  if (Number.isFinite(data.generation)) {
    if (data.generation < workerGeneration) return;
    workerGeneration = data.generation;
  }
  if (data.type === 'ready') {
    clearTimeout(readyTimer);
    remoteFinal = data.capabilities?.remoteFinal === true;
    remoteStreaming = data.capabilities?.remoteStreaming === true;
    $('engineNote').textContent = 'Voice activation is off. Audio is collected only while you hold Ask. '
      + (remoteStreaming ? 'The held question is sent for live transcription. Release stops collection and finishes the question.'
        : remoteFinal ? 'The held question is captured here, then sent for transcription after release. Audio outside the hold is not sent.'
          : 'Question recognition also stays on this device.');
    controller.ready();
  } else if (data.type === 'partial') {
    if (askPending || (Number.isFinite(captureGeneration) && data.generation !== captureGeneration)) return;
    controller.partial(data.text);
    diagnostic(`Heard so far: ${String(data.text || '').slice(0, 600)}`);
  } else if (data.type === 'final') {
    if (askPending || controller.state.phase !== 'Capturing question' || (Number.isFinite(captureGeneration) && data.generation !== captureGeneration)) return;
    if (holding || finishedTurn !== controller.state.turn) { failSession('Capture ended before release. Your phrases still work; start Chat again.'); return; }
    clearTimeout(askTimer); holding = false; $('ask').classList.remove('held');
    questionSending = false;
    setMode('blocked'); uploadEpoch++;
    diagnostic(`Question: ${String(data.text || '').slice(0, 600)}`);
    controller.prepare(data.text);
  } else if (data.type === 'error') {
    diagnostic(`Listening: ${String(data.message || data.error || 'unavailable').slice(0, 300)}`);
    failSession(data.error === 'no-speech' ? 'No question was heard. Start again, or use a phrase.' : 'Speech recognition stopped. Your phrases still work.');
  }
}

async function startChat() {
  if (appLocked()) return;
  if (starting || closing || session || document.visibilityState !== 'visible') return;
  if (!config?.runtime?.available) { controller.fail('Speech is not set up. Prepared phrases and stories still work.'); return; }
  starting = true; const mine = ++lifecycle; sessionAbort = new AbortController();
  $('startChat').disabled = true; notice('Starting the microphone…');
  try {
    mic = createMicrophone({ onFrame: sendFrame, onError: e => { if (mine === lifecycle) failSession(e.message); } });
    await mic.start(); // Called directly by the explicit partner gesture.
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
  } catch (e) {
    if (mine === lifecycle) { await shutdown('close'); controller.fail(e.name === 'NotAllowedError' ? 'Microphone permission was not granted. Your phrases still work.' : e.message); }
  } finally {
    if (mine === lifecycle) { starting = false; $('startChat').disabled = !!session; }
  }
}
async function beginAsk() {
  if (appLocked()) return;
  if (!session || !controller.state.engineReady || holding || askPending || mode === 'draining' || closing || !['Ready to ask', 'Your turn'].includes(controller.state.phase)) return;
  holding = true; askPending = true; captureGeneration = null; questionSending = false; const mine = lifecycle;
  const intent = ++captureIntent; pendingFrames = [];
  setMode('opening'); uploadEpoch++; controller.ask(); finishedTurn = -1; $('ask').classList.add('held');
  const questionTurn = controller.state.turn;
  if (!mic?.begin()) { failSession('The microphone is not ready. Start Chat again.'); return; }
  clearTimeout(askTimer);
  askTimer = setTimeout(() => { if (mine === lifecycle && intent === captureIntent) failSession('That question was too long. Release and try a shorter question.'); }, 15000);
  try {
    askAcknowledged = control('ask');
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
  holding = false; $('ask').classList.remove('held');
  const mine = lifecycle, intent = captureIntent;
  // Stop collecting at release, even if the local Ask acknowledgement is slow.
  try { await mic?.flush(); }
  catch (e) { if (mine === lifecycle && intent === captureIntent) failSession(e.message); return; }
  await askAcknowledged.catch(() => {});
  if (mine !== lifecycle || intent !== captureIntent || !session) return;
  setMode('draining');
  await uploadChain;
  if (mine !== lifecycle || intent !== captureIntent || !session) return;
  setMode('blocked');
  if (remoteFinal) { questionSending = true; $('phase').textContent = 'Sending question'; }
  try { await control('finish'); } catch (e) { if (mine === lifecycle && intent === captureIntent) failSession(e.message); }
}
function cancelAsk() {
  if (finishedTurn === controller.state.turn) return;
  if (!holding && !askPending) return;
  mic?.cancel(); pendingFrames = []; captureIntent++;
  failSession('Question canceled. Your phrases still work; start Chat again.');
}
async function shutdown(type = 'close', preserveAnswers = false) {
  const id = session; session = null; lifecycle++; uploadEpoch++;
  const mine = lifecycle; closing = true;
  recentConversation = [];
  captureIntent++; pendingFrames = [];
  setMode('blocked'); starting = false; holding = false; askPending = false; captureGeneration = null;
  remoteFinal = false; remoteStreaming = false; questionSending = false;
  clearTimeout(askTimer); clearTimeout(readyTimer); clearTimeout(heartbeat); heartbeat = null; sessionAbort?.abort();
  events?.close(); events = null;
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
}
async function failSession(message) { controller.fail(message); await shutdown('cancel', true); }

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
  $('partnerDialog').showModal();
});
$('partnerDialog').addEventListener('close', () => { gridKey = ''; renderGrid(controller.state); });
$('typedAsk').addEventListener('click', () => {
  const text = $('typedQuestion').value.trim(); if (!text) return;
  captureIntent++; holding = false; askPending = false; pendingFrames = []; mic?.cancel(); clearTimeout(askTimer);
  setMode('blocked'); uploadEpoch++; if (session) control('cancel').catch(() => {});
  go('chat'); $('partnerDialog').close(); controller.prepare(text); $('typedQuestion').value = '';
});
$('voicePreference').addEventListener('change', e => voice.setPreference(e.target.value));
$('saveStory').addEventListener('click', () => {
  const label = $('storyLabel').value.trim(), say = $('storyMessage').value.trim();
  if (!label || !say) { $('storyNote').textContent = 'Add a label and the words to speak.'; return; }
  if (stories.length >= 4) { $('storyNote').textContent = 'Four stories are saved. Clear them before adding new stories.'; return; }
  stories.push({ label, say });
  try { localStorage.setItem('chat:stories', JSON.stringify(stories)); $('storyNote').textContent = 'Story saved on this browser.'; } catch { $('storyNote').textContent = 'Story is available until this page closes; browser storage is unavailable.'; }
  $('storyLabel').value = ''; $('storyMessage').value = '';
});
$('clearStories').addEventListener('click', () => { stories = []; localStorage.removeItem('chat:stories'); $('storyNote').textContent = 'Saved stories cleared.'; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') shutdown('pause'); });
window.addEventListener('pagehide', () => shutdown('close'));
window.addEventListener('resize', () => { window.Dwell?.suppress(600); fitLabels(); });
json(`${API}/config`).then(value => {
  config = value;
  $('engineNote').textContent = value.runtime?.available
    ? (value.runtime.kind === 'built-in' ? 'Cloud speech is set up. Start Chat to check the microphone, then wait for Ready to ask.' : 'Speech is set up. Start Chat to check the microphone, then wait for Ready to ask.')
    : 'Speech is not set up on this computer. Prepared phrases and stories work. A maintainer can finish speech setup.';
}).catch(() => { $('engineNote').textContent = 'Speech is unavailable. Prepared phrases and stories work.'; });
