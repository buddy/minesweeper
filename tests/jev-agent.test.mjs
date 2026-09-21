import test from 'node:test';
import assert from 'node:assert/strict';
import { Minesweeper } from '../js/game.js';
import { createRng } from '../js/rng.js';
import { createToolset } from '../js/tools.js';
import { JevAgent, buildJevRequest, forcedByOneClue, gatesFromAnchors, anchorBelief, jevRequestBytes, movesFromProbabilities, JEV_REQUEST_BYTE_BUDGET, JEV_CERTAINTY, JEV_SAFE_CERTAINTY } from '../js/agents/jev-agent.js';

const gateValues = ({ mine, safe }) => ({ mine, safe });
const CERTAIN_MINE = 1;
const CERTAIN_SAFE = 0;

function largeFrontier(count = 300) {
  return {
    mines_remaining: 250,
    unknown_cells_total: 1500,
    candidates: Array.from({ length: count }, (_, i) => ({
      cell: `r${Math.floor(i / 52)}c${i % 52}`, row: Math.floor(i / 52), col: i % 52,
      constraints: Array.from({ length: 8 }, (_, n) => ({
        from: `clue-${i}-${n}`, number: 3, flagged_neighbors: 1,
        unknown_neighbors: 4, mines_still_needed: 2, local_mine_ratio: 0.5,
      })),
    })),
  };
}

const covered = (...cells) => cells.map(cell => ({ cell, constraints: [{ from: `clue-${cell}` }] }));
const uncovered = (...cells) => cells.map(cell => ({ cell, constraints: [] }));

function stubToolset(frontier, execute, flags = []) {
  return { game: { isFinished: false }, frontier: () => frontier, unknownCells: () => [], retractableFlags: () => flags, execute };
}

function mockResponse(t, answers) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'groupCollapsed', () => {});
  t.mock.method(console, 'groupEnd', () => {});
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ answers: answers(request), usage: { input_tokens: 1234, output_tokens: 56 } }), { status: 200 });
  });
}

const rate = value => request => Object.fromEntries(Object.keys(request.questions).map(cell => [cell, { noul: value(cell) }]));

test('every candidate gets its own yes/no question alongside the shared evidence', () => {
  const game = new Minesweeper({ rows: 32, cols: 52, mines: 250, lives: 3, seed: 'jev-size' });
  game.autoOpen();
  const frontier = createToolset(game).frontier(100);
  const request = buildJevRequest(frontier, 'jev-latest');
  const cells = Object.keys(request.state.candidates);

  assert.deepEqual(Object.keys(request.questions), cells, 'one question per candidate, in the same order');
  for (const question of Object.values(request.questions)) assert.equal(question.type, 'noul');
  for (const [cell, clueIds] of Object.entries(request.state.candidates)) {
    const original = frontier.candidates.find(candidate => candidate.cell === cell);
    assert.deepEqual(clueIds, original.constraints.map(clue => clue.from));
    for (const id of clueIds) assert.ok(request.state.clues[id].cells.includes(cell));
  }
  for (const clue of Object.values(request.state.clues)) {
    assert.ok(clue.cells.length <= clue.unknown_neighbors, 'a clue cut by the budget must not look complete');
  }
  assert.ok(jevRequestBytes(request) <= JEV_REQUEST_BYTE_BUDGET);
});

test('large requests keep whole candidates and stay inside the byte budget', () => {
  const frontier = largeFrontier();
  const request = buildJevRequest(frontier, 'jev-latest');
  const cells = Object.keys(request.state.candidates);
  assert.ok(cells.length > 0 && cells.length < frontier.candidates.length);
  assert.deepEqual(cells, frontier.candidates.slice(0, cells.length).map(candidate => candidate.cell));
  assert.deepEqual(Object.keys(request.questions), cells);
  assert.ok(jevRequestBytes(request) <= JEV_REQUEST_BYTE_BUDGET);
  assert.throws(() => buildJevRequest(largeFrontier(0), 'jev-latest'), /at least one/);
});

