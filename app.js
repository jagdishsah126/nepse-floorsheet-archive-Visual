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

  const DB_NAME = 'nepse-visual';
  const DB_VERSION = 1;
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

  const PALETTE = [
    '#5b8def', '#2fbf71', '#e0a33a', '#e15b64', '#a879e8',
    '#3cc7d4', '#f08a5d', '#8bd450', '#f2c94c', '#6f9bd8',
    '#d96fa3', '#4ecdc4', '#c07f00', '#7e6bff', '#ff8fab',
    '#00b4a6', '#b5c7ff', '#ffd166', '#ef476f', '#06d6a0',
  ];

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

    // view
    entityType: 'stock',
    entity: null,
    lastEntity: { stock: null, broker: null },
    range: 'all',
    metric: 'cum_qty',
    topN: 5,
    selected: new Set(),

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

  function colorAt(index) {
    if (index < PALETTE.length) return PALETTE[index];
    return `hsl(${Math.round((index * 137.508) % 360)} 68% 62%)`;
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
    let dbPromise = null;
    let broken = !('indexedDB' in window);

    function open() {
      if (broken) return Promise.reject(new Error('IndexedDB unavailable'));
      if (dbPromise) return dbPromise;

      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE, { keyPath: 'date' });
          }
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
      memory.set(day.date, day);
      if (broken) return;
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

    return { get, put, listDates, clear };
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

    const rows = [];
    for (const row of parsed.data) {
      const brokerId = String(row.broker_id ?? '').trim();
      const symbol = String(row.stock_symbol ?? '').trim();
      if (!brokerId || !symbol) continue;

      rows.push([
        Number(brokerId),
        String(row.broker_name ?? '').trim(),
        symbol,
        num(row.buy_qty),
        num(row.buy_amount),
        num(row.sell_qty),
        num(row.sell_amount),
        num(row.net_qty),
        num(row.net_cash),
        num(row.gross_turnover),
      ]);
    }

    if (!rows.length) throw new Error('no data rows found');
    return { date, rows, fetchedAt: Date.now() };
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

  function buildIndex(dayMap) {
    state.dates = [...dayMap.keys()].sort();
    state.stocks = new Map();
    state.brokers = new Map();

    const pairs = new Map();

    for (let dayIndex = 0; dayIndex < state.dates.length; dayIndex += 1) {
      const day = dayMap.get(state.dates[dayIndex]);
      for (const row of day.rows) {
        const [brokerId, brokerName, symbol, buyQty, buyAmount, sellQty, sellAmount, netQty, netCash, gross] = row;
        const brokerKey = String(brokerId);
        if (!brokerKey || !symbol) continue;

        const broker = getOrCreateBroker(brokerKey, Number(brokerId), brokerName);
        const stock = getOrCreateStock(symbol);

        const pairKey = `${brokerKey}\u0000${symbol}`;
        let series = pairs.get(pairKey);
        if (!series) {
          series = {
            brokerKey,
            symbol,
            points: new Map(),
          };
          pairs.set(pairKey, series);
          broker.stocks.set(symbol, series);
          stock.brokers.set(brokerKey, series);
        }

        const point = series.points.get(dayIndex);
        if (point) {
          point.nq += netQty;
          point.nc += netCash;
          point.bq += buyQty;
          point.sq += sellQty;
          point.ba += buyAmount;
          point.sa += sellAmount;
          point.gt += gross;
        } else {
          series.points.set(dayIndex, {
            nq: netQty,
            nc: netCash,
            bq: buyQty,
            sq: sellQty,
            ba: buyAmount,
            sa: sellAmount,
            gt: gross,
          });
        }

        broker.totalGross += gross;
        stock.totalGross += gross;
      }
    }

    state.stockOrder = [...state.stocks.values()].sort(
      (a, b) => b.totalGross - a.totalGross || a.symbol.localeCompare(b.symbol),
    );
    state.brokerOrder = [...state.brokers.values()].sort(
      (a, b) => b.totalGross - a.totalGross || a.id - b.id,
    );
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
      let cumulativeQty = 0;
      for (const [index, point] of series.points) {
        if (index <= window.end) cumulativeQty += point.nq;
      }
      ranked.push({ key, series, rank: Math.abs(cumulativeQty), cumulativeQty });
    }

    ranked.sort((a, b) => b.rank - a.rank || pairLabel(a.key).localeCompare(pairLabel(b.key)));
    ranked.forEach((pair, index) => {
      pair.color = colorAt(index);
    });
    return ranked;
  }

  function topSelection(ranked) {
    const limit = state.topN === 'all' ? ranked.length : Math.min(Number(state.topN), ranked.length);
    return new Set(ranked.slice(0, limit).map((pair) => pair.key));
  }

  function hasTradeInWindow(series, window) {
    for (let index = window.start; index <= window.end; index += 1) {
      if (series.points.has(index)) return true;
    }
    return false;
  }

  function aggregate(series, window) {
    let buyQty = 0;
    let buyAmount = 0;
    let sellQty = 0;
    let sellAmount = 0;
    let netQty = 0;
    let netCash = 0;
    let gross = 0;

    for (let index = window.start; index <= window.end; index += 1) {
      const point = series.points.get(index);
      if (!point) continue;
      buyQty += point.bq;
      buyAmount += point.ba;
      sellQty += point.sq;
      sellAmount += point.sa;
      netQty += point.nq;
      netCash += point.nc;
      gross += point.gt;
    }

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
      if (prefs.range === 'all' || [5, 10, 30].includes(Number(prefs.range))) {
        state.range = prefs.range === 'all' ? 'all' : Number(prefs.range);
      }
      if (METRIC_LABELS[prefs.metric]) state.metric = prefs.metric;
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
    els.topN.value = String(state.topN);
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------
  async function sync({ force = false } = {}) {
    if (state.busy) return;

    setBusy(true);
    setStatus('Checking Summary/ …', 'busy');
    const failures = [];

    try {
      const { dates, source, warning } = await resolveDates(force);
      if (warning) console.warn('Using cached date list:', warning.message);

      if (!dates.length) throw new Error('No summary files found in the archive');

      setStatus(`Checking cached days (${dates.length})…`, 'busy');

      const cachedRecords = await Promise.all(dates.map((date) => state.cache.get(date)));
      const dayMap = new Map();
      cachedRecords.forEach((record, index) => {
        if (record && Array.isArray(record.rows) && record.rows.length) {
          dayMap.set(dates[index], record);
        }
      });

      const missing = dates.filter((date) => !dayMap.has(date));
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

      if (!dayMap.size) {
        throw new Error(
          failures.length
            ? `Could not download any summary (${failures[0].date}: ${failures[0].message})`
            : 'No summary data available',
        );
      }

      setStatus('Building index…', 'busy');
      await new Promise((resolve) => setTimeout(resolve, 0));

      buildIndex(dayMap);
      state.missingDates = dates.filter((date) => !dayMap.has(date));

      const wasEmpty = !state.entity;
      if (!state.entity) {
        state.entity = state.lastEntity[state.entityType];
      }

      populateEntitySelect();
      syncControlsFromState();

      if (wasEmpty || !state.selected.size) {
        state.selected = topSelection(rankPairs(getWindow()));
      }

      renderAll();

      const counts = `${state.dates.length} days · ${state.brokers.size} brokers · ${state.stocks.size} scrips`;
      if (state.missingDates.length) {
        setStatus(`Ready with ${state.missingDates.length} missing day(s) · ${counts}`, 'warn');
      } else if (source === 'api' || source === 'cache') {
        setStatus(`Ready · ${counts}`, 'ready');
      } else {
        setStatus(`Ready · ${counts} · offline date list`, 'warn');
      }

      if (warningsForMissingDays()) {
        console.warn('Missing summary days:', state.missingDates, failures);
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Failed to load data', 'error');
      if (!state.dates.length) {
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
    els.seriesSearch.value = '';
    savePrefs();
    renderAll();
  }

  function onTabChange(view) {
    if (view === state.entityType) return;
    state.entityType = view;
    state.entity = state.lastEntity[view];
    state.selected = new Set();
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
        interaction: { mode: 'index', intersect: false },
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
                const value = context.parsed.y || 0;
                const cash = metricIsCash();
                const pair = state.rankedPairs.find((entry) => entry.key === context.dataset.key);
                const pointIndex = state.window.start + context.dataIndex;
                const point = pair ? pair.series.points.get(pointIndex) : null;
                const valueText = `${cash ? 'Rs ' : ''}${fmtSignedQty(value)}`;
                let text = `${context.dataset.fullLabel}: ${valueText}`;
                if (point) {
                  text += cash ? ` · day ${fmtRsSigned(point.nc)}` : ` · day ${fmtSignedQty(point.nq)}`;
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
    const cash = metricIsCash(metric);
    const cumulative = metricIsCumulative(metric);
    const values = new Array(window.end - window.start + 1);

    if (cumulative) {
      let cumulativeQty = 0;
      let cumulativeCash = 0;
      for (const [index, point] of series.points) {
        if (index < window.start) {
          cumulativeQty += point.nq;
          cumulativeCash += point.nc;
        }
      }
      for (let index = window.start; index <= window.end; index += 1) {
        const point = series.points.get(index);
        if (point) {
          cumulativeQty += point.nq;
          cumulativeCash += point.nc;
        }
        values[index - window.start] = cash ? cumulativeCash : cumulativeQty;
      }
    } else {
      for (let index = window.start; index <= window.end; index += 1) {
        const point = series.points.get(index);
        values[index - window.start] = point ? (cash ? point.nc : point.nq) : 0;
      }
    }

    return values;
  }

  function valueAtWindowEnd(series, window, metric) {
    const cash = metricIsCash(metric);
    if (metricIsCumulative(metric)) {
      let qty = 0;
      let cashTotal = 0;
      for (const [index, point] of series.points) {
        if (index <= window.end) {
          qty += point.nq;
          cashTotal += point.nc;
        }
      }
      return cash ? cashTotal : qty;
    }
    const point = series.points.get(window.end);
    if (!point) return 0;
    return cash ? point.nc : point.nq;
  }

  function renderChart(window, ranked) {
    const chart = ensureChart();
    if (!chart) return;

    const selected = ranked.filter((pair) => state.selected.has(pair.key));
    const cash = metricIsCash();
    const cumulative = metricIsCumulative();

    const datasets = selected.map((pair) => {
      const data = seriesValues(pair.series, window, state.metric);
      const label = pairLabel(pair.key);
      const base = {
        label,
        fullLabel: label,
        key: pair.key,
        data,
        borderColor: pair.color,
        backgroundColor: pair.color,
      };

      if (cumulative) {
        return {
          ...base,
          type: 'line',
          borderWidth: 2,
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

      wrapper.append(checkbox, swatch, name);

      const value = valueAtWindowEnd(pair.series, state.window, state.metric);
      const valueEl = document.createElement('span');
      valueEl.className = `series-value ${signClass(value)}`.trim();
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

    renderChart(state.window, state.rankedPairs);
    const noun = state.entityType === 'stock' ? 'brokers' : 'stocks';
    els.seriesCount.textContent = `${state.selected.size} of ${state.rankedPairs.length} ${noun} shown`;
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

  function renderTable(window, entity) {
    const isStock = entity.type === 'stock';
    const noun = isStock ? 'Broker' : 'Stock';
    const rows = [];

    for (const [key, series] of entity.pairs) {
      if (!hasTradeInWindow(series, window)) continue;
      const totals = aggregate(series, window);
      rows.push({ key, totals });
    }

    rows.sort((a, b) => Math.abs(b.totals.netQty) - Math.abs(a.totals.netQty) || b.totals.gross - a.totals.gross);

    const columns = [
      noun,
      'Buy Qty',
      'Sell Qty',
      'Net Qty',
      'Net Cash',
      'Gross Turnover',
      'Buy VWAP',
      'Sell VWAP',
    ];

    let head = els.summaryTable.tHead;
    if (!head) head = els.summaryTable.createTHead();
    head.replaceChildren();
    const headRow = document.createElement('tr');
    for (const column of columns) {
      const th = document.createElement('th');
      th.textContent = column;
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
  function updateHeadings(window, entity, ranked) {
    if (entity.type === 'stock') {
      els.chartTitle.textContent = `${entity.data.symbol} — broker net kitta`;
    } else {
      els.chartTitle.textContent = `TMS ${entity.data.id} — stock net kitta`;
    }

    const first = window.dates[0] || '—';
    const last = window.dates[window.dates.length - 1] || '—';
    const parts = [];

    if (metricIsCumulative() && window.start > 0 && state.dates.length) {
      parts.push(`Cumulative since ${state.dates[0]}`);
    }
    parts.push(`Showing ${window.dates.length} day${window.dates.length === 1 ? '' : 's'} (${first} → ${last})`);

    if (entity.type === 'broker') {
      parts.push(entity.data.name);
    }

    const noun = entity.type === 'stock' ? 'brokers' : 'stocks';
    const limit = state.topN === 'all' ? 'all' : `top ${Math.min(Number(state.topN), ranked.length)} of`;
    parts.push(`${limit} ${ranked.length} ${noun} by absolute net kitta`);
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
    if (!state.selected.size) {
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
  function bindEvents() {
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => onTabChange(tab.dataset.view));
    });

    els.rangeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.dataset.range;
        state.range = value === 'all' ? 'all' : Number(value);
        syncControlsFromState();
        savePrefs();
        renderAll();
      });
    });

    els.metric.addEventListener('change', () => {
      state.metric = els.metric.value;
      savePrefs();
      renderAll();
    });

    els.topN.addEventListener('change', () => {
      state.topN = els.topN.value === 'all' ? 'all' : Number(els.topN.value);
      state.selected = new Set();
      savePrefs();
      renderAll();
    });

    els.entitySelect.addEventListener('change', onEntityChange);
    els.seriesList.addEventListener('change', onSeriesToggle);

    els.seriesSearch.addEventListener(
      'input',
      debounce(() => renderSeriesList(), 120),
    );

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
