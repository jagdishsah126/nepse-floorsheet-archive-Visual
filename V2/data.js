/*
 * NEPSE Flow V2 — data layer.
 * Range-scoped loader for Summary/<date>_brokers.csv with an IndexedDB cache
 * shared with the v1 dashboard. Exposes window.V2Data.
 *
 * Memory model (mirrors the v1 dashboard): only the selected trailing window is
 * downloaded, parsed into columnar typed arrays, and indexed as flat per-pair
 * slices. `pair.points` keeps its old Map-like `get(dayIndex)` interface so the
 * view code is unchanged, but it is served by binary search into the compact
 * columnar index — no points are stored as per-day objects.
 *
 * When the archive publishes Summary/manifest.json (future.md §1) the GitHub
 * Trees API listing is skipped entirely; until then the API is the fallback.
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

  // Dev/testing hook: ?base=<url> points the loader at a local Summary dir
  // instead of the live archive (e.g. ?base=/Summary against a mock server).
  const QUERY_BASE = new URLSearchParams(window.location.search).get('base');
  const RAW_SUMMARY = QUERY_BASE
    ? QUERY_BASE.replace(/\/+$/, '')
    : `https://raw.githubusercontent.com/${DATA_REPO}/${BRANCH}/${SUMMARY_DIR}`;

  const CONCURRENCY = 4;
  const FETCH_TIMEOUT_MS = 45000;
  const MANIFEST_TIMEOUT_MS = 8000;
  const DATE_CACHE_KEY = 'nepse.summaryDates.v1'; // shared with v1
  const MANIFEST_CACHE_KEY = 'nepse.v2.manifest.v1';
  const LISTING_TTL = 60 * 60 * 1000;

  // Interim storage model, shared with the v1 dashboard: the tab only ever
  // holds the selected trailing window. "All" is an explicit opt-in.
  const DEFAULT_RANGE = 60;
  const CACHE_DAYS = 120;
  const AVG_DAY_RAW_MB = 1.4;
  const AVG_DAY_GZIP_MB = 0.32;
  // Bytes per broker-stock-day point in the columnar index (2 + 4 + 8 + 32).
  const POINT_BYTES = 46;
  const AVG_ROWS_PER_DAY = 9600; // ≈ 4M rows over a 417-day archive

  const DB_NAME = 'nepse-visual'; // shared with v1
  const DB_VERSION = 2; // v2 records are compact typed arrays; one shared schema
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

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function num(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
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

  function trimCompact(value) {
    const abs = Math.abs(value);
    if (abs >= 100) return String(Math.round(value));
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

  function signClass(value) {
    if (value > 0) return 'pos';
    if (value < 0) return 'neg';
    return '';
  }

  // ---------------------------------------------------------------------------
  // IndexedDB cache (shared with v1; falls back to memory)
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
  // Date listing: manifest first, GitHub Trees API fallback
  // ---------------------------------------------------------------------------
  function readListingCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.dates) || typeof parsed.ts !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeListingCache(key, dates, extra = {}) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), dates, ...extra }));
    } catch {
      // Quota or private mode — the listing simply stays uncached.
    }
  }

  async function fetchWithTimeout(url, timeout, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { signal: controller.signal, headers });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves to null when the manifest does not exist (normal until it ships).
  async function fetchManifest() {
    try {
      const response = await fetchWithTimeout(
        `${RAW_SUMMARY}/manifest.json`,
        MANIFEST_TIMEOUT_MS,
        { Accept: 'application/json' },
      );
      if (!response.ok) return null;
      const manifest = await response.json();
      if (!Array.isArray(manifest.dates) || !manifest.dates.length) return null;
      return manifest;
    } catch {
      return null;
    }
  }

  async function apiJson(url, timeout = 25000) {
    const response = await fetchWithTimeout(url, timeout, {
      Accept: 'application/vnd.github+json',
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        const reset = response.headers.get('x-ratelimit-reset');
        const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : '';
        throw new Error(`GitHub API rate limit reached${when ? ` (resets around ${when})` : ''}`);
      }
      throw new Error(`GitHub API returned HTTP ${response.status}`);
    }
    return response.json();
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
    const cachedManifest = readListingCache(MANIFEST_CACHE_KEY);
    if (!force && cachedManifest && cachedManifest.dates.length && Date.now() - cachedManifest.ts < LISTING_TTL) {
      return {
        dates: cachedManifest.dates,
        source: 'manifest-cache',
        generatedAt: cachedManifest.generatedAt || '',
      };
    }

    const manifest = await fetchManifest();
    if (manifest) {
      const dates = uniqueSorted(manifest.dates);
      writeListingCache(MANIFEST_CACHE_KEY, dates, { generatedAt: manifest.generated_at || '' });
      return { dates, source: 'manifest', generatedAt: manifest.generated_at || '' };
    }

    const cached = readListingCache(DATE_CACHE_KEY);
    if (!force && cached && Date.now() - cached.ts < LISTING_TTL) {
      return { dates: cached.dates, source: 'cache', generatedAt: '' };
    }

    try {
      const dates = await fetchDatesFromApi();
      writeListingCache(DATE_CACHE_KEY, dates);
      return { dates, source: 'api', generatedAt: '' };
    } catch (error) {
      if (cached && cached.dates.length) {
        return { dates: cached.dates, source: 'stale-cache', generatedAt: '', warning: error };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Daily summary download + parse (columnar typed arrays)
  // ---------------------------------------------------------------------------
  async function fetchDay(date) {
    const url = `${RAW_SUMMARY}/${date}_brokers.csv`;
    const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let text = await response.text();
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
    // about POINT_BYTES bytes, so a 60-day window stays around 25-30 MB.
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
    const contracts = new Int32Array(capacity);

    const brokerSlot = new Map();
    const brokers = [];
    const brokerNames = [];
    const symbolSlot = new Map();
    const symbols = [];

    // One slot per (broker, symbol): duplicate rows for the same pair merge,
    // so everything downstream can rely on one point per pair per day.
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
      const contractsI = Math.round(num(row.contracts));

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
        contracts[at] = contractsI;
      } else {
        buyQty[at] += buyQtyI;
        buyAmount[at] += buyAmountI;
        sellQty[at] += sellQtyI;
        sellAmount[at] += sellAmountI;
        netQty[at] += netQtyI;
        netCash[at] += netCashI;
        gross[at] += grossI;
        contracts[at] += contractsI;
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
      contracts: contracts.subarray(0, n),
      fetchedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Index building (flat per-pair slices over columnar points)
  // ---------------------------------------------------------------------------
  function pointObjectOf(points, at) {
    return {
      bq: points.bq[at],
      ba: points.ba[at],
      sq: points.sq[at],
      sa: points.sa[at],
      nq: points.nq[at],
      nc: points.nc[at],
      gt: points.gt[at],
      ct: points.ct[at],
    };
  }

  function buildIndex(records) {
    if (!records.length) return null;

    const brokers = new Map();
    const stocks = new Map();
    const pairs = new Map(); // pairKey -> pair object (v2 app's convention)

    const sliceByBroker = new Map();
    const slices = [];
    const counts = [];
    let total = 0;

    function sliceFor(brokerKey, symbol, brokerName) {
      let bySymbol = sliceByBroker.get(brokerKey);
      if (!bySymbol) {
        bySymbol = new Map();
        sliceByBroker.set(brokerKey, bySymbol);
      }
      let slice = bySymbol.get(symbol);
      if (slice) return slice;

      let broker = brokers.get(brokerKey);
      if (!broker) {
        broker = { key: brokerKey, id: Number(brokerKey), name: brokerName || `TMS ${brokerKey}`, totalGross: 0, pairs: new Set() };
        brokers.set(brokerKey, broker);
      } else if (brokerName) {
        broker.name = brokerName;
      }

      let stock = stocks.get(symbol);
      if (!stock) {
        stock = { symbol, totalGross: 0, pairs: new Set() };
        stocks.set(symbol, stock);
      }

      const pair = { brokerKey, symbol, points: null };
      pairs.set(`${brokerKey}\u0000${symbol}`, pair);
      broker.pairs.add(`${brokerKey}\u0000${symbol}`);
      stock.pairs.add(`${brokerKey}\u0000${symbol}`);

      slice = { pair, broker, stock, brokerKey, symbol, start: 0, end: 0 };
      bySymbol.set(symbol, slice);
      slice.pid = slices.length;
      slices.push(slice);
      counts.push(0);
      return slice;
    }

    // Pass 1: intern broker-stock pairs and count their points so the index
    // can live in flat typed arrays. A pair's accumulated cells must be
    // contiguous, hence the two passes.
    for (const day of records) {
      const brokerKeyStrs = day.brokerKeyStrs || (day.brokerKeyStrs = day.brokers.map(String));
      const pairIds = new Uint32Array(day.n);
      for (let i = 0; i < day.n; i += 1) {
        const slice = sliceFor(brokerKeyStrs[day.brokerIdx[i]], day.symbols[day.symbolIdx[i]], day.brokerNames[day.brokerIdx[i]]);
        pairIds[i] = slice.pid;
        counts[slice.pid] += 1;
        total += 1;
      }
      day.pairIds = pairIds;
    }

    const starts = new Uint32Array(slices.length + 1);
    for (let pid = 0; pid < slices.length; pid += 1) {
      starts[pid + 1] = starts[pid] + counts[pid];
    }
    const cursor = starts.slice(0, slices.length);

    const points = {
      day: new Uint16Array(total),
      nq: new Int32Array(total),
      nc: new Float64Array(total),
      bq: new Int32Array(total),
      sq: new Int32Array(total),
      ba: new Float64Array(total),
      sa: new Float64Array(total),
      gt: new Float64Array(total),
      ct: new Int32Array(total),
    };

    // Pass 2: write the points. Records arrive in date order (day.index is the
    // position of the date in the archive's full date list), so every pair's
    // slice stays sorted by day, which the readers rely on.
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
        points.ct[at] = day.contracts[i];

        const slice = slices[pid];
        const gt = day.gross[i];
        slice.broker.totalGross += gt;
        slice.stock.totalGross += gt;
      }
      day.pairIds = null;
    }

    for (let pid = 0; pid < slices.length; pid += 1) {
      const slice = slices[pid];
      slice.start = starts[pid];
      slice.end = starts[pid + 1];

      // Map-like shim over the pair's slice: view code keeps calling
      // pair.points.get(day) but memory now holds one flat columnar array.
      slice.pair.points = {
        get(dayGlobalIndex) {
          let lo = slice.start;
          let hi = slice.end - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const d = points.day[mid];
            if (d === dayGlobalIndex) return pointObjectOf(points, mid);
            if (d < dayGlobalIndex) lo = mid + 1;
            else hi = mid - 1;
          }
          return undefined;
        },
      };
    }

    return { brokers, stocks, pairs, points, slices };
  }

  // ---------------------------------------------------------------------------
  // Window + aggregation
  // ---------------------------------------------------------------------------
  function windowOf(dates, range) {
    const total = dates.length;
    if (!total) return { start: 0, end: -1, dates: [] };
    const count = range === 'all' ? total : Math.min(Number(range) || total, total);
    return {
      start: total - count,
      end: total - 1,
      dates: dates.slice(total - count),
    };
  }

  function emptyTotals() {
    return { bq: 0, ba: 0, sq: 0, sa: 0, nq: 0, nc: 0, gt: 0, ct: 0, days: 0 };
  }

  function addToTotals(totals, point) {
    totals.bq += point.bq;
    totals.ba += point.ba;
    totals.sq += point.sq;
    totals.sa += point.sa;
    totals.nq += point.nq;
    totals.nc += point.nc;
    totals.gt += point.gt;
    totals.ct += point.ct;
    totals.days += 1;
  }

  // One aggregate row per broker-stock pair that traded inside the window.
  function pairTotals(index, window) {
    const result = [];
    const points = index.points;
    for (const slice of index.slices) {
      const totals = emptyTotals();
      for (let at = slice.start; at < slice.end; at += 1) {
        const day = points.day[at];
        if (day < window.start) continue;
        if (day > window.end) break;
        addToTotals(totals, pointObjectOf(points, at));
      }
      if (!totals.days) continue;
      result.push({
        pairKey: `${slice.brokerKey}\u0000${slice.symbol}`,
        brokerKey: slice.brokerKey,
        symbol: slice.symbol,
        ...totals,
      });
    }
    return result;
  }

  function foldBy(pairRows, keyField, nameOf) {
    const map = new Map();
    for (const row of pairRows) {
      const key = row[keyField];
      let entry = map.get(key);
      if (!entry) {
        entry = { key, name: nameOf(row), ...emptyTotals(), symbols: new Set(), brokers: new Set() };
        map.set(key, entry);
      }
      entry.bq += row.bq;
      entry.ba += row.ba;
      entry.sq += row.sq;
      entry.sa += row.sa;
      entry.nq += row.nq;
      entry.nc += row.nc;
      entry.gt += row.gt;
      entry.ct += row.ct;
      entry.days += row.days;
      if (keyField === 'brokerKey') entry.symbols.add(row.symbol);
      else entry.brokers.add(row.brokerKey);
    }
    return map;
  }

  // Gross turnover per broker per day index (for the bump chart).
  function brokerGrossByDay(index, window) {
    const map = new Map(); // brokerKey -> Float64Array over window
    const size = window.end - window.start + 1;
    const points = index.points;
    for (const slice of index.slices) {
      let series = map.get(slice.brokerKey);
      for (let at = slice.start; at < slice.end; at += 1) {
        const day = points.day[at];
        if (day < window.start) continue;
        if (day > window.end) break;
        const gt = points.gt[at];
        if (!gt) continue;
        if (!series) {
          series = new Float64Array(size);
          map.set(slice.brokerKey, series);
        }
        series[day - window.start] += gt;
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------
  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadCsv(filename, headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) lines.push(row.map(csvEscape).join(','));
    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // URL hash state
  // ---------------------------------------------------------------------------
  function readHash() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return new URLSearchParams();
    return new URLSearchParams(hash);
  }

  function writeHash(params) {
    const hash = params.toString();
    const url = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`;
    window.history.replaceState(null, '', url);
  }

  window.V2Data = {
    // config
    DATA_REPO,
    RAW_SUMMARY,
    DEFAULT_RANGE,
    CACHE_DAYS,
    AVG_DAY_RAW_MB,
    AVG_DAY_GZIP_MB,
    POINT_BYTES,
    AVG_ROWS_PER_DAY,

    // infra
    createCache,
    resolveDates,
    fetchDay,
    runPool,
    debounce,
    num,
    CONCURRENCY,

    // index + aggregation
    buildIndex,
    windowOf,
    pairTotals,
    foldBy,
    brokerGrossByDay,

    // formatting
    fmtInt,
    fmtSignedQty,
    fmtRs,
    fmtRsSigned,
    compact,
    signClass,

    // export + state
    downloadCsv,
    readHash,
    writeHash,
  };
})();
