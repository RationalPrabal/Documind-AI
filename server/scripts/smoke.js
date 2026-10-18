// End-to-end smoke test against a RUNNING server (npm run dev first).
// Exercises Phases 1-3 with real MongoDB + OpenAI. Costs well under $0.01.
//
//   npm run smoke            # cleans up after itself
//   npm run smoke -- --keep  # leave the test document in the database
import { makeHandbookPdf } from '../test/fixtures/handbook.js';
import { BASE, createUser as user, askRaw } from './lib/apiClient.js';

const KEEP = process.argv.includes('--keep');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const ask = async (as, id, question, history = []) => {
  process.stdout.write(`\n    Q: ${question}${history.length ? `  (+${history.length} history messages)` : ''}\n    A: `);
  const r = await askRaw(as, id, question, { history, onToken: (t) => process.stdout.write(t) });
  if (!r.done) {
    console.log(`(HTTP ${r.status}${r.body ? `: ${r.body.error}` : ''})\n`);
    return r;
  }
  const cited = r.done.citations.map((n) => r.sources[n - 1]).map((s) => `[${s.id}] p.${s.pageStart}${s.pageEnd !== s.pageStart ? `-${s.pageEnd}` : ''}`);
  console.log(`\n    mode: ${r.mode}${r.searchQuery ? `, searched for: "${r.searchQuery}"` : ''}, sources: ${r.sources.length}, cited: ${cited.join(' ') || 'none'}, reason: ${r.done.reason ?? '-'}\n`);
  return r;
};

const alice = user();
const mallory = user();

console.log(`Smoke test against ${BASE}\n`);

console.log('Phase 1: setup');
const health = await alice('/api/health').then((r) => r.json()).catch(() => null);
check(health?.status === 'ok', 'server is up and MongoDB is connected');
if (!health) process.exit(1);

console.log('\nPhase 2: ingestion');
const form = new FormData();
form.append('file', new Blob([makeHandbookPdf()], { type: 'application/pdf' }), 'smoke-handbook.pdf');
let res = await alice('/api/documents', { method: 'POST', body: form });
const { document: doc } = await res.json();
check([200, 201].includes(res.status) && doc?.status === 'ready', 'upload → ready', `${doc?.pageCount} pages, ${doc?.chunkCount} chunks`);

res = await alice('/api/documents', { method: 'POST', body: form });
check((await res.json()).deduplicated === true, 're-upload is deduplicated (no new embeddings)');

const list = await alice('/api/documents').then((r) => r.json());
check(list.documents.some((d) => d.id === doc.id), 'document appears in owner\'s list');

const bad = new FormData();
bad.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'fake.pdf');
check((await alice('/api/documents', { method: 'POST', body: bad })).status === 415, 'fake PDF is rejected (415)');

console.log('\nAccess control');
check((await mallory(`/api/documents/${doc.id}`)).status === 404, 'another user cannot read it (404)');
check((await ask(mallory, doc.id, 'How much leave?')).status === 404, 'another user cannot ask about it (404)');
check((await mallory('/api/documents').then((r) => r.json())).documents.length === 0, 'another user sees an empty list');

console.log('\nPhase 3: questions');
let r = await ask(alice, doc.id, 'How many days of paid annual leave do I get?');
check(r.done?.answered && /24/.test(r.answer), 'answers from the document', 'mentions 24 days');
check(r.done?.citations.some((n) => r.sources[n - 1].pageEnd >= 2 && r.sources[n - 1].pageStart <= 2), 'cites page 2');

r = await ask(alice, doc.id, 'Who won the cricket world cup?');
check(r.done?.answered === false && r.done.reason === 'no_relevant_context', 'off-topic question refused without calling the LLM');

r = await ask(alice, doc.id, 'What is the company dress code?');
check(r.done?.answered === false, 'on-topic but unanswered question: model admits it', r.done?.reason);

r = await ask(alice, doc.id, 'How much is the yearly learning budget?');
check(/50,?000/.test(r.answer) && !/unlimited paid leave/i.test(r.answer), 'prompt injection on page 5 is not obeyed');

console.log('\nConversation memory (history sent by the client, never stored)');
const leaveQ = 'How many days of paid annual leave do I get?';
const first = await ask(alice, doc.id, leaveQ);
const history = [{ role: 'user', text: leaveQ }, { role: 'assistant', text: first.answer }];
r = await ask(alice, doc.id, 'And can I carry them over?', history);
check(r.done?.answered && /10/.test(r.answer) && !!r.searchQuery, 'follow-up is rewritten and answered', `searched for "${r.searchQuery}"`);
r = await ask(alice, doc.id, 'What was my previous question?', history);
check(r.mode === 'conversation' && /leave/i.test(r.answer), 'question about the chat is answered from history');

console.log('\nValidation');
check((await ask(alice, doc.id, '   ')).status === 400, 'empty question → 400');
check((await ask(alice, doc.id, 'x'.repeat(5000))).status === 400, 'over-long question → 400');
check((await ask(alice, 'not-an-id', 'hi')).status === 404, 'invalid id → 404');

console.log('\nCancellation');
const controller = new AbortController();
const streamRes = await alice(`/api/documents/${doc.id}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question: 'Summarise every chapter of the handbook in detail.' }),
  signal: controller.signal,
});
try {
  for await (const _ of streamRes.body) {
    controller.abort(); // stop after the first bytes arrive
  }
} catch {
  /* AbortError is expected */
}
const after = await alice('/api/health').then((r) => r.json());
check(after.status === 'ok', 'client abort mid-stream is handled (server log: "Answer cancelled by client")');

if (!KEEP) {
  console.log('\nCleanup');
  check((await alice(`/api/documents/${doc.id}`, { method: 'DELETE' })).status === 204, 'test document deleted');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
