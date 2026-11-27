import test from "node:test";
import assert from "node:assert/strict";
import { parse, evaluate, makePanel, ranks } from "../lib/dsl.mjs";
import { spearman, forwardLabels, asOfJoin, splits } from "../lib/metrics.mjs";
import { simulate, runResearch, robustness } from "../lib/engine.mjs";
import { synthetic, parseUCI, corporateActionFixture } from "../lib/ingest.mjs";
import { CATALOG } from "../lib/catalog.mjs";
import { aggregateBars } from "../lib/window.mjs";
const near = (a, b, eps = 1e-10) =>
  assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("18 delayed orders net outstanding quantities and per-asset PnL reconciles NAV", () => {
  const rows = fixture().map((r) => ({
      ...r,
      open: 100,
      close: 100,
      high: 100,
      low: 100,
    })),
    p = makePanel(rows),
    r = simulate(
      p,
      p.dates.map(() => [4, 3, 2, 1]),
      {
        capital: 10000,
        topK: 1,
        maxWeight: 1,
        feeBps: 0,
        slippageBps: 0,
        delay: 2,
      },
    );
  assert.equal(
    r.ledger.filter((e) => e.type === "fill" && e.filled > 0).length,
    1,
  );
  for (const s of r.series)
    near(
      r.points
        .filter((p) => p.date === s.date)
        .reduce((n, p) => n + p.pnl, 10000),
      s.nav,
    );
});
test("19 participation limit uses decision volume, not future bar volume", () => {
  const rows = fixture().map((r) => ({ ...r, volume: 1000 })),
    a = makePanel(rows),
    b = makePanel(
      rows.map((r) => (r.date === "2020-01-02" ? { ...r, volume: 1e9 } : r)),
    ),
    score = a.dates.map(() => [4, 3, 2, 1]);
  const x = simulate(a, score, { topK: 1, maxWeight: 1 }),
    y = simulate(b, score, { topK: 1, maxWeight: 1 });
  assert.deepEqual(
    x.ledger.filter((e) => e.date === "2020-01-02"),
    y.ledger.filter((e) => e.date === "2020-01-02"),
  );
});
function fixture() {
  return Array.from({ length: 12 }, (_, t) =>
    Array.from({ length: 4 }, (_, a) => ({
      asset: "A" + a,
      date: new Date(Date.UTC(2020, 0, 1 + t)).toISOString().slice(0, 10),
      open: 100 + t * (4 - a),
      close: 101 + t * (4 - a),
      high: 103 + t * (4 - a),
      low: 99 + t * (4 - a),
      volume: 100000,
      availableAt: new Date(Date.UTC(2020, 0, 1 + t, 21)).toISOString(),
      openAt: new Date(Date.UTC(2020, 0, 1 + t, 14)).toISOString(),
      group: a % 2 ? "b" : "a",
    })),
  ).flat();
}
test("01 exact cross-sectional Spearman fixture = 0.8", () =>
  near(spearman([4, 3, 2, 1], [0.02, -0.01, 0.01, -0.02]), 0.8));
