import { useEffect, useRef, useState } from 'react'
import AssistantMessage from './AssistantMessage.jsx'

const SUGGESTIONS = ['What is this document about?', 'What are the key rules or numbers mentioned?', 'Is there anything about deadlines?']

export default function ChatPanel({ document, messages, streaming, maxChars, onAsk, onStop, onClear }) {
  const [draft, setDraft] = useState('')
  const endRef = useRef(null)

  // Keep the newest message in view as tokens stream in.
  const lastText = messages.at(-1)?.text
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, lastText])

  function submit(question = draft) {
    const q = question.trim()
    if (!q || streaming || q.length > maxChars) return
    onAsk(q)
    setDraft('')
  }

  const tooLong = draft.length > maxChars

  return (
    <section className="chat">
      <header className="chat__header">
        <h2 title={document.filename}>{document.filename}</h2>
        <span className="muted">
          {document.pageCount} pages · {document.chunkCount} chunks
        </span>
        <button
          className="btn btn--ghost btn--small chat__clear"
          onClick={onClear}
          disabled={streaming || messages.length === 0}
          title="Start over: earlier messages are no longer sent as context"
        >
          New chat
        </button>
      </header>

      <div className="chat__messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask anything about this document. Answers cite the pages they come from.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => submit(s)} disabled={streaming}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg msg--user">
              {m.text}
            </div>
          ) : (
            <AssistantMessage key={m.id} message={m} />
          ),
        )}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter adds a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask a question about this document…"
          rows={2}
          aria-label="Question"
        />
        <div className="composer__side">
          <span className={`counter ${tooLong ? 'counter--over' : ''}`}>
            {draft.length}/{maxChars}
          </span>
          {streaming ? (
            <button type="button" className="btn btn--danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn--primary" disabled={!draft.trim() || tooLong}>
              Ask
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
