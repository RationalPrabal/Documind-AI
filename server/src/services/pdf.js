// Turns PDF bytes into one cleaned-up string per page.
import { getDocumentProxy, extractText } from 'unpdf';
import { HttpError } from '../errors.js';

// The PDF spec allows the header anywhere in the first 1024 bytes.
export function looksLikePdf(buffer) {
  return buffer.subarray(0, 1024).includes('%PDF-');
}

// Collapse PDF layout noise: spaces/tabs, runs of blank lines, and words
// hyphenated across line breaks ("embed-\ndings" → "embeddings").
export function cleanPageText(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPages(buffer, { maxPages }) {
  if (!looksLikePdf(buffer)) throw new HttpError(415, 'File is not a valid PDF.');

  let pdf;
  try {
    // Copy: PDF.js may transfer (detach) the underlying ArrayBuffer.
    pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new HttpError(422, 'This PDF is password-protected. Remove the password and try again.', { cause: err });
    }
    throw new HttpError(422, 'This PDF appears to be damaged or malformed and could not be read.', { cause: err });
  }

  try {
    if (pdf.numPages > maxPages) {
      throw new HttpError(413, `PDF has ${pdf.numPages} pages; the limit is ${maxPages}.`);
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map(cleanPageText);

    if (!pages.some((p) => p.length > 0)) {
      throw new HttpError(422, 'No selectable text found. This looks like a scanned PDF, which needs OCR (not supported yet).');
    }
    return pages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
