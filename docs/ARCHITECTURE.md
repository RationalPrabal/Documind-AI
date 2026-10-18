# DocuMind AI — Architecture

A small RAG (Retrieval-Augmented Generation) app: upload a PDF, ask questions,
get streamed answers grounded in the document with page citations.

## 1. System overview

```
┌──────────────────────┐        ┌───────────────────────────────────────────┐
│  React + Vite (SPA)  │        │            Express API (Node 24)          │
│                      │  /api  │                                           │
│  Upload  ─────────────────────►  POST /api/documents                      │
│  Doc list            │ (proxy │    multer → validate → hash → dedup?      │
│  Chat (streaming) ◄──────────────   → unpdf (per-page text)               │
│  Citations           │  SSE)  │    → chunker → OpenAI embeddings ─────┐   │
│  Cancel (abort)      │        │    → insert chunks                    │   │
└──────────────────────┘        │                                       │   │
                                │  POST /api/documents/:id/ask          │   │
                                │    validate → embed question ─────────┤   │
                                │    → $vectorSearch (owner+doc filter) │   │
                                │    → score gate → build prompt        │   │
                                │    → OpenAI Responses (stream) ───────┤   │
                                │    → SSE: sources, tokens, done       │   │
                                └──────────────┬────────────────────────┼───┘
                                               │                        │
                               ┌───────────────▼─────────┐   ┌──────────▼────────┐
                               │ MongoDB Atlas           │   │ OpenAI API        │
                               │  documents (metadata)   │   │  embeddings       │
                               │  chunks (text+vector)   │   │  responses (LLM)  │
                               │  chunk_vector_index     │   └───────────────────┘
                               └─────────────────────────┘
```

The browser never talks to OpenAI or MongoDB directly. Keys live only in
`server/.env`.

## 2. The two data flows

### Ingestion (once per unique document)

Code: `routes/documents.js` → `services/ingest.js` → `pdf.js`, `chunker.js`, `openai.js`.

1. **Upload**: `multer` holds the file in memory with a size cap, and the server checks the MIME type and the `%PDF-` magic bytes.
2. **Hash + dedup**: SHA-256 of the bytes. If this owner already has a `ready` document with that hash *and the same pipeline settings* (embedding model and dimensions, chunk size and overlap), it's returned with `200` without re-parsing or re-embedding.
3. **Extract**: `unpdf.extractText(pdf, { mergePages: false })` returns one string per page, which preserves page numbers. Malformed PDFs (422), password-protected PDFs (422), PDFs over the page limit (413), and PDFs with no text layer (422) are rejected here, **before** anything is written to the database.
4. **Chunk**: character windows with overlap, ending at paragraph, sentence, or word boundaries. Each chunk records `pageStart`/`pageEnd`.
5. **Claim**: insert the document row as `processing`. The unique `(ownerId, contentHash)` index, plus a compare-and-swap on `updatedAt` for re-ingests, ensures two simultaneous uploads of one file can't both pay to embed it.
6. **Embed**: batches of 100 chunks per request, run sequentially. The client's `AbortSignal` is passed through, so closing the tab stops further paid calls.
7. **Store**: `insertMany` the chunks, then mark the document `ready`. On any failure, chunks are deleted and the document is marked `failed`, or removed entirely if the client cancelled. A failed or stale (>10 min `processing`) document is re-ingested on the next upload.

**Why synchronous?** The upload request waits until ingestion finishes. A 300-page PDF is about 1,000 chunks, or 10 embedding calls, which takes seconds. The alternative is responding `202 Accepted` and processing in a job queue (BullMQ + Redis) while the client polls the status. That's needed at scale or for OCR-heavy work, but it means more infrastructure to run and explain. The `status` field already exists, so the switch would be small.

### Question answering (every question)

Code: `routes/ask.js` → `services/retrieve.js`, `prompt.js`, `openai.js` (`streamAnswer`).

