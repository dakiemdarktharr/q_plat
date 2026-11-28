# Connect an AI to qtpatuti

Open [qtpatuti](https://q-plat.vercel.app/#connections), sign in to a named workspace, then create a token in **AI**. Guest users first save their workspace. Tokens are shown once, stored hashed in Atlas, expire after 30 days, and can be revoked immediately. The Read scope can inspect private research. Research can additionally validate/save edges and run/retry/cancel jobs. Neither scope can manage credentials, ingest data or administer Atlas.

## Remote MCP

Endpoint: `https://q-plat.vercel.app/mcp`

Use a client that supports Streamable HTTP with custom headers:

```json
{
  "mcpServers": {
    "qtpatuti": {
      "url": "https://q-plat.vercel.app/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Client configuration syntax varies. This server uses personal bearer tokens; it does **not** offer OAuth discovery or dynamic registration. A client requiring OAuth should use the stdio bridge instead. Protocol version: `2025-11-25`; stateless JSON responses, no SSE stream, GET returns 405. Send `Accept: application/json, text/event-stream` and `Content-Type: application/json`. Origin is checked when present. No session ID is required. Resources expose `qtpatuti://dsl`; `tools/list` describes the 15 operations.

## stdio bridge

Use Node 22+ and the checked-out public repository:

```json
{
  "mcpServers": {
    "qtpatuti": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/q_plat/scripts/mcp-bridge.mjs"],
      "env": { "QTPATUTI_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

Keep the token in the client's secret/environment settings, outside version control. The bridge reads newline-delimited JSON-RPC from stdin and forwards HTTPS requests; it writes no datasets, traces, payload logs or caches. Your AI client may retain conversations/tool output under its own policy. qtpatuti does not install an AI provider or enable paid services.

## API

[OpenAPI 3.1 schema](https://q-plat.vercel.app/openapi.json) describes `POST /api/v1/{tool}`. Every operation takes a JSON body; read tools use `{}` when no arguments are needed. Set the same bearer header. Responses are `no-store`. A research job returns HTTP 202 with a job ID; poll `job_status` until completion before reading `read_report`. Results appear in **Runs** on the website after Refresh; saved code appears under **Saved edges & version diff**.

`job_status({id})` returns `jobs[0].progress` with `percent`, `stage`, `elapsedSeconds` and, during persistence, `completed`/`total` chunk counts. Poll every 1–3 seconds. Percentages are weighted work stages, not predicted remaining time; 100 means the run is verified and committed. Cancelled/failed jobs stay below 100. An older job with no measurable checkpoint may return `percent: null`. The website uses the same contract and refreshes Runs automatically while jobs are active.

```javascript
const response = await fetch('https://q-plat.vercel.app/api/v1/catalog', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.QTPATUTI_TOKEN}` },
  body: '{}', cache: 'no-store'
});
const catalog = await response.json(); // keep in RAM
```

Suggested prompt: “Read the DSL guide and catalog. Validate a four-period momentum score on UCI. Run with 10 bps fees. Report IC, costs, sample size and limitations. Compare with mean reversion.” The API never sends live orders. All tools enforce workspace isolation and the existing cloud quotas; use at most two active jobs. Do not treat positive historical performance as guaranteed future returns.

Protocol reference: [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
