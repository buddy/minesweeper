import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MAX_MODELS, createAgent, defaultEffort, REASONING_EFFORTS, NO_REASONING, PRICING, estimateCostUsd } from '../js/models.js';
import { Minesweeper } from '../js/game.js';
import { createToolset } from '../js/tools.js';

function board() {
  const game = new Minesweeper({ rows: 8, cols: 8, mines: 10, lives: 3, seed: 'models' });
  game.autoOpen();
  return game;
}

test('each model preset creates its agent from its own id', () => {
  assert.ok(Object.keys(MODELS).length > MAX_MODELS, 'the catalogue must offer more models than one run can hold');
  const ids = new Set();
  for (const [key, model] of Object.entries(MODELS)) {
    assert.equal(model.key, key, 'the catalogue key must match the entry');
    assert.ok(!ids.has(model.id), `duplicate model id ${model.id}`);
    ids.add(model.id);
    const agent = createAgent(key, defaultEffort(key));
    assert.equal(agent.config.model, model.id);
    assert.equal(agent.config.viaProxy, true);
    assert.equal(agent.config.apiKey, '');
  }
});

test('only models that accept an effort advertise one, and unknown levels are refused', () => {
  for (const [key, model] of Object.entries(MODELS)) {
    for (const level of model.efforts) {
      assert.ok([NO_REASONING, ...REASONING_EFFORTS].includes(level), `${key} offers unknown level ${level}`);
    }
    if (model.efforts.length === 0) {
      assert.equal(defaultEffort(key), undefined);
      assert.equal(createAgent(key).config.effort, undefined);
      assert.throws(() => createAgent(key, 'low'), /Unsupported reasoning effort/);
    } else {
      assert.equal(defaultEffort(key), 'low', `${key} must start on a level that reasons`);
      assert.throws(() => createAgent(key, 'unsupported'), /Unsupported reasoning effort/);
    }
  }
  assert.deepEqual(MODELS.haiku.efforts, [], 'Haiku 4.5 rejects output_config.effort');
  assert.deepEqual(MODELS.jev.efforts, [], 'Jev has no reasoning effort');
  assert.ok(!MODELS.fable.efforts.includes(NO_REASONING), 'Fable 5.1 rejects thinking.disabled at any effort');
  assert.ok(!MODELS.astra.efforts.includes(NO_REASONING), 'Astra rejects reasoning effort "none"');
  for (const key of ['grok46', 'grok45']) {
    assert.deepEqual(MODELS[key].efforts, ['low', 'medium', 'high', 'xhigh'], `${key} levels`);
  }
  assert.deepEqual(MODELS.grok43.efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
});

test('Grok talks Chat Completions: tool calls, tool replies and its own usage names', async t => {
  t.mock.method(console, 'log', () => {});
  const game = board();
  const index = game.mine.findIndex((mine, i) => !mine && !game.revealed[i]);
  const args = { row: game.rowOf(index), col: game.colOf(index) };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: decodeURIComponent(url), body });
    const info = requests.length === 1;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: 'Checking the frontier.',
          tool_calls: [{
            id: `call_${requests.length}`,
            type: 'function',
            function: { name: info ? 'get_board' : 'reveal', arguments: JSON.stringify(info ? {} : args) },
          }],
        },
      }],
      usage: { prompt_tokens: 40, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 12 } },
    }), { status: 200 });
  });
  const result = await createAgent('grok46').step(createToolset(game));
  assert.equal(result.error, null);
  assert.equal(result.apiCalls, 2);
  assert.equal(game.revealed[index], 1);
  assert.equal(requests[0].url, '/proxy/https://api.x.ai/v1/chat/completions');
  assert.equal(requests[0].body.model, MODELS.grok46.id);
  assert.equal(requests[0].body.messages[0].role, 'system');
  assert.ok(requests[0].body.tools.every(tool => tool.type === 'function' && tool.function.name));
  assert.equal(requests[0].body.reasoning_effort, undefined,
    'no level was chosen, so the parameter is left out and xAI\'s own default stands');
  assert.equal(requests[1].body.messages.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'call_1');
  assert.deepEqual(result.usage, { input: 80, cachedInput: 24, output: 14 });
  assert.equal(result.transcript[0].text, 'Checking the frontier.');
  t.mock.restoreAll();
});

