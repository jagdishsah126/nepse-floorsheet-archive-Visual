/*
 * NEPSE Flow V2 — data layer.
 * Manifest-first loader for Summary/<date>_brokers.csv, with an IndexedDB cache
 * shared with the v1 dashboard. Exposes window.V2Data.
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

  const DB_NAME = 'nepse-visual'; // shared with v1
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

  // Row tuple layout used everywhere in V2.
  // [brokerId, brokerName, symbol, buyQty, buyAmount, sellQty, sellAmount, netQty, netCash, gross, contracts]
  const ROW_WIDTH = 11;

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

  function padRows(record) {
    // v1 cached rows have 10 fields (no contracts). Pad so one code path serves both.
    for (const row of record.rows) {
      if (Array.isArray(row) && row.length === ROW_WIDTH - 1) row.push(0);
    }
    return record;
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
  // Daily summary download + parse
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
        num(row.contracts),
      ]);
    }

    if (!rows.length) throw new Error('no data rows found');
    return { date, rows, fetchedAt: Date.now() };
  }

  // ---------------------------------------------------------------------------
  // Index building
  // ---------------------------------------------------------------------------
  function buildIndex(dayMap) {
    const dates = [...dayMap.keys()].sort();
    const brokers = new Map();
    const stocks = new Map();
    const pairs = new Map();

    for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
      const day = dayMap.get(dates[dayIndex]);
      for (const row of day.rows) {
        const [brokerId, brokerName, symbol, buyQty, buyAmount, sellQty, sellAmount, netQty, netCash, gross, contracts] = row;
        const brokerKey = String(brokerId);
        if (!brokerKey || !symbol) continue;

        let broker = brokers.get(brokerKey);
        if (!broker) {
          broker = { key: brokerKey, id: Number(brokerId), name: brokerName || `TMS ${brokerKey}`, totalGross: 0, pairs: new Set() };
          brokers.set(brokerKey, broker);
        } else if (brokerName) {
          broker.name = brokerName;
        }

        let stock = stocks.get(symbol);
        if (!stock) {
          stock = { symbol, totalGross: 0, pairs: new Set() };
          stocks.set(symbol, stock);
        }

        const pairKey = `${brokerKey}\u0000${symbol}`;
        let pair = pairs.get(pairKey);
        if (!pair) {
          pair = { brokerKey, symbol, points: new Map() };
          pairs.set(pairKey, pair);
          broker.pairs.add(pairKey);
          stock.pairs.add(pairKey);
        }

        const point = pair.points.get(dayIndex);
        if (point) {
          point.nq += netQty;
          point.nc += netCash;
          point.bq += buyQty;
          point.sq += sellQty;
          point.ba += buyAmount;
          point.sa += sellAmount;
          point.gt += gross;
          point.ct += contracts;
        } else {
          pair.points.set(dayIndex, {
            nq: netQty,
            nc: netCash,
            bq: buyQty,
            sq: sellQty,
            ba: buyAmount,
            sa: sellAmount,
            gt: gross,
            ct: contracts,
          });
        }

        broker.totalGross += gross;
        stock.totalGross += gross;
      }
    }

    return { dates, brokers, stocks, pairs };
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
    for (const [pairKey, pair] of index.pairs) {
      const totals = emptyTotals();
      for (let i = window.start; i <= window.end; i += 1) {
        const point = pair.points.get(i);
        if (point) addToTotals(totals, point);
      }
      if (!totals.days) continue;
      result.push({ pairKey, brokerKey: pair.brokerKey, symbol: pair.symbol, ...totals });
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
    for (const pair of index.pairs.values()) {
      for (let i = window.start; i <= window.end; i += 1) {
        const point = pair.points.get(i);
        if (!point || !point.gt) continue;
        let series = map.get(pair.brokerKey);
        if (!series) {
          series = new Float64Array(size);
          map.set(pair.brokerKey, series);
        }
        series[i - window.start] += point.gt;
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

    // infra
    createCache,
    resolveDates,
    fetchDay,
    runPool,
    debounce,
    num,

    // index + aggregation
    buildIndex,
    windowOf,
    pairTotals,
    foldBy,
    brokerGrossByDay,
    padRows,

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
