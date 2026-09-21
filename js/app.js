import { Minesweeper, BOARD_LIMITS, boardFor, mineBounds } from './game.js';
import { BoardRenderer, fitCellSize } from './renderer.js';
import { createToolset } from './tools.js';
import { MODELS, MAX_MODELS, PRICING, createAgent, defaultEffort, estimateCostUsd } from './models.js';
import { AgentRunner, PauseGate, maxDecisions, formatDuration, formatRate, formatUsd, ratePerMinute } from './benchmark.js';
import { SERIES_COLORS, chartScale, defaultDirection, formatCost, formatPercent, formatPerMove, laneLabels, progressAt, progressChart, sortRows, summaryRows } from './results.js';
import { randomSeed } from './rng.js';
import { AnimatedCounter } from './animated-counter.js';
import { sleep } from './http.js';
import { mountAmbientMines } from './ambient-mines.js';
import { confettiBurst, mineBlast } from './effects.js';

const $ = (id) => document.getElementById(id);
mountAmbientMines(document.querySelector('.ambient-mines'), $('intro'));
const DEFAULT_PICK = ['jev', 'fable', 'astra', 'grok46'];

const state = {
  seed: '',
  board: { rows: BOARD_LIMITS.maxRows, cols: BOARD_LIMITS.maxCols, mines: undefined },
  picks: DEFAULT_PICK.map(key => ({ key, effort: defaultEffort(key) })),
  lanes: [],
  abort: null,
  uiStatus: 'idle',
  series: [],
  chart: null,
  standings: [],
  sort: { key: 'revealed', dir: 'desc' },
  view: 'intro',
  task: null,
  startedAt: null,
  endedAt: null,
  pause: new PauseGate(),
  pausedAt: null,
  pausedMs: 0,
};


wireControls();
newSession();
updateControls();
setInterval(updateStats, 200);
const boardObserver = new ResizeObserver(resizeLanes);
const chartObserver = new ResizeObserver(() => drawChart());
boardObserver.observe($('workspace'));
chartObserver.observe($('results-plot'));


function boardConfig() {
  return boardFor(state.board.rows, state.board.cols, state.board.mines);
}

function sessionMs() {
  if (state.startedAt === null) return 0;
  const now = state.endedAt ?? state.pausedAt ?? performance.now();
  return Math.max(0, now - state.startedAt - state.pausedMs);
}

function newSession() {
  if (state.abort) return;
  state.seed = randomSeed();
  state.startedAt = null;
  state.endedAt = null;
  state.pausedAt = null;
  state.pausedMs = 0;
  state.series = [];
  state.chart = null;
  state.standings = [];
  buildLanes();
}

function buildLanes() {
  const config = { ...boardConfig(), seed: state.seed };
  state.board = { rows: config.rows, cols: config.cols, mines: config.mines };
  mountLanes(state.picks.map(({ key, effort }) => {
    const game = new Minesweeper(config);
    const openingIndex = Math.floor(game.rng() * game.size);
    game.placeMines(openingIndex);
    const model = effort === undefined ? MODELS[key] : { ...MODELS[key], effort };
    return { key, effort, model, game, toolset: createToolset(game), openingIndex };
  }));
  state.uiStatus = 'idle';
  $('run-error').hidden = true;
  $('intro-error').hidden = true;
  updateCard();
  updateControls();
}

