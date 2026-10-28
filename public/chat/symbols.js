// Decorative communication pictures for Chat tiles. Words remain the source of meaning.
// Library pictures (spec 2026-10-27 §6): the vocabulary table (public/chat/vocabulary.json,
// concept words and pictogram ids only) names one picture per concept; the image comes
// from this hub's own /symbol/<id> cache, never from another host. When a picture
// cannot load, the Drawing app's emoji stickers stand in, then the drawings below.
// The drawings below are original native vector drawings, part of this project and
// covered by the repository's MPL-2.0 LICENSE. Library pictures and the emoji stickers
// keep their own licences and credit (settings page, public/drawing/stickers/LICENSE).
const NS = 'http://www.w3.org/2000/svg';
const path = d => ['path', { d }];
const circle = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }];
const rect = (x, y, width, height, extra = {}) => ['rect', { x, y, width, height, ...extra }];
const eyes = [circle(23, 26, 2, { fill: 'currentColor', stroke: 'none' }), circle(41, 26, 2, { fill: 'currentColor', stroke: 'none' })];
const face = mouth => [circle(32, 32, 25), ...eyes, path(mouth)];
const bubble = path('M9 10h46v32H29L16 54V42H9z');
const book = [path('M32 15C24 9 14 9 5 13v37c9-4 19-4 27 2 8-6 18-6 27-2V13c-9-4-19-4-27 2z'), path('M32 15v37')];
const note = [path('M25 45V15l27-6v30M25 23l27-6'), ['ellipse', { cx: 17, cy: 47, rx: 8, ry: 6 }], ['ellipse', { cx: 44, cy: 41, rx: 8, ry: 6 }]];
const shapes = {
  yes: [circle(32, 32, 25), path('m18 32 10 10 19-21')],
  no: [circle(32, 32, 25), path('m22 22 20 20m0-20L22 42')],
  chat: [path('M5 9h38v28H24L13 47V37H5zM43 24h16v28H46L36 60V47')],
  hello: [path('M22 54c-6-6-10-13-13-20-2-5 3-8 6-4l7 9V15c0-6 7-6 7 0v17-22c0-6 7-6 7 0v22-19c0-6 7-6 7 0v21-13c0-6 7-6 7 0v23c0 10-8 15-16 15-5 0-9-2-12-5z'), path('M6 13 3 8M12 8l-1-5M54 11l5-4M57 18l5-1')],
  feelings: [circle(23, 15, 8), path('M6 54v-8c0-12 12-18 23-14M41 54 29 42c-8-9 3-18 12-9 9-9 20 0 12 9z')],
  sit: [path('M15 8v29h35v10H14M20 47v11m25-11v11M25 17h19v20M8 26h10m29 0h10v15')],
  more: [bubble, path('M23 25h18m-9-9v18')],
  reactions: [circle(27, 35, 23), path('M14 32h1m24 0h1M16 42q11 11 22 0M48 5l3 8 8 3-8 3-3 8-3-8-8-3 8-3z')],
  news: [rect(8, 9, 48, 46, { rx: 3 }), rect(16, 18, 13, 13), path('M37 18h10m-10 10h10M16 39h31M16 47h31')],
  repair: [bubble, path('M25 21c0-10 18-10 18 0 0 5-9 5-9 11m0 5h.1')],
  back: [path('M29 14 12 31l17 17M13 31h27c11 0 15 7 15 17')],
  laugh: [...face('M17 36h30c-3 21-27 21-30 0z'), path('m16 26 6-4 6 4m8 0 6-4 6 4')],
  love: [path('M32 55 10 34C-8 14 17-2 32 17 47-2 72 14 54 34z')],
  surprised: [circle(32, 32, 25), ...eyes, ['ellipse', { cx: 32, cy: 43, rx: 6, ry: 8 }]],
  unfair: [path('M32 9v46M19 56h26M10 22l44-8M16 21 7 39h18zm32-5-9 18h18z')],
  time: [path('M16 6h32M16 58h32M20 6v12c0 8 24 20 24 28v12M44 6v12c0 8-24 20-24 28v12M22 49h20')],
  clarify: [bubble, path('m24 20 17 15m0-15L24 35')],
  'yes-no': [circle(17, 25, 13), path('m10 25 5 5 9-11'), circle(47, 40, 13), path('m42 35 10 10m0-10L42 45')],
  again: [path('M52 24A22 22 0 1 0 53 43M52 9v16H36')],
  unsure: [circle(32, 32, 25), path('M23 23c0-13 23-13 23 0 0 7-13 8-13 17m0 7h.1')],
  repeat: [path('M44 11H12v29h11M33 52a15 15 0 1 0-1-24m1-10v11H22'), path('M22 19h13')],
  help: [circle(32, 32, 25), circle(32, 32, 12), path('m14 14 9 9m18 18 9 9m-36 0 9-9m18-18 9-9')],
  music: note,
  book,
  outside: [circle(15, 14, 7), path('M15 3V2M3 14H2m22-9 3-3M4 4 2 2M43 58V35M29 35h28L44 14zM6 58h52')],
  drink: [path('M12 21h34v28c0 11-34 11-34 0zM46 26h5c13 0 13 18 0 18h-5M20 12V5m11 7V5m11 7V5')],
  food: [path('M13 7v18m-7-18v12c0 9 14 9 14 0V7M13 27v31M45 7c-12 0-12 24 0 24s12-24 0-24zm0 24v27')],
  draw: [path('m12 43 29-32c5-5 15 4 10 9L22 52 9 56zM36 17l10 9M12 43l10 9M30 57h24')],
  video: [rect(6, 8, 52, 48, { rx: 3 }), path('m27 23 16 10-16 10zM16 8v48M48 8v48M6 21h10M6 43h10M48 21h10M48 43h10')],
  friends: [circle(22, 17, 9), circle(46, 20, 8), path('M5 55v-9c0-19 34-19 34 0v9M43 35c14 0 16 7 16 16v4')],
  play: [rect(6, 30, 24, 25, { rx: 3 }), circle(45, 43, 14), path('m9 20 13-15 13 15zM15 40h6m-3-3v6')],
  happy: face('M18 37q14 18 28 0'),
  sad: face('M18 46q14-18 28 0'),
  tired: [path('M44 7a25 25 0 1 0 13 34C31 49 20 20 44 7z'), path('M43 18h12L43 30h12')],
};