1. **Validate**: zod checks that the question is a non-empty string of at most `MAX_QUESTION_CHARS`, after trimming. The document must exist, belong to the requester, be `ready`, and have been embedded with the *current* model and dimensions (otherwise 409, "re-upload").
2. **Embed the question** with the **same** model and dimensions used for the chunks.
3. **Retrieve**: `$vectorSearch` with a **pre-filter** on `{ ownerId, documentId }`, `numCandidates: 100`, `limit: 5`.
4. **Gate**: drop chunks below `RETRIEVAL_MIN_SCORE`. If none remain, send the not-found answer and **skip the LLM call entirely**.
5. **Budget**: keep chunks in score order until `MAX_CONTEXT_CHARS` is reached.
6. **Build prompt**: `instructions` holds our rules (trusted). `input` holds `<excerpts><excerpt id="1" pages="4-5">…</excerpt></excerpts><question>…</question>` (untrusted). Tag-like text inside the excerpts or the question is escaped, so it can't close our delimiters.
7. **Generate**: `responses.create({ stream: true, max_output_tokens, store: false })`. Setting `store: false` means OpenAI doesn't keep the excerpts.
8. **Stream (SSE)**: `sources`, then many `token` events, then `done` with `{ answered, reason, citations, truncated, usage }`, or `error`. Validation and retrieval run *before* the stream opens, so those failures get normal HTTP status codes. Only generation failures arrive as an `error` event.
9. **Citations**: the server parses `[n]`, `[n][m]` and `[n, m]` from the finished answer and drops any number that wasn't one of the sources sent.
10. **Cancel**: if the client disconnects, `res.on('close')` aborts the OpenAI stream, so you stop paying for tokens nobody reads.

**"Not found" has two layers, and calibration showed why both are needed.** These are the top retrieval scores measured on the handbook test document:

| Question type | Example | Top score |
|---|---|---|
| Answerable | "How much annual leave do I get?" | 0.57 – 0.80 |
| On-topic but **not** in the document | "What is the dress code?" | 0.61 – 0.67 |
| Clearly off-topic | "Who won the cricket world cup?" | 0.52 – 0.56 |

The ranges overlap, so no single threshold separates "answer exists" from "answer doesn't exist". The score gate (0.55) only filters **clearly off-topic** questions, as a cost saving. The **LLM** decides on-topic-but-unanswered questions, because rule 3 of the prompt makes it start its reply with the exact not-found sentence. Wrongly refusing a real question is worse than spending about $0.0003 on an LLM call, so the threshold sits just below the lowest answerable score. Cross-language questions (Hinglish) score lower, which is another reason not to set it higher.

**Eventual consistency.** Atlas Vector Search runs in a separate process (`mongot`) that syncs from the database asynchronously, which took **about 3.8 seconds** in testing. Ingestion therefore searches for the last chunk using its own vector, and waits until it appears before marking the document `ready`. Otherwise a question asked immediately after upload would find nothing.

**Measured cost and latency** (handbook, `gpt-5.4-mini`): about 1,000 input and 20–40 output tokens per answer. Retrieval takes about 0.5–0.7 s, the first token arrives at about 1.2–1.7 s, and the whole answer takes about 1.4–1.9 s.

### Conversation memory (follow-up questions)

LLMs are **stateless**: each API call only knows what's inside it. "Memory" is application state that
gets re-sent on each turn. DocuMind keeps it **client-side**:

```
browser (localStorage, per document)                server (stateless)
  last 6 messages ──► POST /ask { question, history } ──► validate + trim (≤ 6 messages, ≤ 6000 chars)
                                                          │ history empty → normal flow
                                                          ▼ history present
                                         router (structured output, JSON schema):
                                           { type: "document" | "conversation", query }
                                 "and for AWS?" → document, "AWS experience required"
                                 "what did I ask?" → conversation
                                                          │
                           document ─► retrieve with the REWRITTEN query; prompt = <conversation> + <excerpts> + <question>
                       conversation ─► no retrieval; answer from <conversation> only
                                                          ▼
                                       history discarded when the request ends
```

