import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStrict,
  normalizeLoose,
  words,
  levenshtein,
  werStrict,
  werLoose,
  cerLoose,
  bagWerLoose,
  scorePage,
  aggregate,
  agreePolicy,
} from '../lib/score.mjs';

test('identical texts score zero error and both perfect flags', () => {
  const t = 'A pebble rolled along the edge of the pond.';
  const s = scorePage(t, t);
  assert.equal(s.werStrict, 0);
  assert.equal(s.werLoose, 0);
  assert.equal(s.cerStrict, 0);
  assert.equal(s.perfectStrict, true);
  assert.equal(s.perfectLoose, true);
});

test('one substituted word in ten gives WER 0.1', () => {
  const ref = 'one two three four five six seven eight nine ten';
  const hyp = 'one two three four five six seven eight nine TENN';
  const s = scorePage(ref, hyp);
  assert.equal(s.werLooseRefWords, 10);
  assert.equal(s.werLooseErrors, 1);
  assert.ok(Math.abs(s.werLoose - 0.1) < 1e-12);
});

test('one deleted word in ten gives WER 0.1 and one inserted gives 0.1', () => {
  const ref = 'one two three four five six seven eight nine ten';
  assert.ok(Math.abs(werLoose(ref, 'one two three four five six seven eight nine').rate - 0.1) < 1e-12);
  assert.ok(Math.abs(werLoose(ref, ref + ' eleven').rate - 0.1) < 1e-12);
});

test('levenshtein basics', () => {
  assert.equal(levenshtein([], []), 0);
  assert.equal(levenshtein(['a'], []), 1);
  assert.equal(levenshtein([], ['a', 'b']), 2);
  assert.equal(levenshtein([...'kitten'], [...'sitting']), 3);
});

test('curly quotes normalise to straight quotes (strict equality)', () => {
  const a = '“Later,” said the keeper, “you’re early.”';
  const b = '"Later," said the keeper, "you\'re early."';
  assert.equal(normalizeStrict(a), normalizeStrict(b));
  assert.equal(scorePage(a, b).perfectStrict, true);
});

test('en dash, em dash and hyphen all normalise to hyphen', () => {
  assert.equal(normalizeStrict('a – b'), normalizeStrict('a - b'));
  assert.equal(normalizeStrict('a — b'), normalizeStrict('a - b'));
  assert.equal(normalizeStrict('a − b'), normalizeStrict('a - b'));
});

test('ellipsis char, three dots and spaced dots are equal', () => {
  assert.equal(normalizeStrict('wait… then'), 'wait... then');
  assert.equal(normalizeStrict('wait. . . then'), 'wait... then');
  assert.equal(normalizeStrict('wait..... then'), 'wait... then');
  assert.equal(scorePage('wait…', 'wait. . .').perfectStrict, true);
});

test('a spaced ellipsis broken across lines still normalises to "..."', () => {
  // GCV emits a newline at every layout break, which can land inside a printed ". . .".
  assert.equal(normalizeStrict('Oh no .\n.\n. not again'), 'Oh no ... not again');
  assert.equal(normalizeStrict('Oh no .\r\n. . not again'), 'Oh no ... not again');
  const s = scorePage('Oh no ... not again', 'Oh no .\n.\n. not again');
  assert.equal(s.werStrict, 0);
  assert.equal(s.perfectStrict, true);
});

test('normalizeStrict is idempotent', () => {
  for (const t of ['Oh no .\n.\n. not again', '“Later,” she said…', 'a – b\t\tc', 'wait. . . then']) {
    assert.equal(normalizeStrict(normalizeStrict(t)), normalizeStrict(t));
  }
});

test('newlines, tabs and runs of spaces are all one space', () => {
  const a = 'line one\nline two\n\nline three';
  const b = 'line one line two   line three';
  assert.equal(normalizeStrict(a), normalizeStrict(b));
  assert.equal(scorePage(a, b).perfectStrict, true);
  assert.equal(scorePage(a, b).werStrict, 0);
});

test('non-breaking and zero-width characters are handled', () => {
  assert.equal(normalizeStrict('a b'), 'a b');
  assert.equal(normalizeStrict('a​b'), 'ab');
});