test("02 centered rank ideal weights yield gross 1.25%", () => {
  const weights = [0.375, 0.125, -0.125, -0.375],
    returns = [0.02, -0.01, 0.01, -0.02];
  near(
    weights.reduce((s, w, i) => s + w * returns[i], 0),
    0.0125,
  );
});
test("03 tie midranks, constant IC, missing inputs", () => {
  assert.deepEqual(ranks([1, 2, 2, 4]), [0, 0.5, 0.5, 1]);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
  near(spearman([4, 3, null, 1], [0.02, -0.01, 0.01, -0.02]), 1);
});
test("04 reject future fields, negative lag, imports and property access with source location", () => {
  for (const code of [
    "score = next_weeks_open",
    "score = percent_change_next_weeks_price",
    "score = days_to_next_dividend",
    "score = lag(close, -1)",
    "score = lag(close, 253)",
    "import os",
    "score = close.constructor",
    "score = process(1)",
  ])
    assert.throws(
      () => parse(code),
      (e) => e.name === "DslError" && e.line >= 1 && e.column >= 1,
    );
});
test("05 arithmetic, rolling full windows, group ranks, where and zero denominator", () => {
  const p = makePanel(fixture()),
    v = evaluate(
      parse(
        "mom = returns(close, 2)\nrisk = ts_std(close, 3)\ng = group_rank(mom)\ns = where(close > 0, clip(g, 0.1, 0.9), 0)\nscore = s / 0",
      ),
      p,
    );
  assert.equal(v.mom[1][0], null);
  near(v.mom[2][0], 109 / 101 - 1);
  near(v.risk[2][0], 4);
  assert.equal(v.score[5][0], null);
});
test("06 ranks are cross-sectional, rolling respects missing calendar cells", () => {
  const rows = fixture().filter(
      (r) => !(r.asset === "A0" && r.date === "2020-01-04"),
    ),
    p = makePanel(rows),
    v = evaluate(parse("m = ts_mean(close, 2)\nscore = rank(m)"), p);
  assert.equal(v.m[4][0], null);
  assert.equal(v.score[3][0], null);
  assert.equal(v.score[6][0], 1);
});
test("07 OHLC labels are open(t+1+h)/open(t+1)-1; ECB has no fake open", () => {
  const p = makePanel(fixture());
  near(forwardLabels(p, 2)[0][0], 112 / 104 - 1);
  near(forwardLabels(p, 2, "reference")[0][0], 109 / 101 - 1);
  assert.equal(forwardLabels(p, 2).at(-1)[0], null);
  assert.throws(() => parse("score = open", CATALOG.ecb.fields));
});
test("08 future mutation changes evaluator labels but not causal scores/orders/NAV through cutoff", () => {
  const rows = fixture(),
    future = rows.map((r) =>
      r.date > "2020-01-07"
        ? { ...r, open: r.open * 3, close: r.close * 4, high: r.high * 5 }
        : r,
    ),
    code = "score = rank(returns(close, 2))",
    a = runResearch(rows, code, {}, CATALOG.uci),
    b = runResearch(future, code, {}, CATALOG.uci);
  assert.deepEqual(
    a.variables.score.slice(0, 7),
    b.variables.score.slice(0, 7),
  );
  assert.deepEqual(a.account.series.slice(0, 7), b.account.series.slice(0, 7));
  assert.deepEqual(
    a.account.ledger.filter((r) => r.date <= "2020-01-07"),
    b.account.ledger.filter((r) => r.date <= "2020-01-07"),
  );
  assert.notDeepEqual(a.diagnostic.labels[5], b.diagnostic.labels[5]);
});
test("09 round trip 100 units at 100, 10 bps each way → fee 20, PnL -20", () => {
  const rows = [0, 1, 2].map((t) => ({
      asset: "A",
      date: "2020-01-0" + (t + 1),
      open: 100,
      close: 100,
      volume: 1e6,
      availableAt: "2020-01-0" + (t + 1) + "T21:00:00Z",
      openAt: "2020-01-0" + (t + 1) + "T14:00:00Z",
    })),
    a = simulate(makePanel(rows), [[1], [-1], [-1]], {
      capital: 10010,
      feeBps: 10,
      slippageBps: 0,
      topK: 1,
      maxWeight: 1,
      entry: 0,
      exit: 0,
    });
  assert.equal(a.ledger[0].filled, 100);
  near(a.series.at(-1).costTotal, 20);
  near(a.series.at(-1).nav - 10010, -20);
});
test("10 no fills on missing bars or zero volume, no future-open sizing", () => {
  const rows = fixture().map((r) =>
      r.date === "2020-01-02"
        ? {
            ...r,
            open: 1000,
            high: 1100,
            volume: r.asset === "A0" ? 0 : r.volume,
          }
        : r,
    ),
    p = makePanel(rows),
    score = p.dates.map(() => [4, 3, 2, 1]),
    a = simulate(p, score, {
      capital: 10000,
      feeBps: 0,
      slippageBps: 0,
      topK: 1,
      maxWeight: 1,
    });
  const rejected = a.ledger.find(
    (r) => r.asset === "A0" && r.date === "2020-01-02",
  );
  assert.equal(rejected.type, "rejected");
  assert.equal(rejected.targetQuantity, 99);
});
test("11 same snapshot/code/config yields identical results; costs and delay alter account", () => {
  const rows = synthetic(44, 100, 8),
    code = "score = rank(returns(close, 4))",
    c = { topK: 2, maxWeight: 0.5 },
    a = runResearch(rows, code, c, CATALOG.synthetic),
    b = runResearch(rows, code, c, CATALOG.synthetic),
    cost = runResearch(rows, code, { ...c, feeBps: 100 }, CATALOG.synthetic),
    lag = runResearch(rows, code, { ...c, delay: 1 }, CATALOG.synthetic);
  assert.deepEqual(a, b);
  assert.notEqual(a.metrics.cumulativeReturn, cost.metrics.cumulativeReturn);
  assert.notDeepEqual(a.account.ledger, lag.account.ledger);
});
test("12 purged folds never train on labels crossing cutoff", () => {
  const p = makePanel(synthetic(2, 120, 4)),
    s = splits(p.dates, 4);
  for (const f of s.folds) assert.ok(f.trainEnd + 1 + 4 < f.testStart);
});
test("13 every robustness trial and weak candidate retained", () => {
  const rows = synthetic(22, 90, 8),
    r = robustness(
      rows,
      "score = rank(returns(close, 3))",
      { topK: 4 },
      CATALOG.synthetic,
    );
  assert.equal(r.trials.length, 5);
  assert.equal(r.folds.length, 3);
  assert.equal(r.folds[0].trials.length, 2);
});
test("14 backward as-of join respects availability, age and gaps", () => {
  const p = [
      { availableAt: "2020-01-02T12:00:00Z" },
      { availableAt: "2020-01-20T12:00:00Z" },
    ],
    s = [
      { date: "2020-01-01", availableAt: "2020-01-02T00:00:00Z", close: 2 },
      { date: "2020-01-02", availableAt: "2020-01-03T00:00:00Z", close: 9 },
    ],
    j = asOfJoin(p, s, 7);
  assert.equal(j[0].context, 2);
  assert.equal(j[0].ageDays, 0.5);
  assert.equal(j[1].context, null);
});
test("15 downsample preserves first open, extrema, last close and total volume", () => {
  const rows = fixture().filter((r) => r.asset === "A0"),
    a = aggregateBars(rows, 1);
  assert.equal(a[0].open, rows[0].open);
  assert.equal(a[0].close, rows.at(-1).close);
  assert.equal(a[0].high, Math.max(...rows.map((r) => r.high)));
  assert.equal(a[0].volume, 1200000);
});
test("16 UCI ingestion feature allowlist removes embedded future fields", () => {
  const text =
    "stock,date,open,high,low,close,volume,next_weeks_open,days_to_next_dividend\nAA,1/7/2011,$10,$12,$9,$11,100,999,8";
  const r = parseUCI(text)[0];
  assert.equal(r.close, 11);
  assert.equal(r.date, "2011-01-07");
  assert.equal("next_weeks_open" in r, false);
  assert.equal("days_to_next_dividend" in r, false);
});
test("17 synthetic seed repeatable; separate split fixture preserves NAV", () => {
  assert.deepEqual(synthetic(7, 30, 4), synthetic(7, 30, 4));
  const f = corporateActionFixture();
  near(f.rawBefore * f.sharesBefore, f.rawAfter * f.sharesAfter);
});
