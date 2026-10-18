# DocuMind AI

Upload a PDF, ask questions about it, and get streamed answers that cite the pages they come from.
When the document doesn't contain the answer, it says so instead of inventing one.

**Stack:** React + Vite · Node.js + Express 5 · MongoDB Atlas Vector Search · OpenAI (embeddings + Responses API)

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works, the alternatives, and the trade-offs
- [docs/INTERVIEW.md](docs/INTERVIEW.md): talk-track, measured numbers, likely questions with answers

---

## Setup (one time)

**Prerequisites:** Node.js 22.12+ (24 LTS recommended; `sudo n 24` or `nvm install && nvm use`),
a MongoDB Atlas cluster (the free tier supports Vector Search), and an OpenAI API key with credits.

1. **Atlas:** create a cluster → *Database Access*: add a user → *Network Access*: add your IP →
   *Connect → Drivers*: copy the `mongodb+srv://…` string.
2. **Configure:**
   ```bash
   cp server/.env.example server/.env
   # edit server/.env: MONGODB_URI, OPENAI_API_KEY, SESSION_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → SESSION_SECRET
   ```
3. **Install:**
   ```bash
   cd server && npm install && cd ../client && npm install
   ```
4. **Create the indexes** (again only if you change the embedding model or dimensions):
   ```bash
   cd server && npm run setup:indexes      # waits until the vector index is READY
   ```
   *Alternative:* paste [server/atlas/chunk_vector_index.json](server/atlas/chunk_vector_index.json) into
   Atlas → Search & Vector Search → Create Search Index → Vector Search → JSON editor
   (database `documind`, collection `chunks`, name `chunk_vector_index`).

## Run

```bash
cd server && npm run dev        # terminal 1 → API on http://localhost:4000
cd client && npm run dev        # terminal 2 → open http://localhost:5173
```

---

## Try everything in the UI

Use any PDF with real text. To get the same test document the automated tests use:
```bash
cd server && node -e "import('./test/fixtures/handbook.js').then(m => require('fs').writeFileSync('handbook.pdf', m.makeHandbookPdf()))"
```

| # | Do this | You should see | Feature |
|---|---|---|---|
| 1 | Open the app | "● Connected", the model names, today's token usage (bottom left) | Health + `/api/meta` |
| 2 | Click **Upload PDF** (or drag one in) | A progress bar, then "Extracting, embedding, indexing…", then a green "ready: N pages, M chunks" notice | Upload → extract → chunk → embed → index |
| 3 | Upload the **same file again** | Blue "already uploaded… no cost" notice, almost instantly | Dedup by content hash |
| 4 | Try a `.txt` file, or a file over 10 MB | A red error, without the file being sent | Client-side validation (the server re-checks) |
| 5 | Ask *"How much paid annual leave do I get?"* | The answer streams in word by word, with a **Stop** button while it runs | SSE streaming |
| 6 | Click a blue citation chip like `1` | That source opens and shows the exact text and page range | Citations |
| 7 | Look under the answer | `5 sources · top score 0.80 · 998 in / 48 out tokens · 2.2s` | Observability |
| 8 | Ask *"Who won the cricket world cup?"* | "I couldn't find…" plus a note that **the AI model was not called** | Score gate (no cost) |
| 9 | Ask *"What is the dress code?"* | "I couldn't find…": the model checked the excerpts and refused | Grounded refusal |
| 10 | Ask *"Do employees get unlimited paid leave?"* (handbook) | "No… 24 days". Page 5 contains an "ignore all instructions" attack, and it isn't obeyed | Prompt-injection defence |
| 10a | After #5, ask a follow-up: *"And can I carry them over?"* | A correct answer plus **🔎 Searched for: "…carried over…"**, the standalone question that was actually searched | Conversation memory + query rewriting |
| 10b | Ask *"What was my first question?"* | It quotes your first question, with "Answered from this conversation; the document was not searched" | Routing (structured outputs) |
| 10c | Reload the page | The chat is still there (saved in this browser only) | `localStorage` persistence |
| 10d | Click **New chat**, then ask the follow-up again | Earlier messages are no longer used as context | Clearing memory |
| 11 | Ask a long question, then click **Stop** | "Stopped." The server log says "Answer cancelled by client" | Cancellation saves tokens |
| 12 | Type more than 1000 characters | The counter turns red and Ask is disabled | Input limits |
| 13 | Open the app in a **private window** | An empty document list: it's a different identity | Per-user scoping |
| 14 | Stop the backend, then reload | "Can't reach the backend" with a retry link | Error states |
| 15 | Click ✕ on a document | It disappears, along with all its chunks in Atlas | Delete cascade |
| 16 | Shrink the window to phone width | The layout stacks, with no sideways scrolling | Responsive |