function normal(value) {
  if (typeof value !== 'string' || value.length > 800 || /[<>\x00-\x1f]/.test(value)) return '';
  return value.normalize('NFKC').toLowerCase().replace(/['’]/g, '').replace(/[?.!,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const fixed = new Map([
  ['yes', 'yes'], ['no', 'no'], ['hi', 'hello'], ['hello', 'hello'], ['hey', 'hello'],
  ['whats up', 'chat'], ['how are you', 'feelings'], ['come sit with me', 'sit'],
  ['tell me more', 'more'], ['reactions', 'reactions'], ['my news', 'news'],
  ['help me say it', 'repair'], ['back to chat', 'back'], ['thats funny', 'laugh'],
  ['i love that', 'love'], ['no way', 'surprised'], ['thats not fair', 'unfair'],
  ['give me more time', 'time'], ['i need a moment', 'time'], ['a moment', 'time'],
  ['thats not what i meant', 'clarify'], ['ask me yes or no', 'yes-no'],
  ['let me try again', 'again'], ['try again', 'again'], ['im not sure', 'unsure'],
  ['i am not sure', 'unsure'], ['not sure', 'unsure'], ['please say that again', 'repeat'],
  ['can you say that again', 'repeat'], ['can i help you', 'help'], ['offer help', 'help'],
  ['give me a clue', 'unsure'], ['can you give me a clue', 'unsure'],
  ['another way', 'repair'], ['let me tell you another way', 'repair'],
  ['not now', 'no'], ['no thanks', 'no'], ['no thank you', 'no'], ['something else', 'again'],
  ['no worries', 'chat'], ['no problem', 'chat'], ['not bad', 'chat'],
  ['i dont know', 'unsure'], ['i do not know', 'unsure'], ['no idea', 'unsure'],
]);
const concepts = [
  ['music', /\b(?:music|song|songs|sing|singing)\b/],
  ['book', /\b(?:story|stories|book|books|read|reading)\b/],
  ['outside', /\b(?:outside|outdoors|park|garden|playground)\b/],
  ['drink', /\b(?:drink|water|juice|milk|thirsty)\b/],
  ['food', /\b(?:food|eat|eating|lunch|dinner|breakfast|snack|hungry)\b/],
  ['draw', /\b(?:draw|drawing|paint|painting|colour|color|picture)\b/],
  ['video', /\b(?:film|movie|video)\b/],
  ['friends', /\b(?:friend|friends|together)\b/],
  ['play', /\b(?:game|games|play|playing|toy|toys)\b/],
  ['happy', /\b(?:happy|good)\b/],
  ['sad', /\bsad\b/],
  ['tired', /\b(?:tired|sleep|sleepy|rest)\b/],
  ['love', /\b(?:love|like)\b/],
];
function meaning(text) {
  if (!text) return null;
  if (fixed.has(text)) return fixed.get(text);
  // A picture must not turn a refusal or a negated feeling into agreement.
  if (/^(?:no|not)\s+(?:(?:a|the|any)\s+)?(?:music|story|stories|book|books|food|drink|game|games)(?: please| thanks)?$|\b(?:dont|do not)\s+(?:want|like|need|choose|prefer)\b/.test(text)) return 'no';
  if (/\b(?:no|not|never|dont|isnt|arent|wasnt|werent|cant|cannot|wont|without)\b/.test(text)) return 'chat';
  const matches = concepts.filter(([, expression]) => expression.test(text)).map(([name]) => name);
  if (matches.some(name => ['outside', 'music', 'book'].includes(name)) && matches.includes('play')) matches.splice(matches.indexOf('play'), 1);
  // Show the concrete topic of an explicit phrase such as "I like music";
  // broad social or feeling words do not erase an otherwise clear subject.
  const concrete = matches.filter(name => !['love', 'happy', 'sad', 'tired', 'friends'].includes(name));
  if (concrete.length === 1) return concrete[0];
  return matches.length === 1 ? matches[0] : matches.length ? 'chat' : null;
}

export function resolveSymbol({ label = '', type = '', say = '' } = {}) {
  // The question strip (spec 2026-10-28 §1) is the partner's words: never a picture.
  if (['rest', 'waiting', 'emptyStory', 'question'].includes(type)) return null;
  if (type === 'yes' || type === 'no') return type;
  // Invalid label text never becomes an executable SVG attribute or a guessed
  // concept derived from partially stripped markup.
  const title = normal(label);
  if (label && !title) return 'chat';
  return meaning(title) || meaning(normal(say)) || 'chat';
}

export function createSymbol(options = {}, document = globalThis.document) {
  const name = resolveSymbol(options);
  if (!name) return null;
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ class: 'chat-symbol', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': '4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
  for (const [tag, attributes] of shapes[name]) {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    svg.appendChild(element);
  }
  return svg;
}

export function attachSymbol(tile, options = {}) {
  tile.querySelector('.chat-symbol')?.remove();
  tile.classList.remove('has-symbol'); delete tile.dataset.symbol;
  const svg = createSymbol(options, tile.ownerDocument);
  if (!svg) return null;
  tile.insertBefore(svg, tile.querySelector('.label'));
  tile.classList.add('has-symbol'); tile.dataset.symbol = resolveSymbol(options);
  return svg;
}

// ---- library pictures --------------------------------------------------------
let library = null;
const PICTURE_TYPES = new Set(['rest', 'waiting', 'emptyStory', 'question']);
// Drawing's shipped emoji stickers (MIT), reused by keyword as the backup.
const EMOJI = {
  home: 'house', horse: 'horse', tree: 'tree', forest: 'tree', nature: 'tree', garden: 'tree', sun: 'sun', sunny: 'sun', hot: 'sun',
  cloudy: 'cloud', weather: 'cloud', rain: 'cloud', star: 'star', favourite: 'star', people: 'person', me: 'person', boy: 'person',
  girl: 'person', draw: 'mode-draw', write: 'mode-draw', pencil: 'mode-draw', friend: 'mode-people', family: 'mode-people',
  hug: 'mode-people', outside: 'mode-places', park: 'mode-places', mountains: 'mode-places', camping: 'mode-places',
};
// The drawn shape that stands for a concept when neither picture loads.
const DRAWN = {
  wow: 'reactions', funny: 'laugh', angry: 'unfair', wait: 'time', mistake: 'clarify', question: 'yes-no', 'not sure': 'unsure',
  "don't know": 'unsure', 'say again': 'repeat', eat: 'food', friend: 'friends', game: 'play', 'not now': 'time',
};
const FROM_DRAWN = { reactions: 'wow', repair: 'help', laugh: 'funny', unfair: 'angry', clarify: 'mistake', 'yes-no': 'question',
  unsure: 'not sure', repeat: 'say again', friends: 'friend' };

export function setVocabulary(table) {
  if (!table || !Array.isArray(table.concepts) || !table.concepts.length || !table.phrases) { library = null; return false; }
  const byWord = new Map(table.concepts.map(concept => [concept.word, concept]));
  const byId = new Map(table.concepts.map(concept => [concept.id, concept]));
  const forms = new Map();
  for (const concept of table.concepts) for (const form of [concept.word, ...(concept.alt || [])]) forms.set(normal(form), concept.word);
  library = { byWord, byId, forms, phrases: new Map(Object.entries(table.phrases)), fallback: byWord.get(table.fallback || 'chat') };
  return !!library.fallback;
}
export async function loadVocabulary(fetcher = globalThis.fetch, url = '/chat/vocabulary.json') {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? setVocabulary(await response.json()) : setVocabulary(null);
  } catch { return setVocabulary(null); }
}
export function hasVocabulary() { return !!library; }

