import { quantile } from "./metrics.mjs";
export function aggregateBars(rows, limit = 350, frame = 1) {
  const width = Math.max(frame, Math.ceil(rows.length / limit)),
    out = [];
  for (let i = 0; i < rows.length; i += width) {
    const group = rows.slice(i, i + width),
      first = group[0],
      last = group.at(-1),
      ohlc = first.open !== undefined;
    out.push({
      ...last,
      startDate: first.date,
      sourceCount: group.length,
      ...(ohlc
        ? {
            open: first.open,
            high: Math.max(...group.map((r) => r.high)),
            low: Math.min(...group.map((r) => r.low)),
            close: last.close,
            volume: group.reduce((s, r) => s + r.volume, 0),
          }
        : {}),
    });
  }
  return out;
}
export function distribution(rows, field = "close") {
  const values = rows.map((r) => r[field]).filter(Number.isFinite),
    lo = Math.min(...values),
    hi = Math.max(...values),
    hist = Array(12).fill(0);
  values.forEach(
    (v) =>
      hist[
        hi === lo ? 0 : Math.min(11, Math.floor(((v - lo) / (hi - lo)) * 12))
      ]++,
  );
  return {
    field,
    n: values.length,
    min: values.length ? lo : null,
    max: values.length ? hi : null,
    quantiles: [0, 0.25, 0.5, 0.75, 1].map((p) => quantile(values, p)),
    histogram: hist,
  };
}
