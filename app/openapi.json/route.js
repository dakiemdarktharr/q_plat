import { AI_TOOLS } from "../../lib/ai-tools.mjs";
export function GET() {
  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "qtpatuti Research API",
        version: "1.0.0",
        description:
          "Scoped bearer tokens created in AI connections. Read scope permits read tools; research scope adds validation, saving edges, run, retry and cancel. No paid AI provider, no live orders.",
      },
      servers: [{ url: process.env.APP_ORIGIN || "https://q-plat.vercel.app" }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      paths: Object.fromEntries(
        AI_TOOLS.map((t) => [
          "/api/v1/" + t.name,
          {
            post: {
              operationId: t.name,
              summary: t.description,
              requestBody: {
                required: true,
                content: { "application/json": { schema: t.inputSchema } },
              },
              responses: {
                200: { description: "Result" },
                201: { description: "Created edge" },
                202: { description: "Job accepted" },
                400: { description: "Invalid input" },
                401: { description: "Token invalid/expired/revoked" },
                403: { description: "Scope or workspace denied" },
                429: { description: "Quota exceeded" },
              },
            },
          },
        ]),
      ),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