test('everything proven is played at once, and nothing else is', () => {
  const candidates = covered('a', 'b', 'c', 'd', 'e');
  const probability = { a: CERTAIN_MINE, b: 0.99, c: CERTAIN_SAFE, d: 0.01, e: 0.5 };
  const moves = movesFromProbabilities(probability, candidates, []);
  assert.deepEqual(moves, [['flag', 'a'], ['flag', 'b'], ['reveal', 'c'], ['reveal', 'd']]);
  assert.ok(!moves.some(([, cell]) => cell === 'e'), 'an unsettled cell is left alone');
});

test('a board it cannot settle falls back to one reveal, the least likely mine', () => {
  const answers = { a: JEV_CERTAINTY - 0.01, b: JEV_SAFE_CERTAINTY + 0.01, c: 0.5 };
  assert.deepEqual(movesFromProbabilities(answers, covered('a', 'b', 'c'), []), [['reveal', 'b']]);
});

test('proven mines are flagged even when no cell is provably safe', () => {
  const moves = movesFromProbabilities({ a: CERTAIN_MINE, b: 0.45 }, covered('a', 'b'), []);
  assert.deepEqual(moves, [['flag', 'a'], ['reveal', 'b']], 'the flag lands and the run still advances');
});

test('a flag whose probability collapses is taken back', () => {
  const moves = movesFromProbabilities({ f: 0.01, a: 0.5 }, covered('a'), ['f']);
  assert.deepEqual(moves, [['unflag', 'f'], ['reveal', 'a']]);
});

test('with nothing left to reveal the weakest flag is taken back', () => {
  const moves = movesFromProbabilities({ f: 0.7, g: 0.6 }, [], ['f', 'g']);
  assert.deepEqual(moves, [['unflag', 'g']], 'otherwise the run would stall on a board it could still finish');
});

test('a cell no clue touches is never flagged, however sure the answer', () => {
  const blind = uncovered('a', 'b', 'c');
  const certain = Object.fromEntries(blind.map(candidate => [candidate.cell, CERTAIN_MINE]));
  assert.deepEqual(movesFromProbabilities(certain, blind, []), [['reveal', 'a']]);
  assert.deepEqual(movesFromProbabilities({ a: 0.4, b: 0.1, c: 0.9 }, blind, []), [['reveal', 'b']],
    'with nothing proven the answers still choose which single cell to open');
});

test('the fallback reveal never lands on a cell the same decision just flagged', () => {
  const candidates = covered('a', 'b');
  assert.deepEqual(movesFromProbabilities({ a: CERTAIN_MINE, b: CERTAIN_MINE }, candidates, []),
    [['flag', 'a'], ['flag', 'b']], 'every cell is settled, so nothing is opened on a guess');
});

test('the threshold is the only rule between the answers and the board', () => {
  const just = JEV_CERTAINTY;
  const under = JEV_CERTAINTY - 0.001;
  assert.deepEqual(movesFromProbabilities({ a: just, b: 0.5 }, covered('a', 'b'), []), [['flag', 'a'], ['reveal', 'b']]);
  assert.deepEqual(movesFromProbabilities({ a: under, b: 0.5 }, covered('a', 'b'), []), [['reveal', 'b']]);
});

test('the agent executes exactly the moves its own answers imply', async t => {
  mockResponse(t, rate(cell => ({ r0c0: CERTAIN_MINE, r0c1: CERTAIN_SAFE, r0c2: 0.5 })[cell]));
  const actions = [];
  const result = await new JevAgent({ viaProxy: true }).step(
    stubToolset(largeFrontier(3), (tool, args) => { actions.push({ tool, args }); return { result: { ok: true } }; }));
  assert.deepEqual(actions, [{ tool: 'flag', args: { row: 0, col: 0 } }, { tool: 'reveal', args: { row: 0, col: 1 } }]);
  assert.equal(result.error, null);
  assert.equal(result.apiCalls, 1);
  assert.equal(result.usage.input, 1234);
});

