// stdio adapter for MCP clients without custom HTTP Authorization headers.
// No files/cache/logged payloads; all responses pass through RAM.
import { createInterface } from "node:readline";
const endpoint = new URL(
  process.env.QTPATUTI_URL || "https://q-plat.vercel.app/mcp",
);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
  throw new Error(
    "QTPATUTI_URL must be an HTTPS MCP endpoint without credentials.",
  );
if (!process.env.QTPATUTI_TOKEN)
  throw new Error("Set QTPATUTI_TOKEN in your MCP client environment.");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    const res = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + process.env.QTPATUTI_TOKEN,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: line,
      signal: AbortSignal.timeout(300000),
      cache: "no-store",
    });
    if (request.id === undefined) continue;
    if (!res.ok) throw new Error("HTTP " + res.status);
    const result = await res.json();
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    if (request?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: e.message.startsWith("HTTP ")
              ? e.message
              : "MCP connection failed.",
          },
        }) + "\n",
      );
  }
}
