import { useCallback, useEffect, useRef, useState } from 'react'
import { askQuestion, deleteDocument, getMeta, listDocuments } from './api.js'
import { formatNumber } from './format.js'
import UploadBox from './components/UploadBox.jsx'
import DocumentList from './components/DocumentList.jsx'
import ChatPanel from './components/ChatPanel.jsx'

const newId = () => crypto.randomUUID()

// ---- Conversation memory (client-side only) ---------------------------
// Chats are kept per document in this browser's localStorage, so a reload
// doesn't wipe them. The server never stores them: each question sends the
// most recent turns, which are used for that request and then discarded.
const STORAGE_KEY = 'documind.chats.v1'
const MAX_STORED_MESSAGES = 40

function loadChats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}
  } catch {
    return {} // storage blocked or corrupted: start empty
  }
}

function saveChats(chats) {
  const finished = Object.fromEntries(
    Object.entries(chats).map(([docId, messages]) => [
      docId,
      messages.filter((m) => m.status !== 'streaming').slice(-MAX_STORED_MESSAGES),
    ]),
  )
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(finished))
  } catch {
    /* storage full or blocked: memory still works for this tab */
  }
}

// The window of recent turns sent with a question. User questions are always
// included (so "what did I ask?" works); answers only if they completed.
function buildHistory(messages, limit) {
  return messages
    .filter((m) => m.role === 'user' || (m.status === 'done' && m.text))
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }))
}