test('a missing or unusable probability rejects the whole decision', async t => {
  for (const answer of [undefined, null, 'high', -0.1, 1.5, Number.NaN]) {
    mockResponse(t, request => Object.fromEntries(Object.keys(request.questions).map((cell, i) =>
      [cell, { noul: i === 0 ? answer : 0.5 }])));
    const actions = [];
    await assert.rejects(new JevAgent({ viaProxy: true }).step(
      stubToolset(largeFrontier(3), (...args) => actions.push(args))), /no usable probability/);
    assert.deepEqual(actions, [], 'nothing reaches the board');
    t.mock.restoreAll();
  }
});

test('rejected moves and cancelled requests never trigger a replacement', async t => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    mockResponse(t, request => {
      if (cancelled) controller.abort();
      return rate(() => CERTAIN_SAFE)(request);
    });
    const actions = [];
    const task = new JevAgent({ viaProxy: true }).step(
      stubToolset(largeFrontier(2), (tool, args) => { actions.push({ tool, args }); return { result: { ok: false, message: 'Rejected' } }; }),
      { signal: controller.signal });
    if (cancelled) {
      await assert.rejects(task, { name: 'AbortError' });
      assert.deepEqual(actions, []);
    } else {
      const result = await task;
      assert.equal(actions.length, 2, 'both proven cells were attempted');
      assert.equal(result.error, 'No successful action taken');
    }
    t.mock.restoreAll();
  }
});

test('the forced-cell measurement reads the request the same way the rules describe it', () => {
  const request = {
    state: {
      clues: {
        full: { cells: ['a', 'b'], mines_still_needed: 2, unknown_neighbors: 2 },
        cut: { cells: ['c'], mines_still_needed: 1, unknown_neighbors: 4 },
        spent: { cells: ['d'], mines_still_needed: 0, unknown_neighbors: 1 },
        loose: { cells: ['e', 'f'], mines_still_needed: 1, unknown_neighbors: 2 },
      },
      candidates: { a: ['full'], b: ['full'], c: ['cut'], d: ['spent'], e: ['loose'], f: ['loose'] },
    },
  };
  assert.deepEqual(forcedByOneClue(request), { a: 'mine', b: 'mine', d: 'safe' },
    'a clue cut by the byte budget forces nothing, and neither does one with a choice left');
});

test('what the evidence forces is measured, never played', () => {
  const candidates = covered('a');
  assert.deepEqual(movesFromProbabilities({ a: 0.5 }, candidates, []), [['reveal', 'a']]);
  assert.equal(movesFromProbabilities.length, 3, 'no route for the app to pass in its own verdict');
});

test('a decision plays everything the whole frontier settles, not just the first batch it finds', async t => {
  const proven = { r0c1: CERTAIN_MINE, r0c9: CERTAIN_SAFE, r0c20: CERTAIN_MINE };
  let requests = 0;
  mockResponse(t, request => {
    requests++;
    return Object.fromEntries(Object.keys(request.questions).map(cell => [cell, { noul: proven[cell] ?? 0.5 }]));
  });
  const actions = [];
  await new JevAgent({ viaProxy: true, maxCandidates: 8 }).step(
    stubToolset(largeFrontier(24), (tool, args) => { actions.push({ tool, args }); return { result: { ok: true } }; }));

  assert.equal(requests, 3, 'the whole frontier is asked, not just up to the first batch that settles');
  assert.deepEqual(actions.map(a => `${a.tool} r${a.args.row}c${a.args.col}`),
    ['flag r0c1', 'reveal r0c9', 'flag r0c20'],
    'settled cells from every batch are played in one decision');
});

