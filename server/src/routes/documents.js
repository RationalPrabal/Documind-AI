import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { documents, chunks } from '../db.js';
import { HttpError } from '../errors.js';
import { parseDocumentId } from '../ids.js';
import { ingestPdf } from '../services/ingest.js';
import { uploadLimiter } from '../middleware/rateLimits.js';

export const documentsRouter = Router();

// Memory storage: the file never touches disk, and the size limit means at
// most MAX_UPLOAD_MB per request sits in RAM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 0 },
  defParamCharset: 'utf8', // decode non-ASCII filenames correctly
  fileFilter: (_req, file, cb) => {
    // First line of defence only: the browser-supplied MIME type can be
    // spoofed, so pdf.js also checks the %PDF- magic bytes.
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new HttpError(415, 'Only PDF files are allowed.'));
  },
});

// Only what the client needs; never ownerId or contentHash.
function toPublic(doc) {
  return {
    id: doc._id.toString(),
    filename: doc.filename,
    status: doc.status,
    pageCount: doc.pageCount,
    chunkCount: doc.chunkCount ?? 0,
    sizeBytes: doc.sizeBytes,
    error: doc.error,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function cleanFilename(name = '') {
  // Strip path components and control characters; cap length.
  const base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'document.pdf').slice(0, 200);
}

// The limiter runs before multer, so a rejected upload is never buffered.
documentsRouter.post('/', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach a PDF in the "file" form field.');

  // If the client disconnects mid-ingestion, abort the paid embedding calls.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const { document, deduplicated } = await ingestPdf({
    ownerId: req.ownerId,
    filename: cleanFilename(req.file.originalname),
    buffer: req.file.buffer,
    signal: controller.signal,
    log: req.log,
  });

  res.status(deduplicated ? 200 : 201).json({ document: toPublic(document), deduplicated });
});

documentsRouter.get('/', async (req, res) => {
  const docs = await documents()
    .find({ ownerId: req.ownerId })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  res.json({ documents: docs.map(toPublic) });
});

// Every lookup filters by BOTH _id and ownerId. Someone else's id returns
// 404 (not 403) so we don't even reveal that the document exists.
documentsRouter.get('/:id', async (req, res) => {
  const _id = parseDocumentId(req.params.id); // validate before touching the DB
  const doc = await documents().findOne({ _id, ownerId: req.ownerId });
  if (!doc) throw new HttpError(404, 'Document not found.');
  res.json({ document: toPublic(doc) });
});

documentsRouter.delete('/:id', async (req, res) => {
  const _id = parseDocumentId(req.params.id);
  const { deletedCount } = await documents().deleteOne({ _id, ownerId: req.ownerId });
  if (!deletedCount) throw new HttpError(404, 'Document not found.');
  await chunks().deleteMany({ documentId: _id, ownerId: req.ownerId });
  res.status(204).end();
});
