import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/chat/symbols.js', import.meta.url), 'utf8');
const vocabulary = JSON.parse(await readFile(new URL('../public/chat/vocabulary.json', import.meta.url), 'utf8'));
const { resolveSymbol, createSymbol, attachSymbol, setVocabulary, planPictures, attachPicture, attachBadge, badgeOf } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('fixed phrases have distinct familiar navigation, reaction and repair symbols', () => {
  const cases = [
    ['yes', 'yes'], ['no', 'no'], ['Hi!', 'hello'], ["What's up?", 'chat'],
    ['How are you?', 'feelings'], ['Come sit with me.', 'sit'],
    ['Tell me more', 'more'], ['Reactions', 'reactions'], ['My news', 'news'],
    ['Help me say it', 'repair'], ['Back to Chat', 'back'],
    ["That's funny!", 'laugh'], ['I love that!', 'love'], ['No way!', 'surprised'],
    ["That's not fair!", 'unfair'], ['Give me more time.', 'time'],
    ["That's not what I meant.", 'clarify'], ['Ask me yes or no.', 'yes-no'],
    ['Let me try again.', 'again'], ["I'm not sure", 'unsure'],
    ['Please say that again', 'repeat'], ['Can I help you?', 'help'],
  ];
  for (const [label, symbol] of cases) assert.equal(resolveSymbol({ label }), symbol, label);
  assert.equal(resolveSymbol({ label: 'Something', type: 'yes' }), 'yes');
  assert.equal(resolveSymbol({ label: 'Something', type: 'no' }), 'no');
});

test('dynamic concepts use the label first and spoken words when the label has no mapping', () => {
  const cases = [
    ['Music', 'music'], ['A story', 'book'], ['Play outside', 'outside'],
    ['A drink please', 'drink'], ['Something to eat', 'food'], ['Draw a picture', 'draw'],
    ['Watch a film', 'video'], ['My friends', 'friends'], ['A game', 'play'],
    ["I'm happy", 'happy'], ["I'm sad", 'sad'], ["I'm tired", 'tired'],
  ];
  for (const [label, symbol] of cases) assert.equal(resolveSymbol({ label, type: 'response' }), symbol, label);
  assert.equal(resolveSymbol({ label: 'My choice', say: 'I want to listen to music.' }), 'music');
  assert.equal(resolveSymbol({ label: 'Music', say: 'Tell me a story.' }), 'music');
  assert.equal(resolveSymbol({ label: 'Play music' }), 'music');
  assert.equal(resolveSymbol({ label: 'Listen to a story' }), 'book');
  assert.equal(resolveSymbol({ label: 'I like music' }), 'music');
  assert.equal(resolveSymbol({ label: 'I love stories' }), 'book');
  assert.equal(resolveSymbol({ label: 'I am happy to play music' }), 'music');
  assert.equal(resolveSymbol({ label: "Let's play together" }), 'play');
  assert.equal(resolveSymbol({ label: 'Draw with friends' }), 'draw');
});

test('negation and ambiguous or unknown concepts do not acquire a misleading positive picture', () => {
  assert.equal(resolveSymbol({ label: 'Not music' }), 'no');
  assert.equal(resolveSymbol({ label: "I don't want a story" }), 'no');
  assert.equal(resolveSymbol({ label: 'I am not sad' }), 'chat');
  assert.equal(resolveSymbol({ label: 'Music or a story' }), 'chat');
  assert.equal(resolveSymbol({ label: 'I like music and stories' }), 'chat');
  assert.equal(resolveSymbol({ label: 'Play or draw' }), 'chat');
  assert.equal(resolveSymbol({ label: 'A surprising thought', say: 'Something unusual.' }), 'chat');
  assert.equal(resolveSymbol({ label: '<script>music</script>' }), 'chat');
  assert.equal(resolveSymbol({ label: 'Hello\u0000music' }), 'chat');
  assert.equal(resolveSymbol({ label: 'Listen to me' }), 'chat');
  assert.equal(resolveSymbol({ label: 'Watch me' }), 'chat');
  assert.equal(resolveSymbol({ label: 'Not a bad idea' }), 'chat');
});