test('Grok sends every level it advertises, "none" included, and refuses one it does not', async t => {
  const sentEfforts = [];
  for (const effort of MODELS.grok43.efforts) {
    t.mock.method(console, 'log', () => {});
    let request;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    });
    const reply = await createAgent('grok43', effort).createConversation('Test').send({});
    assert.equal(request.reasoning_effort, effort);
    sentEfforts.push(request.reasoning_effort);
    assert.equal(reply.text, 'ok');
    assert.deepEqual(reply.calls, []);
    t.mock.restoreAll();
  }
  assert.equal(sentEfforts[0], NO_REASONING);
  for (const key of ['grok46', 'grok45', 'grok43']) {
    assert.throws(() => createAgent(key, 'max'), /Unsupported reasoning effort/, `${key} must refuse max`);
  }
  for (const key of ['grok46', 'grok45']) {
    assert.throws(() => createAgent(key, NO_REASONING), /Unsupported reasoning effort/, `${key} must refuse none`);
  }
});

test('Fable uses Messages and Astra preserves reasoning and tool results across Responses rounds', async t => {
  for (const key of ['fable', 'astra']) {
    t.mock.method(console, 'log', () => {});
    const game = board();
    const index = game.mine.findIndex((mine, i) => !mine && !game.revealed[i]);
    const args = { row: game.rowOf(index), col: game.colOf(index) };
    const requests = [];
    const reasoning = { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'encrypted-test' };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: decodeURIComponent(url), body });
      const info = requests.length === 1;
      const name = info ? 'get_board' : 'reveal';
      const input = info ? {} : args;
      return new Response(JSON.stringify(key === 'fable' ? {
        content: [{ type: 'tool_use', id: `tool_${requests.length}`, name, input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      } : {
        status: 'completed',
        output: [reasoning, { type: 'function_call', call_id: `call_${requests.length}`, name, arguments: JSON.stringify(input) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200 });
    });
    const result = await createAgent(key).step(createToolset(game));
    assert.equal(result.error, null);
    assert.equal(result.apiCalls, 2);
    assert.equal(game.revealed[index], 1);
    assert.equal(requests[0].body.model, MODELS[key].id);
    if (key === 'astra') {
      assert.equal(requests[0].url, '/proxy/https://api.openai.com/v1/responses');
      assert.equal(requests[0].body.store, false);
      assert.ok(requests[0].body.tools.every(tool => tool.type === 'function' && tool.name));
      assert.deepEqual(requests[1].body.input[1], reasoning);
      assert.equal(requests[1].body.input[3].type, 'function_call_output');
      assert.equal(requests[1].body.input[3].call_id, 'call_1');
    } else {
      assert.equal(requests[0].url, '/proxy/https://api.anthropic.com/v1/messages');
      assert.equal(requests[1].body.messages[2].content[0].type, 'tool_result');
    }
    t.mock.restoreAll();
  }
});


test('selected reasoning effort reaches both APIs', async t => {
  for (const key of ['fable', 'astra']) {
    for (const effort of REASONING_EFFORTS) {
      t.mock.method(console, 'log', () => {});
      let request;
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ content: [], output: [] }), { status: 200 });
      });
      const agent = createAgent(key, effort);
      await agent.createConversation('Test').send({});
      assert.equal(key === 'fable' ? request.output_config.effort : request.reasoning.effort, effort);
      if (key === 'fable' && ['high', 'xhigh', 'max'].includes(effort)) assert.equal(request.max_tokens, 65536);
      t.mock.restoreAll();
    }
  }
  assert.equal(createAgent('jev').config.effort, undefined);
  assert.throws(() => createAgent('astra', 'unsupported'), /Unsupported reasoning/);
});

