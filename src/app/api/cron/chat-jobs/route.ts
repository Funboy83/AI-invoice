import { NextRequest, NextResponse, after } from "next/server";
import { listUnfinishedJobIds } from "@/lib/server/chatJobs";
import { driveJob } from "@/lib/server/agentRunner";
import { errorResponse, logged } from "@/lib/server/http";
import { bearerMatches } from "@/lib/server/secret";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Recovery sweep: re-drives every accepted/running job. Jobs held by a live worker or queued behind another job are
 * skipped by claimJob; jobs whose worker died (expired lease) are taken over and continue from their checkpoints.
 * Call it every minute (Vercel Cron on a Pro plan, or any scheduler) with `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: NextRequest) {
  const invocationStart = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!bearerMatches(req, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const ids = await listUnfinishedJobIds(25);
    after(logged("sweep", async () => void (await Promise.allSettled(ids.map((id) => driveJob(id, undefined, { invocationStart }))))));
    return NextResponse.json({ found: ids.length });
  } catch (err) {
    return errorResponse(err);
  }
}
