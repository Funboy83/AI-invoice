import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { voidPurchase } from "@/lib/server/purchaseStore";
import { optionalOperationId } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

/** Cancels a purchase entered by mistake: its stock is taken back out and it no longer counts as owed. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const result = await voidPurchase(id, optionalOperationId(body.operationId));
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
