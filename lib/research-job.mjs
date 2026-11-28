import { hash, bulkUpsert } from "./db.mjs";
import { runResearch, robustness, ENGINE_VERSION } from "./engine.mjs";
import { packResults, verifyChunks, RESULT_STORAGE } from "./result-store.mjs";

export async function executeResearch(database, job, check, progress) {
  const started = performance.now(),
    timings = {};
  let mark = started;
  const measure = (name) => {
    const now = performance.now();
    timings[name] = Math.round(now - mark);
    mark = now;
  };
  const existing = await database.collection("runs").findOne({ _id: job._id });
  if (existing?.status === "ready")
    return { run: job._id, runHash: existing.runHash, ...existing.counts };
  await progress("Loading data", 3);
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
  measure("loadMs");
  await check();
  await progress("Calculating edge", 15);
  const result = runResearch(rows, job.code, job.config, version.meta);
  measure("computeMs");
  await check();
  await progress(
    job.robustness ? "Testing robustness" : "Preparing results",
    35,
  );
  const stress = job.robustness
    ? robustness(rows, job.code, job.config, version.meta)
    : null;
  measure("robustnessMs");
  const { chunks, counts } = packResults(result, job._id);
  const runHash = hash({
    datasetVersion: version._id,
    ast: result.ast,
    config: result.config,
    engine: ENGINE_VERSION,
    universe: job.universe || [],
    code: job.code,
  });
  await database.collection("runs").updateOne(
    { _id: job._id },
    {
      $setOnInsert: {
        workspace: job.workspace,
        status: "staging",
        createdAt: new Date().toISOString(),
        job: job._id,
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
        ...(job.batchId
          ? { batchJob: job.batchId, batchIndex: job.batchIndex }
          : {}),
        config: result.config,
        universe: job.universe || [],
        resultStorage: RESULT_STORAGE,
      },
    },
    { upsert: true },
  );
  await progress("Saving results", 55, {
    completed: existing?.chunkCheckpoint || 0,
    total: chunks.length,
  });
  measure("prepareMs");
  const start = existing?.chunkCheckpoint || 0;
  for (let i = start; i < chunks.length; i += 24) {
    await check();
    const end = Math.min(i + 24, chunks.length);
    await bulkUpsert(
      database.collection("result_chunks"),
      chunks.slice(i, end),
      ["run", "kind", "asset", "bucket"],
    );
    await database
      .collection("runs")
      .updateOne({ _id: job._id }, { $max: { chunkCheckpoint: end } });
    await progress(
      "Saving results",
      55 + Math.floor((40 * end) / chunks.length),
      { completed: end, total: chunks.length },
    );
    if (performance.now() - started > 180000 && end < chunks.length)
      return { status: "continue", checkpoint: end, total: chunks.length };
  }
  measure("writeMs");
  await check();
  await progress("Verifying results", 97, {
    completed: chunks.length,
    total: chunks.length,
  });
  const stored = await database
    .collection("result_chunks")
    .find({ run: job._id }, { projection: { _id: 0 } })
    .limit(chunks.length + 1)
    .toArray();
  verifyChunks(chunks, stored);
  measure("verifyMs");
  timings.workerMs = Math.round(performance.now() - started);
  const pipeline = {
    version: RESULT_STORAGE,
    documents: chunks.length,
    logicalRows: counts.points + counts.sessions + counts.ledger,
    timings,
  };
  await database.collection("runs").updateOne(
    { _id: job._id },
    {
      $set: {
        metrics: result.metrics,
        diagnostic: result.diagnostic.summary,
        decay: result.diagnostic.decay.map(({ byTime, ...r }) => r),
        split: result.split,
        assumptions: result.assumptions,
        terminal: result.account?.terminal || null,
        robustness: stress,
        counts,
        pipeline,
      },
    },
  );
  return {
    run: job._id,
    runHash,
    points: counts.points,
    sessions: counts.sessions,
    pipeline,
  };
}
