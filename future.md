# Future ideas — NEPSE Broker Flow Visualizer

> **Working notes.** Ideas and constraints for the NEPSE dashboards. v1 ships
> Stock → Brokers and Broker → Stocks; V2 adds the market-wide views listed in
> `V2/README.md`. Items here are proposals, not committed scope.

## Constraints to keep

- No backend, no API keys. The site is static on GitHub Pages.
- Data comes from `Summary/` in the archive repo; the browser fetches it.
- Data-saver first: avoid re-downloading a 318 KB file for every chart.
- Cumulative net qty is a position-change proxy since 2026-09-17, not holdings.
- A TMS is a broker aggregating many clients, not one investor.

---

## 1. Data layer: compact per-stock files

The current app downloads every daily `_brokers.csv` file (≈318 KB gzipped per
day) and aggregates in the browser. That is fine for the current 19 days but
will become heavy at hundreds of days.

Build once in GitHub Actions, after `DailySummary.py`:

```text
Summary/
├── manifest.json
├── by-stock/<SYMBOL>.csv
├── by-broker/<BROKER_ID>_index.csv
└── totals_all.csv
```

### `manifest.json`

```json
{
  "generated_at": "2026-10-27T15:45:00+05:45",
  "dates": ["2026-09-17", "2026-09-22", "..."],
  "brokers": 91,
  "symbols": 360,
  "latest": "2026-10-27"
}
```

Avoids the GitHub API listing and the 60 requests/hour limit entirely.

### `by-stock/<SYMBOL>.csv`

One row per broker per day for that stock:

```csv
date,broker_id,broker_name,buy_qty,sell_qty,net_qty,buy_amount,sell_amount,net_cash,gross_turnover,contracts
2026-10-27,58,Naasa Securities Co. Ltd.,6139,30675,-24536,1599673.30,8019777.80,6420104.50,9619451.10,42
```

A stock page then needs one small file (10–50 KB for the current archive)
instead of 19 × 318 KB. The broker-first view:

1. fetch `manifest.json` + `by-broker/<ID>_index.csv` (rank stocks by turnover),
2. fetch only the `by-stock` files for the chosen stocks.

### `totals_all.csv`

Append `_broker_totals.csv` rows into one file for leaderboards, bump charts,
and market-wide views without loading the detailed files.

### Parquet + DuckDB-WASM

If arbitrary slicing and long history become important, store Parquet and query
in the browser with DuckDB-WASM. Much more work; only worth it after the compact
CSV layer.

---

## 2. Visualizations

### 2.1 Broker × stock heatmap

Rows = top brokers, columns = top stocks, cell = net qty or net cash for a day
(or a selected range). Diverging colour scale (red ↔ neutral ↔ green), hover for
buy/sell/net, click a cell to open that series. This is probably the single most
useful next view for spotting accumulation.

### 2.2 Net buyer / seller leaderboard

Horizontal bars for the selected day or range. Toggle between net qty and net
cash, and between buy-side and sell-side. Sort by absolute net. Show the top 10
and a "show all" table.

### 2.3 Churn scatter

Per broker-stock pair for the range:

- x = buy amount
- y = sell amount
- colour = net cash
- size = contracts

Points on the diagonal are round-trips (churn); points far from the diagonal are
directional flow. Useful to separate market makers from accumulators.

### 2.4 Sankey flow

Two variants:

1. **Aggregate flows (possible now):** brokers → stocks on the buy side, and
   stocks → brokers on the sell side. Label it "flows", not "counterparty flows".
2. **True broker-to-broker network (needs `Floorsheet/`):** aggregate
   `buyerMemberId` and `sellerMemberId` per day. Node = broker, edge = value or
   quantity. A chord diagram or network graph is more honest than a Sankey for
   this.

The Summary schema has no counterparties, so variant 1 cannot answer "who bought
from whom".

### 2.5 Small multiples / sparklines

A grid of mini charts:

- one per broker for a selected stock, or
- one per stock for a selected broker.

Normalize each sparkline to its own scale? No — use a shared scale so magnitudes
are comparable, and label the min/max. Good for scanning 50–100 series without
overlaying them.

### 2.6 Accumulation / streak view

Rank broker-stock pairs by:

