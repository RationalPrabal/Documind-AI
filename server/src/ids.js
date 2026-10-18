import { ObjectId } from 'mongodb';
import { HttpError } from './errors.js';

// Strict 24-hex check; ObjectId.isValid also accepts any 12-char string.
// An invalid id is reported as "not found", same as someone else's id.
export function parseDocumentId(id) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw new HttpError(404, 'Document not found.');
  return new ObjectId(id);
}
