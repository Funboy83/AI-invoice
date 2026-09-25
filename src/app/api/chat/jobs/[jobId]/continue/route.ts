import { NextRequest, NextResponse, after } from "next/server";
import { peekJobStatus } from "@/lib/server/chatJobs";
import { driveJob } from "@/lib/server/agentRunner";
import { errorResponse, logged } from "@/lib/server/http";
import { bearerMatches } from "@/lib/server/secret";

export const runtime = "nodejs";
// Keep equal to INVOCATION_LIMIT_MS in agentRunner.ts (a test enforces it).
export const maxDuration = 300;

/**
 * Server-to-server hand-off: an invocation that ran out of time calls this so the job continues in a FRESH
 * invocation with a full time budget — with no browser open and no scheduler involved. Authenticated with
 * CRON_SECRET (not a user login). Safe to call repeatedly: claimJob lets only one worker run a job.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const invocationStart = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!bearerMatches(req, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { jobId } = await params;
    const status = await peekJobStatus(jobId);
    if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (status === "accepted" || status === "running") {
      after(logged(`continue ${jobId}`, () => driveJob(jobId, undefined, { invocationStart })));
    }
    return NextResponse.json({ jobId, status }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