function mountLanes(lanes) {
  for (const lane of state.lanes) {
    lane.renderer?.destroy();
    lane.panel?.remove();
  }
  for (const moved of $('session-panel').querySelectorAll('.lane-head, .lane-stats')) moved.remove();
  state.lanes = lanes.map(lane => ({ runner: null, endedAt: null, status: null, samples: [], ...lane }));
  const template = $('lane-template');
  const labels = laneLabels(state.lanes.map(lane => ({ key: lane.key, name: lane.model.name, effort: lane.effort })));
  for (const [index, lane] of state.lanes.entries()) {
    const panel = template.content.firstElementChild.cloneNode(true);
    panel.dataset.provider = lane.model.provider ?? 'typesafe';
    lane.label = labels[index];
    panel.setAttribute('aria-label', `${lane.label} board`);
    panel.querySelector('.lane-name').textContent = lane.label;
    $('workspace').insertBefore(panel, $('session-panel'));
    renderLogo(panel.querySelector('.lane-logo'), providerMark(lane.model), lane.model.company);
    lane.panel = panel;
    lane.boardEl = panel.querySelector('.lane-board');
    lane.stageEl = panel.querySelector('.lane-stage');
    lane.statusEl = panel.querySelector('.lane-status');
    lane.log = [];
    lane.logEl = panel.querySelector('.lane-log');
    lane.logToggle = panel.querySelector('.lane-log-toggle');
    lane.logToggle.addEventListener('click', () => toggleLog(lane));
    lane.logFollowing = true;
    lane.logEl.addEventListener('scroll', () => {
      lane.logFollowing = lane.logEl.scrollTop + lane.logEl.clientHeight >= lane.logEl.scrollHeight - 24;
    }, { passive: true });
    renderLog(lane);
    lane.counters = {
      turns: new AnimatedCounter(panel.querySelector('.stat-turns')),
      moves: new AnimatedCounter(panel.querySelector('.stat-moves')),
      time: new AnimatedCounter(panel.querySelector('.stat-time'), { format: formatDuration }),
      cost: new AnimatedCounter(panel.querySelector('.stat-cost'), { format: formatUsd }),
    };
    const rateSlot = name => {
      const element = panel.querySelector(`.stat-${name}-rate`);
      return { element, counter: new AnimatedCounter(element.querySelector('.rate-value'), { format: formatRate }) };
    };
    lane.rates = { turns: rateSlot('turns'), moves: rateSlot('moves') };
  }
  $('session-panel').hidden = state.lanes.length !== 1;
  if (state.lanes.length === 1) {
    const [lane] = state.lanes;
    const panel = $('session-panel');
    const head = lane.panel.querySelector('.lane-head');
    panel.prepend(head);
    head.after(lane.panel.querySelector('.lane-stats'));
  }
  $('workspace').dataset.lanes = String(state.lanes.length);
  if (state.view === 'stage') mountRenderers();
}

const LOG_LIMIT = 20_000;

function pushLog(lane, level, text) {
  const entry = { level, text };
  lane.log.push(entry);
  if (lane.log.length > LOG_LIMIT) {
    lane.log.splice(0, lane.log.length - LOG_LIMIT);
    if (!lane.logEl.hidden) renderLog(lane);
    return;
  }
  if (!lane.logEl.hidden) {
    if (lane.log.length === 1) renderLog(lane);
    else appendLogLine(lane, entry);
  }
}

function logLine(entry) {
  const line = document.createElement('p');
  line.className = `log-${entry.level}`;
  line.textContent = entry.text;
  return line;
}

function appendLogLine(lane, entry) {
  lane.logEl.appendChild(logLine(entry));
  if (lane.logScrollQueued || lane.logFollowing === false) return;
  lane.logScrollQueued = true;
  requestAnimationFrame(() => {
    lane.logScrollQueued = false;
    lane.logEl.scrollTop = lane.logEl.scrollHeight;
  });
}

function toggleLog(lane) {
  lane.logEl.hidden = !lane.logEl.hidden;
  lane.logToggle.setAttribute('aria-pressed', String(!lane.logEl.hidden));
  if (!lane.logEl.hidden) renderLog(lane);
}

function renderLog(lane) {
  const following = lane.logFollowing !== false;
  const lines = lane.log.length
    ? lane.log.map(logLine)
    : [Object.assign(document.createElement('p'), { className: 'log-empty', textContent: 'Nothing yet.' })];
  lane.logEl.replaceChildren(...lines);
  if (following) lane.logEl.scrollTop = lane.logEl.scrollHeight;
}

function laneCellSize() {
  const lane = state.lanes[0];
  if (!lane) return 0;
  const { width, height } = lane.stageEl.getBoundingClientRect();
  const frame = getComputedStyle(lane.boardEl.parentElement);
  const chrome = side => parseFloat(frame[`padding${side}`]) + parseFloat(frame[`border${side}Width`]);
  return fitCellSize({
    width: Math.max(0, width - chrome('Left') - chrome('Right') - 1),
    height: Math.max(0, height - chrome('Top') - chrome('Bottom') - 1),
    rows: lane.game.rows,
    cols: lane.game.cols,
  });
}

