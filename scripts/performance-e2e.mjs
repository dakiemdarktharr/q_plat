// Production measurements and interaction checks. All payloads stay in RAM.
import { chromium } from "@playwright/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { validateConfig } from "../lib/engine.mjs";

const base = process.env.BASE_URL || "https://q-plat.vercel.app";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: "block",
});
const page = await context.newPage(),
  errors = [],
  measurements = [];
page.on("pageerror", (e) => errors.push(e.message));
let client, credential;
const pass = (name, evidence = {}) =>
  console.log("PASS", name, JSON.stringify(evidence));
const api = async (op, data, query = {}) => {
  const response = await context.request.fetch(
    base + "/api?" + new URLSearchParams({ op, ...query }),
    {
      method: data ? "POST" : "GET",
      ...(data ? { data } : {}),
      timeout: 60000,
    },
  );
  const value = await response.json();
  assert.ok(response.ok(), `${op}: ${response.status()} ${value.error || ""}`);
  return value;
};
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.ready === "true",
    null,
    { timeout: 60000 },
  );
const waitJob = async (id) => {
  let previous = 0;
  const stages = new Set(),
    percentages = new Set();
  for (let n = 0; n < 180; n++) {
    const job = (await api("jobs", null, { id })).jobs[0];
    assert.ok(!["failed", "cancelled"].includes(job.status), job.error);
    assert.ok(job.progress.percent >= previous);
    previous = job.progress.percent;
    stages.add(job.progress.stage);
    percentages.add(previous);
    if (job.status === "completed") {
      assert.equal(previous, 100);
      assert.ok(job.progress.elapsedSeconds >= 0);
      return { job, stages: [...stages], percentages: [...percentages] };
    }
    assert.ok(previous < 100);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Job timeout " + id);
};
const waitBatch = async (id) => {
  let previous = 0;
  for (let iteration = 0; iteration < 900; iteration++) {
    const job = (await api("jobs", null, { id })).jobs[0];
    assert.ok(job);
    assert.ok(!["failed", "cancelled"].includes(job.status), job.error);
    assert.ok(job.progress.percent >= previous);
    previous = job.progress.percent;
    if (job.status === "completed") {
      assert.equal(previous, 100);
      assert.equal(job.summary.panels.length, 6);
      assert.ok(
        job.summary.panels.every((panel) => panel.status === "completed"),
      );
      assert.equal(
        new Set(job.summary.panels.map((panel) => panel.dataset)).size,
        6,
      );
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Batch timeout " + id);
};
const accepted = (op) =>
  page.waitForResponse(
    (r) => r.url().includes("op=" + op) && r.request().method() === "POST",
  );
try {
  await api("workspace", {
    name: "pipeline_qa_" + Date.now(),
    password: randomBytes(24).toString("base64url"),
    create: true,
  });
  const version = (await api("catalog")).versions.find(
    (v) => v.dataset === "wiki_technology",
  );
  const code =
    "move = returns(close, 20)\nrisk = ts_std(returns(close, 1), 20)\nscore = rank(move) - 0.25 * rank(risk)";
  const config = validateConfig({ feeBps: 10, slippageBps: 5, rebalance: 5 });
  const body = { datasetVersion: version._id, code, config, robustness: true };
  await page.goto(base);
  await ready();
  await page.locator("#dataset").selectOption(version._id);
  await page.locator("#code").fill(code);
  await page.locator("#testSettings > summary").click();
  await page.getByText("Execution, risk & universe", { exact: true }).click();
  for (const [key, value] of Object.entries(config))
    await page.locator("#" + key).fill(String(value));
  await page.locator("#robustness").uncheck();
  const response = accepted("runBatch");
  await page.locator("#run").click();
  const id = (await (await response).json()).job;
  assert.ok(id);
  await page.locator("#batchBoard").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelectorAll("#batchGrid .batch-panel").length === 6,
  );
  assert.ok(await page.locator("#run").isDisabled());
  assert.ok(
    Number(await page.locator("#batchMeter").getAttribute("value")) < 100,
  );
  await page.reload();
  await ready();
  const active = (await api("jobs", null, { id })).jobs[0];
  if (["queued", "running", "retrying", "committing"].includes(active.status)) {
    await page
      .locator("#batchBoard")
      .waitFor({ state: "visible", timeout: 30000 });
  } else {
    await page.goto(base + "/#history");
    await ready();
    await page.locator(`[data-watch-batch="${id}"]`).click();
    await page
      .locator("#batchBoard")
      .waitFor({ state: "visible", timeout: 30000 });
  }
  const completedBatch = await waitBatch(id);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '#batchGrid .batch-panel[data-status="completed"]',
      ).length === 6 &&
      document.querySelectorAll("#batchGrid .batch-panel svg").length === 6 &&
      document.querySelector("#batchMeter").value === 100,
    {},
    { timeout: 120000 },
  );
  pass(
    "six dataset monitor resumes after reload with per-dataset progress and charts",
    {
      batch: id,
      panels: completedBatch.summary.panels.map(({ dataset, runId }) => ({
        dataset,
        runId,
      })),
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator("#batchMeter").isVisible());
  assert.equal(
    await page
      .locator("#batchGrid")
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    2,
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass("completed six-panel monitor fits desktop and mobile");
  let reference;
  for (let iteration = 0; iteration < 3; iteration++) {
    const run = (await api("run", body)).job;
    const measured = await waitJob(run);
    const report = await api("report", null, { run });
    assert.equal(
      report.runHash,
      "67c6982e38ac64dc30dd884bf9d083a34584ec84253505efe16ffeed07a74dd4",
    );
    if (reference) assert.deepEqual(report.metrics, reference.metrics);
    reference = report;
    assert.equal(report.resultStorage, "chunks-v1");
    assert.ok(report.pipeline.documents < report.pipeline.logicalRows / 50);
    measurements.push({
      run,
      milliseconds:
        Date.parse(measured.job.completedAt) -
        Date.parse(measured.job.createdAt),
      attempts: measured.job.attempts,
      ...report.pipeline,
      stages: measured.stages,
      percentages: measured.percentages,
    });
    pass(
      "same equity edge and robustness benchmark " + (iteration + 1),
      measurements.at(-1),
    );
  }
  const cancelId = (await api("run", body)).job;
  await page.goto(base + "/#history");
  await ready();
  await page.locator(`[data-cancel="${cancelId}"]`).waitFor({ timeout: 30000 });
  await page.locator(`[data-cancel="${cancelId}"]`).click();
  await page.waitForFunction(
    async (id) => {
      const response = await fetch("/api?op=jobs&id=" + encodeURIComponent(id));
      return (await response.json()).jobs[0]?.status === "cancelled";
    },
    cancelId,
    { timeout: 30000 },
  );
  const stopped = (await api("jobs", null, { id: cancelId })).jobs[0];
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.progress.percent < 100);
  await page.locator(`[data-retry="${cancelId}"]`).waitFor({ timeout: 30000 });
  const retry = accepted("retry");
  await page.locator(`[data-retry="${cancelId}"]`).click();
  const retryId = (await (await retry).json()).job;
  assert.notEqual(retryId, cancelId);
  await page
    .locator(
      `#jobsList progress[aria-label="Job ${retryId.slice(0, 8)} progress"]`,
    )
    .waitFor();
  await page.reload();
  await ready();
  await waitJob(retryId);
  await page.waitForFunction(
    (id) =>
      document.querySelector(
        `#jobsList progress[aria-label="Job ${id.slice(0, 8)} progress"]`,
      )?.value === 100,
    retryId,
    { timeout: 30000 },
  );
  assert.equal(new URL(page.url()).hash, "#history");
  pass(
    "cancel never reports 100%; retry completes; Runs view refreshes without navigation hijack",
    { cancelled: cancelId, retried: retryId },
  );
  credential = await api("tokens", {
    label: "progress acceptance",
    scope: "read",
  });
  client = new Client({ name: "progress-acceptance", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + credential.token } },
    }),
  );
  const result = await client.callTool({
    name: "job_status",
    arguments: { id },
  });
  assert.ok(!result.isError);
  const status = result.structuredContent || JSON.parse(result.content[0].text);
  assert.equal(status.jobs[0].progress.percent, 100);
  assert.equal(status.jobs[0].progress.stage, "Completed");
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  assert.deepEqual(errors, []);
  pass(
    "official MCP client receives same progress; no browser storage or page errors",
  );
  console.log("BENCHMARK", JSON.stringify({ baselineMs: 63117, measurements }));
} finally {
  await client?.close();
  if (credential?.id) await api("tokens", { revoke: credential.id });
  await context.close();
  await browser.close();
}
