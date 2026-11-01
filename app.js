/*
 * NEPSE Broker Flow Visualizer
 * Static, backend-free dashboard for Summary/<date>_brokers.csv files.
 * Data is fetched from raw.githubusercontent.com and cached in IndexedDB.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const DATA_REPO = 'jagdishsah126/nepse-floorsheet-archive';
  const BRANCH = 'main';
  const SUMMARY_DIR = 'Summary';
  const API_TREE = `https://api.github.com/repos/${DATA_REPO}/git/trees`;
  const RAW_SUMMARY = `https://raw.githubusercontent.com/${DATA_REPO}/${BRANCH}/${SUMMARY_DIR}`;

  const CONCURRENCY = 4;
  const FETCH_TIMEOUT_MS = 45000;
  const DATE_CACHE_KEY = 'nepse.summaryDates.v1';
  const DATE_CACHE_TTL = 60 * 60 * 1000;
  const PREFS_KEY = 'nepse.visual.prefs.v1';

  // Interim storage model: only the selected trailing window is loaded, so the
  // tab never holds the whole archive. "All" is an explicit opt-in.
  const DEFAULT_RANGE = 60;
  const CACHE_DAYS = 120;
  const AVG_DAY_RAW_MB = 1.4;
  const AVG_DAY_GZIP_MB = 0.32;
  // Bytes per broker-stock-day point in the columnar index (2 + 4 + 8 + 32).
  const POINT_BYTES = 46;

  const DB_NAME = 'nepse-visual';
  const DB_VERSION = 2;
  const DB_STORE = 'days';

  const REQUIRED_FIELDS = [
    'broker_id',
    'broker_name',
    'stock_symbol',
    'buy_qty',
    'buy_amount',
    'sell_qty',
    'sell_amount',
    'net_qty',
    'net_cash',
    'gross_turnover',
  ];

  const ACC_COLORS = [
    '#2fbf71', '#3cc7d4', '#8bd450', '#06d6a0', '#4ecdc4',
    '#52b788', '#74c69d', '#43aa8b', '#90be6d', '#a7c957',
    '#57cc99', '#80ed99',
  ];

  const DIST_COLORS = [
    '#e15b64', '#f08a5d', '#ef476f', '#d96fa3', '#ff8fab',
    '#e76f51', '#f28482', '#c9184a', '#ff6b6b', '#e5989b',
    '#d00000', '#ff9f1c',
  ];

  const FLAT_COLORS = ['#6f9bd8', '#91a0b8', '#b5c7ff', '#7e6bff', '#a879e8'];

  const METRIC_LABELS = {
    cum_qty: 'Cumulative net qty',
    daily_qty: 'Daily net qty',
    cum_cash: 'Cumulative net cash',
    daily_cash: 'Daily net cash',
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    // data
    dates: [],
    stocks: new Map(),
    brokers: new Map(),
    stockOrder: [],
    brokerOrder: [],
    missingDates: [],
    dateIndex: new Map(),
    loadedCount: 0,
    dateSource: 'api',
    // Compact columnar point index (one entry per broker-stock-day).
    points: null,

    // view
    entityType: 'stock',
    entity: null,
    lastEntity: { stock: null, broker: null },
    range: DEFAULT_RANGE,
    metric: 'cum_qty',
    flowMode: 'both',
    topN: 5,
    selected: new Set(),
    autoSelection: true,
    // null keeps the original default: absolute net qty, descending.
    tableSort: null,

    // render scratch
    window: { start: 0, end: -1, dates: [] },
    rankedPairs: [],
    tickFullDate: false,

    // infra
    cache: null,
    chart: null,
    busy: false,
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const els = {};
  const $ = (selector) => document.querySelector(selector);

  function cacheDom() {
    els.status = $('#status');
    els.tabs = [...document.querySelectorAll('.tab')];
    els.rangeButtons = [...document.querySelectorAll('#rangeButtons button')];
    els.metric = $('#metric');
    els.flowMode = $('#flowMode');
    els.topCountLabel = $('#topCountLabel');
    els.topN = $('#topN');
    els.syncBtn = $('#syncBtn');
    els.entityLabel = $('#entityLabel');
    els.entitySelect = $('#entitySelect');
    els.entityMeta = $('#entityMeta');
    els.chartTitle = $('#chartTitle');
    els.chartHint = $('#chartHint');
    els.seriesCount = $('#seriesCount');
    els.chart = $('#chart');
    els.seriesSearch = $('#seriesSearch');
    els.seriesList = $('#seriesList');
    els.tableTitle = $('#tableTitle');
    els.tableHint = $('#tableHint');
    els.summaryTable = $('#summaryTable');
    els.clearCache = $('#clearCache');
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const intFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const twoFormat = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  function fmtInt(value) {
    return intFormat.format(Math.round(value || 0));
  }

  function fmtSignedQty(value) {
    const n = Math.round(value || 0);
    if (n > 0) return `+${fmtInt(n)}`;
    return fmtInt(n);
  }

  function fmtRs(value) {
    const n = Number(value) || 0;
    return `${n < 0 ? '-' : ''}Rs ${fmtInt(Math.abs(n))}`;
  }

  function fmtRsSigned(value) {
    const n = Number(value) || 0;
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return `${sign}Rs ${fmtInt(Math.abs(n))}`;
  }

  function fmtVwap(value) {
    const n = Number(value) || 0;
    return n > 0 ? `Rs ${twoFormat.format(n)}` : '—';
  }

  function trimCompact(value) {
    const abs = Math.abs(value);
    if (abs >= 100) return String(Math.round(value));
    if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
    return value.toFixed(1).replace(/\.0$/, '');
  }

  function compact(value) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e7) return `${sign}${trimCompact(abs / 1e7)} Cr`;
    if (abs >= 1e5) return `${sign}${trimCompact(abs / 1e5)} L`;
    if (abs >= 1e3) return `${sign}${trimCompact(abs / 1e3)} K`;
    if (abs < 10) return `${sign}${Math.round(abs * 10) / 10}`;
    return `${sign}${Math.round(abs)}`;
  }

  function metricIsCash(metric = state.metric) {
    return metric.endsWith('cash');
  }

  function metricIsCumulative(metric = state.metric) {
    return metric.startsWith('cum');
  }

  function signClass(value) {
    if (value > 0) return 'pos';
    if (value < 0) return 'neg';
    return '';
  }

  function sideOf(netQty) {
    if (netQty > 0) return 'accum';
    if (netQty < 0) return 'dist';
    return 'flat';
  }

  function sideLabel(side) {
    if (side === 'accum') return 'accumulator';
    if (side === 'dist') return 'distributor';
    return 'no net change';
  }

  function sideColor(side, index) {
    const palette = side === 'accum' ? ACC_COLORS : side === 'dist' ? DIST_COLORS : FLAT_COLORS;
    if (index < palette.length) return palette[index];
    const base = side === 'accum' ? 145 : side === 'dist' ? 345 : 215;
    const hue = (base + ((index * 29) % 45)) % 360;
    return `hsl(${hue} 66% 62%)`;
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function num(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
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

  function uniqueSorted(values) {
    return [...new Set(values)].sort();
  }

  async function runPool(items, limit, worker) {
    let next = 0;
    const size = Math.min(limit, items.length);
    const runners = Array.from({ length: size }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    });
    await Promise.all(runners);
  }

  function debounce(fn, wait) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  // ---------------------------------------------------------------------------
  // IndexedDB cache (falls back to memory when storage is unavailable)
  // ---------------------------------------------------------------------------
  function createCache() {
    const memory = new Map();
    const MEMORY_LIMIT = 30;
    let dbPromise = null;
    let broken = !('indexedDB' in window);

    function trimMemory() {
      while (memory.size > MEMORY_LIMIT) {
        memory.delete(memory.keys().next().value);
      }
    }

    function open() {
      if (broken) return Promise.reject(new Error('IndexedDB unavailable'));
      if (dbPromise) return dbPromise;

      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          // v2 replaces the old raw-row store with compact typed-array days.
          // Dropping the old store also frees the archive-sized v1 cache.
          if (db.objectStoreNames.contains(DB_STORE)) {
            db.deleteObjectStore(DB_STORE);
          }
          db.createObjectStore(DB_STORE, { keyPath: 'date' });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
      }).catch((error) => {
        broken = true;
        console.warn('IndexedDB unavailable, using in-memory cache:', error);
        throw error;
      });

      return dbPromise;
    }

    async function get(date) {
      if (broken) return memory.get(date) || null;
      try {
        const db = await open();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).get(date);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        });
      } catch {
        return memory.get(date) || null;
      }
    }

    async function put(day) {
      if (broken) {
        memory.set(day.date, day);
        trimMemory();
        return;
      }
      try {
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(day);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch (error) {
        console.warn(`Could not cache ${day.date}:`, error);
        memory.set(day.date, day);
        trimMemory();
      }
    }

    async function listDates() {
      const inMemory = [...memory.keys()];
      if (broken) return inMemory;
      try {
        const db = await open();
        const keys = await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).getAllKeys();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
        return uniqueSorted([...inMemory, ...keys]);
      } catch {
        return inMemory;
      }
    }

    async function clear() {
      memory.clear();
      if (broken) return;
      try {
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch (error) {
        console.warn('Could not clear IndexedDB:', error);
      }
    }

    async function prune(keepDates) {
      const keep = new Set(keepDates);
      for (const key of [...memory.keys()]) {
        if (!keep.has(key)) memory.delete(key);
      }
      if (broken) return;
      try {
        const db = await open();
        const keys = await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).getAllKeys();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
        const drop = keys.filter((key) => !keep.has(key));
        if (!drop.length) return;
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          const store = tx.objectStore(DB_STORE);
          for (const key of drop) store.delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch (error) {
        console.warn('Could not prune cached days:', error);
      }
    }

    return { get, put, listDates, clear, prune };
  }

  // ---------------------------------------------------------------------------
  // GitHub listing
  // ---------------------------------------------------------------------------
  function readDateCache() {
    try {
      const raw = localStorage.getItem(DATE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.dates) || typeof parsed.ts !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeDateCache(dates) {
    try {
      localStorage.setItem(DATE_CACHE_KEY, JSON.stringify({ ts: Date.now(), dates }));
    } catch {
      // Quota or private mode — the listing simply stays uncached.
    }
  }

  async function apiJson(url, timeout = 25000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          const reset = response.headers.get('x-ratelimit-reset');
          const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : '';
          throw new Error(`GitHub API rate limit reached${when ? ` (resets around ${when})` : ''}`);
        }
        throw new Error(`GitHub API returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('GitHub API request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchDatesFromApi() {
    const root = await apiJson(`${API_TREE}/${encodeURIComponent(BRANCH)}`);
    if (!root || !Array.isArray(root.tree)) throw new Error('Unexpected GitHub API response');

    const summary = root.tree.find((entry) => entry.path === SUMMARY_DIR && entry.type === 'tree');
    if (!summary) throw new Error(`${SUMMARY_DIR}/ was not found in ${DATA_REPO}`);

    const tree = await apiJson(`${API_TREE}/${summary.sha}`);
    if (!tree || !Array.isArray(tree.tree)) throw new Error('Unexpected GitHub API response');
    if (tree.truncated) throw new Error('Summary/ listing is too large; GitHub truncated the tree');

    return uniqueSorted(
      tree.tree
        .filter((entry) => entry.type === 'blob' && /^\d{4}-\d{2}-\d{2}_brokers\.csv$/.test(entry.path))
        .map((entry) => entry.path.slice(0, 10)),
    );
  }

  async function resolveDates(force) {
    const cached = readDateCache();
    if (!force && cached && Date.now() - cached.ts < DATE_CACHE_TTL) {
      return { dates: cached.dates, source: 'cache' };
    }

    try {
      const dates = await fetchDatesFromApi();
      writeDateCache(dates);
      return { dates, source: 'api' };
    } catch (error) {
      if (cached && cached.dates.length) {
        return { dates: cached.dates, source: 'stale-cache', warning: error };
      }
      const local = await state.cache.listDates();
      if (local.length) {
        return { dates: local, source: 'indexeddb', warning: error };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Daily summary download + parse
  // ---------------------------------------------------------------------------
  async function fetchDay(date) {
    const url = `${RAW_SUMMARY}/${date}_brokers.csv`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let text;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('download timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.length < 200) throw new Error('file is empty or invalid');

    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
    });

    const fields = parsed.meta && Array.isArray(parsed.meta.fields) ? parsed.meta.fields : [];
    const missing = REQUIRED_FIELDS.filter((field) => !fields.includes(field));
    if (missing.length) {
      throw new Error(`unexpected columns (missing ${missing.join(', ')})`);
    }

    const fatal = parsed.errors.find((error) => error.type === 'Quotes');
    if (fatal) throw new Error(`CSV parse error: ${fatal.message}`);

    // Columnar, not one JS object per row: a broker-stock-day point costs
    // about 46 bytes, so a 60-day window stays around 25-30 MB.
    const capacity = parsed.data.length;
    const brokerIdx = new Uint16Array(capacity);
    const symbolIdx = new Uint16Array(capacity);
    const buyQty = new Int32Array(capacity);
    const buyAmount = new Float64Array(capacity);
    const sellQty = new Int32Array(capacity);
    const sellAmount = new Float64Array(capacity);
    const netQty = new Int32Array(capacity);
    const netCash = new Float64Array(capacity);
    const gross = new Float64Array(capacity);

    const brokerSlot = new Map();
    const brokers = [];
    const brokerNames = [];
    const symbolSlot = new Map();
    const symbols = [];

    // One slot per (broker, symbol). If the source publishes duplicate rows for
    // the same pair on a day, they merge here so the rest of the app can rely
    // on one point per pair per day.
    const pairSlot = new Map();

    let n = 0;
    for (const row of parsed.data) {
      const brokerId = Number(String(row.broker_id ?? '').trim());
      const symbol = String(row.stock_symbol ?? '').trim();
      if (!Number.isFinite(brokerId) || !brokerId || !symbol) continue;

      let bi = brokerSlot.get(brokerId);
      if (bi === undefined) {
        bi = brokers.length;
        brokerSlot.set(brokerId, bi);
        brokers.push(brokerId);
        brokerNames.push(String(row.broker_name ?? '').trim() || `TMS ${brokerId}`);
      }

      let si = symbolSlot.get(symbol);
      if (si === undefined) {
        si = symbols.length;
        symbolSlot.set(symbol, si);
        symbols.push(symbol);
      }

      const buyQtyI = Math.round(num(row.buy_qty));
      const buyAmountI = num(row.buy_amount);
      const sellQtyI = Math.round(num(row.sell_qty));
      const sellAmountI = num(row.sell_amount);
      const netQtyI = Math.round(num(row.net_qty));
      const netCashI = num(row.net_cash);
      const grossI = num(row.gross_turnover);

      const pairKey = (bi << 16) | si;
      let at = pairSlot.get(pairKey);
      if (at === undefined) {
        pairSlot.set(pairKey, n);
        at = n;
        n += 1;
        brokerIdx[at] = bi;
        symbolIdx[at] = si;
        buyQty[at] = buyQtyI;
        buyAmount[at] = buyAmountI;
        sellQty[at] = sellQtyI;
        sellAmount[at] = sellAmountI;
        netQty[at] = netQtyI;
        netCash[at] = netCashI;
        gross[at] = grossI;
      } else {
        buyQty[at] += buyQtyI;
        buyAmount[at] += buyAmountI;
        sellQty[at] += sellQtyI;
        sellAmount[at] += sellAmountI;
        netQty[at] += netQtyI;
        netCash[at] += netCashI;
        gross[at] += grossI;
      }
    }

    if (!n) throw new Error('no data rows found');

    return {
      date,
      n,
      brokers,
      brokerNames,
      symbols,
      brokerIdx: brokerIdx.subarray(0, n),
      symbolIdx: symbolIdx.subarray(0, n),
      buyQty: buyQty.subarray(0, n),
      buyAmount: buyAmount.subarray(0, n),
      sellQty: sellQty.subarray(0, n),
      sellAmount: sellAmount.subarray(0, n),
      netQty: netQty.subarray(0, n),
      netCash: netCash.subarray(0, n),
      gross: gross.subarray(0, n),
      fetchedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Index building
  // ---------------------------------------------------------------------------
  function getOrCreateStock(symbol) {
    let stock = state.stocks.get(symbol);
    if (!stock) {
      stock = { symbol, totalGross: 0, brokers: new Map() };
      state.stocks.set(symbol, stock);
    }
    return stock;
  }

  function getOrCreateBroker(key, id, name) {
    let broker = state.brokers.get(key);
    if (!broker) {
      broker = { key, id, name: name || `TMS ${key}`, totalGross: 0, stocks: new Map() };
      state.brokers.set(key, broker);
    } else if (name) {
      broker.name = name;
    }
    return broker;
  }

  function buildIndex(records) {
    if (state.dates.length > 0xffff) {
      throw new Error('too many trading days for the compact index');
    }

    state.stocks = new Map();
    state.brokers = new Map();

    const pairByBroker = new Map();
    const pairMeta = [];
    const pairSeries = [];
    const counts = [];
    let total = 0;

    function pairIdFor(brokerKey, symbol, brokerName) {
      let bySymbol = pairByBroker.get(brokerKey);
      if (!bySymbol) {
        bySymbol = new Map();
        pairByBroker.set(brokerKey, bySymbol);
      }
      let pid = bySymbol.get(symbol);
      if (pid !== undefined) return pid;

      pid = pairMeta.length;
      bySymbol.set(symbol, pid);
      const broker = getOrCreateBroker(brokerKey, Number(brokerKey), brokerName);
      const stock = getOrCreateStock(symbol);
      const series = { brokerKey, symbol, start: 0, end: 0 };
      broker.stocks.set(symbol, series);
      stock.brokers.set(brokerKey, series);
      pairMeta.push({ broker, stock, series });
      pairSeries.push(series);
      counts.push(0);
      return pid;
    }

    // Pass 1: intern broker-stock pairs and count points so the index can live
    // in flat typed arrays instead of one object per point.
    for (const day of records) {
      const brokerKeys = day.brokerKeyStrs || (day.brokerKeyStrs = day.brokers.map(String));
      const pairIds = new Uint32Array(day.n);
      for (let i = 0; i < day.n; i += 1) {
        const brokerAt = day.brokerIdx[i];
        const pid = pairIdFor(
          brokerKeys[brokerAt],
          day.symbols[day.symbolIdx[i]],
          day.brokerNames[brokerAt],
        );
        pairIds[i] = pid;
        counts[pid] += 1;
        total += 1;
      }
      day.pairIds = pairIds;
    }

    const starts = new Uint32Array(pairMeta.length + 1);
    for (let pid = 0; pid < pairMeta.length; pid += 1) {
      starts[pid + 1] = starts[pid] + counts[pid];
    }
    const cursor = starts.slice(0, pairMeta.length);

    const points = {
      day: new Uint16Array(total),
      nq: new Int32Array(total),
      nc: new Float64Array(total),
      bq: new Int32Array(total),
      sq: new Int32Array(total),
      ba: new Float64Array(total),
      sa: new Float64Array(total),
      gt: new Float64Array(total),
    };

    // Pass 2: write the points. Records arrive in date order, so every pair's
    // slice stays sorted by day, which the series readers rely on.
    for (const day of records) {
      const pairIds = day.pairIds;
      for (let i = 0; i < day.n; i += 1) {
        const pid = pairIds[i];
        const at = cursor[pid];
        cursor[pid] = at + 1;

        points.day[at] = day.index;
        points.nq[at] = day.netQty[i];
        points.nc[at] = day.netCash[i];
        points.bq[at] = day.buyQty[i];
        points.sq[at] = day.sellQty[i];
        points.ba[at] = day.buyAmount[i];
        points.sa[at] = day.sellAmount[i];
        points.gt[at] = day.gross[i];

        const meta = pairMeta[pid];
        meta.broker.totalGross += day.gross[i];
        meta.stock.totalGross += day.gross[i];
      }
      day.pairIds = null;
    }

    for (let pid = 0; pid < pairMeta.length; pid += 1) {
      const series = pairSeries[pid];
      series.start = starts[pid];
      series.end = starts[pid + 1];
    }

    state.points = points;
    state.stockOrder = [...state.stocks.values()].sort(
      (a, b) => b.totalGross - a.totalGross || a.symbol.localeCompare(b.symbol),
    );
    state.brokerOrder = [...state.brokers.values()].sort(
      (a, b) => b.totalGross - a.totalGross || a.id - b.id,
    );
  }

  // Iterate one pair's points that fall inside the window. Points are sparse
  // (a broker does not trade a stock every day) and sorted by day.
  function eachPoint(series, window, callback) {
    const points = state.points;
    for (let i = series.start; i < series.end; i += 1) {
      const day = points.day[i];
      if (day < window.start) continue;
      if (day > window.end) break;
      callback(i, day);
    }
  }

  function findPoint(series, dayIndex) {
    const days = state.points.day;
    let lo = series.start;
    let hi = series.end - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = days[mid];
      if (value === dayIndex) return mid;
      if (value < dayIndex) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  function firstPointInWindow(series, window) {
    const days = state.points.day;
    let i = series.start;
    while (i < series.end && days[i] < window.start) i += 1;
    return i < series.end && days[i] <= window.end ? i : -1;
  }

  // ---------------------------------------------------------------------------
  // Window / entity helpers
  // ---------------------------------------------------------------------------
  function getWindow() {
    const total = state.dates.length;
    if (!total) return { start: 0, end: -1, dates: [] };
    const count = state.range === 'all' ? total : Math.min(Number(state.range), total);
    return {
      start: total - count,
      end: total - 1,
      dates: state.dates.slice(total - count),
    };
  }

  function currentEntity() {
    if (state.entityType === 'stock') {
      const stock = state.stocks.get(state.entity);
      return stock ? { type: 'stock', data: stock, pairs: stock.brokers } : null;
    }
    const broker = state.brokers.get(state.entity);
    return broker ? { type: 'broker', data: broker, pairs: broker.stocks } : null;
  }

  function pairLabel(key) {
    if (state.entityType === 'stock') {
      const broker = state.brokers.get(key);
      return broker ? `${broker.id} — ${broker.name}` : key;
    }
    return key;
  }

  function rankPairs(window) {
    const entity = currentEntity();
    if (!entity) return [];

    const ranked = [];
    for (const [key, series] of entity.pairs) {
      let netQty = 0;
      eachPoint(series, window, (at) => {
        netQty += state.points.nq[at];
      });
      ranked.push({
        key,
        series,
        netQty,
        side: sideOf(netQty),
        rank: Math.abs(netQty),
      });
    }

    ranked.sort((a, b) => b.rank - a.rank || pairLabel(a.key).localeCompare(pairLabel(b.key)));

    const bySide = { accum: [], dist: [], flat: [] };
    for (const pair of ranked) bySide[pair.side].push(pair);
    bySide.accum.sort((a, b) => b.netQty - a.netQty);
    bySide.dist.sort((a, b) => a.netQty - b.netQty);
    bySide.flat.sort((a, b) => pairLabel(a.key).localeCompare(pairLabel(b.key)));
    for (const side of ['accum', 'dist', 'flat']) {
      bySide[side].forEach((pair, index) => {
        pair.color = sideColor(side, index);
      });
    }

    return ranked;
  }

  function topSelection(ranked) {
    const limit = state.topN === 'all' ? Infinity : Math.max(0, Number(state.topN) || 0);
    const accumulators = ranked
      .filter((pair) => pair.netQty > 0)
      .sort((a, b) => b.netQty - a.netQty);
    const distributors = ranked
      .filter((pair) => pair.netQty < 0)
      .sort((a, b) => a.netQty - b.netQty);

    let chosen;
    if (state.flowMode === 'accum') chosen = accumulators.slice(0, limit);
    else if (state.flowMode === 'dist') chosen = distributors.slice(0, limit);
    else chosen = [...accumulators.slice(0, limit), ...distributors.slice(0, limit)];

    return new Set(chosen.map((pair) => pair.key));
  }

  function hasTradeInWindow(series, window) {
    return firstPointInWindow(series, window) !== -1;
  }

  function aggregate(series, window) {
    const points = state.points;
    let buyQty = 0;
    let buyAmount = 0;
    let sellQty = 0;
    let sellAmount = 0;
    let netQty = 0;
    let netCash = 0;
    let gross = 0;

    eachPoint(series, window, (at) => {
      buyQty += points.bq[at];
      buyAmount += points.ba[at];
      sellQty += points.sq[at];
      sellAmount += points.sa[at];
      netQty += points.nq[at];
      netCash += points.nc[at];
      gross += points.gt[at];
    });

    return { buyQty, buyAmount, sellQty, sellAmount, netQty, netCash, gross };
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);

      if (prefs.entityType === 'stock' || prefs.entityType === 'broker') {
        state.entityType = prefs.entityType;
      }
      if (prefs.lastEntity && typeof prefs.lastEntity === 'object') {
        if (typeof prefs.lastEntity.stock === 'string') state.lastEntity.stock = prefs.lastEntity.stock;
        if (typeof prefs.lastEntity.broker === 'string') state.lastEntity.broker = prefs.lastEntity.broker;
      }
      if (prefs.range === 'all' || [5, 10, 30, 45, 60, 90].includes(Number(prefs.range))) {
        // A persisted "All" would silently pull the whole archive on open.
        state.range = prefs.range === 'all' ? DEFAULT_RANGE : Number(prefs.range);
      }
      if (METRIC_LABELS[prefs.metric]) state.metric = prefs.metric;
      if (prefs.flowMode === 'accum' || prefs.flowMode === 'dist' || prefs.flowMode === 'both') {
        state.flowMode = prefs.flowMode;
      }
      if (prefs.topN === 'all' || [5, 10, 20].includes(Number(prefs.topN))) {
        state.topN = prefs.topN === 'all' ? 'all' : Number(prefs.topN);
      }
    } catch {
      // Ignore malformed preferences.
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          entityType: state.entityType,
          lastEntity: state.lastEntity,
          range: state.range,
          metric: state.metric,
          flowMode: state.flowMode,
          topN: state.topN,
        }),
      );
    } catch {
      // Ignore quota errors.
    }
  }

  function syncControlsFromState() {
    els.tabs.forEach((tab) => {
      const active = tab.dataset.view === state.entityType;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    els.rangeButtons.forEach((button) => {
      const value = button.dataset.range;
      const active = value === String(state.range);
      button.classList.toggle('active', active);
    });
    els.metric.value = state.metric;
    els.flowMode.value = state.flowMode;
    syncCountControl();
  }

  function syncCountControl() {
    const both = state.flowMode === 'both';
    els.topCountLabel.textContent = both ? 'Each side' : 'Count';
    for (const option of els.topN.options) {
      if (option.value === 'all') option.textContent = both ? 'All vs all' : 'All';
      else option.textContent = both ? `${option.value} vs ${option.value}` : option.value;
    }
    els.topN.value = String(state.topN);
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------
  function rangeCount() {
    if (state.range === 'all') return state.dates.length;
    return Math.min(Number(state.range) || DEFAULT_RANGE, state.dates.length);
  }

  async function loadRange() {
    const count = rangeCount();
    const targets = state.dates.slice(state.dates.length - count);
    const failures = [];

    setStatus(`Checking ${count} cached day${count === 1 ? '' : 's'}…`, 'busy');
    const cached = await Promise.all(targets.map((date) => state.cache.get(date)));
    const dayMap = new Map();
    cached.forEach((record, index) => {
      // v1 records held raw row arrays; v2 holds compact typed arrays only.
      if (record && record.n && record.brokerIdx) dayMap.set(targets[index], record);
    });

    const missing = targets.filter((date) => !dayMap.has(date));
    if (missing.length) {
      let completed = 0;
      await runPool(missing, CONCURRENCY, async (date) => {
        try {
          const day = await fetchDay(date);
          await state.cache.put(day);
          dayMap.set(date, day);
        } catch (error) {
          failures.push({ date, message: error.message || String(error) });
        } finally {
          completed += 1;
          setStatus(`Downloading ${completed}/${missing.length} day${missing.length === 1 ? '' : 's'}…`, 'busy');
        }
      });
    }

    const records = [];
    for (const date of targets) {
      const day = dayMap.get(date);
      if (!day) continue;
      day.index = state.dateIndex.get(date);
      records.push(day);
    }
    state.missingDates = targets.filter((date) => !dayMap.has(date));
    state.loadedCount = records.length;

    if (!records.length) {
      throw new Error(
        failures.length
          ? `Could not download any summary (${failures[0].date}: ${failures[0].message})`
          : 'No summary data available',
      );
    }

    setStatus(`Building index for ${records.length} day${records.length === 1 ? '' : 's'}…`, 'busy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    buildIndex(records);

    // The columnar index owns the numbers now; let the day records go so the
    // tab keeps only the selected window.
    for (const day of records) {
      day.brokerKeyStrs = null;
      day.pairIds = null;
    }
    // While All is loaded keep the extra days on disk; pruning them would force
    // a large re-download the next time All is selected.
    if (state.range !== 'all') {
      await state.cache.prune(state.dates.slice(-CACHE_DAYS));
    }

    if (failures.length) console.warn('Days that failed to download:', failures);
  }

  function updateReadyStatus() {
    const counts = `${state.loadedCount} of ${state.dates.length} days · ${state.brokers.size} brokers · ${state.stocks.size} scrips`;
    if (state.missingDates.length) {
      setStatus(`Ready with ${state.missingDates.length} missing day(s) · ${counts}`, 'warn');
    } else if (state.dateSource === 'api' || state.dateSource === 'cache') {
      setStatus(`Ready · ${counts}`, 'ready');
    } else {
      setStatus(`Ready · ${counts} · offline date list`, 'warn');
    }
  }

  async function sync({ force = false } = {}) {
    if (state.busy) return;

    setBusy(true);
    setStatus('Checking Summary/ …', 'busy');

    try {
      const { dates, source, warning } = await resolveDates(force);
      if (warning) console.warn('Using cached date list:', warning.message);

      if (!dates.length) throw new Error('No summary files found in the archive');

      state.dates = dates;
      state.dateSource = source;
      state.dateIndex = new Map(dates.map((date, index) => [date, index]));

      await loadRange();

      if (!state.entity) {
        state.entity = state.lastEntity[state.entityType];
      }

      populateEntitySelect();
      syncControlsFromState();

      if (!state.selected.size) state.autoSelection = true;

      renderAll();
      updateReadyStatus();

      if (warningsForMissingDays()) {
        console.warn('Missing summary days:', state.missingDates);
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Failed to load data', 'error');
      if (!state.dates.length || !state.points) {
        els.chartTitle.textContent = 'Could not load data';
        els.chartHint.textContent = 'Check your connection and press “Sync data” to retry.';
        els.chartHint.classList.add('warn');
        clearChart();
        clearTable();
        renderSeriesList();
      }
    } finally {
      setBusy(false);
    }
  }

  async function changeRange(value) {
    if (state.busy) return;
    const next = value === 'all' ? 'all' : Number(value);
    if (!state.dates.length || next === state.range) return;

    if (next === 'all') {
      const days = state.dates.length;
      const rawMb = Math.round(days * AVG_DAY_RAW_MB);
      const gzipMb = Math.round(days * AVG_DAY_GZIP_MB);
      const ok = window.confirm(
        `Load all ${days} trading days?\n\n` +
          `Download: about ${rawMb} MB (≈ ${gzipMb} MB compressed).\n` +
          `Tab memory: roughly ${Math.round(days * POINT_BYTES / 1e6)} MB.\n\n` +
          'On a metered connection, stay on 60D unless you need the full history.',
      );
      if (!ok) {
        syncControlsFromState();
        return;
      }
    }

    const previous = state.range;
    state.range = next;
    syncControlsFromState();
    savePrefs();
    setBusy(true);
    setStatus(`Loading ${next === 'all' ? 'all days' : `${next} days`}…`, 'busy');

    try {
      await loadRange();
      populateEntitySelect();
      renderAll();
      updateReadyStatus();
    } catch (error) {
      console.error(error);
      state.range = previous;
      syncControlsFromState();
      savePrefs();
      setStatus(error.message || 'Failed to load range', 'error');
    } finally {
      setBusy(false);
    }
  }

  function warningsForMissingDays() {
    return state.missingDates.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Entity select
  // ---------------------------------------------------------------------------
  function populateEntitySelect() {
    const isStock = state.entityType === 'stock';
    els.entityLabel.textContent = isStock ? 'Stock' : 'Broker';

    const list = isStock ? state.stockOrder : state.brokerOrder;
    if (!list.length) {
      els.entitySelect.replaceChildren(new Option('No data', ''));
      els.entitySelect.disabled = true;
      state.entity = null;
      return;
    }

    els.entitySelect.disabled = false;
    const fragment = document.createDocumentFragment();

    for (const item of list) {
      const key = isStock ? item.symbol : item.key;
      const label = isStock ? item.symbol : `${item.id} — ${item.name}`;
      fragment.append(new Option(label, key));
    }
    els.entitySelect.replaceChildren(fragment);

    const keys = new Set(list.map((item) => (isStock ? item.symbol : item.key)));
    const desired = state.entity && keys.has(state.entity) ? state.entity : state.lastEntity[state.entityType];
    const value = desired && keys.has(desired) ? desired : isStock ? list[0].symbol : list[0].key;

    els.entitySelect.value = value;
    state.entity = value;
    state.lastEntity[state.entityType] = value;
  }

  function onEntityChange() {
    state.entity = els.entitySelect.value;
    state.lastEntity[state.entityType] = state.entity;
    state.selected = new Set();
    state.autoSelection = true;
    els.seriesSearch.value = '';
    savePrefs();
    renderAll();
  }

  function onTabChange(view) {
    if (view === state.entityType) return;
    state.entityType = view;
    state.entity = state.lastEntity[view];
    state.selected = new Set();
    state.autoSelection = true;
    els.seriesSearch.value = '';
    syncControlsFromState();
    populateEntitySelect();
    savePrefs();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  function ensureChart() {
    if (state.chart) return state.chart;
    if (typeof Chart === 'undefined') return null;

    Chart.defaults.color = '#91a0b8';
    Chart.defaults.borderColor = 'rgba(34, 48, 77, 0.65)';
    Chart.defaults.font.family =
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

    state.chart = new Chart(els.chart.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'nearest',
            intersect: true,
            backgroundColor: 'rgba(10, 15, 28, 0.96)',
            borderColor: '#22304d',
            borderWidth: 1,
            titleColor: '#e7edf8',
            bodyColor: '#c9d5e8',
            padding: 10,
            callbacks: {
              label(context) {
                const value = context.parsed.y || 0;
                const cash = metricIsCash();
                const pair = state.rankedPairs.find((entry) => entry.key === context.dataset.key);
                const pointIndex = state.window.start + context.dataIndex;
                const at = pair ? findPoint(pair.series, pointIndex) : -1;
                const valueText = `${cash ? 'Rs ' : ''}${fmtSignedQty(value)}`;
                let text = `${context.dataset.fullLabel}: ${valueText}`;
                if (at >= 0) {
                  const points = state.points;
                  text += cash ? ` · day ${fmtRsSigned(points.nc[at])}` : ` · day ${fmtSignedQty(points.nq[at])}`;
                }
                return text;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              autoSkip: true,
              maxTicksLimit: 12,
              maxRotation: 0,
              callback(value) {
                const label = this.getLabelForValue(value);
                return state.tickFullDate ? label : label.slice(5);
              },
            },
          },
          y: {
            grid: { color: 'rgba(34, 48, 77, 0.5)' },
            ticks: {
              callback(value) {
                return compact(value);
              },
            },
            title: { display: true, text: 'Net kitta' },
          },
        },
      },
    });

    return state.chart;
  }

  function seriesValues(series, window, metric) {
    const points = state.points;
    const cash = metricIsCash(metric);
    const cumulative = metricIsCumulative(metric);
    const values = new Array(window.end - window.start + 1);

    let cursor = series.start;
    while (cursor < series.end && points.day[cursor] < window.start) cursor += 1;

    if (cumulative) {
      // Cumulative runs inside the selected window only, matching the range the
      // chart title and the summary table report.
      let cumulativeQty = 0;
      let cumulativeCash = 0;
      for (let index = window.start; index <= window.end; index += 1) {
        if (cursor < series.end && points.day[cursor] === index) {
          cumulativeQty += points.nq[cursor];
          cumulativeCash += points.nc[cursor];
          cursor += 1;
        }
        values[index - window.start] = cash ? cumulativeCash : cumulativeQty;
      }
    } else {
      values.fill(0);
      for (; cursor < series.end; cursor += 1) {
        const day = points.day[cursor];
        if (day > window.end) break;
        values[day - window.start] = cash ? points.nc[cursor] : points.nq[cursor];
      }
    }

    return values;
  }

  function valueAtWindowEnd(series, window, metric) {
    const points = state.points;
    const cash = metricIsCash(metric);
    if (metricIsCumulative(metric)) {
      let qty = 0;
      let cashTotal = 0;
      eachPoint(series, window, (at) => {
        qty += points.nq[at];
        cashTotal += points.nc[at];
      });
      return cash ? cashTotal : qty;
    }
    const at = findPoint(series, window.end);
    if (at < 0) return 0;
    return cash ? points.nc[at] : points.nq[at];
  }

  function renderChart(window, ranked) {
    const chart = ensureChart();
    if (!chart) return;

    const sideOrder = { accum: 0, dist: 1, flat: 2 };
    const selected = ranked
      .filter((pair) => state.selected.has(pair.key))
      .sort((a, b) => sideOrder[a.side] - sideOrder[b.side] || b.rank - a.rank);
    const cash = metricIsCash();
    const cumulative = metricIsCumulative();

    const datasets = selected.map((pair) => {
      const data = seriesValues(pair.series, window, state.metric);
      const label = pairLabel(pair.key);
      const side = pair.side;
      const base = {
        label,
        fullLabel: `${label} · ${sideLabel(side)}`,
        key: pair.key,
        side,
        sideLabel: sideLabel(side),
        data,
        borderColor: pair.color,
        backgroundColor: pair.color,
      };

      if (cumulative) {
        return {
          ...base,
          type: 'line',
          borderWidth: 2,
          borderDash: side === 'dist' ? [6, 4] : [],
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 12,
          tension: 0.18,
          fill: false,
        };
      }

      return {
        ...base,
        type: 'bar',
        borderWidth: 0,
        borderRadius: 3,
        barPercentage: 0.85,
        categoryPercentage: 0.82,
      };
    });

    state.tickFullDate =
      window.dates.length > 1 && window.dates[0].slice(0, 4) !== window.dates[window.dates.length - 1].slice(0, 4);

    chart.data.labels = window.dates;
    chart.data.datasets = datasets;
    chart.options.scales.y.title.text = cash ? 'Net cash (Rs)' : 'Net kitta';
    chart.update();
  }

  function clearChart() {
    if (!state.chart) return;
    state.chart.data.labels = [];
    state.chart.data.datasets = [];
    state.chart.update();
  }

  // ---------------------------------------------------------------------------
  // Series controls
  // ---------------------------------------------------------------------------
  function renderSeriesList() {
    const fragment = document.createDocumentFragment();
    const filter = els.seriesSearch.value.trim().toLowerCase();
    let shown = 0;

    for (const pair of state.rankedPairs) {
      const label = pairLabel(pair.key);
      if (filter && !label.toLowerCase().includes(filter)) continue;
      shown += 1;

      const item = document.createElement('div');
      item.className = 'series-item';

      const wrapper = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = pair.key;
      checkbox.checked = state.selected.has(pair.key);

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = pair.color;

      const name = document.createElement('span');
      name.className = 'series-name';
      name.textContent = label;
      name.title = label;

      const tag = document.createElement('span');
      tag.className = `series-tag ${pair.side}`;
      tag.textContent = pair.side === 'accum' ? 'ACC' : pair.side === 'dist' ? 'DIST' : 'FLAT';
      tag.title = `${sideLabel(pair.side)} in selected range: ${fmtSignedQty(pair.netQty)} net qty`;

      wrapper.append(checkbox, swatch, name, tag);

      const value = valueAtWindowEnd(pair.series, state.window, state.metric);
      const valueEl = document.createElement('span');
      valueEl.className = `series-value ${signClass(value)}`.trim();
      valueEl.title = 'Value at the end of the chart';
      valueEl.textContent = metricIsCash()
        ? `Rs ${compact(value)}`
        : fmtSignedQty(value);

      item.append(wrapper, valueEl);
      fragment.append(item);
    }

    if (!shown) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = filter ? 'No series match that filter.' : 'No series available.';
      fragment.append(empty);
    }

    els.seriesList.replaceChildren(fragment);

    const noun = state.entityType === 'stock' ? 'brokers' : 'stocks';
    els.seriesCount.textContent = `${state.selected.size} of ${state.rankedPairs.length} ${noun} shown`;
  }

  function onSeriesToggle(event) {
    if (!event.target.matches('input[type="checkbox"]')) return;
    const key = event.target.value;
    if (event.target.checked) state.selected.add(key);
    else state.selected.delete(key);
    state.autoSelection = false;

    renderChart(state.window, state.rankedPairs);
    const noun = state.entityType === 'stock' ? 'brokers' : 'stocks';
    els.seriesCount.textContent = `${state.selected.size} of ${state.rankedPairs.length} ${noun} shown`;

    const entity = currentEntity();
    if (entity) updateHeadings(state.window, entity, state.rankedPairs);
  }

  // ---------------------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------------------
  function makeCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function clearTable() {
    if (els.summaryTable.tHead) els.summaryTable.tHead.replaceChildren();
    if (els.summaryTable.tBodies[0]) els.summaryTable.tBodies[0].replaceChildren();
    if (els.summaryTable.tFoot) els.summaryTable.tFoot.replaceChildren();
    els.tableTitle.textContent = 'Summary';
    els.tableHint.textContent = '';
    els.entityMeta.textContent = '';
  }

  function tableValue(row, key) {
    switch (key) {
      case 'label':
        return pairLabel(row.key);
      case 'buyQty':
        return row.totals.buyQty;
      case 'sellQty':
        return row.totals.sellQty;
      case 'netQty':
        return row.totals.netQty;
      case 'netCash':
        return row.totals.netCash;
      case 'gross':
        return row.totals.gross;
      case 'buyVwap':
        return row.totals.buyQty > 0 ? row.totals.buyAmount / row.totals.buyQty : 0;
      case 'sellVwap':
        return row.totals.sellQty > 0 ? row.totals.sellAmount / row.totals.sellQty : 0;
      default:
        return 0;
    }
  }

  function compareTableRows(a, b, sort) {
    const direction = sort.dir === 'asc' ? 1 : -1;
    let result;
    if (sort.key === 'label') {
      result = pairLabel(a.key).localeCompare(pairLabel(b.key), undefined, { numeric: true, sensitivity: 'base' });
    } else {
      result = tableValue(a, sort.key) - tableValue(b, sort.key);
    }
    if (result !== 0) return result * direction;
    return pairLabel(a.key).localeCompare(pairLabel(b.key), undefined, { numeric: true, sensitivity: 'base' });
  }

  function renderTable(window, entity) {
    const isStock = entity.type === 'stock';
    const noun = isStock ? 'Broker' : 'Stock';
    const rows = [];

    for (const [key, series] of entity.pairs) {
      if (!hasTradeInWindow(series, window)) continue;
      const totals = aggregate(series, window);
      rows.push({ key, totals });
    }

    if (state.tableSort) {
      rows.sort((a, b) => compareTableRows(a, b, state.tableSort));
    } else {
      rows.sort((a, b) => Math.abs(b.totals.netQty) - Math.abs(a.totals.netQty) || b.totals.gross - a.totals.gross);
    }

    const columns = [
      { key: 'label', label: noun },
      { key: 'buyQty', label: 'Buy Qty' },
      { key: 'sellQty', label: 'Sell Qty' },
      { key: 'netQty', label: 'Net Qty' },
      { key: 'netCash', label: 'Net Cash' },
      { key: 'gross', label: 'Gross Turnover' },
      { key: 'buyVwap', label: 'Buy VWAP' },
      { key: 'sellVwap', label: 'Sell VWAP' },
    ];

    let head = els.summaryTable.tHead;
    if (!head) head = els.summaryTable.createTHead();
    head.replaceChildren();
    const headRow = document.createElement('tr');
    for (const column of columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.dataset.sortKey = column.key;
      th.classList.add('sortable');
      th.tabIndex = 0;
      th.title = `Sort by ${column.label}`;
      if (state.tableSort && state.tableSort.key === column.key) {
        th.setAttribute('aria-sort', state.tableSort.dir === 'asc' ? 'ascending' : 'descending');
      }
      const text = document.createElement('span');
      text.textContent = column.label;
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent =
        state.tableSort && state.tableSort.key === column.key ? (state.tableSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      th.append(text, arrow);
      headRow.append(th);
    }
    head.append(headRow);

    let body = els.summaryTable.tBodies[0];
    if (!body) body = els.summaryTable.createTBody();
    body.replaceChildren();

    let footer = els.summaryTable.tFoot;
    if (!footer) footer = els.summaryTable.createTFoot();
    footer.replaceChildren();

    const totals = {
      buyQty: 0,
      buyAmount: 0,
      sellQty: 0,
      sellAmount: 0,
      netQty: 0,
      netCash: 0,
      gross: 0,
    };

    for (const row of rows) {
      const value = row.totals;
      const tr = document.createElement('tr');
      tr.append(
        makeCell(pairLabel(row.key)),
        makeCell(fmtInt(value.buyQty)),
        makeCell(fmtInt(value.sellQty)),
        makeCell(fmtSignedQty(value.netQty), signClass(value.netQty)),
        makeCell(fmtRsSigned(value.netCash), signClass(value.netCash)),
        makeCell(fmtRs(value.gross)),
        makeCell(fmtVwap(value.buyQty > 0 ? value.buyAmount / value.buyQty : 0)),
        makeCell(fmtVwap(value.sellQty > 0 ? value.sellAmount / value.sellQty : 0)),
      );
      body.append(tr);

      totals.buyQty += value.buyQty;
      totals.buyAmount += value.buyAmount;
      totals.sellQty += value.sellQty;
      totals.sellAmount += value.sellAmount;
      totals.netQty += value.netQty;
      totals.netCash += value.netCash;
      totals.gross += value.gross;
    }

    if (rows.length) {
      const totalRow = document.createElement('tr');
      totalRow.className = 'total-row';
      totalRow.append(
        makeCell('Total'),
        makeCell(fmtInt(totals.buyQty)),
        makeCell(fmtInt(totals.sellQty)),
        makeCell(fmtSignedQty(totals.netQty), signClass(totals.netQty)),
        makeCell(fmtRsSigned(totals.netCash), signClass(totals.netCash)),
        makeCell(fmtRs(totals.gross)),
        makeCell(fmtVwap(totals.buyQty > 0 ? totals.buyAmount / totals.buyQty : 0)),
        makeCell(fmtVwap(totals.sellQty > 0 ? totals.sellAmount / totals.sellQty : 0)),
      );
      footer.append(totalRow);
    }

    const first = window.dates[0] || '—';
    const last = window.dates[window.dates.length - 1] || '—';

    els.tableTitle.textContent = isStock
      ? `${entity.data.symbol} — broker summary`
      : `TMS ${entity.data.id} — stock summary`;
    els.tableHint.textContent = `${rows.length} ${isStock ? 'broker' : 'stock'}${rows.length === 1 ? '' : 's'} · ${first} → ${last}`;
    if (!rows.length) {
      els.entityMeta.textContent = 'No trades in the selected range';
    } else if (isStock) {
      // Across every broker of one stock, net qty nets out to zero, so gross is the useful total.
      els.entityMeta.textContent = `${rows.length} brokers · gross Rs ${compact(totals.gross)}`;
    } else {
      els.entityMeta.textContent = `${rows.length} stocks · net ${fmtSignedQty(totals.netQty)} · gross Rs ${compact(totals.gross)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Headings / render
  // ---------------------------------------------------------------------------
  function selectionDescription(ranked, noun) {
    if (!state.selected.size) {
      if (state.flowMode === 'accum' && !ranked.some((pair) => pair.side === 'accum')) {
        return 'No accumulators in this range — try another mode';
      }
      if (state.flowMode === 'dist' && !ranked.some((pair) => pair.side === 'dist')) {
        return 'No distributors in this range — try another mode';
      }
      return `No ${noun} selected — use the checkboxes below`;
    }

    const selected = ranked.filter((pair) => state.selected.has(pair.key));
    const accumulators = selected.filter((pair) => pair.side === 'accum').length;
    const distributors = selected.filter((pair) => pair.side === 'dist').length;

    if (state.flowMode === 'both') {
      if (!distributors) return `${accumulators} accumulator${accumulators === 1 ? '' : 's'} — no distributors in range`;
      if (!accumulators) return `${distributors} distributor${distributors === 1 ? '' : 's'} — no accumulators in range`;
      if (state.topN === 'all' && state.selected.size === ranked.length) return `all ${ranked.length} ${noun}`;
      return `${accumulators} accumulator${accumulators === 1 ? '' : 's'} vs ${distributors} distributor${distributors === 1 ? '' : 's'} of ${ranked.length} ${noun}`;
    }

    if (state.selected.size === ranked.length) {
      return `all ${ranked.length} ${noun}`;
    }
    if (state.flowMode === 'accum') {
      return `${accumulators} accumulator${accumulators === 1 ? '' : 's'} of ${ranked.length} ${noun}`;
    }
    return `${distributors} distributor${distributors === 1 ? '' : 's'} of ${ranked.length} ${noun}`;
  }

  function updateHeadings(window, entity, ranked) {
    if (entity.type === 'stock') {
      els.chartTitle.textContent = `${entity.data.symbol} — broker net kitta`;
    } else {
      els.chartTitle.textContent = `TMS ${entity.data.id} — stock net kitta`;
    }

    const first = window.dates[0] || '—';
    const last = window.dates[window.dates.length - 1] || '—';
    const parts = [];

    if (metricIsCumulative() && state.dates.length) {
      parts.push(`Cumulative since ${window.dates[0]}`);
    }
    parts.push(`Showing ${window.dates.length} day${window.dates.length === 1 ? '' : 's'} (${first} → ${last})`);

    if (entity.type === 'broker') {
      parts.push(entity.data.name);
    }

    const noun = entity.type === 'stock' ? 'brokers' : 'stocks';
    parts.push(selectionDescription(ranked, noun));
    if (state.selected.size) parts.push('ranked by net qty in range');
    parts.push(METRIC_LABELS[state.metric]);

    els.chartHint.textContent = parts.join(' · ');
    els.chartHint.classList.toggle('warn', warningsForMissingDays());

    if (warningsForMissingDays()) {
      const dates = state.missingDates.slice(0, 4).join(', ');
      const suffix = state.missingDates.length > 4 ? '…' : '';
      els.chartHint.textContent += ` · ⚠ missing ${state.missingDates.length} day(s): ${dates}${suffix}`;
    }
  }

  function renderAll() {
    ensureChart();
    const window = getWindow();
    state.window = window;

    const entity = currentEntity();
    const ranked = entity ? rankPairs(window) : [];
    state.rankedPairs = ranked;

    if (!entity || !state.dates.length) {
      els.chartTitle.textContent = 'No data';
      els.chartHint.textContent = 'Press “Sync data” to load the archive.';
      els.chartHint.classList.remove('warn');
      els.seriesCount.textContent = '';
      els.seriesList.replaceChildren();
      clearChart();
      clearTable();
      return;
    }

    const available = new Set(ranked.map((pair) => pair.key));
    for (const key of [...state.selected]) {
      if (!available.has(key)) state.selected.delete(key);
    }
    if (state.autoSelection) {
      state.selected = topSelection(ranked);
    }

    renderChart(window, ranked);
    renderSeriesList();
    renderTable(window, entity);
    updateHeadings(window, entity, ranked);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function onTableSort(event) {
    const th = event.target.closest('th[data-sort-key]');
    if (!th) return;
    const key = th.dataset.sortKey;
    if (state.tableSort && state.tableSort.key === key) {
      state.tableSort.dir = state.tableSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.tableSort = { key, dir: key === 'label' ? 'asc' : 'desc' };
    }
    const window = getWindow();
    const entity = currentEntity();
    if (entity) renderTable(window, entity);
  }

  function bindEvents() {
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => onTabChange(tab.dataset.view));
    });

    els.rangeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        changeRange(button.dataset.range);
      });
    });

    els.metric.addEventListener('change', () => {
      state.metric = els.metric.value;
      savePrefs();
      renderAll();
    });

    els.flowMode.addEventListener('change', () => {
      state.flowMode = els.flowMode.value;
      state.selected = new Set();
      state.autoSelection = true;
      syncControlsFromState();
      savePrefs();
      renderAll();
    });

    els.topN.addEventListener('change', () => {
      state.topN = els.topN.value === 'all' ? 'all' : Number(els.topN.value);
      state.selected = new Set();
      state.autoSelection = true;
      syncCountControl();
      savePrefs();
      renderAll();
    });

    els.entitySelect.addEventListener('change', onEntityChange);
    els.seriesList.addEventListener('change', onSeriesToggle);

    els.seriesSearch.addEventListener(
      'input',
      debounce(() => renderSeriesList(), 120),
    );

    els.summaryTable.addEventListener('click', onTableSort);
    els.summaryTable.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const th = event.target.closest('th[data-sort-key]');
      if (!th) return;
      event.preventDefault();
      onTableSort(event);
    });

    els.syncBtn.addEventListener('click', () => sync({ force: true }));

    els.clearCache.addEventListener('click', async () => {
      const confirmed = window.confirm(
        'Clear cached summary data and settings? The next sync will download everything again from GitHub.',
      );
      if (!confirmed) return;
      await state.cache.clear();
      try {
        localStorage.removeItem(DATE_CACHE_KEY);
        localStorage.removeItem(PREFS_KEY);
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

    if (typeof Chart === 'undefined') {
      setStatus('Chart.js failed to load — run from a local web server, not file://', 'error');
      return;
    }
    if (typeof Papa === 'undefined') {
      setStatus('PapaParse failed to load — run from a local web server, not file://', 'error');
      return;
    }

    state.cache = createCache();
    loadPrefs();
    syncControlsFromState();
    bindEvents();
    ensureChart();

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