test('loose ignores case and punctuation but strict does not', () => {
  const ref = 'Once upon a time, a pebble!';
  const hyp = 'once upon a time a pebble';
  assert.equal(scorePage(ref, hyp).werLoose, 0);
  assert.equal(scorePage(ref, hyp).perfectLoose, true);
  assert.equal(scorePage(ref, hyp).perfectStrict, false);
  assert.ok(scorePage(ref, hyp).werStrict > 0);
});

test('loose still cares about word identity', () => {
  const s = scorePage('the pebble and the pond', 'the pebble and the pund');
  assert.ok(s.werLoose > 0);
  assert.equal(s.perfectLoose, false);
});

test('loose keeps intra-word apostrophes', () => {
  assert.equal(normalizeLoose("the keeper's hat"), "the keeper's hat");
  // leading/trailing quote marks and dashes are stripped
  assert.equal(normalizeLoose("'quoted' - word"), 'quoted word');
});

test('an intra-word dash JOINS in loose, whichever dash it is', () => {
  // The asymmetry this rule exists to kill: the reference prints an em dash exactly
  // where the models print a hyphen-minus, and normalizeStrict has already folded both
  // to "-". A rule that split one and not the other charged two word errors for
  // typography no listener can hear - and made loose errors exceed strict errors on
  // pages strict called perfect. Joining is symmetric: the dash leaves no trace.
  assert.deepEqual(words(normalizeLoose('better—at')), ['betterat']);
  assert.deepEqual(words(normalizeLoose('better–at')), ['betterat']);
  assert.deepEqual(words(normalizeLoose('better-at')), ['betterat']);
  assert.equal(werLoose('better—at', 'better-at').errors, 0, 'em dash vs hyphen must be free');
  assert.equal(werLoose('well-known', 'wellknown').errors, 0, 'dash vs no dash must be free');
  assert.equal(normalizeLoose("mother-in-law's hat"), "motherinlaw's hat");
});

test('a dash is not a space: splitting a compound is still an error', () => {
  // Joining must not quietly become "any dash is a word boundary": a model that prints
  // a compound as two spaced words has printed different words, and the corpus says so
  // (splitting every dash cost 17 records and 12 extra errors over 2,900 cached calls).
  assert.deepEqual(words(normalizeLoose('well-known')), ['wellknown']);
  assert.equal(werLoose('well-known', 'well known').errors, 2, 'one token vs two: a substitution plus an insertion');
});

test('loose never costs MORE word errors than strict on dash typography', () => {
  // The standing invariant: loose is a RELAXATION of strict. This is the assertion the
  // em/en-dash split rule failed - it scored strict-perfect pages as two loose errors.
  const renderings = ['better at', 'better-at', 'better—at', 'better–at', 'betterat', 'better - at', 'better — at'];
  for (const ref of renderings) {
    for (const hyp of renderings) {
      const s = scorePage(ref, hyp);
      assert.ok(
        s.werLooseErrors <= s.werStrictErrors,
        `loose ${s.werLooseErrors} > strict ${s.werStrictErrors} for "${ref}" vs "${hyp}"`,
      );
      assert.equal(s.looseOverStrict, false);
      if (s.perfectStrict) assert.equal(s.perfectLoose, true, 'strict-perfect implies loose-perfect');
    }
  }
});

test('the strict normaliser is unchanged: every dash still folds to a hyphen', () => {
  assert.equal(normalizeStrict('better—at'), 'better-at');
  assert.equal(normalizeStrict('better–at'), 'better-at');
  assert.equal(normalizeStrict('better-at'), 'better-at');
  assert.equal(normalizeStrict('a — b'), 'a - b');
});

test('empty ref and empty hyp is zero error, both perfect', () => {
  const s = scorePage('', '');
  assert.equal(s.werLoose, 0);
  assert.equal(s.cerLoose, 0);
  assert.equal(s.perfectLoose, true);
  assert.equal(s.perfectStrict, true);
  assert.equal(s.phantomWords, 0);
});

test('empty ref with hypothesis text counts insertions as phantom words', () => {
  const s = scorePage('', 'the end');
  assert.equal(s.phantomWords, 2);
  assert.equal(s.werLoose, 1);
  assert.equal(s.perfectLoose, false);
});

test('non-empty ref with empty hyp is a full deletion (WER 1)', () => {
  const s = scorePage('two words', '');
  assert.equal(s.werLoose, 1);
  assert.equal(s.werLooseErrors, 2);
  assert.equal(s.phantomWords, 0);
});

