import test from 'node:test';
import assert from 'node:assert/strict';
import { postJson } from '../js/http.js';

function captureLogs(t) {
  const logs = [];
  logs.headlines = [];
  t.mock.method(console, 'groupCollapsed', line => logs.headlines.push(line));
  t.mock.method(console, 'groupEnd', () => {});
  t.mock.method(console, 'log', entry => logs.push(entry));
  return logs;
}

test('browser console pairs request and response bodies without credentials', async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    result: 'move', echoed: 'test-header-secret', nested: { api_key: 'test-response-secret' },
  }), { status: 200 }));
  const result = await postJson('https://api.anthropic.com/v1/messages?api_key=test-query-secret', {
    headers: { 'x-api-key': 'test-header-secret' },
    body: { model: 'fable-test', input: 'Make a move', password: 'test-body-secret' },
    viaProxy: true,
  });
  assert.equal(result.result, 'move');
  assert.equal(result.echoed, 'test-header-secret', 'Redaction must not modify the response returned to the agent');
  assert.deepEqual(logs.map(log => log.event), ['model.request', 'model.response']);
  assert.equal(logs[0].requestId, logs[1].requestId);
  assert.equal(logs[0].provider, 'Anthropic');
  assert.equal(logs[0].body.input, 'Make a move');
  assert.equal(logs[1].status, 200);
  assert.ok(logs[1].durationMs >= 0);
  for (const secret of ['test-header-secret', 'test-response-secret', 'test-body-secret', 'test-query-secret']) {
    assert.equal(JSON.stringify([...logs, ...logs.headlines]).includes(secret), false);
  }
});

test('each console event collapses to one scannable line with its body nested inside', async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}', { status: 200 }));
  await postJson('https://api.typesafe.ai/v1/systemone', { body: { model: 'jev-latest', state: {} } });
  assert.equal(logs.headlines.length, logs.length, 'one headline per logged body, never a bare object');
  assert.match(logs.headlines[0], /^#\d+ · TypeSafe · jev-latest · \d+(\.\d)? (B|kB)$/);
  assert.match(logs.headlines[1], /^#\d+ · TypeSafe · 200 · \d+ ms$/);

  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
  await assert.rejects(postJson('https://api.openai.com/v1/responses', { body: { model: 'astra' } }));
  assert.match(logs.headlines.at(-1), /^#\d+ · OpenAI · error · Network unavailable · \d+ ms$/);
});

test('browser console logs every retry with its response status and attempt', async t => {
  const logs = captureLogs(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? new Response('Rate limited', { status: 429 })
    : new Response('{"ok":true}', { status: 200 }));
  await postJson('https://api.typesafe.ai/v1/systemone', { body: { model: 'jev-latest' }, retries: 1 });
  assert.deepEqual(logs.map(log => log.attempt), [1, 1, 2, 2]);
  assert.equal(new Set(logs.map(log => log.requestId)).size, 1);
  assert.deepEqual(logs.filter(log => log.event === 'model.response').map(log => log.status), [429, 200]);
});

test('browser console reports HTTP errors, network failures, and cancellation', async t => {
  const logs = captureLogs(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"message":"Invalid key"}}', { status: 401 }));
  const url = 'https://api.openai.com/v1/responses';
  await assert.rejects(postJson(url, { body: { model: 'astra' } }), /HTTP 401/);
  assert.equal(logs.at(-1).status, 401);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
  await assert.rejects(postJson(url), /Network unavailable/);
  assert.equal(logs.at(-1).event, 'model.error');
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Stopped', 'AbortError'); });
  await assert.rejects(postJson(url), { name: 'AbortError' });
  assert.equal(logs.at(-1).event, 'model.cancelled');
});