function mountRenderers() {
  const cellSize = laneCellSize();
  for (const lane of state.lanes) {
    lane.renderer?.destroy();
    lane.renderer = new BoardRenderer(lane.boardEl, lane.game, {
      cellSize,
      onExplode: cellEl => mineBlast(lane.boardEl, cellEl),
      onOutcome: outcome => { if (outcome === 'won') confettiBurst(lane.stageEl); },
    });
    lane.renderer.mount();
  }
}

function resizeLanes() {
  if (state.view !== 'stage' || !state.lanes.length) return;
  const cellSize = laneCellSize();
  for (const lane of state.lanes) lane.renderer?.resize(cellSize);
}


function sample(lane) {
  const ms = lane.endedAt ?? sessionMs();
  const previous = lane.samples.at(-1);
  if (previous && previous.ms === ms && previous.progress === lane.game.progress) return;
  lane.samples.push({ ms, progress: lane.game.progress });
}

function createRunner(lane) {
  return new AgentRunner({
    agent: createAgent(lane.key, lane.effort),
    toolset: lane.toolset,
    delayMs: 250,
    maxSteps: maxDecisions(lane.game.rows, lane.game.cols),
    pause: state.pause,
    onStep: () => {
      sample(lane);
      updateStats();
    },
    onLog: (entry) => {
      pushLog(lane, entry.level, entry.text);
      if (entry.level === 'error') showRunError(`${lane.label}: ${entry.text}`);
    },
  });
}

function showStage() {
  state.view = 'stage';
  $('intro').hidden = true;
  $('results').hidden = true;
  $('workspace').hidden = false;
  $('controls-dialog').close();
  document.activeElement?.blur();
  mountRenderers();
  updateControls();
}

async function countdown(signal, label) {
  $('countdown-label').textContent = label;
  $('countdown').hidden = false;
  state.uiStatus = 'countdown';
  updateCard();
  try {
    const deadline = performance.now() + 3000;
    for (let remaining = 3; remaining > 0; remaining--) {
      $('countdown-number').textContent = String(remaining);
      await sleep(Math.max(0, deadline - performance.now() - (remaining - 1) * 1000), signal);
    }
  } finally {
    $('countdown').hidden = true;
  }
}

function startRun() {
  if (state.abort) return;
  state.task = runSession();
}

async function runLane(lane, signal) {
  try {
    await lane.runner.run(signal);
    lane.status = lane.runner.stopReason ?? 'stopped';
  } catch (error) {
    if (error?.name === 'AbortError') {
      lane.status = 'stopped';
    } else {
      lane.status = 'error';
      showRunError(`${lane.label}: ${error.message}`);
    }
  }
  lane.endedAt = sessionMs();
  updateStats();
}

async function runSession() {
  newSession();
  showStage();
  state.abort = new AbortController();
  const signal = state.abort.signal;
  updateControls();
  try {
    await countdown(signal, 'Run starts in');
    if (signal.aborted) return;
    state.startedAt = performance.now();
    for (const lane of state.lanes) {
      lane.game.reveal(lane.game.rowOf(lane.openingIndex), lane.game.colOf(lane.openingIndex));
      lane.runner = createRunner(lane);
      sample(lane);
    }
    state.uiStatus = 'running';
    updateCard();
    await Promise.all(state.lanes.map(lane => runLane(lane, signal)));
  } catch (error) {
    if (error?.name !== 'AbortError') showRunError(error.message);
  } finally {
    state.endedAt = performance.now();
    state.uiStatus = summarizeStatuses();
    state.abort = null;
    updateCard();
    updateControls();
    if (!signal.aborted) showResults();
    if (state.uiStatus === 'error') openControls();
  }
}

function summarizeStatuses() {
  const statuses = state.lanes.map(lane => lane.status).filter(Boolean);
  if (!statuses.length) return 'stopped';
  if (statuses.includes('error')) return 'error';
  return [...new Set(statuses)].join(' · ');
}

function stopRun() {
  if (state.pausedAt !== null) togglePause();
  state.abort?.abort();
}

function togglePause() {
  if (!state.abort || state.uiStatus === 'countdown') return;
  if (state.pause.toggle()) {
    state.pausedAt = performance.now();
    state.uiStatus = 'paused';
  } else {
    state.pausedMs += performance.now() - state.pausedAt;
    state.pausedAt = null;
    state.uiStatus = 'running';
  }
  updateCard();
}

