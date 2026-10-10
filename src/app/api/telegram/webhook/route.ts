import { NextRequest, NextResponse, after } from "next/server";
import { driveJob } from "@/lib/server/agentRunner";
import { logged } from "@/lib/server/http";
import { handleTelegramUpdate, secretMatches, telegramConfig, type TgUpdate } from "@/lib/server/telegram";

export const runtime = "nodejs";
// Same as /api/chat: the AI work runs inside `after()`. Keep equal to INVOCATION_LIMIT_MS in agentRunner.ts.
export const maxDuration = 300;

/**
 * Telegram webhook: Telegram POSTs every message sent to the bot here. Turned off (404) unless TELEGRAM_ENABLED=true
 * and the token + webhook secret are configured. Requests without the exact secret header are rejected, so only
 * Telegram (which was given the secret when the webhook was set) can reach the AI through this door.
 */
export async function POST(req: NextRequest) {
  const invocationStart = Date.now();
  const cfg = telegramConfig();
  if (!cfg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"), cfg.secret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update.update_id !== "number") return NextResponse.json({ ok: true });
  try {
    const jobId = await handleTelegramUpdate(cfg, update);
    if (jobId) after(logged(`drive ${jobId}`, () => driveJob(jobId, undefined, { invocationStart })));
  } catch (err) {
    // Answer 200 anyway: a non-200 makes Telegram resend the same update over and over. The message is simply
    // not processed; she can send it again.
    console.error("telegram webhook", err instanceof Error ? err.name : "error");
  }
  return NextResponse.json({ ok: true });
}
