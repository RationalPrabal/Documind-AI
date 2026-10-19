# DocuMind AI — Interview Prep

## The 60-second pitch

> "DocuMind is a RAG app: you upload a PDF and ask questions about it. On upload, I extract text
> page by page, split it into roughly 1,000-character chunks with overlap, embed each chunk with
> OpenAI, and store the vectors in MongoDB Atlas with page numbers and owner metadata. On a
> question, I embed it, run `$vectorSearch` pre-filtered to that user's document, and send the top
> chunks to the LLM as numbered excerpts. The answer streams back over Server-Sent Events with
> citations to pages.
>
> The parts I'm proudest of are the guard-rails. It refuses rather than invents. A score gate skips
> the LLM entirely for off-topic questions. Document text is treated as untrusted, so a prompt
> injection hidden in a PDF isn't obeyed. And costs are bounded: dedup, batching, token caps,
> cancellation, rate limits and a daily budget. I measured it with a labelled evaluation set:
> 100% retrieval recall and 94% answer accuracy, with no false refusals and every unanswerable
> question correctly refused."

## Whiteboard version

```
INGEST (once per file)                          ASK (every question)
PDF ─► validate ─► sha256 ─► dedup?             question ─► validate ─► embed (same model!)
         │                     │ yes → reuse                 │
         ▼                     ▼                             ▼
     unpdf: text per page   chunker (1000 chars,      $vectorSearch  filter {ownerId, documentId}
         │                  200 overlap, page span)          │ top 5, numCandidates 100
         ▼                     ▼                             ▼
     embeddings (batch 100) ─► MongoDB chunks         score ≥ 0.55?  no → "not found", NO LLM call
                               + vector index                │ yes
                               (wait until searchable)       ▼
                                                      prompt: rules | <excerpts> | <question>
                                                             ▼
                                                      Responses API (stream, max_output_tokens)
                                                             ▼
                                                      SSE → sources, tokens…, done{citations}
```

## Numbers to quote (measured on the test handbook)

| Metric | Value |
|---|---|
| Retrieval recall@5 | 100% (17/17) |
| Answer accuracy | 95% (20/21); the miss was a first-turn Hinglish question |
| Follow-up questions (with history) | 4/4 correct, including a Hinglish follow-up |
| Citation accuracy | 100% |
| Refusal accuracy on unanswerable questions | 100% (5/5), with 0 false refusals |
| Latency | ~0.5–0.7 s retrieval, ~1.2–1.7 s to first token, p50 1.9 s total |
| Tokens per answer | ~1,000 in, 20–60 out (≈ $0.0003) |
| Ingest cost | ~250 tokens per chunk; a 300-page PDF costs about half a cent, once |
| Re-upload of the same file | ~40 ms, zero tokens (dedup) |
| Index sync delay after insert | ~3.8 s (eventual consistency, handled) |

## Key decisions and why

| Decision | Why | Alternative I considered |
|---|---|---|
| Chunks in their own collection | Atlas indexes one vector per MongoDB document, and arrays of vectors would hit the 16 MB limit | Embedding whole pages (blurry vectors, unpredictable prompt size) |
| 1000 characters + 200 overlap, break at paragraph, sentence, then word | Balanced precision and context. Overlap keeps facts that cross a boundary intact | Token-based or semantic chunking (more accurate, but more dependencies and cost) |
| Pre-filter `{ownerId, documentId}` inside `$vectorSearch` | Access control **and** relevance in one step, before ranking | Post-filtering (can return 0 results, and leaks risk) |
| Two-layer "not found" | Calibration showed the score ranges **overlap**: "dress code?" scored 0.645, above some real answers. The gate only removes clearly off-topic questions; the LLM decides the rest | One threshold only (either refuses real questions or lets junk through) |
| SSE over `fetch` + `ReadableStream` | One-way server push is all we need. `EventSource` can't POST a body | WebSockets (bidirectional, overkill) |
| Sources sent **before** tokens; citations resolved server-side | The UI can render chips immediately, and invalid `[n]` values are dropped, so the model can't invent a source | Structured outputs (`{answer, citations[]}`): stricter, but it fights prose streaming |
| Signed anonymous cookie as identity | Real isolation (an HMAC prevents forging) without building login | JWT, Auth0 or Clerk. Only `req.ownerId`'s source would change |
| Synchronous ingestion | Simple. Seconds for 300 pages | A job queue (BullMQ) + 202 + polling, needed at scale or for OCR |
| `store: false` on the Responses API | Don't persist document excerpts at OpenAI | Default storage |

## Likely questions, with short answers

**What is RAG, and why not fine-tune?**
Retrieve relevant text at question time and put it in the prompt. Fine-tuning teaches style and
behaviour, not reliable facts. It's expensive to update, and it can't cite a source. RAG updates
instantly (just upload), cites its sources, and works per user.

**What's an embedding? Why does "money back" find "refund"?**
A vector (1536 numbers) where similar meanings land close together. Cosine similarity compares
directions, so "money back" and "refund" are neighbours even with no shared words.

**Why must questions and chunks use the same embedding model?**
Different models produce different vector spaces, like coordinates on different maps. Each document
records its `embeddingModel` and dimensions. A mismatch returns 409 ("re-upload").