async function returnToIntro() {
  stopRun();
  await state.task;
  $('controls-dialog').close();
  state.view = 'intro';
  $('workspace').hidden = true;
  $('results').hidden = true;
  $('intro').hidden = false;
  updateControls();
  $('btn-start-run').focus({ preventScroll: true });
}

function drawChart() {
  const plot = $('results-plot');
  if (!state.series.length || !plot.clientWidth) return;
  state.chart = { width: plot.clientWidth, height: plot.clientHeight };
  $('chart-svg').innerHTML = progressChart(state.series, state.chart);
  hideChartReading();
}

function hideChartReading() {
  $('chart-guide').hidden = true;
  $('chart-tooltip').hidden = true;
}

function readChart(event) {
  if (!state.series.length || !state.chart) return;
  const plot = $('results-plot');
  const scale = chartScale(state.series, state.chart);
  const at = event.clientX - plot.getBoundingClientRect().left;
  if (at < scale.left - 8 || at > scale.left + scale.width + 8) return hideChartReading();
  const ms = scale.msAt(at);

  const readings = state.series
    .map(one => ({ label: one.label, color: one.color, progress: progressAt(one.points, ms) }))
    .filter(reading => reading.progress !== null)
    .sort((a, b) => b.progress - a.progress);
  if (!readings.length) return hideChartReading();

  const guide = $('chart-guide');
  guide.hidden = false;
  guide.style.left = `${scale.xOf(ms)}px`;
  guide.style.top = `${scale.top}px`;
  guide.style.height = `${scale.height}px`;

  const tip = $('chart-tooltip');
  tip.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'chart-tooltip-time', textContent: formatDuration(ms),
  }), ...readings.map(reading => {
    const row = document.createElement('p');
    row.innerHTML = '<span class="legend-swatch"></span>';
    row.firstChild.style.background = reading.color;
    row.append(reading.label, Object.assign(document.createElement('b'), { textContent: formatPercent(reading.progress) }));
    return row;
  }));
  tip.hidden = false;
  const flip = scale.xOf(ms) > scale.left + scale.width / 2;
  tip.classList.toggle('chart-tooltip-left', flip);
  tip.style.left = `${scale.xOf(ms) + (flip ? -12 : 12)}px`;
}