- cumulative net qty ÷ average daily volume,
- consecutive net-buy or net-sell days,
- a simple "accumulation score" combining direction, persistence, and turnover.

Show streaks as a heatmap or a sorted table. Caveat: a broker can be buying for
many unrelated clients, so "accumulation" is still an aggregate proxy.

### 2.7 Sector flows

Needs a curated `symbol → sector` mapping. Do not guess from names. Once the
mapping exists, show net cash by sector over time and a sector-level treemap.
Add the mapping as a CSV in the data repo so it is versioned and reviewable.

### 2.8 Bump chart

Top N brokers by gross turnover, ranked over dates. Shows how activity leadership
changes. Use a fixed N and clear labels; a bump chart with 91 lines is unreadable.

### 2.9 Animated day-by-day heatmap

The broker × stock matrix with a play/pause button and a date slider. Good for
presentations and for seeing rotation over time. Precompute the matrix for a
handful of top stocks to keep it fast.

### 2.10 Price overlay

Summary has no market price, only broker VWAPs. To overlay price:

- read the raw `Floorsheet/<date>.csv`,
- compute a daily OHLC or VWAP per symbol,
- cache that much smaller table.

Do not pretend the broker VWAP is the market price.

### 2.11 Trade-size / ticket distribution

From `Floorsheet`: contract size distribution, average ticket, share of large
trades. Can approximate retail vs institutional activity. Heavy data; precompute
aggregates in Actions.

### 2.12 Market breadth and concentration

- net flow by stock,
- number of net buyers vs net sellers,
- top-5 broker share of turnover (HHI),
- stocks with the widest buy/sell imbalance.

Can be built from Summary alone; a compact daily aggregate file is enough.

### 2.13 Watchlist and client-side alerts

Save symbols/brokers in `localStorage`, show a compact watchlist card, and flag
when net qty/cash crosses a threshold. No backend; alerts only appear when the
page is open.

### 2.14 CSV export and permalinks

- Export the current table and series to CSV with a `Blob` download.
- Put view/entity/metric/range in the URL hash so a view can be shared.
- Both are low effort and high value.

### 2.15 Compare mode

Overlay multiple stocks or multiple brokers in one chart, sharing a normalized
axis. Useful for relative accumulation; must be clearly labelled because the
units are the same but the scale may differ.

---

## 3. Improvements to the current app

- Persist selected series keys, not just the entity/metric/range.
- Click a table row to select that series in the chart.
- Sortable table columns (net qty, net cash, gross, VWAP).
- Sticky totals row in the table.
- Show a "last synced" timestamp and how many days came from cache.
- Explicitly mark the 2026-09-18 gap on the date axis once there is a note for it.
- Full/compact number toggle (currently full values in tables, compact on axes).
- A "force re-download this day" action for corrected summaries.
- Keyboard navigation for the series checkboxes and tabs.
- Service worker for offline use after the first sync.
- More robust tests: data aggregation in Node, browser smoke test with mocked
  data, and a test for the 1,000-file listing limit.

---

## 4. Data quality notes

- `2026-09-18.csv` is a 2-byte stub. Re-scrape the day to fill it. Until then
  every cumulative series has one fewer observation.
- Bonus shares, splits, and transfers can change cumulative qty without a trade.
  Consider a "corporate action" annotation layer later.
- Broker names may change over time. The app currently keeps the latest name;
  a rename log would make historical comparisons cleaner.
- Gross turnover is two-sided per broker. Do not sum it across brokers and call
  it market turnover.
- The archive's Summary files are generated from `Floorsheet/`; any source
  corruption propagates. The backfill workflow already skips invalid source
  files, which is why 2026-09-18 is absent.

---

## 5. Suggested order

**P1**

1. Compact per-stock + broker-index + manifest layer.
2. Broker × stock heatmap.
3. Buyer/seller leaderboard.
4. CSV export and URL state.

**P2**

5. Churn scatter.
6. Small multiples.
7. Accumulation/streak view.
8. Sector mapping and flows.
9. Bump chart.

**P3**

10. Animated matrix.
11. Price overlay (raw Floorsheet).
12. True broker-to-broker network.
13. DuckDB-WASM / Parquet if the archive becomes large.
