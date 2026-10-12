import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { EXTERNAL_INSTRUCTIONS, apiConfig, apiConfigProblem, authenticateApiKey, externalTools, keyFromRequest } from "@/lib/server/externalApi";

export const runtime = "nodejs";

/** REST API: the list of tools an outside app may call, with their input schemas. See src/lib/server/externalApi.ts. */
export async function GET(req: Request) {
  const cfg = apiConfig();
  if (!cfg) {
    const problem = apiConfigProblem();
    return problem ? NextResponse.json({ error: problem }, { status: 503 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    await authenticateApiKey(cfg, keyFromRequest(req));
    return NextResponse.json({ instructions: EXTERNAL_INSTRUCTIONS, tools: externalTools });
  } catch (err) {
    return errorResponse(err);
  }
}