function renderStandings() {
  const { key, dir } = state.sort;
  for (const header of $('results').querySelectorAll('thead th')) {
    const sorted = header.querySelector('.results-sort').dataset.sort === key;
    header.setAttribute('aria-sort', sorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  $('results-rows').replaceChildren(...sortRows(state.standings, key, dir).map(row => {
    const tr = document.createElement('tr');
    const cells = [row.label, formatPercent(row.revealed), formatDuration(row.ms), formatCost(row.costUsd),
      String(row.turns), String(row.moves), formatPerMove(row.msPerMove)];
    tr.append(...cells.map((text, index) => {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      if (index === 0) cell.scope = 'row';
      cell.textContent = text;
      return cell;
    }));
    if (row.revealed === 1) tr.className = 'results-row-won';
    return tr;
  }));
}

function sortStandings(event) {
  const button = event.target.closest('.results-sort');
  if (!button || !state.standings.length) return;
  const { sort: key } = button.dataset;
  state.sort = key === state.sort.key
    ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: defaultDirection(key) };
  renderStandings();
}

function showResults() {
  state.view = 'results';
  const colours = new Map(state.lanes.map((lane, index) => [lane, SERIES_COLORS[index % SERIES_COLORS.length]]));
  state.series = state.lanes.map(lane => ({ label: lane.label, color: colours.get(lane), points: lane.samples }));
  $('results-legend').replaceChildren(...state.lanes.map(lane => {
    const item = document.createElement('li');
    item.innerHTML = '<span class="legend-swatch"></span>';
    item.firstChild.style.background = colours.get(lane);
    item.append(lane.label);
    return item;
  }));
  const { rows, cols, mines } = state.board;
  $('results-board').textContent = `${rows} x ${cols}, ${mines} mines`;

  state.standings = summaryRows(state.lanes.map(lane => ({
    label: lane.label,
    status: lane.status,
    progress: lane.game.progress,
    ms: lane.endedAt ?? sessionMs(),
    costUsd: estimateCostUsd(lane.key, lane.runner?.stats.usage),
    turns: lane.runner?.stats.steps,
    moves: lane.runner?.stats.moves,
  })));
  state.sort = { key: 'revealed', dir: 'desc' };
  renderStandings();

  $('workspace').hidden = true;
  $('results').hidden = false;
  drawChart();
  updateControls();
  $('btn-results-back').focus({ preventScroll: true });
}


function wireControls() {
  const closeModelPickers = event => {
    for (const menu of document.querySelectorAll('.add-menu:popover-open')) {
      if (event.type === 'scroll' && menu.contains(event.target)) continue;
      const hadFocus = menu.contains(document.activeElement);
      menu.hidePopover();
      if (hadFocus) document.querySelector(`[popovertarget="${menu.id}"]`)?.focus({ preventScroll: true });
    }
  };
  window.addEventListener('resize', closeModelPickers);
  document.addEventListener('scroll', closeModelPickers, true);
  $('btn-start').addEventListener('click', startRun);
  $('btn-stop').addEventListener('click', stopRun);
  $('btn-controls').addEventListener('click', openControls);
  $('btn-home').addEventListener('click', returnToIntro);
  $('btn-results-back').addEventListener('click', returnToIntro);
  $('btn-show-boards').addEventListener('click', showStage);
  $('btn-show-results').addEventListener('click', showResults);
  $('results-plot').addEventListener('pointermove', readChart);
  $('results-plot').addEventListener('pointerleave', hideChartReading);
  $('results').querySelector('thead').addEventListener('click', sortStandings);
  $('controls-dialog').addEventListener('close', () => $('btn-controls').blur());
  $('btn-start-run').addEventListener('click', startRun);
  buildAddMenu();
  wireBoardPicker();
  document.addEventListener('keydown', event => {
    if (state.view !== 'stage') return;
    if ($('controls-dialog').open || event.target.closest('input, select, textarea') || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.key === ' ' && event.target.closest('button')) return;
    switch (event.key.toLowerCase()) {
      case ' ':
        event.preventDefault();
        if (state.abort) togglePause();
        else startRun();
        break;
      case 'escape':
        event.preventDefault();
        returnToIntro();
        break;
      case 'n':
        newSession();
        break;
      case ',':
        event.preventDefault();
        openControls();
        break;
      default:
    }
  });
}

function wireBoardPicker() {
  $('board-mines').addEventListener('change', () => { state.board.mines = $('board-mines').value; newSession(); });
  for (const [id, key] of [['board-rows', 'rows'], ['board-cols', 'cols']]) {
    $(id).addEventListener('change', () => {
      const before = state.board.rows * state.board.cols;
      state.board[key] = $(id).value;
      const { rows, cols } = boardFor(state.board.rows, state.board.cols);
      state.board.mines = Math.round(state.board.mines * rows * cols / before);
      newSession();
    });
  }
}

function renderBoardPicker() {
  const { rows, cols, mines } = boardConfig();
  const bounds = mineBounds(rows, cols);
  const busy = Boolean(state.abort);
  for (const [id, value] of [['board-rows', rows], ['board-cols', cols], ['board-mines', mines]]) {
    if ($(id).value !== String(value)) $(id).value = String(value);
    $(id).disabled = busy;
  }
  $('board-mines').min = String(bounds.min);
  $('board-mines').max = String(bounds.max);
}

function renderModelRows() {
  const container = $('model-rows');
  const template = $('model-row-template');
  const busy = Boolean(state.abort);
  container.replaceChildren();
  state.picks.forEach((pick, index) => {
    const model = MODELS[pick.key];
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.provider = model.provider ?? 'typesafe';
    const select = row.querySelector('.model-select');
    select.disabled = busy;
    select.setAttribute('aria-label', `Model: ${model.company} / ${model.name}`);
    mountModelPicker(row, select, pick.key, index);

    renderLogo(row.querySelector('.model-logo'), providerMark(model), model.company);
    row.querySelector('.model-name').textContent = `${model.company} / ${model.name}`;
    const price = PRICING[pick.key];
    row.querySelector('.model-price').textContent = price.output ? `$${price.input} / $${price.output}` : `$${price.input} / free`;

    const effort = row.querySelector('.model-effort');
    const effortLabel = level => ({ xhigh: 'Extra high', none: 'No reasoning' })[level]
      ?? level[0].toUpperCase() + level.slice(1);
    effort.textContent = model.efforts.length ? effortLabel(pick.effort) : '\u2014';
    effort.setAttribute('aria-label', `Reasoning effort: ${model.efforts.length ? effortLabel(pick.effort) : 'Not available'}`);
    effort.disabled = busy || model.efforts.length === 0;
    if (model.efforts.length) mountEffortPicker(row, effort, model.efforts, pick.effort, index, effortLabel);


    const remove = row.querySelector('.model-remove');
    remove.disabled = busy || state.picks.length <= 1;
    remove.addEventListener('click', () => { state.picks.splice(index, 1); buildLanes(); });
    container.appendChild(row);
  });
  $('btn-add-model').disabled = busy || state.picks.length >= MAX_MODELS;
  $('selection-hint').textContent = `${state.picks.length} / ${MAX_MODELS} models selected`;
  $('btn-start-run').disabled = busy || state.picks.length === 0;
}

function mountModelPicker(row, trigger, selectedKey, rowIndex) {
  const menu = document.createElement('div');
  menu.id = `model-picker-${rowIndex}`;
  menu.className = 'add-menu model-picker-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Choose model');
  trigger.setAttribute('popovertarget', menu.id);
  trigger.setAttribute('aria-controls', menu.id);
  let company;
  const items = [];
  for (const model of Object.values(MODELS)) {
    if (company !== model.company) {
      company = model.company;
      const heading = document.createElement('div');
      heading.className = 'add-menu-group';
      heading.textContent = company;
      heading.setAttribute('role', 'presentation');
      menu.appendChild(heading);
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'add-menu-item model-picker-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(model.key === selectedKey));
    item.tabIndex = -1;
    const label = document.createElement('strong');
    label.textContent = model.name;
    const price = PRICING[model.key];
    const tag = document.createElement('span');
    tag.textContent = price.output ? `$${price.input} / $${price.output}` : `$${price.input} / free`;
    item.append(label, tag);
    item.addEventListener('click', () => {
      menu.hidePopover();
      if (model.key !== selectedKey) {
        state.picks[rowIndex] = { key: model.key, effort: defaultEffort(model.key) };
        buildLanes();
      }
      $('model-rows').children[rowIndex]?.querySelector('.model-select').focus({ preventScroll: true });
    });
    items.push(item);
    menu.appendChild(item);
  }
  row.querySelector('.model-choice').appendChild(menu);
  wirePickerMenu(menu, trigger, items, 352);
}

function mountEffortPicker(row, trigger, levels, selected, rowIndex, labelFor) {
  const menu = document.createElement('div');
  menu.id = `effort-picker-${rowIndex}`;
  menu.className = 'add-menu effort-picker-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Reasoning effort');
  const items = levels.map(level => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'add-menu-item model-picker-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(level === selected));
    item.tabIndex = -1;
    const label = document.createElement('strong');
    label.textContent = labelFor(level);
    item.appendChild(label);
    item.addEventListener('click', () => {
      menu.hidePopover();
      if (level !== selected) {
        state.picks[rowIndex].effort = level;
        buildLanes();
      }
      $('model-rows').children[rowIndex]?.querySelector('.model-effort').focus({ preventScroll: true });
    });
    menu.appendChild(item);
    return item;
  });
  row.querySelector('.effort-choice').appendChild(menu);
  wirePickerMenu(menu, trigger, items, 192);
}

