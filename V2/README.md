# NEPSE Flow V2 — market-wide views

Same archive, different lens. Where the [v1 dashboard](../README.md) follows one
stock or one broker, V2 shows the whole market at once. Static, no backend.

**URL:** `/V2/` — the main page links to it. Every view's controls are stored in
the URL hash, so a filtered view can be shared as a permalink.

## Views

| View | What it shows | Based on |
| --- | --- | --- |
| **Heatmap** | Top brokers × top stocks, cell = net qty or net cash in the selected range. Click a cell for the pair's daily detail. | `Summary/<date>_brokers.csv` |
| **Leaderboard** | Top net buyers vs sellers (horizontal bars) + sortable all-brokers table. | same |
| **Churn** | Scatter of buy amount vs sell amount (log-log) per broker-stock pair. Diagonal = round-trips; far off it = directional flow. Bubble size = contracts. | same |
| **Streaks** | Broker-stock pairs with consecutive same-sign days (net-buy/net-sell streaks), with a per-day strip. | same |
| **Bump** | Daily rank of the top N brokers by gross turnover — how activity leadership rotates. | same |
| **Sparklines** | Small multiples: daily net qty per broker for a stock (or per stock for a broker), on one shared scale. | same |

All views share a range selector (5D / 10D / 30D / All) and an **Export CSV**
button that downloads the current view's data. Colour language everywhere:
**green = net buying, red = net selling** (for net-cash measures this is
inverted to keep "green = accumulating" consistent).

## Data layer

The loader is manifest-first (see `future.md` §1):

1. Try `Summary/manifest.json` in the archive repo — when the GitHub Action that
   builds the compact layer ships, V2 skips the GitHub API entirely.
2. Fall back to the GitHub Trees API listing (2 calls, cached 1 h in
   `localStorage`, shared with v1).
3. Fall back to a stale cached listing.

Daily CSVs are parsed with PapaParse and cached in IndexedDB
(`nepse-visual` / `days` — the same store v1 uses, so a visit to either app
warms the other). Downloads run 4 at a time.

## Not implemented (and why)

- **Sector flows** — needs a curated `symbol → sector` mapping CSV. Do not guess.
- **Price overlay, broker-to-broker network** — need raw `Floorsheet/` data; the
  Summary schema has no market price or counterparties.
- **Animated matrix** — planned; the heatmap is its static foundation.

## Local development

Serve the repo root over HTTP (not `file://`):

```sh
python3 -m http.server 8000
# http://localhost:8000/V2/
```
