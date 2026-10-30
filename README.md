# NEPSE Broker Flow Visualizer

A static, backend-free dashboard for the broker-wise summaries in the
[NEPSE Floorsheet Archive](https://github.com/jagdishsah126/nepse-floorsheet-archive).

It reads `Summary/<date>_brokers.csv` directly from GitHub and renders the charts in
the browser. No server, no API token, no build step.

**Live site:** <https://jagdishsah126.github.io/nepse-floorsheet-archive-Visual/>

**V2 — market-wide views:** [`/V2/`](V2/) adds a broker × stock heatmap,
buyer/seller leaderboard, churn scatter, accumulation streaks, a bump chart,
and small-multiple sparklines, plus CSV export and permalink state. See
[V2/README.md](V2/README.md).

## Views

| View | What it shows |
| --- | --- |
| **Stock → Brokers** | Pick a stock (e.g. `NHPC`). One line per TMS/broker showing that broker's net kitta in the stock. Defaults to the top 5 accumulators vs the top 5 distributors by net qty in the selected range. |
| **Broker → Stocks** | Pick a broker (e.g. TMS `58`). One line per stock showing that broker's net kitta in the stock. Defaults to the top 5 accumulators vs the top 5 distributors. |

Both views share the same controls:

- **Range** — `5D`, `10D`, `30D`, or `All` available summary days.
  The range only changes the *display window*; cumulative values always include
  the history from the first available summary.
- **Metric** — cumulative net qty (default), daily net qty, cumulative net cash,
  or daily net cash.
- **Show** — top accumulators, top distributors, or accumulators vs distributors.
- **Count** — show 5, 10, or 20 per side, or all counterparties on the selected
  side(s). In the comparison mode, `10 vs 10` means ten accumulators and ten
  distributors. Zero-net counterparties remain available in the checklist but
  are not auto-selected. Series can be added or removed with the searchable
  checkboxes below the chart. A green `ACC` badge means positive net qty in the
  selected range; a red `DIST` badge means negative net qty; a grey `FLAT` badge
  means zero net qty. Distributor lines are dashed in the cumulative line views.
- **Sync data** — force a fresh listing of `Summary/` and download any new days.

The table below the chart aggregates every broker (or stock) that traded in the
selected range. Click a series checkbox to add or remove its line from the chart.

## What the numbers mean

The summary schema is one row per broker, stock, and trading day:

```text
business_date, broker_id, broker_name, stock_symbol,
buy_qty, buy_amount, buy_vwap, sell_qty, sell_amount, sell_vwap,
net_qty, net_cash, gross_turnover, contracts
```

- `net_qty = buy_qty − sell_qty`. Positive means the broker bought more than it
  sold that day.
- `net_cash = sell_amount − buy_amount`. Positive means the broker received cash
  (was a net seller); negative means it spent cash (was a net buyer).
- **Accumulator / distributor** — over the selected range, an accumulator has
  positive net qty (bought more than sold) and a distributor has negative net qty.
  Ranking always uses net qty, even when the chart is showing a cash metric.
- **Cumulative net qty** is the running sum from the first available summary
  date. It is a *position-change proxy*, not actual holdings: the archive starts
  on 2026-09-17, so anything held before that is invisible. Bonus shares, splits,
  and off-market transfers are not trades and can distort the line.
- A broker (TMS) aggregates many clients. "TMS 58 bought" does not mean one
  investor bought.
- `gross_turnover` is broker-side turnover (`buy_amount + sell_amount`). It is
  two-sided by design, so summing it across all brokers double-counts the market
  total. Per broker/stock it is still a useful activity measure.
- All cash values are in Nepali rupees (NPR).
- **2026-09-18 is missing** from the archive because the source floorsheet is a
  2-byte stub. The dashboard uses the dates that actually exist and never
  interpolates a missing day.

## How the data is loaded

1. **Date list** — two small GitHub Git Trees API requests (root tree → `Summary`
   tree). The result is cached in `localStorage` for one hour. Press **Sync data**
   to bypass the cache. The Trees API is used instead of the Contents API because
   the latter truncates directory listings at 1,000 files.
2. **Daily files** — `https://raw.githubusercontent.com/jagdishsah126/nepse-floorsheet-archive/main/Summary/<date>_brokers.csv`.
   Four downloads run in parallel.
3. **Parsing** — PapaParse (vendored) parses each CSV once.
4. **Cache** — parsed rows are stored in **IndexedDB**, keyed by date. Reloading
   the page inside the same browser reads from IndexedDB and makes no data
   requests. The footer has **Clear cached data** for a full reset.
5. **Aggregation** — the browser builds a stock ↔ broker index and computes the
   selected series. No precomputed files and no server-side step.

First sync cost: one CSV per summary day, roughly **318 KB gzipped / 1.3 MB raw
per day**. The 19-day archive is about **6 MB gzipped**. After the first sync the
data is local; each new trading day adds one file. If your connection is metered,
sync once and keep the browser cache.

Both GitHub endpoints return `access-control-allow-origin: *`, so the static page
can read them directly.

## Running locally

Any static file server works:

```bash
cd Visual
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` with `file://` will not work: the browser blocks the
cross-origin data fetches from that origin.

## Deployment

The site is plain HTML/CSS/JS at the repository root.

1. Push to `main`.
2. **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
3. The included `.nojekyll` file tells Pages to serve the files as-is.

No Actions workflow is required for the dashboard. The archive repository's own
workflows continue to append new `Summary/` files; this site picks them up on the
next sync.

## Project layout

```text
.
├── index.html          markup
├── style.css           dark theme and responsive layout
├── app.js              data loading, IndexedDB cache, charts, tables
├── V2/                 market-wide views (heatmap, leaderboard, churn, …)
├── vendor/
│   ├── chart.umd.min.js    Chart.js 4.4.7 (MIT)
│   └── papaparse.min.js    PapaParse 5.4.1 (MIT)
├── credit.md           dependency and data attribution
├── future.md           local, gitignored notes for later visualizations
├── .nojekyll           GitHub Pages passthrough
└── .gitignore
```

## Limitations and next steps

- The two v1 views are the only views on the root page. The market-wide ideas
  from `future.md` (heatmap, leaderboard, churn scatter, streaks, bump chart,
  sparklines) are implemented in [V2/](V2/); the rest of `future.md` (not pushed)
  tracks what is still open.
- The Summary data has no market price. A price overlay needs the raw
  `Floorsheet/` files and a separate build step.
- The dashboard loads every available day to compute cumulative values. As the
  archive grows into hundreds of days, a pre-aggregated per-stock layer (or
  Parquet + DuckDB-WASM) would be the next performance improvement.
- Cached days are immutable in practice. If a historical summary is corrected,
  use **Clear cached data** to force a re-download.

## Credits

Chart.js 4.4.7 and PapaParse 5.4.1 are vendored under `vendor/`; both are MIT
licensed. See [credit.md](credit.md) for the full notices and data attribution.

Data source: the public [NEPSE Floorsheet Archive](https://github.com/jagdishsah126/nepse-floorsheet-archive).
NEPSE data belongs to its respective owners. This is an independent visualizer,
not affiliated with NEPSE, and not investment advice.
