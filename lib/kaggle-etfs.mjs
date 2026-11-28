import { createHash } from "node:crypto";
import { isKaggleEtfSession, KAGGLE_ETF_SESSIONS } from "./etf-calendar.mjs";

export const KAGGLE_ETF_BUNDLE = "kaggle_etf_objective_panels_70";
export const KAGGLE_ETF_PLAN_ID = "kaggle_etf_objective_panels_70_v3";
export const KAGGLE_ETF_COUNT = 70;
export const KAGGLE_ETFS_PER_PANEL = 6;
export const KAGGLE_SOURCE_VERSION = 2;
export const KAGGLE_OWNER = "jacksoncrow";
export const KAGGLE_SLUG = "stock-market-dataset";
export const KAGGLE_FROM = "2015-01-02";
export const KAGGLE_TO = "2020-04-01";
export const MIN_ETF_COVERAGE = 0.97;
export const MIN_MEDIAN_DOLLAR_VOLUME = 250_000;

export const ETF_OBJECTIVES = [
  { id: "momentum", label: "Time-series momentum" },
  { id: "mean_reversion", label: "Mean reversion" },
  { id: "volatility", label: "Volatility scaling" },
  { id: "cross_section", label: "Cross-sectional rank" },
  { id: "liquidity", label: "Liquidity and volume" },
  { id: "overnight", label: "Gap and overnight" },
  { id: "robustness", label: "Robustness controls" },
];

export const KAGGLE_ETF_SOURCE = {
  id: KAGGLE_ETF_BUNDLE,
  name: "Kaggle / US ETF research panels",
  kind: "ohlcv",
  reality: "Real",
  frequency: "Business daily",
  annualization: 252,
  assetClass: "US-listed ETFs",
  currency: "USD",
  fields: ["open", "high", "low", "close", "volume"],
  units: {
    open: "final-vintage adjusted USD/share",
    high: "final-vintage adjusted USD/share",
    low: "final-vintage adjusted USD/share",
    close: "dividend-and-split-adjusted USD/share",
    volume: "split-adjusted shares/day",
  },
  timezone: "America/New_York",
  calendar: "NYSE sessions, 2015-01-02 through 2020-04-01",
  source: `https://www.kaggle.com/datasets/${KAGGLE_OWNER}/${KAGGLE_SLUG}`,
  download: `https://www.kaggle.com/api/v1/datasets/download/${KAGGLE_OWNER}/${KAGGLE_SLUG}`,
  license: "Kaggle release metadata: CC0: Public Domain",
  attribution:
    "Oleh Onyshchak's Kaggle Stock Market Dataset, version 2; historical prices retrieved from Yahoo Finance via yfinance.",
  adjustment:
    "Source OHLC is adjusted by Adj Close / Close; Adj Close is used as close. Volume remains the source's split-adjusted volume. Source prices and the adjustment factor are retained for audit.",
  lag: "Daily bars are available only after the session. Availability is conservatively set to 23:59:59 UTC; historical publication times are not verified.",
  revision:
    "Pinned Kaggle version 2, last updated 2020-04-02; final-vintage adjusted values, not point-in-time data.",
  limitations:
    "The release declares CC0 and says the files originate from Yahoo Finance/yfinance. The universe contains ETFs trading at the 2020 snapshot and is subject to survivorship and selection bias. Each entry is a six-ETF research panel from one historical source, not an independent vendor history. Exploratory research only.",
};

const LEVERAGED_OR_VOLATILITY = new Set(
  `AGQ BOIL BNKU BNKD DUST DGP DZZ ERX ERY FAZ FAS GLL JDST JNUG LABD LABU NUGT QID QLD SCO SDOW SOXL SOXS SPXL SPXS SPXU SQQQ SSO SVXY TNA TQQQ TZA TECL TECS TMF TMV TVIX UCO UGL UPRO UVXY VIXM VIXY VXX XIV ZSL`.split(
    " ",
  ),
);

function parseCsv(text) {
  const records = [];
  let row = [],
    field = "",
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) records.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unterminated quote.");
  if (field || row.length) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) records.push(row);
  }
  return records;
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function rounded(value, places = 6) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

const easternHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
});