test('CER counts characters, not words', () => {
  const r = cerLoose('abcde', 'abXde');
  assert.equal(r.refLen, 5);
  assert.equal(r.errors, 1);
  assert.equal(r.rate, 0.2);
});

test('strict WER is punctuation sensitive', () => {
  const r = werStrict('Hello, world', 'Hello world');
  assert.ok(r.errors > 0);
});

test('the bag metric separates a reading-order swap from a misread word', () => {
  // Same words, cover blocks in the other order: WER punishes it, the bag metric does not.
  // Invented title and byline - no real page text belongs in this public repo.
  const gt = 'THE PEBBLE AND THE POND Wren Halloway Marek Ilves';
  const swapped = 'Wren Halloway Marek Ilves THE PEBBLE AND THE POND';
  const s = scorePage(gt, swapped);
  assert.ok(s.werLoose > 0.5, 'order-sensitive WER should punish the swap');
  assert.equal(s.bagWerLoose, 0);
  assert.equal(s.bagWerLooseErrors, 0);
  assert.equal(s.sameMultisetLoose, true);
  assert.equal(s.orderOnlyLoose, true);
});

test('the bag metric still counts genuinely wrong words', () => {
  const s = scorePage('the cat sat on the mat', 'the cat sat on the hat');
  assert.equal(s.sameMultisetLoose, false);
  assert.equal(s.orderOnlyLoose, false);
  assert.equal(s.bagWerLooseErrors, 1);
  assert.ok(Math.abs(s.bagWerLoose - 1 / 6) < 1e-12);
});

test('bag errors pair substitutions rather than double-counting them', () => {
  // one word missing, one word added -> one error, not two
  const r = bagWerLoose('a b c d', 'a b c e');
  assert.equal(r.errors, 1);
  // pure insertion and pure deletion each count fully
  assert.equal(bagWerLoose('a b c', 'a b c d').errors, 1);
  assert.equal(bagWerLoose('a b c', 'a b').errors, 1);
  // identical text, identical order
  assert.equal(scorePage('a b c', 'a b c').sameMultisetLoose, true);
  assert.equal(scorePage('a b c', 'a b c').orderOnlyLoose, false);
});

const rec = (pageId, gt, hyp, opts = {}) => ({
  pageId,
  ok: true,
  parseError: false,
  uncertain: opts.uncertain || [],
  costUsd: opts.costUsd ?? 0.001,
  latencyMs: opts.latencyMs ?? 1000,
  score: scorePage(gt, hyp),
});

test('aggregate computes micro vs macro WER differently', () => {
  // page1: 1 error out of 100 words; page2: 1 error out of 2 words.
  const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const longBad = long.replace('w0 ', 'X ');
  const pages = [rec('p1', long, longBad), rec('p2', 'a b', 'a X')];
  const a = aggregate(pages);
  assert.equal(a.pagesOk, 2);
  assert.ok(Math.abs(a.microWerLoose - 2 / 102) < 1e-12);
  assert.ok(Math.abs(a.macroWerLoose - (0.01 + 0.5) / 2) < 1e-12);
  assert.equal(a.perfectLoosePct, 0);
});

test('an empty-reference page cannot contaminate micro or macro rates', () => {
  // The real corpus has eleven such pages after the amendment pass. A model that
  // invents a caption there must show up as phantom text, NOT as corpus-wide word error:
  // 119 word-perfect pages + 1 phantom page must still read 0 WER.
  const forty = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
  const junk = Array.from({ length: 20 }, (_, i) => `j${i}`).join(' ');
  const pages = Array.from({ length: 119 }, (_, i) => rec(`p${i}`, forty, forty));
  pages.push(rec('empty-gt-canary', '', junk));
  const a = aggregate(pages);
  assert.equal(a.pagesOk, 120);
  assert.equal(a.pagesScored, 119);
  assert.equal(a.pagesEmptyRef, 1);
  assert.equal(a.microWerLoose, 0, 'zero real word errors must report zero micro WER');
  assert.equal(a.microCerLoose, 0);
  assert.equal(a.macroWerLoose, 0, 'macro must describe the same pages micro does');
  assert.equal(a.microBagWerLoose, 0);
  // the canary is not swept away - it is reported as phantom text
  assert.equal(a.phantomPages, 1);
  assert.equal(a.phantomWords, 20);
  assert.equal(a.emptyRefCleanPages, 0, 'the canary produced junk, so it is not a clean canary');
  // ... and it is excluded from the perfect-page rates too, exactly like every other
  // rate: 119 of 119 SCORED pages are perfect. Crediting or debiting a page for what a
  // model did with no reference moved perfect(l) by up to 6.5pp once 11 of 120 pages
  // had an empty reference, and perfect-page rate is an acceptance criterion.
  assert.equal(a.perfectLoosePct, 1);
  assert.equal(a.perfectStrictPct, 1);
});