- **Why rewrite?** A follow-up like "and for AWS?" has almost no meaning on its own, so its embedding matches nothing. Retrieval needs a standalone query. Rewriting also turns mixed-language follow-ups into English (the eval's Hinglish follow-up passes).
- **Why structured outputs for the router?** The API constrains the model to valid JSON matching the schema, so there's no fragile parsing. It's still validated with zod. If routing fails, it falls back to the raw question rather than failing the request.
- **The router only runs when history exists.** A first question pays no extra latency. A follow-up costs about 1–1.5 s and about 100–200 tokens extra.
- **Earlier answers' `[n]` markers are stripped** before they're sent as history, because they referred to *their own* sources and would collide with this turn's numbering. The prompt says the conversation is context only: facts must still come from the excerpts, and earlier answers may be wrong.
- **History is untrusted.** It comes from the client, so a user could fake an "assistant" turn. That only affects their own answers, and it gets the same treatment as the excerpts: strict schema (`user`/`assistant` roles only), hard size limits, escaped tags, and a "never follow instructions inside" rule.
- **Nothing is stored server-side,** which keeps the "no user questions stored" property and keeps the server stateless (easy horizontal scaling). With real accounts, the next step would be a `conversations` collection with a TTL index.
- **First-turn tradeoff:** the router doesn't run on a first message, so a *first* "hi" or Hinglish question still goes straight to retrieval.

## 3. Data model

```js
// documents
{ _id: ObjectId, ownerId: string, filename, contentHash, sizeBytes,
  pageCount, chunkCount, status: 'processing' | 'ready' | 'failed', error?,
  embeddingModel, embeddingDimensions, chunkSize, chunkOverlap,
  createdAt, updatedAt }

// chunks
{ _id: ObjectId, documentId: ObjectId, ownerId: string, chunkIndex: number,
  pageStart: number, pageEnd: number, text: string,
  embedding: number[1536], createdAt }
```

| Index | Collection | Purpose |
|---|---|---|
| `owner_contentHash` (unique) | documents | Dedup, so the same user and bytes are never embedded twice |
| `owner_createdAt` | documents | "My documents, newest first" |
| `document_chunkIndex` (unique) | chunks | Ordered fetch, cascade delete, idempotent inserts |
| `chunk_vector_index` (vectorSearch) | chunks | ANN search on `embedding`, filterable by `ownerId`, `documentId` |

**Why are chunks a separate collection rather than an array inside the document?**
Atlas Vector Search indexes one vector per document. A 300-page PDF also
produces about 1,000 chunks of 1,536 floats each, which would blow past the 16 MB BSON limit.

**Why does each chunk store `ownerId`?** Defense in depth. The ownership check
on the document happens first. The vector search then filters by owner **and**
document, so a bug in one layer still cannot leak another user's text.

## 4. Components: what, why, alternatives, trade-offs

### Frontend: React + Vite
- **What:** Upload form, document list, chat panel with a streaming answer, citation chips, a cancel button, and loading and error states.
- **Why Vite:** Fast dev server and HMR. Its `/api` proxy gives the browser a single origin in development, so cookies need no CORS work.
- **Streaming client:** `fetch()` plus `response.body.getReader()`, parsing SSE frames by hand. The browser's `EventSource` only supports GET with no body and offers no clean abort, and asking a question needs a POST with JSON.
- **Alternatives:** Next.js (SSR and API routes in one app, but more framework to explain), or the Vercel AI SDK (`useChat`), which hides the streaming plumbing you want to be able to explain.

### API: Node.js + Express 5
- **What:** HTTP routing, validation (`zod`), upload handling (`multer`), auth scoping, rate limiting, and SSE streaming.
- **Why Express 5:** You already know it. v5 also forwards rejected promises from async handlers to the error middleware, so no `express-async-errors` wrapper is needed.
- **Alternatives:** Fastify (faster, schema-first), NestJS (structure, but heavy), serverless functions (cheap at idle, but awkward for long streams and 10 MB uploads).

### PDF extraction: `unpdf`
- **What:** A thin, maintained wrapper around Mozilla's PDF.js. `extractText(..., { mergePages: false })` gives `string[]`, one entry per page.
- **Why:** Per-page output means correct page citations for free, and it has no native dependencies.
- **Alternatives:** `pdf-parse` v2 (also PDF.js-based, slightly larger API), raw `pdfjs-dist` (most control, most boilerplate), or cloud parsers such as AWS Textract or Azure Document Intelligence (OCR, tables, layout; they cost money and add latency).
- **Trade-off:** It can't read scanned or image-only PDFs, because there is no text layer. We detect "no extractable text" and return a clear error rather than storing empty chunks. OCR is a later extension.

### Chunker (hand-written, about 40 lines)
- **What:** Splits text into roughly `CHUNK_SIZE` characters with `CHUNK_OVERLAP` overlap. It prefers to break at paragraph, then sentence, then word boundaries.
- **Why chunk at all:** Embeddings capture one "topic" per vector, and long inputs dilute it. The prompt also has a budget, so we send only the most relevant few excerpts.
- **Why overlap:** If a key sentence straddles a boundary, the overlap ensures one chunk contains it whole.
- **Why characters, not tokens:** No tokenizer dependency, and the code is easy to explain. About 4 characters make 1 English token, so 1,000 characters is roughly 250 tokens.
- **Alternatives:** Token-based splitting (`tiktoken`), LangChain's `RecursiveCharacterTextSplitter` (the same idea as a library), semantic chunking (splitting where embedding similarity drops, which costs extra embedding calls), or structure-aware chunking by headings.
- **Trade-off:** Smaller chunks retrieve more precisely but carry less context per hit. Larger chunks give richer context but noisier retrieval and more tokens per question.

### Embeddings: OpenAI `text-embedding-3-small` (configurable)
- **What:** Maps text to a 1,536-dimensional vector, where semantic similarity becomes vector closeness.
- **Why:** It's cheap, good quality, and supports a `dimensions` parameter for shrinking vectors.
- **Key rule:** Questions and chunks **must** use the same model and dimensions. So the document stores `embeddingModel`, and changing the model means re-running `setup:indexes` and re-ingesting.
- **Alternatives:** `text-embedding-3-large` (better recall, about 6× the cost, 3,072 dimensions), Voyage AI (MongoDB-owned, strong retrieval models), or local models such as `bge` or `nomic` via Ollama (free, but you operate them).

### Vector store: MongoDB Atlas Vector Search
- **What:** An approximate nearest-neighbour (HNSW) index over `chunks.embedding`, queried with the `$vectorSearch` aggregation stage.
- **Why:** Your app data and vectors live in one database. Metadata filtering comes built in (`filter` fields), there's no extra service to run, and it works on the free M0 tier.
- **`numCandidates` vs `limit`:** HNSW examines `numCandidates` neighbours and returns the best `limit`. Raising it improves recall at the cost of latency; roughly 10–20× `limit` is the usual starting point.
- **Similarity:** cosine. Atlas normalizes the score to 0–1, which is what `RETRIEVAL_MIN_SCORE` compares against.
- **Alternatives:** pgvector (if you're on Postgres), Pinecone, Qdrant, or Weaviate (purpose-built, with more tuning knobs, but another system to sync), or an in-memory store such as FAISS (fine for demos, but loses data on restart).
- **Trade-off:** Search indexes build **asynchronously**, so a freshly inserted chunk is searchable after a short delay. It needs Atlas, or a local Atlas deployment via the Atlas CLI.

### Generation: OpenAI Responses API (configurable model)
- **What:** `client.responses.create({ model, instructions, input, max_output_tokens, stream: true })`. We forward `response.output_text.delta` events to the browser.
- **Why Responses rather than Chat Completions:** It's OpenAI's current primary API, with typed stream events and a first-class `instructions` field. Chat Completions still works, but newer features land in Responses first.
- **Grounding and refusal, in two layers:** (1) the retrieval score gate means no evidence leads to no LLM call. (2) The system prompt tells the model to answer only from the excerpts, cite them as `[n]`, and say plainly when they don't contain the answer.
- **Citations:** The excerpts are numbered in the prompt, and the server already knows each `[n]`'s chunk ID and pages, so it sends that mapping to the client before the tokens. The UI turns `[2]` into a "p. 7" chip. Citations are only ever built from chunks we actually retrieved, never from text the model invents.
- **Alternative:** Structured outputs (a JSON schema `{ answer, citations[] }`). Validation is stricter, but you can't show partial prose as cleanly while it streams. That's a good interview trade-off to mention; we may add it as a non-streaming mode.

### Identity and access scoping
- **What:** On the first request, the server issues a random `ownerId` in a **signed, HttpOnly, SameSite=Lax** cookie (`cookie-parser` plus `SESSION_SECRET`). Every query includes `ownerId`, so you can't read or ask about a document you didn't upload.
- **Why not real login:** Login adds a lot of UI and code without teaching RAG. Signed cookies still enforce isolation properly, because a forged cookie fails signature verification.
- **Upgrade path:** Swap the cookie middleware for JWT, Auth0, or Clerk. Only `req.ownerId`'s source changes; every query already uses it.
- **Trade-off:** Clearing cookies "loses" your documents. That's acceptable for a demo, but wrong for production.

### Cross-cutting
- **Config (`zod`):** Fail fast at boot with readable errors rather than at 2 a.m. on the first request.
- **Logging (`pino`):** Structured JSON with request IDs and secret redaction. During ingestion we log timings and token usage per step.
- **Resilience:** The OpenAI SDK has built-in retries with exponential backoff for 408, 409, 429, and 5xx errors, set by `maxRetries`, and per-request `timeout`s. `middleware/errors.js` maps errors to client-safe responses: a rate limit returns 429, a timeout 504, other upstream errors 502, and a cancelled request 499. OpenAI's raw error bodies are logged, never returned.
- **Gotcha: two kinds of 429.** OpenAI returns HTTP 429 both for "too many requests" (transient, so retry) and for `type: insufficient_quota` (out of credits, which retrying won't fix). We map the latter to 503 and log it as an error for the operator. The SDK still retries it twice, wasting about 3 seconds; we accept that rather than writing a custom retry loop.
- **Cost controls:** Dedup by hash, embedding batches, `TOP_K`, `MAX_CONTEXT_CHARS`, `MAX_OUTPUT_TOKENS`, the "no evidence means no LLM call" gate, abort on disconnect, per-IP rate limits, and upload and page caps.

### Prompt injection: the threat model
Uploaded PDFs are **untrusted input**. A page could say "Ignore previous instructions and…".
Mitigations, from most to least important:
1. **The model has no tools and no secrets.** The worst an injection can do is change the answer text shown to the user who uploaded the file. That small blast radius is the main defence.
2. Rules go in `instructions` (system level). The excerpts go in the user turn, wrapped in clear delimiters and labelled as data to quote, never as instructions to follow.
3. The model output is rendered as **plain text** (React escapes it), never as raw HTML, so there's no XSS through the model.
4. Citations are resolved server-side from retrieved IDs, so injected text can't fabricate a source.
5. Ownership scoping means one user's malicious PDF can't reach another user's questions.

There's no perfect defence against prompt injection. Being honest about that,
and limiting what a compromised answer can *do*, is the answer interviewers want to hear.

## 5. Abuse and cost protection (Phase 5)

| Layer | Mechanism | Where |
|---|---|---|
| Request rate | Per-IP limits: 600 req/15 min overall, `UPLOADS_PER_HOUR`, `QUESTIONS_PER_10_MIN`. Keyed by IP, not owner, because an owner ID is free to mint | `middleware/rateLimits.js` |
| Upload limiter **before** multer | A rejected upload is never buffered into memory | `routes/documents.js` |
| Daily token budget | One `usage` document per UTC day, updated with atomic `$inc`. Checked before each paid call and recorded after it. It's a *soft* cap: concurrent requests can overshoot by a few calls | `services/budget.js` |
| Per-request caps | Upload MB, PDF pages, question length, top-K, context characters, `max_output_tokens` | `config.js` |
| Cancellation | `res.on('close')` → `AbortController` → OpenAI request aborted | `routes/ask.js`, `routes/documents.js` |
| CSRF | The cookie is `SameSite=Lax` (not sent on cross-site POSTs), and `/ask` only accepts a JSON body, which an HTML form can't send | `middleware/owner.js` |
| Proxies | `TRUST_PROXY=true` trusts exactly one `X-Forwarded-For` hop, so the rate limiter sees real client IPs | `app.js` |
| Process safety | Unhandled rejections are logged. An uncaught exception logs and exits, and the process manager restarts it | `server.js` |

Rate-limit counters live in memory, which is correct for a single process. With multiple instances,
a shared store (Redis) is needed so the limits apply across all of them.

## 6. Testing strategy (Phase 6)

| Level | Tool | Scope |
|---|---|---|
| Unit | `node:test` | Pure logic: chunker, PDF parsing and rejection, prompt escaping, citation parsing |
| HTTP | `node:test` + real socket | Middleware and validation paths that reject before the DB or OpenAI: headers, cookie signing and forgery, 400/404/413/415, CSRF, rate limits, no error leakage |
| End to end | `npm run smoke` | Real Atlas + OpenAI, with two users: ingestion, dedup, isolation, answers, refusals, injection, cancellation |
| Quality | `npm run eval` | A labelled question set: retrieval recall@k, answer accuracy, citation accuracy, refusal accuracy, latency, tokens, with a pass/fail bar |

Answer correctness is checked with regexes (deterministic and free). A common alternative is
**LLM-as-judge**: a second model grades faithfulness and relevance. It scales to open-ended answers,
but it costs money and adds its own errors.

## 7. Deliberately out of scope for v1
Reranking (a cross-encoder or Voyage rerank on the top 20), hybrid lexical plus
vector search (`$rankFusion` with Atlas Search), multi-document questions, OCR,
background job queues, conversation memory, MCP, and agent frameworks. Each is
a good "how would you extend this?" answer.

## 8. Project structure

```
DocuMind AI/
├── .nvmrc                          # Node 24 LTS
├── README.md                       # setup, run and test instructions
├── docs/ARCHITECTURE.md            # this file
├── docs/INTERVIEW.md               # pitch, numbers, Q&A
├── server/
│   ├── .env.example                # all config, documented
│   ├── atlas/chunk_vector_index.json   # index JSON for the Atlas UI
│   ├── scripts/
│   │   ├── setupIndexes.js         # regular + vector indexes (idempotent)
│   │   ├── smoke.js                # end-to-end checks against a running server
│   │   ├── eval.js                 # quality metrics on a labelled question set
│   │   └── lib/apiClient.js        # cookie jar + SSE reader shared by smoke/eval
│   ├── src/
│   │   ├── server.js               # boot: connect DB, listen, graceful shutdown
│   │   ├── app.js                  # express app (importable by tests)
│   │   ├── config.js               # zod-validated env
│   │   ├── logger.js               # pino
│   │   ├── db.js                   # MongoClient singleton + collections
│   │   ├── errors.js, ids.js       # HttpError, strict id parsing
│   │   ├── middleware/             # owner.js (identity), errors.js, rateLimits.js
│   │   ├── routes/                 # health, meta, documents, ask (SSE)
│   │   └── services/               # pdf, chunker, openai (embed, route, stream), ingest, retrieve, prompt, budget
│   └── test/                       # unit + HTTP tests, helpers/makePdf.js, fixtures/handbook.js (+ eval set)
└── client/                         # Vite + React
    ├── vite.config.js              # /api proxy → :4000
    └── src/
        ├── api.js                  # fetch wrappers, XHR upload with progress, SSE reader
        ├── App.jsx                 # state: documents, per-document chats, streaming, notices
        ├── format.js
        └── components/             # UploadBox, DocumentList, ChatPanel, AssistantMessage
```
