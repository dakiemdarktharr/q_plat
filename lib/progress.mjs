export function jobProgress(job, now = Date.now()) {
  const p = job.progress || {};
  const terminal = ["completed", "failed", "cancelled"].includes(job.status);
  const end = terminal
    ? Date.parse(job.completedAt || job.cancelledAt || job.failedAt)
    : now;
  const start = Date.parse(job.createdAt);
  let percent = Number.isFinite(p.percent) ? p.percent : null;
  if (
    percent === null &&
    job.type !== "import" &&
    Number.isFinite(p.checkpoint) &&
    p.total > 0
  )
    percent = 55 + Math.floor(40 * Math.min(1, p.checkpoint / p.total));
  if (job.status === "queued") percent = 0;
  if (job.status === "completed") percent = 100;
  else if (percent !== null)
    percent = Math.max(0, Math.min(99, Math.floor(percent)));
  const names = {
    queued: "Queued",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    retrying: "Retrying",
    committing: "Finishing",
  };
  return {
    ...p,
    percent,
    stage:
      names[job.status] ||
      p.stage ||
      (job.type === "import" ? "Importing data" : "Running"),
    elapsedSeconds:
      Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, Math.floor((end - start) / 1000))
        : null,
  };
}
