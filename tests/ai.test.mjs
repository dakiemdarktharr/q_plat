import test from "node:test";
import assert from "node:assert/strict";
import { authorizeOperation, session, issueToken } from "../lib/auth.mjs";
import { hash } from "../lib/db.mjs";
import { AI_TOOLS, invokeTool } from "../lib/ai-tools.mjs";
import { rpc, PROTOCOL } from "../lib/mcp.mjs";
test("AI token permissions deny management and writes outside research scope", () => {
  for (const scope of ["read", "research"]) {
    const s = { auth: "token", scope };
    for (const op of [
      "tokens",
      "workspace",
      "guest",
      "import",
      "verify",
      "logout",
      "probe",
    ])
      assert.throws(() => authorizeOperation(s, op, "POST"), { status: 403 });
    authorizeOperation(s, "runs", "GET");
    if (scope === "read")
      assert.throws(() => authorizeOperation(s, "run", "POST"), {
        status: 403,
      });
    else {
      authorizeOperation(s, "run", "POST");
      authorizeOperation(s, "runBatch", "POST");
    }
  }
});
test("API credentials are hash-only, scoped, expiring and revocable", async () => {
  let record;
  const database = {
    collection(name) {
      assert.equal(name, "api_tokens");
      return {
        countDocuments: async () => 0,
        insertOne: async (r) => {
          record = r;
        },
        findOne: async (q) =>
          record._id === q._id &&
          record.expiresAt > q.expiresAt.$gt &&
          record.revokedAt === null
            ? record
            : null,
      };
    },
  };
  const s = { workspace: "private-a", name: "desk" };
  const result = await issueToken(database, s, {
    scope: "research",
    label: "Agent",
  });
  assert.equal(record._id, hash(result.token));
  assert.ok(!JSON.stringify(record).includes(result.token));
  const request = new Request("https://example.com/api", {
    headers: { authorization: "Bearer " + result.token },
  });
  assert.equal((await session(request, database)).workspace, "private-a");
  record.revokedAt = new Date();
  await assert.rejects(session(request, database), { status: 401 });
  record.revokedAt = null;
  record.expiresAt = new Date(0);
  await assert.rejects(session(request, database), { status: 401 });
  await assert.rejects(
    issueToken(database, { ...s, auth: "token" }, { scope: "research" }),
    { status: 403 },
  );
});
test("MCP lifecycle, tools, resource, notifications and bounded argument validation", async () => {
  const req = new Request("https://example.com/mcp", {
    headers: { authorization: "Bearer test" },
  });
  const call = (method, params = {}) =>
    rpc({ jsonrpc: "2.0", id: 7, method, params }, req, async () => {
      throw new Error("Unexpected dispatch");
    });
  assert.equal((await call("initialize")).result.protocolVersion, PROTOCOL);
  const tools = (await call("tools/list")).result.tools;
  assert.equal(tools.length, 16);
  const batchTool = tools.find(
    (tool) => tool.name === "run_research_across_datasets",
  );
  assert.ok(batchTool);
  assert.equal(batchTool.inputSchema.properties.datasets.minItems, 6);
  assert.equal(batchTool.inputSchema.properties.datasets.uniqueItems, true);
  assert.ok(
    (
      await call("resources/read", { uri: "qtpatuti://dsl" })
    ).result.contents[0].text.includes("future labels"),
  );
  assert.equal(
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, req),
    null,
  );
  assert.equal((await call("unknown")).error.code, -32601);
  assert.equal(
    (await call("tools/call", { name: "shell" })).error.code,
    -32602,
  );
  assert.equal(
    (
      await call("tools/call", {
        name: "run_research",
        arguments: {
          code: "score = close",
          datasetVersion: "known",
          config: { command: "bad" },
        },
      })
    ).result.isError,
    true,
  );
  assert.equal((await rpc([], req)).error.code, -32600);
});
test("MCP dispatch shares API auth and rejects injected paths and query properties", async () => {
  const request = new Request("https://example.com/mcp", {
    headers: { authorization: "Bearer secret", cookie: "q_session=unrelated" },
  });
  await invokeTool(
    "run_research",
    { datasetVersion: "known", code: "score = rank(close)" },
    request,
    async (r) => {
      assert.equal(r.url, "https://example.com/api?op=run");
      assert.equal(r.method, "POST");
      assert.equal(r.headers.get("authorization"), "Bearer secret");
      assert.equal(r.headers.get("cookie"), null);
      assert.equal((await r.json()).code, "score = rank(close)");
      return Response.json({ job: "accepted" });
    },
  );
  const batchArgs = {
    code: "score = rank(close)",
    datasets: ["a", "b", "c", "d", "e", "f"],
  };
  await assert.rejects(
    invokeTool(
      "run_research_across_datasets",
      { ...batchArgs, datasets: ["a", "a", "b", "c", "d", "e"] },
      request,
      () => assert.fail("Invalid batch request reached the API."),
    ),
    { status: 400 },
  );
  await invokeTool(
    "run_research_across_datasets",
    batchArgs,
    request,
    async (r) => {
      assert.equal(r.url, "https://example.com/api?op=runBatch");
      assert.equal(r.method, "POST");
      assert.equal((await r.json()).datasets.length, 6);
      return Response.json({ job: "accepted" }, { status: 202 });
    },
  );
  for (const args of [
    { version: "x", op: "import" },
    { version: "x", frame: -1 },
    { version: "x", from: "not-a-date" },
  ])
    await assert.rejects(
      invokeTool("data_window", args, request, () => assert.fail()),
      { status: 400 },
    );
  assert.ok(
    AI_TOOLS.every(
      (t) => !["import", "verify", "probe", "tokens"].includes(t.op),
    ),
  );
});
