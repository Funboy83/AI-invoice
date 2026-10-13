import { NextRequest, NextResponse } from "next/server";
import { inAuthedStore } from "@/lib/server/storeAuth";
import { errorResponse } from "@/lib/server/http";
import { updateInvoiceWithLog } from "@/lib/server/businessStore";
import { requireEditLineItems, requireFiniteNumber, requireInvoiceStatus, requireReason, optionalString, optionalOperationId } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/**
 * Manual invoice edit (the invoice detail page's "Edit" form). `reason` is required and saved to the permanent
 * audit log, exactly as before — the server enforces this now (the client already did, but that check is not
 * trustworthy). `actor` is always "user", never read from the request.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await inAuthedStore(req, async () => {
      const { id } = await params;
      if (!id) throw new ValidationError("Thiếu id invoice.");
      const body = await req.json().catch(() => ({}));
      const { stockWarnings, ...invoice } = await updateInvoiceWithLog({
        invoiceId: id,
        items: body.items === undefined ? undefined : requireEditLineItems(body.items),
        shipping: body.shipping === undefined ? undefined : requireFiniteNumber(body.shipping, "Phí giao hàng"),
        discount: body.discount === undefined ? undefined : requireFiniteNumber(body.discount, "Giảm giá"),
        status: body.status === undefined ? undefined : requireInvoiceStatus(body.status),
        notes: optionalString(body.notes, "Ghi chú"),
        // "Chốt giá": the prices in this edit are final — the open delivery becomes a normal invoice (refused if it isn't one).
        ...(body.convertDelivery === true ? { convertDelivery: true } : {}),
        actor: "user",
        reason: requireReason(body.reason),
        operationId: optionalOperationId(body.operationId),
      });
      return NextResponse.json({ invoice, ...(stockWarnings ? { stockWarnings } : {}) });
    });
  } catch (err) {
    return errorResponse(err);
  }
}