test('ordinary reassurance and uncertainty are distinct from clear refusal', () => {
  for (const label of ['No worries', 'No problem', 'Not bad', 'No big deal', "Don't worry"])
    assert.equal(resolveSymbol({ label }), 'chat', label);
  for (const label of ["I don't know", 'I do not know', 'No idea'])
    assert.equal(resolveSymbol({ label }), 'unsure', label);
  for (const label of ['No, thanks', 'No thank you', 'Not now', 'No music', "I don't want that", "I don't like it"])
    assert.equal(resolveSymbol({ label }), 'no', label);
});

class Node {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = {}; this.dataset = {}; this.parentNode = null; this.textContent = ''; this.classes = new Set();
    this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), contains: value => this.classes.has(value) }; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
  insertBefore(child, before) { child.parentNode = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); return child; }
  querySelector(selector) { return this.children.find(child => ['.chat-symbol', '.chat-badge', '.label'].includes(selector) && child.attributes.class === selector.slice(1)) || null; }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
}
const document = { createElementNS(namespace, tagName) { assert.equal(namespace, 'http://www.w3.org/2000/svg'); return new Node(tagName); } };
const allNodes = root => [root, ...root.children.flatMap(allNodes)];

test('symbols render synchronously as decorative native vectors without replacing speech or text', () => {
  const tile = new Node('button'); tile.ownerDocument = document;
  const label = new Node('span'); label.setAttribute('class', 'label'); label.textContent = 'Music'; tile.appendChild(label);
  const svg = attachSymbol(tile, { label: 'Music', type: 'response', say: 'Music please.' });
  assert.equal(svg.tagName, 'svg'); assert.equal(svg.attributes['aria-hidden'], 'true');
  assert.equal(svg.attributes.focusable, 'false'); assert.equal(svg.attributes.viewBox, '0 0 64 64');
  assert.equal(tile.children[0], svg); assert.equal(tile.children[1], label); assert.equal(label.textContent, 'Music');
  assert.equal(tile.attributes['aria-label'], undefined); assert.equal(tile.dataset.symbol, 'music');
  assert.ok(tile.classList.contains('has-symbol')); assert.ok(svg.children.length > 0);
  assert.ok(!allNodes(svg).some(node => ['title', 'text', 'image', 'use', 'script', 'foreignObject'].includes(node.tagName)));
  assert.ok(allNodes(svg).every(node => Object.keys(node.attributes).every(key => !/^on|href|src/i.test(key))));
});

test('reattaching changes only the decorative symbol and never duplicates it', () => {
  const tile = new Node('button'); tile.ownerDocument = document;
  const label = new Node('span'); label.setAttribute('class', 'label'); label.textContent = 'No'; tile.appendChild(label);
  attachSymbol(tile, { label: 'Yes' }); attachSymbol(tile, { label: 'No' });
  assert.equal(tile.children.length, 2); assert.equal(tile.dataset.symbol, 'no'); assert.equal(tile.children[1], label);
});

test('black rest slots and inactive placeholders stay symbol-free while unknown replies have a symbol', () => {
  for (const type of ['rest', 'waiting', 'emptyStory']) {
    const tile = new Node('div'); tile.ownerDocument = document;
    attachSymbol(tile, { label: 'Hello' });
    assert.equal(attachSymbol(tile, { label: 'Hello', type }), null);
    assert.equal(tile.children.length, 0); assert.ok(!tile.classList.contains('has-symbol'));
    assert.equal(resolveSymbol({ label: 'Hello', type }), null);
  }
  assert.ok(createSymbol({ label: 'A surprising thought' }, document).children.length > 0);
});

