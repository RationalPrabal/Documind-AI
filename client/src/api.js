// Every call to the backend goes through this file. The browser only ever
// talks to /api (proxied to Express by Vite in development), so no API keys
// or backend URLs exist anywhere in the client.

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function errorFrom(res) {
  try {
    const body = await res.json()
    return new ApiError(res.status, body.error ?? `Request failed (${res.status})`)
  } catch {
    return new ApiError(res.status, `Request failed (${res.status})`)
  }
}

async function send(path, init) {
  try {
    return await fetch(path, init)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(0, 'Cannot reach the server. Is the backend running?')
  }
}

async function request(path, init) {
  const res = await send(path, init)
  if (!res.ok) throw await errorFrom(res)
  return res.status === 204 ? null : res.json()
}

export const getMeta = () => request('/api/meta')
export const submitAccessCode = (code) =>
  request('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
export const listDocuments = () => request('/api/documents').then((r) => r.documents)
export const deleteDocument = (id) => request(`/api/documents/${id}`, { method: 'DELETE' })

// fetch() cannot report upload progress; XMLHttpRequest can.
export function uploadDocument(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/documents')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => {
      const body = xhr.response ?? {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body)
      else reject(new ApiError(xhr.status, body.error ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload. Is the backend running?'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

// Server-Sent Events over a POST request. The browser's EventSource only
// supports GET with no body, so we read the stream ourselves.
// Wire format, one frame per event:  "event: token\ndata: {...}\n\n"
// `history` = recent turns of this chat. The server uses them for this one
// request (to resolve follow-ups like "and for AWS?") and never stores them.
export async function askQuestion(documentId, question, { history = [], signal, onEvent }) {
  const res = await send(`/api/documents/${documentId}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
    signal,
  })
  // Validation / ownership / rate-limit errors arrive as normal JSON.
  if (!res.ok) throw await errorFrom(res)

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read() // throws AbortError on Stop
    if (done) break
    buffer += value

    // A network chunk can hold several frames, or half of one.
    let end
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      onEvent(event, data ? JSON.parse(data) : null)
    }
  }
}
