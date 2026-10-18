import { useRef, useState } from 'react'
import { uploadDocument } from '../api.js'

// Upload states: idle → uploading (bytes moving, % known) → processing
// (server is extracting, embedding, indexing) → idle. Cancel works in both.
export default function UploadBox({ maxUploadMb, onUploaded, onError }) {
  const inputRef = useRef(null)
  const controllerRef = useRef(null)
  const [phase, setPhase] = useState('idle')
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)

  async function start(file) {
    // Quick client-side checks for instant feedback. The server re-checks
    // everything (the client can't be trusted), including the PDF magic bytes.
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) return onError('Only PDF files are supported.')
    if (file.size > maxUploadMb * 1024 * 1024) return onError(`File is larger than ${maxUploadMb} MB.`)

    const controller = new AbortController()
    controllerRef.current = controller
    setPhase('uploading')
    setProgress(0)
    try {
      const result = await uploadDocument(file, {
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p)
          if (p >= 1) setPhase('processing')
        },
      })
      onUploaded(result)
    } catch (err) {
      if (err.name !== 'AbortError') onError(err.message)
    } finally {
      controllerRef.current = null
      setPhase('idle')
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const busy = phase !== 'idle'

  return (
    <div
      className={`upload ${dragging ? 'upload--drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!busy) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file && !busy) start(file)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        data-testid="file-input"
        onChange={(e) => e.target.files[0] && start(e.target.files[0])}
      />

      {!busy && (
        <>
          <button className="btn btn--primary btn--block" onClick={() => inputRef.current.click()}>
            Upload PDF
          </button>
          <p className="upload__hint">or drop a file here · max {maxUploadMb} MB</p>
        </>
      )}

      {busy && (
        <div className="upload__progress" role="status">
          <div className="upload__label">
            {phase === 'uploading' ? `Uploading… ${Math.round(progress * 100)}%` : 'Extracting, embedding, indexing…'}
          </div>
          <div className="bar">
            <div
              className={`bar__fill ${phase === 'processing' ? 'bar__fill--busy' : ''}`}
              style={{ width: phase === 'uploading' ? `${progress * 100}%` : '100%' }}
            />
          </div>
          <button className="btn btn--ghost btn--small" onClick={() => controllerRef.current?.abort()}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
