import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { apiConfig, apiConfigProblem, authenticateApiKey, externalTools, keyFromRequest, runExternalTool } from "@/lib/server/externalApi";

export const runtime = "nodejs";

/** REST API: call one tool. Body = the tool's arguments as JSON. Answer = the tool's result (same as over MCP). */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const cfg = apiConfig();
  if (!cfg) {
    const problem = apiConfigProblem();
    return problem ? NextResponse.json({ error: problem }, { status: 503 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const user = await authenticateApiKey(cfg, keyFromRequest(req));
    const { name } = await params;
    if (!externalTools.some((t) => t.name === name)) return NextResponse.json({ error: `Unknown tool "${name}".` }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const args = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return NextResponse.json({ result: await runExternalTool(name, args, user) });
  } catch (err) {
    return errorResponse(err);
  }
}
