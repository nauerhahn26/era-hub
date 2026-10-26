import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/chat/symbols.js', import.meta.url), 'utf8');
const { resolveSymbol, createSymbol, attachSymbol } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

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
  insertBefore(child, before) { child.parentNode = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); return child; }
  querySelector(selector) { return this.children.find(child => selector === '.chat-symbol' ? child.attributes.class === 'chat-symbol' : selector === '.label' && child.attributes.class === 'label') || null; }
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
