# Equity research panels

Ten curated six-stock universes, all sourced from the same frozen Quandl WIKI Prices archive. These are ten research panels, not ten independent vendors, ETF datasets, official sector-index histories or survivorship-free universes.

| Dataset | Symbols |
|---|---|
| Technology | AAPL, MSFT, INTC, CSCO, ORCL, IBM |
| Financials | JPM, BAC, WFC, C, GS, MS |
| Healthcare | JNJ, PFE, MRK, ABT, AMGN, GILD |
| Consumer discretionary | AMZN, HD, MCD, NKE, SBUX, LOW |
| Consumer staples | KO, PEP, PG, WMT, COST, CL |
| Energy | XOM, CVX, COP, SLB, EOG, OXY |
| Industrials | CAT, DE, MMM, HON, UPS, UNP |
| Utilities | DUK, SO, D, AEP, EXC, XEL |
| Materials | APD, ECL, FCX, NEM, NUE, EMN |
| Real estate | AMT, SPG, PLD, PSA, AVB, EQR |

Requested observation interval: 2012-01-01 to 2017-12-31. Admission requires all six symbols, at least 1,400 observations per symbol, at least 97% coverage against 1,509 scheduled exchange sessions, unique symbol/date keys, finite positive OHLC, nonnegative volume, valid bar ranges, consistent price adjustment factors and no unexplained adjusted one-day move over 50%. Structurally invalid or non-trading-date source bars are excluded without imputation; the full symbol/date/reason rejection list is kept in snapshot metadata. More than 0.5% rejected bars for any stock fails admission. Large returns are never silently removed as outliers. These structural checks cannot establish the correctness of every vendor observation.

