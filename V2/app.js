/*
 * NEPSE Flow V2 — views and interactions.
 * Requires ../vendor/{chart.umd.min.js,papaparse.min.js} and data.js (window.V2Data).
 */
(() => {
  'use strict';

  const D = window.V2Data;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    cache: null,
    index: null,
    dates: [],
    missingDates: [],
    window: { start: 0, end: -1, dates: [] },
    view: 'heatmap',
    range: 'all',
    busy: false,
    cachedDays: 0,
    source: '',
    generatedAt: '',
    charts: {},

    // per-view control values
    hm: { metric: 'qty', size: 15, detail: null },
    lb: { metric: 'qty', side: 'both', top: 10, sortKey: null, sortDir: -1 },
    ch: { top: 500 },
    st: { side: 'both', min: 2, top: 20 },
    bm: { top: 10 },
    sp: { mode: 'stock', entity: null, sort: 'gross' },
  };

  const VIEWS = ['heatmap', 'leaderboard', 'churn', 'streaks', 'bump', 'sparklines'];

  const PALETTE = [
    '#5b8def', '#2fbf71', '#e0a33a', '#3cc7d4', '#e15b64',
    '#a879e8', '#06d6a0', '#f08a5d', '#7e6bff', '#8bd450',
    '#d96fa3', '#4ecdc4', '#ef476f', '#90be6d', '#ff9f1c',
  ];

  const GREEN = '#2fbf71';
  const RED = '#e15b64';
  const GREY = '#6f9bd8';

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const els = {};
  const $ = (selector) => document.querySelector(selector);

  function cacheDom() {
    els.status = $('#status');
    els.tabs = [...document.querySelectorAll('.tab')];
    els.rangeButtons = [...document.querySelectorAll('#rangeButtons button')];
    els.syncBtn = $('#syncBtn');
    els.exportBtn = $('#exportBtn');
    els.clearCache = $('#clearCache');

    // heatmap
    els.hmMetric = $('#hmMetric');
    els.hmSize = $('#hmSize');
    els.hmMeta = $('#hmMeta');
    els.hmHint = $('#hmHint');
    els.hmGrid = $('#heatmapGrid');
    els.hmDetail = $('#hmDetail');
    els.hmDetailTitle = $('#hmDetailTitle');
    els.hmDetailTable = $('#hmDetailTable');
    els.hmDetailClose = $('#hmDetailClose');

    // leaderboard
    els.lbMetric = $('#lbMetric');
    els.lbSide = $('#lbSide');
    els.lbTop = $('#lbTop');
    els.lbMeta = $('#lbMeta');
    els.lbTitle = $('#lbTitle');
    els.lbChartWrap = document.querySelector('#view-leaderboard .chart-wrap');
    els.lbChart = $('#lbChart');
    els.lbTable = $('#lbTable');

    // churn
    els.chTop = $('#chTop');
    els.chMeta = $('#chMeta');
    els.chChart = $('#chChart');

    // streaks
    els.stSide = $('#stSide');
    els.stMin = $('#stMin');
    els.stTop = $('#stTop');
    els.stMeta = $('#stMeta');
    els.stTable = $('#stTable');

    // bump
    els.bmTop = $('#bmTop');
    els.bmMeta = $('#bmMeta');
    els.bmChart = $('#bmChart');

    // sparklines
    els.spMode = $('#spMode');
    els.spEntityLabel = $('#spEntityLabel');
    els.spEntity = $('#spEntity');
    els.spSort = $('#spSort');
    els.spMeta = $('#spMeta');
    els.spGrid = $('#spGrid');
  }

  function setStatus(text, kind = '') {
    els.status.textContent = text;
    els.status.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.syncBtn.disabled = busy;
    els.syncBtn.textContent = busy ? 'Syncing…' : 'Sync data';
  }

  // ---------------------------------------------------------------------------
  // Labels + shared helpers
  // ---------------------------------------------------------------------------
  function brokerLabel(key) {
    const broker = state.index && state.index.brokers.get(key);
    return broker ? `TMS ${broker.id} — ${broker.name}` : `TMS ${key}`;
  }

  function brokerShort(key) {
    const broker = state.index && state.index.brokers.get(key);
    return broker ? `${broker.id} · ${broker.name}` : `TMS ${key}`;
  }

  function trunc(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  function makeCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function makeCellHtml(text, className = '') {
    const cell = document.createElement('td');
    cell.innerHTML = text;
    if (className) cell.className = className;
    return cell;
  }

  function metricValue(row, metric) {
    return metric === 'cash' ? row.nc : row.nq;
  }

  // Heatmap/others use "accumulate direction": green always means net buying.
  function accumValue(row, metric) {
    return metric === 'cash' ? -row.nc : row.nq;
  }

  function buildTableHead(table, columns) {
    const head = table.tHead || table.createTHead();
    head.replaceChildren();
    const row = document.createElement('tr');
    for (const column of columns) {
      const th = document.createElement('th');
      th.textContent = column.label;
      if (column.sortable) {
        th.classList.add('sortable');
        if (state.lb.sortKey === column.key) {
          th.classList.add(state.lb.sortDir > 0 ? 'asc' : 'desc');
        }
      }
      if (column.key) th.dataset.key = column.key;
      row.append(th);
    }
    head.append(row);
  }

  // ---------------------------------------------------------------------------
  // URL hash state
  // ---------------------------------------------------------------------------
  function hashValidNumber(params, key, allowed) {
    const raw = params.get(key);
    if (raw === null) return undefined;
    const n = Number(raw);
    return allowed.includes(n) ? n : undefined;
  }

  function readStateFromHash() {
    const params = D.readHash();

    const view = params.get('view');
    if (VIEWS.includes(view)) state.view = view;

    const range = params.get('range');
    if (range === 'all' || [5, 10, 30].includes(Number(range))) {
      state.range = range === 'all' ? 'all' : Number(range);
    }

    const hmMetric = params.get('hmMetric');
    if (hmMetric === 'qty' || hmMetric === 'cash') state.hm.metric = hmMetric;
    const hmSize = hashValidNumber(params, 'hmSize', [10, 15, 20, 25]);
    if (hmSize) state.hm.size = hmSize;

    const lbMetric = params.get('lbMetric');
    if (lbMetric === 'qty' || lbMetric === 'cash') state.lb.metric = lbMetric;
    const lbSide = params.get('lbSide');
    if (['both', 'buy', 'sell'].includes(lbSide)) state.lb.side = lbSide;
    const lbTop = hashValidNumber(params, 'lbTop', [10, 20, 50]);
    if (lbTop) state.lb.top = lbTop;

    const chTop = hashValidNumber(params, 'chTop', [250, 500, 1000]);
    if (chTop) state.ch.top = chTop;

    const stSide = params.get('stSide');
    if (['both', 'buy', 'sell'].includes(stSide)) state.st.side = stSide;
    const stMin = hashValidNumber(params, 'stMin', [2, 3, 5]);
    if (stMin) state.st.min = stMin;
    const stTop = hashValidNumber(params, 'stTop', [20, 50]);
    if (stTop) state.st.top = stTop;

    const bmTop = hashValidNumber(params, 'bmTop', [5, 10, 15]);
    if (bmTop) state.bm.top = bmTop;

    const spMode = params.get('spMode');
    if (spMode === 'stock' || spMode === 'broker') state.sp.mode = spMode;
    const spEntity = params.get('spEntity');
    if (spEntity) state.sp.entity = spEntity;
    const spSort = params.get('spSort');
    if (spSort === 'gross' || spSort === 'net') state.sp.sort = spSort;
  }

  function writeStateToHash() {
    const params = new URLSearchParams();
    params.set('view', state.view);
    params.set('range', String(state.range));
    params.set('hmMetric', state.hm.metric);
    params.set('hmSize', String(state.hm.size));
    params.set('lbMetric', state.lb.metric);
    params.set('lbSide', state.lb.side);
    params.set('lbTop', String(state.lb.top));
    params.set('chTop', String(state.ch.top));
    params.set('stSide', state.st.side);
    params.set('stMin', String(state.st.min));
    params.set('stTop', String(state.st.top));
    params.set('bmTop', String(state.bm.top));
    params.set('spMode', state.sp.mode);
    if (state.sp.entity) params.set('spEntity', state.sp.entity);
    params.set('spSort', state.sp.sort);
    D.writeHash(params);
  }

  // ---------------------------------------------------------------------------
  // Sync (download + cache + index)
  // ---------------------------------------------------------------------------
  async function sync({ force = false } = {}) {
    if (state.busy) return;

    setBusy(true);
    setStatus('Checking Summary/ …', 'busy');
    const failures = [];

    try {
      const listing = await D.resolveDates(force);
      state.source = listing.source;
      state.generatedAt = listing.generatedAt || '';
      if (listing.warning) console.warn('Using cached date list:', listing.warning.message);

      if (!listing.dates.length) throw new Error('No summary files found in the archive');

      setStatus(`Checking cached days (${listing.dates.length})…`, 'busy');

      const cachedRecords = await Promise.all(listing.dates.map((date) => state.cache.get(date)));
      const dayMap = new Map();
      cachedRecords.forEach((record, index) => {
        if (record && Array.isArray(record.rows) && record.rows.length) {
          dayMap.set(listing.dates[index], D.padRows(record));
        }
      });

      state.cachedDays = dayMap.size;
      const missing = listing.dates.filter((date) => !dayMap.has(date));

      if (missing.length) {
        let completed = 0;
        await D.runPool(missing, 4, async (date) => {
          try {
            const day = await D.fetchDay(date);
            await state.cache.put(day);
            dayMap.set(date, day);
            state.cachedDays += 1;
          } catch (error) {
            failures.push({ date, message: error.message || String(error) });
          } finally {
            completed += 1;
            setStatus(`Downloading ${completed}/${missing.length} day${missing.length === 1 ? '' : 's'}…`, 'busy');
          }
        });
      }

      if (!dayMap.size) {
        throw new Error(
          failures.length
            ? `Could not download any summary (${failures[0].date}: ${failures[0].message})`
            : 'No summary data available',
        );
      }

      setStatus('Building index…', 'busy');
      await new Promise((resolve) => setTimeout(resolve, 0));

      state.index = D.buildIndex(dayMap);
      state.dates = state.index.dates;
      state.missingDates = listing.dates.filter((date) => !dayMap.has(date));
      state.window = D.windowOf(state.dates, state.range);
      state.hm.detail = null;

      populateSparkEntities();
      renderActiveView();
      updateStatusReady(failures);
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Failed to load data', 'error');
    } finally {
      setBusy(false);
    }
  }

  function updateStatusReady(failures) {
    const counts = `${state.dates.length} days (${state.cachedDays} from cache) · `
      + `${state.index.brokers.size} brokers · ${state.index.stocks.size} scrips`;
    const sourceLabel = state.source.startsWith('manifest')
      ? `manifest${state.generatedAt ? ` ${state.generatedAt.slice(0, 10)}` : ''}`
      : state.source === 'api' ? 'GitHub listing' : 'offline listing';

    if (state.missingDates.length) {
      setStatus(`Ready with ${state.missingDates.length} missing day(s) · ${counts}`, 'warn');
    } else if (failures.length) {
      setStatus(`Ready with errors · ${counts}`, 'warn');
    } else {
      setStatus(`Ready · ${counts} · ${sourceLabel}`, 'ready');
    }
  }

  // ---------------------------------------------------------------------------
  // Heatmap view
  // ---------------------------------------------------------------------------
  function heatmapColor(value, maxAbs, metric) {
    if (!maxAbs) return '';
    const direction = accumValue({ nq: value, nc: value }, metric);
    const t = Math.max(-1, Math.min(1, direction / maxAbs));
    if (Math.abs(t) < 0.02) return 'rgba(111, 155, 216, 0.10)';
    const alpha = 0.12 + 0.66 * Math.abs(t);
    return t > 0
      ? `rgba(47, 191, 113, ${alpha.toFixed(3)})`
      : `rgba(225, 91, 100, ${alpha.toFixed(3)})`;
  }

  function renderHeatmap() {
    if (!state.index) return;
    const metric = state.hm.metric;
    const size = state.hm.size;
    const totals = D.pairTotals(state.index, state.window);

    const byBroker = D.foldBy(totals, 'brokerKey', (row) => brokerShort(row.brokerKey));
    const byStock = D.foldBy(totals, 'symbol', () => '');

    const brokers = [...byBroker.values()]
      .sort((a, b) => b.gt - a.gt || a.key.localeCompare(b.key))
      .slice(0, size);
    const stocks = [...byStock.values()]
      .sort((a, b) => b.gt - a.gt || a.key.localeCompare(b.key))
      .slice(0, size);

    const cellMap = new Map(totals.map((row) => [row.pairKey, row]));

    let maxAbs = 0;
    for (const broker of brokers) {
      for (const stock of stocks) {
        const row = cellMap.get(`${broker.key}\u0000${stock.key}`);
        if (row) maxAbs = Math.max(maxAbs, Math.abs(metricValue(row, metric)));
      }
    }

    const grid = els.hmGrid;
    grid.style.setProperty('--hm-cols', String(stocks.length));
    const fragment = document.createDocumentFragment();

    const corner = document.createElement('div');
    corner.className = 'hm-corner';
    corner.textContent = 'TMS ↓ · scrip →';
    fragment.append(corner);

    for (const stock of stocks) {
      const head = document.createElement('div');
      head.className = 'hm-col-head';
      head.textContent = stock.key;
      head.title = `${stock.key} · gross Rs ${D.compact(stock.gt)} in range`;
      fragment.append(head);
    }

    for (const broker of brokers) {
      const rowHead = document.createElement('div');
      rowHead.className = 'hm-row-head';
      rowHead.textContent = `${broker.key} · ${trunc(broker.name, 20)}`;
      rowHead.title = `${brokerLabel(broker.key)} · gross Rs ${D.compact(broker.gt)} in range`;
      fragment.append(rowHead);

      for (const stock of stocks) {
        const row = cellMap.get(`${broker.key}\u0000${stock.key}`);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'hm-cell';

        if (!row) {
          cell.classList.add('empty');
          cell.title = `${brokerLabel(broker.key)} × ${stock.key} — no trades in range`;
          cell.disabled = true;
        } else {
          const value = metricValue(row, metric);
          cell.style.background = heatmapColor(value, maxAbs, metric);
          cell.textContent = D.compact(value);
          cell.title = `${brokerLabel(broker.key)} × ${stock.key}\n`
            + `buy ${D.fmtInt(row.bq)} kitta / Rs ${D.compact(row.ba)}`
            + ` · sell ${D.fmtInt(row.sq)} / Rs ${D.compact(row.sa)}\n`
            + `net ${D.fmtSignedQty(row.nq)} kitta · net cash ${D.fmtRsSigned(row.nc)}`
            + ` · ${D.fmtInt(row.ct)} contracts`;
          cell.addEventListener('click', () => showHeatmapDetail(broker.key, stock.key));
        }
        fragment.append(cell);
      }
    }

    grid.replaceChildren(fragment);

    els.hmMeta.textContent =
      `${brokers.length} brokers × ${stocks.length} scrips of `
      + `${state.index.brokers.size}/${state.index.stocks.size} · ranked by gross in range`;

    if (!totals.length) {
      els.hmHint.textContent = 'No trades in the selected range.';
    } else if (els.hmHint.classList.contains('warn')) {
      els.hmHint.classList.remove('warn');
    }

    renderHeatmapDetailIfOpen();
  }

  function showHeatmapDetail(brokerKey, symbol) {
    state.hm.detail = { brokerKey, symbol };
    renderHeatmapDetail();
  }

  function renderHeatmapDetailIfOpen() {
    if (state.hm.detail) renderHeatmapDetail();
  }

  function renderHeatmapDetail() {
    const detail = state.hm.detail;
    if (!detail || !state.index) return;

    const pair = state.index.pairs.get(`${detail.brokerKey}\u0000${detail.symbol}`);
    if (!pair) {
      state.hm.detail = null;
      els.hmDetail.hidden = true;
      return;
    }

    els.hmDetail.hidden = false;
    els.hmDetailTitle.textContent = `${brokerLabel(detail.brokerKey)} × ${detail.symbol}`;

    const head = els.hmDetailTable.tHead || els.hmDetailTable.createTHead();
    head.replaceChildren();
    const headRow = document.createElement('tr');
    for (const label of ['Date', 'Buy Qty', 'Buy Rs', 'Sell Qty', 'Sell Rs', 'Net Qty', 'Net Cash', 'Contracts']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.append(th);
    }
    head.append(headRow);

    const body = els.hmDetailTable.tBodies[0] || els.hmDetailTable.createTBody();
    body.replaceChildren();

    for (let i = state.window.start; i <= state.window.end; i += 1) {
      const point = pair.points.get(i);
      if (!point) continue;
      const tr = document.createElement('tr');
      tr.append(
        makeCell(state.dates[i]),
        makeCell(D.fmtInt(point.bq)),
        makeCell(D.fmtRs(point.ba)),
        makeCell(D.fmtInt(point.sq)),
        makeCell(D.fmtRs(point.sa)),
        makeCell(D.fmtSignedQty(point.nq), D.signClass(point.nq)),
        makeCell(D.fmtRsSigned(point.nc), D.signClass(point.nc)),
        makeCell(D.fmtInt(point.ct)),
      );
      body.append(tr);
    }
  }

  // ---------------------------------------------------------------------------
  // Leaderboard view
  // ---------------------------------------------------------------------------
  const LB_COLUMNS = [
    { key: 'broker', label: 'Broker' },
    { key: 'symbols', label: 'Scrips' },
    { key: 'bq', label: 'Buy Qty' },
    { key: 'sq', label: 'Sell Qty' },
    { key: 'nq', label: 'Net Qty' },
    { key: 'nc', label: 'Net Cash' },
    { key: 'gt', label: 'Gross' },
  ];

  function renderLeaderboard() {
    if (!state.index) return;
    const totals = D.pairTotals(state.index, state.window);
    const byBroker = D.foldBy(totals, 'brokerKey', (row) => brokerShort(row.brokerKey));
    const rows = [...byBroker.values()].map((entry) => ({
      ...entry,
      symbols: entry.symbols.size,
      broker: brokerShort(entry.key),
    }));

    if (!rows.length) {
      els.lbMeta.textContent = 'No trades in the selected range.';
      if (state.charts.lb) {
        state.charts.lb.data.labels = [];
        state.charts.lb.data.datasets = [];
        state.charts.lb.update();
      }
      renderLeaderboardTable(rows);
      return;
    }

    const metric = state.lb.metric;
    const buyers = rows.filter((row) => row.nq > 0);
    const sellers = rows.filter((row) => row.nq < 0);
    const sortByAbs = (list) => [...list].sort((a, b) => Math.abs(metricValue(b, metric)) - Math.abs(metricValue(a, metric)));
    const buyersSorted = sortByAbs(buyers);
    const sellersSorted = sortByAbs(sellers);

    const top = state.lb.top;
    let chartRows;
    let colors;
    if (state.lb.side === 'buy') {
      chartRows = buyersSorted.slice(0, top);
      colors = chartRows.map(() => GREEN);
    } else if (state.lb.side === 'sell') {
      chartRows = sellersSorted.slice(0, top);
      colors = chartRows.map(() => RED);
    } else {
      chartRows = [...buyersSorted.slice(0, top), ...sellersSorted.slice(0, top)];
      colors = chartRows.map((row) => (row.nq > 0 ? GREEN : RED));
    }

    els.lbMeta.textContent =
      `${buyers.length} net buyers · ${sellers.length} net sellers of ${rows.length} brokers`;

    els.lbTitle.textContent = state.lb.side === 'buy'
      ? `Top ${Math.min(top, buyersSorted.length)} net buyers`
      : state.lb.side === 'sell'
        ? `Top ${Math.min(top, sellersSorted.length)} net sellers`
        : `Top ${Math.min(top, buyersSorted.length)} buyers vs ${Math.min(top, sellersSorted.length)} sellers`;

    const chartWrap = els.lbChartWrap;
    chartWrap.style.height = `${Math.min(920, Math.max(300, chartRows.length * 26 + 90))}px`;

    ensureChart('lb', els.lbChart.getContext('2d'), {
      type: 'bar',
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(10, 15, 28, 0.96)',
            borderColor: '#22304d',
            borderWidth: 1,
            titleColor: '#e7edf8',
            bodyColor: '#c9d5e8',
            padding: 10,
            callbacks: {
              label(context) {
                const row = chartRows[context.dataIndex];
                if (!row) return '';
                return [
                  `net ${D.fmtSignedQty(row.nq)} kitta`,
                  `net cash ${D.fmtRsSigned(row.nc)}`,
                  `gross Rs ${D.compact(row.gt)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(34, 48, 77, 0.5)' },
            ticks: { callback: (value) => D.compact(value) },
          },
          y: {
            grid: { display: false },
            ticks: { autoSkip: false, font: { size: 11 } },
          },
        },
      },
    });

    const chart = state.charts.lb;
    chart.data.labels = chartRows.map((row) => trunc(row.broker, 30));
    chart.data.datasets = [{
      data: chartRows.map((row) => metricValue(row, metric)),
      backgroundColor: colors,
      borderRadius: 3,
      barPercentage: 0.85,
    }];
    chart.options.scales.x.title = {
      display: true,
      text: metric === 'cash' ? 'Net cash (Rs) — sell − buy' : 'Net kitta',
    };
    chart.update();

    renderLeaderboardTable(rows);
  }

  function renderLeaderboardTable(rows) {
    buildTableHead(els.lbTable, LB_COLUMNS.map((c) => ({ ...c, sortable: true })));

    const sortKey = state.lb.sortKey || 'nqabs';
    const dir = state.lb.sortDir;
    const sorted = [...rows].sort((a, b) => {
      let value = 0;
      if (sortKey === 'nqabs') value = Math.abs(a.nq) - Math.abs(b.nq);
      else if (sortKey === 'broker') value = a.broker.localeCompare(b.broker);
      else value = (a[sortKey] || 0) - (b[sortKey] || 0);
      if (value === 0) value = a.broker.localeCompare(b.broker);
      return value * dir;
    });

    const body = els.lbTable.tBodies[0] || els.lbTable.createTBody();
    body.replaceChildren();

    for (const row of sorted) {
      const tr = document.createElement('tr');
      tr.append(
        makeCell(row.broker),
        makeCell(D.fmtInt(row.symbols)),
        makeCell(D.fmtInt(row.bq)),
        makeCell(D.fmtInt(row.sq)),
        makeCell(D.fmtSignedQty(row.nq), D.signClass(row.nq)),
        makeCell(D.fmtRsSigned(row.nc), D.signClass(row.nc)),
        makeCell(D.fmtRs(row.gt)),
      );
      body.append(tr);
    }
  }

  // ---------------------------------------------------------------------------
  // Churn scatter view
  // ---------------------------------------------------------------------------
  function renderChurn() {
    if (!state.index) return;
    const totals = D.pairTotals(state.index, state.window);
    const traded = totals
      .filter((row) => row.gt > 0)
      .sort((a, b) => b.gt - a.gt)
      .slice(0, state.ch.top);

    // Log axes need positive values: one-sided pairs sit on a small floor.
    let maxBa = 0;
    let maxSa = 0;
    let maxCt = 0;
    for (const row of traded) {
      maxBa = Math.max(maxBa, row.ba);
      maxSa = Math.max(maxSa, row.sa);
      maxCt = Math.max(maxCt, row.ct);
    }
    const floor = Math.max(1000, Math.max(maxBa, maxSa) * 0.015);

    const points = traded.map((row) => ({
      x: row.ba > 0 ? row.ba : floor,
      y: row.sa > 0 ? row.sa : floor,
      row,
    }));

    els.chMeta.textContent = traded.length
      ? `Top ${traded.length} pairs by gross · ${state.index.pairs.size} pairs traded in range`
      : 'No trades in the selected range.';

    const radiusFor = (contracts) => {
      const t = maxCt > 0 ? Math.sqrt(contracts) / Math.sqrt(maxCt) : 0;
      return 2 + 13 * t;
    };

    const colorFor = (nc) => {
      if (nc > 0) return 'rgba(225, 91, 100, 0.62)'; // net cash in → net selling
      if (nc < 0) return 'rgba(47, 191, 113, 0.62)'; // net cash out → net buying
      return 'rgba(111, 155, 216, 0.5)';
    };

    ensureChart('ch', els.chChart.getContext('2d'), {
      type: 'scatter',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(10, 15, 28, 0.96)',
            borderColor: '#22304d',
            borderWidth: 1,
            titleColor: '#e7edf8',
            bodyColor: '#c9d5e8',
            padding: 10,
            callbacks: {
              title(items) {
                const point = points[items[0].dataIndex];
                return point ? `${brokerShort(point.row.brokerKey)} × ${point.row.symbol}` : '';
              },
              label(context) {
                const point = points[context.dataIndex];
                if (!point) return '';
                const row = point.row;
                return [
                  `buy Rs ${D.compact(row.ba)} · sell Rs ${D.compact(row.sa)}`,
                  `net ${D.fmtSignedQty(row.nq)} kitta · net cash ${D.fmtRsSigned(row.nc)}`,
                  `gross Rs ${D.compact(row.gt)} · ${D.fmtInt(row.ct)} contracts`,
                  row.ba === 0 ? '(no buys in range)' : row.sa === 0 ? '(no sells in range)' : '',
                ].filter(Boolean);
              },
            },
          },
        },
        scales: {
          x: {
            type: 'logarithmic',
            grid: { color: 'rgba(34, 48, 77, 0.5)' },
            title: { display: true, text: 'Buy amount (Rs, log)' },
            ticks: { callback: (value) => D.compact(value) },
            min: floor / 2,
          },
          y: {
            type: 'logarithmic',
            grid: { color: 'rgba(34, 48, 77, 0.5)' },
            title: { display: true, text: 'Sell amount (Rs, log)' },
            ticks: { callback: (value) => D.compact(value) },
            min: floor / 2,
          },
        },
      },
    });

    const chart = state.charts.ch;
    const diagonalEnd = Math.max(maxBa, maxSa) * 1.05 || 1;
    chart.data.datasets = [
      {
        type: 'line',
        data: [{ x: floor / 2, y: floor / 2 }, { x: diagonalEnd, y: diagonalEnd }],
        borderColor: 'rgba(145, 160, 184, 0.55)',
        borderWidth: 1.5,
        borderDash: [6, 5],
        pointRadius: 0,
        label: '_diagonal',
      },
      {
        data: points,
        pointRadius: points.map((point) => radiusFor(point.row.ct)),
        pointHoverRadius: points.map((point) => radiusFor(point.row.ct) + 3),
        pointBackgroundColor: points.map((point) => colorFor(point.row.nc)),
        pointBorderWidth: 0,
      },
    ];
    chart.update();
  }

  // ---------------------------------------------------------------------------
  // Streaks view
  // ---------------------------------------------------------------------------
  function computeStreaks() {
    const result = [];
    for (const pair of state.index.pairs.values()) {
      const signs = [];
      let traded = 0;
      let netQty = 0;
      let netCash = 0;
      let gross = 0;

      for (let i = state.window.start; i <= state.window.end; i += 1) {
        const point = pair.points.get(i);
        if (!point) {
          signs.push(0);
          continue;
        }
        traded += 1;
        netQty += point.nq;
        netCash += point.nc;
        gross += point.gt;
        signs.push(point.nq > 0 ? 1 : point.nq < 0 ? -1 : 0);
      }

      if (!traded) continue;

      // current streak: trailing run ending on the last day of the window
      let current = 0;
      let currentSign = 0;
      for (let i = signs.length - 1; i >= 0; i -= 1) {
        if (signs[i] === 0) break;
        if (currentSign === 0) currentSign = signs[i];
        else if (signs[i] !== currentSign) break;
        current += 1;
      }

      // longest same-sign run anywhere in the window
      let longest = 0;
      let longestSign = 0;
      let run = 0;
      let runSign = 0;
      for (const sign of signs) {
        if (sign === 0) {
          run = 0;
          runSign = 0;
          continue;
        }
        if (sign === runSign) run += 1;
        else {
          run = 1;
          runSign = sign;
        }
        if (run > longest) {
          longest = run;
          longestSign = sign;
        }
      }

      result.push({ pair, signs, current, currentSign, longest, longestSign, netQty, netCash, gross });
    }
    return result;
  }

  function renderStreaks() {
    if (!state.index) return;
    const streaks = computeStreaks();

    const wantedSign = state.st.side === 'buy' ? 1 : state.st.side === 'sell' ? -1 : 0;
    const matched = streaks.filter((entry) => {
      if (entry.current < state.st.min) return false;
      if (wantedSign === 0) return true;
      return entry.currentSign === wantedSign;
    });

    matched.sort((a, b) => b.current - a.current || Math.abs(b.netQty) - Math.abs(a.netQty));

    els.stMeta.textContent = matched.length
      ? `${matched.length} streak${matched.length === 1 ? '' : 's'} of ${streaks.length} traded pairs`
      : 'No streaks of that length in the selected range.';

    const body = els.stTable.tBodies[0] || els.stTable.createTBody();
    const head = els.stTable.tHead || els.stTable.createTHead();
    head.replaceChildren();
    const headRow = document.createElement('tr');
    for (const label of ['Broker × scrip', 'Daily strip', 'Current', 'Longest', 'Net Qty', 'Net Cash', 'Gross']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.append(th);
    }
    head.append(headRow);
    body.replaceChildren();

    for (const entry of matched.slice(0, state.st.top)) {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      name.textContent = `${brokerShort(entry.pair.brokerKey)} × ${entry.pair.symbol}`;

      const strip = document.createElement('td');
      const wrap = document.createElement('span');
      wrap.className = 'streak-strip';
      for (const sign of entry.signs) {
        const cell = document.createElement('span');
        cell.className = sign > 0 ? 'streak-day pos' : sign < 0 ? 'streak-day neg' : 'streak-day flat';
        wrap.append(cell);
      }
      strip.append(wrap);

      const side = entry.currentSign > 0 ? 'buy' : 'sell';
      tr.append(
        name,
        strip,
        makeCell(`${entry.current}D ${side}`, entry.currentSign > 0 ? 'pos' : 'neg'),
        makeCell(`${entry.longest}D ${entry.longestSign > 0 ? 'buy' : 'sell'}`),
        makeCell(D.fmtSignedQty(entry.netQty), D.signClass(entry.netQty)),
        makeCell(D.fmtRsSigned(entry.netCash), D.signClass(entry.netCash)),
        makeCell(D.fmtRs(entry.gross)),
      );
      body.append(tr);
    }

    if (!matched.length) {
      const tr = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.textContent = 'No qualifying streaks — lower the minimum length or widen the range.';
      tr.append(cell);
      body.append(tr);
    }
  }

  // ---------------------------------------------------------------------------
  // Bump view
  // ---------------------------------------------------------------------------
  function renderBump() {
    if (!state.index) return;
    const grossByDay = D.brokerGrossByDay(state.index, state.window);
    const size = state.bm.top;
    const topBrokers = new Map(); // brokerKey -> {grossByRankDay, bestRank}

    const rankSeries = new Map(); // brokerKey -> Array<(rank|null)>
    for (let day = 0; day < state.window.dates.length; day += 1) {
      const entries = [...grossByDay.entries()]
        .map(([key, series]) => ({ key, gross: series[day] }))
        .filter((entry) => entry.gross > 0)
        .sort((a, b) => b.gross - a.gross);

      entries.slice(0, size).forEach((entry, index) => {
        let series = rankSeries.get(entry.key);
        if (!series) {
          series = new Array(state.window.dates.length).fill(null);
          rankSeries.set(entry.key, series);
        }
        series[day] = index + 1;
      });
    }

    const keys = [...rankSeries.keys()].sort((a, b) => {
      const aBest = Math.min(...rankSeries.get(a).filter(Boolean));
      const bBest = Math.min(...rankSeries.get(b).filter(Boolean));
      return aBest - bBest;
    });

    els.bmMeta.textContent = keys.length
      ? `${keys.length} brokers reached the top ${size} on at least one day`
      : 'No trades in the selected range.';

    const palette = (index) => (index < PALETTE.length ? PALETTE[index] : `hsl(${(index * 47) % 360} 66% 62%)`);

    ensureChart('bm', els.bmChart.getContext('2d'), {
      type: 'line',
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: keys.length > 0, position: 'right', labels: { boxWidth: 12, font: { size: 10.5 } } },
          tooltip: {
            backgroundColor: 'rgba(10, 15, 28, 0.96)',
            borderColor: '#22304d',
            borderWidth: 1,
            titleColor: '#e7edf8',
            bodyColor: '#c9d5e8',
            padding: 10,
            callbacks: {
              title(items) {
                return state.window.dates[items[0].dataIndex] || '';
              },
              label(context) {
                if (context.parsed.y == null) return '';
                const gross = grossByDay.get(context.dataset.key);
                const value = gross ? gross[context.dataIndex] : 0;
                return `${context.dataset.label}: rank ${Math.round(context.parsed.y)} · Rs ${D.compact(value)}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { autoSkip: true, maxTicksLimit: 12, maxRotation: 0 },
          },
          y: {
            reverse: true,
            min: 0.5,
            max: size + 0.5,
            grid: { color: 'rgba(34, 48, 77, 0.5)' },
            ticks: { stepSize: 1, precision: 0 },
            title: { display: true, text: 'Rank by gross turnover' },
          },
        },
      },
    });

    const chart = state.charts.bm;
    chart.data.labels = state.window.dates;
    chart.data.datasets = keys.map((key, index) => ({
      key,
      label: `TMS ${key}`,
      data: rankSeries.get(key),
      borderColor: palette(index),
      backgroundColor: palette(index),
      borderWidth: 2,
      pointRadius: 2.5,
      pointHoverRadius: 5,
      spanGaps: false,
      tension: 0.25,
    }));
    chart.update();
  }

  // ---------------------------------------------------------------------------
  // Sparklines view (small multiples)
  // ---------------------------------------------------------------------------
  function populateSparkEntities() {
    if (!state.index) return;
    const isStock = state.sp.mode === 'stock';
    els.spEntityLabel.textContent = isStock ? 'Stock' : 'Broker';

    const list = isStock
      ? [...state.index.stocks.values()].sort((a, b) => b.totalGross - a.totalGross || a.symbol.localeCompare(b.symbol))
      : [...state.index.brokers.values()].sort((a, b) => b.totalGross - a.totalGross || a.id - b.id);

    if (!list.length) {
      els.spEntity.replaceChildren(new Option('No data', ''));
      els.spEntity.disabled = true;
      return;
    }

    els.spEntity.disabled = false;
    const fragment = document.createDocumentFragment();
    for (const item of list) {
      const key = isStock ? item.symbol : item.key;
      const label = isStock ? item.symbol : `${item.id} — ${item.name}`;
      fragment.append(new Option(label, key));
    }
    els.spEntity.replaceChildren(fragment);

    const keys = new Set(list.map((item) => (isStock ? item.symbol : item.key)));
    if (!state.sp.entity || !keys.has(state.sp.entity)) {
      state.sp.entity = isStock ? list[0].symbol : list[0].key;
    }
    els.spEntity.value = state.sp.entity;
  }

  function sparklineSvg(values, maxAbs) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    const barWidth = 7;
    const gap = 2;
    const height = 44;
    const mid = height / 2;
    const width = values.length * (barWidth + gap);

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.classList.add('spark-svg');

    values.forEach((value, index) => {
      if (!value) return;
      const magnitude = maxAbs ? Math.abs(value) / maxAbs : 0;
      const barHeight = Math.max(1.5, magnitude * (height / 2 - 2));
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(index * (barWidth + gap)));
      rect.setAttribute('width', String(barWidth));
      rect.setAttribute('y', value > 0 ? String(mid - barHeight) : String(mid));
      rect.setAttribute('height', String(barHeight));
      rect.setAttribute('rx', '1');
      rect.setAttribute('fill', value > 0 ? GREEN : RED);
      svg.append(rect);
    });

    const baseline = document.createElementNS(SVG_NS, 'line');
    baseline.setAttribute('x1', '0');
    baseline.setAttribute('x2', String(width));
    baseline.setAttribute('y1', String(mid));
    baseline.setAttribute('y2', String(mid));
    baseline.setAttribute('stroke', 'rgba(145, 160, 184, 0.4)');
    baseline.setAttribute('stroke-width', '1');
    svg.append(baseline);

    return svg;
  }

  function renderSparklines() {
    if (!state.index) return;
    const isStock = state.sp.mode === 'stock';
    const entityKey = state.sp.entity;

    const entity = isStock ? state.index.stocks.get(entityKey) : state.index.brokers.get(entityKey);
    const container = els.spGrid;

    if (!entity) {
      container.replaceChildren();
      els.spMeta.textContent = 'No entity selected.';
      return;
    }

    const cards = [];
    for (const pairKey of entity.pairs) {
      const pair = state.index.pairs.get(pairKey);
      if (!pair) continue;

      const values = [];
      let gross = 0;
      let net = 0;
      for (let i = state.window.start; i <= state.window.end; i += 1) {
        const point = pair.points.get(i);
        if (!point) {
          values.push(0);
          continue;
        }
        values.push(point.nq);
        gross += point.gt;
        net += point.nq;
      }
      if (!gross) continue;
      cards.push({
        label: isStock ? brokerShort(pair.brokerKey) : pair.symbol,
        values,
        gross,
        net,
      });
    }

    cards.sort((a, b) => (state.sp.sort === 'net' ? Math.abs(b.net) - Math.abs(a.net) : b.gross - a.gross));

    const MAX_CARDS = 48;
    const shown = cards.slice(0, MAX_CARDS);

    let maxAbs = 0;
    for (const card of shown) {
      for (const value of card.values) maxAbs = Math.max(maxAbs, Math.abs(value));
    }

    const fragment = document.createDocumentFragment();
    for (const card of shown) {
      const item = document.createElement('div');
      item.className = 'spark-card';

      const head = document.createElement('div');
      head.className = 'spark-head';
      const name = document.createElement('span');
      name.className = 'spark-name';
      name.textContent = card.label;
      name.title = card.label;
      const value = document.createElement('span');
      value.className = `spark-value ${D.signClass(card.net)}`.trim();
      value.textContent = D.fmtSignedQty(card.net);
      value.title = `Net ${D.fmtSignedQty(card.net)} kitta · gross Rs ${D.compact(card.gross)} in range`;
      head.append(name, value);

      item.append(head, sparklineSvg(card.values, maxAbs));
      fragment.append(item);
    }

    container.replaceChildren(fragment);

    els.spMeta.textContent = shown.length
      ? `${shown.length} of ${cards.length} ${isStock ? 'brokers' : 'scrips'} · shared scale ±${D.compact(maxAbs)} kitta/day`
      : `No ${isStock ? 'brokers' : 'scrips'} traded in the selected range.`;
  }

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------
  function exportName(view) {
    const last = state.window.dates[state.window.dates.length - 1] || 'no-data';
    const range = state.range === 'all' ? 'all' : `${state.range}d`;
    return `nepse-v2-${view}-${range}-${last}.csv`;
  }

  const EXPORTS = {
    heatmap() {
      const totals = D.pairTotals(state.index, state.window);
      return {
        headers: ['broker_id', 'broker_name', 'symbol', 'buy_qty', 'buy_amount', 'sell_qty', 'sell_amount', 'net_qty', 'net_cash', 'gross_turnover', 'contracts'],
        rows: totals.map((row) => {
          const broker = state.index.brokers.get(row.brokerKey);
          return [
            row.brokerKey,
            broker ? broker.name : '',
            row.symbol,
            row.bq, row.ba, row.sq, row.sa, row.nq, row.nc, row.gt, row.ct,
          ];
        }),
      };
    },
    leaderboard() {
      const totals = D.pairTotals(state.index, state.window);
      const byBroker = D.foldBy(totals, 'brokerKey', (row) => brokerShort(row.brokerKey));
      const rows = [...byBroker.values()].sort((a, b) => b.gt - a.gt);
      return {
        headers: ['broker_id', 'broker_name', 'stocks', 'buy_qty', 'buy_amount', 'sell_qty', 'sell_amount', 'net_qty', 'net_cash', 'gross_turnover'],
        rows: rows.map((row) => {
          const broker = state.index.brokers.get(row.key);
          return [row.key, broker ? broker.name : '', row.symbols.size, row.bq, row.ba, row.sq, row.sa, row.nq, row.nc, row.gt];
        }),
      };
    },
    churn() {
      const totals = D.pairTotals(state.index, state.window);
      const traded = totals
        .filter((row) => row.gt > 0)
        .sort((a, b) => b.gt - a.gt)
        .slice(0, state.ch.top);
      return {
        headers: ['broker_id', 'symbol', 'buy_amount', 'sell_amount', 'net_qty', 'net_cash', 'gross_turnover', 'contracts'],
        rows: traded.map((row) => [row.brokerKey, row.symbol, row.ba, row.sa, row.nq, row.nc, row.gt, row.ct]),
      };
    },
    streaks() {
      const streaks = computeStreaks();
      const wantedSign = state.st.side === 'buy' ? 1 : state.st.side === 'sell' ? -1 : 0;
      const matched = streaks
        .filter((entry) => entry.current >= state.st.min && (wantedSign === 0 || entry.currentSign === wantedSign))
        .sort((a, b) => b.current - a.current || Math.abs(b.netQty) - Math.abs(a.netQty));
      return {
        headers: ['broker_id', 'symbol', 'current_streak_days', 'side', 'longest_streak_days', 'net_qty_window', 'net_cash_window', 'gross_turnover'],
        rows: matched.map((entry) => [
          entry.pair.brokerKey, entry.pair.symbol, entry.current,
          entry.currentSign > 0 ? 'buy' : 'sell', entry.longest, entry.netQty, entry.netCash, entry.gross,
        ]),
      };
    },
    bump() {
      const grossByDay = D.brokerGrossByDay(state.index, state.window);
      const rows = [];
      for (let day = 0; day < state.window.dates.length; day += 1) {
        const entries = [...grossByDay.entries()]
          .map(([key, series]) => ({ key, gross: series[day] }))
          .filter((entry) => entry.gross > 0)
          .sort((a, b) => b.gross - a.gross);
        entries.forEach((entry, index) => {
          const broker = state.index.brokers.get(entry.key);
          rows.push([state.window.dates[day], entry.key, broker ? broker.name : '', entry.gross, index + 1]);
        });
      }
      return {
        headers: ['date', 'broker_id', 'broker_name', 'gross_turnover', 'rank'],
        rows,
      };
    },
    sparklines() {
      const isStock = state.sp.mode === 'stock';
      const entity = isStock ? state.index.stocks.get(state.sp.entity) : state.index.brokers.get(state.sp.entity);
      const rows = [];
      if (entity) {
        for (const pairKey of entity.pairs) {
          const pair = state.index.pairs.get(pairKey);
          if (!pair) continue;
          for (let i = state.window.start; i <= state.window.end; i += 1) {
            const point = pair.points.get(i);
            if (!point) continue;
            rows.push([pair.brokerKey, pair.symbol, state.dates[i], point.nq, point.nc, point.gt]);
          }
        }
      }
      return {
        headers: ['broker_id', 'symbol', 'date', 'net_qty', 'net_cash', 'gross_turnover'],
        rows,
      };
    },
  };

  function onExport() {
    if (!state.index) return;
    const exporter = EXPORTS[state.view];
    if (!exporter) return;
    const { headers, rows } = exporter();
    D.downloadCsv(exportName(state.view), headers, rows);
  }

  // ---------------------------------------------------------------------------
  // Chart helper (one Chart.js instance per view canvas)
  // ---------------------------------------------------------------------------
  function ensureChart(name, context, config) {
    if (state.charts[name]) return state.charts[name];
    if (typeof Chart === 'undefined') return null;

    Chart.defaults.color = '#91a0b8';
    Chart.defaults.borderColor = 'rgba(34, 48, 77, 0.65)';
    Chart.defaults.font.family =
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

    state.charts[name] = new Chart(context, config);
    return state.charts[name];
  }

  // ---------------------------------------------------------------------------
  // View switching + rendering
  // ---------------------------------------------------------------------------
  const RENDERERS = {
    heatmap: renderHeatmap,
    leaderboard: renderLeaderboard,
    churn: renderChurn,
    streaks: renderStreaks,
    bump: renderBump,
    sparklines: renderSparklines,
  };

  function renderActiveView() {
    const renderer = RENDERERS[state.view];
    if (!renderer) return;
    writeStateToHash();
    try {
      renderer();
    } catch (error) {
      console.error(`Render failed for ${state.view}:`, error);
      setStatus(`Render error in ${state.view} — see console`, 'error');
    }
  }

  function syncViewVisibility() {
    for (const id of VIEWS) {
      const section = $(`#view-${id}`);
      if (section) section.hidden = id !== state.view;
    }
  }

  function onTabChange(view) {
    if (view === state.view) return;
    state.view = view;
    syncControls();
    syncViewVisibility();
    renderActiveView();
  }

  function setRange(value) {
    state.range = value === 'all' ? 'all' : Number(value);
    if (state.index) state.window = D.windowOf(state.dates, state.range);
    els.rangeButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.range === String(state.range));
    });
    renderActiveView();
  }

  function syncControls() {
    els.tabs.forEach((tab) => {
      const active = tab.dataset.view === state.view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    els.rangeButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.range === String(state.range));
    });
    els.hmMetric.value = state.hm.metric;
    els.hmSize.value = String(state.hm.size);
    els.lbMetric.value = state.lb.metric;
    els.lbSide.value = state.lb.side;
    els.lbTop.value = String(state.lb.top);
    els.chTop.value = String(state.ch.top);
    els.stSide.value = state.st.side;
    els.stMin.value = String(state.st.min);
    els.stTop.value = String(state.st.top);
    els.bmTop.value = String(state.bm.top);
    els.spMode.value = state.sp.mode;
    els.spSort.value = state.sp.sort;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bindEvents() {
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => onTabChange(tab.dataset.view));
    });

    els.rangeButtons.forEach((button) => {
      button.addEventListener('click', () => setRange(button.dataset.range));
    });

    els.hmMetric.addEventListener('change', () => {
      state.hm.metric = els.hmMetric.value;
      renderActiveView();
    });
    els.hmSize.addEventListener('change', () => {
      state.hm.size = Number(els.hmSize.value);
      renderActiveView();
    });
    els.hmDetailClose.addEventListener('click', () => {
      state.hm.detail = null;
      els.hmDetail.hidden = true;
    });

    els.lbMetric.addEventListener('change', () => {
      state.lb.metric = els.lbMetric.value;
      renderActiveView();
    });
    els.lbSide.addEventListener('change', () => {
      state.lb.side = els.lbSide.value;
      renderActiveView();
    });
    els.lbTop.addEventListener('change', () => {
      state.lb.top = Number(els.lbTop.value);
      renderActiveView();
    });
    els.lbTable.addEventListener('click', (event) => {
      const th = event.target.closest('th[data-key]');
      if (!th) return;
      const key = th.dataset.key;
      if (state.lb.sortKey === key) {
        state.lb.sortDir = -state.lb.sortDir;
      } else {
        state.lb.sortKey = key;
        state.lb.sortDir = key === 'broker' ? 1 : -1;
      }
      renderLeaderboard();
    });

    els.chTop.addEventListener('change', () => {
      state.ch.top = Number(els.chTop.value);
      renderActiveView();
    });

    els.stSide.addEventListener('change', () => {
      state.st.side = els.stSide.value;
      renderActiveView();
    });
    els.stMin.addEventListener('change', () => {
      state.st.min = Number(els.stMin.value);
      renderActiveView();
    });
    els.stTop.addEventListener('change', () => {
      state.st.top = Number(els.stTop.value);
      renderActiveView();
    });

    els.bmTop.addEventListener('change', () => {
      state.bm.top = Number(els.bmTop.value);
      renderActiveView();
    });

    els.spMode.addEventListener('change', () => {
      state.sp.mode = els.spMode.value;
      populateSparkEntities();
      renderActiveView();
    });
    els.spEntity.addEventListener('change', () => {
      state.sp.entity = els.spEntity.value;
      renderActiveView();
    });
    els.spSort.addEventListener('change', () => {
      state.sp.sort = els.spSort.value;
      renderActiveView();
    });

    els.syncBtn.addEventListener('click', () => sync({ force: true }));
    els.exportBtn.addEventListener('click', onExport);

    els.clearCache.addEventListener('click', async () => {
      const confirmed = window.confirm(
        'Clear cached summary data? The next sync will download everything again from GitHub. '
        + 'This also clears the cache used by the v1 dashboard.',
      );
      if (!confirmed) return;
      await state.cache.clear();
      try {
        localStorage.removeItem('nepse.summaryDates.v1');
        localStorage.removeItem('nepse.v2.manifest.v1');
      } catch {
        // Ignore.
      }
      window.location.reload();
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function init() {
    cacheDom();

    if (typeof Chart === 'undefined' || typeof Papa === 'undefined') {
      setStatus('Chart.js/PapaParse failed to load — serve over HTTP, not file://', 'error');
      return;
    }

    state.cache = D.createCache();
    readStateFromHash();
    syncControls();
    syncViewVisibility();
    bindEvents();

    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persist().catch(() => {});
      }
    } catch {
      // Ignore.
    }

    await sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
