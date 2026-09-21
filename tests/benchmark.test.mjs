import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatRate, formatUsd, maxDecisions, ratePerMinute, AgentRunner, PauseGate } from '../js/benchmark.js';
import { Minesweeper, BOARD_LIMITS, MINE_DENSITY, boardFor, mineBounds } from '../js/game.js';

test('stage clock reads m:ss and grows to h:mm:ss without dropping seconds', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(999), '0:00');
  assert.equal(formatDuration(1000), '0:01');
  assert.equal(formatDuration(59_999), '0:59');
  assert.equal(formatDuration(60_000), '1:00');
  assert.equal(formatDuration(600_000), '10:00');
  assert.equal(formatDuration(3_599_000), '59:59');
  assert.equal(formatDuration(3_600_000), '1:00:00');
  assert.equal(formatDuration(3_661_000), '1:01:01');
  assert.equal(formatDuration(45_296_000), '12:34:56');
});

test('an absent or reset clock renders zero rather than NaN on the stage', () => {
  for (const value of [undefined, null, NaN, -1, -60_000, Infinity, '12']) {
    assert.equal(formatDuration(value), '0:00', `formatDuration(${String(value)})`);
  }
});

test('cost formatting stays readable from fractions of a cent to hundreds of dollars', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.000252), '$0.00025');
  assert.equal(formatUsd(0.0012), '$0.0012');
  assert.equal(formatUsd(0.009), '$0.0090');
  assert.equal(formatUsd(0.37), '$0.37');
  assert.equal(formatUsd(12.3456), '$12.35');
  assert.equal(formatUsd(999.994), '$999.99');
  assert.equal(formatUsd(1234.5), '$1,235');
  assert.equal(formatUsd(1e-7).includes('e'), false);
});

test('an absent or malformed cost renders zero rather than NaN', () => {
  for (const value of [undefined, null, NaN, -1, Infinity, '12']) {
    assert.equal(formatUsd(value), '$0.00', `formatUsd(${String(value)})`);
  }
});

test('the per-minute rate appears with the first move rather than waiting to settle', () => {
  assert.equal(ratePerMinute(60, 60_000), 60);
  assert.equal(ratePerMinute(7, 12_000), 35);
  assert.equal(ratePerMinute(1, 200), 300, 'an early rate is wild, but the lane is not left blank for it');
  for (const [count, ms] of [[0, 60_000], [5, 0], [5, -1], [-1, 60_000], [NaN, 60_000], [5, NaN], [5, Infinity]]) {
    assert.equal(ratePerMinute(count, ms), 0, `ratePerMinute(${String(count)}, ${String(ms)})`);
  }
});

test('the rate keeps a decimal only where rounding would hide the difference', () => {
  assert.equal(formatRate(35), '35');
  assert.equal(formatRate(10), '10');
  assert.equal(formatRate(3.44), '3.4', 'a slow lane keeps a decimal rather than reading as a flat number');
  assert.equal(formatRate(9.96), '10.0');
  for (const value of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(formatRate(value), '0.0', `formatRate(${String(value)}) is never NaN`);
  }
});

test('every board size the picker allows is a board the engine accepts', () => {
  const { minRows, maxRows, minCols, maxCols } = BOARD_LIMITS;
  for (const rows of [minRows, 17, maxRows]) {
    for (const cols of [minCols, 31, maxCols]) {
      const config = boardFor(rows, cols);
      assert.deepEqual([config.rows, config.cols], [rows, cols]);
      assert.equal(config.mines, Math.round(rows * cols * MINE_DENSITY), 'one density for every size, or the sizes are not comparable');
      assert.doesNotThrow(() => new Minesweeper({ ...config, seed: 'size' }));
    }
  }
});

test('a size outside the limits is pulled back inside them rather than rejected', () => {
  const { minRows, maxRows, minCols, maxCols } = BOARD_LIMITS;
  for (const [rows, cols] of [[1, 1], [999, 999], ['', null], [Number.NaN, 'abc'], [17.4, 30.6]]) {
    const config = boardFor(rows, cols);
    assert.ok(config.rows >= minRows && config.rows <= maxRows, `rows ${config.rows}`);
    assert.ok(config.cols >= minCols && config.cols <= maxCols, `cols ${config.cols}`);
    assert.ok(Number.isInteger(config.rows) && Number.isInteger(config.cols));
  }
});

test('the decision limit leaves every size room a perfect player cannot use up', () => {
  for (const [rows, cols, measured] of [[10, 10, 38], [16, 20, 102], [20, 30, 207], [32, 52, 557]]) {
    const limit = maxDecisions(rows, cols);
    assert.ok(limit > measured * 1.4, `${rows}x${cols}: ${limit} leaves too little over ${measured}`);
    assert.ok(limit < measured * 4, `${rows}x${cols}: ${limit} is so loose it stops being a limit`);
  }
});