test('all mapped concepts have finite native vector shapes and no external resources', () => {
  for (const label of ['Yes', 'No', 'Hi', 'How are you?', 'Come sit with me', 'Tell me more', 'Reactions',
    'My news', 'Help me say it', 'Back to Chat', "That's funny", 'I love that', 'No way', "That's not fair",
    'Give me more time', "That's not what I meant", 'Ask me yes or no', 'Let me try again', "I'm not sure",
    'Please say that again', 'Can I help you', 'Music', 'A story', 'Outside', 'A drink', 'Food',
    'Drawing', 'A film', 'Friends', 'A game', 'Happy', 'Sad', 'Tired', 'Unmapped']) {
    const svg = createSymbol({ label }, document);
    assert.ok(svg.children.length, label);
    for (const node of allNodes(svg)) assert.ok(Object.values(node.attributes).every(value => !/NaN|Infinity|https?:|url\(/i.test(value)), label);
  }
});

test('symbols keep fixed hitboxes, black rest space, accessible words and readable labels at supported viewports', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const css = (await readFile(new URL('../public/chat/chat.css', import.meta.url), 'utf8')).replace(/^@import[^;]+;/m, '');
  const scenes = [
    ['Hi!', "What's up?", 'How are you?', 'Come sit with me.'],
    ['Give me more time.', "That's not what I meant.", 'Ask me yes or no.', 'Let me try again.'],
    ['Music', 'A story', 'Play outside', 'Something different'],
  ];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1600, height: 1000 }]) {
      const page = await browser.newPage({ viewport });
      await page.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}</style><main id="app"><div id="grid"></div></main>`);
      const findings = await page.evaluate(async ({ moduleURL, scenes }) => {
        const { attachSymbol } = await import(moduleURL);
        const grid = document.querySelector('#grid'), findings = [];
        for (const words of scenes) {
          grid.replaceChildren();
          const entries = [['Yes', 'yes', [0, 0]], ['No', 'no', [3, 0]], ['', 'rest', [1, 1]], ['', 'rest', [2, 1]],
            ...words.map((label, i) => [label, 'static', [[1, 0], [2, 0], [0, 1], [3, 1]][i]]),
            ...['Tell me more', 'Reactions', 'My news', 'Help me say it'].map((label, i) => [label, 'route', [i, 2]])];
          for (const [label, type, position] of entries) {
            const tile = document.createElement(type === 'rest' ? 'div' : 'button'); tile.className = `tile ${type}`;
            tile.style.gridColumn = position[0] + 1; tile.style.gridRow = position[1] + 1;
            const text = document.createElement('span'); text.className = 'label'; text.textContent = label; tile.appendChild(text); grid.appendChild(tile);
            const before = tile.getBoundingClientRect().toJSON();
            attachSymbol(tile, { label, type });
            // Exercise the existing minimum: symbols may not force even a
            // multi-line repair phrase to be smaller than 44px.
            if (!['yes', 'no', 'rest'].includes(type)) tile.style.fontSize = '44px';
            const after = tile.getBoundingClientRect().toJSON();
            const style = getComputedStyle(tile), icon = tile.querySelector('.chat-symbol');
            const available = tile.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
              - (icon ? icon.getBoundingClientRect().height + parseFloat(style.rowGap) : 0);
            findings.push({ label, type, before, after, font: parseFloat(style.fontSize),
              clipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > available + 1,
              symbolCount: tile.querySelectorAll('.chat-symbol').length, background: style.backgroundColor });
          }
        }
        return findings;
      }, { moduleURL: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, scenes });
      for (const item of findings) {
        assert.deepEqual(item.after, item.before, `${viewport.width}: symbol changed the hitbox for ${item.label}`);
        if (item.type === 'rest') { assert.equal(item.symbolCount, 0); assert.equal(item.background, 'rgb(0, 0, 0)'); }
        else { assert.equal(item.symbolCount, 1, item.label); assert.ok(item.font >= 44, item.label); assert.equal(item.clipped, false, `${viewport.width}: ${item.label}`); }
      }
      assert.equal(await page.getByRole('button', { name: 'Yes', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Help me say it', exact: true }).count(), 1);
      await page.close();
    }
  } finally { await browser.close(); }
});

// ---- the rail, the modes and the AI mark (spec 2026-11-07 §3, §4) ----
const conceptId = word => vocabulary.concepts.find(concept => concept.word === word).id;
const FRAME = [
  { label: 'yes', type: 'yes' }, { label: '', type: 'question' }, { label: 'no', type: 'no' },
  { label: 'My questions', type: 'page' }, { label: 'My comments', type: 'page' }, { label: 'About me', type: 'page' },
  { label: 'Tell me more', type: 'static' }, { label: 'Ask a question', type: 'mode', badge: 'ai' }, { label: 'Make a comment', type: 'mode', badge: 'ai' },
  { label: 'Something else', type: 'static' },
];
const tileFor = label => { const tile = new Node('button'); tile.ownerDocument = document; const text = new Node('span'); text.setAttribute('class', 'label'); text.textContent = label; tile.appendChild(text); return tile; };

test('the rail and mode tiles share the question bubble and the drawn comment bubble, in every style (spec 2026-11-07 §3)', () => {
  assert.equal(setVocabulary(vocabulary), true);
  for (const variant of ['color', 'bw', 'emoji']) {
    const plan = planPictures(FRAME, { variant });
    const [questions, comments, about, , ask, comment] = plan.slice(3, 9);
    if (variant !== 'emoji') {
      assert.equal(questions.id, conceptId('question'), variant); assert.equal(ask.id, conceptId('question'), `${variant}: badged Ask a question shares My questions' picture`);
    }
    assert.equal(questions.word, 'question'); assert.equal(ask.word, 'question');
    for (const item of [comments, comment]) assert.deepEqual({ kind: item.kind, drawn: item.drawn, id: item.id, src: item.src, word: item.word },
      { kind: 'drawn', drawn: 'comment', id: null, src: null, word: 'comment' }, `${variant}: the comment bubble is drawn in-house`);
    assert.equal(about.word, 'me');
  }
});