function wirePickerMenu(menu, trigger, items, preferredWidth = 352) {
  trigger.setAttribute('popovertarget', menu.id);
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  menu.addEventListener('beforetoggle', event => {
    const opening = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(opening));
    if (!opening) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(preferredWidth, innerWidth - 32);
    const below = innerHeight - rect.bottom;
    const above = rect.top;
    const openAbove = below < 424 && above > below;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - width - 16))}px`;
    menu.style.maxHeight = `${Math.max(80, Math.min(innerHeight * .6, (openAbove ? above : below) - 16))}px`;
    menu.style.top = openAbove ? 'auto' : `${rect.bottom + 8}px`;
    menu.style.bottom = openAbove ? `${innerHeight - rect.top + 8}px` : 'auto';
  });
  menu.addEventListener('toggle', event => {
    if (event.newState === 'open') (items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true });
  });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!menu.matches(':popover-open')) menu.showPopover();
    }
  });
  let query = '';
  let lastTyped = 0;
  menu.addEventListener('keydown', event => {
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      items[next].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      menu.hidePopover();
      trigger.focus({ preventScroll: true });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      const now = performance.now();
      query = now - lastTyped > 600 ? event.key : query + event.key;
      lastTyped = now;
      items.find(item => item.querySelector('strong').textContent.toLowerCase().startsWith(query.toLowerCase()))?.focus();
    }
  });
}

function addModel(key) {
  if (state.picks.length >= MAX_MODELS) return;
  state.picks.push({ key, effort: defaultEffort(key) });
  buildLanes();
}

function buildAddMenu() {
  const menu = $('add-model-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Add a model');
  const items = [];
  let company = null;
  for (const model of Object.values(MODELS)) {
    if (model.company !== company) {
      company = model.company;
      const group = document.createElement('div');
      group.className = 'add-menu-group';
      group.textContent = company;
      group.setAttribute('role', 'presentation');
      menu.appendChild(group);
    }
    const price = PRICING[model.key];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'add-menu-item model-picker-item';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    const label = document.createElement('strong');
    label.textContent = model.name;
    const tag = document.createElement('span');
    tag.textContent = price.output ? `$${price.input} / $${price.output}` : `$${price.input} / free`;
    item.append(label, tag);
    item.addEventListener('click', () => {
      menu.hidePopover();
      addModel(model.key);
      $('model-rows').lastElementChild?.querySelector('.model-select').focus({ preventScroll: true });
    });
    items.push(item);
    menu.appendChild(item);
  }
  wirePickerMenu(menu, $('btn-add-model'), items, 352);
}

function updateControls() {
  $('btn-controls').hidden = state.view !== 'stage';
  $('btn-show-results').hidden = state.view !== 'stage' || !state.series.length;
  const busy = Boolean(state.abort);
  $('btn-start').hidden = busy;
  $('btn-stop').hidden = !busy;
  $('btn-stop').disabled = !busy;
  renderBoardPicker();
  renderModelRows();
}

function openControls() {
  if (!$('controls-dialog').open) $('controls-dialog').showModal();
}

function showRunError(message) {
  $('run-error').textContent = message;
  $('run-error').hidden = false;
  $('intro-error').textContent = message;
  $('intro-error').hidden = false;
}

function updateStats() {
  const elapsed = sessionMs();
  for (const lane of state.lanes) {
    const turns = lane.runner?.stats.steps ?? 0;
    const moves = lane.runner?.stats.moves ?? 0;
    const activeMs = lane.endedAt ?? elapsed;
    const cost = estimateCostUsd(lane.key, lane.runner?.stats.usage);
    lane.counters.turns.set(turns, { immediate: turns === 0 });
    lane.counters.moves.set(moves, { immediate: moves === 0 });
    lane.counters.time.set(activeMs, { immediate: activeMs === 0 });
    lane.counters.cost.set(cost, { immediate: cost === 0 });
    for (const [name, count] of [['turns', turns], ['moves', moves]]) {
      const rate = ratePerMinute(count, activeMs);
      lane.rates[name].element.hidden = rate === 0;
      lane.rates[name].counter.set(rate, { immediate: rate === 0 });
    }
    const status = lane.status ?? (state.uiStatus === 'running' || state.uiStatus === 'paused' ? state.uiStatus : '');
    if (lane.statusEl.textContent !== status) lane.statusEl.textContent = status;
  }
}

function updateCard() {
  $('run-status').textContent = `Run status: ${state.uiStatus}`;
  updateStats();
}

function providerMark(model) {
  return model.provider === 'openai' ? 'assets/openai-mark.svg'
    : model.provider === 'anthropic' ? model.logo
      : model.provider === 'xai' ? model.logo : 'assets/typesafe-mark.svg';
}

function renderLogo(container, url, company) {
  container.innerHTML = '';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${company} logo`;
    if (url === 'assets/openai.svg') img.className = 'logo-inverted';
    img.addEventListener('error', () => renderLogo(container, '', company), { once: true });
    container.appendChild(img);
    return;
  }
  const span = document.createElement('span');
  span.textContent = company;
  container.appendChild(span);
}