test('a decision that settles nothing keeps asking before it guesses', async t => {
  const proven = 'r0c12';
  let requests = 0;
  mockResponse(t, request => {
    requests++;
    return Object.fromEntries(Object.keys(request.questions).map(cell =>
      [cell, { noul: cell === proven ? CERTAIN_MINE : 0.5 }]));
  });
  const actions = [];
  const result = await new JevAgent({ viaProxy: true, maxCandidates: 8 }).step(
    stubToolset(largeFrontier(16), (tool, args) => { actions.push({ tool, args }); return { result: { ok: true } }; }));

  assert.equal(requests, 2, 'the first eight settled nothing, so the next eight were asked');
  assert.deepEqual(actions, [{ tool: 'flag', args: { row: 0, col: 12 } }],
    'the proven cell is played instead of a guess from the first batch');
  assert.equal(result.apiCalls, 2, 'every request is counted, or the cost is understated');
});

test('a frontier that settles nothing anywhere is guessed exactly once', async t => {
  let requests = 0;
  mockResponse(t, request => {
    requests++;
    return Object.fromEntries(Object.keys(request.questions).map((cell, i) => [cell, { noul: 0.4 + i / 100 }]));
  });
  const actions = [];
  await new JevAgent({ viaProxy: true, maxCandidates: 8 }).step(
    stubToolset(largeFrontier(24), (tool, args) => { actions.push({ tool, args }); return { result: { ok: true } }; }));

  assert.equal(requests, 3, 'it asked the whole frontier first');
  assert.equal(actions.length, 1, 'one guess, not one per batch');
  assert.equal(actions[0].tool, 'reveal');
  assert.deepEqual(actions[0].args, { row: 0, col: 0 }, 'the cell it rated least likely across everything it asked');
});

test('the two gates are separate, because a wrong flag and a wrong reveal do not cost the same', () => {
  assert.ok(JEV_SAFE_CERTAINTY < 1 - JEV_CERTAINTY,
    'the safe gate must be stricter than the mirror of the mine gate');
  const moves = movesFromProbabilities({ mine: 0.96, nearlySafe: 0.14, safe: 0.04 }, covered('mine', 'nearlySafe', 'safe'), []);
  assert.deepEqual(moves, [['flag', 'mine'], ['reveal', 'safe']],
    'the near-miss is left alone rather than played as proof');
});

test('a move says whether the answer proved it or only preferred it', async t => {
  mockResponse(t, request => Object.fromEntries(Object.keys(request.questions).map((cell, i) =>
    [cell, { noul: i === 0 ? CERTAIN_SAFE : 0.5 }])));
  const actions = [];
  const result = await new JevAgent({ viaProxy: true }).step(
    stubToolset(largeFrontier(3), (tool, args) => { actions.push({ tool, args }); return { result: { ok: true } }; }));

  assert.match(result.actions[0].reason, /reveal r0c0 at 0\.00 · proven/);
  mockResponse(t, rate(() => 0.5));
  const guessRun = await new JevAgent({ viaProxy: true }).step(
    stubToolset(largeFrontier(3), () => ({ result: { ok: true } })));
  assert.match(guessRun.actions[0].reason, /· guess$/, 'a fallback reveal must not read as proof');
});

test('a decision stops once the board it was answering about is gone', async t => {
  mockResponse(t, rate(() => CERTAIN_SAFE));
  const actions = [];
  const game = { isFinished: false };
  const toolset = { ...stubToolset(largeFrontier(6), null), game };
  toolset.execute = (tool, args) => {
    actions.push(`${tool} r${args.row}c${args.col}`);
    return { result: { ok: true, cells_changed: actions.length === 2 ? 14 : 1 } };
  };
  await new JevAgent({ viaProxy: true }).step(toolset);
  assert.deepEqual(actions, ['reveal r0c0', 'reveal r0c1'], 'the four answers behind the flood are not spent');
});