// One of the family's own people, from the hub's /characters/<slug>.png route only.
const PERSON_SRC = /^\/characters\/[a-z0-9][a-z0-9-]{0,39}\.png$/;
function personFor(picture, symbol) {
  return picture && typeof picture.src === 'string' && PERSON_SRC.test(picture.src)
    ? { word: typeof symbol === 'string' && symbol.length <= 64 ? symbol : '', id: null, src: picture.src, person: true } : null;
}
function conceptFor({ label = '', type = '', say = '', symbol, symbolId, picture } = {}) {
  if (PICTURE_TYPES.has(type)) return null;
  const person = type === 'response' || type === 'static' ? personFor(picture, symbol) : null;
  if (person) return person;
  if (type === 'yes' || type === 'no') return library.byWord.get(type) || null;
  const picked = library.byId.get(Number(symbolId));
  if (picked && (!symbol || picked.word === symbol)) return picked;
  // A library picture the hub chose from its word index (spec §6): an id paired
  // with a word the table lacks ("lasagna") is shown as a concept of its own,
  // from /symbol/<id> like every other; offline it falls to the drawn bubble.
  if (Number.isSafeInteger(Number(symbolId)) && Number(symbolId) > 0 && typeof symbol === 'string' && symbol &&
    symbol.length <= 64 && !library.byWord.has(symbol)) return { word: symbol, id: Number(symbolId) };
  if (typeof symbol === 'string' && library.byWord.has(symbol)) return library.byWord.get(symbol);
  const title = normal(label), spoken = normal(say);
  const word = library.phrases.get(title) || library.phrases.get(spoken) ||
    library.forms.get(title) || library.forms.get(title.replace(/^(?:a|an|the|some)\s+/, ''));
  if (word) return library.byWord.get(word);
  if (label && !title) return library.fallback;
  const drawn = resolveSymbol({ label, type, say });
  return library.byWord.get(FROM_DRAWN[drawn] || drawn) || library.fallback;
}
function sourceFor(id, variant) { return `/symbol/${id}${variant === 'bw' ? '?color=false' : ''}`; }
function emojiFor(word) { return EMOJI[word] ? `/drawing/stickers/${EMOJI[word]}.png` : null; }
function drawnFor(word) { return shapes[DRAWN[word] || word] ? DRAWN[word] || word : 'chat'; }

