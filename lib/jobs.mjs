import { db, schema, hash, bulkUpsert } from "./db.mjs";
import { ingest } from "./ingest.mjs";
import { runResearch, robustness, ENGINE_VERSION } from "./engine.mjs";
import { ranks } from "./dsl.mjs";
export async function executeJob(id) {
  const database = await db();
  await schema(database);
  let job = await database.collection("jobs").findOne({ _id: id });
  if (!job || ["completed", "cancelled"].includes(job.status))
    return { status: job?.status || "missing" };
  await database.collection("jobs").updateOne(
    { _id: id, status: { $nin: ["completed", "cancelled"] } },
    {
      $set: {
        status: "running",
        startedAt: new Date().toISOString(),
        leaseUntil: new Date(Date.now() + 240000).toISOString(),
      },
      $inc: { attempts: 1 },
    },
  );
  const check = async () => {
    const current = await database
      .collection("jobs")
      .findOne({ _id: id }, { projection: { status: 1 } });
    if (current?.status === "cancelled") throw new Error("Cancelled");
  };
  try {
    let summary;
    if (job.type === "probe") {
      if (job.probe === "provider-error" && !job.probeFailed) {
        await database
          .collection("jobs")
          .updateOne({ _id: id }, { $set: { probeFailed: true } });
        throw new Error("Simulated provider unavailable");
      }
      if (job.probe === "cancel" && !job.probePaused) {
        await database
          .collection("jobs")
          .updateOne({ _id: id }, { $set: { probePaused: true } });
        return { status: "pause" };
      }
      summary = { probe: job.probe, recovered: job.probe === "provider-error" };
    } else if (job.type === "import") {
      summary = await ingest(database, job.dataset, check);
      if (summary.status === "continue") {
        await database
          .collection("jobs")
          .updateOne(
            { _id: id, status: "running" },
            { $set: { progress: summary } },
          );
        return summary;
      }
    } else {
      const version = await database
        .collection("dataset_versions")
        .findOne({ _id: job.datasetVersion, status: "ready" });
      if (!version) throw new Error("Snapshot unavailable.");
      const filter = { version: version._id };
      if (job.universe?.length) filter.asset = { $in: job.universe };
      const rows = await database
        .collection("bars")
        .find(filter, { projection: { _id: 0, version: 0 } })
        .sort({ date: 1, asset: 1 })
        .limit(70001)
        .toArray();
      if (rows.length > 70000) throw new Error("Panel row limit exceeded.");
      await check();
      const result = runResearch(rows, job.code, job.config, version.meta),
        run = id;
      const runHash = hash({
        datasetVersion: version._id,
        ast: result.ast,
        config: result.config,
        engine: ENGINE_VERSION,
        universe: job.universe || [],
        code: job.code,
      });
      await database.collection("runs").updateOne(
        { _id: run },
        {
          $setOnInsert: {
            workspace: job.workspace,
            status: "staging",
            createdAt: new Date().toISOString(),
            job: id,
            runHash,
            code: job.code,
            astHash: hash(result.ast),
            edge: job.edge || null,
            edgeVersion: job.edgeVersion || null,
            datasetVersion: version._id,
            dataset: version.dataset,
            meta: version.meta,
            engine: ENGINE_VERSION,
            sourceCommit: process.env.VERCEL_GIT_COMMIT_SHA,
            deployment: process.env.VERCEL_DEPLOYMENT_ID,
            config: result.config,
            universe: job.universe || [],
          },
        },
        { upsert: true },
      );
      const points =
        result.account?.points ||
        result.panel.dates.flatMap((date, t) =>
          result.panel.assets.map((asset, a) => ({
            date,
            asset,
            score: result.variables.score[t][a],
            rank: ranks(result.variables.score[t])[a],
            reason:
              "Reference-rate diagnostic only; no executable orders or fills.",
          })),
        );
      const ti = new Map(result.panel.dates.map((d, t) => [d, t])),
        ai = new Map(result.panel.assets.map((a, i) => [a, i]));
      const existing = await database.collection("runs").findOne({ _id: run }),
        pointStart = existing.pointCheckpoint || 0,
        pointEnd = Math.min(points.length, pointStart + 4000);
      for (let i = pointStart; i < pointEnd; i += 400) {
        await check();
        await bulkUpsert(
          database.collection("run_series"),
          points.slice(i, Math.min(i + 400, pointEnd)).map((p) => {
            const t = ti.get(p.date),
              a = ai.get(p.asset);
            return {
              ...p,
              run,
              kind: "point",
              variables: Object.fromEntries(
                Object.entries(result.variables).map(([k, v]) => [k, v[t][a]]),
              ),
              forwardReturn: result.diagnostic.labels[t][a],
            };
          }),
          ["run", "kind", "date", "asset"],
        );
        await database
          .collection("runs")
          .updateOne(
            { _id: run },
            { $max: { pointCheckpoint: Math.min(i + 400, pointEnd) } },
          );
      }
      if (pointEnd < points.length) {
        const progress = {
          status: "continue",
          checkpoint: pointEnd,
          total: points.length,
        };
        await database
          .collection("jobs")
          .updateOne({ _id: id, status: "running" }, { $set: { progress } });
        return progress;
      }
      const series = result.diagnostic.series.map((r, t) => ({
        ...r,
        ...result.account?.series[t],
        run,
        kind: "timeline",
        asset: "",
        ideal: result.ideal[t],
        icByHorizon: Object.fromEntries(
          result.diagnostic.decay.map((d) => [d.horizon, d.byTime[t]]),
        ),
        pointHash: hash({
          scores: result.variables.score[t],
          points: points.filter((p) => p.date === r.date),
        }),
      }));
      await bulkUpsert(database.collection("run_series"), series, [
        "run",
        "kind",
        "date",
        "asset",
      ]);
      if (result.account)
        await bulkUpsert(
          database.collection("ledger_events"),
          result.account.ledger.map((r, i) => ({ ...r, run, event: i })),
          ["run", "event"],
        );
      await check();
      const robustnessResult = job.robustness
        ? robustness(rows, job.code, job.config, version.meta)
        : null;
      await database.collection("runs").updateOne(
        { _id: run },
        {
          $set: {
            metrics: result.metrics,
            diagnostic: result.diagnostic.summary,
            decay: result.diagnostic.decay.map(({ byTime, ...r }) => r),
            split: result.split,
            assumptions: result.assumptions,
            terminal: result.account?.terminal || null,
            robustness: robustnessResult,
            holdoutOpened: false,
            counts: {
              points: points.length,
              sessions: series.length,
              ledger: result.account?.ledger.length || 0,
            },
          },
        },
      );
      summary = {
        run,
        runHash,
        points: points.length,
        sessions: series.length,
      };
    }
    await check();
    const committed = await database
      .collection("jobs")
      .updateOne(
        { _id: id, status: "running" },
        { $set: { status: "committing", summary } },
      );
    if (!committed.modifiedCount) return { status: "cancelled" };
    if (job.type === "research")
      await database
        .collection("runs")
        .updateOne({ _id: id }, { $set: { status: "ready" } });
    await database.collection("jobs").updateOne(
      { _id: id, status: "committing" },
      {
        $set: {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary,
          error: null,
        },
      },
    );
    return { status: "completed", ...summary };
  } catch (error) {
    await database.collection("jobs").updateOne(
      { _id: id, status: { $nin: ["cancelled", "completed"] } },
      {
        $set: {
          status: "retrying",
          error:
            error.message === "Cancelled"
              ? "Cancelled"
              : "Transient worker failure; cloud dispatcher is retrying.",
          failedAt: new Date().toISOString(),
        },
      },
    );
    if (error.message === "Cancelled") return { status: "cancelled" };
    throw error;
  }
}
