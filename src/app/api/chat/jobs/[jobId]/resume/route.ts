import { NextRequest, NextResponse, after } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { getJobForUser } from "@/lib/server/chatJobs";
import { driveJob } from "@/lib/server/agentRunner";
import { errorResponse, logged } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Re-drives an unfinished job. The app calls this when it opens, when the tab becomes visible again and while a job
 * is pending — so a job whose worker died is picked up without anyone repeating the request. A no-op for finished
 * jobs and for jobs a live worker is already running (the lease decides).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const invocationStart = Date.now(); // the platform's time limit counts from here
  try {
    const user = await authenticate(req);
    const { jobId } = await params;
    const job = await getJobForUser(user, jobId);
    if (job.status === "accepted" || job.status === "running") {
      after(logged(`resume ${jobId}`, () => driveJob(jobId, undefined, { invocationStart })));
    }
    return NextResponse.json({ jobId, status: job.status }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
