import test from 'node:test';
import assert from 'node:assert/strict';
import { SERIES_COLORS, chartScale, defaultDirection, formatCost, formatPercent, formatPerMove, laneLabels, progressAt, progressChart, sortRows, summaryRow, summaryRows } from '../js/results.js';

const points = (...pairs) => pairs.map(([ms, progress]) => ({ ms, progress }));

test('a lane that never moved reports no average rather than an instant one', () => {
  const row = summaryRow({ label: 'Haiku', progress: 0.11, ms: 12_000, costUsd: 0.04, turns: 3, moves: 0 });
  assert.equal(row.msPerMove, null);
  assert.equal(formatPerMove(row.msPerMove), '—');
  assert.equal(summaryRow({ label: 'Jev', ms: 8000, moves: 4 }).msPerMove, 2000);
});

test('a summary survives the figures a stopped or errored lane leaves behind', () => {
  for (const broken of [undefined, null, NaN, -1, Infinity]) {
    const row = summaryRow({ label: 'x', progress: broken, ms: broken, costUsd: broken, turns: broken, moves: broken });
    for (const [field, value] of Object.entries(row)) {
      if (field === 'label' || field === 'status' || field === 'msPerMove') continue;
      assert.ok(Number.isFinite(value) && value >= 0, `${field} is ${value} for ${String(broken)}`);
    }
    assert.equal(row.msPerMove, null);
  }
});

test('the table leads with the model that got furthest, ties broken by who got there first', () => {
  const rows = summaryRows([
    { label: 'slow winner', progress: 1, ms: 400_000, moves: 1 },
    { label: 'half', progress: 0.5, ms: 10_000, moves: 1 },
    { label: 'fast winner', progress: 1, ms: 120_000, moves: 1 },
  ]);
  assert.deepEqual(rows.map(row => row.label), ['fast winner', 'slow winner', 'half']);
});

test('a share reads coarsely once it is worth rounding and finely while it is not', () => {
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0.625), '63%');
  assert.equal(formatPercent(0.034), '3.4%', 'an early lane would otherwise read as a flat 3%');
  for (const broken of [NaN, undefined, -1, Infinity]) assert.equal(formatPercent(broken), '0%');
  assert.equal(formatPercent(2), '100%', 'progress never reads past the whole board');
});

test('time per move stays in seconds until seconds stop being readable', () => {
  assert.equal(formatPerMove(1020), '1.02s');
  assert.equal(formatPerMove(9999), '10.00s');
  assert.equal(formatPerMove(65_000), '1:05');
  for (const broken of [null, 0, -1, NaN, Infinity]) assert.equal(formatPerMove(broken), '—');
});

test('every series is drawn against one shared scale so the lines can be compared', () => {
  const svg = progressChart([
    { label: 'a', points: points([0, 0], [60_000, 1]) },
    { label: 'b', points: points([0, 0], [30_000, 0.5]) },
  ], { width: 1000, height: 400 });
  const lines = [...svg.matchAll(/<polyline[^>]*points="([^"]+)"/g)].map(match => match[1]);
  assert.equal(lines.length, 2);
  const [a, b] = lines.map(line => line.split(' ').map(pair => pair.split(',').map(Number)));
  assert.deepEqual(a[0], b[0], 'both start at the same origin');
  assert.equal(b[1][0], a[1][0] / 2 + a[0][0] / 2, 'half the time lands half way across');
  assert.ok(a[1][1] < b[1][1], 'more revealed sits higher up');
});

test('a chart still renders its axes when a run produced nothing to draw', () => {
  for (const series of [[], [{ label: 'dead', points: [] }]]) {
    const svg = progressChart(series);
    assert.match(svg, /^<svg /);
    assert.equal(svg.includes('<polyline'), false);
    assert.equal([...svg.matchAll(/chart-label-y/g)].length, 5, 'the percentage axis is still readable');
  }
});

test('an unfinished lane stops its line where it died rather than dropping to zero', () => {
  const svg = progressChart([{ label: 'died', points: points([0, 0], [5000, 0.2]) }]);
  const [, drawn] = svg.match(/<polyline[^>]*points="([^"]+)"/);
  assert.equal(drawn.split(' ').length, 2);
  assert.match(svg, /<circle class="chart-end"/, 'the last point is marked so a short line is still visible');
});

