export const MUTATING_TOOLS = new Set(['reveal', 'flag', 'unflag', 'chord']);

const cellArgs = {
  row: { type: 'integer', description: '0-indexed row, top row is 0' },
  col: { type: 'integer', description: '0-indexed column, left column is 0' },
};

export const TOOL_DEFINITIONS = [
  {
    name: 'get_board',
    description:
      'Returns the full visible board as text. Legend: # unknown, F flagged, . revealed empty (0 adjacent mines), 1-8 revealed number of adjacent mines, * exploded mine.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_frontier',
    description:
      'Returns candidate cells: unknown, unflagged cells adjacent to at least one revealed number. For each candidate, lists every numbered neighbour with how many mines it still needs and how many unknown cells it touches. Also reports how many mines remain and how many unknown cells are not touching any number.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 255, description: 'Maximum candidates to return (default 80). Tightest constraints first.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_neighborhood',
    description: 'Returns a small text excerpt of the board centred on a cell, using the same legend as get_board.',
    parameters: {
      type: 'object',
      properties: {
        ...cellArgs,
        radius: { type: 'integer', minimum: 1, maximum: 6, description: 'How many cells around the centre to include (default 2).' },
      },
      required: ['row', 'col'],
      additionalProperties: false,
    },
  },
  {
    name: 'reveal',
    description: 'Reveals an unknown cell. If it is a mine you lose a life. Empty cells auto-open their neighbours. Ends your turn.',
    parameters: { type: 'object', properties: cellArgs, required: ['row', 'col'], additionalProperties: false },
  },
  {
    name: 'flag',
    description: 'Marks an unknown cell as a mine. Ends your turn (you may combine several flag/reveal calls in one response).',
    parameters: { type: 'object', properties: cellArgs, required: ['row', 'col'], additionalProperties: false },
  },
  {
    name: 'unflag',
    description: 'Removes a flag from a cell. Ends your turn.',
    parameters: { type: 'object', properties: cellArgs, required: ['row', 'col'], additionalProperties: false },
  },
  {
    name: 'chord',
    description:
      'For a revealed number whose flagged neighbours equal its number: reveals all remaining unknown neighbours at once. Ends your turn.',
    parameters: { type: 'object', properties: cellArgs, required: ['row', 'col'], additionalProperties: false },
  },
];