Calendar audit `wiki-calendar-2` uses the published [2012](https://www.nasdaqtrader.com/TraderNews.aspx?id=dn2011-011), [2013](https://www.nasdaqtrader.com/TraderNews.aspx?id=dn2012-21), [2014](https://www.nasdaqtrader.com/TraderNews.aspx?id=dn2013-10), [2015–2016](https://ir.theice.com/press/news-details/2014/NYSE-Group-2016-Holiday-Calendar-and-Early-Closings/default.aspx) and [2017](https://ir.theice.com/press/news-details/2016/NYSE-Group-Announces-2017-Holiday-and-Early-Closings-Calendar/default.aspx) exchange holidays, plus [Sandy closures](https://www.sec.gov/files/rules/sro/nyse/2013/34-70099.pdf). It caught an otherwise valid-looking LOW bar on Good Friday 2017-04-14. The corrected panel gets a new content hash; the original snapshot is preserved for reproducibility and omitted from the current catalog. Unchanged observations keep their hash and receive an additional independent audit record. Complete-session gaps are listed in `quantAudit.missingSessions`; the engine uses observed session slots and does not manufacture missing bars. Exchange-calendar coverage and observed-panel coverage are separate measures.

[Nasdaq's WIKI description](https://data.nasdaq.com/databases/WIKIP) identifies the archive as public domain, but also says it stopped being maintained in 2018 and is not recommended for investment or analysis. We retain that warning in every panel's metadata. This is a constrained historical research resource, not an institutional-quality or current production trading feed. [Kaggle mirror](https://www.kaggle.com/datasets/marketneutral/quandl-wiki-prices-us-equites), frozen version 1, supplies the original WIKI_PRICES.csv; source and normalized SHA-256 hashes accompany the snapshots.

Publisher-adjusted OHLCV feeds the existing daily engine. Original OHLCV, cash dividends, split ratios and adjustment factors remain in Atlas for inspection. Adjusted-unit account simulation approximates distribution reinvestment: do not pay dividends again. Adjusted prices are not historical executable dollar prices. Open timestamps use New York DST; daily close availability is a conservative 23:59:59 UTC proxy. Revised/back-adjusted history is not point-in-time data. The selected surviving-stock universes, daily-bar fills and small cross-sections limit inference.

The cloud-only importer streams the compressed archive through bounded decompression in RAM, retains only the selected symbols/years, validates every panel before publishing any, and writes content-addressed snapshots to Atlas. Each worker yields at a durable batch checkpoint after about three minutes; the next invocation reopens the pinned archive in cloud and resumes the unfinished snapshot. Ready snapshots are reused. This stays within the free serverless runtime without using local files or paid storage. No archive, CSV, cache or market-data file is written to the user's computer. Repeating `node scripts/admin.mjs import wiki_sectors` reuses verified ready snapshots. Only the owner can trigger ingestion; the ready datasets use the existing bounded web/API/MCP interfaces.

## Atlas ingestion evidence — 2026-11-28, Asia/Saigon

The ten current snapshots contain **90,445 observations, 60 distinct stocks and 1,508 observed sessions per panel**, spanning **2012-01-03 through 2017-12-29**. All ten omit the source-wide missing session **2017-11-08**; no prices were interpolated. Panel coverage against the 1,509 scheduled exchange sessions ranges from 99.6355% to 99.9337%. The weakest individual history has 1,481 observations; the panel is still a deliberately selected surviving-stock universe, not a complete market history.

| Panel | Observations | Rejected source rows | Normalized SHA-256 |
|---|---:|---:|---|
| Technology | 9,044 | 2 | `37624ed02d0eeff762faf17c68b89f53ed0ada57911b91cb33fcadc05fcb63f6` |
| Financials | 9,048 | 0 | `dac3e0327afe8fad357d9300da79d329c8a8241935f6fe44b965997ca7781cae` |
| Healthcare | 9,047 | 0 | `c013d2b10449296a001a19a92465efb652a0d8e400a16efc68e5bb4c0ed7b63b` |
| Consumer discretionary | 9,046 | 2 | `5f8d89057d4ab7a4f53d318390e395231b2e6bbd52111b94c90243c1f695810e` |
| Consumer staples | 9,047 | 0 | `df7e1bb38eb687d50dd7f4170b03149ff4cc2aa31340d128b222b055c31c21e2` |
| Energy | 9,048 | 0 | `ff46fc663c4ac67e9a1e3f7da7fa595fd2616b48ea09eb5df0879cb88e36c6f5` |
| Industrials | 9,021 | 0 | `6a5410f2672871f878d99b24bade40e18be33b4fa596304081a2d1f6a7a33c25` |
| Utilities | 9,048 | 0 | `e47cf89a666e9912722c9edb3dbb1a68eab23ed6e681b478afeebe2b991b9f7b` |
| Materials | 9,048 | 0 | `015c249e2b2af6c90060fc15eab33943d9ce63ceecf2882ac4a5832cf17343f6` |
| Real estate | 9,048 | 0 | `8e42ee51eff8533bc1e4f11ae61995c905012a6d15ca1b19886235490bf94f58` |

The exclusions are INTC 2016-11-29 and 2016-11-30, AMZN 2016-11-16 (OHLC invariants), and LOW 2017-04-14 (exchange holiday). Source ZIP SHA-256: `adfd226694c6f3ec2c56b585d973764180a39a3ec516601721e90096dc1de94f`; compressed size 463,184,323 bytes; expanded CSV size 1,797,003,576 bytes. These describe the streamed cloud artifact, not a local file.

An independent Atlas aggregation over the ten current version IDs matched all counts, six assets and 1,508 sessions per panel, with zero duplicate keys, invalid OHLC ranges or inconsistent close adjustment factors. Every published snapshot also passed full normalized-hash readback in its cloud importer. Repeat import `ff5600a5-de2f-460e-aa53-590c7c51b319` completed with ten snapshots and `idempotent: true`, preserving counts and hashes. The intermediate consumer-discretionary snapshot is marked superseded and excluded from the current catalog; its original data is retained for reproducibility.

The project scan found no CSV, Parquet, JSONL, Arrow, Feather or market-data archive. The only ZIP in the ignored tools folder was the Atlas CLI installer. No dataset was written locally during this work, so no local dataset deletion was needed. Atlas remains the existing FREE cluster; no paid resource was enabled.

## Production acceptance — completed 08:38:53, 2026-11-28, Asia/Saigon

`scripts/equities-e2e.mjs` completed successfully against production revision `0218337e47aaca6d4670be1d1e18db71663b44cd`, deployment `dpl_35aXvfXdZJpVRwQpySPm8PQmZJqc`, engine `q-engine-1.1.0`. All **11 real cloud research runs** completed. [Release CI 46089850953](https://github.com/dakiemdarktharr/q_plat/actions/runs/46089850953) also passed **29 unit tests**, build, dependency audit and production/public-source checks. The earlier interrupted attempt was not counted as a completed E2E suite.

| Acceptance check | Observed result |
|---|---|
| Catalog and raw audit | Ten current panels, 60 unique stocks, 90,445 rows; bounded windows and no-store headers; AAPL's 2014-06-09 split ratio is 7, with the raw-price discontinuity absent from adjusted prices. |
| Independent arithmetic | Twenty-session momentum, sample volatility and cross-sectional percentile scores for all six technology stocks matched independent calculations from bounded real price windows within 1e-12. |
| Full-history research | Every panel completed 1,508 sessions and 9,048 result-grid cells. Finite signal metrics and returns, positive transaction costs, actual fills and linked score series passed. Result-grid cells at missing observations do not create source price bars. |
| Robustness | Technology retained all five stress/null trials and all three purged walk-forward folds, with both train candidates preserved per fold. |
| Reproduction | Technology rerun `19f4311b-f085-41bc-9512-80da01bc1d16` exactly matched original run `f611caf2-1a60-4dde-b4a8-8206ffc93c88`: hash `67c6982e38ac64dc30dd884bf9d083a34584ec84253505efe16ffeed07a74dd4` and identical account metrics. |
| MCP | Official SDK connected to production, discovered every new snapshot and read the audited AAPL split through a scoped token. The test token was revoked afterward. |
| Browser journey | Reopened the private equity run from Runs; price/score charts, six-stock cross-section, intermediate-variable trace, robustness view and source audit disclosure passed. All five primary screens passed the 390px overflow check. No browser JavaScript errors. |
| Local storage | localStorage, sessionStorage, IndexedDB, Cache Storage and service worker counts were zero. No payload files, screenshots, HAR or traces were written. |

Full-history run receipts: Technology `f611caf2-1a60-4dde-b4a8-8206ffc93c88`; Financials `64d3db8b-ec35-4f1c-8bc0-30bd80c565bd`; Healthcare `d39d8829-5264-4875-ab52-bd54ccbb105e`; Consumer discretionary `fadbda7a-6951-4ea9-8c6f-3cf2ebdd7c1e`; Consumer staples `936aae3e-54ae-4f81-8ed1-5cf8b47a40d7`; Energy `3402db5f-13de-49b4-a8d0-29820cbf2e74`; Industrials `8b224fc1-377b-4185-a55b-7d0b0dca4f6d`; Utilities `5efd0e7f-9f4d-47c2-9f48-927ad2d6a61b`; Materials `220b3e71-d20f-40f8-a8f9-72c5cba40e1a`; Real estate `5627039f-9f7a-44c1-9a1f-99aad75f0e68`. These remain private workspace results; IDs are scalar audit receipts, not public report links.

HTML SHA-256: `a65d93b6ecebe4f9462e906df8ef8348ec5b6406045d48cef4ab90f8ae9c0d93`. Subsequent documentation-only commits use the same frontend and engine; the repository release check verifies current HEAD against production and `/download`.
