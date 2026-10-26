import { mountDoorBar } from '../lib/doorbar.js';
import { STORAGE_KEY, CATALOG, createState, readSavedState, restoreState, serializeState, reduce } from './state.js';

const screen = document.getElementById('gamesScreen');
const origins = new WeakSet();
const BACKUP_KEY = `${STORAGE_KEY}.recovery`;
let S = createState(), recoveryNotice = '', storageBlocked = false, recoveryOriginal = null;
let localRaw = null, localValid = false, durableBlocked = false;
let revision = 0, acknowledged = 0, queuedRevision = 0, latestSave = '', saveFailed = false;
let saving = Promise.resolve(true);
const saveNotice = document.getElementById('saveNotice');
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  const loaded = readSavedState(raw);
  localRaw = raw; localValid = !!raw && loaded.valid;
  if (raw && !loaded.valid) {
    recoveryOriginal = raw;
    try {
      // Keep an invalid original before writing defaults. A failed backup forbids overwrite.
      if (raw.length <= 1024 * 1024) localStorage.setItem(BACKUP_KEY, raw);
      else storageBlocked = true;
    } catch { storageBlocked = true; }
    recoveryNotice = storageBlocked ? 'Saved progress could not be read. Its original has been left untouched; this session still works.' : 'An unreadable saved game was preserved in local recovery. This session starts safely.';
  }
} catch { storageBlocked = true; recoveryNotice = 'Local storage is unavailable. Existing progress is untouched; this session still works.'; }
let ready = false, gone = false, renderedKey = '', uiPage = '', rigTemplate = null;
let bar, stage, choices, heading, status, footer, botTimer = null, showTimer = null;
let showStarted = 0, showRemaining = 1600, showToken = '', sceneKey = '', idCounter = 0;
let audio = null, musicTimer = null, musicStep = 0, partnerPanel, partnerButton, durableCopy;
let musicGeneration = 0, musicArmed = false, musicPending = false, musicVolCap = 0;
const liveNotes = new Set();

