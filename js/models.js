import { JevAgent } from './agents/jev-agent.js';
import { LlmAgent, NO_REASONING } from './agents/llm-agent.js';

export const MAX_MODELS = 9;

export const JEV_CELLS_PER_REQUEST = 96;
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export { NO_REASONING };
const OR_NONE = Object.freeze([NO_REASONING, ...REASONING_EFFORTS]);
const XAI_EFFORTS = Object.freeze(REASONING_EFFORTS.filter(effort => effort !== 'max'));
const XAI_EFFORTS_OR_NONE = Object.freeze([NO_REASONING, ...XAI_EFFORTS]);
const ANTHROPIC = { provider: 'anthropic', company: 'Anthropic', logo: 'assets/anthropic.svg' };
const OPENAI = { provider: 'openai', company: 'OpenAI', logo: 'assets/openai.svg' };
const XAI = { provider: 'xai', company: 'xAI', logo: 'assets/grok-mark.svg' };

export const MODELS = Object.freeze({
  jev: Object.freeze({ key: 'jev', name: 'Jev', id: 'jev-latest', company: 'TypeSafe AI', logo: 'assets/typesafe.svg', efforts: [] }),
  haiku: Object.freeze({ key: 'haiku', name: 'Haiku 4.5', id: 'claude-haiku-4-5', ...ANTHROPIC, efforts: [] }),
  sonnet: Object.freeze({ key: 'sonnet', name: 'Sonnet 5', id: 'claude-sonnet-5', ...ANTHROPIC, efforts: OR_NONE }),
  opus: Object.freeze({ key: 'opus', name: 'Opus 5', id: 'claude-opus-5', ...ANTHROPIC, efforts: OR_NONE }),
  fable: Object.freeze({ key: 'fable', name: 'Fable 5.1', id: 'claude-fable-5-1', ...ANTHROPIC, efforts: REASONING_EFFORTS }),
  luna: Object.freeze({ key: 'luna', name: 'Luna', id: 'gpt-5.6-luna', ...OPENAI, efforts: OR_NONE }),
  terra: Object.freeze({ key: 'terra', name: 'Terra', id: 'gpt-5.6-terra', ...OPENAI, efforts: OR_NONE }),
  sol: Object.freeze({ key: 'sol', name: 'Sol', id: 'gpt-5.6-sol', ...OPENAI, efforts: OR_NONE }),
  astra: Object.freeze({ key: 'astra', name: 'Astra', id: 'gpt-6-astra', ...OPENAI, efforts: REASONING_EFFORTS }),
  grok46: Object.freeze({ key: 'grok46', name: 'Grok 4.6', id: 'grok-4.6', ...XAI, efforts: XAI_EFFORTS }),
  grok45: Object.freeze({ key: 'grok45', name: 'Grok 4.5', id: 'grok-4.5', ...XAI, efforts: XAI_EFFORTS }),
  grok43: Object.freeze({ key: 'grok43', name: 'Grok 4.3', id: 'grok-4.3', ...XAI, efforts: XAI_EFFORTS_OR_NONE }),
});

export const PRICING = Object.freeze({
  jev: Object.freeze({ input: 0.042, cachedInput: 0.042, output: 0 }),
  haiku: Object.freeze({ input: 1, cachedInput: 0.1, output: 5 }),
  sonnet: Object.freeze({ input: 2, cachedInput: 0.2, output: 10 }),
  opus: Object.freeze({ input: 5, cachedInput: 0.5, output: 25 }),
  fable: Object.freeze({ input: 10, cachedInput: 0.25, output: 50 }),
  luna: Object.freeze({ input: 0.2, cachedInput: 0.02, output: 1.2 }),
  terra: Object.freeze({ input: 2, cachedInput: 0.2, output: 12 }),
  sol: Object.freeze({ input: 4, cachedInput: 0.4, output: 20 }),
  astra: Object.freeze({ input: 10, cachedInput: 1, output: 50 }),
  grok46: Object.freeze({ input: 2, cachedInput: 0.5, output: 6 }),
  grok45: Object.freeze({ input: 2, cachedInput: 0.3, output: 6 }),
  grok43: Object.freeze({ input: 1.25, cachedInput: 0.2, output: 2.5 }),
});

export function estimateCostUsd(modelKey, usage) {
  const price = PRICING[modelKey];
  if (!price || !usage) return 0;
  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  const cached = Math.min(Math.max(0, Number(usage.cachedInput) || 0), input);
  return ((input - cached) * price.input + cached * price.cachedInput + output * price.output) / 1e6;
}

export function defaultEffort(key) {
  return MODELS[key]?.efforts.find(effort => effort !== NO_REASONING);
}

export function createAgent(key, effort) {
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown model: ${key}`);
  if (effort !== undefined && !model.efforts.includes(effort)) {
    throw new Error(`Unsupported reasoning effort for ${model.name}: ${effort}`);
  }
  const config = { model: model.id, viaProxy: true };
  if (!model.provider) return new JevAgent({ ...config, maxCandidates: JEV_CELLS_PER_REQUEST });
  return new LlmAgent({
    ...config,
    provider: model.provider,
    effort,
    maxTokens: ['high', 'xhigh', 'max'].includes(effort) ? 65536 : 4096,
  });
}
