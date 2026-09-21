export function mountAmbientMines(root, intro) {
  const fields = [...root.children];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const wide = matchMedia('(min-width: 1280px)');
  let timer;
  let animations = [];
  let boards = [];

  function clear() {
    clearTimeout(timer);
    animations.forEach(animation => animation.cancel());
    animations = [];
    fields.forEach(field => field.replaceChildren());
  }

  function build() {
    boards = fields.map(field => {
      const cols = Math.ceil(field.clientWidth / 24);
      const rows = Math.ceil(field.clientHeight / 24);
      const phase = Math.random() * Math.PI * 2;
      const cells = [];
      const fragment = document.createDocumentFragment();
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const cell = document.createElement('span');
        cell.className = 'ambient-cell';
        cell.style.left = `${x * 24}px`;
        cell.style.top = `${y * 24}px`;
        const wave = (Math.sin(x * .48 + y * .32 + phase) + Math.cos(y * .55 - x * .21)) / 4 + .5;
        const tones = [.025, .04, .055, .075];
        const density = Math.min(1, Math.max(0, (1 - y / Math.max(1, rows - 1)) * 1.8));
        const opacity = Math.random() < density
          ? tones[Math.min(3, Math.floor(wave * 4))] : 0;
        cell.style.opacity = opacity;
        fragment.append(cell);
        cells.push({ cell, opacity, x, y });
      }
      field.append(fragment);
      return { cells, cols, rows };
    });
  }

  const ease = 'cubic-bezier(.23, 1, .32, 1)';
  const later = (fn, delay) => { timer = setTimeout(fn, delay); };
  function fade(tile, opacity, duration = 180, delay = 0) {
    animations.push(tile.cell.animate([
      { opacity: tile.current ?? tile.opacity }, { opacity },
    ], { duration, delay, easing: ease, fill: 'forwards' }));
    tile.current = opacity;
  }

  function startRound() {
    animations.forEach(animation => animation.cancel());
    animations = [];
    for (const board of boards) {
      for (const tile of board.cells) {
        tile.current = tile.opacity;
        tile.open = false;
        tile.mine = Math.random() < .17;
      }
    }
    let move = 0;
    function neighbors(board, tile) {
      return board.cells.filter(other => other !== tile &&
        Math.abs(other.x - tile.x) <= 1 && Math.abs(other.y - tile.y) <= 1);
    }
    function click() {
      const board = boards[move % boards.length];
      const candidates = board.cells.filter(tile => !tile.open && tile.opacity > 0 && !tile.mine &&
        tile.y < board.rows * .65 && tile.x > board.cols * .15 && tile.x < board.cols * .85);
      const empty = candidates.filter(tile => neighbors(board, tile).every(other => !other.mine));
      const options = empty.length ? empty : candidates;
      if (!options.length) { later(reset, 800); return; }
      const selected = options[Math.floor(Math.random() * options.length)];
      fade(selected, selected.opacity + .14, 120);
      later(() => {
        const queue = [{ tile: selected, depth: 0 }];
        const visited = new Set();
        while (queue.length && visited.size < 36) {
          const { tile, depth } = queue.shift();
          if (visited.has(tile) || tile.open || tile.mine || !tile.opacity) continue;
          visited.add(tile);
          tile.open = true;
          fade(tile, .008, 180, depth * 60);
          const adjacent = neighbors(board, tile);
          if (adjacent.every(other => !other.mine)) {
            adjacent.forEach(other => queue.push({ tile: other, depth: depth + 1 }));
          }
        }
        move++;
        later(move < 6 ? click : hit, 1200 + Math.random() * 700);
      }, 140);
    }
    function hit() {
      const board = boards[move % boards.length];
      const options = board.cells.filter(tile => !tile.open && tile.opacity > 0 && tile.y < board.rows * .6 &&
        tile.x > board.cols * .2 && tile.x < board.cols * .8);
      const tile = options[Math.floor(Math.random() * options.length)];
      if (tile) {
        tile.mine = true;
        animations.push(tile.cell.animate([
          { opacity: tile.opacity }, { opacity: .24, offset: .2 },
          { opacity: .04, offset: .45 }, { opacity: .18, offset: .7 },
          { opacity: tile.opacity },
        ], { duration: 1400, easing: ease }));
      }
      later(reset, 2000);
    }
    function reset() {
      boards.forEach(board => board.cells.filter(tile => tile.open)
        .forEach(tile => fade(tile, tile.opacity, 600)));
      later(startRound, 1800);
    }
    later(click, 1000);
  }

  function sync() {
    clear();
    if (intro.hidden || !wide.matches) return;
    build();
    if (!document.hidden && !reduce.matches) startRound();
  }
  new MutationObserver(sync).observe(intro, { attributes: true, attributeFilter: ['hidden'] });
  new ResizeObserver(sync).observe(root);
  document.addEventListener('visibilitychange', sync);
  reduce.addEventListener('change', sync);
  wide.addEventListener('change', sync);
  sync();
}
