export const CATALOG = {
  uci: {
    id: "uci",
    name: "UCI · Dow Jones sample",
    kind: "ohlcv",
    reality: "Real",
    frequency: "Weekly",
    annualization: 52,
    assetClass: "US equities",
    currency: "USD",
    fields: ["open", "high", "low", "close", "volume"],
    units: {
      open: "USD/share",
      high: "USD/share",
      low: "USD/share",
      close: "USD/share",
      volume: "shares/week",
    },
    timezone: "America/New_York",
    calendar: "Observed week-end dates in UCI, 2011 H1",
    adjustment: "Raw price-only; dividends and survivorship not corrected",
    source: "https://archive.ics.uci.edu/dataset/312/dow%2Bjones%2Bindex",
    download:
      "https://archive.ics.uci.edu/static/public/312/dow%2Bjones%2Bindex.zip",
    license: "CC BY 4.0",
    attribution:
      "Michael Brown (2014), Dow Jones Index, UCI Machine Learning Repository. DOI:10.24432/C5788V",
    lag: "Decision at week-end 23:59 UTC; next-week open proxy at Monday 14:30 UTC. Exact historic release times unknown; NOT point-in-time verified.",
    revision: "Publisher archive as retrieved; content-addressed snapshots",
    limitations:
      "30 historical constituents; 25 weeks, not a multi-year history. equal-weight sample is not the official Dow Jones index.",
  },
  ecb: {
    id: "ecb",
    name: "ECB · Euro reference FX",
    kind: "reference",
    reality: "Real",
    frequency: "Business daily",
    annualization: 252,
    assetClass: "FX reference fixing",
    currency: "foreign currency per EUR",
    fields: ["close"],
    units: { close: "units of foreign currency per EUR" },
    timezone: "Europe/Frankfurt",
    calendar: "ECB published business-day observations",
    adjustment: "Original published reference rates; no fabricated OHLC/volume",
    source:
      "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
    download:
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+JPY+CHF+CAD+AUD.EUR.SP00.A?startPeriod=2010-01-01&endPeriod=2024-12-31&format=csvdata",
    license:
      "ESCB statistics reuse policy; quote source, preserve statistics and metadata",
    licenseUrl:
      "https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html",
    attribution:
      "Source: ECB statistics. Derived scores and returns are q_plat calculations, not ECB statistics.",
    lag: "Conservative next-calendar-day 00:00 UTC availability proxy; historical publication times unverified.",
    revision:
      "Latest revised vintage retrieved from ECB; NOT point-in-time verified",
    limitations:
      "Reference fixing is not an executable quote. Research mode only; no open-price simulation.",
  },
  synthetic: {
    id: "synthetic",
    name: "Synthetic · Regime laboratory",
    kind: "ohlcv",
    reality: "Synthetic",
    frequency: "Business daily",
    annualization: 252,
    assetClass: "Synthetic equities",
    currency: "SIM",
    fields: ["open", "high", "low", "close", "volume"],
    units: {
      open: "SIM/share",
      high: "SIM/share",
      low: "SIM/share",
      close: "SIM/share",
      volume: "synthetic shares",
    },
    timezone: "UTC",
    calendar: "Weekdays starting 2018-01-01, 1,200 sessions",
    adjustment:
      "Synthetic raw prices; corporate action fixture isolated separately",
    source: "generator:synthetic-v1",
    license: "CC0 (generated)",
    attribution: "q_plat seeded generator; not market data",
    seed: 271828,
    generatorVersion: "synthetic-v1",
    lag: "Observed close at 21:00 UTC; available at 21:01; next open 14:30.",
    revision: "Deterministic generator + seed",
    limitations:
      "28 assets, 4 sectors; momentum regimes, null innovations, missing sessions, zero volume, late listing. Synthetic at all times.",
  },
};
export const OPTIONAL_SOURCES = [
  {
    name: "CryptoDataDownload",
    status: "Not imported",
    reason:
      "Public redistribution rights of underlying venue data not sufficiently explicit. Optional adapter omitted.",
    source: "https://www.cryptodatadownload.com/terms-of-use/",
  },
];
