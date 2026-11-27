// Real production + Atlas + official MCP client. No files, payload logs, traces or screenshots.
import { chromium } from "playwright";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const base = process.env.BASE_URL || "https://q-plat.vercel.app";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: "block",
});
const page = await context.newPage(),
  errors = [],
  clients = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (name) => console.log("PASS", name);
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.ready === "true",
    null,
    { timeout: 60000 },
  );
const responseData = (result) => {
  assert.ok(!result.isError, "MCP tool failed");
  return result.structuredContent || JSON.parse(result.content[0].text);
};
try {
  await page.goto(base);
  await ready();
  assert.equal(await page.title(), "qtpatuti");
  assert.equal(await page.locator("#workspaceDialog").isVisible(), false);
  const accepted = page.waitForResponse(
    (r) => r.url().includes("op=run") && r.request().method() === "POST",
  );
  await page.locator("#quickRun").click();
  const first = await accepted;
  assert.equal(first.status(), 202);
  const guestJob = (await first.json()).job;
  await page.waitForFunction(() => document.querySelector("#run").disabled);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#runLabel").textContent.includes(id.slice(0, 8)),
    guestJob,
    { timeout: 180000 },
  );
  assert.equal(await page.locator("#startCard").isHidden(), true);
  assert.ok(await page.locator("#priceChart").isVisible());
  assert.ok(await page.locator("#scoreChart").isVisible());
  assert.ok(await page.locator("#result-overview").isVisible());
  const guest = await (
    await context.request.get(base + "/api?op=session")
  ).json();
  assert.ok(guest.guest);
  pass("21 guest one-click run reaches real result without registration");
  await page.locator("#workspaceButton").click();
  await page.locator("#workspaceName").fill("ai_qa_" + Date.now());
  await page
    .locator("#workspacePassword")
    .fill(randomBytes(24).toString("base64url"));
  await page.locator("#createWorkspace").click();
  await page.locator("#workspaceDialog").waitFor({ state: "hidden" });
  const claimed = await (
    await context.request.get(base + "/api?op=session")
  ).json();
  assert.equal(claimed.workspace, guest.workspace);
  assert.equal(claimed.guest, false);
  assert.equal(
    (
      await context.request.get(base + "/api?op=report&run=" + guestJob)
    ).status(),
    200,
  );
  pass("22 saving guest workspace preserves its completed research");
  const originalCode = await page.locator("#code").inputValue();
  await page.locator("#code").fill("score = next_weeks_open");
  await page.locator("#run").click();
  await page.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("forbidden"),
  );
  assert.ok(await page.locator("#run").isEnabled());
  assert.ok(await page.locator("#quickRun").isEnabled());
  await page.locator("#code").fill(originalCode);
  await page.keyboard.press("Control+k");
  await page.locator("#commandSearch").fill("AI");
  await page.locator("#commandSearch").press("Enter");
  assert.ok(await page.locator("#commandDialog").isHidden());
  assert.ok(await page.locator("#view-connections").isVisible());
  assert.ok(await page.locator(".filters").isHidden());
  await page.locator("#tokenLabel").fill("E2E read");
  await page.locator("#createToken").click();
  await page.locator("#newToken").waitFor({ state: "visible" });
  const readToken = await page.locator("#tokenValue").inputValue();
  assert.match(readToken, /^qtp_/);
  const apiCall = (tool, args, token = readToken) =>
    fetch(base + "/api/v1/" + tool, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    });
  const catResponse = await apiCall("catalog", {});
  assert.match(catResponse.headers.get("cache-control"), /no-store/);
  const cat = await catResponse.json(),
    snapshot = cat.versions.find((v) => v.dataset === "uci")._id;
  assert.equal(
    (
      await apiCall("save_edge", {
        name: "Denied",
        code: "score = rank(close)",
        datasetVersion: snapshot,
      })
    ).status,
    403,
  );
  const tokenManagement = await fetch(base + "/api?op=tokens", {
    headers: { authorization: "Bearer " + readToken },
  });
  assert.equal(tokenManagement.status, 403);
  pass("23 read token can inspect but cannot save, run or create credentials");
  await page.locator("#tokenScope").selectOption("research");
  await page.locator("#tokenLabel").fill("E2E research");
  await page.locator("#createToken").click();
  await page.waitForFunction(
    (previous) =>
      document.querySelector("#tokenValue").value &&
      document.querySelector("#tokenValue").value !== previous,
    readToken,
  );
  const token = await page.locator("#tokenValue").inputValue();
  const client = new Client({
    name: "qtpatuti-release-check",
    version: "1.0.0",
  });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 15);
  assert.ok(
    (
      await client.readResource({ uri: "qtpatuti://dsl" })
    ).contents[0].text.includes("score"),
  );
  const code = "move = returns(close, 3)\nscore = 1 - rank(move)";
  assert.ok(
    responseData(
      await client.callTool({
        name: "validate_edge",
        arguments: { code, datasetVersion: snapshot },
      }),
    ).ok,
  );
  const edge = responseData(
    await client.callTool({
      name: "save_edge",
      arguments: { code, datasetVersion: snapshot, name: "MCP saved reversal" },
    }),
  );
  assert.equal(edge.code, code);
  const acceptedAI = responseData(
    await client.callTool({
      name: "run_research",
      arguments: {
        code,
        datasetVersion: snapshot,
        edge: edge.edge,
        edgeVersion: edge.version,
        config: { feeBps: 10 },
        robustness: false,
      },
    }),
  );
  let job;
  for (let i = 0; i < 60; i++) {
    job = responseData(
      await client.callTool({
        name: "job_status",
        arguments: { id: acceptedAI.job },
      }),
    ).jobs[0];
    if (["completed", "failed", "cancelled"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  assert.equal(job.status, "completed");
  const report = responseData(
    await client.callTool({
      name: "read_report",
      arguments: { run: job.summary.run },
    }),
  );
  assert.equal(report.datasetVersion, snapshot);
  assert.ok(report.diagnostic.pairs > 0);
  assert.ok(report.metrics.fills > 0);
  const difference = responseData(
    await client.callTool({
      name: "compare_runs",
      arguments: { a: guestJob, b: report._id },
    }),
  );
  assert.ok(difference.codeDiff.length);
  pass(
    "24 official MCP HTTP client validates, saves, runs, polls, reads and compares on Atlas",
  );
  const stdio = new Client({ name: "qtpatuti-stdio-check", version: "1.0.0" });
  clients.push(stdio);
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [process.cwd() + "/scripts/mcp-bridge.mjs"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ),
        QTPATUTI_TOKEN: token,
        QTPATUTI_URL: base + "/mcp",
      },
      stderr: "pipe",
    }),
  );
  assert.equal((await stdio.listTools()).tools.length, 15);
  assert.ok(
    responseData(
      await stdio.callTool({ name: "list_runs", arguments: {} }),
    ).runs.some((r) => r._id === report._id),
  );
  await stdio.close();
  pass("25 official MCP stdio client connects through the zero-cache bridge");
  await page.locator("#aiRuns").click();
  await page.locator('[data-open-run="' + report._id + '"]').click();
  await page.waitForFunction(
    (id) =>
      document.querySelector("#runLabel").textContent.includes(id.slice(0, 8)),
    report._id,
  );
  await page.locator("#tab-signal").click();
  assert.ok(await page.locator("#result-signal").isVisible());
  await page.locator("#tab-signal").press("ArrowRight");
  assert.equal(
    await page.locator("#tab-trace").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#tab-trace").press("Home");
  assert.ok(await page.locator("#result-overview").isVisible());
  await page.locator("#chartLayers > summary").click();
  assert.ok(await page.locator("#featureChart").isVisible());
  await page.locator("#chartLayers > summary").click();
  assert.ok(await page.locator("#featureChart").isHidden());
  const originalAsset = await page.locator("#asset").inputValue();
  const otherAsset = await page
    .locator("#asset option")
    .evaluateAll(
      (options, original) => options.find((o) => o.value !== original).value,
      originalAsset,
    );
  // Delay genuine cloud responses in RAM; never replace their data with a mock.
  await page.route("**/api?op=runWindow**", async (route) => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get("asset") === otherAsset)
      await new Promise((r) => setTimeout(r, 700));
    await route.fulfill({ response });
  });
  await page.locator("#asset").selectOption(otherAsset);
  await page.waitForFunction(
    (asset) =>
      document
        .querySelector("#detail h3")
        ?.textContent.startsWith(asset + " ·"),
    otherAsset,
  );
  await page.locator("#asset").selectOption(originalAsset);
  await page.waitForFunction(
    (asset) =>
      document
        .querySelector("#detail h3")
        ?.textContent.startsWith(asset + " ·"),
    originalAsset,
  );
  await page.locator("#asset").selectOption(otherAsset);
  await page.locator("#asset").selectOption(originalAsset);
  await new Promise((r) => setTimeout(r, 1200));
  await page.waitForFunction(
    (asset) =>
      state.window.asset === asset &&
      state.runWindow.points.every((p) => p.asset === asset) &&
      document
        .querySelector("#detail h3")
        ?.textContent.startsWith(asset + " ·"),
    originalAsset,
  );
  await page.unroute("**/api?op=runWindow**");
  pass(
    "26 AI results appear on web; tabs, keyboard focus and chart layers work",
  );
  await page.locator('.nav [data-view="connections"]').click();
  assert.equal(await page.locator("#tokenValue").inputValue(), "");
  const tokenRows = await (
    await context.request.get(base + "/api?op=tokens")
  ).json();
  assert.ok(tokenRows.tokens.every((t) => !t.token && !t._id));
  const researchId = tokenRows.tokens.find(
    (t) => t.label === "E2E research",
  ).id;
  await page.locator('[data-revoke="' + researchId + '"]').click();
  await page.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("revoked"),
  );
  assert.equal((await apiCall("list_runs", {}, token)).status, 401);
  assert.equal(
    (
      await fetch(base + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + readToken,
          origin: "https://untrusted.example",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).status,
    403,
  );
  const second = await browser.newContext();
  await second.request.post(base + "/api?op=workspace", {
    data: {
      name: "ai_other_" + Date.now(),
      password: randomBytes(24).toString("base64url"),
      create: true,
    },
  });
  const otherToken = await (
    await second.request.post(base + "/api?op=tokens", {
      data: { label: "Isolation", scope: "read" },
    })
  ).json();
  assert.equal(
    (await apiCall("read_report", { run: report._id }, otherToken.token))
      .status,
    404,
  );
  await second.request.post(base + "/api?op=tokens", {
    data: { revoke: otherToken.id },
  });
  await second.close();
  const readId = tokenRows.tokens.find((t) => t.label === "E2E read").id;
  await context.request.post(base + "/api?op=tokens", {
    data: { revoke: readId },
  });
  pass(
    "27 revocation, Origin validation, token secrecy and workspace isolation enforced",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.nav [data-view="research"]').click();
  assert.equal(await page.locator("#from").isVisible(), false);
  await page.locator("#toggleFilters").click();
  assert.ok(await page.locator("#from").isVisible());
  await page.locator("#toggleFilters").click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 2,
    ),
    false,
  );
  const storage = await page.evaluate(async () => [
    localStorage.length,
    sessionStorage.length,
    (await indexedDB.databases()).length,
    (await caches.keys()).length,
  ]);
  assert.deepEqual(storage, [0, 0, 0, 0]);
  assert.deepEqual(errors, []);
  pass("28 mobile filters, no overflow, no stored data and no browser errors");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await browser.close();
}
