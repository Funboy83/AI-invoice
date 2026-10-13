import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { recordCustomerPayment } from "@/lib/server/businessStore";
import { requirePositive, optionalString, optionalOperationId } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/** Customer payment (the customer page's "Record payment"): split across their open invoices, oldest first. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    if (!id) throw new ValidationError("Thiếu id khách hàng.");
    const body = await req.json().catch(() => ({}));
    const result = await recordCustomerPayment({
      customerId: id,
      amount: requirePositive(body.amount, "Số tiền thanh toán"),
      method: optionalString(body.method, "Phương thức", 100),
      note: optionalString(body.note, "Ghi chú"),
      actor: "user",
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