test('a paused gate releases only on resume, and lets go when the run is stopped', async () => {
  const gate = new PauseGate();
  let passedStraightThrough = false;
  gate.wait().then(() => { passedStraightThrough = true; });
  await Promise.resolve();
  assert.equal(passedStraightThrough, true, 'an open gate never makes a caller wait');

  assert.equal(gate.toggle(), true);
  let released = false;
  const held = gate.wait().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false, 'still holding');
  assert.equal(gate.toggle(), false);
  await held;
  assert.equal(released, true);

  gate.toggle();
  const controller = new AbortController();
  const stopped = gate.wait(controller.signal);
  controller.abort();
  await assert.rejects(stopped, { name: 'AbortError' }, 'stopping a paused run must not hang it');
});

test('a pause stops the next decision without ending the run', async () => {
  const pause = new PauseGate();
  let steps = 0;
  const game = { isFinished: false, explodedCount: 0, status: 'playing' };
  const agent = { step: async () => {
    steps++;
    return { actions: [], latencyMs: 1, apiCalls: 1, toolCalls: 0, usage: { input: 0, output: 0 }, error: null };
  } };
  const runner = new AgentRunner({ agent, toolset: { game }, delayMs: 1, maxSteps: 10_000, pause });
  const controller = new AbortController();
  const task = runner.run(controller.signal);

  await new Promise(resolve => setTimeout(resolve, 20));
  pause.toggle();
  await new Promise(resolve => setTimeout(resolve, 20));
  const held = steps;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(steps, held, 'no decision is taken while paused');
  assert.equal(runner.running, true, 'the run is held, not finished');

  pause.toggle();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(steps > held, 'resuming carries the same run on');
  game.isFinished = true;
  controller.abort();
  await task;
});

test('a decision logs what the model said before the moves it made', async () => {
  const logs = [];
  const game = { isFinished: false, explodedCount: 0, status: 'playing' };
  const agent = { step: async () => {
    game.isFinished = true;
    return {
      actions: [{ tool: 'flag', args: { row: 2, col: 3 }, result: { ok: true, message: 'flagged' } }],
      transcript: [
        { role: 'reasoning', text: 'Clue r1c3 needs one more mine and has one unknown.' },
        { role: 'assistant', text: '  r2c3 must be a mine.  ' },
        { role: 'tool', name: 'flag', result: {} },
      ],
      latencyMs: 12, apiCalls: 1, toolCalls: 1, usage: { input: 0, output: 0 }, error: null,
    };
  } };
  const runner = new AgentRunner({ agent, toolset: { game }, delayMs: 0, onLog: entry => logs.push(entry) });
  await runner.run(new AbortController().signal);

  assert.deepEqual(logs.map(entry => entry.level), ['reasoning', 'model', 'info', 'meta'],
    'the reasoning comes first, then what it said, then what it did, then the timing');
  assert.equal(logs[1].text, 'r2c3 must be a mine.', 'trimmed, and tool entries are not logged as prose');
  assert.match(logs[2].text, /flag r2c3/);
});

test('a chosen mine count is honoured inside bounds and pulled inside them outside', () => {
  const { minRows, maxRows, minCols, maxCols } = BOARD_LIMITS;
  for (const [rows, cols] of [[minRows, minCols], [17, 31], [maxRows, maxCols]]) {
    const { min, max } = mineBounds(rows, cols);
    assert.ok(min >= 1 && max > min, `${rows}x${cols}: bounds ${min}-${max} leave no room`);
    assert.ok(max <= rows * cols - 9, 'the engine reserves nine cells for a safe opening');
    assert.equal(boardFor(rows, cols, min + 1).mines, min + 1, 'a count inside the bounds is kept');
    for (const [asked, expected] of [[0, min], [-5, min], [max + 1, max], [1e6, max], ['abc', min]]) {
      assert.equal(boardFor(rows, cols, asked).mines, expected, `${rows}x${cols} asked ${asked}`);
    }
    for (const mines of [min, max]) {
      assert.doesNotThrow(() => new Minesweeper({ ...boardFor(rows, cols, mines), seed: 'mines' }));
    }
  }
  assert.equal(boardFor(maxRows, maxCols).mines, Math.round(maxRows * maxCols * MINE_DENSITY),
    'an unset count still follows the density');
});

test('a turn is one loop, and moves count only what reached the board', async () => {
  const game = { isFinished: false, explodedCount: 0, status: 'playing' };
  const agent = { step: async () => {
    game.isFinished = true;
    return {
      actions: [{ tool: 'flag', args: { row: 1, col: 1 }, result: { ok: true, message: 'f' } },
        { tool: 'reveal', args: { row: 1, col: 2 }, result: { ok: true, message: 'r' } }],
      toolCalls: 3, transcript: [], latencyMs: 1, apiCalls: 1,
      usage: { input: 0, output: 0 }, error: null,
    };
  } };
  const runner = new AgentRunner({ agent, toolset: { game }, delayMs: 0 });
  await runner.run(new AbortController().signal);

  assert.equal(runner.stats.steps, 1, 'one loop is one turn');
  assert.equal(runner.stats.moves, 2, 'the frontier read is not a move');
  assert.equal(runner.stats.toolCalls, 3, 'it is still counted where cost and latency are read');
});
