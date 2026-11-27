import { POST as handle } from "../../route.js";
import { invokeTool } from "../../../../lib/ai-tools.mjs";
import { db } from "../../../../lib/db.mjs";
import { session, sameOrigin, rateLimit } from "../../../../lib/auth.mjs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(request, { params }) {
  try {
    sameOrigin(request);
    if (!request.headers.has("authorization"))
      return Response.json(
        { error: "Bearer API token required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    const database = await db();
    const s = await session(request, database);
    await rateLimit(database, s.workspace + ":api-v1", 120);
    const text = await request.text();
    if (text.length > 20000)
      throw Object.assign(new Error("Request too large."), { status: 413 });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("Invalid JSON."), { status: 400 });
    }
    return await invokeTool((await params).tool, body, request, handle);
  } catch (e) {
    return Response.json(
      { error: e.status ? e.message : "Service unavailable." },
      { status: e.status || 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