// One page of tiles: the corner yes/no tiles, then routes and fixed phrases,
// then replies claim pictures, so a reply never takes a picture from a tile
// whose place she has learned. A repeat takes the concept's alternate
// picture, then the bubble; when both are taken the tile shows its words alone.
export function planPictures(entries, { variant = 'color' } = {}) {
  if (!library) return entries.map(() => null);
  const rank = entry => entry.type === 'yes' || entry.type === 'no' ? 0 : entry.type === 'route' ? 1 : entry.type === 'response' ? 3 : 2;
  const order = entries.map((entry, index) => index).sort((a, b) => rank(entries[a]) - rank(entries[b]) || a - b);
  const used = new Set(), shown = new Set(), plan = entries.map(() => null);
  for (const index of order) {
    const concept = conceptFor(entries[index]);
    if (!concept) continue;
    // A person's own picture: shown once a page, in every style; on error the bubble.
    if (concept.person) {
      if (shown.has(concept.src)) continue;
      shown.add(concept.src);
      plan[index] = { word: concept.word, id: null, kind: 'person', src: concept.src, emoji: null, drawn: 'chat' };
      continue;
    }
    const options = [[concept.id, concept.word], [concept.altId, concept.word], [library.fallback.id, library.fallback.word]];
    const [id, word] = options.find(([candidate]) => candidate && !used.has(candidate)) || [];
    if (!id) continue;
    const emoji = emojiFor(word);
    const kind = variant === 'emoji' ? (emoji ? 'emoji' : 'drawn') : 'library';
    // The emoji style shows stickers and drawings, which repeat across concepts.
    const look = kind === 'emoji' ? emoji : kind === 'drawn' ? 'drawn:' + drawnFor(word) : id;
    if (shown.has(look)) continue;
    used.add(id); shown.add(look);
    plan[index] = { word, id, kind, src: kind === 'library' ? sourceFor(id, variant) : kind === 'emoji' ? emoji : null, emoji, drawn: drawnFor(word) };
  }
  return plan;
}

