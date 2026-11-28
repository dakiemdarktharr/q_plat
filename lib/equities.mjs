import { createHash } from "node:crypto";
import { Unzip, UnzipInflate } from "fflate";
import { EQUITY_CATALOG, WIKI_ARCHIVE } from "./equity-catalog.mjs";

const wanted = new Map(
  Object.values(EQUITY_CATALOG).flatMap((m) => m.symbols.map((s) => [s, m])),
);
const priceFields = ["open", "high", "low", "close", "volume"];
const required = [
  "ticker",
  "date",
  ...priceFields,
  "ex-dividend",
  "split_ratio",
  ...priceFields.map((f) => "adj_" + f),
];
const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  hourCycle: "h23",
});
export function equityHeader(line) {
  const keys = line
    .replace(/^\uFEFF/, "")
    .split(",")
    .map((x) =>
      x.trim().replace(/^"|"$/g, "").toLowerCase().replaceAll(" ", "_"),
    );
  if (!required.every((k) => keys.includes(k)))
    throw new Error("WIKI archive schema changed.");
  return Object.fromEntries(keys.map((key, i) => [key, i]));
}
export function parseEquityLine(line, header) {
  const cols = line
    .trim()
    .split(",")
    .map((x) => x.replace(/^"|"$/g, ""));
  const asset = cols[header.ticker],
    meta = wanted.get(asset),
    date = cols[header.date];
  if (!meta || date < meta.from || date > meta.to) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid WIKI date.");
  const n = (key) => {
    const text = cols[header[key]],
      value = Number(text);
    if (text === undefined || text === "" || !Number.isFinite(value))
      throw new Error("Missing/nonfinite WIKI field: " + key);
    return value;
  };
  const raw = Object.fromEntries(priceFields.map((f) => [f, n(f)]));
  const adjusted = Object.fromEntries(
    priceFields.map((f) => [f, n("adj_" + f)]),
  );
  for (const prices of [raw, adjusted]) {
    if (
      ["open", "high", "low", "close"].some((f) => prices[f] <= 0) ||
      prices.volume < 0 ||
      prices.low > Math.min(prices.open, prices.close) ||
      prices.high < Math.max(prices.open, prices.close)
    )
      throw new Error("Invalid WIKI OHLCV invariant.");
  }
  const factor = adjusted.close / raw.close;
  for (const f of ["open", "high", "low"])
    if (
      Math.abs(adjusted[f] - raw[f] * factor) >
      Math.max(0.001, Math.abs(adjusted[f]) * 1e-6)
    )
      throw new Error("Inconsistent WIKI OHLC adjustment.");
  const dividend = n("ex-dividend"),
    splitRatio = n("split_ratio");
  if (dividend < 0 || splitRatio <= 0)
    throw new Error("Invalid WIKI corporate action.");
  const hour =
    Number(eastern.format(new Date(date + "T14:30:00Z"))) === 9 ? "14" : "13";
  return {
    dataset: meta.id,
    row: {
      asset,
      date,
      ...adjusted,
      group: meta.sector,
      availableAt: date + "T23:59:59Z",
      openAt: date + "T" + hour + ":30:00Z",
      rawOpen: raw.open,
      rawHigh: raw.high,
      rawLow: raw.low,
      rawClose: raw.close,
      rawVolume: raw.volume,
      cashDividend: dividend,
      splitRatio,
      adjustmentFactor: factor,
    },
  };
}