test('perfect-page % is computed over scored pages, not over every answered page', () => {
  // 3 real pages, 2 of them perfect, plus 2 empty-reference canaries the model handled
  // correctly. perfect(l) must read 2/3, not 4/5.
  const pages = [
    rec('p1', 'alpha beta', 'alpha beta'),
    rec('p2', 'alpha beta', 'alpha beta'),
    rec('p3', 'alpha beta', 'alpha delta'),
    rec('e1', '', ''),
    rec('e2', '', ''),
  ];
  const a = aggregate(pages);
  assert.equal(a.pagesOk, 5);
  assert.equal(a.pagesScored, 3);
  assert.equal(a.pagesEmptyRef, 2);
  assert.equal(a.emptyRefCleanPages, 2);
  assert.ok(Math.abs(a.perfectLoosePct - 2 / 3) < 1e-12);
  assert.ok(Math.abs(a.perfectStrictPct - 2 / 3) < 1e-12);
});

test('a corpus of only empty-reference pages reports null rates, not zero', () => {
  const a = aggregate([rec('e1', '', ''), rec('e2', '', 'invented')]);
  assert.equal(a.microWerLoose, null);
  assert.equal(a.macroWerLoose, null);
  assert.equal(a.pagesScored, 0);
  assert.equal(a.phantomWords, 1);
  // no scored page means no perfect-page rate either - "100%" over zero pages is a lie
  assert.equal(a.perfectLoosePct, null);
  assert.equal(a.perfectStrictPct, null);
  assert.equal(a.emptyRefCleanPages, 1);
});

test('aggregate counts pages where loose costs more than strict (a scoring regression)', () => {
  // The counter that would have caught the em/en-dash split: it took this from 3 pages
  // to 19 across the cached corpus while strict still called those pages perfect.
  const clean = [rec('p1', 'better—at', 'better-at'), rec('p2', 'alpha beta', 'alpha beta')];
  assert.equal(aggregate(clean).looseOverStrictPages, 0);
  // It can still happen honestly, which is why this is a reported number and not a
  // throw: loose turns a slash into a space and splits a hypothesis token that strict
  // kept whole, so the hypothesis gains a word the reference has to pay for.
  const s = scorePage('alpha betagamma', 'alpha beta/gamma');
  assert.equal(s.werStrictErrors, 1);
  assert.equal(s.werLooseErrors, 2);
  assert.equal(s.looseOverStrict, true);
  assert.equal(aggregate([rec('p1', 'alpha betagamma', 'alpha beta/gamma')]).looseOverStrictPages, 1);
  // an empty-reference page can never be one: there is nothing to relax
  assert.equal(scorePage('', 'invented text').looseOverStrict, false);
});

test('aggregate reports order-only pages separately from wrong words', () => {
  const pages = [
    rec('p1', 'alpha beta gamma', 'gamma alpha beta'), // right words, wrong order
    rec('p2', 'alpha beta gamma', 'alpha beta delta'), // genuinely wrong word
  ];
  const a = aggregate(pages);
  assert.equal(a.orderOnlyPages, 1);
  assert.ok(a.microWerLoose > a.microBagWerLoose, 'bag WER must be the lower, order-blind number');
});

test('aggregate reports cost per page and per 16-page book', () => {
  const pages = [rec('p1', 'a', 'a', { costUsd: 0.002 }), rec('p2', 'b', 'b', { costUsd: 0.004 })];
  const a = aggregate(pages);
  assert.ok(Math.abs(a.totalCostUsd - 0.006) < 1e-12);
  assert.ok(Math.abs(a.costPerPageUsd - 0.003) < 1e-12);
  assert.ok(Math.abs(a.costPer16PageBookUsd - 0.048) < 1e-12);
  assert.equal(a.perfectLoosePct, 1);
});

