// Chat tile layout by board law (era-board app/board-render.js; ux-contract §E 20).
// A tile with a picture and a short label shows the picture BESIDE the word:
// 42% of the tile's width, 82% of its height (30% only when a word needs it).
// A label that cannot fit beside at the 74 px target goes STACKED (picture
// above, words below) before any shrink; only a stacked label that cannot fit
// at 74 px shrinks, to the 44 px floor, and is marked data-font-reduced="1".
// Word integrity outranks the picture: when even 44 px cannot fit, the picture
// is set aside and the words keep the whole tile.
// Stacked labels may take 55% of the height, then 80% (board-render.js applyFit tiers).
// The "stacked-big" profile is a preview candidate for the maintainer, not the
// default: a stacked picture keeps at least 30% of the height and the label
// steps down toward 60 px before the 44 px floor.
export const STACKED_BIG = Object.freeze({ labelShare: 0.70 });
// A one- or two-character label with no picture (a letter or number reply) is
// a GLYPH: the largest 2 px step from 3x the target that keeps it within 85%
// of the content height, marked data-glyph="1" (line-height 1 in chat.css).
// The yes/no corner tiles keep their own law.
export const FIT = Object.freeze({ target: 74, floor: 44, iconShare: 0.42, iconShareMin: 0.30, besideMaxChars: 16, besideMinWidth: 190, stackedShares: [0.55, 0.80],
  glyphMaxChars: 2, glyphScale: 3, glyphShare: 0.85 });

function fits(tile, label, layout, share = 1) {
  const style = getComputedStyle(tile);
  const content = tile.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const room = content * share;
  return label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= room + 1;
}
// Largest size from `from` down to `to` (2 px steps) at which the label fits.
function shrink(tile, label, layout, from, to, share = 1) {
  for (let size = from; ; size -= 2) {
    const at = Math.max(size, to);
    tile.style.fontSize = `${at}px`;
    if (fits(tile, label, layout, share)) return at;
    if (at === to) return null;
  }
}

export function fitTile(tile, { profile } = {}) {
  const label = tile.querySelector('.label');
  if (!label || tile.classList.contains('rest')) return null;
  const picture = tile.querySelector('.chat-symbol');
  tile.style.fontSize = ''; delete tile.dataset.fontReduced; delete tile.dataset.glyph;
  tile.classList.remove('beside', 'stacked', 'picture-set-aside');
  picture?.style.removeProperty('--icon-w');
  const start = Math.max(FIT.target, parseFloat(getComputedStyle(tile).fontSize) || FIT.target);
  const done = (size, layout) => {
    tile.style.fontSize = `${size}px`;
    if (size < FIT.target) tile.dataset.fontReduced = '1';
    return { size, layout };
  };
  const chars = [...(label.textContent || '').trim()].length;
  if (!picture && chars >= 1 && chars <= FIT.glyphMaxChars && !tile.classList.contains('yes') && !tile.classList.contains('no')) {
    tile.dataset.glyph = '1';
    const size = shrink(tile, label, 'glyph', FIT.target * FIT.glyphScale, FIT.floor, FIT.glyphShare) ?? FIT.floor;
    return done(size, 'glyph');
  }
  if (!picture) {
    const size = shrink(tile, label, 'plain', start, FIT.target) ?? shrink(tile, label, 'plain', FIT.target - 2, FIT.floor) ?? FIT.floor;
    return done(size, 'plain');
  }
  if ((label.textContent || '').trim().length <= FIT.besideMaxChars && tile.clientWidth >= FIT.besideMinWidth) {
    tile.classList.add('beside');
    let size = shrink(tile, label, 'beside', start, FIT.target);
    if (size) return done(size, 'beside');
    picture.style.setProperty('--icon-w', `${Math.round(FIT.iconShareMin * 100)}%`);
    size = shrink(tile, label, 'beside', start, FIT.target);
    if (size) return done(size, 'beside');
    picture.style.removeProperty('--icon-w');
    tile.classList.remove('beside');
  }
  tile.classList.add('stacked');
  if (profile === 'stacked-big') {
    // The label never takes more than 70%: sizes step down through 60 px to the floor.
    const size = shrink(tile, label, 'stacked', start, FIT.floor, STACKED_BIG.labelShare);
    if (size) return done(size, 'stacked');
  } else {
    // Every height share at the 74 px target first; only the last share shrinks below it.
    for (const share of FIT.stackedShares) {
      const size = shrink(tile, label, 'stacked', start, FIT.target, share);
      if (size) return done(size, 'stacked');
    }
    const last = FIT.stackedShares[FIT.stackedShares.length - 1];
    const size = shrink(tile, label, 'stacked', FIT.target - 2, FIT.floor, last);
    if (size) return done(size, 'stacked');
  }
  tile.classList.remove('stacked'); tile.classList.add('picture-set-aside');
  return done(shrink(tile, label, 'plain', start, FIT.floor) ?? FIT.floor, 'plain');
}
