import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schema, hash, bulkUpsert } from "./db.mjs";
import { synthetic, canonicalRows } from "./ingest.mjs";
import { runResearch } from "./engine.mjs";
import { CATALOG } from "./catalog.mjs";
import { spearman } from "./metrics.mjs";
export async function cloudChecks() {
  if (!process.env.VERCEL_DEPLOYMENT_ID)
    throw new Error("Cloud verification only.");
  const d = await db("q_plat_test");
  await schema(d);
  await d.command({ ping: 1 });
  const checks = [],
    prefix = randomUUID(),
    rows = synthetic(7788, 80, 8),
    version = prefix + "-v1",
    code = "score = rank(returns(close, 3))";
  const record = (name, scalars = {}) =>
    checks.push({ name, status: "pass", ...scalars });
  await d.collection("dataset_versions").insertOne({
    _id: version,
    status: "staging",
    dataset: "test",
    schemaVersion: 1,
  });
  await bulkUpsert(
    d.collection("bars"),
    rows.slice(0, 100).map((r) => ({ ...r, version })),
    ["version", "asset", "date"],
  );
  assert.equal(
    await d
      .collection("dataset_versions")
      .countDocuments({ _id: version, status: "ready" }),
    0,
  );
  record("staging snapshot cannot be selected");
  await bulkUpsert(
    d.collection("bars"),
    rows.map((r) => ({ ...r, version })),
    ["version", "asset", "date"],
  );
  const firstCount = await d.collection("bars").countDocuments({ version });
  await bulkUpsert(
    d.collection("bars"),
    rows.map((r) => ({ ...r, version })),
    ["version", "asset", "date"],
  );
  assert.equal(
    await d.collection("bars").countDocuments({ version }),
    firstCount,
  );
  const read = await d
    .collection("bars")
    .find({ version }, { projection: { _id: 0, version: 0 } })
    .toArray();
  assert.equal(hash(canonicalRows(read)), hash(canonicalRows(rows)));
  record("idempotent retry/readback checksum", {
    count: firstCount,
    checksum: hash(canonicalRows(read)),
  });
  await d
    .collection("dataset_versions")
    .updateOne({ _id: version }, { $set: { status: "ready" } });
  const a = runResearch(read, code, { topK: 3 }, CATALOG.synthetic),
    cutoff = a.panel.dates[45],
    future = prefix + "-v2";
  await bulkUpsert(
    d.collection("bars"),
    read.map((r) => ({
      ...r,
      version: future,
      ...(r.date > cutoff
        ? {
            open: r.open * (1 + Number(r.date.slice(-2)) * 0.03),
            close: r.close * 2,
            high: r.high * 3,
          }
        : {}),
    })),
    ["version", "asset", "date"],
  );
  const changed = await d
      .collection("bars")
      .find({ version: future }, { projection: { _id: 0, version: 0 } })
      .toArray(),
    b = runResearch(changed, code, { topK: 3 }, CATALOG.synthetic);
  assert.deepEqual(
    a.variables.score.slice(0, 46),
    b.variables.score.slice(0, 46),
  );
  assert.deepEqual(
    a.account.series.slice(0, 46),
    b.account.series.slice(0, 46),
  );
  assert.deepEqual(
    a.account.ledger.filter((e) => e.date <= cutoff),
    b.account.ledger.filter((e) => e.date <= cutoff),
  );
  record("Atlas future mutation preserves pre-cutoff scores/orders/NAV");
  await d
    .collection("dataset_versions")
    .insertOne({
      _id: future,
      status: "ready",
      dataset: "test",
      schemaVersion: 1,
    });
  assert.notDeepEqual(a.diagnostic.labels, b.diagnostic.labels);
  record("Future evaluator labels respond to changed future observations");
  const again = runResearch(
    await d
      .collection("bars")
      .find({ version }, { projection: { _id: 0, version: 0 } })
      .toArray(),
    code,
    { topK: 3 },
    CATALOG.synthetic,
  );
  assert.deepEqual(a.metrics, again.metrics);
  record("old snapshot reproducible after new snapshot exists", {
    resultHash: hash(a.metrics),
  });
  assert.ok(
    Math.abs(spearman([4, 3, 2, 1], [0.02, -0.01, 0.01, -0.02]) - 0.8) < 1e-12,
  );
  record("Spearman reference", { value: 0.8 });
  const prod = await db(),
    versions = await prod
      .collection("dataset_versions")
      .find({ status: "ready" })
      .toArray();
  for (const v of versions) {
    const count = await prod
        .collection("bars")
        .countDocuments({ version: v._id }),
      market = await prod
        .collection("bars")
        .find({ version: v._id }, { projection: { _id: 0, version: 0 } })
        .toArray();
    assert.equal(count, v.count);
    assert.equal(hash(canonicalRows(market)), v.checksum);
    record("production snapshot independent readback " + v.dataset, {
      count,
      checksum: v.checksum,
    });
    if (v.dataset === "uci") {
      const custom =
        "move = returns(close, 3)\nrange = (high - low) / close\nscore = rank(move) - 0.37 * rank(range)";
      const r = runResearch(market, custom, { topK: 5 }, v.meta),
        t = 10;
      const moves = r.panel.matrix[t].map(
          (b, a) => b.close / r.panel.matrix[t - 3][a].close - 1,
        ),
        ranges = r.panel.matrix[t].map((b) => (b.high - b.low) / b.close);
      const referenceRank = (arr, value) => {
        const less = arr.filter((x) => x < value).length,
          equal = arr.filter((x) => x === value).length;
        return (less + (equal - 1) / 2) / (arr.length - 1);
      };
      for (let a = 0; a < moves.length; a++)
        assert.ok(
          Math.abs(
            r.variables.score[t][a] -
              (referenceRank(moves, moves[a]) -
                0.37 * referenceRank(ranges, ranges[a])),
          ) < 1e-12,
        );
      record(
        "Real UCI custom edge preview vs independent cross-sectional arithmetic",
        { assets: moves.length, tolerance: 1e-12 },
      );
      let cash = r.config.capital,
        costs = 0;
      const positions = new Map(),
        marks = new Map();
      for (const day of r.account.series) {
        for (const f of r.account.ledger.filter(
          (x) => x.date === day.date && x.type === "fill",
        )) {
          assert.ok(
            Math.abs(
              f.price -
                f.referencePrice *
                  (1 + (Math.sign(f.filled) * r.config.slippageBps) / 10000),
            ) < 1e-10,
          );
          const fee = (Math.abs(f.filled * f.price) * r.config.feeBps) / 10000;
          assert.ok(Math.abs(f.fee - fee) < 1e-10);
          cash -= f.filled * f.price + fee;
          costs += fee + Math.abs(f.filled * (f.price - f.referencePrice));
          positions.set(f.asset, (positions.get(f.asset) || 0) + f.filled);
        }
        market
          .filter((b) => b.date === day.date)
          .forEach((b) => marks.set(b.asset, b.close));
        const nav =
          cash + [...positions].reduce((s, [a, q]) => s + q * marks.get(a), 0);
        assert.ok(Math.abs(nav - day.nav) < 1e-8);
        assert.ok(Math.abs(cash - day.cash) < 1e-8);
      }
      assert.ok(Math.abs(costs - r.metrics.costs) < 1e-8);
      record("Real UCI independent ledger/cash/mark/NAV/fees reconciliation", {
        sessions: r.account.series.length,
        ledger: r.account.ledger.length,
        tolerance: 1e-8,
      });
    }
  }
  // Test namespace contains generated fixtures only, explicitly disposable. Never delete production data.
  await d
    .collection("bars")
    .deleteMany({ version: { $in: [version, future] } });
  await d
    .collection("dataset_versions")
    .deleteMany({ _id: { $in: [version, future] } });
  const evidence = {
    _id: prefix,
    createdAt: new Date().toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA,
    deployment: process.env.VERCEL_DEPLOYMENT_ID,
    checks,
  };
  await d.collection("verification").insertOne(evidence);
  return evidence;
}
