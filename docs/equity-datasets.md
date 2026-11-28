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
