import { NextRequest, NextResponse } from "next/server";
import { inAuthedStore } from "@/lib/server/storeAuth";
import { errorResponse } from "@/lib/server/http";
import { recordPayment } from "@/lib/server/businessStore";
import { requirePositive, optionalString, optionalOperationId } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/** Manual payment recording (the invoice detail page's "Record payment" dialog). Amount must be strictly positive. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await inAuthedStore(req, async () => {
      const { id } = await params;
      if (!id) throw new ValidationError("Thiếu id invoice.");
      const body = await req.json().catch(() => ({}));
      const { invoice, payment, stockWarnings } = await recordPayment({
        invoiceId: id,
        amount: requirePositive(body.amount, "Số tiền thanh toán"),
        method: optionalString(body.method, "Phương thức", 100),
        note: optionalString(body.note, "Ghi chú"),
        actor: "user",
        operationId: optionalOperationId(body.operationId),
      });
      return NextResponse.json({ invoice, payment, ...(stockWarnings ? { stockWarnings } : {}) }, { status: 201 });
    });
  } catch (err) {
    return errorResponse(err);
  }
}
