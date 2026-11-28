// Direct Playwright harness: no traces, HAR, screenshots, snapshots or persisted browser profiles.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
const base = process.env.BASE_URL || "https://q-plat.vercel.app",
  checks = [],
  minSnapshots = 6;
const pass = (name, scalars = {}) => {
  checks.push({ name, ...scalars });
  console.log("PASS", name, JSON.stringify(scalars));
};
const waitBatch = async (id) => {
  let previous = 0,
    transientErrors = 0;
  for (let attempt = 0; attempt < 900; attempt++) {
    const result = await page.evaluate(async (jobId) => {
      const response = await fetch(
        "/api?op=jobs&id=" + encodeURIComponent(jobId),
        { cache: "no-store" },
      );
      return { status: response.status, body: await response.json() };
    }, id);
    if (
      !Array.isArray(result.body.jobs) &&
      [429, 500, 502, 503, 504].includes(result.status) &&
      ++transientErrors <= 10
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    assert.ok(Array.isArray(result.body.jobs), `Job poll failed: HTTP ${result.status} ${result.body.error || "unknown response"}`);
    transientErrors = 0;
    const job = result.body.jobs[0];
    assert.ok(job, "Batch job disappeared.");
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
  throw new Error("Six-dataset job timed out " + id);
};
const openBatchPanel = async (job, datasetVersion = null) => {
  const panel =
    job.summary.panels.find((item) => item.datasetVersion === datasetVersion) ||
    job.summary.panels[0];
  const button = page.locator(`[data-open-batch-run="${panel.runId}"]`);
  await button.waitFor({ state: "visible", timeout: 120000 });
  await button.click();
  await page.waitForFunction(
    (id) => document.querySelector("#runLabel").textContent.includes(id),
    panel.runId.slice(0, 8),
    { timeout: 60000 },
  );
  return panel.runId;
};
const waitSingle = async (id) => {
  let transientErrors = 0;
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await page.evaluate(async (jobId) => {
      const response = await fetch(
        "/api?op=jobs&id=" + encodeURIComponent(jobId),
        { cache: "no-store" },
      );
      return { status: response.status, body: await response.json() };
    }, id);
    if (
      !Array.isArray(result.body.jobs) &&
      [429, 500, 502, 503, 504].includes(result.status) &&
      ++transientErrors <= 10
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    assert.ok(Array.isArray(result.body.jobs), `Job poll failed: HTTP ${result.status} ${result.body.error || "unknown response"}`);
    transientErrors = 0;
    const job = result.body.jobs[0];
    assert.ok(job, "Research job disappeared.");
    assert.ok(!["failed", "cancelled"].includes(job.status), job.error);
    if (job.status === "completed") return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Research job timed out " + id);
};
const submitSingleAndOpen = async () => {
  const body = await page.evaluate(() => ({
    code: document.querySelector("#code").value,
    datasetVersion: document.querySelector("#dataset").value,
    config: Object.fromEntries(
      [
        "capital",
        "feeBps",
        "slippageBps",
        "topK",
        "rebalance",
        "maxWeight",
        "lot",
        "maxParticipation",
        "delay",
        "maxHolding",
        "entry",
        "exit",
        "horizon",
        "riskFree",
        "seed",
      ].map((key) => [key, Number(document.querySelector("#" + key).value)]),
    ),
    universe: document
      .querySelector("#universe")
      .value.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    robustness: document.querySelector("#robustness").checked,
  }));
  const accepted = await page.evaluate(async (requestBody) => {
    const response = await fetch("/api?op=run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    });
    return { status: response.status, body: await response.json() };
  }, body);
  assert.equal(accepted.status, 202, accepted.body.error);
  const id = accepted.body.job;
  await waitSingle(id);
  const report = await page.evaluate(async (runId) => {
    const response = await fetch(
      "/api?op=report&run=" + encodeURIComponent(runId),
      { cache: "no-store" },
    );
    return response.json();
  }, id);
  await page.locator('[data-view="history"]').click();
  await page.locator("#refreshHistory").click();
  const button = page.locator(`[data-open-run="${id}"]`);
  await button.waitFor({ state: "visible", timeout: 30000 });
  await button.click();
  await page.waitForFunction(
    (runId) => document.querySelector("#runLabel").textContent.includes(runId),
    id.slice(0, 8),
    { timeout: 60000 },
  );
  return report;
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: "block",
});
let page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const workspaceResponse = await context.request.post(
    base + "/api?op=workspace",
    {
      data: {
        name: "qa_" + Date.now(),
        password: randomBytes(24).toString("base64url"),
        create: true,
      },
    },
  );
  assert.equal(workspaceResponse.status(), 200);
  const health = await fetch(base + "/api?op=health").then((r) => r.json());
  assert.equal(health.database, "connected");
  const [html, download] = await Promise.all([
    fetch(base).then((r) => r.text()),
    fetch(base + "/download").then((r) => r.text()),
  ]);
  const digest = (s) => createHash("sha256").update(s).digest("hex");
  assert.equal(digest(html), digest(download));
  assert.equal(digest(html), digest(await readFile("index.html", "utf8")));
  pass("11 HTML production/download/source identical", {
    sha256: digest(html),
  });
  await page.goto(base);
  await page.waitForFunction(
    () => document.documentElement.dataset.ready === "true",
    {},
    { timeout: 60000 },
  );
  await page.waitForFunction(
    (n) => document.querySelector("#dataset").options.length >= n,
    minSnapshots,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#batchSelectors .batch-dataset").length === 6,
    {},
    { timeout: 60000 },
  );
  assert.ok(await page.locator("#run").isEnabled());
  const count = await page.locator("#dataset option").count();
  assert.ok(count >= minSnapshots);
  assert.match(await page.locator("#dbStatus").textContent(), /connected/);
  pass("01 catalog loaded from Atlas", { snapshots: count });
  const catalog = await (
    await context.request.get(base + "/api?op=catalog")
  ).json();
  const compatible = [
    ...new Map(
      catalog.versions
        .filter(
          (version) =>
            version.meta.fields.includes("high") &&
            version.meta.fields.includes("low"),
        )
        .map((version) => [version.dataset, version]),
    ).values(),
  ];
  assert.ok(
    compatible.length >= 6,
    "Need six OHLC datasets for the DSL fixture.",
  );
  const firstCompatible =
    compatible.find((version) => version.dataset === "uci") || compatible[0];
  await page.locator("#dataset").selectOption(firstCompatible._id);
  await page.waitForFunction(
    (id) =>
      document.querySelector('#batchSelectors [data-slot="0"]').value === id,
    firstCompatible._id,
  );
  const selectors = page.locator("#batchSelectors .batch-dataset");
  const compatibleIds = new Set(compatible.map((version) => version._id));
  for (let slot = 0; slot < 6; slot++) {
    const selected = await selectors.evaluateAll((elements) =>
      elements.map((element) => element.value),
    );
    if (compatibleIds.has(selected[slot])) continue;
    const used = new Set(selected);
    const replacement = compatible.find((version) => !used.has(version._id));
    assert.ok(replacement, "Need six distinct OHLC datasets to exercise selection.");
    await page
      .locator(`#batchSelectors [data-slot="${slot}"]`)
      .selectOption(replacement._id);
    await page.waitForFunction(
      ({ slot, id }) =>
        document.querySelector(`#batchSelectors [data-slot="${slot}"]`)
          .value === id,
      { slot, id: replacement._id },
    );
  }
  const selectedVersions = await selectors.evaluateAll((elements) =>
    elements.map((element) => element.value),
  );
  assert.equal(selectedVersions.length, 6);
  assert.equal(new Set(selectedVersions).size, 6);
  assert.ok(selectedVersions.includes(firstCompatible._id));
  const code =
    "move = returns(close, 3)\nrange = (high - low) / close\nscore = rank(move) - 0.37 * rank(range)";
  await page.locator("#edgeName").fill("QA custom range-adjusted momentum");
  await page.locator("#code").fill(code);
  await page.getByText("Hypothesis & research notes", { exact: true }).click();
  await page
    .locator("#hypothesis")
    .fill(
      "Three-week momentum adjusted by current range predicts next-week open returns.",
    );
  await page.locator("#validate").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#editorStatus").textContent.startsWith("Valid"),
    {},
    { timeout: 30000 },
  );
  await page.locator("#save").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#editorStatus").textContent.startsWith("Saved") &&
      document.querySelector("#savedEdge").value,
    {},
    { timeout: 30000 },
  );
  const edgeName = await page.locator("#savedEdge").inputValue();
  assert.ok(edgeName);
  pass("02 custom code validates and saves");
  await page.locator("#code").fill("score = next_weeks_open");
  await page.locator("#validate").click();
  await page.waitForFunction(
    () => document.querySelector("#notice").textContent.includes("Line 1"),
    {},
    { timeout: 30000 },
  );
  assert.match(await page.locator("#notice").innerText(), /forbidden/);
  await page.locator("#code").fill("score = lag(close, -1)");
  await page.locator("#validate").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#notice")
        .textContent.includes("Negative offsets"),
    {},
    { timeout: 30000 },
  );
  pass("04 future field and negative lag rejected through editor");
  await page.locator("#code").fill(code);
  await page.locator("#testSettings > summary").click();
  await page.locator("#robustness").uncheck();
  const batchAccepted = page.waitForResponse(
    (r) => r.url().includes("op=runBatch") && r.request().method() === "POST",
  );
  await page.locator("#run").click();
  const batchResponse = await batchAccepted,
    batchBody = await batchResponse.json();
  assert.equal(batchResponse.status(), 202, JSON.stringify(batchBody));
  const batchId = batchBody.job;
  assert.ok(batchId);
  await page.waitForFunction(
    () => document.querySelector("#jobStatus").textContent.includes("accepted"),
    {},
    { timeout: 30000 },
  );
  // Close immediately after the dispatcher accepts the job; same in-memory session on a fresh page.
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/#history");
  await page.waitForFunction(
    () =>
      document.querySelector("#workspaceButton").textContent.includes("qa_"),
    {},
    { timeout: 30000 },
  );
  const firstBatch = await waitBatch(batchId);
  await page.locator("#refreshHistory").click();
  await page.locator(`[data-watch-batch="${batchId}"]`).click();
  await page
    .locator("#batchBoard")
    .waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#batchGrid .batch-panel").length === 6 &&
      document.querySelectorAll(
        '#batchGrid .batch-panel[data-status="completed"]',
      ).length === 6 &&
      document.querySelectorAll("#batchGrid .batch-panel svg").length === 6,
    {},
    { timeout: 120000 },
  );
  const originalRun = await openBatchPanel(firstBatch);
  pass(
    "09 six dataset monitor survives tab close and renders six edge/data plots",
    {
      batch: batchId,
      runs: firstBatch.summary.panels.map((panel) => panel.runId),
    },
  );
  assert.match(await page.locator("#kpis").innerText(), /Mean rank IC/);
  await page.locator("#priceChart").click({ position: { x: 220, y: 80 } });
  await page.waitForFunction(
    () => document.querySelector("#crossTable tbody tr"),
    {},
    { timeout: 30000 },
  );
  const rankRows = await page.locator("#crossTable tbody tr").count();
  assert.equal(rankRows, 30);
  await page.locator("#tab-signal").click();
  await page.locator("#crossTable tbody tr").nth(1).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#detail")
        .textContent.includes("Intermediate variables"),
    {},
    { timeout: 30000 },
  );
  pass("03 linked price/cross-section/detail controls", { assets: rankRows });
  await page.locator("#priceChart").hover({ position: { x: 220, y: 80 } });
  assert.ok(await page.locator("#tooltip").isVisible());
  const beforeZoom = await page.locator("#from").inputValue();
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(
    (before) => document.querySelector("#from").value !== before,
    beforeZoom,
  );
  await page.locator("#resetZoom").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#seriesTable tbody tr").length === 25,
  );
  const rectangle = await page.locator("#priceChart").boundingBox();
  await page.mouse.move(rectangle.x + 100, rectangle.y + 80);
  await page.mouse.down();
  await page.mouse.move(rectangle.x + 300, rectangle.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelectorAll("#seriesTable tbody tr").length < 25,
  );
  await page.locator("#resetZoom").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#seriesTable tbody tr").length === 25,
  );
  const marker = await page.evaluate(async (run) => {
    const asset = document.querySelector("#asset").value,
      version = document.querySelector("#dataset").value;
    const [w, r] = await Promise.all([
      fetch("/api?op=window&version=" + version + "&asset=" + asset, {
        cache: "no-store",
      }).then((r) => r.json()),
      fetch("/api?op=runWindow&run=" + run + "&asset=" + asset, {
        cache: "no-store",
      }).then((r) => r.json()),
    ]);
    const f = r.fills.find((f) => f.type === "fill");
    if (!f) return null;
    const i = w.points.findIndex((p) => p.date === f.date),
      b = document.querySelector("#priceChart").getBoundingClientRect();
    let lo = Math.min(...w.points.map((p) => p.low)),
      hi = Math.max(...w.points.map((p) => p.high));
    const pad = (hi - lo) * 0.07;
    lo -= pad;
    hi += pad;
    return {
      x: 55 + (i / (w.points.length - 1)) * (b.width - 70),
      y: 12 + ((hi - f.referencePrice) / (hi - lo)) * (b.height - 38),
      date: f.date,
    };
  }, originalRun);
  assert.ok(marker);
  await page
    .locator("#priceChart")
    .click({ position: { x: marker.x, y: marker.y } });
  await page.waitForFunction(
    (date) =>
      document.querySelector("#detail").textContent.includes(date) &&
      document.querySelector("#selectedDate").textContent.includes(date),
    marker.date,
  );
  pass("03 hover, zoom, brush and exact fill-marker drill-down");
  await page.locator("#frame").selectOption("5");
  await page.waitForFunction(
    () => document.querySelectorAll("#seriesTable tbody tr").length === 5,
  );
  await page.locator("#frame").selectOption("1");
  await page.waitForFunction(
    () => document.querySelectorAll("#seriesTable tbody tr").length === 25,
  );
  await page.locator("#heatChart").click({ position: { x: 180, y: 70 } });
  await page.waitForFunction(() =>
    document.querySelector("#selectedDate").textContent.includes("h=4"),
  );
  const contextOption = await page
    .locator("#context option")
    .evaluateAll(
      (os) =>
        os.find((o) => o.value.startsWith("ecb-") && o.value.endsWith("|USD"))
          ?.value,
    );
  await page.locator("#tab-context").click();
  await page.locator("#context").selectOption(contextOption);
  await page.waitForFunction(() =>
    document.querySelector("#contextNote").textContent.includes("Coverage"),
  );
  pass("03 aggregation, horizon heatmap and availability-aware context");
  await page
    .locator("summary")
    .filter({ hasText: "Saved edges & version diff" })
    .click();
  await page.locator("#savedEdge").selectOption(edgeName);
  await page.locator("#savedVersion").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => Number(document.querySelector("#savedVersion").value) > 0,
  );
  await page.locator("#loadEdge").click();
  await page.waitForFunction(
    (expected) => document.querySelector("#code").value === expected,
    code,
  );
  pass("02 saved edge reload preserves exact code");
  await page.locator("#code").fill(code.replace("0.37", "0.52"));
  await page.locator("#fork").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#editorStatus").textContent.includes("version 1"),
    {},
    { timeout: 30000 },
  );
  await page.locator("#testSettings > summary").click();
  await page.locator("#feeBps").fill("20");
  const second = await submitSingleAndOpen();
  const secondRun = second._id;
  pass("06 changed edge/cost account run completed");
  await page.locator('[data-view="history"]').click();
  await page.locator("#refreshHistory").click();
  await page.waitForFunction(
    () => document.querySelector("#compareB").options.length >= 2,
    {},
    { timeout: 30000 },
  );
  await page.locator("#compareB").selectOption({ index: 1 });
  await page.locator("#compare").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#comparison")
        .textContent.includes("firstDifferentDate"),
    {},
    { timeout: 30000 },
  );
  pass("08 A/B report and configuration diff");
  const compare = await (
    await context.request.get(
      base + "/api?op=compare&a=" + originalRun + "&b=" + secondRun,
    )
  ).json();
  assert.ok(compare.firstDifferentDate);
  assert.ok(compare.codeDiff.length);
  assert.ok(compare.configDiff.some((x) => x.key === "feeBps"));
  const exactAccepted = page.waitForResponse(
    (r) => r.url().includes("op=run") && r.request().method() === "POST",
  );
  await page.locator('[data-rerun="' + originalRun + '"]').click();
  const rerunId = (await (await exactAccepted).json()).job;
  await page.waitForFunction(() =>
    document
      .querySelector("#notice")
      .textContent.includes("Exact rerun accepted"),
  );
  await page.waitForFunction(
    (id) =>
      document.querySelector("#runLabel").textContent.includes(id.slice(0, 8)),
    rerunId,
    { timeout: 120000 },
  );
  const original = await (
    await context.request.get(base + "/api?op=report&run=" + originalRun)
  ).json();
  const rerun = await (
    await context.request.get(base + "/api?op=report&run=" + rerunId)
  ).json();
  assert.equal(original.runHash, rerun.runHash);
  assert.deepEqual(original.metrics, rerun.metrics);
  pass("08 exact saved snapshot rerun", { runHash: original.runHash });
  await page
    .locator("summary")
    .filter({ hasText: "Execution, risk & universe" })
    .click();
  await page.locator("#universe").fill("AA,AXP,BA,BAC,CAT");
  const subset = await submitSingleAndOpen();
  assert.equal(subset.universe.length, 5);
  await page.waitForFunction(
    () => document.querySelectorAll("#crossTable tbody tr").length === 5,
  );
  pass("03 universe changes computed cross-section", { assets: 5 });
  const synth = await page
    .locator("#dataset option")
    .evaluateAll(
      (os) => os.find((o) => o.value.startsWith("synthetic-")).value,
    );
  await page.locator("#dataset").selectOption(synth);
  await page.waitForFunction(() =>
    document.querySelector("#modeNote").textContent.includes("Next-period"),
  );
  await page.locator("#universe").fill("");
  await page
    .locator("#code")
    .fill("mom = returns(close, 12)\nscore = rank(mom)");
  await page.locator("#robustness").check();
  const long = await submitSingleAndOpen();
  assert.equal(long.meta.reality, "Synthetic");
  assert.equal(long.counts.sessions, 1200);
  assert.equal(long.robustness.trials.length, 5);
  assert.equal(long.robustness.folds.length, 3);
  assert.equal(long.robustness.trials[1].config.feeBps, 2 * long.config.feeBps);
  assert.equal(long.robustness.trials[2].config.delay, long.config.delay + 1);
  assert.ok(
    long.robustness.trials[3].universe.length <
      long.robustness.trials[0].universe.length,
  );
  assert.ok(
    long.robustness.folds.every(
      (f) => f.trainEnd + f.purge < f.testStart && f.trials.length === 2,
    ),
  );
  await page.locator("#tab-robust").click();
  await page
    .locator("#robustReport summary")
    .filter({ hasText: "Fold 1" })
    .click();
  pass(
    "07 long-panel purged walk-forward, all stress trials and null control",
    { run: long._id, sessions: long.counts.sessions, folds: 3, trials: 5 },
  );
  const ecb = await page
    .locator("#dataset option")
    .evaluateAll((os) => os.find((o) => o.value.startsWith("ecb-")).value);
  await page.locator("#dataset").selectOption(ecb);
  await page.waitForFunction(() =>
    document.querySelector("#modeNote").textContent.includes("Research-only"),
  );
  await page
    .locator("#code")
    .fill("change = returns(close, 12)\nscore = -rank(change)");
  await page.locator("#robustness").uncheck();
  const fx = await submitSingleAndOpen();
  assert.equal(fx.metrics, null);
  assert.equal(fx.counts.ledger, 0);
  assert.ok(fx.diagnostic.sessions > 3000);
  pass("01 ECB reference research without fabricated execution", {
    run: fx._id,
    sessions: fx.counts.sessions,
  });
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  assert.deepEqual(storage, {
    local: 0,
    session: 0,
    indexedDB: 0,
    caches: 0,
    serviceWorkers: 0,
  });
  pass("10 browser storage remains empty", storage);
  const other = await browser.newContext({ serviceWorkers: "block" }),
    outsider = await other.request.get(base + "/api?op=runs");
  assert.equal(outsider.status(), 401);
  const otherWorkspace = await other.request.post(base + "/api?op=workspace", {
    data: {
      name: "qa_other_" + Date.now(),
      password: randomBytes(24).toString("base64url"),
      create: true,
    },
  });
  assert.equal(otherWorkspace.status(), 200);
  const otherPage = await other.newPage();
  await otherPage.goto(base);
  await otherPage.waitForFunction(
    () => document.documentElement.dataset.ready === "true",
  );
  assert.equal(
    (
      await other.request.get(base + "/api?op=report&run=" + originalRun)
    ).status(),
    404,
  );
  assert.equal(
    (
      await (
        await other.request.get(base + "/api?op=edges&id=" + edgeName)
      ).json()
    ).versions.length,
    0,
  );
  const own = await (await other.request.get(base + "/api?op=runs")).json();
  assert.equal(own.runs.length, 0);
  await otherPage.locator("#code").fill("score = rank(close)");
  await otherPage.locator("#save").click();
  await otherPage.waitForFunction(() =>
    document.querySelector("#editorStatus").textContent.startsWith("Saved"),
  );
  await other.close();
  pass("10 anonymous rejection and two-workspace isolation");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-view="research"]').click();
  assert.ok(await page.locator("#code").isVisible());
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 2,
  );
  assert.equal(overflow, false);
  pass("11 small viewport controls and no horizontal overflow");
  const local = await context.newPage();
  await local.goto(pathToFileURL(process.cwd() + "/index.html").href);
  await local.waitForFunction(
    (n) => document.querySelector("#dataset").options.length >= n,
    minSnapshots,
    { timeout: 30000 },
  );
  assert.ok(await local.locator("#code").isVisible());
  assert.ok(await local.locator("#localBanner").isVisible());
  await local.waitForFunction(
    () =>
      document.documentElement.dataset.ready === "true" &&
      document.querySelectorAll("#dataTable tbody tr").length > 0,
    {},
    { timeout: 60000 },
  );
  pass("11 file protocol public-data preview");
  await local.close();
  assert.equal(errors.length, 0, "Browser JavaScript errors");
  pass("12 production runtime and browser clean", {
    commit: health.commit,
    deployment: health.deployment,
  });
} catch (error) {
  console.log(
    "UI_STATUS",
    JSON.stringify({
      notice: await page
        .locator("#notice")
        .textContent()
        .catch(() => null),
      editor: await page
        .locator("#editorStatus")
        .textContent()
        .catch(() => null),
      job: await page
        .locator("#jobStatus")
        .textContent()
        .catch(() => null),
      errors,
    }),
  );
  throw error;
} finally {
  await browser.close();
}
console.log("E2E_CHECKS", checks.length);
