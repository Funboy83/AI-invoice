import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { conversationIdFor } from "@/lib/chat/types";

export const runtime = "nodejs";

/**
 * The single authorization check the app runs on load, and again on account switch: confirms the signed-in
 * account is a store member (authenticate() checks storeMembers/{uid} live — see src/lib/server/membership.ts)
 * and, since that grants both chat and business access, also returns which conversation is theirs. A 401/403
 * here is what src/lib/useAppAuth.tsx turns into the app-wide "denied" state that gates every business page and
 * the chat UI alike.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await authenticate(req);
    return NextResponse.json({ conversationId: conversationIdFor(user.storeId, user.uid), email: user.email });
  } catch (err) {
    return errorResponse(err);
  }
}
