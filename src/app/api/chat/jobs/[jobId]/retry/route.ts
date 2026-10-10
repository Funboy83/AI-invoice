import { NextRequest, NextResponse, after } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { getJobForUser, retryJob } from "@/lib/server/chatJobs";
import { driveJob } from "@/lib/server/agentRunner";
import { errorResponse, logged } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/** "Thử lại" for a failed job: continues from its checkpoints, so finished steps and tool calls are not repeated. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const invocationStart = Date.now(); // the platform's time limit counts from here
  try {
    const user = await authenticate(req);
    const { jobId } = await params;
    await getJobForUser(user, jobId); // ownership check
    const { status } = await retryJob(user, jobId);
    if (status === "accepted") after(logged(`retry ${jobId}`, () => driveJob(jobId, undefined, { invocationStart })));
    return NextResponse.json({ jobId, status }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
