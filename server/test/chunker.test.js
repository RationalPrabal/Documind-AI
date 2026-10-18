import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPages } from '../src/services/chunker.js';

const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const opts = { chunkSize: 200, chunkOverlap: 50 };

test('empty or blank pages produce no chunks', () => {
  assert.deepEqual(chunkPages([], opts), []);
  assert.deepEqual(chunkPages(['', '   ', '\n'], opts), []);
});

test('short single page becomes one chunk on page 1', () => {
  const chunks = chunkPages(['Hello world.'], opts);
  assert.deepEqual(chunks, [{ chunkIndex: 0, text: 'Hello world.', pageStart: 1, pageEnd: 1 }]);
});

test('no chunk exceeds chunkSize and indexes are sequential', () => {
  const chunks = chunkPages([words(300)], opts);
  assert.ok(chunks.length > 1);
  chunks.forEach((c, i) => {
    assert.ok(c.text.length <= opts.chunkSize, `chunk ${i} is ${c.text.length} chars`);
    assert.equal(c.chunkIndex, i);
  });
});

test('every word of the input appears in at least one chunk', () => {
  const input = words(500);
  const seen = new Set(chunkPages([input], opts).flatMap((c) => c.text.split(/\s+/)));
  for (const w of input.split(' ')) assert.ok(seen.has(w), `missing ${w}`);
});

test('consecutive chunks overlap', () => {
  const chunks = chunkPages([words(300)], opts);
  for (let i = 1; i < chunks.length; i++) {
    const firstWordOfNext = chunks[i].text.split(' ')[0];
    assert.ok(chunks[i - 1].text.includes(firstWordOfNext), `chunk ${i} does not overlap the previous one`);
  }
});

test('chunks never cut words in half', () => {
  const input = words(400);
  const vocab = new Set(input.split(' '));
  for (const c of chunkPages([input], opts)) {
    for (const w of c.text.split(/\s+/)) assert.ok(vocab.has(w), `broken word "${w}"`);
  }
});

test('prefers sentence boundaries when available', () => {
  const sentence = 'This is a complete sentence about retrieval. ';
  const chunks = chunkPages([sentence.repeat(20)], opts);
  for (const c of chunks.slice(0, -1)) assert.ok(c.text.endsWith('.'), `"${c.text.slice(-20)}" does not end a sentence`);
});

test('tracks page numbers, including across blank pages', () => {
  const pages = [words(30, 'a'), '', words(30, 'c')]; // page 2 is blank
  const chunks = chunkPages(pages, { chunkSize: 1000, chunkOverlap: 100 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageStart, 1);
  assert.equal(chunks[0].pageEnd, 3);

  const small = chunkPages(pages, opts);
  assert.equal(small[0].pageStart, 1);
  assert.equal(small.at(-1).pageEnd, 3);
  assert.ok(small.every((c) => c.pageStart !== 2 && c.pageEnd !== 2), 'blank page 2 should never be cited');
  assert.ok(small.some((c) => c.pageStart === 1 && c.pageEnd === 3), 'expected a chunk spanning the page break');
});

test('terminates on text with no whitespace (hard cut)', () => {
  const chunks = chunkPages(['x'.repeat(1000)], opts);
  assert.ok(chunks.length >= 5);
  assert.equal(chunks.map((c) => c.text).join('').length >= 1000, true);
});

test('rejects overlap >= chunk size', () => {
  assert.throws(() => chunkPages(['abc'], { chunkSize: 100, chunkOverlap: 100 }));
});
