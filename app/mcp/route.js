import { db, schema } from "../../lib/db.mjs";
import { session, sameOrigin, rateLimit } from "../../lib/auth.mjs";
import { rpc, PROTOCOL } from "../../lib/mcp.mjs";
import { POST as handle } from "../api/route.js";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request) {
  try {
    sameOrigin(request);
    if (!request.headers.get("authorization"))
      return Response.json(
        {
          error:
            "Bearer API token required. Create one in qtpatuti → AI connections.",
        },
        { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } },
      );
    if (
      !(request.headers.get("content-type") || "").includes("application/json")
    )
      return Response.json(
        { error: "Use application/json." },
        { status: 415, headers },
      );
    const accept = request.headers.get("accept") || "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    )
      return Response.json(
        {
          error: "Accept must include application/json and text/event-stream.",
        },
        { status: 406, headers },
      );
    const protocol = request.headers.get("mcp-protocol-version");
    if (protocol && ![PROTOCOL, "2025-06-18", "2025-03-26"].includes(protocol))
      return Response.json(
        { error: "Unsupported protocol version." },
        { status: 400, headers },
      );
    const database = await db();
    await schema(database);
    const s = await session(request, database);
    await rateLimit(database, s.workspace + ":mcp", 120);
    const text = await request.text();
    if (text.length > 20000)
      return Response.json(
        { error: "Request too large." },
        { status: 413, headers },
      );
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        { status: 400, headers },
      );
    }
    const result = await rpc(message, request, handle);
    return result
      ? Response.json(result, { headers })
      : new Response(null, { status: 202, headers });
  } catch (e) {
    return Response.json(
      { error: e.status ? e.message : "Service unavailable." },
      { status: e.status || 503, headers },
    );
  }
}
export async function GET(request) {
  try {
    sameOrigin(request);
  } catch {
    return new Response(null, { status: 403, headers });
  }
  return new Response(null, {
    status: 405,
    headers: { ...headers, Allow: "POST" },
  });
}