test('pair rule: a badged and an unbadged tile may share a picture; two unbadged or two badged may not; a reply never repeats a rail picture', () => {
  assert.equal(setVocabulary(vocabulary), true);
  const plain = planPictures(FRAME.map(({ badge, ...entry }) => entry));
  assert.equal(plain[3].id, conceptId('question'));
  assert.notEqual(plain[7]?.id, conceptId('question'), 'two unbadged tiles never share the question bubble');
  assert.notEqual(plain[8]?.drawn === 'comment' && plain[8]?.kind, 'drawn', 'two unbadged tiles never share the comment bubble');
  const both = planPictures([{ label: 'Ask a question', type: 'mode', badge: 'ai' }, { label: 'Ask a question', type: 'mode', badge: 'ai' }]);
  assert.equal(both[0].id, conceptId('question')); assert.notEqual(both[1]?.id, conceptId('question'), 'two badged tiles never share');
  // Three never share: the pair is two tiles.
  const three = planPictures([{ label: 'My questions', type: 'page' }, { label: 'Ask a question', type: 'mode', badge: 'ai' }, { label: 'Ask a question', type: 'static' }]);
  assert.equal(three.filter(item => item?.id === conceptId('question')).length, 2);
  // A generated reply (badged) never takes a rail picture, nor the drawn comment bubble a second time.
  const replies = planPictures([...FRAME, { label: 'About me', type: 'response', badge: 'ai', symbol: 'me', symbolId: conceptId('me') },
    { label: 'A comment', type: 'response', badge: 'ai', symbol: 'comment' }]);
  assert.notEqual(replies[10]?.id, conceptId('me'), 'a generated reply never repeats the About me picture');
  assert.notEqual(replies[11]?.drawn === 'comment' && replies[11]?.kind, 'drawn', 'nor the comment bubble');
  // A kept picture (a replacement's unchanged reply) counts as shown.
  const shown = planPictures([{ label: 'My comments', type: 'page' }])[0];
  const kept = planPictures([{ label: 'My comments', type: 'page' }, { label: 'Make a comment', type: 'mode', badge: 'ai' }, { label: 'Make a comment', type: 'static' }], { keep: [shown] });
  assert.equal(kept[0], shown); assert.equal(kept[1].drawn, 'comment', 'the badged tile pairs with a kept picture');
  assert.notEqual(kept[2]?.kind === 'drawn' && kept[2]?.drawn, 'comment', 'a third never does');
});

test('the drawn comment bubble renders in fixed colours: black outline, white bubble, never currentColor', () => {
  assert.equal(setVocabulary(vocabulary), true);
  const [plan] = planPictures([{ label: 'Make a comment', type: 'mode', badge: 'ai' }], { variant: 'bw' });
  const tile = tileFor('Make a comment');
  const svg = attachPicture(tile, plan);
  assert.equal(svg.tagName, 'svg'); assert.equal(tile.dataset.picture, 'drawn'); assert.equal(tile.dataset.symbol, 'comment');
  assert.equal(tile.dataset.symbolId, undefined);
  const parts = svg.children;
  assert.ok(parts.length >= 3, 'a bubble and two text lines');
  assert.equal(parts[0].attributes.fill, '#fff'); assert.equal(parts[0].attributes.stroke, '#000');
  for (const part of parts) assert.ok(!Object.values(part.attributes).includes('currentColor'), 'fixed colours');
  assert.ok(parts.slice(1).every(part => part.attributes.stroke === '#000'), 'black text lines');
});

