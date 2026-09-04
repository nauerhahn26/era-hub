// Reference amendments: the ground truth is good, not infallible, and a corrected
// reference must be a reviewable file rather than an untracked hand-edit of
// dataset.json. Every fixture text below is INVENTED - no page text, no book titles,
// no ground truth ever appears in this public repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDataset, applyAmendments, gtMetrics } from '../lib/dataset.mjs';

/** A throwaway dataset dir with two pages of invented text. */
function makeDataset(amendments) {
  const dir = fs.mkdtempSync(path.join(process.env.SCRATCHPAD_DIR || os.tmpdir(), 'ocr-bakeoff-ds-'));
  const pages = [
    { id: 'fixture-p00', slug: 'fixture', index: 0, gt: 'one two three', gtChars: 13, gtWords: 3, images: {}, bytes: {} },
    { id: 'fixture-p01', slug: 'fixture', index: 1, gt: 'four five', gtChars: 9, gtWords: 2, images: {}, bytes: {} },
  ];
  fs.writeFileSync(
    path.join(dir, 'dataset.json'),
    JSON.stringify({ version: 1, count: pages.length, books: { fixture: 2 }, emptyGtPages: [], pages }),
  );
  if (amendments) fs.writeFileSync(path.join(dir, 'amendments.json'), JSON.stringify(amendments));
  return dir;
}

test('no amendments file is a no-op', () => {
  const d = loadDataset(makeDataset(null));
  assert.equal(d.pages[0].gt, 'one two three');
  assert.equal(d.pages[0].amended, undefined);
  assert.deepEqual(d.amendedPages, []);
});

test('an amendment replaces the reference and recomputes its counts', () => {
  const d = loadDataset(
    makeDataset({
      note: 'invented fixture',
      pages: { 'fixture-p01': { gt: 'four five six seven', reason: 'fixture replacement' } },
    }),
  );
  const p = d.pages.find((x) => x.id === 'fixture-p01');
  assert.equal(p.gt, 'four five six seven');
  assert.equal(p.gtWords, 4, 'gtWords must be recomputed, not carried over from dataset.json');
  assert.equal(p.gtChars, 'four five six seven'.length);
  assert.equal(p.amended, true);
  // untouched pages stay untouched
  assert.equal(d.pages.find((x) => x.id === 'fixture-p00').amended, undefined);
  assert.deepEqual(d.amendedPages, ['fixture-p01']);
});

test('an empty replacement turns the page into a phantom-text canary', () => {
  const d = loadDataset(
    makeDataset({ note: 'invented fixture', pages: { 'fixture-p00': { gt: '', reason: 'images carry no text' } } }),
  );
  const p = d.pages.find((x) => x.id === 'fixture-p00');
  assert.equal(p.gt, '');
  assert.equal(p.gtWords, 0, 'no reference words -> excluded from every micro/macro rate');
  assert.equal(p.gtChars, 0);
  assert.equal(p.amended, true);
  // emptyGtPages is derived from gtWords, so it has to follow the amendment
  assert.deepEqual(d.emptyGtPages, ['fixture-p00']);
});

test('an unknown page id throws and names the id', () => {
  const dir = makeDataset({ note: 'typo', pages: { 'fixture-p99': { gt: 'x', reason: 'typo' } } });
  assert.throws(() => loadDataset(dir), /fixture-p99/);
});

test('a non-string replacement throws rather than becoming an empty reference', () => {
  const dir = makeDataset({ note: 'bad', pages: { 'fixture-p00': { reason: 'forgot the gt field' } } });
  assert.throws(() => loadDataset(dir), /fixture-p00/);
});

test('"nothing was amended" is true: a bad entry rolls nothing forward', () => {
  // The message is a promise to the caller. applyAmendments is exported and called
  // directly, so a caller that catches the throw must not be holding a dataset whose
  // earlier pages were already rewritten by the same call.
  const dataset = JSON.parse(fs.readFileSync(path.join(makeDataset(null), 'dataset.json'), 'utf8'));
  const before = dataset.pages.map((p) => ({ gt: p.gt, gtWords: p.gtWords, amended: p.amended }));
  for (const bad of [
    { 'fixture-p00': { gt: 'CHANGED' }, 'fixture-p99': { gt: 'x' } }, // unknown id, second
    { 'fixture-p00': { gt: 'CHANGED' }, 'fixture-p01': { reason: 'no gt' } }, // non-string gt, second
  ]) {
    assert.throws(() => applyAmendments(dataset, { note: 'bad', pages: bad }), /nothing was amended/);
    assert.deepEqual(
      dataset.pages.map((p) => ({ gt: p.gt, gtWords: p.gtWords, amended: p.amended })),
      before,
      'a valid entry BEFORE the bad one must not have been applied',
    );
  }
});

test('applyAmendments is idempotent and reports what it changed', () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(makeDataset(null), 'dataset.json'), 'utf8'));
  const am = { note: 'invented', pages: { 'fixture-p00': { gt: 'eight', reason: 'fixture' } } };
  const a = applyAmendments(dataset, am);
  const b = applyAmendments(dataset, am);
  assert.deepEqual(a.applied, ['fixture-p00']);
  assert.deepEqual(b.applied, ['fixture-p00']);
  assert.equal(dataset.pages[0].gt, 'eight');
  assert.equal(dataset.pages[0].gtWords, 1);
});

test('gtMetrics counts the same way build-dataset does', () => {
  assert.deepEqual(gtMetrics(''), { gtChars: 0, gtWords: 0 });
  assert.deepEqual(gtMetrics('  '), { gtChars: 2, gtWords: 0 });
  assert.deepEqual(gtMetrics('a\nb  c'), { gtChars: 6, gtWords: 3 });
});
