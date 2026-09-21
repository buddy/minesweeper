import { sleep } from './http.js';

export function maxDecisions(rows, cols) {
  return Math.max(120, Math.ceil(rows * cols / 2));
}

export class PauseGate {
  constructor() {
    this.paused = false;
    this.waiting = [];
  }

  toggle() {
    if (this.paused) {
      this.paused = false;
      for (const resume of this.waiting.splice(0)) resume();
    } else {
      this.paused = true;
    }
    return this.paused;
  }

  wait(signal) {
    if (!this.paused) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      this.waiting.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export class AgentRunner {
  constructor({ agent, toolset, delayMs = 250, maxSteps = 400, maxConsecutiveErrors = 3, pause, onStep, onLog }) {
    this.agent = agent;
    this.toolset = toolset;
    this.delayMs = delayMs;
    this.maxSteps = maxSteps;
    this.maxConsecutiveErrors = maxConsecutiveErrors;
    this.pause = pause ?? new PauseGate();
    this.onStep = onStep ?? (() => {});
    this.onLog = onLog ?? (() => {});
    this.running = false;
    this.resetStats();
  }

  resetStats() {
    this.stats = {
      steps: 0,
      apiCalls: 0,
      toolCalls: 0,
      moves: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      minLatencyMs: Infinity,
      maxLatencyMs: 0,
      usage: { input: 0, cachedInput: 0, output: 0 },
      minesHit: 0,
      errors: 0,
      consecutiveErrors: 0,
      activeMs: 0,
      lastError: null,
    };
  }

  get game() {
    return this.toolset.game;
  }

  get avgLatencyMs() {
    return this.stats.steps ? this.stats.totalLatencyMs / this.stats.steps : 0;
  }

  get isDone() {
    return this.game.isFinished || this.stats.steps >= this.maxSteps || this.stats.consecutiveErrors >= this.maxConsecutiveErrors;
  }

  get stopReason() {
    if (this.game.isFinished) return this.game.status;
    if (this.stats.consecutiveErrors >= this.maxConsecutiveErrors) return 'error';
    if (this.stats.steps >= this.maxSteps) return 'step limit';
    return null;
  }

  async stepOnce(signal) {
    const explodedBefore = this.game.explodedCount;
    let result;
    try {
      result = await this.agent.step(this.toolset, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      this.stats.errors++;
      this.stats.consecutiveErrors++;
      this.stats.lastError = error.message;
      this.onLog({ level: 'error', text: error.message });
      this.onStep();
      return null;
    }

    const s = this.stats;
    s.steps++;
    s.apiCalls += result.apiCalls;
    s.toolCalls += result.toolCalls;
    s.moves += result.actions.length;
    s.totalLatencyMs += result.latencyMs;
    s.lastLatencyMs = result.latencyMs;
    s.minLatencyMs = Math.min(s.minLatencyMs, result.latencyMs);
    s.maxLatencyMs = Math.max(s.maxLatencyMs, result.latencyMs);
    s.usage.input += result.usage.input;
    s.usage.cachedInput += result.usage.cachedInput ?? 0;
    s.usage.output += result.usage.output;
    s.minesHit += this.game.explodedCount - explodedBefore;

    for (const entry of result.transcript ?? []) {
      if ((entry.role === 'reasoning' || entry.role === 'assistant') && entry.text?.trim()) {
        this.onLog({ level: entry.role === 'reasoning' ? 'reasoning' : 'model', text: entry.text.trim() });
      }
    }

    if (result.error) {
      s.errors++;
      s.consecutiveErrors++;
      s.lastError = result.error;
      this.onLog({ level: 'warn', text: `${result.error} (${Math.round(result.latencyMs)} ms)` });
    } else {
      s.consecutiveErrors = 0;
      for (const action of result.actions) {
        const target = `r${action.args.row}c${action.args.col}`;
        const outcome = action.result.ok ? action.result.message : `rejected: ${action.result.message}`;
        const reason = action.reason ? ` [${action.reason}]` : '';
        const level = action.result.kind === 'mine' ? 'mine' : action.result.ok ? 'info' : 'warn';
        this.onLog({ level, text: `#${s.steps} ${action.tool} ${target} → ${outcome}${reason}` });
      }
      this.onLog({ level: 'meta', text: `#${s.steps} ${Math.round(result.latencyMs)} ms, ${result.apiCalls} API call(s), ${result.toolCalls} tool call(s)` });
    }
    this.onStep(result);
    return result;
  }

  async run(signal) {
    if (this.running) return;
    this.running = true;
    const sessionStart = performance.now();
    try {
      while (!this.isDone && !signal.aborted) {
        await this.stepOnce(signal);
        if (this.isDone || signal.aborted) break;
        if (this.delayMs > 0) await sleep(this.delayMs, signal);
        await this.pause.wait(signal);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    } finally {
      this.stats.activeMs += performance.now() - sessionStart;
      this.running = false;
      this.onStep();
    }
  }
}

export function formatUsd(value) {
  const amount = Number.isFinite(value) && value > 0 ? value : 0;
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(Math.max(4, 1 - Math.floor(Math.log10(amount))))}`;
  if (amount < 1000) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

export function ratePerMinute(count, ms) {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(ms) || ms <= 0) return 0;
  return count / (ms / 60_000);
}

export function formatRate(perMinute) {
  const rate = Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 0;
  return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
}

export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const head = hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes);
  return `${head}:${String(total % 60).padStart(2, '0')}`;
}
