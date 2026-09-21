import { joinUrl, postJson } from '../http.js';
import { createRng } from '../rng.js';

const TYPESAFE_DEFAULT_BASE = 'https://api.typesafe.ai';

export const JEV_REQUEST_BYTE_BUDGET = 24_000;

export const JEV_FRONTIER_POOL = 96;

export const JEV_CERTAINTY = 0.85;

export const JEV_SAFE_CERTAINTY = 0.07;

const GAME_RULES =
  'Minesweeper. Each candidate is an unknown, unflagged cell. The clues map contains the visible clues: each clue lists in cells the candidates it touches, and each candidate lists the clues covering it. For each clue, mines_still_needed is the number of mines among its unknown_neighbors. Revealed exploded mines and flags have already been subtracted. If mines_still_needed is 0, every unknown neighbour is safe. If it equals unknown_neighbors, every unknown neighbour is a mine. A clue whose cells list is shorter than unknown_neighbors does not show all of them, so on its own it cannot prove certainty. Otherwise compare all clues for the candidate. Answer each question with the probability that the named cell holds a mine: near 1 when the clues prove a mine, near 0 when they prove it safe, and in between when they do not settle it. Cells in flags are already flagged; answer near 0 if you now believe the flag is wrong. Flags are beliefs and can be wrong; contradictory clues indicate uncertainty.';

export function cluesForCandidates(candidates) {
  const clues = {};
  for (const candidate of candidates) {
    for (const constraint of candidate.constraints) {
      const clue = (clues[constraint.from] ??= {
        cells: [],
        mines_still_needed: constraint.mines_still_needed,
        unknown_neighbors: constraint.unknown_neighbors,
      });
      clue.cells.push(candidate.cell);
    }
  }
  return clues;
}

function requestForCandidates(frontier, candidates, model, retractable) {
  const state = {
    rules: GAME_RULES,
    board: {
      mines_remaining: frontier.mines_remaining,
      unknown_cells_total: frontier.unknown_cells_total,
    },
    clues: cluesForCandidates(candidates),
    candidates: Object.fromEntries(candidates.map(candidate =>
      [candidate.cell, candidate.constraints.map(constraint => constraint.from)])),
  };
  const questions = Object.fromEntries(candidates.map(candidate =>
    [candidate.cell, { type: 'noul', instructions: `Is ${candidate.cell} a mine?` }]));
  if (retractable.length) {
    state.flags = Object.fromEntries(retractable.map(flag => [flag.cell, { contradicted: flag.contradicted }]));
    for (const flag of retractable) {
      questions[flag.cell] = { type: 'noul', instructions: `${flag.cell} is flagged. Is it really a mine?` };
    }
  }
  return { state, model, questions };
}