export function toOpenAITools(definitions = TOOL_DEFINITIONS) {
  return definitions.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

export function toAnthropicTools(definitions = TOOL_DEFINITIONS) {
  return definitions.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}

export function cellId(row, col) {
  return `r${row}c${col}`;
}

export const BOARD_LEGEND =
  'Legend: # unknown, F flagged, . revealed empty (0), 1-8 revealed number of adjacent mines, * exploded mine. Rows and columns are 0-indexed; cell ids look like r12c7 (row 12, column 7).';

function columnHeader(from, to) {
  const tens = [];
  const units = [];
  for (let c = from; c <= to; c++) {
    tens.push(c >= 10 ? String(Math.floor(c / 10) % 10) : ' ');
    units.push(String(c % 10));
  }
  return [`      ${tens.join('')}`, `      ${units.join('')}`];
}

export function createToolset(game) {
  function boardText() {
    const lines = [BOARD_LEGEND, ...columnHeader(0, game.cols - 1)];
    for (let r = 0; r < game.rows; r++) lines.push(`${String(r).padStart(4, ' ')}: ${game.rowString(r)}`);
    return lines.join('\n');
  }

  function neighborhood(row, col, radius = 2) {
    if (!game.inBounds(row, col)) return { ok: false, message: `Cell ${cellId(row, col)} is out of bounds` };
    const r0 = Math.max(0, row - radius);
    const r1 = Math.min(game.rows - 1, row + radius);
    const c0 = Math.max(0, col - radius);
    const c1 = Math.min(game.cols - 1, col + radius);
    const lines = columnHeader(c0, c1);
    for (let r = r0; r <= r1; r++) {
      let s = '';
      for (let c = c0; c <= c1; c++) s += game.charAt(game.index(r, c));
      lines.push(`${String(r).padStart(4, ' ')}: ${s}`);
    }
    return { ok: true, center: cellId(row, col), text: lines.join('\n') };
  }

  function frontier(limit = 80) {
    const candidates = new Map();
    let constraintCount = 0;

    for (let i = 0; i < game.size; i++) {
      if (!game.revealed[i] || game.exploded[i] || game.adjacent[i] === 0) continue;
      const nbrs = game.neighbors(i);
      const unknown = nbrs.filter((n) => !game.revealed[n] && !game.flagged[n]);
      if (unknown.length === 0) continue;
      const flaggedCount = nbrs.filter((n) => game.flagged[n]).length;
      const explodedCount = nbrs.filter((n) => game.exploded[n]).length;
      const needed = game.adjacent[i] - flaggedCount - explodedCount;
      const constraint = {
        from: cellId(game.rowOf(i), game.colOf(i)),
        number: game.adjacent[i],
        flagged_neighbors: flaggedCount,
        exploded_neighbors: explodedCount,
        unknown_neighbors: unknown.length,
        mines_still_needed: needed,
        local_mine_ratio: Math.round((needed / unknown.length) * 100) / 100,
      };
      constraintCount++;
      for (const u of unknown) {
        if (!candidates.has(u)) {
          candidates.set(u, { cell: cellId(game.rowOf(u), game.colOf(u)), row: game.rowOf(u), col: game.colOf(u), constraints: [] });
        }
        candidates.get(u).constraints.push(constraint);
      }
    }

    const list = [...candidates.values()].map((c) => {
      const ratios = c.constraints.map((k) => k.local_mine_ratio);
      return {
        ...c,
        min_local_mine_ratio: Math.min(...ratios),
        max_local_mine_ratio: Math.max(...ratios),
        tightest_unknown_count: Math.min(...c.constraints.map((k) => k.unknown_neighbors)),
      };
    });
    list.sort((a, b) => a.tightest_unknown_count - b.tightest_unknown_count || a.row - b.row || a.col - b.col);

    const unknownTotal = game.unknownCount;
    return {
      ...game.snapshot(),
      unknown_cells_total: unknownTotal,
      unknown_cells_isolated: unknownTotal - list.length,
      numbered_cells_with_unknown_neighbors: constraintCount,
      candidates_total: list.length,
      truncated: list.length > limit,
      candidates: list.slice(0, limit),
    };
  }

  function unknownCells(limit = 80) {
    const cells = [];
    for (let i = 0; i < game.size && cells.length < clampLimit(limit); i++) {
      if (game.revealed[i] || game.flagged[i]) continue;
      const row = game.rowOf(i);
      const col = game.colOf(i);
      cells.push({ cell: cellId(row, col), row, col, constraints: [] });
    }
    return cells;
  }

  function retractableFlags(limit = 80) {
    const worst = new Map();
    for (let i = 0; i < game.size; i++) {
      if (!game.revealed[i] || game.exploded[i] || game.adjacent[i] === 0) continue;
      const nbrs = game.neighbors(i);
      const flagged = nbrs.filter((n) => game.flagged[n]);
      if (flagged.length === 0) continue;
      const excess = flagged.length + nbrs.filter((n) => game.exploded[n]).length - game.adjacent[i];
      for (const f of flagged) worst.set(f, Math.max(worst.get(f) ?? -Infinity, excess));
    }
    return [...worst.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, clampLimit(limit))
      .map(([i, excess]) => ({ cell: cellId(game.rowOf(i), game.colOf(i)), row: game.rowOf(i), col: game.colOf(i), contradicted: excess > 0 }));
  }

  function summarizeGameResult(result) {
    if (!result.ok) return { ok: false, message: result.message, ...game.snapshot() };
    const revealedCells = result.changed
      .filter((i) => game.revealed[i])
      .slice(0, 60)
      .map((i) => `${cellId(game.rowOf(i), game.colOf(i))}=${game.charAt(i)}`);
    return {
      ok: true,
      kind: result.kind,
      message: result.message,
      cells_changed: result.changed.length,
      revealed_cells: revealedCells,
      ...game.snapshot(),
    };
  }

  function requireCell(args) {
    const row = Number(args?.row);
    const col = Number(args?.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      throw new Error('row and col must be integers');
    }
    return { row, col };
  }

  function execute(name, args = {}) {
    const mutating = MUTATING_TOOLS.has(name);
    try {
      switch (name) {
        case 'get_board':
          return { mutating, result: { ...game.snapshot(), board: boardText() } };
        case 'get_frontier':
          return { mutating, result: frontier(clampLimit(args.limit)) };
        case 'get_neighborhood': {
          const { row, col } = requireCell(args);
          const radius = Number.isInteger(Number(args.radius)) ? Math.min(6, Math.max(1, Number(args.radius))) : 2;
          return { mutating, result: neighborhood(row, col, radius) };
        }
        case 'reveal': {
          const { row, col } = requireCell(args);
          return { mutating, result: summarizeGameResult(game.reveal(row, col)) };
        }
        case 'flag': {
          const { row, col } = requireCell(args);
          return { mutating, result: summarizeGameResult(game.setFlag(row, col, true)) };
        }
        case 'unflag': {
          const { row, col } = requireCell(args);
          return { mutating, result: summarizeGameResult(game.setFlag(row, col, false)) };
        }
        case 'chord': {
          const { row, col } = requireCell(args);
          return { mutating, result: summarizeGameResult(game.chord(row, col)) };
        }
        default:
          return { mutating: false, result: { ok: false, message: `Unknown tool: ${name}` } };
      }
    } catch (error) {
      return { mutating: false, result: { ok: false, message: error.message } };
    }
  }

  return { game, definitions: TOOL_DEFINITIONS, boardText, frontier, neighborhood, unknownCells, retractableFlags, execute };
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return 80;
  return Math.min(255, Math.max(1, n));
}
