import { MUTATING_TOOLS, toAnthropicTools, toOpenAITools } from '../tools.js';
import { joinUrl, postJson } from '../http.js';

export const NO_REASONING = 'none';

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const XAI_DEFAULT_BASE = 'https://api.x.ai/v1';

function systemPrompt(game) {
  return [
    `You are playing Minesweeper through tools. The board has ${game.rows} rows and ${game.cols} columns with ${game.minesTotal} mines.`,
    'Goal: reveal every safe cell without revealing mines.',
    'Rules: a revealed number N means exactly N mines among its up to 8 neighbours (including diagonals). "#" is unknown, "F" is flagged, "." is a revealed empty cell.',
    'Each turn you must act by calling reveal, flag, unflag or chord. Your turn ends as soon as you call any of those. You may include several of these calls in one response, for example flag two certain mines and reveal one certain safe cell.',
    'Flagging a proven mine subtracts it from every number touching it, which is what makes neighbouring numbers provably safe.',
    'Reveal only cells you can prove safe. If nothing can be proven, reveal the candidate with the lowest mine probability. Never reveal a flagged or already revealed cell.',
    'You may call get_frontier, get_neighborhood or get_board for more information, but be quick: answer with tool calls only, no prose.',
  ].join('\n');
}

function initialUserMessage(toolset, prefetchFrontier, frontierLimit) {
  const parts = [`Current board:\n${toolset.boardText()}`];
  if (prefetchFrontier) {
    parts.push(`Frontier analysis (get_frontier):\n${JSON.stringify(toolset.frontier(frontierLimit))}`);
  }
  parts.push('Make your move now.');
  return parts.join('\n\n');
}

export class LlmAgent {
  constructor(config) {
    this.config = {
      provider: 'anthropic',
      apiKey: '',
      model: 'claude-fable-5-1',
      baseUrl: '',
      viaProxy: false,
      maxToolRounds: 6,
      maxTokens: 4096,
      effort: 'low',
      prefetchFrontier: true,
      frontierLimit: 80,
      ...config,
    };
    this.name = `${this.config.provider}:${this.config.model}`;
  }

  async step(toolset, { signal } = {}) {
    const game = toolset.game;
    const started = performance.now();
    const transcript = [];
    const actions = [];
    const usage = { input: 0, cachedInput: 0, output: 0 };
    let apiCalls = 0;
    let toolCalls = 0;

    const conversation = this.createConversation(systemPrompt(game));
    conversation.addUser(initialUserMessage(toolset, this.config.prefetchFrontier, this.config.frontierLimit));

    for (let round = 0; round < this.config.maxToolRounds; round++) {
      apiCalls++;
      const reply = await conversation.send({ signal });
      usage.input += reply.usage.input;
      usage.cachedInput += reply.usage.cachedInput;
      usage.output += reply.usage.output;
      if (reply.reasoning) transcript.push({ role: 'reasoning', text: reply.reasoning });
      if (reply.text) transcript.push({ role: 'assistant', text: reply.text });

      if (reply.calls.length === 0) {
        conversation.addUser('You did not call any tool. You must act now: call reveal, flag, unflag or chord.');
        continue;
      }

      const results = [];
      let acted = false;
      for (const call of reply.calls) {
        signal?.throwIfAborted();
        toolCalls++;
        const { result, mutating } = toolset.execute(call.name, call.args);
        results.push({ id: call.id, name: call.name, result });
        transcript.push({ role: 'tool', name: call.name, args: call.args, result });
        if (mutating) {
          acted = true;
          actions.push({ tool: call.name, args: call.args, result });
        }
        if (game.isFinished) break;
      }
      if (acted || game.isFinished) break;
      conversation.addToolResults(reply.raw, results);
    }

    return {
      actions,
      latencyMs: performance.now() - started,
      apiCalls,
      toolCalls,
      usage,
      transcript,
      error: actions.some(action => action.result.ok) ? null : 'Agent finished its turn without a successful move',
    };
  }

  createConversation(system) {
    if (this.config.provider === 'anthropic') return new AnthropicConversation(this.config, system);
    if (this.config.provider === 'xai') return new GrokConversation(this.config, system);
    return new OpenAIConversation(this.config, system);
  }
}

class AnthropicConversation {
  constructor(config, system) {
    this.config = config;
    this.system = system;
    this.messages = [];
    this.tools = toAnthropicTools();
  }

  addUser(text) {
    this.messages.push({ role: 'user', content: text });
  }