export default function App() {
  const [meta, setMeta] = useState(null)
  const [backendError, setBackendError] = useState(null)
  const [documents, setDocuments] = useState([])
  const [docsState, setDocsState] = useState('loading')
  const [selectedId, setSelectedId] = useState(null)
  const [chats, setChats] = useState(loadChats)
  const [streamingDocId, setStreamingDocId] = useState(null)
  const [notice, setNotice] = useState(null)
  const askControllerRef = useRef(null)

  const refreshMeta = useCallback(() => {
    getMeta()
      .then((m) => {
        setMeta(m)
        setBackendError(null)
      })
      .catch((err) => setBackendError(err.message))
  }, [])

  const refreshDocuments = useCallback(async () => {
    try {
      const docs = await listDocuments()
      setDocuments(docs)
      setDocsState('ready')
      return docs
    } catch {
      setDocsState('error')
      return []
    }
  }, [])

  // Initial load from the backend (an external system, so an effect is right).
  // State is only set when the responses arrive, never synchronously here.
  useEffect(() => {
    refreshMeta()
    // oxlint-disable-next-line react/set-state-in-effect
    refreshDocuments().then((docs) => setSelectedId((id) => id ?? docs.find((d) => d.status === 'ready')?.id ?? null))
  }, [refreshMeta, refreshDocuments])

  // Persist chats, but not on every streamed token: only once nothing is streaming.
  useEffect(() => {
    if (!streamingDocId) saveChats(chats)
  }, [chats, streamingDocId])

  // Drop stored chats whose document no longer exists for this identity.
  useEffect(() => {
    if (docsState !== 'ready') return
    const ids = new Set(documents.map((d) => d.id))
    // oxlint-disable-next-line react/set-state-in-effect
    setChats((c) => {
      const kept = Object.fromEntries(Object.entries(c).filter(([id]) => ids.has(id)))
      return Object.keys(kept).length === Object.keys(c).length ? c : kept
    })
  }, [documents, docsState])

  // Auto-hide notices after a few seconds.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  async function handleUploaded({ document, deduplicated }) {
    await refreshDocuments()
    setSelectedId(document.id)
    refreshMeta()
    setNotice(
      deduplicated
        ? { type: 'info', text: `"${document.filename}" was already uploaded. Reused the existing embeddings (no cost).` }
        : { type: 'ok', text: `"${document.filename}" is ready: ${document.pageCount} pages, ${document.chunkCount} chunks.` },
    )
  }

  async function handleDelete(id) {
    if (streamingDocId === id) askControllerRef.current?.abort()
    try {
      await deleteDocument(id)
      setChats(({ [id]: _removed, ...rest }) => rest)
      const docs = await refreshDocuments()
      if (selectedId === id) setSelectedId(docs[0]?.id ?? null)
    } catch (err) {
      setNotice({ type: 'error', text: err.message })
    }
  }

  async function handleAsk(question) {
    const docId = selectedId
    const assistantId = newId()
    const started = performance.now()
    const history = buildHistory(chats[docId] ?? [], meta?.limits.historyMessages ?? 6)
    setChats((c) => ({
      ...c,
      [docId]: [
        ...(c[docId] ?? []),
        { id: newId(), role: 'user', text: question },
        { id: assistantId, role: 'assistant', text: '', sources: [], status: 'streaming' },
      ],
    }))
    const update = (patch) =>
      setChats((c) =>
        c[docId] // the document may have been deleted mid-stream
          ? {
              ...c,
              [docId]: c[docId].map((m) =>
                m.id === assistantId ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m,
              ),
            }
          : c,
      )

    const controller = new AbortController()
    askControllerRef.current = controller
    setStreamingDocId(docId)
    try {
      await askQuestion(docId, question, {
        history,
        signal: controller.signal,
        onEvent: (event, data) => {
          if (event === 'sources') update({ sources: data.sources, mode: data.mode, searchQuery: data.searchQuery })
          else if (event === 'token') update((m) => ({ text: m.text + data.text }))
          else if (event === 'done') update({ ...data, status: 'done', elapsedMs: performance.now() - started })
          else if (event === 'error') update({ status: 'error', error: data.message })
        },
      })
      // Stream closed without a "done" or "error" event: the connection dropped.
      update((m) => (m.status === 'streaming' ? { status: 'error', error: 'The connection was interrupted.' } : {}))
    } catch (err) {
      if (err.name === 'AbortError') update({ status: 'cancelled' })
      else update({ status: 'error', error: err.message })
    } finally {
      askControllerRef.current = null
      setStreamingDocId(null)
      refreshMeta()
    }
  }

  const selected = documents.find((d) => d.id === selectedId)
  const usage = meta?.usageToday

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__logo">◆</span> DocuMind
        </div>

        <UploadBox
          maxUploadMb={meta?.limits.maxUploadMb ?? 10}
          onUploaded={handleUploaded}
          onError={(text) => setNotice({ type: 'error', text })}
        />

        <div className="sidebar__section">Your documents</div>
        <DocumentList
          documents={documents}
          state={docsState}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDelete={handleDelete}
          onRetry={refreshDocuments}
        />

        <footer className="sidebar__footer">
          {backendError ? (
            <span className="status status--down">● Backend unavailable</span>
          ) : meta ? (
            <>
              <span className="status status--up">● Connected</span>
              <span className="muted small">
                {meta.models.chat} · {meta.models.embedding}
              </span>
              {usage && (
                <span className="muted small" title="Global daily token budgets (server-enforced)">
                  Today: {formatNumber(usage.chatTokens)} / {formatNumber(usage.chatBudget)} chat tokens
                </span>
              )}
            </>
          ) : (
            <span className="muted small">Connecting…</span>
          )}
        </footer>
      </aside>

      <main className="main">
        {notice && (
          <div className={`notice notice--${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}

        {backendError && !meta ? (
          <div className="placeholder">
            <h2>Can't reach the backend</h2>
            <p className="muted">{backendError}</p>
            <p className="muted">
              Start it with <code>cd server &amp;&amp; npm run dev</code>, then{' '}
              <button className="link" onClick={() => (refreshMeta(), refreshDocuments())}>
                retry
              </button>
              .
            </p>
          </div>
        ) : selected?.status === 'ready' ? (
          <ChatPanel
            key={selected.id}
            document={selected}
            messages={chats[selected.id] ?? []}
            streaming={streamingDocId !== null}
            maxChars={meta?.limits.maxQuestionChars ?? 1000}
            onAsk={handleAsk}
            onStop={() => askControllerRef.current?.abort()}
            onClear={() => setChats(({ [selected.id]: _cleared, ...rest }) => rest)}
          />
        ) : selected ? (
          <div className="placeholder">
            <h2>{selected.filename}</h2>
            <p className="muted">
              This document is <strong>{selected.status}</strong>.
              {selected.error && <> {selected.error}</>}
            </p>
          </div>
        ) : (
          <div className="placeholder">
            <h2>Ask questions about your PDFs</h2>
            <p className="muted">
              Upload a PDF on the left. It is split into chunks, embedded, and stored in MongoDB Atlas. Then ask
              anything: answers stream in and cite the pages they come from.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