test('nothing is played into a finished game', async t => {
  mockResponse(t, rate(() => CERTAIN_SAFE));
  const actions = [];
  const game = { isFinished: false };
  const toolset = { ...stubToolset(largeFrontier(5), null), game };
  toolset.execute = (tool, args) => {
    actions.push(`${tool} r${args.row}c${args.col}`);
    game.isFinished = true;
    return { result: { ok: true, cells_changed: 1 } };
  };
  await new JevAgent({ viaProxy: true }).step(toolset);
  assert.equal(actions.length, 1, 'the rest are not sent to a board that is already over');
});

test('a decision stops once one of its answers has opened a mine', async t => {
  mockResponse(t, rate(() => CERTAIN_SAFE));
  const actions = [];
  const toolset = { ...stubToolset(largeFrontier(6), null), game: { isFinished: false } };
  toolset.execute = (tool, args) => {
    actions.push(`${tool} r${args.row}c${args.col}`);
    return { result: { ok: true, kind: actions.length === 2 ? 'mine' : 'revealed', cells_changed: 1 } };
  };
  await new JevAgent({ viaProxy: true }).step(toolset);
  assert.deepEqual(actions, ['reveal r0c0', 'reveal r0c1'],
    'the batch just proved itself wrong, so the rest of it is not spent');
});

test('the safe gate sits below the band where logged reveals opened mines', () => {
  const openedAMine = [0.14, 0.04, 0.09, 0.10, 0.09, 0.08, 0.08, 0.10, 0.09, 0.08];
  const caught = openedAMine.filter(value => value > JEV_SAFE_CERTAINTY).length;
  assert.ok(caught >= 9, `the gate lets ${openedAMine.length - caught} of these through`);
  assert.ok(JEV_SAFE_CERTAINTY >= 0.05, 'below this it would start refusing correct reveals too');
});

test('gates come from this request\'s own answers on what its payload proves', () => {
  const probability = { m1: 0.71, m2: 0.63, m3: 0.88, s1: 0.22, s2: 0.31, s3: 0.05, other: 0.5 };
  const forced = { m1: 'mine', m2: 'mine', m3: 'mine', s1: 'safe', s2: 'safe', s3: 'safe' };
  assert.deepEqual(gateValues(gatesFromAnchors(probability, forced)), { mine: 0.71, safe: 0.135 },
    'the mine side takes the middle of its proofs, the safe side reads low in its own spread');
  assert.deepEqual(gateValues(gatesFromAnchors(probability, {})), { mine: null, safe: null },
    'a request that proves nothing calibrates nothing');
});

test('a scale the constants were never measured on is still read correctly', () => {
  const probability = { m: 0.63, s: 0.22, likelyMine: 0.66, likelySafe: 0.18, unsure: 0.45 };
  const gates = gatesFromAnchors(probability, { m: 'mine', s: 'safe' });
  const moves = movesFromProbabilities(probability,
    covered('m', 's', 'likelyMine', 'likelySafe', 'unsure'), [], { gates });

  assert.deepEqual(moves, [['flag', 'm'], ['reveal', 's'], ['flag', 'likelyMine'], ['reveal', 'likelySafe']]);
  assert.deepEqual(movesFromProbabilities(probability, covered('likelyMine', 'likelySafe'), []),
    [['reveal', 'likelySafe']], 'the fixed gates alone would have settled almost none of it');
});

test('one badly answered proven cell does not prise the gates open', () => {
  const probability = { s1: 0.03, s2: 0.04, s3: 0.27, m1: 0.92, m2: 0.90, m3: 0.47, sloppy: 0.20, unsure: 0.55 };
  const forced = { s1: 'safe', s2: 'safe', s3: 'safe', m1: 'mine', m2: 'mine', m3: 'mine' };
  const gates = gatesFromAnchors(probability, forced);
  assert.deepEqual(gateValues(gates), { mine: 0.9, safe: 0.035 });

  const moves = movesFromProbabilities(probability, covered('sloppy', 'unsure'), [], { gates });
  assert.deepEqual(moves, [['reveal', 'sloppy']], 'played as the fallback guess, not as proof');
  assert.ok(!moves.some(([tool]) => tool === 'flag'), 'nothing near the outlier is flagged');
});

