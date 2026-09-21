import { createRng } from './rng.js';

export const STATUS = Object.freeze({
  READY: 'ready',
  PLAYING: 'playing',
  WON: 'won',
  LOST: 'lost',
});

export const BOARD_LIMITS = Object.freeze({ minRows: 10, maxRows: 32, minCols: 10, maxCols: 52 });

export const MINE_DENSITY = 0.15;

export function mineBounds(rows, cols) {
  const total = rows * cols;
  return { min: Math.max(1, Math.round(total * 0.05)), max: Math.min(total - 9, Math.round(total * 0.3)) };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value)) || min));

export function boardFor(rows, cols, mines, lives = 3) {
  const r = clamp(rows, BOARD_LIMITS.minRows, BOARD_LIMITS.maxRows);
  const c = clamp(cols, BOARD_LIMITS.minCols, BOARD_LIMITS.maxCols);
  const bounds = mineBounds(r, c);
  return {
    rows: r,
    cols: c,
    mines: mines === undefined ? Math.round(r * c * MINE_DENSITY) : clamp(mines, bounds.min, bounds.max),
    lives,
  };
}

export class Minesweeper {
  constructor({ rows, cols, mines, seed, lives = 1 }) {
    const total = rows * cols;
    if (rows < 5 || cols < 5) throw new Error('Board must be at least 5x5');
    if (mines < 1 || mines > total - 9) throw new Error('Too many mines for this board size');

    this.rows = rows;
    this.cols = cols;
    this.minesTotal = mines;
    this.seed = seed;
    this.lives = lives;
    this.livesLeft = lives;
    this.rng = createRng(seed);

    this.mine = new Uint8Array(total);
    this.revealed = new Uint8Array(total);
    this.flagged = new Uint8Array(total);
    this.exploded = new Uint8Array(total);
    this.adjacent = new Uint8Array(total);

    this.minesPlaced = false;
    this.status = STATUS.READY;
    this.safeTotal = total - mines;
    this.safeRevealed = 0;
    this.flagsPlaced = 0;
    this.explodedCount = 0;
    this.moves = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.lastActionIndex = -1;
    this.listeners = new Set();
  }

  get size() {
    return this.rows * this.cols;
  }

  get isFinished() {
    return this.status === STATUS.WON || this.status === STATUS.LOST;
  }

  get minesRemaining() {
    return this.minesTotal - this.flagsPlaced - this.explodedCount;
  }

  get progress() {
    return this.safeRevealed / this.safeTotal;
  }

  get unknownCount() {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (!this.revealed[i] && !this.flagged[i]) n++;
    return n;
  }

  elapsedMs(now = Date.now()) {
    if (!this.startedAt) return 0;
    return (this.endedAt ?? now) - this.startedAt;
  }

  index(row, col) {
    return row * this.cols + col;
  }

  rowOf(index) {
    return Math.floor(index / this.cols);
  }

  colOf(index) {
    return index % this.cols;
  }

  inBounds(row, col) {
    return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }

