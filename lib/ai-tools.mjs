// One contract drives MCP, the versioned API, and OpenAPI. No arbitrary DB/query tool.
const str = (description, maxLength = 100) => ({
  type: "string",
  description,
  maxLength,
});
const id = str("ID returned by qtpatuti; never invent an ID.");
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const code = str(
  "Expression DSL, one assignment per line; final variable score. No Python imports or future fields.",
  12000,
);
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const config = object(
  Object.fromEntries(
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
    ].map((k) => [k, { type: "number" }]),
  ),
);
const tool = (
  name,
  op,
  method,
  description,
  properties = {},
  required = [],
) => ({
  name,
  op,
  method,
  description,
  inputSchema: object(properties, required),
  annotations: {
    readOnlyHint: method === "GET" && op !== "report",
    destructiveHint: op === "cancel",
    idempotentHint: method === "GET" || op === "cancel",
    openWorldHint: false,
  },
});
export const AI_TOOLS = [
  tool(
    "catalog",
    "catalog",
    "GET",
    "List ready datasets, snapshot IDs, fields, units and limitations. Start here.",
  ),
  tool(
    "data_window",
    "window",
    "GET",
    "Read a bounded public price window (max 350 chart buckets, 50 table rows).",
    {
      version: id,
      asset: str("Asset symbol"),
      from: date,
      to: date,
      frame: { type: "integer", enum: [1, 5, 20] },
      offset: { type: "integer", minimum: 0, maximum: 5000 },
      field: str("Allowed field"),
    },
    ["version"],
  ),
  tool(
    "validate_edge",
    "validate",
    "POST",
    "Validate DSL and preview intermediate values at one asset/date. Research scope required.",
    { code, datasetVersion: id, asset: str("Asset symbol"), date },
    ["code", "datasetVersion"],
  ),
  tool(
    "list_edges",
    "edges",
    "GET",
    "List private edges, or immutable versions of an edge.",
    { id },
  ),
  tool(
    "save_edge",
    "edges",
    "POST",
    "Save a new immutable version; provide id to update, fork=true to branch. Research scope required.",
    {
      name: str("Edge name"),
      code,
      datasetVersion: id,
      hypothesis: str("Hypothesis", 3000),
      notes: str("Research notes", 3000),
      id,
      fork: { type: "boolean" },
      version: { type: "integer", minimum: 1 },
    },
    ["name", "code", "datasetVersion"],
  ),
  tool(
    "run_research",
    "run",
    "POST",
    "Start a durable cloud job. Returns job ID; poll job_status, then read_report. Costs cloud quota. Research scope required; max two active jobs. No live trading.",
    {
      code,
      datasetVersion: id,
      config,
      universe: { type: "array", maxItems: 64, items: str("Asset") },
      robustness: { type: "boolean" },
      edge: id,
      edgeVersion: { type: "integer", minimum: 1 },
      expectedEngine: str("Optional exact engine version for reproducibility"),
    },
    ["code", "datasetVersion"],
  ),
  tool(
    "job_status",
    "jobs",
    "GET",
    "Read job status, checkpoint and result ID.",
    { id },
  ),
  tool(
    "cancel_job",
    "cancel",
    "POST",
    "Cancel a private cloud job; partial results are not published.",
    { id },
    ["id"],
  ),
  tool(
    "retry_job",
    "retry",
    "POST",
    "Retry a failed private job, using its persisted inputs.",
    { id },
    ["id"],
  ),
  tool(
    "list_runs",
    "runs",
    "GET",
    "List completed research in the authenticated workspace.",
  ),
  tool(
    "read_report",
    "report",
    "GET",
    "Read metrics, assumptions, splits and all robustness trials. Opening a report records the first holdout access timestamp.",
    { run: id },
    ["run"],
  ),
  tool(
    "run_window",
    "runWindow",
    "GET",
    "Read bounded aligned score, NAV, target and fill series.",
    {
      run: id,
      asset: str("Asset"),
      from: date,
      to: date,
      frame: { type: "integer", enum: [1, 5, 20] },
    },
    ["run"],
  ),
  tool(
    "cross_section",
    "cross",
    "GET",
    "Compare all assets for one date with evaluation-only forward labels.",
    { run: id, date, horizon: { type: "integer", minimum: 1, maximum: 12 } },
    ["run", "date"],
  ),
  tool(
    "trace_decision",
    "detail",
    "GET",
    "Trace source fields → variables → score → target → orders → fills → costs → NAV.",
    { run: id, asset: str("Asset"), date },
    ["run", "asset", "date"],
  ),
  tool(
    "compare_runs",
    "compare",
    "GET",
    "Compare code, config, metrics and first different date between two private runs.",
    { a: id, b: id },
    ["a", "b"],
  ),
];
export const DSL_GUIDE = `qtpatuti expression DSL v1. One assignment per line; final variable must be score. Fields come from catalog, never future labels. Operators: + - * / comparisons and/or/not; lag, delta, returns, ts_mean, ts_std, ts_rank (integer window 1–252); rank, zscore, group_rank, group_demean; where, clip, abs. Rank is ascending 0–1 with average ties. Rolling requires complete calendar windows, std ddof=1. Missing data and division by zero produce null. Labels exist only in evaluator. OHLC labels: open(t+1+h)/open(t+1)-1. ECB: close(t+h)/close(t)-1, no executable account. UCI is 25 weekly sessions, not multi-year. Synthetic must be identified as synthetic. A positive backtest is not evidence of future profit. Workflow: catalog → validate_edge → save_edge → run_research → job_status → read_report → run_window / trace_decision → compare_runs. Report every trial, fees, sample size and uncertainty.\nExample:\nmom = returns(close, 4)\nrisk = ts_std(returns(close, 1), 4)\nscore = rank(mom) - 0.25 * rank(risk)`;
export function validateArgs(value, schema, path = "arguments") {
  const fail = () => {
    throw Object.assign(new Error(`Invalid ${path}.`), { status: 400 });
  };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    for (const k of schema.required || [])
      if (!(k in value))
        throw Object.assign(new Error(`Missing ${path}.${k}.`), {
          status: 400,
        });
    for (const [k, v] of Object.entries(value)) {
      if (!schema.properties[k]) fail();
      validateArgs(v, schema.properties[k], `${path}.${k}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) fail();
    value.forEach((v, i) => validateArgs(v, schema.items, `${path}[${i}]`));
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) fail();
  } else if (
    typeof value !== schema.type ||
    (schema.type === "number" && !Number.isFinite(value))
  )
    fail();
  if (schema.maxLength && value.length > schema.maxLength) fail();
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.minimum !== undefined && value < schema.minimum) fail();
  if (schema.maximum !== undefined && value > schema.maximum) fail();
}
export async function invokeTool(name, args, request, handle) {
  const t = AI_TOOLS.find((t) => t.name === name);
  if (!t) throw Object.assign(new Error("Unknown tool."), { status: 404 });
  validateArgs(args, t.inputSchema);
  const url = new URL("/api", request.url);
  url.searchParams.set("op", t.op);
  if (t.method === "GET")
    for (const [k, v] of Object.entries(args))
      url.searchParams.set(k, String(v));
  const headers = new Headers({
    authorization: request.headers.get("authorization") || "",
    "content-type": "application/json",
  });
  if (request.headers.has("origin"))
    headers.set("origin", request.headers.get("origin"));
  return handle(
    new Request(url, {
      method: t.method,
      headers,
      ...(t.method === "POST" ? { body: JSON.stringify(args) } : {}),
    }),
  );
}