export function parseKaggleEtfCsv(text, symbol) {
  const records = parseCsv(text);
  if (records.length < 2) throw new Error("CSV has no price history.");
  const headers = records.shift().map((value) =>
    value
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
  );
  const index = Object.fromEntries(
    headers.map((name, position) => [name, position]),
  );
  for (const name of [
    "date",
    "open",
    "high",
    "low",
    "close",
    "adj_close",
    "volume",
  ])
    if (!Number.isInteger(index[name]))
      throw new Error("CSV is missing required field: " + name);

  const sessions = new Set(KAGGLE_ETF_SESSIONS),
    rows = [],
    dollarVolumes = [];
  let lastDate = "",
    invalidRows = 0,
    zeroVolumeRows = 0,
    largeMoves = 0,
    lastAdjustedClose = null;

  for (const cells of records) {
    const date = cells[index.date]?.trim();
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new Error("CSV has an invalid date.");
    if (lastDate && date <= lastDate)
      throw new Error("CSV dates are duplicate or out of order.");
    lastDate = date;
    if (date < KAGGLE_FROM || date > KAGGLE_TO) continue;
    if (!sessions.has(date) || !isKaggleEtfSession(date))
      throw new Error("CSV contains a date outside the NYSE session calendar.");

    const number = (name) => {
      const raw = cells[index[name]]?.trim();
      if (!raw || raw.toLowerCase() === "null") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    const raw = Object.fromEntries(
      ["open", "high", "low", "close", "volume"].map((name) => [
        name,
        number(name),
      ]),
    );
    const adjClose = number("adj_close");
    if (
      Object.values(raw).some((value) => value === null) ||
      adjClose === null ||
      [raw.open, raw.high, raw.low, raw.close, adjClose].some(
        (value) => value <= 0,
      ) ||
      raw.volume < 0 ||
      raw.low > Math.min(raw.open, raw.close) ||
      raw.high < Math.max(raw.open, raw.close)
    ) {
      invalidRows++;
      continue;
    }
    const factor = adjClose / raw.close,
      adjusted = {
        open: raw.open * factor,
        high: raw.high * factor,
        low: raw.low * factor,
        close: adjClose,
      };
    if (
      !Number.isFinite(factor) ||
      factor <= 0 ||
      Object.values(adjusted).some((value) => !Number.isFinite(value)) ||
      adjusted.low > Math.min(adjusted.open, adjusted.close) ||
      adjusted.high < Math.max(adjusted.open, adjusted.close)
    ) {
      invalidRows++;
      continue;
    }
    if (
      lastAdjustedClose !== null &&
      Math.abs(adjusted.close / lastAdjustedClose - 1) > 0.5
    )
      largeMoves++;
    lastAdjustedClose = adjusted.close;
    if (raw.volume === 0) zeroVolumeRows++;
    else dollarVolumes.push(raw.close * raw.volume);

    const etHour = Number(easternHour.format(new Date(`${date}T14:30:00Z`))),
      openUtcHour = etHour === 9 ? "14" : "13";
    rows.push({
      asset: symbol,
      date,
      ...adjusted,
      volume: raw.volume,
      availableAt: `${date}T23:59:59Z`,
      openAt: `${date}T${openUtcHour}:30:00Z`,
      sourceOpen: raw.open,
      sourceHigh: raw.high,
      sourceLow: raw.low,
      sourceClose: raw.close,
      adjustmentFactor: factor,
    });
  }

  const expected = KAGGLE_ETF_SESSIONS.length,
    coverage = rows.length / expected,
    medianDollarVolume = median(dollarVolumes),
    zeroVolumeFraction = rows.length ? zeroVolumeRows / rows.length : 1,
    invalidFraction =
      (invalidRows + zeroVolumeRows) / Math.max(1, rows.length + invalidRows);
  if (rows.length < Math.ceil(expected * MIN_ETF_COVERAGE))
    throw new Error("ETF history coverage is below 97% of exchange sessions.");
  if (invalidFraction > 0.005)
    throw new Error("ETF has too many malformed or zero-volume rows.");
  if (medianDollarVolume < MIN_MEDIAN_DOLLAR_VOLUME)
    throw new Error("ETF median dollar volume is below the liquidity floor.");
  if (largeMoves)
    throw new Error(
      "ETF has an adjusted daily move above 50% requiring reconciliation.",
    );

  return {
    rows,
    quality: {
      expectedSessions: expected,
      observations: rows.length,
      coverage: rounded(coverage, 6),
      firstDate: rows[0].date,
      lastDate: rows.at(-1).date,
      medianDollarVolume: rounded(medianDollarVolume, 2),
      positiveVolumeFraction: rounded(1 - zeroVolumeFraction, 6),
      invalidRows,
      zeroVolumeRows,
      largeMoves,
    },
  };
}

export function isEligibleKaggleEtfFile(file) {
  if (
    typeof file?.name !== "string" ||
    !/^etfs\/[A-Za-z0-9.-]+\.csv$/i.test(file.name)
  )
    return false;
  const symbol = file.name
    .split("/")
    .at(-1)
    .replace(/\.csv$/i, "")
    .toUpperCase();
  return (
    /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol) &&
    !LEVERAGED_OR_VOLATILITY.has(symbol) &&
    Number.isSafeInteger(Number(file.totalBytes)) &&
    Number(file.totalBytes) >= 10_000 &&
    Number(file.totalBytes) <= 5_000_000
  );
}