While you do this, watch terminal 1: every request is logged with timings, scores and token counts.

---

## Automated tests

| Command | Needs | What it checks | Cost |
|---|---|---|---|
| `cd server && npm test` | nothing | 37 tests: chunker, PDF parsing, prompt and citation logic, and the HTTP layer (security headers, signed cookie, forged cookie, validation, CSRF, upload limits, rate limiting, no error leakage) | free |
| `npm run smoke` | server running | 20 end-to-end checks: upload, dedup, access control between two users, answers and citations, both refusal paths, prompt injection, follow-ups and memory, cancellation, cleanup | < $0.01 |
| `npm run eval` | server running | 26 labelled questions (including follow-ups) → retrieval recall, answer accuracy, citation accuracy, refusal accuracy, latency, tokens. Exits non-zero below the quality bar | ~ $0.01 |
| `cd client && npm run lint && npm run build` | nothing | Lint + production build | free |

Last eval run: retrieval recall **100%**, answer accuracy **95%** (20/21), citation accuracy **100%**,
follow-ups **4/4**, refusal accuracy **100%** (5/5), p50 latency **1.6 s**.

---

## API reference

All `/api/documents` routes are scoped to the caller's signed `documind_owner` cookie.

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/health` | `{ status, db }`, or 503 if MongoDB is unreachable |
| `GET` | `/api/meta` | limits, model names, today's token usage and budgets |
| `POST` | `/api/documents` | multipart field `file` → `201` new, `200` deduplicated |
| `GET` | `/api/documents` | the caller's documents, newest first |
| `GET` | `/api/documents/:id` | one document (`404` if it isn't yours) |
| `DELETE` | `/api/documents/:id` | `204`; removes the document and its chunks |
| `POST` | `/api/documents/:id/ask` | `{ "question": "...", "history": [{ "role": "user"\|"assistant", "text": "..." }] }` → Server-Sent Events. `history` is optional; the server uses it for this request only and never stores it |

The `/ask` stream:
```
event: sources   data: {"mode":"document","searchQuery":null,"sources":[{"id":1,"pageStart":2,"pageEnd":2,"score":0.82,"text":"..."}]}
event: token     data: {"text":"Full-time employees receive "}
event: done      data: {"answered":true,"citations":[1],"truncated":false,"usage":{"inputTokens":998,"outputTokens":48}}
```
`mode` is `"document"` (searched the PDF) or `"conversation"` (answered from the history, e.g. "what did I ask?").
`searchQuery` is the rewritten standalone question when a follow-up was rewritten. `answered: false` comes with `reason: "no_relevant_context"` (no LLM call was made) or `"model_found_no_answer"`.

With curl:
```bash
curl -c jar -b jar -F "file=@your.pdf;type=application/pdf" localhost:4000/api/documents        # note the "id"
curl -N -b jar -H 'content-type: application/json' -d '{"question":"..."}' localhost:4000/api/documents/<id>/ask
```

| Status | Meaning |
|---|---|
| 400 | Invalid input (empty or over-long question, malformed JSON, no file) |
| 404 | Not found, **or not yours** (the two are indistinguishable on purpose) |
| 409 | Document not ready, or processed with an older embedding model |
| 413 / 415 / 422 | File too big or too many pages / not a PDF / damaged, encrypted or scanned |
| 429 | Rate limit (per IP) or OpenAI rate limit |
| 502 / 504 | OpenAI error / timeout |
| 503 | Daily token budget exhausted, or the OpenAI account is out of credits |

## Configuration

Every setting is documented in [server/.env.example](server/.env.example): models, chunk size and overlap,
top-K, score threshold, context and output token caps, upload limits, rate limits, and daily token budgets.

---

## Security notes (read before deploying or forking)

- **Never commit `server/.env`.** It's git-ignored. If a key is ever committed, **rotate it immediately**: deleting the file doesn't remove it from git history.
- **This is a learning project, not production auth.** Identity is an anonymous signed cookie, so anyone who can reach a deployed instance can upload and ask questions on your OpenAI key. Spend is bounded by per-IP rate limits and the daily token budgets in `.env`, but add real authentication before exposing it publicly.
- Also set a **monthly usage limit in your OpenAI dashboard**, as a second safety net independent of this app.
- Uploaded PDFs are treated as untrusted input (prompt-injection defences are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), but don't upload confidential documents to a demo deployment.

## Labs

[`labs/sse-lab.mjs`](labs/sse-lab.mjs) is a standalone, dependency-free server for practising Server-Sent Events (`node labs/sse-lab.mjs`, then open http://localhost:3001).
