import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPages, cleanPageText, looksLikePdf } from '../src/services/pdf.js';
import { makePdf } from './helpers/makePdf.js';

const rejectsWith = (promise, status) => assert.rejects(promise, (err) => err.status === status);

test('extracts one string per page and keeps blank pages in place', async () => {
  const pdf = makePdf([['Page one, line one.', 'Line two (with parens).'], [], ['Page three.']]);
  const pages = await extractPages(pdf, { maxPages: 10 });
  assert.deepEqual(pages, ['Page one, line one.\nLine two (with parens).', '', 'Page three.']);
});

test('rejects files that are not PDFs (415)', async () => {
  assert.equal(looksLikePdf(Buffer.from('hello')), false);
  await rejectsWith(extractPages(Buffer.from('just text'), { maxPages: 10 }), 415);
});

test('rejects malformed PDFs (422)', async () => {
  await rejectsWith(extractPages(Buffer.from('%PDF-1.4\n garbage'), { maxPages: 10 }), 422);
});

test('rejects PDFs over the page limit (413)', async () => {
  await rejectsWith(extractPages(makePdf([['a'], ['b'], ['c']]), { maxPages: 2 }), 413);
});

test('rejects PDFs with no extractable text (422)', async () => {
  await rejectsWith(extractPages(makePdf([[], []]), { maxPages: 10 }), 422);
});

test('cleanPageText normalises whitespace and joins hyphenated words', () => {
  assert.equal(cleanPageText('  vector   em-\nbeddings \n\n\n\n next\t para '), 'vector embeddings\n\nnext para');
});
