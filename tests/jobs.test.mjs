import assert from "node:assert/strict";
import test from "node:test";
import { continuationProgressPipeline } from "../lib/jobs.mjs";

test("continuation progress keeps the stored completion percent monotonic", () => {
  const summary = {
    status: "continue",
    datasets: 70,
    completed: 66,
    percent: 72,
    stage: "Qualified PST",
  };
  const update = continuationProgressPipeline(summary)[0].$set.progress;
  const [next, current] = update.$mergeObjects;

  assert.deepEqual(next, summary);
  assert.deepEqual(current.percent, {
    $max: [{ $ifNull: ["$progress.percent", 0] }, 72],
  });
  assert.match(current.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});