test('attachBadge("ai") draws three four-pointed sparkles: violet on the white disc, black in black-and-white; one badge a tile', () => {
  assert.equal(setVocabulary(vocabulary), true);
  for (const [variant, colour] of [['color', '#8a5cf6'], ['bw', '#000'], ['emoji', '#8a5cf6']]) {
    const tile = tileFor('Ask a question');
    const badge = attachBadge(tile, 'ai', variant);
    assert.equal(badge.tagName, 'svg', variant); assert.equal(badge.attributes.class, 'chat-badge'); assert.equal(badge.dataset.side, 'ai');
    assert.equal(badge.attributes['aria-hidden'], 'true');
    const sparkles = badge.children.filter(child => child.tagName === 'path');
    assert.equal(sparkles.length, 3, `${variant}: three sparkles`);
    for (const sparkle of sparkles) {
      assert.equal(sparkle.attributes.fill, colour, variant);
      assert.equal((sparkle.attributes.d.match(/[QC]/g) || []).length, 4, `${variant}: four points`);
    }
    attachBadge(tile, 'ai', variant); attachBadge(tile, 'yes', 'emoji');
    assert.equal(tile.children.filter(child => child.attributes.class === 'chat-badge').length, 1, 'one badge a tile');
    assert.equal(attachBadge(tile, null), null); assert.equal(tile.querySelector('.chat-badge'), null);
  }
});

test('badgeOf: yes or no outranks the AI mark; a check-mark or cross picture carries none; the AI mark marks a tile without a picture (§7)', () => {
  assert.equal(setVocabulary(vocabulary), true);
  const plan = word => ({ word, id: 1, kind: 'library', src: '/symbol/1' });
  assert.equal(badgeOf({ badge: 'ai' }, plan('music')), 'ai');
  assert.equal(badgeOf({ badge: 'yes' }, plan('hungry')), 'yes');
  assert.equal(badgeOf({ badge: 'no' }, plan('hungry')), 'no');
  assert.equal(badgeOf({ badge: 'ai' }, plan('yes')), null, 'the check mark is the meaning: no sparkle on it');
  assert.equal(badgeOf({ badge: 'ai' }, plan('no')), null);
  // The mark marks the tile, not the picture (spec 2026-11-07 §7): a words-only tile carries it in its corner.
  assert.equal(badgeOf({ badge: 'ai' }, null), 'ai', 'no picture: the AI mark in the tile corner');
  assert.equal(badgeOf({ badge: 'yes' }, null), null, 'the Yes/No badge keeps needing a picture');
  assert.equal(badgeOf({ badge: 'no' }, null), null);
  assert.equal(badgeOf({ badge: 'ai', symbol: 'yes' }, null), null, 'never on the yes-or-no pair');
  assert.equal(badgeOf({ badge: 'ai', type: 'no' }, null), null);
  assert.equal(badgeOf(null, null), null);
  assert.equal(badgeOf({}, plan('music')), null);
  assert.equal(badgeOf({ badge: 'other' }, plan('music')), null);
});

