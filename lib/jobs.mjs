import { db, schema } from "./db.mjs";
import { ingest } from "./ingest.mjs";
import { executeResearch } from "./research-job.mjs";
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
          progress: {
            percent: 100,
            stage: "Completed",
            updatedAt: new Date().toISOString(),
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
