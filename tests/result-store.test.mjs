import test from "node:test";
import assert from "node:assert/strict";
import { synthetic } from "../lib/ingest.mjs";
import { runResearch } from "../lib/engine.mjs";
import { CATALOG } from "../lib/catalog.mjs";
import { hash } from "../lib/db.mjs";
import {
  packResults,
  verifyChunks,
  selectChunkRows,
  CHUNK_ROWS,
} from "../lib/result-store.mjs";
import { jobProgress } from "../lib/progress.mjs";

test("chunk storage preserves every score, variable, fill and legacy per-date hash", () => {
  const result = runResearch(
    synthetic(332, 270, 6),
    "m = returns(close, 3)\nscore = rank(m)",
    { delay: 2, topK: 3 },
    CATALOG.synthetic,
  );
  const packed = packResults(result, "fixture");
  assert.ok(packed.chunks.every((c) => c.count <= CHUNK_ROWS));
  assert.ok(packed.chunks.length < packed.counts.points / 20);
  verifyChunks(packed.chunks, structuredClone(packed.chunks));
  const dates = [
    result.panel.dates[0],
    result.panel.dates[127],
    result.panel.dates[128],
    result.panel.dates.at(-1),
  ];
  for (const date of dates) {
    const t = result.panel.dates.indexOf(date);
    const ps = selectChunkRows(
      packed.chunks.filter((c) => c.kind === "point"),
      { from: date, to: date },
    );
    assert.equal(ps.length, 6);
    for (const p of ps) {
      const a = result.panel.assets.indexOf(p.asset);
      assert.equal(p.score, result.variables.score[t][a]);
      assert.deepEqual(p.variables, {
        m: result.variables.m[t][a],
        score: result.variables.score[t][a],
      });
      assert.equal(p.forwardReturn, result.diagnostic.labels[t][a]);
    }
    const day = selectChunkRows(
      packed.chunks.filter((c) => c.kind === "timeline"),
      { from: date, to: date },
    )[0];
    assert.equal(
      day.pointHash,
      hash({
        scores: result.variables.score[t],
        points: result.account.points.filter((p) => p.date === date),
      }),
    );
    assert.equal(day.nav, result.account.series[t].nav);
  }
  const ledger = selectChunkRows(
    packed.chunks.filter((c) => c.kind === "ledger"),
    { sort: "event" },
  );
  assert.deepEqual(
    ledger.map(({ _id, run, event, ...r }) => r),
    result.account.ledger,
  );
  const broken = structuredClone(packed.chunks);
  broken[0].rows[0].score = 123;
  assert.throws(() => verifyChunks(packed.chunks, broken), /checksum/);
  assert.throws(
    () => verifyChunks(packed.chunks, packed.chunks.slice(1)),
    /count/,
  );
  assert.throws(
    () =>
      verifyChunks(packed.chunks, [
        ...packed.chunks.slice(1),
        packed.chunks[1],
      ]),
    /checksum/,
  );
});

test("chunk windows include delayed decisions but respect asset, bounds and limit", () => {
  const chunks = [
    {
      rows: [
        {
          asset: "A",
          date: "2014-01-08",
          decisionDate: "2014-01-02",
          event: 2,
        },
        {
          asset: "A",
          date: "2014-01-02",
          decisionDate: "2014-01-01",
          event: 1,
        },
        { asset: "B", date: "2014-01-02", event: 0 },
        {
          asset: "A",
          date: "2014-01-03",
          decisionDate: "2014-01-01",
          event: 3,
        },
      ],
    },
  ];
  const options = {
    asset: "A",
    from: "2014-01-02",
    to: "2014-01-02",
    decisionDate: "2014-01-02",
    sort: "event",
  };
  assert.deepEqual(
    selectChunkRows(chunks, options).map((r) => r.event),
    [1, 2],
  );
  assert.equal(selectChunkRows(chunks, { ...options, limit: 1 }).length, 1);
});

test("reference runs keep scores without fabricating account results", () => {
  const result = runResearch(
    synthetic(334, 40, 6),
    "score = rank(returns(close, 3))",
    {},
    { ...CATALOG.ecb, kind: "reference" },
  );
  const packed = packResults(result, "reference");
  assert.equal(packed.counts.ledger, 0);
  assert.ok(!packed.chunks.some((c) => c.kind === "ledger"));
  const day = packed.chunks.find((c) => c.kind === "timeline").rows[10];
  assert.equal(day.nav, undefined);
  assert.ok(
    packed.chunks
      .filter((c) => c.kind === "point")
      .some((c) => c.rows.some((r) => Number.isFinite(r.score))),
  );
});

test("progress reserves 100 for committed jobs and freezes elapsed time on completion", () => {
  const job = {
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    progress: { percent: 100, stage: "Verifying results" },
  };
  assert.equal(jobProgress(job).percent, 99);
  assert.equal(jobProgress({ ...job, status: "cancelled" }).stage, "Cancelled");
  assert.equal(jobProgress({ ...job, status: "queued" }).percent, 0);
  const done = jobProgress({
    ...job,
    status: "completed",
    completedAt: "2026-01-01T00:00:12Z",
  });
  assert.equal(done.percent, 100);
  assert.equal(done.elapsedSeconds, 12);
  assert.equal(
    jobProgress({
      status: "running",
      progress: { checkpoint: 4000, total: 8000 },
    }).percent,
    75,
  );
  assert.equal(jobProgress({ status: "running" }).percent, null);
});