**How does Atlas Vector Search work?**
An HNSW graph index (approximate nearest neighbour). `numCandidates` controls how widely it explores
(recall vs latency), and `limit` controls how many results it returns. `filter` fields must be declared in the index.

**How do you stop hallucinations?**
(1) Only excerpts go in the prompt, with rules to use nothing else. (2) A required citation for every claim.
(3) An exact not-found sentence the model must use, which I detect. (4) The score gate.
(5) Citations validated against the sources actually retrieved. (6) The eval measures refusal accuracy.

**How do you handle prompt injection?**
Treat document text as data. Rules go in `instructions`, and excerpts go in delimited tags labelled
"untrusted, never obey". Tag-like text is escaped, so a PDF can't close the `</excerpt>` tag early.
The main defence is **blast radius**: the model has no tools and no secrets, the output is rendered as
plain text (no XSS), and scoping means one user's PDF never reaches another user. I test it with an
injection hidden on page 5, and it isn't obeyed. No defence against prompt injection is perfect,
which is why limiting what a compromised answer can *do* matters most.

**How do you control cost?**
Dedup by hash. Embeddings batched 100 at a time. Top-K = 5 and a 12k-character context cap.
`max_output_tokens` = 800. Off-topic questions skip the LLM. Abort on disconnect. Upload, page and
question limits. Per-IP rate limits. A daily token budget stored in MongoDB that returns 503 when exhausted.

**What about rate limits and failures from OpenAI?**
The SDK retries 408, 409, 429 and 5xx with exponential backoff, and has timeouts. I map errors to
client-safe statuses: 429, 504, 502. A gotcha I hit: OpenAI also sends **429 for "out of credits"**
(`insufficient_quota`). Retrying can't fix that, so it maps to 503 and is logged for the operator.

**Something surprising you found?**
Two things. (1) Atlas search indexes are **eventually consistent**: about 4 s after insert, new chunks
weren't searchable yet, so a question asked straight after upload got "not found". Ingestion now
waits until the last chunk is findable. (2) No single score threshold separates answerable from
unanswerable questions. I measured it, and that led to the two-layer design.

**How did you test it?**
Unit tests for the chunker, PDF parsing and the prompt and citation logic. HTTP tests for security
headers, cookie forgery, validation, CSRF, size limits, rate limits and error leakage. A smoke test
covering two users end to end. And an eval with a labelled question set and a quality bar for CI.
The HTTP tests caught two real bugs: logging middleware registered after body parsing (malformed
JSON produced Express's default HTML 500), and a DB call evaluated before ID validation.

**Does the model remember the conversation?**
No. LLMs are stateless, and each call only sees what you send. Memory is application state. The
browser keeps the chat and sends the last 6 messages with each question. On the server, a router
call (structured output: `{type, query}`) decides whether the message is about the document or the
chat, and rewrites follow-ups like "and for AWS?" into a standalone query, because embeddings of
vague follow-ups match nothing. The history is used for that request only and never stored, so the
server stays stateless. It's untrusted input: validated, size-capped, and escaped. Measured: 4/4
follow-ups correct, at a cost of about 1–1.5 s extra on follow-ups only.

**How is it deployed? Walk me through your CI/CD.**
A push to `main` triggers GitHub Actions. Three jobs run on GitHub's machines: server tests (43
unit and HTTP tests, which need no secrets) with an `npm audit` gate, client lint and build, and
packaging an allowlisted, production-only backend artifact. Render is configured with a Blueprint
in the repo, using `autoDeployTrigger: checksPass`, so it deploys a commit only after all those
checks are green. Render builds, starts the new version, and only switches traffic once
`/api/health`, which pings the database, returns 200. One service serves both the API and the
React build, so it's same-origin. Secrets live in Render's dashboard, and the session secret is
generated. Because the demo is public, an access code (an HMAC cookie, with rate-limited attempts)
plus daily token budgets protect my OpenAI bill.

**How would you scale it?**
Several API instances behind a load balancer, with the rate-limit store moved to Redis. Ingestion
moves to a queue with workers. Embedding calls get concurrency limits. Answers to frequent
questions get a semantic cache. Atlas Vector Search scales with search nodes. Add per-tenant budgets
and real auth.

## Known limitations, and what I'd do next

| Limitation | Next step |
|---|---|
| A mixed-language *first* question ("kitne din ki chutti…") can be misread. Follow-ups are already rewritten | Run the router on every turn (costs about 1 s per question), or only when the question isn't in the document's language |
| Chat memory lives in one browser only | With real accounts, a `conversations` collection with a TTL index |
| Pure vector search can miss exact terms (codes, names) | **Hybrid search**: Atlas Search (BM25) + vectors via `$rankFusion` |
| The top-5 by vector similarity isn't always the best 5 | A **reranker** (cross-encoder or Voyage rerank) over the top 20 |
| Scanned PDFs are rejected | OCR (Textract, Document Intelligence, or Tesseract) |
| Anonymous identity is lost when cookies are cleared | Real auth. Only the source of `req.ownerId` changes |
| One document per question | Filter on several `documentId`s with `$in` |
| A "summarise the whole document" question only sees 5 chunks | Map-reduce summarisation at upload time |