test('Fable and Astra never substitute moves for missing, rejected or cancelled actions', async t => {
  for (const key of ['fable', 'astra']) {
    for (const scenario of ['missing', 'rejected', 'cancelled']) {
      const game = board();
      const before = [...game.revealed];
      const movesBefore = game.moves;
      const tools = createToolset(game);
      const execute = t.mock.method(tools, 'execute');
      const controller = new AbortController();
      const args = { row: -1, col: -1 };
      t.mock.method(console, 'log', () => {});
      t.mock.method(globalThis, 'fetch', async () => {
        if (scenario === 'cancelled') controller.abort();
        return new Response(JSON.stringify(key === 'fable' ? {
          content: scenario === 'missing' ? [] : [{ type: 'tool_use', id: 'action', name: 'reveal', input: args }],
        } : {
          status: 'completed',
          output: scenario === 'missing' ? [] : [{ type: 'function_call', call_id: 'action', name: 'reveal', arguments: JSON.stringify(args) }],
        }), { status: 200 });
      });
      const task = createAgent(key).step(tools, { signal: controller.signal });
      if (scenario === 'cancelled') await assert.rejects(task, { name: 'AbortError' });
      else assert.match((await task).error, /without a successful move/);
      assert.equal(execute.mock.callCount(), scenario === 'rejected' ? 1 : 0);
      if (scenario === 'rejected') assert.deepEqual(execute.mock.calls[0].arguments, ['reveal', args]);
      assert.deepEqual([...game.revealed], before);
      assert.equal(game.moves, movesBefore);
      t.mock.restoreAll();
    }
  }
});

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ~${expected}`);
const MILLION = 1_000_000;

test('every model has a complete rate table and no cache discount priced as a surcharge', () => {
  assert.deepEqual(Object.keys(PRICING).sort(), Object.keys(MODELS).sort());
  for (const [key, price] of Object.entries(PRICING)) {
    for (const rate of ['input', 'cachedInput', 'output']) {
      assert.ok(Number.isFinite(price[rate]) && price[rate] >= 0, `${key}.${rate} must be a non-negative rate`);
    }
    assert.ok(price.cachedInput <= price.input, `${key}: cached input priced above fresh input`);
  }
});

test('a million tokens bills exactly its listed rate, and cached tokens bill once', () => {
  for (const [key, price] of Object.entries(PRICING)) {
    near(estimateCostUsd(key, { input: MILLION, cachedInput: 0, output: 0 }), price.input);
    near(estimateCostUsd(key, { input: 0, cachedInput: 0, output: MILLION }), price.output);
    near(estimateCostUsd(key, { input: MILLION, cachedInput: MILLION, output: 0 }), price.cachedInput);

    const fresh = estimateCostUsd(key, { input: MILLION, cachedInput: 0, output: 0 });
    const cached = estimateCostUsd(key, { input: MILLION, cachedInput: MILLION, output: 0 });
    const half = estimateCostUsd(key, { input: MILLION, cachedInput: MILLION / 2, output: 0 });
    assert.ok(half <= fresh && half >= cached, `${key}: partly cached input must land between the two rates`);
    if (price.cachedInput < price.input) assert.ok(cached < fresh, `${key}: caching must reduce the bill`);
    if (price.output === 0) assert.equal(estimateCostUsd(key, { input: 0, cachedInput: 0, output: MILLION }), 0);
  }
});

test('malformed usage shows $0 rather than NaN or a negative charge', () => {
  const key = Object.keys(PRICING)[0];
  assert.equal(estimateCostUsd(key, { input: 100, cachedInput: 999_999, output: 0 }),
    estimateCostUsd(key, { input: 100, cachedInput: 100, output: 0 }));
  for (const usage of [undefined, null, {}, { input: -5, output: NaN }, { input: 'x' }]) {
    assert.equal(estimateCostUsd(key, usage), 0, `usage ${JSON.stringify(usage)}`);
  }
  assert.equal(estimateCostUsd('unknown-model', { input: MILLION }), 0);
});

test('reasoning is asked for and read back, and never asked of a model without it', async t => {
  const cases = {
    fable: {
      reply: { content: [{ type: 'thinking', thinking: 'r1c1 is forced.' }, { type: 'text', text: 'Flagging it.' }] },
      opt: request => request.thinking,
      expected: { type: 'adaptive', display: 'summarized' },
    },
    astra: {
      reply: { output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'r1c1 is forced.' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Flagging it.' }] }] },
      opt: request => request.reasoning.summary,
      expected: 'auto',
    },
  };
  for (const [key, { reply, opt, expected }] of Object.entries(cases)) {
    t.mock.method(console, 'log', () => {});
    let request;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify(reply), { status: 200 });
    });
    const result = await createAgent(key, 'low').createConversation('Test').send({});
    assert.deepEqual(opt(request), expected, `${key} must opt in, or the summary comes back empty`);
    assert.equal(result.reasoning, 'r1c1 is forced.', `${key} reasoning is read back`);
    assert.equal(result.text, 'Flagging it.', `${key} keeps reasoning and answer apart`);
    t.mock.restoreAll();
  }

  t.mock.method(console, 'log', () => {});
  let haikuRequest;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    haikuRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({ content: [] }), { status: 200 });
  });
  await createAgent('haiku').createConversation('Test').send({});
  assert.equal(haikuRequest.thinking, undefined, 'Haiku takes no effort and no thinking; asking would be a 400');
});

test('a model can be run with no reasoning at all, each provider its own way', async t => {
  const replies = { opus: { content: [] }, luna: { output: [] } };
  const sent = {};
  for (const key of ['opus', 'luna']) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      sent[key] = JSON.parse(options.body);
      return new Response(JSON.stringify(replies[key]), { status: 200 });
    });
    await createAgent(key, NO_REASONING).createConversation('Test').send({});
    t.mock.restoreAll();
  }

  assert.deepEqual(sent.opus.thinking, { type: 'disabled' });
  assert.equal(sent.opus.output_config, undefined,
    'disabling thinking is a 400 above effort high, so no effort is sent and the default high stands');
  assert.deepEqual(sent.luna.reasoning, { effort: NO_REASONING });
  assert.equal('summary' in sent.luna.reasoning, false, 'nothing reasons, so there is nothing to summarise');
});