test('the AI mark sits where the check mark sits, at its size, on the drawn comment bubble too', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const css = (await readFile(new URL('../public/chat/chat.css', import.meta.url), 'utf8')).replace(/^@import[^;]+;/m, '');
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<style>${css}</style><main id="app"><div id="grid"></div></main>`);
    const result = await page.evaluate(async ({ moduleURL, vocabulary }) => {
      const { setVocabulary, planPictures, attachPicture, attachBadge, placeBadge } = await import(moduleURL);
      setVocabulary(vocabulary);
      const grid = document.querySelector('#grid'), out = [];
      for (const [i, [label, side, variant]] of [['Make a comment', 'ai', 'bw'], ['Make a comment', 'yes', 'emoji'], ['Make a comment', 'ai', 'color']].entries()) {
        const tile = document.createElement('button'); tile.className = 'tile mode has-symbol beside'; tile.style.gridColumn = i + 1; tile.style.gridRow = 1;
        const text = document.createElement('span'); text.className = 'label'; text.textContent = label; tile.appendChild(text); grid.appendChild(tile);
        attachPicture(tile, planPictures([{ label, type: 'mode', badge: 'ai' }], { variant })[0]);
        const badge = attachBadge(tile, side, variant); placeBadge(tile);
        const box = tile.getBoundingClientRect(), mark = badge.getBoundingClientRect(), bubble = tile.querySelector('.chat-symbol path');
        out.push({ side, left: mark.left - box.left, top: mark.top - box.top, width: mark.width, background: getComputedStyle(badge).backgroundColor,
          fill: getComputedStyle(badge.querySelector('path') || badge).fill, bubbleFill: getComputedStyle(bubble).fill, bubbleStroke: getComputedStyle(bubble).stroke });
      }
      return out;
    }, { moduleURL: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, vocabulary });
    const [bw, yes, colour] = result;
    for (const key of ['left', 'top', 'width']) assert.ok(Math.abs(bw[key] - yes[key]) <= 1 && Math.abs(colour[key] - yes[key]) <= 1, `${key}: ${JSON.stringify(result)}`);
    assert.ok(yes.width > 10, 'the badge is drawn');
    assert.equal(colour.background, 'rgb(255, 255, 255)', 'the white badge disc');
    assert.equal(colour.fill, 'rgb(138, 92, 246)'); assert.equal(bw.fill, 'rgb(0, 0, 0)');
    for (const item of result) { assert.equal(item.bubbleFill, 'rgb(255, 255, 255)'); assert.equal(item.bubbleStroke, 'rgb(0, 0, 0)'); }
    await page.close();
  } finally { await browser.close(); }
});

test('the AI mark on a tile with no picture sits in the tile\'s own top-right corner, an eighth of its height (28-56 px); a Yes/No badge stays hidden (§7)', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const css = (await readFile(new URL('../public/chat/chat.css', import.meta.url), 'utf8')).replace(/^@import[^;]+;/m, '');
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<style>${css}</style><main id="app"><div id="grid"></div></main>`);
    const result = await page.evaluate(async ({ moduleURL, vocabulary }) => {
      const { setVocabulary, planPictures, attachPicture, attachBadge, placeBadge } = await import(moduleURL);
      setVocabulary(vocabulary);
      const grid = document.querySelector('#grid'), out = {};
      const make = (key, label, height, { picture, setAside, side }) => {
        const tile = document.createElement('button'); tile.className = 'tile mode';
        tile.style.cssText = `position:absolute;left:0;top:${Object.keys(out).length * 500}px;width:320px;height:${height}px`;
        const text = document.createElement('span'); text.className = 'label'; text.textContent = label; tile.appendChild(text); grid.appendChild(tile);
        if (picture) attachPicture(tile, planPictures([{ label, type: 'mode', badge: 'ai' }])[0]);
        if (setAside) tile.classList.add('picture-set-aside');
        const badge = attachBadge(tile, side, 'color'); placeBadge(tile);
        const box = tile.getBoundingClientRect(), mark = badge.getBoundingClientRect();
        out[key] = { shown: getComputedStyle(badge).display !== 'none', width: mark.width, height: mark.height,
          right: box.right - mark.right, top: mark.top - box.top, inside: mark.left >= box.left && mark.right <= box.right && mark.top >= box.top && mark.bottom <= box.bottom };
      };
      make('setAside', 'Ask a question', 160, { picture: true, setAside: true, side: 'ai' });
      make('wordsOnly', 'Zorbly', 320, { side: 'ai' });
      make('tall', 'Zorbly', 480, { side: 'ai' });
      make('yes', 'Yes, I am', 320, { picture: true, setAside: true, side: 'yes' });
      return out;
    }, { moduleURL: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, vocabulary });
    for (const [key, size] of [['setAside', 28], ['wordsOnly', 40], ['tall', 56]]) {
      const mark = result[key];
      assert.ok(mark.shown && mark.inside, `${key}: ${JSON.stringify(mark)}`);
      assert.ok(Math.abs(mark.width - size) <= 1 && Math.abs(mark.height - size) <= 1, `${key}: ${size} px, got ${JSON.stringify(mark)}`);
      assert.ok(Math.abs(mark.right - 6) <= 1 && Math.abs(mark.top - 6) <= 1, `${key}: the top-right corner: ${JSON.stringify(mark)}`);
    }
    assert.equal(result.yes.shown, false, 'a Yes/No badge keeps needing a picture');
    await page.close();
  } finally { await browser.close(); }
});
