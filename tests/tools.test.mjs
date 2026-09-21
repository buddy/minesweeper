import test from 'node:test';
import assert from 'node:assert/strict';
import { Minesweeper } from '../js/game.js';
import { createToolset } from '../js/tools.js';

test('frontier subtracts revealed exploded mines as well as flags from clue counts', () => {
  const game = new Minesweeper({ rows: 5, cols: 5, mines: 2, lives: 3, seed: 'exploded-clue' });
  game.mine[game.index(1, 1)] = 1;
  game.mine[game.index(1, 3)] = 1;
  for (let i = 0; i < game.size; i++) game.adjacent[i] = game.neighbors(i).reduce((sum, n) => sum + game.mine[n], 0);
  game.minesPlaced = true;
  game.reveal(2, 2);
  game.setFlag(1, 3, true);
  const tools = createToolset(game);
  const before = tools.frontier().candidates.find(c => c.cell === 'r2c1').constraints.find(c => c.from === 'r2c2');
  assert.equal(before.mines_still_needed, 1, 'A hidden mine is not used to reduce the count');
  game.reveal(1, 1);
  const frontier = tools.frontier();
  const clue = frontier.candidates.find(c => c.cell === 'r2c1').constraints.find(c => c.from === 'r2c2');
  assert.equal(clue.number, 2);
  assert.equal(clue.flagged_neighbors, 1);
  assert.equal(clue.exploded_neighbors, 1);
  assert.equal(clue.unknown_neighbors, 6);
  assert.equal(clue.mines_still_needed, 0);
  assert.equal(clue.local_mine_ratio, 0);
  assert.equal(frontier.mines_remaining, 0);
  assert.ok(frontier.candidates.every(c => c.cell !== 'r1c1' && c.cell !== 'r1c3'));
});
