// Production/Atlas acceptance. Only scalar evidence is printed; payloads stay in RAM.
import { chromium } from "@playwright/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { EQUITY_CATALOG } from "../lib/equity-catalog.mjs";
import { EQUITY_AUDIT_VERSION } from "../lib/equity-calendar.mjs";

const base = process.env.BASE_URL || "https://q-plat.vercel.app";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: "block",
});
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let client, credential;
const pass = (name, values = {}) =>
  console.log("PASS", name, JSON.stringify(values));
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
  assert.match(response.headers()["cache-control"], /no-store/);
  return value;
};
const poll = async (id) => {
  for (let n = 0; n < 120; n++) {
    const job = (await api("jobs", null, { id })).jobs[0];
    assert.ok(!["failed", "cancelled"].includes(job.status), job.error);
    if (job.status === "completed") return api("report", null, { run: id });
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Research timeout: " + id);
};
const code =
  "move = returns(close, 20)\nrisk = ts_std(returns(close, 1), 20)\nscore = rank(move) - 0.25 * rank(risk)";
try {
  const catalog = await api("catalog");
  const versions = Object.keys(EQUITY_CATALOG).map((id) => {
    const v = catalog.versions.find((v) => v.dataset === id);
    assert.ok(v, "Missing ready dataset " + id);
    assert.equal(v.assets.length, 6);
    assert.ok(v.count >= 8400 && v.sessions >= 1400);
    assert.equal(v.quantAudit.largeMoves, 0);
    assert.equal(v.quantAudit.version, EQUITY_AUDIT_VERSION);
    assert.equal(v.quantAudit.expectedSessions, 1509);
    assert.match(v.sourceArtifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(v.meta.reality, "Real");
    return v;
  });
  assert.equal(new Set(versions.flatMap((v) => v.assets)).size, 60);
  assert.equal(new Set(versions.map((v) => v.sourceArtifact.sha256)).size, 1);
  for (const v of versions) {
    const w = await api("window", null, { version: v._id, asset: v.assets[0] });
    assert.ok(
      w.points.length <= 350 && w.table.length <= 50 && w.total >= 1400,
    );
    for (const row of w.table) {
      assert.ok(row.close > 0 && row.rawClose > 0 && row.volume >= 0);
      assert.ok(
        Math.abs(row.close / row.rawClose - row.adjustmentFactor) < 1e-10,
      );
      assert.ok(Date.parse(row.availableAt) > Date.parse(row.openAt));
    }
  }
  const technology = versions.find((v) => v.dataset === "wiki_technology");
  const action = await api("window", null, {
    version: technology._id,
    asset: "AAPL",
    from: "2014-06-06",
    to: "2014-06-10",
  });
  const split = action.table.find((r) => r.date === "2014-06-09");
  assert.equal(split.splitRatio, 7);
  assert.ok(Math.abs(split.close / action.table[0].close - 1) < 0.1);
  assert.ok(split.rawClose / action.table[0].rawClose < 0.2);
  pass("10 real panels, bounded windows and preserved split audit", {
    datasets: versions.length,
    assets: 60,
    rows: versions.reduce((s, v) => s + v.count, 0),
    rejected: versions.reduce((s, v) => s + v.quantAudit.rejectedCount, 0),
  });
  await api("workspace", {
    name: "equity_qa_" + Date.now(),
    password: randomBytes(24).toString("base64url"),
    create: true,
  });
  const runs = [];
  for (let start = 0; start < versions.length; start += 2) {
    const batch = versions.slice(start, start + 2);
    const accepted = [];
    for (const v of batch) {
      const validated = await api("validate", { code, datasetVersion: v._id });
      assert.ok(validated.ok && Number.isFinite(validated.variables.score));
      const body = {
        code,
        datasetVersion: v._id,
        config: { feeBps: 10, slippageBps: 5, rebalance: 5 },
        robustness: v === technology,
      };
      accepted.push({ v, body, id: (await api("run", body)).job });
    }
    const reports = await Promise.all(
      accepted.map(async (item) => ({ ...item, report: await poll(item.id) })),
    );
    for (const item of reports) {
      const { report: r, v } = item;
      assert.equal(r.counts.sessions, v.sessions);
      assert.equal(r.counts.points, v.sessions * 6);
      assert.ok(
        r.metrics.fills > 0 && Number.isFinite(r.metrics.cumulativeReturn),
      );
      assert.ok(
        Number.isFinite(r.diagnostic.meanIC) && r.diagnostic.sessions > 1300,
      );
      const w = await api("runWindow", null, {
        run: item.id,
        asset: v.assets[0],
      });
      assert.ok(w.timeline.at(-1).costTotal > 0);
      assert.ok(w.points.some((p) => Number.isFinite(p.score)));
      if (v === technology) {
        assert.equal(r.robustness.trials.length, 5);
        assert.equal(r.robustness.folds.length, 3);
        assert.ok(r.robustness.folds.every((f) => f.trials.length === 2));
      }
      pass("full-panel research " + v.dataset, {
        run: item.id,
        sessions: r.counts.sessions,
        points: r.counts.points,
        fills: r.metrics.fills,
        runHash: r.runHash,
      });
      runs.push(item);
    }
  }
  const original = runs.find((r) => r.v === technology);
  const repeat = await poll((await api("run", original.body)).job);
  assert.equal(repeat.runHash, original.report.runHash);
  assert.deepEqual(repeat.metrics, original.report.metrics);
  pass(
    "equity run reproduces exactly; all stress trials and purged folds retained",
  );
  credential = await api("tokens", {
    label: "equity acceptance",
    scope: "read",
  });
  client = new Client({ name: "equity-acceptance", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + credential.token } },
    }),
  );
  const mcp = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError);
    return result.structuredContent || JSON.parse(result.content[0].text);
  };
  const aiCatalog = await mcp("catalog");
  assert.ok(
    versions.every((v) => aiCatalog.versions.some((a) => a._id === v._id)),
  );
  const aiWindow = await mcp("data_window", {
    version: technology._id,
    asset: "AAPL",
    from: "2014-06-06",
    to: "2014-06-10",
  });
  assert.equal(
    aiWindow.table.find((r) => r.date === "2014-06-09").splitRatio,
    7,
  );
  pass(
    "official MCP client discovers new panels and reads audited corporate action",
  );
  await page.goto(base + "/#history");
  await page.waitForFunction(
    () => document.documentElement.dataset.ready === "true",
    null,
    { timeout: 60000 },
  );
  await page.locator(`[data-open-run="${original.id}"]`).click();
  await page.waitForFunction(
    (id) =>
      document.querySelector("#runLabel").textContent.includes(id.slice(0, 8)),
    original.id,
    { timeout: 60000 },
  );
  assert.equal(await page.locator("#dataset").inputValue(), technology._id);
  assert.ok(await page.locator("#priceChart").isVisible());
  assert.ok(await page.locator("#scoreChart").isVisible());
  await page.locator("#tab-signal").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#crossTable tbody tr").length === 6,
  );
  await page.locator("#crossTable tbody tr").first().click();
  await page.waitForFunction(() =>
    document
      .querySelector("#detail")
      .textContent.includes("Intermediate variables"),
  );
  await page.locator("#tab-robust").click();
  assert.ok(await page.locator("#result-robust").isVisible());
  await page.locator('[data-view="catalog"]').click();
  const source = page
    .locator("article")
    .filter({ hasText: "US equities / Technology" });
  await source.locator("summary").first().click();
  await source.locator("summary").filter({ hasText: technology._id }).click();
  assert.match(await source.innerText(), /rejectedCount/);
  assert.match(await source.innerText(), /INTC/);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of [
    "catalog",
    "research",
    "explorer",
    "history",
    "connections",
  ]) {
    const button = page.locator(`[data-view="${view}"]`);
    if (await button.count()) {
      await button.click();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "Overflow " + view,
      );
    }
  }
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    dbs: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  assert.deepEqual(storage, {
    local: 0,
    session: 0,
    dbs: 0,
    caches: 0,
    workers: 0,
  });
  assert.deepEqual(errors, []);
  pass(
    "web result, linked signal trace, provenance disclosure and mobile; no persistent browser data",
  );
  console.log(
    "EQUITY ACCEPTANCE COMPLETE",
    JSON.stringify({ at: new Date().toISOString(), datasets: 10, runs: 11 }),
  );
} finally {
  await client?.close().catch(() => {});
  if (credential)
    await api("tokens", { revoke: credential.id }).catch(() => {});
  await context.close();
  await browser.close();
}
