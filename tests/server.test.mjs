import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function startFixture(t, { config, env = {}, onOutput = () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minesweeper-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(new URL('../server.mjs', import.meta.url), path.join(root, 'server.mjs'));
  if (config !== undefined) await fs.writeFile(path.join(root, '.env'), config);
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Test studio</h1>');
  await fs.mkdir(path.join(root, 'js'));
  await fs.writeFile(path.join(root, 'js/app.js'), 'export const ready = true;');
  await fs.symlink(path.join(root, '.env'), path.join(root, 'js/private.js'));
  await fs.writeFile(path.join(root, 'start.mjs'), `
    globalThis.fetch = async (_url, options) => {
      const model = JSON.parse(options.body).model;
      if (model === 'network-error') throw new Error('Connection interrupted');
      if (model === 'http-error') return new Response('Provider unavailable', { status: 503 });
      return new Response(JSON.stringify({
      credential: options.headers.authorization || options.headers['x-api-key'],
      model: JSON.parse(options.body).model,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await import('./server.mjs');
  `);
  const child = spawn(process.execPath, [path.join(root, 'start.mjs')], {
    cwd: os.tmpdir(), env: { PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
    let output = '';
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.stdout.on('data', data => {
      output += data;
      onOutput(String(data));
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}: ${errors}`)); });
  });
  return url;
}

function proxy(url, host) {
  return fetch(`${url}/proxy/${encodeURIComponent(`https://${host}/v1/test`)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture' }),
  });
}

test('loads provider keys from the project .env, with environment overrides', async t => {
  const url = await startFixture(t, {
    config: '# Test keys only\nTYPESAFE_API_KEY="test-jev"\nANTHROPIC_API_KEY=\'test-fable\'\nOPENAI_API_KEY=test-file-astra\nXAI_API_KEY=test-grok\n',
    env: { OPENAI_API_KEY: 'test-env-astra' },
  });
  for (const [host, expected] of [
    ['api.typesafe.ai', 'Bearer test-jev'],
    ['api.anthropic.com', 'test-fable'],
    ['api.openai.com', 'Bearer test-env-astra'],
    ['api.x.ai', 'Bearer test-grok'],
  ]) {
    const response = await proxy(url, host);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { credential: expected, model: 'fixture' });
  }
});

test('serves public assets but blocks config, server source, encoded paths, and private symlinks', async t => {
  const url = await startFixture(t, { config: 'OPENAI_API_KEY=test-private-key\n' });
  for (const route of ['/', '/js/app.js']) assert.equal((await fetch(url + route)).status, 200);
  for (const route of ['/.env', '/%2eenv', '/.env.example', '/server.mjs', '/js/../.env', '/js/%2e%2e%2f.env', '/js/private.js']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 403, route);
    assert.equal((await response.text()).includes('test-private-key'), false, route);
  }
  assert.equal((await fetch(url + '/%ZZ')).status, 400);
});

test('starts without .env and explains missing keys without making an upstream call', async t => {
  const url = await startFixture(t);
  for (const [host, variable] of [['api.openai.com', 'OPENAI_API_KEY'], ['api.x.ai', 'XAI_API_KEY']]) {
    const response = await proxy(url, host);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, new RegExp(`Add ${variable} to .env and restart`));
  }
});


test('console logs correlate requests and responses while redacting credentials', async t => {
  let output = '';
  const url = await startFixture(t, {
    config: 'ANTHROPIC_API_KEY=test-secret-fable\n',
    onOutput: chunk => { output += chunk; },
  });
  const response = await fetch(`${url}/proxy/${encodeURIComponent('https://api.anthropic.com/v1/messages?api_key=test-url-secret')}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-header-secret' },
    body: JSON.stringify({ model: 'fable-test', messages: [{ text: 'test-secret-fable test-header-secret', api_key: 'test-body-secret' }] }),
  });
  assert.equal(response.status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  const logs = output.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, 'model.request');
  assert.equal(logs[1].event, 'model.response');
  assert.equal(logs[0].requestId, logs[1].requestId);
  assert.equal(logs[0].provider, 'Anthropic');
  assert.equal(logs[0].model, 'fable-test');
  assert.equal(logs[1].status, 200);
  assert.ok(logs[1].durationMs >= 0);
  assert.equal(logs[1].body.model, 'fable-test');
  for (const secret of ['test-secret-fable', 'test-header-secret', 'test-body-secret', 'test-url-secret']) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /REDACTED/);
});

test('console logs include provider HTTP errors and network failures', async t => {
  let output = '';
  const url = await startFixture(t, {
    config: 'OPENAI_API_KEY=test-key\n', onOutput: chunk => { output += chunk; },
  });
  for (const model of ['http-error', 'network-error']) {
    await fetch(`${url}/proxy/${encodeURIComponent('https://api.openai.com/v1/responses')}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
    });
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  const logs = output.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  const responses = logs.filter(log => log.event === 'model.response');
  assert.deepEqual(responses.map(log => log.status), [503, 502]);
  assert.equal(responses[0].body, 'Provider unavailable');
  assert.match(responses[1].body.error.message, /Connection interrupted/);
  assert.notEqual(responses[0].requestId, responses[1].requestId);
});
