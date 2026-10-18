// Offline-style evaluation of retrieval + answers on a labelled question set.
// Requires a RUNNING server (npm run dev). ~25 questions, costs ~1-2 cents.
//
//   npm run eval
//
// Metrics (answerable questions unless noted):
//   retrieval recall@k   expected page is inside one of the retrieved sources
//   answer accuracy      answer contains the expected fact (regex)
//   citation accuracy    at least one CITED source covers the expected page
//   false refusals       answerable, but the app said "not found"
//   refusal accuracy     (unanswerable) the app correctly said "not found"
import { makeHandbookPdf, evalSet } from '../test/fixtures/handbook.js';
import { BASE, createUser, askRaw, uploadPdf } from './lib/apiClient.js';

// Quality bar for the exit code (useful in CI). One known-hard case (the
// Hinglish question) is allowed to fail; refusals must be perfect, because
// answering an unanswerable question means inventing facts.
const MIN_ANSWER_ACCURACY = 0.9;
const MIN_REFUSAL_ACCURACY = 1.0;

const covers = (s, page) => s.pageStart <= page && page <= s.pageEnd;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');

const as = createUser();
const up = await uploadPdf(as, makeHandbookPdf(), 'eval-handbook.pdf');
if (!up.document) {
  console.error(`Upload failed (HTTP ${up.status}): ${up.error}. Is the server running at ${BASE}?`);
  process.exit(1);
}
const id = up.document.id;
console.log(`Evaluating ${evalSet.length} questions against ${BASE}\n`);

const rows = [];
for (const item of evalSet) {
  const answerable = item.answerable !== false;
  const t = performance.now();
  const r = await askRaw(as, id, item.q, { history: item.history });
  const ms = performance.now() - t;
  if (!r.done) {
    rows.push({ ...item, answerable, error: r.body?.error ?? r.error?.message ?? `HTTP ${r.status}` });
    continue;
  }
  const refused = r.done.answered === false;
  const cited = r.done.citations.map((n) => r.sources[n - 1]);
  const hasPage = answerable && item.page != null;
  rows.push({
    ...item,
    answerable,
    ms,
    refused,
    reason: r.done.reason,
    topScore: r.sources[0]?.score,
    retrievalHit: hasPage ? r.sources.some((s) => covers(s, item.page)) : null,
    correct: !answerable
      ? refused
      : !refused && item.expect.test(r.answer) && (item.mode ? r.done.mode === item.mode : r.done.mode === 'document'),
    citationHit: hasPage ? cited.some((s) => covers(s, item.page)) : null,
    searchQuery: r.searchQuery,
    tokens: (r.done.usage?.inputTokens ?? 0) + (r.done.usage?.outputTokens ?? 0),
    answer: r.answer.replace(/\s+/g, ' ').slice(0, 90),
  });
}

const mark = (v) => (v === null || v === undefined ? ' ' : v ? '✓' : '✗');
console.log('ok  retr cite  score  ms     question → answer');
for (const r of rows) {
  if (r.error) {
    console.log(`✗   -    -     -      -      ${r.q}  (ERROR: ${r.error})`);
    continue;
  }
  const tag = r.tag ? ` [${r.tag}]` : r.answerable ? '' : ' [unanswerable]';
  console.log(
    `${mark(r.correct)}   ${mark(r.retrievalHit)}    ${mark(r.citationHit)}     ${r.topScore?.toFixed(2) ?? ' -  '}   ${String(Math.round(r.ms)).padEnd(6)} ${r.q}${tag}\n${r.searchQuery ? `${' '.repeat(36)}🔎 ${r.searchQuery}\n` : ''}${' '.repeat(36)}→ ${r.answer}`,
  );
}

const ok = rows.filter((r) => !r.error);
const ans = ok.filter((r) => r.answerable);
const paged = ans.filter((r) => r.page != null); // retrieval/citation metrics only apply to these
const unans = ok.filter((r) => !r.answerable);
const llmCalls = ok.filter((r) => r.reason !== 'no_relevant_context');
const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
console.log(`
Summary
  retrieval recall@k   ${pct(paged.filter((r) => r.retrievalHit).length, paged.length)}  (${paged.filter((r) => r.retrievalHit).length}/${paged.length})
  answer accuracy      ${pct(ans.filter((r) => r.correct).length, ans.length)}  (${ans.filter((r) => r.correct).length}/${ans.length})
  citation accuracy    ${pct(paged.filter((r) => r.citationHit).length, paged.length)}  (${paged.filter((r) => r.citationHit).length}/${paged.length})
  follow-ups correct   ${ok.filter((r) => r.history).filter((r) => r.correct).length}/${ok.filter((r) => r.history).length}
  false refusals       ${ans.filter((r) => r.refused).length}
  refusal accuracy     ${pct(unans.filter((r) => r.correct).length, unans.length)}  (${unans.filter((r) => r.correct).length}/${unans.length})
  LLM calls skipped    ${ok.length - llmCalls.length} of ${ok.length} (score gate)
  latency p50 / p95    ${Math.round(latencies[Math.floor(latencies.length / 2)])} ms / ${Math.round(latencies[Math.floor(latencies.length * 0.95)])} ms
  chat tokens total    ${ok.reduce((n, r) => n + r.tokens, 0)}
  errors               ${rows.length - ok.length}`);

await as(`/api/documents/${id}`, { method: 'DELETE' });
const answerAccuracy = ans.filter((r) => r.correct).length / ans.length;
const refusalAccuracy = unans.filter((r) => r.correct).length / unans.length;
const passed = rows.length === ok.length && answerAccuracy >= MIN_ANSWER_ACCURACY && refusalAccuracy >= MIN_REFUSAL_ACCURACY;
console.log(`\n${passed ? 'PASS' : 'FAIL'} (bar: answer accuracy ≥ ${MIN_ANSWER_ACCURACY * 100}%, refusal accuracy ≥ ${MIN_REFUSAL_ACCURACY * 100}%, no errors)`);
process.exit(passed ? 0 : 1);
