// The optional access code (ACCESS_CODE). Like http.test.js, every request
// here is decided before MongoDB or OpenAI are touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-characters',
  MONGODB_URI: 'mongodb://127.0.0.1:1/never-connected',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  ACCESS_CODE: 'open-sesame-42',
});
const { createApp } = await import('../src/app.js');

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const tryCode = (code) =>
  fetch(`${base}/api/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
const accessCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith('documind_access='));

test('without the code, document and question routes are locked (401)', async () => {
  assert.equal((await fetch(`${base}/api/documents`)).status, 401);
  assert.equal((await fetch(`${base}/api/documents/aaaaaaaaaaaaaaaaaaaaaaaa`)).status, 401);
  const ask = await fetch(`${base}/api/documents/aaaaaaaaaaaaaaaaaaaaaaaa/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'hi' }),
  });
  assert.equal(ask.status, 401);
  assert.match((await ask.json()).error, /access code/i);
});

test('health stays public (the host needs it for health checks)', async () => {
  // 503 because there is no database in this test, but crucially not 401.
  assert.notEqual((await fetch(`${base}/api/health`)).status, 401);
});

test('a wrong code is rejected and sets no cookie', async () => {
  const res = await tryCode('wrong');
  assert.equal(res.status, 401);
  assert.equal(accessCookie(res), undefined);
});

test('the right code sets an HttpOnly cookie that unlocks the routes', async () => {
  const res = await tryCode('open-sesame-42');
  assert.equal(res.status, 200);
  const cookie = accessCookie(res);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(!cookie.includes('open-sesame-42'), 'the cookie must not contain the code itself');

  // Past the gate: an invalid id now fails at validation (404), not at the gate (401).
  const res2 = await fetch(`${base}/api/documents/not-an-id`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(res2.status, 404);
});

test('a forged access cookie does not unlock anything', async () => {
  const res = await fetch(`${base}/api/documents/not-an-id`, { headers: { cookie: 'documind_access=1' } });
  assert.equal(res.status, 401);
});

test('guessing is rate limited', async () => {
  let res;
  for (let i = 0; i < 12; i++) {
    res = await tryCode(`guess-${i}`);
    if (res.status === 429) break;
  }
  assert.equal(res.status, 429);
});
