import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { recordVendorPayment } from "@/lib/server/purchaseStore";
import { optionalOperationId, optionalString, requirePositive } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

/** Records a payment to the vendor for this purchase (never more than what is still owed on it). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const purchase = await recordVendorPayment({
      purchaseId: id,
      amount: requirePositive(body.amount, "Amount"),
      method: optionalString(body.method, "Payment method", 100),
      note: optionalString(body.note, "Note"),
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json({ purchase }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
