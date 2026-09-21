import { STATUS } from './game.js';

const POP_LIMIT = 600;

export class BoardRenderer {
  constructor(container, game, { cellSize = 20, onExplode = null, onOutcome = null } = {}) {
    this.container = container;
    this.game = game;
    this.cellSize = cellSize;
    this.cells = [];
    this.highlighted = -1;
    this.unsubscribe = null;
    this.onExplode = onExplode;
    this.onOutcome = onOutcome;
    this.outcome = null;
    this.blasted = new Set();
  }

  mount() {
    this.destroy();
    const { rows, cols } = this.game;
    this.container.innerHTML = '';
    this.resize(this.cellSize);

    const fragment = document.createDocumentFragment();
    this.cells = new Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) {
      const cell = document.createElement('div');
      cell.dataset.i = String(i);
      this.cells[i] = cell;
      fragment.appendChild(cell);
    }
    this.container.appendChild(fragment);
    this.unsubscribe = this.game.onChange((changed) => this.update(changed));
    this.highlighted = this.game.lastActionIndex;
    this.outcome = null;
    this.syncOutcome();
    this.updateAll();
  }

  resize(cellSize) {
    this.cellSize = cellSize;
    const { cols } = this.game;
    this.container.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
    this.container.style.gridAutoRows = `${cellSize}px`;
    this.container.style.width = `${cols * cellSize + (cols - 1)}px`;
    this.container.style.fontSize = `${Math.max(1, cellSize * 0.62)}px`;
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  update(changed) {
    const animate = changed.length <= POP_LIMIT;
    for (const i of changed) {
      this.paint(i);
      if (animate && this.game.revealed[i]) this.pop(i);
    }
    for (const i of changed) {
      if (!this.game.exploded[i] || this.blasted.has(i)) continue;
      this.blasted.add(i);
      this.onExplode?.(this.cells[i]);
    }
    if (this.game.lastActionIndex >= 0) this.highlight(this.game.lastActionIndex);
    if (this.syncOutcome()) {
      this.updateAll();
      this.onOutcome?.(this.outcome);
    }
  }

  syncOutcome() {
    const outcome = this.game.status === STATUS.WON ? 'won'
      : this.game.status === STATUS.LOST ? 'lost' : null;
    if (outcome === this.outcome) return false;
    this.outcome = outcome;
    this.container.classList.toggle('board-won', outcome === 'won');
    this.container.classList.toggle('board-lost', outcome === 'lost');
    return Boolean(outcome);
  }

  pop(i) {
    const el = this.cells[i];
    el.classList.add('cell-pop');
    setTimeout(() => el.classList.remove('cell-pop'), 400);
  }

  updateAll() {
    for (let i = 0; i < this.cells.length; i++) this.paint(i);
  }

  highlight(index) {
    const previous = this.highlighted;
    this.highlighted = index;
    if (previous >= 0 && previous !== index) this.paint(previous);
    this.paint(index);
  }

  paint(i) {
    const game = this.game;
    const el = this.cells[i];
    let className = 'cell';
    let text = '';

    if (game.revealed[i]) {
      if (game.mine[i]) {
        className += game.exploded[i] ? ' cell-boom' : ' cell-mine';
        text = '✹';
      } else {
        const n = game.adjacent[i];
        if (n === 0) className += ' cell-empty';
        else {
          className += ` cell-revealed n${n}`;
          text = String(n);
        }
      }
    } else if (this.outcome === 'won' && game.mine[i]) {
      className += ' cell-found';
      text = '✹';
    } else if (game.flagged[i]) {
      const wrongFlag = game.isFinished && !game.mine[i];
      className += wrongFlag ? ' cell-wrong' : ' cell-unknown';
      text = wrongFlag ? '×' : '⚑';
    } else {
      className += ' cell-unknown';
    }

    if (i === this.highlighted) className += ' cell-last';
    if (el.className !== className) el.className = className;
    if (el.textContent !== text) el.textContent = text;
  }
}

export function fitCellSize({ width, height, rows, cols, min = 0, max = Infinity }) {
  const byWidth = (width - (cols - 1)) / cols;
  const byHeight = (height - (rows - 1)) / rows;
  return Math.max(min, Math.min(max, byWidth, byHeight));
}
