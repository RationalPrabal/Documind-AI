import { useState } from 'react'
import { submitAccessCode } from '../api.js'

// Shown when the server requires an access code (ACCESS_CODE is set).
// The code is checked on the server; on success it sets an HttpOnly cookie,
// so this component never stores the code anywhere.
export default function AccessGate({ onGranted }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await submitAccessCode(code.trim())
      onGranted()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="brand">
          <span className="brand__logo">◆</span> DocuMind
        </div>
        <p className="muted">This demo is protected so it can't be used to spend the owner's AI credit. Enter the access code to continue.</p>
        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          aria-label="Access code"
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn--primary btn--block" disabled={!code.trim() || busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  )
}
