import { formatDuration, formatUsd } from './benchmark.js';

export const SERIES_COLORS = Object.freeze([
  '#70d5f5', '#adff63', '#d983f5', '#ff9864', '#ff7eb6',
  '#ffd93d', '#8aa0ff', '#5ee9b5', '#ff6f6f',
]);

const PAD = Object.freeze({ top: 14, right: 18, bottom: 32, left: 48 });
const GRID = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
const TIME_TICKS = 4;

const clamp01 = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function summaryRow({ label, status, progress, ms, costUsd, turns, moves }) {
  const safe = value => (Number.isFinite(value) && value > 0 ? value : 0);
  const made = safe(moves);
  return {
    label,
    status: status ?? '',
    revealed: clamp01(progress),
    ms: safe(ms),
    costUsd: safe(costUsd),
    turns: safe(turns),
    moves: made,
    msPerMove: made ? safe(ms) / made : null,
  };
}

export function summaryRows(rows) {
  return rows.map(summaryRow).sort((a, b) => b.revealed - a.revealed || a.ms - b.ms);
}

const SORT_DIRECTION = Object.freeze({
  label: 'asc', revealed: 'desc', ms: 'asc', costUsd: 'desc', turns: 'desc', moves: 'desc', msPerMove: 'asc',
});

export function defaultDirection(key) {
  return SORT_DIRECTION[key] ?? 'desc';
}

export function sortRows(rows, key, direction) {
  if (!(key in SORT_DIRECTION)) return [...rows];
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    if (typeof left === 'string') return sign * left.localeCompare(right, 'en', { numeric: true });
    return sign * (left - right);
  });
}

export function formatPercent(value) {
  const share = clamp01(value) * 100;
  if (share === 0 || share >= 10) return `${Math.round(share)}%`;
  return `${share.toFixed(1)}%`;
}

export function formatCost(value) {
  const amount = Number.isFinite(value) && value > 0 ? value : 0;
  if (amount === 0) return '$0.00';
  if (amount >= 1) return formatUsd(amount);
  return `$${Number(amount.toPrecision(3))}`;
}

export function formatPerMove(ms) {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)}s` : formatDuration(ms);
}

export function laneLabels(lanes) {
  const perKey = new Map();
  for (const lane of lanes) perKey.set(lane.key, (perKey.get(lane.key) ?? 0) + 1);
  const base = lanes.map(lane => (perKey.get(lane.key) > 1 && lane.effort ? `${lane.name} · ${lane.effort}` : lane.name));
  const totals = new Map();
  for (const label of base) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map();
  return base.map(label => {
    if (totals.get(label) === 1) return label;
    const nth = (seen.get(label) ?? 0) + 1;
    seen.set(label, nth);
    return `${label} #${nth}`;
  });
}

export function progressAt(points, ms) {
  let value = null;
  for (const point of points) {
    if (!Number.isFinite(point.ms) || point.ms > ms) break;
    value = point.progress;
  }
  return value;
}

export function chartScale(series, { width = 960, height = 380 } = {}) {
  const times = series.flatMap(one => one.points.map(point => point.ms)).filter(Number.isFinite);
  const maxMs = Math.max(1000, ...times);
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  return {
    maxMs, left: PAD.left, top: PAD.top, width: plotWidth, height: plotHeight,
    xOf: ms => PAD.left + clamp01(ms / maxMs) * plotWidth,
    yOf: progress => PAD.top + (1 - clamp01(progress)) * plotHeight,
    msAt: at => clamp01((at - PAD.left) / plotWidth) * maxMs,
  };
}

export function progressChart(series, { width = 960, height = 380 } = {}) {
  const scale = chartScale(series, { width, height });
  const { maxMs, xOf: x, yOf: y } = scale;
  const plotWidth = scale.width;
  const round = value => Math.round(value * 10) / 10;

  const grid = GRID.map(share => {
    const at = round(y(share));
    return `<line class="chart-grid" x1="${PAD.left}" y1="${at}" x2="${round(PAD.left + plotWidth)}" y2="${at}" />`
      + `<text class="chart-label chart-label-y" x="${PAD.left - 8}" y="${at}">${formatPercent(share)}</text>`;
  }).join('');

  const ticks = Array.from({ length: TIME_TICKS + 1 }, (_, index) => {
    const ms = (maxMs / TIME_TICKS) * index;
    return `<text class="chart-label chart-label-x" x="${round(x(ms))}" y="${height - 10}">${formatDuration(ms)}</text>`;
  }).join('');

  const lines = series.map((one, index) => {
    const points = one.points.filter(point => Number.isFinite(point.ms));
    if (!points.length) return '';
    const path = points.map(point => `${round(x(point.ms))},${round(y(point.progress))}`).join(' ');
    const colour = one.color ?? SERIES_COLORS[index % SERIES_COLORS.length];
    const last = points.at(-1);
    return `<polyline class="chart-line" points="${path}" stroke="${colour}" />`
      + `<circle class="chart-end" cx="${round(x(last.ms))}" cy="${round(y(last.progress))}" r="3" fill="${colour}" />`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img"`
    + ` aria-label="Share of the board revealed over time, one line per model">${grid}${ticks}${lines}</svg>`;
}
