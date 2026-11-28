# Kaggle ETF research panels

## Source and limits

The importer pins [Oleh Onyshchak's Kaggle Stock Market Dataset](https://www.kaggle.com/datasets/jacksoncrow/stock-market-dataset) to version 2. The public Kaggle API reports `CC0: Public Domain`, 2,165 files under `etfs/`, and version 2 updated on 2020-04-02. Its description says the histories were retrieved from Yahoo Finance with yfinance and end on 2020-04-01. The original Yahoo publication terms and point-in-time revision history are not supplied with each file, so the app labels the source and limitation in every snapshot. Treat the data as exploratory historical research; confirm the underlying provider terms before redistribution or commercial use.

This source does not make 70 independent datasets in the vendor sense. The importer builds 70 distinct six-ETF research universes from one frozen source. It requires 420 distinct symbols so no accepted ETF is reused. Every panel has a research-objective label for navigation: time-series momentum, mean reversion, volatility scaling, cross-sectional rank, liquidity and volume, gap and overnight, or robustness controls. Those labels are intended workflows, not publisher classifications or a claim of independent evidence.

The source universe is a 2020 snapshot of ETFs still trading at that time, so it has survivorship and selection bias. Adjusted prices are final-vintage values, not point-in-time observations. This is not a current market feed or evidence that an edge remains investable today.

## Admission checks

Candidate files are considered in deterministic size/hash order. The screen excludes known leveraged, inverse and volatility products, then checks each CSV independently. A candidate is rejected if any gate fails; screening continues with the next unique ticker.

- Exact required fields: date, open, high, low, close, adjusted close and volume.
- Chronological dates with no duplicates, NYSE sessions only, within 2015-01-02 through 2020-04-01.
- At least 97% of the 1,321 exchange sessions for each symbol.
- Positive source prices, nonnegative volume and valid source and normalized OHLC ranges.
- OHLC normalized by `Adj Close / Close`; adjusted close is retained as close, and the source's split-adjusted volume is preserved. Source prices and the adjustment factor remain attached for audit.
- Fewer than 0.5% malformed or zero-volume observations.
- Median split-adjusted dollar volume of at least USD 250,000 per session.
- No adjusted one-day close move above 50% without source reconciliation.

Only a complete six-symbol panel is published. Atlas stores its immutable normalized bars, file hashes, coverage and screening audit, source version, license metadata and checksum. The plan stored in `dataset_ingest_plans` contains manifest metadata, screening counters and checkpoints, not price rows. Ingestion reads one source file at a time into a bounded Vercel worker buffer and writes bars directly to Atlas. No source file, CSV, cache or market row is written to the user's laptop or repository.

## Free Atlas layout and job behavior

Workspace, catalog, snapshot metadata and screening checkpoints remain on the current data M0. The 70 new panels alternate between two additional Atlas M0 clusters: 35 panel versions route to `qt70a-` and 35 to `qt70b-`. Their bars use the same compound indexes as existing panels. Result chunks continue to use run-hash partitioning across the two clusters. The importer performs one idempotent bulk write per panel and verifies Atlas counts and a normalized readback checksum before marking the snapshot ready.

The owner-only job reports manifest, candidate screening, panel saving and panel verification progress. It checkpoints each accepted symbol, rejected candidates in small batches and every complete panel so retries do not publish partial snapshots. Only a transient source/network failure is retried; it does not count as a rejected ETF. The supported command is:

```text
node scripts/admin.mjs import kaggle_etf_objective_panels_70
```

This invokes the production API with the local owner credential but carries no dataset to the local process. The worker and Atlas relay enforce the cloud-only import path.

## Production acceptance record

This section is updated only after the production job and Atlas readback complete. Required evidence is 70 current ready snapshots, seven groups of ten, 420 unique screened symbols, six assets per snapshot, count/hash readback for each panel, and successful production research on six distinct new snapshots. Storage evidence records `dataSize + indexSize` for both new M0 clusters before and after import. It records counts, hashes and scalar quality metrics only; it does not include price rows.
