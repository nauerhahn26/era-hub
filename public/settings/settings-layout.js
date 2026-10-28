/* Settings navigation keeps the original controls alive while moving them into
   named sections. Changing a section never invokes an application action. */
(() => {
  'use strict';
  const root = document.querySelector('.wrap');
  if (!root || document.getElementById('settingsNav')) return;
  const byId = id => document.getElementById(id);
  const node = (tag, attrs = {}, text = '') => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text) el.textContent = text;
    return el;
  };
  const pages = [
    ['gaze', 'Eye gaze', '◎', 'Comfort & control', 'Make selections feel comfortable and predictable.'],
    ['sound', 'Voice & sound', '♫', 'Comfort & control', 'Choose a speaking voice and comfortable volume limits.'],
    ['apps', 'Apps & navigation', '▦', 'Comfort & control', 'Choose available apps and what the app controls do.'],
    ['books', 'Books', '▤', 'Content', 'Find a book, check its progress, or review its pages.'],
    ['clothing', 'Clothing & weather', '♧', 'Content', 'Keep wardrobe choices and the forecast together.'],
    ['media', 'Writing & media', '✎', 'Content', 'Saved words, films and this week’s learning content.'],
    ['connections', 'Connections', '⇄', 'This computer', 'Set up a service once, then return to what you were doing.'],
    ['system', 'System', '⚙', 'This computer', 'Updates and occasional troubleshooting on this computer.']
  ];
  const pageIds = new Set(pages.map(p => p[0]));
  const sections = new Map();
  const originalCards = Array.from(root.querySelectorAll(':scope > .card'));
  const cardFor = id => byId(id)?.closest('.card');
  const original = {
    apps:cardFor('appsList'), updates:byId('updates'), voice:byId('voice'),
    writing:byId('writing'), drive:byId('integrations'), ai:byId('ai'),
    books:byId('content'), moving:byId('fal'), films:byId('movies'),
    exit:byId('exit'), week:byId('weekVideos'), dwell:cardFor('dwellUp'),
    pencil:cardFor('pencilDwellUp'), settle:cardFor('settleUp'), feel:cardFor('feel'),
    grace:cardFor('grace'), ring:cardFor('ring'), volume:cardFor('deviceVolumeCap'),
    music:cardFor('mvolUp'), lock:byId('lock'), pause:cardFor('paused'), buttons:byId('buttons')
  };
  const shell = node('div', {class:'settings-shell'});
  const sidebar = node('aside', {id:'settingsSidebar', class:'settings-sidebar', 'aria-label':'Settings navigation'});
  const brand = node('div', {class:'settings-brand'});
  brand.append(node('span', {class:'settings-brandmark', 'aria-hidden':'true'}, 'e'));
  const brandText = node('div');
  brandText.append(node('strong', {}, 'Our Era'), node('small', {}, 'Settings'));
  brand.append(brandText);
  const closeMenu = node('button', {type:'button', class:'settings-close-menu', 'aria-label':'Close sections'}, '✕');
  brand.append(closeMenu);
  sidebar.append(brand);
  const searchRegion = node('div', {class:'settings-search', role:'search'});
  const search = node('input', {id:'settingsSearch', type:'search', placeholder:'Search settings', 'aria-label':'Search settings', autocomplete:'off'});
  searchRegion.append(search);
  sidebar.append(searchRegion);
  const nav = node('nav', {id:'settingsNav', 'aria-label':'Settings sections'});
  let previousGroup = '';
  for (const [id, title, icon, group] of pages) {
    if (group !== previousGroup) nav.append(node('div', {class:'settings-nav-group'}, group));
    previousGroup = group;
    const a = node('a', {href:'#' + id});
    a.append(node('span', {class:'settings-nav-icon', 'aria-hidden':'true'}, icon), node('span', {}, title));
    nav.append(a);
  }
  sidebar.append(nav);
  const footer = node('div', {class:'settings-sidebar-footer'});
  footer.append(node('strong', {}, 'This computer'), node('p', {}, 'Preferences are saved here. Content can sync through Drive.'));
  sidebar.append(footer);
  const overlay = node('button', {type:'button', id:'settingsOverlay', class:'settings-overlay', 'aria-label':'Close sections', tabindex:'-1'});
  const main = node('main', {id:'settingsMain', tabindex:'-1'});
  const top = node('div', {class:'settings-topbar'});
  const menu = node('button', {type:'button', id:'settingsMenu', class:'settings-menu', 'aria-label':'Open sections', 'aria-controls':'settingsSidebar', 'aria-expanded':'false'}, '☰');
  const crumb = node('div', {class:'settings-breadcrumb'});
  crumb.append(node('span', {}, 'Settings'), node('span', {'aria-hidden':'true'}, '/'));
  const crumbCurrent = node('strong'); crumb.append(crumbCurrent);
  const back = root.querySelector('header a[href="/home/"]') || node('a', {href:'/home/'}, '← Back to apps');
  back.removeAttribute('style'); back.classList.add('settings-back');
  top.append(menu, crumb, back); main.append(top);
  const heading = node('header', {class:'settings-page-header'});
  const titleBlock = node('div');
  const title = node('h1', {id:'settingsHeading', tabindex:'-1'});
  const description = node('p'); titleBlock.append(title, description);
  heading.append(titleBlock, node('span', {class:'settings-scope'}, 'This computer'));
  root.querySelector(':scope > header')?.remove();
  root.querySelector(':scope > .tag')?.remove();
  root.classList.add('settings-content'); root.prepend(heading);
  for (const [id, label] of pages) {
    const section = node('section', {id:'settings-section-' + id, class:'settings-section', 'data-section':id, 'aria-label':label, hidden:''});
    sections.set(id, section); root.append(section);
  }
  const results = node('section', {id:'settingsSearchResults', class:'settings-search-results', 'aria-label':'Search results', hidden:''});
  root.append(results);
  root.before(shell); main.append(root); shell.append(sidebar, overlay, main);
  const skip = node('a', {href:'#settingsMain', class:'settings-skip'}, 'Skip to settings');
  document.body.prepend(skip);
  skip.addEventListener('click', event => { event.preventDefault(); main.focus(); });
  document.body.classList.add('settings-upgrade'); document.title = 'Our Era Settings';

  function put(card, destination, id) {
    if (!card) return;
    if (!card.id && id) card.id = id;
    sections.get(destination).append(card);
  }
  function newCard(id, title, destination, hint) {
    const card = node('div', {id, class:'card'}); card.append(node('h2', {}, title));
    if (hint) card.append(node('p', {class:'hint'}, hint));
    sections.get(destination).append(card); return card;
  }
  function contextual(card, text, hash) {
    const p = node('p', {class:'settings-context-link'});
    p.append(node('a', {href:'#' + hash}, text)); card.append(p);
  }
  put(original.apps,'apps','settings-apps'); put(original.exit,'apps'); put(original.lock,'apps');
  put(original.updates,'system'); put(original.books,'books');
  for (const key of ['dwell','pencil','settle','feel','grace','ring','pause']) put(original[key],'gaze','settings-'+key);
  for (const key of ['voice','volume','music']) put(original[key],'sound','settings-'+key);
  for (const key of ['drive','ai','moving','films']) put(original[key],'connections');
  put(original.buttons,'connections');
  put(original.week,'media');

  const voiceSetup = byId('ttsKey')?.closest('.row')?.parentElement;
  if (voiceSetup && original.voice?.contains(voiceSetup)) {
    const connection = newCard('voiceConnection','Recorded voice service','connections');
    connection.append(voiceSetup);
    contextual(original.voice, 'Manage the recorded voice service →', 'connections/voice');
  }
  if (original.writing) {
    original.writing.id = 'emailConnection';
    original.writing.querySelector('h2').textContent = 'Writing email';
    put(original.writing,'connections');
    const writing = newCard('writing','Writing from The Pencil','media','Messages sent from The Pencil are kept here.');
    if (byId('writings')) writing.append(byId('writings'));
    const writingPager = byId('writingPageCount')?.closest('.settings-books-pagination');
    if (writingPager) writing.append(writingPager);
    contextual(writing,'Manage writing email →','connections/email');
  }
  const weather = newCard('weather','Weather for outfits','clothing','Choose the place and hours used for outfits on this computer.');
  for (const id of ['wxPlace','wxPlaceHits','wxWindow','wxHint']) if (byId(id)) weather.append(byId(id));
  const wardrobe = newCard('wardrobe','Wardrobe & outfits','clothing','Clothing preparation, favourites and accessories.');
  const prep = node('div', {id:'clothingPrepStatus', class:'status'}); wardrobe.append(prep);
  for (const id of ['picksStatus','accStatus']) if (byId(id)) wardrobe.append(byId(id));
  const aiStatus = byId('aiStatus');
  if (aiStatus) {
    const mirror = () => { prep.innerHTML = aiStatus.innerHTML; prep.className = aiStatus.className; };
    mirror(); new MutationObserver(mirror).observe(aiStatus,{childList:true,subtree:true,characterData:true,attributes:true});
  }
  const outfits = byId('dlOutfitsNow');
  if (outfits) {
    const actions = node('div', {class:'row settings-outfit-actions'}); actions.append(outfits); wardrobe.append(actions);
    const source = byId('dlAlways');
    if (source) {
      const mirror = () => { actions.hidden = source.style.display === 'none'; };
      mirror(); new MutationObserver(mirror).observe(source,{attributes:true,attributeFilter:['style']});
    }
  }
  contextual(wardrobe,'Manage Drive and the AI helper →','connections');
  if (original.pause) {
    const danger = original.pause.querySelector('.danger-zone');
    if (danger) {
      const maintenance = newCard('engineMaintenance','Release the eye tracker','system');
      maintenance.append(danger);
      const offline = node('div', {class:'settings-engine-offline'}); maintenance.append(offline);
      const pauseControls = byId('pauseControls'), stopped = byId('stoppedBlock');
      const mirror = () => {
        const isStopped = pauseControls?.style.display === 'none';
        danger.hidden = isStopped;
        offline.hidden = !isStopped;
        if (stopped) offline.innerHTML = stopped.innerHTML;
      };
      mirror();
      if (pauseControls) new MutationObserver(mirror).observe(pauseControls,{attributes:true,attributeFilter:['style']});
      if (stopped) new MutationObserver(mirror).observe(stopped,{childList:true,subtree:true,attributes:true});
      contextual(original.pause,'Complete stop and restart guidance →','system');
    }
  }
  const mediaHelp = newCard('mediaServices','Films, shows & moving pages','media','Film links work without a lookup key. Optional services add search, posters and moving book pages.');
  contextual(mediaHelp,'Manage film lookup and country →','connections/films');
  contextual(mediaHelp,'Set up moving book pages →','connections/moving');
  contextual(mediaHelp,'Open book setup →','books/setup');
  // A newly added original card remains reachable even before it has a named
  // place in this registry. It must never disappear during an upgrade.
  for (const card of originalCards) if (!card.closest('.settings-section')) sections.get('system').append(card);

  const aliases = {
    content:['books','content','library'], integrations:['connections','integrations'],
    voice:['sound','voice'], ai:['connections','ai'], fal:['connections','fal'],
    movies:['connections','movies'], writing:['media','writing'], exit:['apps','exit'],
    weekVideos:['media','weekVideos'], lock:['apps','lock'], updates:['system','updates'],
    contentTiers:['books','contentTiers','setup']
  };
  const connectionTargets = {drive:'integrations',ai:'ai',voice:'voiceConnection',email:'emailConnection',moving:'fal',films:'movies',buttons:'buttons'};
  const searchIndex = [
    ['gaze','settings-dwell','Dwell time','Dwell, hold, selection timing'],
    ['gaze','settings-pencil','Alternative Pencil dwell time','Pencil, writing, letter selection'],
    ['gaze','settings-settle','Page-change pause','Settle, page, delay'],
    ['gaze','settings-feel','Cursor feel','Cursor smoothing, calm, jumpy, responsive'],
    ['gaze','settings-grace','Look-away forgiveness','Grace, glance, progress'],
    ['gaze','settings-ring','Cursor visible','Ring, show, hide cursor'],
    ['gaze','settings-pause','Pause eye gaze','Temporary pause, testing, running'],
    ['sound','voice','Speaking voice','Speech, narration, talking voice'],
    ['sound','settings-volume','Volume cap for this device','Speaker, audio, volume, loudness, limit'],
    ['sound','settings-music','Music volume cap','Songs, music, volume, loudness'],
    ['apps','settings-apps','Apps on this computer','Apps, shortcuts, hide, install'],
    ['apps','exit','Where the door goes','Exit, door, home, talker'],
    ['apps','lock','App locks','Passcode, pin, music, films, books, drawing, math, games, chat, duration'],
    ['books','content','Book library','Books, reading, review, rename, build'],
    ['clothing','weather','Weather for outfits','Weather, location, place, town, zip, hours'],
    ['clothing','wardrobe','Wardrobe and outfits','Clothes, clothing, favourites, accessories, photos'],
    ['media','writing','Writing from The Pencil','Writing, saved words, messages'],
    ['media','weekVideos','This week’s videos','Videos, download, week, lessons'],
    ['connections','integrations','Drive folder and sync','Drive, folder, integration, sync'],
    ['connections','ai','AI helper','AI, key, content preparation'],
    ['connections','voiceConnection','Recorded voice service','Voice key, narration, allowance'],
    ['connections','emailConnection','Writing email','Email, delivery, key, send'],
    ['connections','fal','Moving pages','Animation, video, book pages, key'],
    ['connections','movies','Films and shows','Film, movies, shows, posters, country, key'],
    ['connections','buttons','Buttons','Flic, button, press, ask, square'],
    ['system','updates','Updates','Update, version, build, installed'],
    ['system','engineMaintenance','Stop eye gaze completely','Stop, shutdown, release, tracker, testing']
  ];
  let active = '', searching = false;
  const scrollPositions = new Map();
  const scrollStorageKey = 'era-settings-scroll';
  let pendingScroll = null, persistTimer;
  try {
    const stored = JSON.parse(sessionStorage.getItem(scrollStorageKey) || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [section,position] of Object.entries(stored)) {
        if (pageIds.has(section) && typeof position === 'number' && Number.isFinite(position) && position >= 0 && position <= 10000000) scrollPositions.set(section,Math.floor(position));
      }
    }
  } catch {}
  function persistScroll() {
    clearTimeout(persistTimer); persistTimer = undefined;
    if (active && !searching && !pendingScroll) scrollPositions.set(active,main.scrollTop);
    try { sessionStorage.setItem(scrollStorageKey,JSON.stringify(Object.fromEntries(scrollPositions))); } catch {}
  }
  function finishScrollRestore() {
    if (!pendingScroll || pendingScroll.section !== active) return;
    main.scrollTop = pendingScroll.position;
    pendingScroll = null;
  }
  main.addEventListener('scroll',() => {
    if (!active || searching || pendingScroll) return;
    scrollPositions.set(active,main.scrollTop);
    clearTimeout(persistTimer); persistTimer = setTimeout(persistScroll,100);
  },{passive:true});
  // A delayed content response must not pull the page away after the person has
  // started interacting. Only the initial, untouched restore can remain pending.
  function cancelScrollRestore() { if (pendingScroll) { pendingScroll = null; persistScroll(); } }
  for (const type of ['wheel','touchstart','pointerdown','keydown']) main.addEventListener(type,cancelScrollRestore,{passive:true});
  window.addEventListener('pagehide',persistScroll);
  document.addEventListener('era-settings-content',event => {
    if (pendingScroll?.section === event.detail?.section) finishScrollRestore();
  });
  const narrow = matchMedia('(max-width: 760px)');
  function placeSearchResults() {
    const inSidebar = narrow.matches && searching && document.body.classList.contains('settings-nav-open');
    if (inSidebar) sidebar.insertBefore(results,nav); else root.append(results);
    nav.hidden = inSidebar;
    results.classList.toggle('settings-search-in-sidebar',inSidebar);
  }
  function closeDrawer(restoreFocus = false) {
    document.body.classList.remove('settings-nav-open'); menu.setAttribute('aria-expanded','false');
    main.inert = false; placeSearchResults();
    if (restoreFocus) menu.focus();
  }
  function openDrawer() {
    document.body.classList.add('settings-nav-open'); menu.setAttribute('aria-expanded','true');
    main.inert = true; placeSearchResults(); search.focus();
  }
  menu.addEventListener('click',openDrawer);
  overlay.addEventListener('click',() => closeDrawer(true));
  closeMenu.addEventListener('click',() => closeDrawer(true));
  narrow.addEventListener('change',() => closeDrawer());
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Escape' && narrow.matches) { event.preventDefault(); closeDrawer(true); }
    if (event.key !== 'Tab' || !narrow.matches || !document.body.classList.contains('settings-nav-open')) return;
    const focusable = Array.from(sidebar.querySelectorAll('button, input, a')).filter(el=>el.getClientRects().length && !el.disabled);
    const first = focusable[0], last = focusable[focusable.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  function route(initial = false) {
    let hash = '';
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch {}
    let remembered = '';
    try { remembered = sessionStorage.getItem('era-settings-section') || ''; } catch {}
    if (!hash) hash = pageIds.has(remembered) ? remembered : 'gaze';
    const [base, sub] = hash.split('/');
    const alias = aliases[hash];
    let section = alias?.[0] || (pageIds.has(base) ? base : '');
    let target = alias?.[1] || '';
    let subview = alias?.[2] || (base==='books' && ['library','activity','setup'].includes(sub) ? sub : 'library');
    if (base==='connections' && connectionTargets[sub]) target = connectionTargets[sub];
    if (!section && byId(hash)?.closest('.settings-section')) { section = byId(hash).closest('.settings-section').dataset.section; target = hash; }
    if (!section) section = 'gaze';
    if (active && !searching && !pendingScroll) scrollPositions.set(active, main.scrollTop);
    pendingScroll = null;
    active = section; document.body.dataset.settingsSection = section; searching = false; search.value = ''; results.hidden = true;
    for (const [id, el] of sections) el.hidden = id !== section;
    for (const a of nav.querySelectorAll('a')) {
      if (a.hash === '#' + section) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    }
    const page = pages.find(p=>p[0]===section);
    title.textContent = page[1]; description.textContent = page[4]; crumbCurrent.textContent = page[1];
    heading.querySelector('.settings-scope').textContent = section==='books' ? 'Drive content' : 'This computer';
    try { sessionStorage.setItem('era-settings-section',section); } catch {}
    closeDrawer();
    document.dispatchEvent(new CustomEvent('era:settings-route',{detail:{section,subview,fragment:hash}}));
    document.dispatchEvent(new CustomEvent('era-settings-section',{detail:{section,subview,fragment:hash}}));
    if (section==='books') window.ERA_SETTINGS_BOOKS_VIEW?.(subview);
    const savedPosition = scrollPositions.get(section);
    const restoresLibrary = target === 'content' && savedPosition !== undefined;
    const destination = target && !restoresLibrary ? byId(target) : null;
    if (!destination && savedPosition !== undefined) {
      pendingScroll = {section,position:savedPosition};
      if (section !== 'books' || byId('content')?.dataset.settingsContentReady === 'true') finishScrollRestore();
      else main.scrollTop = savedPosition;
    } else main.scrollTop = 0;
    if (destination && !destination.closest('[hidden]')) destination.scrollIntoView({block:'start'});
    persistScroll();
    if (!initial) {
      const focus = destination?.querySelector('h2') || title;
      focus.setAttribute('tabindex','-1'); focus.focus({preventScroll:true});
    }
  }
  function navigate(hash) {
    const value = String(hash || '').replace(/^#/,'');
    if (location.hash === '#' + value) route(); else location.hash = value;
  }
  function searchSettings() {
    const query = search.value.trim().toLowerCase();
    if (!query) { route(); search.focus(); return; }
    if (!searching) scrollPositions.set(active, main.scrollTop);
    searching = true;
    for (const el of sections.values()) el.hidden = true;
    results.hidden = false; results.replaceChildren(); placeSearchResults();
    title.textContent = 'Search settings'; crumbCurrent.textContent = 'Search';
    const words = query.split(/\s+/);
    const matches = searchIndex.filter(entry => words.every(w => entry.join(' ').toLowerCase().includes(w)));
    description.textContent = matches.length + ' result' + (matches.length===1?'':'s') + ' for “' + search.value.trim() + '”';
    for (const [section,target,label,summary] of matches) {
      if (!byId(target)) continue;
      const a = node('a',{href:'#'+target,class:'settings-search-result'});
      a.append(node('span',{class:'settings-result-path'},pages.find(p=>p[0]===section)[1]), node('strong',{},label), node('p',{},summary));
      a.addEventListener('click',() => { if (location.hash === a.hash) route(); });
      results.append(a);
    }
    if (!matches.length) results.append(node('p',{class:'settings-no-results'},'No settings found. Try volume, weather, dwell or books.'));
    main.scrollTop = 0;
  }
  search.addEventListener('input',searchSettings);
  nav.addEventListener('click', event => {
    const a = event.target.closest('a'); if (!a) return;
    if (location.hash === a.hash) { event.preventDefault(); route(); }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='k') {
      event.preventDefault(); if (narrow.matches) openDrawer(); else search.focus();
    }
  });
  window.addEventListener('hashchange',() => route());
  window.ERASettingsLayout = {navigate, sections:pageIds, get section(){return active;}};
  route(true);
  document.dispatchEvent(new CustomEvent('era-settings-ready'));
})();
