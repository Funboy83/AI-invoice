import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { changePayment } from "@/lib/server/businessStore";
import { requirePositive, requireReason, optionalOperationId } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/** Edit (wrong amount) or cancel a payment. Reason required; every change is kept in the payment's history and the invoice log. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authenticate(req);
    const { id } = await params;
    if (!id) throw new ValidationError("Thiếu id thanh toán.");
    const body = await req.json().catch(() => ({}));
    const action = body.action === "edit" || body.action === "cancel" ? body.action : null;
    if (!action) throw new ValidationError("action must be edit or cancel.");
    const result = await changePayment({
      paymentId: id,
      action,
      amount: action === "edit" ? requirePositive(body.amount, "Số tiền") : undefined,
      reason: requireReason(body.reason),
      actor: "user",
      by: user.email,
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