export function auditEquityPanel(rows, meta) {
  const byAsset = new Map(meta.symbols.map((s) => [s, []])),
    dates = new Set(),
    keys = new Set();
  for (const r of rows) {
    if (!byAsset.has(r.asset)) throw new Error("Unexpected equity universe.");
    const key = r.asset + "|" + r.date;
    if (keys.has(key)) throw new Error("Duplicate equity observation.");
    keys.add(key);
    dates.add(r.date);
    byAsset.get(r.asset).push(r);
  }
  let largeMoves = 0;
  for (const series of byAsset.values()) {
    series.sort((a, b) => a.date.localeCompare(b.date));
    if (series.length < 1400 || series.length / dates.size < 0.97)
      throw new Error("Equity history/coverage gate failed.");
    for (let i = 1; i < series.length; i++)
      if (Math.abs(series[i].close / series[i - 1].close - 1) > 0.5)
        largeMoves++;
  }
  if (largeMoves)
    throw new Error(
      "Adjusted daily move exceeds 50%; manual source reconciliation required.",
    );
  return {
    assets: byAsset.size,
    sessions: dates.size,
    largeMoves,
    dividends: rows.filter((r) => r.cashDividend > 0).length,
    splits: rows.filter((r) => r.splitRatio !== 1).length,
    minimumAssetSessions: Math.min(
      ...[...byAsset.values()].map((x) => x.length),
    ),
  };
}

export async function readEquityArchive(check = async () => {}) {
  if (!process.env.VERCEL_DEPLOYMENT_ID)
    throw new Error("Equity ingestion is cloud-only.");
  const signal = AbortSignal.timeout(210000);
  let response = await fetch(WIKI_ARCHIVE, {
    cache: "no-store",
    redirect: "manual",
    signal,
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get("location"), WIKI_ARCHIVE);
    if (
      location.protocol !== "https:" ||
      location.hostname !== "storage.googleapis.com"
    )
      throw new Error("Unapproved archive redirect.");
    await response.body?.cancel();
    response = await fetch(location, {
      cache: "no-store",
      redirect: "error",
      signal,
    });
  }
  if (!response.ok) throw new Error("WIKI archive HTTP " + response.status);
  const groups = Object.fromEntries(
    Object.keys(EQUITY_CATALOG).map((id) => [id, []]),
  );
  const digest = createHash("sha256"),
    decoder = new TextDecoder();
  let compressed = 0,
    expanded = 0,
    pending = "",
    header,
    error,
    matched = 0,
    complete = false,
    selected = 0,
    lastCheck = Date.now();
  const unzip = new Unzip((file) => {
    if (file.name.split("/").at(-1) !== "WIKI_PRICES.csv") return;
    if (++matched !== 1) throw new Error("Duplicate archive member.");
    file.ondata = (err, bytes, final) => {
      if (err || error) {
        error ||= err;
        return;
      }
      try {
        expanded += bytes.length;
        if (expanded > 2000 * 1024 * 1024)
          throw new Error("WIKI expanded-size limit.");
        pending += decoder.decode(bytes, { stream: !final });
        const lines = pending.split("\n");
        pending = lines.pop();
        if (pending.length > 8192) throw new Error("WIKI row length limit.");
        if (final && pending.trim()) {
          lines.push(pending);
          pending = "";
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          if (!header) {
            header = equityHeader(line);
            continue;
          }
          // Filter tickers before parsing numbers; the large archive stays streamed in RAM.
          const firstComma = line.indexOf(",");
          if (
            header.ticker === 0 &&
            !wanted.has(line.slice(0, firstComma).replaceAll('"', ""))
          )
            continue;
          const parsed = parseEquityLine(line, header);
          if (parsed) {
            groups[parsed.dataset].push(parsed.row);
            if (++selected > 100000) throw new Error("Equity panel row limit.");
          }
        }
        complete = final;
      } catch (e) {
        error = e;
        file.terminate();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of response.body) {
      compressed += chunk.length;
      if (compressed > 600 * 1024 * 1024)
        throw new Error("WIKI compressed-size limit.");
      digest.update(chunk);
      unzip.push(chunk);
      if (error) throw error;
      if (Date.now() - lastCheck > 5000) {
        await check();
        lastCheck = Date.now();
      }
    }
    unzip.push(new Uint8Array(), true);
    if (error) throw error;
    if (matched !== 1 || !complete || !header)
      throw new Error("Incomplete WIKI archive.");
  } catch (e) {
    await response.body?.cancel().catch(() => {});
    throw e;
  }
  return {
    groups,
    sourceArtifact: {
      sha256: digest.digest("hex"),
      compressedBytes: compressed,
      expandedBytes: expanded,
      member: "WIKI_PRICES.csv",
      sourceVersion: 1,
    },
  };
}