test('calibration never moves a gate across the coin flip', () => {
  const collapsed = { m1: 0.31, m2: 0.33, m3: 0.36, s1: 0.60, s2: 0.62, s3: 0.65, coinFlip: 0.34 };
  const gates = gatesFromAnchors(collapsed, { m1: 'mine', m2: 'mine', m3: 'mine', s1: 'safe', s2: 'safe', s3: 'safe' });
  assert.deepEqual(gateValues(gates), { mine: Infinity, safe: -Infinity },
    'a request that cannot rate its own proofs above a coin flip settles nothing');

  const moves = movesFromProbabilities(collapsed, covered('coinFlip'), [], { gates });
  assert.deepEqual(moves, [['reveal', 'coinFlip']], 'one guess, and nothing dressed as proof');
});

test('the app weighs its anchors by how much belief they rest on, without telling the model', () => {
  const game = new Minesweeper({ rows: 32, cols: 52, mines: 250, lives: 3, seed: 'flag-evidence' });
  game.autoOpen();
  const toolset = createToolset(game);
  const first = toolset.frontier(96).candidates[0];
  game.setFlag(first.row, first.col, true);

  const frontier = toolset.frontier(96);
  const request = buildJevRequest(frontier, 'jev-latest');
  assert.ok(Object.values(request.state.clues).every(clue => clue.mines_from_flags === undefined),
    'how much the app trusts a clue is the app\'s own reading, and is not sent to the model');

  const assumed = Object.values(anchorBelief(request, frontier.candidates));
  assert.ok(assumed.length > 0, 'there are anchors to weigh');
  assert.ok(assumed.some(value => value > 0), 'and some of them rest on that flag');
  assert.ok(assumed.every(value => Number.isInteger(value) && value >= 0));
});

test('a tie in the answers is not resolved by where the cells sit on the board', () => {
  const tied = ['r0c0', 'r0c1', 'r5c9', 'r9c9'];
  const probability = Object.fromEntries(tied.map(cell => [cell, 0.30]));
  const candidates = covered(...tied);
  assert.equal(movesFromProbabilities(probability, candidates, [])[0][1], 'r0c0',
    'without a tie-break it falls to frontier order, which is row then column');

  const picked = new Set();
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const rng = createRng(seed);
    picked.add(movesFromProbabilities(probability, candidates, [], { rng })[0][1]);
  }
  assert.ok(picked.size > 1, `every seed still chose ${[...picked]}`);

  const twice = ['x', 'y'].map(() => movesFromProbabilities(probability, candidates, [], { rng: createRng('same') })[0][1]);
  assert.equal(twice[0], twice[1], 'the same seed still replays the same run');
});

test('a request with too few proofs borrows from the recent ones rather than reading noise', () => {
  const probability = { s1: 0.30, m1: 0.90 };
  const forced = { s1: 'safe', m1: 'mine' };
  const recent = { safe: [0.02, 0.03, 0.03, 0.04, 0.04, 0.05], mine: [0.88, 0.89, 0.91, 0.92] };

  const alone = gatesFromAnchors(probability, forced);
  assert.equal(alone.safe, 0.30, 'one anchor on its own puts the gate wherever that anchor landed');

  const topped = gatesFromAnchors(probability, forced, {}, recent);
  assert.ok(topped.safe < 0.1, `one high answer should not carry the gate: got ${topped.safe}`);
  assert.deepEqual(topped.sampled, { mine: [0.9], safe: [0.3] },
    'only this request\'s own anchors are carried forward, not the borrowed ones');
});