  addToolResults(assistantContent, results) {
    this.messages.push({ role: 'assistant', content: assistantContent });
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result), is_error: r.result?.ok === false })),
    });
  }

  async send({ signal }) {
    const base = this.config.baseUrl || ANTHROPIC_DEFAULT_BASE;
    const headers = {
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (!this.config.viaProxy) headers['anthropic-dangerous-direct-browser-access'] = 'true';

    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: this.system,
      tools: this.tools,
      messages: this.messages,
    };
    if (this.config.effort === NO_REASONING) {
      body.thinking = { type: 'disabled' };
    } else if (this.config.effort) {
      body.output_config = { effort: this.config.effort };
      body.thinking = { type: 'adaptive', display: 'summarized' };
    }
    const response = await postJson(joinUrl(base, '/v1/messages'), { headers, body, viaProxy: this.config.viaProxy, signal });
    if (response.stop_reason === 'refusal') {
      throw new Error(`Model refused: ${response.stop_details?.explanation ?? 'no explanation'}`);
    }
    const content = Array.isArray(response.content) ? response.content : [];
    return {
      raw: content,
      reasoning: content.filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking).join('\n'),
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      usage: {
        input: (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0)
          + (response.usage?.cache_creation_input_tokens ?? 0),
        cachedInput: response.usage?.cache_read_input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    };
  }
}

class OpenAIConversation {
  constructor(config, system) {
    this.config = config;
    this.system = system;
    this.input = [];
    this.tools = toOpenAITools().map(tool => ({ type: 'function', ...tool.function, strict: false }));
  }

  addUser(text) {
    this.input.push({ role: 'user', content: text });
  }

  addToolResults(_assistantOutput, results) {
    for (const result of results) {
      this.input.push({ type: 'function_call_output', call_id: result.id, output: JSON.stringify(result.result) });
    }
  }

  async send({ signal }) {
    const base = this.config.baseUrl || OPENAI_DEFAULT_BASE;
    const body = {
      model: this.config.model,
      instructions: this.system,
      input: this.input,
      tools: this.tools,
      tool_choice: 'auto',
      store: false,
      reasoning: this.config.effort === NO_REASONING
        ? { effort: NO_REASONING }
        : { effort: this.config.effort || 'low', summary: 'auto' },
    };
    const response = await postJson(joinUrl(base, '/responses'), {
      headers: { authorization: `Bearer ${this.config.apiKey}` },
      body,
      viaProxy: this.config.viaProxy,
      signal,
    });
    if (response.error) throw new Error(response.error.message || 'Model response failed');
    if (response.status === 'incomplete') throw new Error(`Model response incomplete: ${response.incomplete_details?.reason ?? 'unknown reason'}`);
    const output = response.output ?? [];
    this.input.push(...output);
    return {
      raw: output,
      reasoning: output.filter(item => item.type === 'reasoning').flatMap(item => item.summary ?? [])
        .filter(part => part.type === 'summary_text').map(part => part.text).join('\n'),
      text: output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
        .filter(item => item.type === 'output_text').map(item => item.text).join('\n'),
      calls: output.filter(item => item.type === 'function_call')
        .map(item => ({ id: item.call_id, name: item.name, args: parseArgs(item.arguments) })),
      usage: {
        input: response.usage?.input_tokens ?? 0,
        cachedInput: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    };
  }
}

class GrokConversation {
  constructor(config, system) {
    this.config = config;
    this.messages = [{ role: 'system', content: system }];
    this.tools = toOpenAITools();
  }

  addUser(text) {
    this.messages.push({ role: 'user', content: text });
  }

  addToolResults(assistantMessage, results) {
    this.messages.push(assistantMessage);
    for (const result of results) {
      this.messages.push({ role: 'tool', tool_call_id: result.id, content: JSON.stringify(result.result) });
    }
  }

  async send({ signal }) {
    const base = this.config.baseUrl || XAI_DEFAULT_BASE;
    const body = {
      model: this.config.model,
      messages: this.messages,
      tools: this.tools,
      tool_choice: 'auto',
      max_tokens: this.config.maxTokens,
    };
    if (this.config.effort) body.reasoning_effort = this.config.effort;
    const response = await postJson(joinUrl(base, '/chat/completions'), {
      headers: { authorization: `Bearer ${this.config.apiKey}` },
      body,
      viaProxy: this.config.viaProxy,
      signal,
    });
    if (response.error) throw new Error(response.error.message || 'Model response failed');
    const choice = response.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new Error('Model refused: response was filtered');
    const message = choice?.message ?? {};
    return {
      raw: message,
      reasoning: message.reasoning_content ?? '',
      text: message.content ?? '',
      calls: (message.tool_calls ?? []).filter(call => call.function?.name)
        .map(call => ({ id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) })),
      usage: {
        input: response.usage?.prompt_tokens ?? 0,
        cachedInput: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export { MUTATING_TOOLS };