export function jevRequestBytes(request) {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

export function buildJevRequest(frontier, model, retractable = []) {
  if (!frontier.candidates.length) {
    if (!retractable.length) throw new Error('Jev needs at least one frontier candidate.');
    return requestForCandidates(frontier, [], model, retractable);
  }
  let low = 1;
  let high = frontier.candidates.length;
  let best;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const request = requestForCandidates(frontier, frontier.candidates.slice(0, count), model, retractable);
    if (jevRequestBytes(request) <= JEV_REQUEST_BYTE_BUDGET) {
      best = request;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  if (!best) throw new Error('A single Jev candidate exceeds the request size budget.');
  return best;
}

const isProvable = candidate => candidate.constraints?.length > 0;

export const ANCHOR_SAMPLE = 16;

export function gatesFromAnchors(probability, forced, belief = {}, recent = { mine: [], safe: [] }) {
  const answers = kind => {
    const cells = Object.entries(forced)
      .filter(([cell, settled]) => settled === kind && typeof probability[cell] === 'number');
    if (!cells.length) return [];
    const fewest = Math.min(...cells.map(([cell]) => belief[cell] ?? 0));
    return cells.filter(([cell]) => (belief[cell] ?? 0) === fewest).map(([cell]) => probability[cell]);
  };
  const topUp = (fresh, kind) => fresh.concat(recent[kind] ?? []).slice(0, ANCHOR_SAMPLE);
  const quantile = (values, at) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * at;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  const freshMine = answers('mine');
  const freshSafe = answers('safe');
  const mine = quantile(topUp(freshMine, 'mine'), 0.5);
  const safe = quantile(topUp(freshSafe, 'safe'), 0.25);
  return {
    mine: mine === null ? null : (mine < 0.5 ? Infinity : mine),
    safe: safe === null ? null : (safe > 0.5 ? -Infinity : safe),
    sampled: { mine: freshMine, safe: freshSafe },
  };
}

function unbiased(candidates, rng) {
  if (!rng) return candidates;
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function movesFromProbabilities(probability, candidates, flagged, { guessIfUnsettled = true, gates, rng } = {}) {
  const certainMine = gates?.mine === null || gates?.mine === undefined
    ? value => value >= JEV_CERTAINTY
    : value => value >= gates.mine;
  const certainSafe = gates?.safe === null || gates?.safe === undefined
    ? value => value <= JEV_SAFE_CERTAINTY
    : value => value <= gates.safe;
  const moves = [];
  for (const cell of flagged) {
    if (certainSafe(probability[cell])) moves.push(['unflag', cell]);
  }
  for (const candidate of candidates) {
    const value = probability[candidate.cell];
    if (!isProvable(candidate)) continue;
    if (certainMine(value)) moves.push(['flag', candidate.cell]);
    else if (certainSafe(value)) moves.push(['reveal', candidate.cell]);
  }
  if (moves.some(([tool]) => tool === 'reveal')) return moves;
  if (!guessIfUnsettled) return moves;
  const justFlagged = new Set(moves.filter(([tool]) => tool === 'flag').map(([, cell]) => cell));
  const safest = unbiased(candidates.filter(candidate => !justFlagged.has(candidate.cell)), rng)
    .sort((a, b) => probability[a.cell] - probability[b.cell])[0];
  if (safest) {
    moves.push(['reveal', safest.cell]);
  } else if (moves.length === 0 && flagged.length) {
    const weakest = [...flagged].sort((a, b) => probability[a] - probability[b])[0];
    moves.push(['unflag', weakest]);
  }
  return moves;
}

export function anchorBelief(request, candidates = []) {
  const assumedByClue = new Map();
  for (const candidate of candidates) {
    for (const constraint of candidate.constraints) {
      assumedByClue.set(constraint.from, constraint.flagged_neighbors ?? 0);
    }
  }
  const belief = {};
  for (const [cell, clueIds] of Object.entries(request.state.candidates)) {
    for (const id of clueIds) {
      const clue = request.state.clues[id];
      const settles = clue.mines_still_needed === 0
        || (clue.cells.length === clue.unknown_neighbors && clue.mines_still_needed === clue.cells.length);
      if (!settles) continue;
      const assumed = assumedByClue.get(id) ?? 0;
      belief[cell] = belief[cell] === undefined ? assumed : Math.min(belief[cell], assumed);
    }
  }
  return belief;
}

export function forcedByOneClue(request) {
  const forced = {};
  for (const [cell, clueIds] of Object.entries(request.state.candidates)) {
    for (const id of clueIds) {
      const clue = request.state.clues[id];
      if (clue.mines_still_needed === 0) forced[cell] = 'safe';
      else if (clue.cells.length === clue.unknown_neighbors && clue.mines_still_needed === clue.cells.length) forced[cell] = 'mine';
    }
  }
  return forced;
}

export function summarizeAnswers(probability, forced = {}, gates = {}) {
  const mineGate = gates.mine ?? JEV_CERTAINTY;
  const safeGate = gates.safe ?? JEV_SAFE_CERTAINTY;
  const entries = Object.entries(probability).sort((a, b) => b[1] - a[1]);
  const show = ([cell, value]) => `${cell} ${value.toFixed(3)}`;
  const onForced = kind => entries.filter(([cell]) => forced[cell] === kind).map(([, value]) => value);
  const spread = values => values.length
    ? `${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}` : 'none in this request';
  const forcedMines = onForced('mine');
  const rest = entries.filter(([cell]) => forced[cell] !== 'mine').map(([, value]) => value);
  const gap = forcedMines.length && rest.length
    ? (Math.min(...forcedMines) - Math.max(...rest)).toFixed(3) : 'not measurable here';
  return {
    answers: entries.length,
    gates: `mine ${mineGate === Infinity ? 'none' : mineGate.toFixed(2)}${gates.calibrated?.mine === false ? ' (fallback)' : ''}`
      + ` · safe ${safeGate === -Infinity ? 'none' : safeGate.toFixed(2)}${gates.calibrated?.safe === false ? ' (fallback)' : ''}`,
    provenMines: entries.filter(([, value]) => value >= mineGate).length,
    provenSafe: entries.filter(([, value]) => value <= safeGate).length,
    highest: entries.slice(0, 3).map(show),
    lowest: entries.slice(-3).reverse().map(show),
    answeredOnForcedMines: spread(forcedMines),
    answeredOnForcedSafe: spread(onForced('safe')),
    answeredOnEverythingElse: spread(rest),
    gapBetweenThem: gap,
  };
}

export class JevAgent {
  constructor(config) {
    this.config = {
      apiKey: '',
      model: 'jev-latest',
      baseUrl: '',
      viaProxy: false,
      maxCandidates: 100,
      frontierPool: JEV_FRONTIER_POOL,
      ...config,
    };
    this.name = `typesafe:${this.config.model}`;
  }

  async step(toolset, { signal } = {}) {
    const started = performance.now();
    const actions = [];
    const transcript = [];
    const batchSize = this.config.maxCandidates;
    const pool = toolset.frontier(this.config.frontierPool);

    if (pool.candidates.length === 0) {
      pool.candidates = toolset.unknownCells(batchSize);
    }

    const flags = toolset.retractableFlags(batchSize);
    const retractable = pool.candidates.length ? flags.filter(flag => flag.contradicted) : flags;
    const flagged = retractable.map(flag => flag.cell);

    const usage = { input: 0, cachedInput: 0, output: 0 };
    const seen = {};
    const asked = [];
    let apiCalls = 0;
    let moves = [];
    let lastGates = { mine: null, safe: null };
    let recentAnchors = this.recentAnchors ?? { mine: [], safe: [] };

    for (let offset = 0; offset < pool.candidates.length; offset += batchSize) {
      const batch = pool.candidates.slice(offset, offset + batchSize);
      const withFlags = offset === 0 ? retractable : [];
      const request = buildJevRequest({ ...pool, candidates: batch }, this.config.model, withFlags);
      const candidates = batch.filter(candidate => Object.hasOwn(request.state.candidates, candidate.cell));
      const sentAt = performance.now();
      transcript.push({ role: 'request', questions: Object.keys(request.questions).length,
        candidates: candidates.length, offset, requestBytes: jevRequestBytes(request),
      });

      const response = await postJson(joinUrl(this.config.baseUrl || TYPESAFE_DEFAULT_BASE, '/v1/systemone'), {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: request,
        viaProxy: this.config.viaProxy,
        signal,
      });
      apiCalls++;
      usage.input += response.usage?.input_tokens ?? 0;
      usage.output += response.usage?.output_tokens ?? 0;
      const answers = response.answers ?? {};
      const probability = {};
      for (const name of Object.keys(request.questions)) {
        const value = answers[name]?.noul;
        if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
          throw new Error(`Jev returned no usable probability for ${name}. No moves were applied.`);
        }
        probability[name] = value;
      }
      Object.assign(seen, probability);
      asked.push(...candidates);

      const forced = forcedByOneClue(request);
      const answerSummary = summarizeAnswers(probability, forced, lastGates);
      console.groupCollapsed(`Jev · ${answerSummary.answers} cells · ${answerSummary.gates} · ${answerSummary.provenMines} mine, ${answerSummary.provenSafe} safe`);
      console.log({ highest: answerSummary.highest, lowest: answerSummary.lowest,
        onCellsOneClueForcesAsMine: answerSummary.answeredOnForcedMines,
        onCellsOneClueForcesAsSafe: answerSummary.answeredOnForcedSafe,
        onEverythingElse: answerSummary.answeredOnEverythingElse,
        gap: answerSummary.gapBetweenThem });
      console.groupEnd();
      transcript.push({ role: 'answers', apiLatencyMs: Math.round(performance.now() - sentAt), ...answerSummary });

      const gates = gatesFromAnchors(probability, forced, anchorBelief(request, candidates), recentAnchors);
      recentAnchors = {
        mine: gates.sampled.mine.concat(recentAnchors.mine).slice(0, ANCHOR_SAMPLE),
        safe: gates.sampled.safe.concat(recentAnchors.safe).slice(0, ANCHOR_SAMPLE),
      };
      lastGates = {
        mine: gates.mine ?? lastGates.mine,
        safe: gates.safe ?? lastGates.safe,
        calibrated: { mine: gates.mine !== null, safe: gates.safe !== null },
      };
      moves.push(...movesFromProbabilities(probability, candidates, offset === 0 ? flagged : [],
        { guessIfUnsettled: false, gates: lastGates }));
    }

    this.recentAnchors = recentAnchors;
    if (moves.length === 0) {
      this.rng ??= createRng(`jev-tiebreak:${toolset.game.seed}`);
      moves = movesFromProbabilities(seen, asked, flagged, { gates: lastGates, rng: this.rng });
    }
    transcript.push({ role: 'decision', moves: moves.length, askedCells: asked.length, requests: apiCalls,
      settled: moves.some(([tool, cell]) => tool !== 'reveal' || seen[cell] <= (lastGates.safe ?? JEV_SAFE_CERTAINTY)),
    });

    signal?.throwIfAborted();
    const positions = new Map([...asked, ...retractable].map(entry => [entry.cell, entry]));
    for (const [tool, cell] of moves) {
      if (toolset.game.isFinished) break;
      const target = positions.get(cell);
      const args = { row: target.row, col: target.col };
      const { result } = toolset.execute(tool, args);
      const value = seen[cell];
      const byMineGate = lastGates.mine === null ? value >= JEV_CERTAINTY : value >= lastGates.mine;
      const bySafeGate = lastGates.safe === null ? value <= JEV_SAFE_CERTAINTY : value <= lastGates.safe;
      const proven = tool === 'flag' ? byMineGate : bySafeGate;
      actions.push({ tool, args, result,
        reason: `Jev ${tool} ${cell} at ${value.toFixed(2)} · ${proven ? 'proven' : 'guess'}` });
      if (result.kind === 'mine') break;
      if (tool === 'reveal' && result.ok && result.cells_changed > 1) break;
    }

    return this.finish({ started, actions, transcript, apiCalls, usage, error: actions.some(action => action.result.ok) ? null : 'No successful action taken' });
  }

  finish({ started, actions, transcript, apiCalls, usage, error }) {
    return {
      actions,
      latencyMs: performance.now() - started,
      apiCalls,
      toolCalls: actions.length,
      usage,
      transcript,
      error,
    };
  }
}
