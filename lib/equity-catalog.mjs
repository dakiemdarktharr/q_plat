// Ten distinct research universes from one frozen public-domain price archive.
// These are explicitly curated panels, not ten independent vendor feeds or index histories.
export const EQUITY_BUNDLE = "wiki_sectors";
export const WIKI_ARCHIVE =
  "https://www.kaggle.com/api/v1/datasets/download/marketneutral/quandl-wiki-prices-us-equites?datasetVersionNumber=1";
export const EQUITY_CATALOG = Object.fromEntries(
  [
    [
      "technology",
      "Technology",
      ["AAPL", "MSFT", "INTC", "CSCO", "ORCL", "IBM"],
    ],
    ["financials", "Financials", ["JPM", "BAC", "WFC", "C", "GS", "MS"]],
    ["healthcare", "Healthcare", ["JNJ", "PFE", "MRK", "ABT", "AMGN", "GILD"]],
    [
      "consumer_discretionary",
      "Consumer discretionary",
      ["AMZN", "HD", "MCD", "NKE", "SBUX", "LOW"],
    ],
    [
      "consumer_staples",
      "Consumer staples",
      ["KO", "PEP", "PG", "WMT", "COST", "CL"],
    ],
    ["energy", "Energy", ["XOM", "CVX", "COP", "SLB", "EOG", "OXY"]],
    ["industrials", "Industrials", ["CAT", "DE", "MMM", "HON", "UPS", "UNP"]],
    ["utilities", "Utilities", ["DUK", "SO", "D", "AEP", "EXC", "XEL"]],
    ["materials", "Materials", ["APD", "ECL", "FCX", "NEM", "NUE", "EMN"]],
    ["real_estate", "Real estate", ["AMT", "SPG", "PLD", "PSA", "AVB", "EQR"]],
  ].map(([slug, sector, symbols]) => {
    const id = "wiki_" + slug;
    return [
      id,
      {
        id,
        name: "US equities / " + sector,
        provider: "wiki",
        kind: "ohlcv",
        reality: "Real",
        frequency: "Business daily",
        annualization: 252,
        assetClass: "US equities / curated " + sector + " panel",
        currency: "USD",
        fields: ["open", "high", "low", "close", "volume"],
        units: {
          open: "adjusted USD/share",
          high: "adjusted USD/share",
          low: "adjusted USD/share",
          close: "adjusted USD/share",
          volume: "split-adjusted shares/day",
        },
        timezone: "America/New_York",
        calendar: "Observed US trading sessions, 2012-01-01 through 2017-12-31",
        symbols,
        sector,
        from: "2012-01-01",
        to: "2017-12-31",
        source: "https://data.nasdaq.com/databases/WIKIP",
        mirror:
          "https://www.kaggle.com/datasets/marketneutral/quandl-wiki-prices-us-equites",
        download: WIKI_ARCHIVE,
        sourceVersion: 1,
        normalizerVersion: "wiki-panels-1",
        license:
          "Public domain (Quandl WIKI Prices); publisher attribution retained",
        licenseUrl: "https://data.nasdaq.com/databases/WIKIP",
        attribution:
          "Quandl community / Nasdaq Data Link WIKI Prices. Frozen archive mirrored by marketneutral on Kaggle, version 1 (2022-02-02). qtpatuti curated the universe and date range; no raw price or corporate-action values were invented.",
        adjustment:
          "Publisher adjusted OHLC and volume. Raw OHLCV, cash dividend, split ratio and adjustment factor retained for audit. Adjusted-unit simulation approximates reinvested distributions; do not add dividends again. Fill prices are adjusted research units, not historical executable dollar prices.",
        lag: "NYSE local 09:30 open with DST; conservative daily 23:59:59 UTC availability proxy. Back-adjusted, final-vintage archive; NOT point-in-time verified.",
        revision:
          "Frozen source ending March 2018; selected 2012–2017 only. Nasdaq no longer maintains or recommends WIKI for investment/analysis. Imported subset must pass independent structural and adjustment checks; vendor warning remains applicable.",
        limitations:
          "Historical daily-signal research only. Six explicitly selected surviving stocks per panel, not a historical sector index or survivor-free universe. No delisted-return model, bid/ask or intraday fill evidence. Cross-sectional sample is small. Costs and walk-forward tests do not establish current trading viability.",
      },
    ];
  }),
);
