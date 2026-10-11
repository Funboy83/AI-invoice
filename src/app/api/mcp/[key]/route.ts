import { handleMcpGet, handleMcpPost } from "@/lib/server/mcp";

export const runtime = "nodejs";

/**
 * The same MCP server, with the key in the link itself (/api/mcp/<key>) for AI apps whose "add a connector" screen
 * only takes a URL (claude.ai and ChatGPT custom connectors). Treat this link like a password.
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return handleMcpPost(req, key);
}

export function GET() {
  return handleMcpGet();
}