  neighbors(index) {
    const row = this.rowOf(index);
    const col = this.colOf(index);
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr;
        const c = col + dc;
        if (this.inBounds(r, c)) out.push(this.index(r, c));
      }
    }
    return out;
  }

  charAt(index) {
    if (this.revealed[index]) {
      if (this.exploded[index]) return '*';
      return this.adjacent[index] === 0 ? '.' : String(this.adjacent[index]);
    }
    if (this.flagged[index]) return 'F';
    return '#';
  }

  rowString(row) {
    let s = '';
    for (let c = 0; c < this.cols; c++) s += this.charAt(this.index(row, c));
    return s;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(changed) {
    for (const listener of this.listeners) listener(changed, this);
  }

  placeMines(excludeIndex) {
    const forbidden = new Set([excludeIndex, ...this.neighbors(excludeIndex)]);
    let pool = [];
    for (let i = 0; i < this.size; i++) if (!forbidden.has(i)) pool.push(i);
    if (pool.length < this.minesTotal) {
      pool = [];
      for (let i = 0; i < this.size; i++) if (i !== excludeIndex) pool.push(i);
    }
    for (let k = 0; k < this.minesTotal; k++) {
      const j = k + Math.floor(this.rng() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j], pool[k]];
      this.mine[pool[k]] = 1;
    }
    for (let i = 0; i < this.size; i++) {
      if (this.mine[i]) continue;
      let count = 0;
      for (const n of this.neighbors(i)) count += this.mine[n];
      this.adjacent[i] = count;
    }
    this.minesPlaced = true;
  }

  autoOpen() {
    const start = Math.floor(this.rng() * this.size);
    if (!this.minesPlaced) this.placeMines(start);
    const result = this.reveal(this.rowOf(start), this.colOf(start));
    if (!this.isFinished) {
      this.status = STATUS.READY;
      this.startedAt = null;
      this.moves = 0;
      this.lastActionIndex = -1;
    }
    return result;
  }

  ensureStarted(index) {
    if (!this.minesPlaced) this.placeMines(index);
    if (this.status === STATUS.READY) {
      this.status = STATUS.PLAYING;
      this.startedAt = Date.now();
    }
  }

  finish(status) {
    this.status = status;
    this.endedAt = Date.now();
    const changed = [];
    if (status === STATUS.LOST) {
      for (let i = 0; i < this.size; i++) {
        if (this.mine[i] && !this.revealed[i]) {
          this.revealed[i] = 1;
          changed.push(i);
        }
        if (!this.mine[i] && this.flagged[i]) changed.push(i);
      }
    }
    return changed;
  }

  fail(message) {
    return { ok: false, kind: 'error', message, changed: [] };
  }

  reveal(row, col) {
    if (!this.inBounds(row, col)) return this.fail(`Cell r${row}c${col} is out of bounds`);
    if (this.isFinished) return this.fail('Game is already over');
    const index = this.index(row, col);
    if (this.flagged[index]) return this.fail(`Cell r${row}c${col} is flagged; unflag it first`);
    if (this.revealed[index]) return this.fail(`Cell r${row}c${col} is already revealed`);

    this.ensureStarted(index);
    this.moves++;
    this.lastActionIndex = index;

    if (this.mine[index]) {
      this.revealed[index] = 1;
      this.exploded[index] = 1;
      this.explodedCount++;
      this.livesLeft--;
      let changed = [index];
      if (this.livesLeft <= 0) changed = changed.concat(this.finish(STATUS.LOST));
      this.emit(changed);
      return { ok: true, kind: 'mine', changed, livesLeft: this.livesLeft, message: `Cell r${row}c${col} was a mine` };
    }

    const changed = this.floodReveal(index);
    this.safeRevealed += changed.length;
    if (this.safeRevealed === this.safeTotal) changed.push(...this.finish(STATUS.WON));
    this.emit(changed);
    return {
      ok: true,
      kind: 'revealed',
      changed,
      cellsRevealed: changed.length,
      value: this.adjacent[index],
      message: `Revealed r${row}c${col} (${this.adjacent[index]}), ${changed.length} cell(s) opened`,
    };
  }

  floodReveal(start) {
    const changed = [];
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (this.revealed[i] || this.flagged[i] || this.mine[i]) continue;
      this.revealed[i] = 1;
      changed.push(i);
      if (this.adjacent[i] === 0) {
        for (const n of this.neighbors(i)) if (!this.revealed[n]) stack.push(n);
      }
    }
    return changed;
  }

  setFlag(row, col, on) {
    if (!this.inBounds(row, col)) return this.fail(`Cell r${row}c${col} is out of bounds`);
    if (this.isFinished) return this.fail('Game is already over');
    const index = this.index(row, col);
    if (this.revealed[index]) return this.fail(`Cell r${row}c${col} is already revealed`);
    if (Boolean(this.flagged[index]) === on) {
      return this.fail(`Cell r${row}c${col} is already ${on ? 'flagged' : 'unflagged'}`);
    }
    this.flagged[index] = on ? 1 : 0;
    this.flagsPlaced += on ? 1 : -1;
    this.moves++;
    this.lastActionIndex = index;
    this.emit([index]);
    return { ok: true, kind: on ? 'flagged' : 'unflagged', changed: [index], message: `${on ? 'Flagged' : 'Unflagged'} r${row}c${col}` };
  }

  toggleFlag(row, col) {
    if (!this.inBounds(row, col)) return this.fail(`Cell r${row}c${col} is out of bounds`);
    return this.setFlag(row, col, !this.flagged[this.index(row, col)]);
  }

  chord(row, col) {
    if (!this.inBounds(row, col)) return this.fail(`Cell r${row}c${col} is out of bounds`);
    if (this.isFinished) return this.fail('Game is already over');
    const index = this.index(row, col);
    if (!this.revealed[index] || this.exploded[index]) return this.fail(`Cell r${row}c${col} is not a revealed number`);
    const nbrs = this.neighbors(index);
    const flaggedCount = nbrs.filter((n) => this.flagged[n]).length;
    if (flaggedCount !== this.adjacent[index]) {
      return this.fail(`Cell r${row}c${col} shows ${this.adjacent[index]} but has ${flaggedCount} flagged neighbours`);
    }
    const targets = nbrs.filter((n) => !this.revealed[n] && !this.flagged[n]);
    if (targets.length === 0) return this.fail(`Cell r${row}c${col} has no unknown neighbours to open`);
    const results = [];
    for (const t of targets) {
      if (this.isFinished) break;
      const r = this.reveal(this.rowOf(t), this.colOf(t));
      if (r.ok) results.push(r);
    }
    const changed = results.flatMap((r) => r.changed);
    const hitMine = results.some((r) => r.kind === 'mine');
    return {
      ok: true,
      kind: hitMine ? 'mine' : 'revealed',
      changed,
      cellsRevealed: changed.length,
      message: `Chord on r${row}c${col} opened ${targets.length} neighbour(s)${hitMine ? ', hit a mine' : ''}`,
    };
  }

  snapshot() {
    return {
      rows: this.rows,
      cols: this.cols,
      mines_total: this.minesTotal,
      mines_remaining: this.minesRemaining,
      lives_left: this.livesLeft,
      status: this.status,
      safe_cells_revealed: this.safeRevealed,
      safe_cells_total: this.safeTotal,
      progress_percent: Math.round(this.progress * 1000) / 10,
      unknown_cells: this.unknownCount,
    };
  }
}
