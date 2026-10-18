import { formatBytes } from '../format.js'

export default function DocumentList({ documents, state, selectedId, onSelect, onDelete, onRetry }) {
  if (state === 'loading') return <p className="muted pad">Loading documents…</p>
  if (state === 'error')
    return (
      <div className="pad">
        <p className="error-text">Couldn't load documents.</p>
        <button className="btn btn--ghost btn--small" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  if (documents.length === 0) return <p className="muted pad">No documents yet. Upload a PDF to start.</p>

  return (
    <ul className="doclist">
      {documents.map((doc) => (
        <li key={doc.id}>
          <button
            className={`doc ${doc.id === selectedId ? 'doc--active' : ''}`}
            onClick={() => onSelect(doc.id)}
            title={doc.filename}
          >
            <span className="doc__name">{doc.filename}</span>
            <span className="doc__meta">
              <span className={`badge badge--${doc.status}`}>{doc.status}</span>
              {doc.pageCount} pages · {doc.chunkCount} chunks · {formatBytes(doc.sizeBytes)}
            </span>
          </button>
          <button
            className="icon-btn"
            aria-label={`Delete ${doc.filename}`}
            title="Delete"
            onClick={() => {
              if (confirm(`Delete "${doc.filename}" and its embeddings?`)) onDelete(doc.id)
            }}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  )
}