function drawnPicture(name, document) {
  const svg = createSymbol({ label: '', say: '' }, document);
  svg.replaceChildren();
  for (const [tag, attributes] of shapes[name] || shapes.chat) {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    svg.appendChild(element);
  }
  return svg;
}
export function attachPicture(tile, plan, onChange) {
  tile.querySelector('.chat-symbol')?.remove();
  tile.classList.remove('has-symbol');
  for (const key of ['symbol', 'symbolId', 'picture']) delete tile.dataset[key];
  if (!plan) return null;
  const document = tile.ownerDocument;
  const place = element => { tile.insertBefore(element, tile.querySelector('.label')); return element; };
  const drawn = () => {
    tile.querySelector('.chat-symbol')?.remove();
    place(drawnPicture(plan.drawn, document)); tile.dataset.picture = 'drawn'; onChange?.(tile);
  };
  tile.classList.add('has-symbol');
  tile.dataset.symbol = plan.word;
  if (plan.id) tile.dataset.symbolId = String(plan.id);
  if (!plan.src) { drawn(); return tile.querySelector('.chat-symbol'); }
  const img = document.createElement('img');
  img.className = 'chat-symbol'; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.draggable = false; img.decoding = 'async';
  tile.dataset.picture = plan.kind;
  img.addEventListener('error', () => {
    if (tile.dataset.picture === 'library' && plan.emoji) { tile.dataset.picture = 'emoji'; img.src = plan.emoji; onChange?.(tile); }
    else drawn();
  });
  img.src = plan.src;
  return place(img);
}