export function buildKaggleEtfCandidates(files) {
  const unique = new Map();
  for (const file of files) {
    if (!isEligibleKaggleEtfFile(file)) continue;
    const symbol = file.name
      .split("/")
      .at(-1)
      .replace(/\.csv$/i, "")
      .toUpperCase();
    if (!unique.has(symbol))
      unique.set(symbol, {
        name: file.name,
        symbol,
        totalBytes: Number(file.totalBytes),
      });
  }
  return [...unique.values()].sort(
    (a, b) =>
      b.totalBytes - a.totalBytes ||
      createHash("sha256")
        .update(`etf-v${KAGGLE_SOURCE_VERSION}:${a.symbol}`)
        .digest("hex")
        .localeCompare(
          createHash("sha256")
            .update(`etf-v${KAGGLE_SOURCE_VERSION}:${b.symbol}`)
            .digest("hex"),
        ),
  );
}

export function kaggleEtfPanelMeta(panelIndex, symbols) {
  if (
    !Number.isInteger(panelIndex) ||
    panelIndex < 0 ||
    panelIndex >= KAGGLE_ETF_COUNT
  )
    throw new Error("Kaggle ETF panel index is out of range.");
  if (
    symbols.length !== KAGGLE_ETFS_PER_PANEL ||
    new Set(symbols).size !== symbols.length
  )
    throw new Error("Each ETF panel must contain six distinct symbols.");
  const objective = ETF_OBJECTIVES[Math.floor(panelIndex / 10)],
    panelNumber = (panelIndex % 10) + 1,
    id = `kaggle_etf_${String(panelIndex + 1).padStart(3, "0")}`;
  return {
    id,
    name: `US ETF / ${objective.label} / ${String(panelNumber).padStart(2, "0")}`,
    provider: "kaggle-jacksoncrow",
    kind: "ohlcv",
    reality: "Real",
    frequency: "Business daily",
    annualization: 252,
    assetClass: "US-listed ETF research panel",
    objective: objective.label,
    objectiveId: objective.id,
    panelNumber,
    currency: "USD",
    fields: ["open", "high", "low", "close", "volume"],
    units: KAGGLE_ETF_SOURCE.units,
    timezone: "America/New_York",
    calendar: KAGGLE_ETF_SOURCE.calendar,
    symbols: [...symbols],
    from: KAGGLE_FROM,
    to: KAGGLE_TO,
    source: KAGGLE_ETF_SOURCE.source,
    sourceVersion: KAGGLE_SOURCE_VERSION,
    license: KAGGLE_ETF_SOURCE.license,
    attribution: KAGGLE_ETF_SOURCE.attribution,
    adjustment: KAGGLE_ETF_SOURCE.adjustment,
    lag: KAGGLE_ETF_SOURCE.lag,
    revision: KAGGLE_ETF_SOURCE.revision,
    limitations: KAGGLE_ETF_SOURCE.limitations,
  };
}
