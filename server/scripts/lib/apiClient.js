// Tiny API client for the smoke test and the eval: a cookie jar per "user"
// (like a browser) and a Server-Sent Events reader for /ask.
export const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:4000';

export function createUser() {
  let cookie = '';
  return async (path, init = {}) => {
    const res = await fetch(BASE + path, { ...init, headers: { ...init.headers, cookie } });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('documind_owner='));
    if (set) cookie = set.split(';')[0];
    return res;
  };
}

export async function readSSE(res, { onToken } = {}) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = frame.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? 'null');
      events.push({ event, data });
      if (event === 'token') onToken?.(data.text);
    }
  }
  const answer = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  const get = (name) => events.find((e) => e.event === name)?.data;
  const sources = get('sources');
  return { answer, sources: sources?.sources ?? [], mode: sources?.mode, searchQuery: sources?.searchQuery, done: get('done'), error: get('error') };
}

// Returns { status, body } for JSON errors, or { status, answer, sources, done, error } for streams.
export async function askRaw(as, documentId, question, { onToken, history = [] } = {}) {
  const res = await as(`/api/documents/${documentId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, body: await res.json() };
  return { status: res.status, ...(await readSSE(res, { onToken })) };
}

export async function uploadPdf(as, buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
  const res = await as('/api/documents', { method: 'POST', body: form });
  return { status: res.status, ...(await res.json()) };
}
