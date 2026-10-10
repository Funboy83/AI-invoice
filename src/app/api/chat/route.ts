import { NextRequest, NextResponse, after } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { acceptMessage } from "@/lib/server/chatJobs";
import { driveJob } from "@/lib/server/agentRunner";
import { errorResponse, logged } from "@/lib/server/http";

export const runtime = "nodejs";
// The background run happens inside `after()`, which lives for the route's max duration on Vercel.
// Keep equal to INVOCATION_LIMIT_MS in agentRunner.ts (a test enforces it).
export const maxDuration = 300;

/**
 * Accepts a chat message as a durable job and returns immediately with its id (HTTP 202).
 * Nothing is processed until the job (and the user's message) are safely stored in Firestore; the work itself then
 * runs after the response and can be resumed from its checkpoints by any later invocation if this one dies.
 * Sending the same `requestId` again returns the original job instead of creating a second one.
 */
export async function POST(req: NextRequest) {
  const invocationStart = Date.now(); // the platform's time limit counts from here
  try {
    const user = await authenticate(req);
    if (!process.env.ANTHROPIC_API_KEY) {
      const hint = process.env.VERCEL
        ? "Add it in your Vercel project's Settings → Environment Variables, then redeploy."
        : "Add it to .env.local and restart the dev server.";
      return NextResponse.json({ error: `ANTHROPIC_API_KEY is not configured on the server. ${hint}` }, { status: 503 });
    }
    const body = await req.json().catch(() => null);
    const accepted = await acceptMessage(user, { requestId: body?.requestId, content: body?.content });
    // Also on duplicates: if the first invocation died right after accepting, this re-drives it (claimJob no-ops otherwise).
    after(logged(`drive ${accepted.jobId}`, () => driveJob(accepted.jobId, undefined, { invocationStart })));
    return NextResponse.json(
      { jobId: accepted.jobId, status: accepted.status, duplicate: accepted.duplicate },
      { status: 202 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
