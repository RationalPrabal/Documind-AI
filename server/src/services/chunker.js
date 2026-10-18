// Splits per-page text into overlapping chunks and records which pages each
// chunk came from, so answers can cite "p. 4" or "pp. 4–5".
//
// Strategy: join pages into one string (remembering where each page starts),
// slide a window of ~chunkSize characters across it, and end each window at
// the nicest nearby boundary: paragraph > sentence > word > hard cut.

const PAGE_SEPARATOR = '\n\n';

export function chunkPages(pages, { chunkSize, chunkOverlap }) {
  if (chunkOverlap >= chunkSize) throw new Error('chunkOverlap must be smaller than chunkSize');

  // 1. Concatenate, tracking each page's [start, end) offsets in the full text.
  const spans = [];
  let text = '';
  pages.forEach((pageText, i) => {
    if (!pageText.trim()) return; // blank page: skip text, keep numbering
    if (text) text += PAGE_SEPARATOR;
    spans.push({ page: i + 1, start: text.length, end: text.length + pageText.length });
    text += pageText;
  });

  const pageAt = (offset) => {
    let page = spans[0]?.page;
    for (const span of spans) {
      if (span.start > offset) break;
      page = span.page;
    }
    return page;
  };

  // 2. Slide the window.
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) end = findBreak(text, start, end, chunkSize);

    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const from = start + (raw.length - raw.trimStart().length);
      const to = from + trimmed.length - 1;
      chunks.push({ chunkIndex: chunks.length, text: trimmed, pageStart: pageAt(from), pageEnd: pageAt(to) });
    }
    if (end >= text.length) break;

    // 3. Step back by the overlap, but always move forward, and start on a word.
    const next = end - chunkOverlap;
    start = next > start ? alignToWordStart(text, next, end) : end;
  }
  return chunks;
}

// Prefer to end the chunk at a paragraph, then sentence, then word boundary,
// as long as that keeps the chunk at least half full.
function findBreak(text, start, end, chunkSize) {
  const minEnd = start + Math.floor(chunkSize / 2);
  const window = text.slice(minEnd, end);

  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph !== -1) return minEnd + paragraph + 2;

  let sentence = -1;
  for (const m of window.matchAll(/[.!?]["')\]]?\s/g)) sentence = m.index + m[0].length;
  if (sentence !== -1) return minEnd + sentence;

  const space = window.search(/\s\S*$/);
  if (space !== -1) return minEnd + space + 1;

  return end; // one giant "word" (e.g. a URL or table row): hard cut
}

function alignToWordStart(text, pos, limit) {
  while (pos < limit && !/\s/.test(text[pos - 1])) pos++;
  return pos;
}