test('nine lanes each get a colour of their own', () => {
  assert.equal(new Set(SERIES_COLORS).size, 9);
  const svg = progressChart(Array.from({ length: 9 }, (_, i) => ({ label: `m${i}`, points: points([0, 0], [1000, 0.5]) })));
  const strokes = [...svg.matchAll(/<polyline[^>]*stroke="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(strokes).size, 9);
});

test('the standings keep enough of a cost to tell two close lanes apart', () => {
  assert.notEqual(formatCost(0.0231), formatCost(0.019), 'cents alone would print both as $0.02');
  assert.equal(formatCost(0.0231), '$0.0231');
  assert.equal(formatCost(0.019), '$0.019');
  assert.equal(formatCost(0.412), '$0.412');
  assert.equal(formatCost(0.00081), '$0.00081');
  assert.equal(formatCost(1.2345), '$1.23', 'past a dollar the cents are the interesting part again');
  assert.equal(formatCost(1234.5), '$1,235');
  for (const broken of [0, -1, NaN, undefined, Infinity]) assert.equal(formatCost(broken), '$0.00');
});

test('the same model run many times still gets a name per lane', () => {
  const jev = { key: 'jev', name: 'Jev' };
  assert.deepEqual(laneLabels([jev, jev, jev]), ['Jev #1', 'Jev #2', 'Jev #3']);
  assert.deepEqual(laneLabels([jev]), ['Jev'], 'a lane on its own is never numbered');
});

test('effort separates two lanes of one model before a number has to', () => {
  const astra = { key: 'astra', name: 'Astra' };
  assert.deepEqual(laneLabels([{ ...astra, effort: 'low' }, { ...astra, effort: 'high' }]),
    ['Astra · low', 'Astra · high']);
  assert.deepEqual(laneLabels([{ ...astra, effort: 'low' }, { ...astra, effort: 'low' }]),
    ['Astra · low #1', 'Astra · low #2'], 'the same effort twice still needs telling apart');
  assert.deepEqual(laneLabels([{ ...astra, effort: 'low' }, { key: 'jev', name: 'Jev' }]),
    ['Astra', 'Jev'], 'one lane each leaves the effort off, as it did before');
});

test('a reading is taken from the last turn that had happened by then', () => {
  const walk = points([0, 0], [1000, 0.25], [5000, 0.9]);
  assert.equal(progressAt(walk, 0), 0);
  assert.equal(progressAt(walk, 999), 0, 'a turn in flight has not moved the board yet');
  assert.equal(progressAt(walk, 1000), 0.25);
  assert.equal(progressAt(walk, 4999), 0.25);
  assert.equal(progressAt(walk, 60_000), 0.9, 'a lane that ended holds where it ended');
  assert.equal(progressAt([], 10), null, 'a lane with no turns has nothing to report');
});

test('a point on the chart and the time under the cursor are the same scale read both ways', () => {
  const scale = chartScale([{ label: 'a', points: points([0, 0], [120_000, 1]) }], { width: 1000, height: 400 });
  assert.equal(scale.maxMs, 120_000);
  for (const ms of [0, 30_000, 120_000]) {
    assert.ok(Math.abs(scale.msAt(scale.xOf(ms)) - ms) < 1, `${ms} ms does not survive the round trip`);
  }
  assert.equal(scale.msAt(scale.left - 50), 0, 'a cursor left of the plot reads as the start');
  assert.equal(scale.msAt(scale.left + scale.width + 50), 120_000, 'and right of it as the end');
});

const standings = summaryRows([
  { label: 'Jev #2', progress: 0.5, ms: 10_000, costUsd: 0.90, turns: 9, moves: 30 },
  { label: 'Jev #10', progress: 1, ms: 60_000, costUsd: 0.10, turns: 40, moves: 4 },
  { label: 'Astra', progress: 1, ms: 20_000, costUsd: 0.50, turns: 20, moves: 0 },
]);

test('a header sorts the column its own way round before the click reverses it', () => {
  assert.equal(defaultDirection('label'), 'asc', 'names read A to Z first');
  for (const key of ['revealed', 'turns', 'moves', 'costUsd']) {
    assert.equal(defaultDirection(key), 'desc', `${key} leads with the largest`);
  }
  for (const key of ['ms', 'msPerMove']) {
    assert.equal(defaultDirection(key), 'asc', `${key} leads with the fastest`);
  }
});

test('sorting a column reverses cleanly and leaves the rows themselves alone', () => {
  const down = sortRows(standings, 'costUsd', 'desc').map(row => row.label);
  const up = sortRows(standings, 'costUsd', 'asc').map(row => row.label);
  assert.deepEqual(down, ['Jev #2', 'Astra', 'Jev #10']);
  assert.deepEqual(up, [...down].reverse());
  assert.equal(standings[0].label, 'Astra', 'the default order is not mutated by a sort');
});

test('names sort by their number rather than by the digits as text', () => {
  assert.deepEqual(sortRows(standings, 'label', 'asc').map(row => row.label), ['Astra', 'Jev #2', 'Jev #10'],
    'plain text ordering would put #10 before #2');
});

test('a lane with no average sinks to the bottom whichever way the column is sorted', () => {
  for (const dir of ['asc', 'desc']) {
    assert.equal(sortRows(standings, 'msPerMove', dir).at(-1).label, 'Astra', `sorted ${dir}`);
  }
});

test('ties keep the ranking the table opened with', () => {
  const byRevealed = sortRows(standings, 'revealed', 'desc').map(row => row.label);
  assert.deepEqual(byRevealed, ['Astra', 'Jev #10', 'Jev #2'], 'both winners stay in default order');
});

test('an unknown column leaves the order untouched rather than scrambling it', () => {
  assert.deepEqual(sortRows(standings, 'nope', 'asc'), standings);
});
