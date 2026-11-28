import { db, schema } from "./db.mjs";
import { ingest } from "./ingest.mjs";
import { executeResearch } from "./research-job.mjs";
async function executeBatch(database, job, check) {
  const total = job.datasets.length,
    panels = job.datasets.map((panel) => ({
      ...panel,
      status: "queued",
      percent: 0,
      stage: "Queued",
    }));
  const saveProgress = async (index, stage, percent, counts = {}) => {
    const panel = panels[index];
    panel.status = percent === 100 ? "completed" : "running";
    panel.percent = Math.max(
      panel.percent || 0,
      Math.min(99, Math.floor(percent)),
    );
    panel.stage = stage;
    if (counts.completed !== undefined)
      panel.completedChunks = counts.completed;
    if (counts.total !== undefined) panel.totalChunks = counts.total;
    await database.collection("jobs").updateOne(
      { _id: job._id, status: "running" },
      {
        $max: {
          "progress.percent": Math.min(
            99,
            Math.floor(((index + percent / 100) * 100) / total),
          ),
        },
        $set: {
          "progress.stage": `${panel.name}: ${stage}`,
          "progress.updatedAt": new Date().toISOString(),
          "progress.datasets": panels,
        },
      },
    );
  };
  for (let index = 0; index < total; index++) {
    await check();
    const panel = panels[index];
    const existing = await database.collection("runs").findOne({
      _id: panel.runId,
      status: "ready",
      workspace: job.workspace,
    });
    if (existing) {
      panel.status = "completed";
      panel.percent = 100;
      panel.stage = "Completed";
      panel.runHash = existing.runHash;
      panel.pipeline = existing.pipeline;
      await saveProgress(index, "Completed", 100);
      await database
        .collection("jobs")
        .updateOne(
          { _id: job._id, status: "running" },
          { $set: { batchCheckpoint: index + 1 } },
        );
      continue;
    }
    await saveProgress(index, "Loading data", 0);
    const summary = await executeResearch(
      database,
      {
        ...job,
        _id: panel.runId,
        datasetVersion: panel.datasetVersion,
        batchId: job._id,
        batchIndex: index,
      },
      check,
      (stage, percent, counts) => saveProgress(index, stage, percent, counts),
    );
    if (summary.status === "continue") return summary;
    await check();
    await database
      .collection("runs")
      .updateOne(
        { _id: panel.runId, workspace: job.workspace },
        { $set: { status: "ready" } },
      );
    panel.status = "completed";
    panel.percent = 100;
    panel.stage = "Completed";
    panel.runHash = summary.runHash;
    panel.pipeline = summary.pipeline;
    await database.collection("jobs").updateOne(
      { _id: job._id, status: "running" },
      {
        $set: {
          batchCheckpoint: index + 1,
          "progress.datasets": panels,
        },
      },
    );
  }
  return {
    batch: true,
    panels: panels.map(({ status, percent, stage, ...panel }) => ({
      ...panel,
      status,
      percent,
      stage,
    })),
  };
}
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
        startedAt: job.startedAt || new Date().toISOString(),
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
  const progress = async (stage, percent, counts = {}) => {
    await database.collection("jobs").updateOne(
      { _id: id, status: "running" },
      {
        $max: { "progress.percent": Math.min(99, Math.floor(percent)) },
        $set: {
          "progress.stage": stage,
          "progress.updatedAt": new Date().toISOString(),
          "progress.completed": counts.completed ?? null,
          "progress.total": counts.total ?? null,
        },
      },
    );
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
    } else if (job.batch) {
      summary = await executeBatch(database, job, check);
      if (summary.status === "continue") return summary;
    } else {
      summary = await executeResearch(database, job, check, progress);
      if (summary.status === "continue") return summary;
    }
    await check();
    const committed = await database
      .collection("jobs")
      .updateOne(
        { _id: id, status: "running" },
        { $set: { status: "committing", summary } },
      );
    if (!committed.modifiedCount) return { status: "cancelled" };
    if (job.type === "research" && !job.batch)
      await database
        .collection("runs")
        .updateOne({ _id: id }, { $set: { status: "ready" } });
    if (job.batch)
      await database
        .collection("runs")
        .updateMany(
          { batchJob: id, workspace: job.workspace, status: "staging" },
          { $set: { status: "ready" } },
        );
    await database.collection("jobs").updateOne(
      { _id: id, status: "committing" },
      {
        $set: {
          status: "completed",
          completedAt: new Date().toISOString(),
          summary,
          error: null,
          progress: {
            percent: 100,
            stage: "Completed",
            updatedAt: new Date().toISOString(),
            ...(job.batch
              ? {
                  datasets: summary.panels.map((panel) => ({
                    ...panel,
                    percent: 100,
                    status: "completed",
                    stage: "Completed",
                  })),
                }
              : {}),
          },
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
              : job.type === "import"
                ? String(error.message).slice(0, 180)
                : "Transient worker failure; cloud dispatcher is retrying.",
          failedAt: new Date().toISOString(),
        },
      },
    );
    if (error.message === "Cancelled") return { status: "cancelled" };
    throw error;
  }
}