test('aggregate latency median and p95', () => {
  const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => rec(`p${n}`, 'a', 'a', { latencyMs: n * 100 }));
  const a = aggregate(pages);
  assert.equal(a.latencyMsMedian, 550);
  assert.equal(a.latencyMsP95, 1000);
});

test('aggregate self-flag precision and recall', () => {
  const pages = [
    rec('p1', 'a b', 'a X', { uncertain: ['X'] }), // wrong + flagged  -> TP
    rec('p2', 'a b', 'a X'), //                        wrong, unflagged -> FN
    rec('p3', 'a b', 'a b', { uncertain: ['a'] }), //  right + flagged  -> FP
    rec('p4', 'a b', 'a b'), //                        right, unflagged -> TN
  ];
  const a = aggregate(pages);
  assert.equal(a.selfFlag.truePositives, 1);
  assert.equal(a.selfFlag.falsePositives, 1);
  assert.equal(a.selfFlag.falseNegatives, 1);
  assert.equal(a.selfFlag.precision, 0.5);
  assert.equal(a.selfFlag.recall, 0.5);
});

test('aggregate separates failed pages from scored pages', () => {
  const pages = [rec('p1', 'a', 'a'), { pageId: 'p2', ok: false, error: 'http 500' }];
  const a = aggregate(pages);
  assert.equal(a.pagesRun, 2);
  assert.equal(a.pagesOk, 1);
  assert.equal(a.pagesFailed, 1);
  assert.equal(a.failures[0].pageId, 'p2');
});

test('agreePolicy accepts the cheap answer when A and B agree and escalates when they do not', () => {
  const byPage = {
    // agree and both right -> no escalation cost
    p1: {
      gt: 'the cat sat',
      a: { text: 'the cat sat', costUsd: 0.001, ok: true },
      b: { text: 'The cat sat.', costUsd: 0.001, ok: true },
      s: { text: 'the cat sat', costUsd: 0.02, ok: true },
    },
    // disagree -> strong model's (correct) answer is used, strong cost added
    p2: {
      gt: 'the dog ran',
      a: { text: 'the dog run', costUsd: 0.001, ok: true },
      b: { text: 'the dog ran', costUsd: 0.001, ok: true },
      s: { text: 'the dog ran', costUsd: 0.02, ok: true },
    },
  };
  const p = agreePolicy(byPage);
  assert.equal(p.pages, 2);
  assert.equal(p.disagreeRate, 0.5);
  assert.equal(p.microWerLoose, 0);
  assert.equal(p.perfectLoosePct, 1);
  // 2 pages x (A + B) = 0.004, plus one escalation at 0.02
  assert.ok(Math.abs(p.totalCostUsd - 0.024) < 1e-12);
});

test('agreePolicy reports no cost at all when a paid member has no price', () => {
  // An unpriced escalation model must not make the policy look free.
  const byPage = {
    p1: {
      gt: 'the dog ran',
      a: { text: 'the dog run', costUsd: 0.001, ok: true },
      b: { text: 'the dog ran', costUsd: 0.001, ok: true },
      s: { text: 'the dog ran', costUsd: null, ok: true }, // no pricing.json row
    },
  };
  const p = agreePolicy(byPage);
  assert.equal(p.disagreeRate, 1);
  assert.equal(p.costPriced, false);
  assert.equal(p.costPagesKnown, 0);
  assert.equal(p.totalCostUsd, null);
  assert.equal(p.costPerPageUsd, null);
  assert.equal(p.costPer16PageBookUsd, null);
});

test("agreePolicy ignores the escalation price on pages it never escalates", () => {
  const byPage = {
    p1: {
      gt: 'the cat sat',
      a: { text: 'the cat sat', costUsd: 0.001, ok: true },
      b: { text: 'the cat sat', costUsd: 0.001, ok: true },
      s: { text: 'the cat sat', costUsd: null, ok: true },
    },
  };
  const p = agreePolicy(byPage);
  assert.equal(p.costPriced, true);
  assert.ok(Math.abs(p.totalCostUsd - 0.002) < 1e-12);
});

test('agreePolicy skips pages where a member failed', () => {
  const byPage = {
    p1: {
      gt: 'x',
      a: { text: 'x', costUsd: 0, ok: true },
      b: { text: 'x', costUsd: 0, ok: false },
      s: { text: 'x', costUsd: 0, ok: true },
    },
  };
  assert.equal(agreePolicy(byPage), null);
});