function saveMessage(message) { saveNotice.textContent = message; }
function startSave() {
  if (durableBlocked || queuedRevision === revision) return saving;
  queuedRevision = revision;
  saving = saving.then(async () => {
      const current = revision, body = latestSave;
      if (acknowledged >= current) return true;
      try {
        const controller = new AbortController();
        let timeout;
        let status;
        try {
          status = await Promise.race([
            (async () => {
              const response = await fetch('/games/state', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
                keepalive: body.length <= 60000, signal: controller.signal,
              });
              await response.text();
              return response.status;
            })(),
            new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(Error('save timeout')); }, 750); }),
          ]);
        } finally { clearTimeout(timeout); }
        if (status !== 200) throw Error(`save ${status}`);
        acknowledged = current;
        saveFailed = false;
        if (current === revision) {
          if (!recoveryOriginal) recoveryNotice = '';
          saveMessage('Saved');
        }
        return true;
      } catch {
        saveFailed = true;
        if (current === revision) {
          recoveryNotice = 'The hub did not confirm the latest save. Progress remains in this session. Make another choice to retry, then wait for Saved.';
          saveMessage('Not saved');
        }
        return false;
      }
  });
  return saving;
}
function persist() {
  if (!ready || durableBlocked) return Promise.resolve(false);
  try {
    const nextSave = serializeState(S);
    if (nextSave === latestSave && !saveFailed) return saving;
    latestSave = nextSave;
    revision++;
    saveMessage('Saving…');
    if (!storageBlocked) {
      try { localStorage.setItem(STORAGE_KEY, latestSave); }
      catch { storageBlocked = true; }
    }
    return startSave();
  } catch {
    recoveryNotice = 'The latest progress could not be prepared for saving. This session still works, but the change is not saved.';
    saveMessage('Not saved');
    return Promise.resolve(false);
  }
}
async function flushBeforeExit() {
  if (durableBlocked) return;
  if (acknowledged === revision) return;
  const done = await Promise.race([
    startSave(), new Promise(resolve => setTimeout(() => resolve(false), 900)),
  ]);
  if (!done && acknowledged < revision) {
    recoveryNotice = 'The latest save was not confirmed before Exit. The previous saved progress was preserved.';
    saveMessage('Not saved yet');
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function active() { return !window.AppLock?.isLocked() && !gone && !S.paused && !S.hidden && document.visibilityState === 'visible'; }
function speak(text) {
  if (text && window.AppLock?.isLocked()) return;
  try { window.Speech?.stop(); if (text) void window.Speech?.say(text, 'long'); } catch {}
}
function suppress() {
  try { const d = window.Dwell; if (d) d.suppress(Math.max(d.state().suppressedMs, d.config.settleMs)); } catch {}
}
function syncDwell() {
  screen.querySelectorAll('.game-control').forEach(el => {
    if (!active() || el.disabled) el.setAttribute('data-dwell-disabled', '');
    else el.removeAttribute('data-dwell-disabled');
  });
  if (window.Dwell) {
    if (gone || document.visibilityState !== 'visible') window.Dwell.disable(); else window.Dwell.enable();
  }
}
function clearTimers() {
  if (botTimer !== null) { clearTimeout(botTimer); botTimer = null; }
  if (showTimer !== null) {
    clearTimeout(showTimer); showTimer = null;
    showRemaining = Math.max(0, showRemaining - (performance.now() - showStarted));
  }
}
function stopMusic() {
  musicGeneration++; musicPending = false;
  if (musicTimer !== null) { clearInterval(musicTimer); musicTimer = null; }
  for (const { osc, gain } of liveNotes) {
    osc.onended = null;
    try { osc.stop(); } catch {}
    try { osc.disconnect(); gain.disconnect(); } catch {}
  }
  liveNotes.clear();
  // Suspend even if resume is still pending. Its completion is guarded below.
  if (audio && audio.state !== 'closed') void audio.suspend().catch(() => {});
}
function interrupt() { clearTimers(); stopMusic(); speak(''); }
function musicAllowed() {
  return musicArmed && musicVolCap > 0 && active() && S.view === 'fashion' &&
    S.fashion.view === 'show' && !S.fashion.show.paused && S.fashion.stage.music !== 'none';
}
function armMusic(action) {
  if (S.view !== 'fashion' || S.fashion.view !== 'show') { musicArmed = false; return; }
  if (['show-start', 'show-encore', 'show-next'].includes(action) ||
      (action === 'show-pause' && !S.fashion.show.paused)) musicArmed = true;
}
function scheduleMusic() {
  if (!musicAllowed() || musicPending || musicTimer !== null) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    audio ||= new Audio();
    const generation = musicGeneration;
    musicPending = true;
    // Original, quiet pentatonic phrases; never selection or confirmation sounds.
    const phrases = { pulse: [261.63, 329.63, 392, 329.63, 293.66, 392, 440, 392], glow: [329.63, 392, 440, 523.25, 440, 392, 329.63, 293.66], drift: [261.63, 293.66, 392, 440, 392, 293.66, 329.63, 261.63] };
    const notes = phrases[S.fashion.stage.music] || phrases.pulse;
    const note = () => {
      if (generation !== musicGeneration) return;
      if (!musicAllowed()) { stopMusic(); return; }
      const osc = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
      const peak = .035 * musicVolCap, entry = { osc, gain };
      osc.type = 'sine'; osc.frequency.value = notes[musicStep++ % notes.length];
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(peak, now + .04); gain.gain.exponentialRampToValueAtTime(peak / 1000, now + .55);
      liveNotes.add(entry);
      osc.onended = () => { liveNotes.delete(entry); osc.disconnect(); gain.disconnect(); };
      osc.connect(gain); gain.connect(audio.destination); osc.start(now); osc.stop(now + .6);
    };
    void Promise.resolve(audio.resume()).then(() => {
      if (generation !== musicGeneration || !musicAllowed()) {
        if (!musicAllowed() && audio.state !== 'closed') void audio.suspend().catch(() => {});
        return;
      }
      if (audio.state !== 'running') return;
      note(); musicTimer = setInterval(note, 650);
    }).catch(() => {}).finally(() => { if (generation === musicGeneration) musicPending = false; });
  } catch { musicPending = false; /* Optional music never blocks commands. */ }
}
function schedule() {
  if (!active() || S.pending) return;
  if (S.view === 'connect4' && S.connect4.pendingComputer) {
    botTimer = setTimeout(() => {
      botTimer = null;
      if (!active() || S.view !== 'connect4' || !S.connect4.pendingComputer) return;
      S = reduce(S, { type: 'connect4-computer' }); persist(); render();
    }, 550);
  }
  if (S.view === 'fashion' && S.fashion.view === 'show') {
    const show = S.fashion.show;
    const token = `${show.index}:${show.encores}`;
    if (showToken !== token) { showToken = token; showRemaining = 1600; }
    if (show.phase === 'entrance' && !show.paused) {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) showRemaining = 50;
      showStarted = performance.now();
      showTimer = setTimeout(() => {
        showTimer = null;
        if (!active() || S.view !== 'fashion' || S.fashion.view !== 'show' || S.fashion.show.paused) return;
        S = reduce(S, { type: 'show-arrived' }); persist(); render();
      }, Math.max(30, showRemaining));
    }
    scheduleMusic();
  }
}
function labelLines(text) {
  const aliases = { 'Fashion Studio': ['Fashion', 'Studio'], 'Four in a Row': ['Four in', 'a Row'], 'Number Tiles': ['Number', 'Tiles'], 'Make clothes': ['Make', 'clothes'], 'Dress a model': ['Dress', 'model'], 'Keep look': ['Keep'], 'Collection': ['Looks'], 'Model order': ['Show', 'order'], 'Two players': ['Friends'], 'No sleeves': ['No', 'sleeves'], 'Sunshine': ['Sunny'], 'Midnight': ['Night'], 'Leggings': ['Tights'], 'Shoulder': ['Side'], 'Moonlight': ['Moon'], 'Sleeveless': ['No', 'sleeves'], 'Trousers': ['Pants'], 'Train show': ['Show'] };
  if (aliases[text]) return aliases[text];
  if (text.length > 8 && text.includes(' ')) return text.split(' ');
  return [text];
}
function button(action, label, value, kind = '') {
  const el = document.createElement('button'); el.type = 'button';
  el.className = `game-control dwell ${kind}`; el.dataset.action = action;
  if (value !== undefined && value !== null) el.dataset.value = String(value);
  el.setAttribute('aria-label', label); el.dataset.dwellSay = label;
  const content = document.createElement('span'); content.className = 'command-label';
  labelLines(label).forEach(line => { const span = document.createElement('span'); span.className = 'label-line'; span.textContent = line; content.append(span); });
  el.append(content);
  el.addEventListener('click', event => {
    const input = origins.has(el) ? 'gaze' : event.isTrusted ? (event.detail ? 'pointer' : 'keyboard') : 'unknown';
    origins.delete(el); actionFor(action, value, input);
  });
  return el;
}
function inert() { const el = document.createElement('div'); el.className = 'inert-seat'; el.setAttribute('aria-hidden', 'true'); return el; }
function disabled(action, value, off) {
  const nodes = [...screen.querySelectorAll(`[data-action="${action}"]`)];
  const el = nodes.find(n => value === undefined || n.dataset.value === String(value));
  if (el) el.disabled = off;
}
function text(className, value, tag = 'div') { const el = document.createElement(tag); el.className = className; el.textContent = value; return el; }
function catalog(field) { return CATALOG[field] || []; }
function currentField() { return uiPage.startsWith('picker:') ? uiPage.slice(7) : S.fashion.editField; }
function safeLabel(field, value) { return catalog(field).find(x => x.value === value)?.label || String(value); }
function topTitle() {
  if (S.pending) {
    if (['look-delete','look-replace'].includes(S.pending.type)) {
      const index = S.fashion.looks.findIndex(l => l.id === S.pending.id) + 1;
      return `${S.pending.type === 'look-delete' ? 'Remove' : 'Replace'} look ${index}?`;
    }
    return 'Your choice';
  }
  if (S.view === 'menu') return 'Games';
  if (S.view === 'connect4') return 'Four in a Row';
  if (S.view === 'tiles') return 'Number Tiles';
  if (S.view === 'credits') return 'About these games';
  if (uiPage === 'shape') return 'Shape';
  if (uiPage === 'details') return 'Details';
  if (uiPage === 'collection-actions') return 'Your look';
  if (uiPage === 'lineup') return 'Show order';
  if (uiPage.startsWith('picker:')) return uiPage.slice(7) === 'music' ? 'Music' : 'Venue';
  return { studio: 'Fashion Studio', workbench: 'Make it yours', options: ({cut:'Cut',sleeves:'Sleeves',color:'Color',pattern:'Pattern',detail:'Motif',detailPosition:'Position',bottoms:'Bottoms',shoes:'Shoes',hair:'Hair',model:'Model'}[S.fashion.editField] || 'Choose'), styling: 'Style your model', collection: 'Your collection', stage: 'Set the scene', show: 'Your show' }[S.fashion.view] || 'Fashion Studio';
}
function addChoices(items) { items.forEach(item => choices.append(item || inert())); while (choices.children.length < 4) choices.append(inert()); }
function footerFor(third = null) {
  footer.append(button('back', 'Back', undefined, 'nav'), button('undo', 'Undo', undefined, 'primary'), third || inert());
}
function renderShell() {
  screen.replaceChildren(); stage = null; choices = null; sceneKey = '';
  const layout = document.createElement('section'); layout.className = 'game-layout';
  const titleRow = document.createElement('header'); titleRow.className = 'game-heading';
  heading = text('', topTitle(), 'h1'); status = text('game-status', ''); titleRow.append(heading, status); layout.append(titleRow);
  const workspace = document.createElement('div'); workspace.className = 'game-workspace';
  stage = document.createElement('section'); stage.className = 'game-preview'; stage.id = 'gameStage';
  choices = document.createElement('nav'); choices.className = 'game-choices'; choices.setAttribute('aria-label', 'Game choices');
  footer = document.createElement('nav'); footer.className = 'game-footer'; footer.setAttribute('aria-label', 'Back and game controls');
  const rest = document.createElement('div'); rest.className = 'game-rest'; rest.setAttribute('aria-hidden', 'true');
  workspace.append(stage, choices); layout.append(workspace, footer, rest); screen.append(layout);
  if (S.pending) {
    stage.classList.add('confirm-preview');
    const removing = S.pending.type === 'look-delete';
    const replacing = S.pending.type === 'look-replace';
    const target = S.fashion.looks.find(l => l.id === S.pending.id);
    if ((removing || replacing) && target) {
      const index = S.fashion.looks.findIndex(l => l.id === target.id) + 1;
      stage.classList.add('fashion-scene', 'look-confirm'); stage.dataset.testid = 'confirm-look-preview';
      stage.append(text('confirm-look-label', `Look ${index}`, 'h2'), character(target.outfit));
    } else stage.append(text('', 'Start again?', 'h2'), text('', 'Your choice will wait.'));
    addChoices([button('confirm', removing ? 'Remove look' : replacing ? 'Replace look' : 'Start again', undefined, 'primary'), button('cancel', removing || replacing ? 'Keep look' : 'Keep game', undefined, 'nav')]);
    footer.append(button('cancel', 'Back', undefined, 'nav'), inert(), inert());
  } else if (S.view === 'menu') {
    layout.classList.add('menu-layout'); stage.classList.add('fashion-scene', 'menu-preview');
    addChoices([button('open', 'Fashion Studio', 'fashion'), button('open', 'Four in a Row', 'connect4'), button('open', 'Number Tiles', 'tiles')]);
    footer.append(inert(), inert(), inert());
  } else if (S.view === 'connect4') {
    layout.classList.add('connect-layout');
    const columns = document.createElement('nav'); columns.className = 'column-commands'; columns.setAttribute('aria-label', 'Choose a column');
    for (let i = 0; i < 7; i++) columns.append(button('connect4-drop', String(i + 1), i));
    layout.insertBefore(columns, workspace); choices.classList.add('connect-modes');
    choices.append(button('connect4-mode', 'Two players', 'local'), button('connect4-mode', 'Computer', 'computer'));
    footerFor(button('restart', 'Again', undefined, 'primary'));
  } else if (S.view === 'tiles') {
    addChoices([button('tiles-move', 'Up', 'up'), button('tiles-move', 'Right', 'right'), button('tiles-move', 'Left', 'left'), button('tiles-move', 'Down', 'down')]);
    footerFor(button('restart', 'Again', undefined, 'primary'));
  } else if (S.view === 'credits') {
    stage.classList.add('credits-text');
    stage.innerHTML = '<h2>Number Tiles</h2><p>Adapted from 2048 by Gabriele Cirulli, under the MIT license. Movement uses four commands.</p><p><a href="vendor/2048/LICENSE.txt" target="_blank" rel="noopener">Read the original license</a></p><h2>Original local games</h2><p>Four in a Row, the character rig, garment designs and quiet show music were created for this app. Background art provenance is recorded with the artwork.</p><h2>Access</h2><p>Hosted games have separate controls. Ordinary mouse access does not prove gaze access.</p>';
    footer.append(button('back', 'Back', undefined, 'nav'), inert(), inert());
  } else {
    stage.classList.add('fashion-scene'); stage.dataset.testid = 'fashion-preview';
    fashionShell();
  }
  suppress();
}
function fashionShell() {
  const f = S.fashion;
  if (uiPage === 'shape') {
    addChoices([button('fashion-edit', 'Cut', 'cut'), button('fashion-edit', 'Sleeves', 'sleeves')]); footerFor(button('fashion-save', 'Keep', undefined, 'primary')); return;
  }
  if (uiPage === 'details') {
    addChoices([button('fashion-edit', 'Motif', 'detail'), button('fashion-edit', 'Position', 'detailPosition')]); footerFor(button('fashion-save', 'Keep', undefined, 'primary')); return;
  }
  if (uiPage === 'collection-actions') {
    addChoices([button('look-edit', 'Edit copy'), button('look-delete', 'Remove look'), button('lineup-add', 'Add to show', f.selectedLookId), button('lineup-order', 'Show order')]);
    footerFor(button('fashion-new', 'New', undefined, 'primary')); return;
  }
  if (uiPage === 'lineup') {
    addChoices([button('lineup-up', 'Earlier', f.selectedLookId), button('lineup-down', 'Later', f.selectedLookId), button('lineup-add', 'Add look', f.selectedLookId), button('lineup-remove', 'Remove', f.selectedLookId)]);
    footerFor(button('lineup-choose', 'Choose', undefined, 'primary')); return;
  }
  if (uiPage === 'lineup-choose') {
    addChoices(f.looks.map((look, i) => button('lineup-select', `Look ${i + 1}`, look.id)));
    footerFor(button('stage', 'Stage', undefined, 'primary')); return;
  }
  if (f.view === 'options' || uiPage.startsWith('picker:')) {
    const field = currentField(), page = f.view === 'options' ? f.optionPage : 0;
    const options = catalog(field).slice(page * 4, page * 4 + 4);
    addChoices(options.map(option => {
      const b = button('option', option.label, option.value);
      if (field === 'color') { const chip = document.createElement('span'); chip.className = 'swatch'; chip.style.backgroundColor = fabricColors[option.value]?.[0] || '#B19EBB'; b.prepend(chip); }
      return b;
    }));
    footerFor(catalog(field).length > 4 ? button('option-page', 'More', 1, 'primary') : null); return;
  }
  if (f.view === 'studio') {
    addChoices([button('fashion-resume', 'Resume'), button('fashion-new', 'Make clothes'), button('fashion-style', 'Dress a model'), button('fashion-collection', 'Collection')]); footerFor();
  } else if (f.view === 'workbench') {
    addChoices([button('fashion-shape', 'Shape'), button('fashion-edit', 'Color', 'color'), button('fashion-edit', 'Pattern', 'pattern'), button('fashion-details', 'Details')]); footerFor(button('fashion-save', 'Keep', undefined, 'primary'));
  } else if (f.view === 'styling') {
    addChoices([button('fashion-edit', 'Bottoms', 'bottoms'), button('fashion-edit', 'Shoes', 'shoes'), button('fashion-edit', 'Hair', 'hair'), button('fashion-edit', 'Model', 'model')]); footerFor(button('fashion-save', 'Keep', undefined, 'primary'));
  } else if (f.view === 'collection') {
    addChoices([...f.looks.map((look, i) => button('look-select', `Look ${i + 1}`, look.id)), button('collection-actions', 'Options')].slice(0, 4));
    footerFor(button('stage', 'Stage', undefined, 'primary'));
  } else if (f.view === 'stage') {
    addChoices([button('stage-venue', 'Venue'), button('stage-music', 'Music'), button('lineup-order', 'Model order'), button('show-start', 'Start')]); footerFor(button('fashion-collection', 'Collection', undefined, 'primary'));
  } else if (f.view === 'show') {
    stage.classList.add('stage-scene');
    addChoices([button('show-next', 'Next model'), button('show-pose', 'Pose'), button('show-encore', 'Encore'), button('show-pause', f.show.paused ? 'Resume' : 'Pause')]); footerFor(button('fashion-collection', 'Collection', undefined, 'primary'));
  }
}
const fabricColors = {
  plum: ['#9A679D', '#C49BC4', '#734974'], sunshine: ['#D8AC59', '#EFCD88', '#AE7E37'], sky: ['#6B9BC3', '#A0C3E2', '#4C719D'], midnight: ['#4D587B', '#8791B0', '#303B58'], teal: ['#459A9D', '#7AC2BA', '#286C79'], rose: ['#BA759C', '#DBA4BC', '#8E4D7E'], gold: ['#D8AC59', '#EFCD88', '#AE7E37'], lilac: ['#A18EB9', '#C8B7D9', '#796991'], blue: ['#6B9BC3', '#A0C3E2', '#4C719D'], mint: ['#83B39D', '#B3D5BA', '#588877'], coral: ['#D9967F', '#F1C3A4', '#AD7169'], cream: ['#E2D1AA', '#FFF1D2', '#B3A17E']
};
const cuts = {
  hoodie: 'M177 311 Q250 355 323 311 L345 559 Q250 578 155 559Z',
  tshirt: 'M181 316 Q250 350 319 316 L340 533 Q250 555 160 533Z',
  dress: 'M181 316 Q250 350 319 316 L320 445 L367 626 Q250 653 133 626 L180 445Z',
  tunic: 'M181 316 Q250 350 319 316 L345 579 Q250 615 155 579Z',
  jacket: 'M181 316 Q250 340 319 316 L343 550 L268 566 L250 480 L232 566 L157 550Z',
  skirt: 'M181 316 Q250 350 319 316 L321 450 L365 591 Q250 635 135 591 L179 450Z'
};
function character(outfit) {
  if (!rigTemplate) return text('empty-caption', 'Your design');
  const svg = rigTemplate.cloneNode(true); svg.classList.add('character');
  const prefix = `rig${++idCounter}-`;
  svg.querySelectorAll('[id]').forEach(el => { const old = el.id; el.id = prefix + old; svg.querySelectorAll('*').forEach(n => { for (const a of [...n.attributes]) if (a.value.includes(`url(#${old})`)) n.setAttribute(a.name, a.value.replaceAll(`url(#${old})`, `url(#${prefix}${old})`)); }); });
  const color = fabricColors[outfit.color] || fabricColors.teal;
  const skins = { warm: ['#CB8B64', '#E9B489', '#A76A50'], deep: ['#88583F', '#B5815B', '#634231'], light: ['#EDC49D', '#FFE1BE', '#C99C7F'], olive: ['#B79A6D', '#D7BD88', '#8E7656'] };
  const skin = skins[outfit.model] || skins.warm;
  ['--fabric', '--fabric-light', '--fabric-dark'].forEach((key, i) => svg.style.setProperty(key, color[i]));
  ['--skin', '--skin-light', '--skin-shadow'].forEach((key, i) => svg.style.setProperty(key, skin[i]));
  svg.style.setProperty('--shoe', { trainers: '#F1D4A5', boots: '#775E77', sandals: '#D6B08D', flats: '#A080AE' }[outfit.shoes] || '#F1D4A5');
  svg.style.setProperty('--bottom', { trousers: '#485979', shorts: '#638B8B', skirt: '#AB88A6', leggings: '#5D5875' }[outfit.bottoms] || '#485979');
  svg.dataset.hair = outfit.hair; svg.dataset.sleeves = outfit.sleeves; svg.dataset.bottoms = outfit.bottoms; svg.dataset.detail = outfit.detail;
  svg.dataset.cut = outfit.cut; svg.dataset.shoes = outfit.shoes;
  if (outfit.bottoms === 'leggings') svg.querySelectorAll('.trouser').forEach((el,i)=>el.setAttribute('d', i ? 'M250 511 L267 728 Q286 739 308 728 L307 511Z' : 'M193 511 L191 728 Q211 739 233 728 L250 511Z'));
  if (outfit.hair === 'short') svg.querySelector('.hair-back>path').setAttribute('d', 'M145 181 Q125 72 245 64 Q376 58 356 197 L332 222 L166 222Z');
  const shoePaths = { boots: ['M190 667 H233 L238 753 Q235 772 177 771 Q160 758 175 740Z','M267 667 H309 L309 721 L329 742 Q345 760 329 771 Q272 773 264 753Z'], flats: ['M190 738 Q210 755 234 738 L238 755 Q235 772 177 771 Q160 758 175 746Z','M267 739 Q290 754 309 737 L329 750 Q345 760 329 771 Q272 773 264 753Z'], sandals: ['M177 750 Q205 760 235 746 L238 761 Q220 777 177 771Z','M266 748 Q293 761 327 750 L334 763 Q310 780 266 770Z'] };
  if (shoePaths[outfit.shoes]) svg.querySelectorAll('.shoe').forEach((el,i)=>el.setAttribute('d',shoePaths[outfit.shoes][i]));
  const shape = cuts[outfit.cut] || cuts.tshirt;
  svg.querySelectorAll('.garment-base,.garment-mask').forEach(n => n.setAttribute('d', shape));
  const hem = { hoodie: 'M157 547 Q250 569 343 547', dress: 'M135 615 Q250 645 365 615', tunic: 'M157 568 Q250 604 343 568', jacket: 'M159 539 L231 555 M269 555 L341 539', skirt: 'M137 580 Q250 625 363 580' }[outfit.cut] || 'M161 522 Q250 547 339 522';
  svg.querySelector('.hem').setAttribute('d', hem);
  const pattern = svg.querySelector('.pattern-fill'); pattern.setAttribute('fill', ['dots', 'stripes', 'stars', 'checks', 'flowers', 'waves', 'sparkle'].includes(outfit.pattern) ? `url(#${prefix}${outfit.pattern})` : 'none');
  const position = { chest: [250, 403], hem: [270, outfit.cut === 'dress' ? 590 : 490], shoulder: [198, 362], waist: [250, 451], left: [205, 400], right: [295, 400] }[outfit.detailPosition] || [250, 403];
  svg.querySelector('.garment-detail').setAttribute('transform', `translate(${position.join(' ')}) scale(.9)`);
  return svg;
}
function scene(outfit, key) {
  if (sceneKey === key) return;
  sceneKey = key; stage.replaceChildren(character(outfit));
}
function paintFashion() {
  const f = S.fashion;
  if (f.view === 'collection' || uiPage === 'collection-actions' || uiPage === 'lineup' || uiPage === 'lineup-choose') {
    sceneKey = '';
    stage.className = 'game-preview fashion-scene gallery';
    const list = uiPage === 'lineup' ? f.lineup.map(id => f.looks.find(l => l.id === id)).filter(Boolean) : f.looks;
    stage.replaceChildren();
    if (!list.length) stage.append(text('empty-caption', 'No looks yet'));
    list.slice(0, 3).forEach((look, i) => {
      const card = document.createElement('div'); card.className = `gallery-look${look.id === f.selectedLookId ? ' selected' : ''}`;
      card.append(character(look.outfit), text('look-label', String(i + 1))); stage.append(card);
    });
    screen.querySelectorAll('[data-action="look-select"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === f.selectedLookId)));
    ['look-edit', 'look-delete'].forEach(a => disabled(a, undefined, !f.selectedLookId));
    disabled('lineup-add', undefined, !f.selectedLookId || f.lineup.includes(f.selectedLookId) || f.lineup.length >= 3);
    const index = f.lineup.indexOf(f.selectedLookId);
    disabled('lineup-up', undefined, index <= 0); disabled('lineup-down', undefined, index < 0 || index >= f.lineup.length - 1);
    disabled('lineup-remove', undefined, index < 0);
  } else if (f.view === 'show') {
    const id = f.lineup[f.show.index], look = f.looks.find(l => l.id === id);
    scene(look?.outfit || f.draft, `show:${id}:${JSON.stringify(look?.outfit)}`);
    const venue = f.stage.venue;
    stage.className = `game-preview fashion-scene stage-scene venue-${venue} pose-${f.show.pose}${f.show.phase === 'entrance' ? ' show-entrance' : ''}${!active() || f.show.paused ? ' show-paused' : ''}`;
    status.textContent = f.show.paused ? 'Paused' : '';
    const pause = screen.querySelector('[data-action="show-pause"]');
    if (pause) { pause.querySelector('.label-line').textContent = f.show.paused ? 'Resume' : 'Pause'; pause.setAttribute('aria-label', f.show.paused ? 'Resume' : 'Pause'); }
  } else {
    scene(f.draft, JSON.stringify(f.draft));
    if (f.view === 'options' || uiPage.startsWith('picker:')) {
      const field = currentField(), selected = ['venue', 'music'].includes(field) ? f.stage[field] : f.draft[field];
      screen.querySelectorAll('[data-action="option"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === selected)));
    }
    if (f.view === 'stage') { stage.className = `game-preview fashion-scene stage-scene venue-${f.stage.venue}`; disabled('show-start', undefined, f.lineup.length === 0); }
  }
  disabled('undo', undefined, !f.history?.length || f.view === 'show' || f.view === 'studio');
}
function paintConnect() {
  const c = S.connect4;
  stage.replaceChildren();
  const board = document.createElement('div'); board.className = 'connect-board';
  board.setAttribute('role', 'img'); board.setAttribute('aria-label', `Board columns 1 to 7. Player ${c.turn} to play.`);
  const map = document.createElement('div'); map.className = 'board-column-map';
  // Passive column numerals are an explicit 44px fit exception, not command labels.
  for (let i = 1; i <= 7; i++) {
    const number = text('board-column-number', String(i));
    number.dataset.fontReduced = 'passive-board-column-map'; map.append(number);
  }
  const grid = document.createElement('div'); grid.className = 'connect-grid';
  c.board.flat().forEach(v => { const cell = document.createElement('div'); cell.className = `connect-cell player-${v}`; grid.append(cell); });
  const gap = innerWidth < 1500 ? 5 : 10;
  const cell = Math.floor(Math.min((stage.clientWidth - 28 - gap * 6) / 7, (stage.clientHeight - 78 - gap * 5) / 6));
  board.style.setProperty('--counter-size', `${Math.max(15, cell)}px`);
  board.style.setProperty('--counter-gap', `${gap}px`);
  board.append(map, grid); stage.append(board);
  status.dataset.player = String(c.status === 'won' ? c.winner : c.turn);
  status.textContent = c.status === 'won' ? `Player ${c.winner} wins` : c.status === 'draw' ? 'A draw' : c.pendingComputer ? 'Computer' : `Player ${c.turn}`;
  for (let i = 0; i < 7; i++) disabled('connect4-drop', i, c.status !== 'playing' || c.pendingComputer || c.board[0][i] !== 0);
  screen.querySelectorAll('[data-action="connect4-mode"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === c.mode)));
  disabled('undo', undefined, !c.history.length);
}
function paintTiles() {
  const t = S.tiles; stage.replaceChildren(); const board = document.createElement('div'); board.className = 'tiles-board'; board.setAttribute('role', 'img'); board.setAttribute('aria-label', 'Number tile board');
  t.board.flat().forEach(value => { const cell = text(`number-tile${value >= 1024 ? ' large-number' : ''}${value >= 65536 ? ' very-large' : ''}`, value || ''); cell.dataset.power = String(value ? (Math.log2(value) - 1) % 7 + 1 : 0); board.append(cell); }); stage.append(board);
  status.textContent = t.over ? 'No moves' : t.won ? '2048!'  : '';
  disabled('undo', undefined, !t.history.length);
}
function fitLabels() {
  // Explicit, measured exceptions only: ordinary labels remain 74px at both sizes.
  screen.querySelectorAll('.game-control').forEach(el => {
    const label = el.querySelector('.command-label'); if (!label) return;
    el.style.fontSize = ''; el.removeAttribute('data-font-reduced');
    const fits = () => {
      const r = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(label);
      return [...range.getClientRects()].filter(x => x.width > 0).every(x => x.left >= r.left + 5 && x.right <= r.right - 5 && x.top >= r.top + 5 && x.bottom <= r.bottom - 5);
    };
    let size = 74;
    while (!fits() && size > 44) { size -= 2; el.style.fontSize = `${size}px`; }
    if (size < 74) el.dataset.fontReduced = `fit:${el.dataset.action}:${el.dataset.value || ''}`;
  });
}
function render(force = false) {
  const f = S.fashion;
  const key = `${S.view}:${S.pending?.type || ''}:${S.view === 'fashion' ? `${f.view}:${f.editField}:${f.optionPage}:${uiPage}:${f.view === 'collection' ? f.looks.map(l => l.id).join(',') : ''}` : ''}`;
  if (force || key !== renderedKey) { renderedKey = key; renderShell(); }
  if (heading) heading.textContent = topTitle();
  if (!S.pending) {
    if (S.view === 'menu') scene(f.draft, JSON.stringify(f.draft));
    else if (S.view === 'fashion') paintFashion();
    else if (S.view === 'connect4') paintConnect();
    else if (S.view === 'tiles') paintTiles();
  }
  fitLabels(); syncDwell(); schedule();
}
function actionFor(action, value, input = 'unknown') {
  if (!active()) return;
  interrupt();
  const before = S;
  if (action === 'fashion-shape' || action === 'fashion-details' || action === 'collection-actions' || action === 'lineup-order' || action === 'lineup-choose') {
    uiPage = { 'fashion-shape': 'shape', 'fashion-details': 'details', 'collection-actions': 'collection-actions', 'lineup-order': 'lineup', 'lineup-choose': 'lineup-choose' }[action];
  } else if (action === 'stage-venue' || action === 'stage-music') uiPage = `picker:${action === 'stage-venue' ? 'venue' : 'music'}`;
  else if (action === 'lineup-select') { S = reduce(S, { type: 'look-select', value }); uiPage = 'lineup'; }
  else if (action === 'back' && uiPage) { uiPage = ''; }
  else {
    let type = action, arg = value;
    if (action === 'fashion-resume') { type = 'fashion-view'; arg = 'workbench'; }
    if (action === 'fashion-style') { type = 'fashion-view'; arg = 'styling'; }
    if (action === 'fashion-collection') { type = 'fashion-view'; arg = 'collection'; }
    if (action === 'fashion-studio') { type = 'fashion-view'; arg = 'studio'; }
    if (action === 'fashion-new') { type = 'fashion-view'; arg = 'workbench'; }
    if (action === 'option' && uiPage.startsWith('picker:')) { type = uiPage.slice(7); }
    if (action.startsWith('lineup-') && arg === undefined) arg = S.fashion.selectedLookId;
    if (action === 'show-pose') arg = undefined;
    if (action === 'option-page' && S.fashion.optionPage > 0) arg = -1;
    const keepPage = uiPage === 'lineup' && ['lineup-up', 'lineup-down', 'lineup-add', 'lineup-remove'].includes(action);
    S = reduce(S, { type, value: arg });
    if (!keepPage) uiPage = '';
    if (action === 'fashion-save' && !S.pending) S = reduce(S, { type: 'fashion-view', value: 'collection' });
    if (['show-start', 'show-next', 'show-encore'].includes(action)) { showRemaining = 1600; showToken = ''; }
  }
  armMusic(action); const saved = persist(), saveIssued = revision; render();
  if (S !== before && action === 'option') speak(safeLabel(before.fashion.editField || currentField(), value));
  if ((action === 'fashion-save' && !S.pending && S.fashion.looks.length > before.fashion.looks.length) || (action === 'confirm' && before.pending?.type === 'look-replace' && !S.pending)) {
    void saved.then(ok => { if (ok && active() && revision === saveIssued) speak('Your look is kept.'); });
  }
  if (S.view === 'connect4' && S.connect4.status !== before.connect4.status && S.connect4.status !== 'playing') speak(S.connect4.status === 'won' ? `Player ${S.connect4.winner} has four in a row.` : 'A draw.');
  try { fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: 'games', event: action, input, view: S.view }) }).catch(() => {}); } catch {}
}
function mountPartner() {
  partnerButton = document.createElement('button'); partnerButton.type = 'button'; partnerButton.className = 'partner-button'; partnerButton.textContent = 'Partner'; partnerButton.setAttribute('aria-expanded', 'false');
  partnerPanel = document.createElement('aside'); partnerPanel.className = 'partner-panel'; partnerPanel.hidden = true;
  partnerPanel.innerHTML = '<h2>Partner setup and credits</h2><p>The three local games work offline. Hosted games use their own controls and do not inherit these HTML dwell targets. Mouse access alone does not verify gaze access.</p><p><a href="https://prod.games.eyegazegames.com/?game=connect4" target="_blank" rel="noopener">Hosted Four in a Row</a> — use its official tracker/browser setup.</p><p><a href="https://gameaccess.info/gazey-golf-eye-control-options/" target="_blank" rel="noopener">Golf control guidance</a> — the Demo is a video.</p><p><a href="https://pbskids.org/games/play/pinkalicious-fashion-game/66548" target="_blank" rel="noopener">Pinkamagine Fashion</a> — hosted clothing/design choices; independent control review required.</p>';
  const notice = text('', recoveryNotice); notice.id = 'storageNotice'; partnerPanel.append(notice);
  durableCopy = document.createElement('a'); durableCopy.href = '/games/state/recovery'; durableCopy.download = 'games-state-recovery.txt';
  durableCopy.textContent = 'Export unreadable saved Games file'; durableCopy.hidden = true; partnerPanel.append(durableCopy);
  const credits = document.createElement('button'); credits.type = 'button'; credits.textContent = 'Local game credits';
  credits.addEventListener('click', () => { partnerPanel.hidden = true; partnerButton.setAttribute('aria-expanded', 'false'); actionFor('open', 'credits', 'partner'); });
  const backup = document.createElement('button'); backup.type = 'button'; backup.textContent = 'Export recovery copy';
  backup.addEventListener('click', () => {
    try {
      let raw = recoveryOriginal;
      if (!raw) raw = localStorage.getItem(BACKUP_KEY) || (storageBlocked ? localStorage.getItem(STORAGE_KEY) : null); if (!raw) { notice.textContent = 'No recovery copy is needed.'; return; }
      const blob = new Blob([raw], { type: 'text/plain' }), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'games-recovery.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { notice.textContent = 'Recovery storage is unavailable.'; }
  });
  partnerPanel.append(credits, backup);
  partnerButton.addEventListener('click', () => { partnerPanel.hidden = !partnerPanel.hidden; partnerButton.setAttribute('aria-expanded', String(!partnerPanel.hidden)); notice.textContent = recoveryNotice; });
  document.body.append(partnerButton, partnerPanel);
}
function lifecycle(type, value) {
  interrupt(); S = reduce(S, { type, value }); persist();
  if (stage && S.view === 'fashion' && S.fashion.view === 'show') paintFashion();
  syncDwell(); if (!value) { suppress(); schedule(); }
}
document.addEventListener('dwell:activate', e => { if (e.target instanceof Element) origins.add(e.target); });
bar = mountDoorBar(document.body, {
  appPath: '/games/',
  onLock() { interrupt(); musicArmed = false; persist(); syncDwell(); },
  onUnlock() { syncDwell(); },
  onLeave() { interrupt(); musicArmed = false; gone = true; persist(); syncDwell(); return flushBeforeExit(); },
  onPause() { lifecycle('suspend', true); },
  onResume() { lifecycle('suspend', false); },
});
mountPartner();
let migrate = false;
try {
  const controller = new AbortController();
  let timeout;
  try {
    const loadedResponse = await Promise.race([
      (async () => {
        const response = await fetch('/games/state', { signal: controller.signal, cache: 'no-store' });
        return { status: response.status, body: response.status === 200 ? await response.text() : '' };
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(Error('load timeout')); }, 2000); }),
    ]);
    if (loadedResponse.status === 200) {
      const loaded = readSavedState(loadedResponse.body);
      if (!loaded.valid) throw Error('invalid response');
      S = loaded.state;
      saveMessage('Restored');
    } else if (loadedResponse.status === 404) {
      if (localValid) { S = readSavedState(localRaw).state; migrate = true; }
      saveMessage(migrate ? 'Moving save…' : 'Ready');
    } else if (loadedResponse.status === 409) {
      durableBlocked = true;
      durableCopy.hidden = false;
      recoveryNotice = 'The unreadable saved Games file remains untouched in the hub data folder. Export it with the link below. New changes in this session are not saved.';
      saveMessage('Not saved');
    } else throw Error(`load ${loadedResponse.status}`);
  } finally { clearTimeout(timeout); }
} catch {
  durableBlocked = true;
  if (localValid) S = readSavedState(localRaw).state;
  recoveryNotice = 'The hub could not read saved Games progress. This session still works, but new changes are not saved. Existing data was not overwritten.';
  saveMessage('Not saved');
}
try {
  const response = await fetch('art/character.svg');
  if (response.ok) rigTemplate = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement;
} catch { /* A failed decorative asset never blocks commands. */ }
ready = true; render();
if (migrate) void persist();
else if (!durableBlocked) latestSave = serializeState(S);
window.GamesApp = { state: () => ({ ...clone(S), ready }), storageKey: STORAGE_KEY };
if (window.__testHooks) {
  window.GamesApp.test = {
    setState(value) { interrupt(); musicArmed = false; S = restoreState(JSON.stringify(value)); uiPage = ''; renderedKey = ''; showToken = ''; showRemaining = 1600; persist(); render(true); },
    action: (action, value) => actionFor(action, value, 'test'),
    flush: () => saving,
  };
}
try { Promise.resolve(window.Speech?.init('Games')).then(mode => { document.getElementById('voiceWarning').hidden = mode !== 'off'; }).catch(() => {}); } catch {}
fetch('/settings').then(r => r.ok ? r.json() : null).then(settings => {
  if (!settings) return;
  if (Number.isFinite(settings.dwellMs) && settings.dwellMs > 0) { window.Dwell?.setMs(settings.dwellMs); bar.setDwell(settings.dwellMs); }
  if (Number.isFinite(settings.settleMs)) window.Dwell?.set({ settleMs: Math.max(0, Math.min(2000, settings.settleMs)) });
  musicVolCap = Number.isFinite(settings.musicVolCap) ? Math.max(0, Math.min(100, settings.musicVolCap)) / 100 : 1;
  scheduleMusic();
  bar.setPause(settings.pauseGoes === 'tdsnap');
}).catch(() => {});
addEventListener('resize', () => { bar.sizeBar(); if (S.view === 'connect4' && !S.pending) paintConnect(); fitLabels(); suppress(); });
addEventListener('pagehide', () => { interrupt(); musicArmed = false; persist(); });
addEventListener('pageshow', event => {
  if (!event.persisted) return;
  gone = false;
  S = reduce(reduce(S, {type:'suspend',value:false}), {type:'hidden',value:false});
  render(); suppress(); syncDwell();
});
document.addEventListener('visibilitychange', () => lifecycle('hidden', document.visibilityState !== 'visible'));
