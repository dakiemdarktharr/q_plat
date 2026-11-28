import { createHash } from "node:crypto";

export const SP500_CONSTITUENTS_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
export const WIKI_COHORT_BUNDLE = "wiki_sp500_cohorts_70";
export const WIKI_COHORT_PLAN_ID = "wiki_sp500_cohorts_plan_v1";
export const WIKI_COHORT_COUNT = 70;

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else value += char;
  }
  if (quoted) throw new Error("Constituent CSV has an unterminated quote.");
  values.push(value);
  return values;
}

export function parseConstituentsCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("Constituent CSV is empty.");
  const headers = parseCsvLine(lines.shift()).map((value) => value.trim());
  const indexes = Object.fromEntries(
    headers.map((value, index) => [value, index]),
  );
  for (const field of ["Symbol", "GICS Sector", "GICS Sub-Industry"])
    if (!(field in indexes)) throw new Error("Constituent CSV schema changed.");
  const seen = new Set();
  const constituents = [];
  for (const line of lines) {
    const row = parseCsvLine(line);
    const symbol = row[indexes.Symbol]?.trim().toUpperCase();
    const sector = row[indexes["GICS Sector"]]?.trim();
    const subIndustry = row[indexes["GICS Sub-Industry"]]?.trim();
    if (
      !/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol || "") ||
      !sector ||
      !subIndustry
    )
      continue;
    if (seen.has(symbol)) throw new Error("Duplicate constituent ticker.");
    seen.add(symbol);
    constituents.push({ symbol, sector, subIndustry });
  }
  if (constituents.length < 400)
    throw new Error("Constituent CSV is incomplete.");
  return constituents.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function constituentSourceHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function selectEligibleConstituents(
  constituents,
  stats,
  sessions = 1509,
) {
  return constituents
    .map((item) => ({ ...item, ...stats[item.symbol] }))
    .filter(
      (item) =>
        item.count >= 1400 &&
        item.count / sessions >= 0.97 &&
        item.rejected / Math.max(1, item.count + item.rejected) <= 0.005 &&
        item.largeMoves === 0 &&
        item.orderErrors === 0,
    );
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function windows(items, stride, limit = 500) {
  const result = [];
  for (
    let start = 0;
    start + 6 <= items.length && result.length < limit;
    start += stride
  )
    result.push(items.slice(start, start + 6));
  return result;
}

function lexicographicCombinations(items, limit) {
  const result = [];
  const indexes = [];
  function visit(start) {
    if (result.length >= limit) return;
    if (indexes.length === 6) {
      result.push(indexes.map((index) => items[index]));
      return;
    }
    const need = 6 - indexes.length;
    for (
      let i = start;
      i <= items.length - need && result.length < limit;
      i++
    ) {
      indexes.push(i);
      visit(i + 1);
      indexes.pop();
    }
  }
  visit(0);
  return result;
}

export function buildWikiCohortPlan(
  eligible,
  { count = WIKI_COHORT_COUNT, existing = [] } = {},
) {
  const uniqueExisting = new Set(
    existing.map((symbols) => [...symbols].sort().join("|")),
  );
  const bySector = new Map();
  for (const item of [...eligible].sort(
    (a, b) =>
      a.sector.localeCompare(b.sector) || a.symbol.localeCompare(b.symbol),
  )) {
    const list = bySector.get(item.sector) || [];
    list.push(item);
    bySector.set(item.sector, list);
  }

  const queues = [...bySector.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sector, items]) => {
      const candidates = [
        ...windows(items, 3),
        ...windows(items, 2),
        ...windows(items, 1),
        ...lexicographicCombinations(items, 300),
      ];
      const seen = new Set();
      return {
        sector,
        items,
        candidates: candidates.filter((group) => {
          const key = group
            .map((x) => x.symbol)
            .sort()
            .join("|");
          if (seen.has(key) || uniqueExisting.has(key)) return false;
          seen.add(key);
          return true;
        }),
        index: 0,
      };
    });

  const selected = [];
  const selectedKeys = new Set(uniqueExisting);
  const usedSymbols = new Set();
  const overlaps = new Set();
  const allowOverlap = [false, true];
  let overlapPhase = 0;
  while (selected.length < count && overlapPhase < allowOverlap.length) {
    let added = false;
    for (const queue of queues) {
      while (queue.index < queue.candidates.length) {
        const symbols = queue.candidates[queue.index++];
        const key = symbols
          .map((x) => x.symbol)
          .sort()
          .join("|");
        if (selectedKeys.has(key)) continue;
        if (
          !allowOverlap[overlapPhase] &&
          symbols.some((item) => usedSymbols.has(item.symbol))
        )
          continue;
        selectedKeys.add(key);
        selected.push({ sector: queue.sector, members: symbols });
        if (symbols.some((item) => usedSymbols.has(item.symbol)))
          overlaps.add(selected.length - 1);
        for (const item of symbols) usedSymbols.add(item.symbol);
        added = true;
        break;
      }
      if (selected.length === count) break;
    }
    if (selected.length === count) break;
    if (added) continue;
    if (!allowOverlap[overlapPhase]) {
      overlapPhase++;
      continue;
    }

    const all = [...eligible].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const crossSector = [
      ...windows(all, 2, 2000),
      ...windows(all, 1, 2000),
      ...lexicographicCombinations(all, 2000),
    ];
    for (const members of crossSector) {
      const key = members
        .map((x) => x.symbol)
        .sort()
        .join("|");
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      if (members.some((item) => usedSymbols.has(item.symbol)))
        overlaps.add(selected.length);
      for (const item of members) usedSymbols.add(item.symbol);
      const sectors = new Set(members.map((x) => x.sector));
      selected.push({
        sector: sectors.size === 1 ? [...sectors][0] : "Cross-sector",
        members,
      });
      if (selected.length === count) break;
    }
    break;
  }
  if (selected.length < count)
    throw new Error(
      `Only ${selected.length} distinct six-stock panels passed source screening; ${count} required.`,
    );

  const ordinals = new Map();
  return selected.map(({ sector, members }, index) => {
    const category = slug(sector) || "cross_sector";
    const ordinal = (ordinals.get(category) || 0) + 1;
    ordinals.set(category, ordinal);
    const id = `wiki_sp500_${String(index + 1).padStart(3, "0")}`;
    const symbols = members.map((item) => item.symbol);
    const meta = {
      id,
      name: `US equities / ${sector} cohort ${String(ordinal).padStart(2, "0")}`,
      provider: "wiki",
      kind: "ohlcv",
      reality: "Real",
      frequency: "Business daily",
      annualization: 252,
      assetClass: "US equities / six-stock research cohort",
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
      overlap: overlaps.has(index),
      sector,
      subIndustries: [...new Set(members.map((item) => item.subIndustry))],
      from: "2012-01-01",
      to: "2017-12-31",
      source: "https://data.nasdaq.com/databases/WIKIP",
      mirror:
        "https://www.kaggle.com/datasets/marketneutral/quandl-wiki-prices-us-equites",
      download:
        "https://www.kaggle.com/api/v1/datasets/download/marketneutral/quandl-wiki-prices-us-equites?datasetVersionNumber=1",
      sourceVersion: 1,
      normalizerVersion: "wiki-sp500-cohorts-1",
      license:
        "Public domain (Quandl WIKI Prices); publisher attribution retained",
      licenseUrl: "https://data.nasdaq.com/databases/WIKIP",
      attribution:
        "Prices: Quandl community / Nasdaq Data Link WIKI Prices, frozen Kaggle mirror version 1. Constituent and GICS metadata: datasets/s-and-p-500-companies, sourced from Wikipedia, ODC-PDDL-1.0. qtpatuti curated an overlapping universe; no raw price or corporate-action values were invented.",
      adjustment:
        "Publisher adjusted OHLC and volume. Raw OHLCV, cash dividend, split ratio and adjustment factor retained for audit. Adjusted-unit simulation approximates reinvested distributions; do not add dividends again. Fill prices are adjusted research units, not historical executable dollar prices.",
      lag: "NYSE local 09:30 open with DST; conservative daily 23:59:59 UTC availability proxy. Back-adjusted, final-vintage archive; NOT point-in-time verified.",
      revision:
        "Frozen source ending March 2018; selected 2012–2017 only. Nasdaq no longer maintains or recommends WIKI for investment/analysis. Current S&P constituent metadata selects a survivorship-biased subset and is not a historical membership file.",
      limitations:
        "Exploratory historical daily-signal research only. Cohorts may overlap each other and the original WIKI sector panels; results across cohorts are not independent replications. Current constituent selection creates survivor and look-ahead universe bias. No delisted-return model, bid/ask or intraday fill evidence. Adjusted fills are not executable prices. Costs and walk-forward tests do not establish current trading viability.",
      universeMethod: overlaps.has(index)
        ? "Six-stock rolling/combination cohort; symbols recur across datasets."
        : "Six-stock cohort with no symbols repeated in other selected cohorts.",
      universeSource: "https://github.com/datasets/s-and-p-500-companies",
      universeLicense: "ODC-PDDL-1.0",
    };
    return { id, meta, members };
  });
}
