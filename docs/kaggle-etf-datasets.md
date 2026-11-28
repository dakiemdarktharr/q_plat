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

The owner-only job reports manifest, candidate screening, panel saving and panel verification progress. It downloads three files concurrently through Kaggle's official `DatasetApiService/DownloadDataset` RPC, follows only HTTPS redirects to Google Cloud Storage, and keeps file bytes in bounded worker memory. Results are admitted in pinned manifest order, so panel membership stays deterministic. Each completed batch checkpoints accepted hashes and rejection counts; a transient source/network failure retries the batch and does not count as a rejected ETF. Complete panels are verified before publish. The supported command is:

```text
node scripts/admin.mjs import kaggle_etf_objective_panels_70
```

This invokes the production API with the local owner credential but carries no dataset to the local process. The worker and Atlas relay enforce the cloud-only import path.

## Production acceptance record

Verified 2026-11-28 against the production catalog, the Atlas metadata plan, and both bar shards. Import job `f86ced70-ccc3-47c3-bd9c-4939c9e7f8dd` completed in 1,788 seconds. The Atlas plan is `complete`, with 70 imported snapshots. Its candidate screen rejected 57 files for volume, 8 for coverage, 16 for liquidity and 1 for calendar.

| Objective | Ready panels |
| --- | ---: |
| Time-series momentum | 10 |
| Mean reversion | 10 |
| Volatility scaling | 10 |
| Cross-sectional rank | 10 |
| Liquidity and volume | 10 |
| Gap and overnight | 10 |
| Robustness controls | 10 |

All 70 dataset versions are ready and unique. Their six-asset universes contain 420 unique ETF symbols. Every panel has a 64-character snapshot checksum and source manifest hash. Atlas grouped the actual bars into 35 versions on each result shard; every group had six assets. All 70 Atlas row counts matched the production catalog exactly: 554,730 bars total and 7,920–7,926 bars per panel.

Quality readback found minimum coverage of 99.6215% (1,316 of 1,321 expected sessions), minimum per-asset median dollar volume of USD 257,193, maximum combined invalid/zero-volume rate of 0.1263%, and no large unexplained moves. All values pass the admission gates above. Atlas readback also confirmed the 70 ready snapshot records in the metadata cluster.

All three MongoDB clusters are Atlas M0. After import and six-panel research, `dataSize + indexSize` was 382.01 MiB on `qplatdata01`, 145.57 MiB on `qplatresults01`, and 145.01 MiB on `qplatresults02`, below the 512 MiB M0 limit. Dataset bars and result chunks are sharded across the two result clusters. The metadata cluster retains about 130 MiB of headroom; neither result shard is above 29% of its limit. The database list contained only `q_plat`, `admin` and `local` on each cluster. No local price rows, CSVs, archives or dataset files were used or committed.

Production interaction check: a browser selected panels `kaggle_etf_001` through `kaggle_etf_006`, saved edge version 1, and submitted one batch to `runBatch`. Job `cc31a882-da6e-4e79-a437-ba378bcb2c8f` completed on six distinct snapshots. Each report contained 7,926 points and a finite return and mean IC. The production batch view rendered six panels, each with normalized price and edge-score paths; browser page errors: 0. The alpha was `move = returns(close, 20)`, `risk = ts_std(returns(close, 1), 20)`, and `score = rank(move) - 0.25 * rank(risk)`.

| Dataset | Run hash |
| --- | --- |
| `kaggle_etf_001` | `1f91afc801a2c5cc366f0d9e1aee60a76b732654c717fe160176b85ed6645273` |
| `kaggle_etf_002` | `0bf2e7ef2840b80b457af3eaffe50e83c2b45d16f324191bbb1435a6496a0e34` |
| `kaggle_etf_003` | `a9f942001f99c23b5b586fbe7f4d25caf1a8f8425edfe9012926c254e0c95fd5` |
| `kaggle_etf_004` | `911a1c239d9ba9551ad028a7927ee1ec8ebe28bd4efd1c612f7b4b870e188103` |
| `kaggle_etf_005` | `6ae9bb32578ecddb7c765c9a3ed4ebcfee248e82f6e540f1fbff888f1d524ce6` |
| `kaggle_etf_006` | `ac7e21b7931645c140530cf04796ff760101e28abf0dfd35da861263530b0767` |

This is one frozen Kaggle release, divided into non-overlapping research panels. The panels are not independent vendor datasets or independent evidence. The histories end in 2020 and carry the survivorship, final-vintage and source-rights limitations stated above. They support exploratory research, not a claim of current investability.
