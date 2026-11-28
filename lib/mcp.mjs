import { AI_TOOLS, DSL_GUIDE, invokeTool } from "./ai-tools.mjs";
export const PROTOCOL = "2025-11-25";
export async function rpc(message, request, handle) {
  const id = message?.id ?? null;
  const error = (code, text) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: text },
  });
  if (
    !message ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (message.id !== undefined &&
      typeof message.id !== "string" &&
      typeof message.id !== "number")
  )
    return error(-32600, "Invalid Request");
  if (message.id === undefined) return null; // Notifications never receive JSON-RPC replies.
  const p = message.params || {};
  let result;
  if (message.method === "initialize")
    result = {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "qtpatuti", version: "1.0.0" },
      instructions:
        "Private quant research, no live trading. Read qtpatuti://dsl first. Use catalog IDs. Use run_research_across_datasets to compare one edge across six distinct datasets; poll its durable job until all panels finish. Every run uses cloud quota. Report limits and all trials. Results also appear in the website Runs view.",
    };
  else if (message.method === "ping") result = {};
  else if (message.method === "tools/list")
    result = { tools: AI_TOOLS.map(({ op, method, ...t }) => t) };
  else if (message.method === "resources/list")
    result = {
      resources: [
        {
          uri: "qtpatuti://dsl",
          name: "DSL and research workflow",
          mimeType: "text/plain",
        },
      ],
    };
  else if (message.method === "resources/read") {
    if (p.uri !== "qtpatuti://dsl") return error(-32602, "Unknown resource");
    result = {
      contents: [{ uri: p.uri, mimeType: "text/plain", text: DSL_GUIDE }],
    };
  } else if (message.method === "tools/call") {
    if (!AI_TOOLS.some((t) => t.name === p.name))
      return error(-32602, "Unknown tool");
    try {
      const res = await invokeTool(p.name, p.arguments || {}, request, handle),
        data = await res.json();
      result = {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: !res.ok,
      };
    } catch (e) {
      result = {
        content: [
          { type: "text", text: e.status ? e.message : "Tool failed." },
        ],
        isError: true,
      };
    }
  } else return error(-32601, "Method not found");
  return { jsonrpc: "2.0", id, result };
}
