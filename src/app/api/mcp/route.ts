import { handleMcpGet, handleMcpPost } from "@/lib/server/mcp";

export const runtime = "nodejs";

/** MCP server for outside AI apps; the key comes in `Authorization: Bearer …` or `X-API-Key`. See src/lib/server/mcp.ts. */
export async function POST(req: Request) {
  return handleMcpPost(req);
}

export function GET() {
  return handleMcpGet();
}
