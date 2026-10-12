import { NextResponse } from "next/server";
import { HttpError } from "./auth";
import { ConfigError } from "./firebaseAdmin";
import { EXTERNAL_INSTRUCTIONS, apiConfig, apiConfigProblem, authenticateApiKey, externalTools, keyFromRequest, runExternalTool } from "./externalApi";

/**
 * A small MCP server (Model Context Protocol, "Streamable HTTP" transport, stateless JSON responses) so Claude,
 * ChatGPT and other AI apps can use the store's tools directly. It only translates MCP's JSON-RPC messages into
 * calls to externalApi.ts — the access rules, the tool list and the confirm step all live there.
 *
 * Hand-written on purpose (about 100 lines) instead of pulling in the MCP SDK: no new dependency to break the
 * Vercel build, and this app only needs initialize, tools/list and tools/call.
 */

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "ai-invoice", title: "Invoice AI (store)", version: "1.0.0" };

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcpPost(req: Request, pathKey?: string): Promise<Response> {
  const cfg = apiConfig();
  if (!cfg) {
    const problem = apiConfigProblem();
    return problem ? NextResponse.json(rpcError(null, -32603, problem), { status: 503 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let user;
  try {
    user = await authenticateApiKey(cfg, keyFromRequest(req, pathKey));
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json(rpcError(null, -32001, err.message), { status: err.status });
    if (err instanceof ConfigError) return NextResponse.json(rpcError(null, -32603, err.message), { status: 503 });
    throw err;
  }

  const body = (await req.json().catch(() => undefined)) as JsonRpcRequest | JsonRpcRequest[] | undefined;
  if (body === undefined) return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });

  const messages = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const msg of messages) {
    const out = await handleMessage(msg, user);
    if (out) responses.push(out);
  }
  // Only notifications (no id) → nothing to answer.
  if (responses.length === 0) return new Response(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? responses : responses[0]);
}

async function handleMessage(msg: JsonRpcRequest, user: Awaited<ReturnType<typeof authenticateApiKey>>): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid request");
  }
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: EXTERNAL_INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: externalTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!externalTools.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = (await runExternalTool(name, args, user)) as Record<string, unknown> | null;
        const isError = result?.status === "error";
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], isError });
      } catch (err) {
        // Database or network trouble: tell the AI to retry, without leaking internals.
        console.error("[mcp] tool failed", name, err instanceof Error ? err.name : "error");
        return rpcResult(id, { content: [{ type: "text", text: "The store's server had a problem. Try again in a moment." }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled …
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

/** This server doesn't push messages to the client, so the optional GET stream isn't offered. */
export function handleMcpGet(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
