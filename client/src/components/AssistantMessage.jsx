import { useRef, useState } from 'react'
import { formatPages, formatNumber } from '../format.js'

const REASONS = {
  no_relevant_context: 'No passage in the document was relevant enough, so the AI model was not called (no generation cost).',
  model_found_no_answer: 'The model read the most relevant passages and found no answer in them.',
}

// Turns "… 24 days [1][2]." into text + clickable citation chips.
// Everything is rendered as React text nodes (auto-escaped), never as HTML,
// so a malicious document can't inject markup through the model's answer.
function AnswerText({ text, sources, onCite }) {
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g)
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/)
    if (!match) return <span key={i}>{part}</span>
    return match[1].split(',').map((n) => {
      const source = sources[Number(n) - 1]
      // A number with no matching source is a hallucinated citation: show it as plain text.
      if (!source) return <span key={`${i}-${n}`}>[{n.trim()}]</span>
      return (
        <button key={`${i}-${n}`} className="cite" onClick={() => onCite(source.id)} title={formatPages(source)}>
          {source.id}
        </button>
      )
    })
  })
}

export default function AssistantMessage({ message }) {
  const [openId, setOpenId] = useState(null)
  const sourceRefs = useRef({})
  const { text, sources = [], status, citations = [], reason, truncated, usage, elapsedMs, error, mode, searchQuery } = message
  const notFound = status === 'done' && message.answered === false

  function cite(id) {
    setOpenId(id)
    sourceRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  return (
    <div className={`msg msg--assistant ${notFound ? 'msg--notfound' : ''}`}>
      <div className="msg__body">
        {text ? <AnswerText text={text} sources={sources} onCite={cite} /> : null}
        {status === 'streaming' && !text && <span className="muted">Searching the document…</span>}
        {status === 'streaming' && <span className="cursor" aria-hidden />}
      </div>

      {searchQuery && (
        <p className="msg__note" title="Your follow-up was rewritten into a standalone question before searching">
          🔎 Searched for: “{searchQuery}”
        </p>
      )}
      {mode === 'conversation' && status === 'done' && (
        <p className="msg__note">ⓘ Answered from this conversation; the document was not searched.</p>
      )}
      {notFound && reason && <p className="msg__note">ⓘ {REASONS[reason] ?? reason}</p>}
      {truncated && <p className="msg__note msg__note--warn">Answer was cut off at the output token limit.</p>}
      {status === 'cancelled' && <p className="msg__note">Stopped.</p>}
      {status === 'error' && <p className="msg__note msg__note--error">⚠ {error}</p>}

      {sources.length > 0 && !notFound && (
        <div className="sources">
          <div className="sources__title">Sources</div>
          {sources.map((s) => (
            <details
              key={s.id}
              ref={(el) => (sourceRefs.current[s.id] = el)}
              open={openId === s.id}
              onToggle={(e) => {
                // One source open at a time; keeps state in sync with clicks on <summary>.
                const isOpen = e.currentTarget.open
                if (isOpen && openId !== s.id) setOpenId(s.id)
                if (!isOpen && openId === s.id) setOpenId(null)
              }}
              className={`source ${citations.includes(s.id) ? 'source--cited' : ''}`}
            >
              <summary>
                <span className="source__id">{s.id}</span>
                <span>{formatPages(s)}</span>
                <span className="source__score" title="Vector similarity (0–1)">
                  score {s.score.toFixed(2)}
                </span>
                {citations.includes(s.id) && <span className="source__tag">cited</span>}
              </summary>
              <p className="source__text">{s.text}</p>
            </details>
          ))}
        </div>
      )}

      {status === 'done' && (
        <div className="msg__meta">
          {mode === 'conversation' ? 'conversation' : `${sources.length} sources`}
          {sources[0] && <> · top score {sources[0].score.toFixed(2)}</>}
          {usage && (
            <>
              {' '}
              · {formatNumber(usage.inputTokens)} in / {formatNumber(usage.outputTokens)} out tokens
            </>
          )}
          {elapsedMs != null && <> · {(elapsedMs / 1000).toFixed(1)}s</>}
        </div>
      )}
    </div>
  )
}
