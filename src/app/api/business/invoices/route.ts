import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { createInvoice } from "@/lib/server/businessStore";
import { requireName, requireManualLineItems, requireFiniteNumber, optionalString, optionalOperationId } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

/**
 * Manual invoice creation (the invoices page's "New invoice" form). `status`, `createdBy` and `actor` are never
 * read from the request — a manually-created invoice always starts "unpaid", created by and attributed to "user",
 * matching exactly what the form has always done; this just makes it impossible to forge those from the client.
 * `delivery: true` tags it as a delivery order (priced later).
 */
export async function POST(req: NextRequest) {
  try {
    await authenticate(req);
    const body = await req.json().catch(() => ({}));
    const customerId = typeof body.customerId === "string" && body.customerId ? body.customerId : undefined;
    const { stockWarnings, ...invoice } = await createInvoice({
      customerId,
      customerName: requireName(body.customerName, "Tên khách hàng"),
      items: requireManualLineItems(body.items),
      shipping: body.shipping === undefined ? 0 : requireFiniteNumber(body.shipping, "Phí giao hàng"),
      discount: body.discount === undefined ? 0 : requireFiniteNumber(body.discount, "Giảm giá"),
      notes: optionalString(body.notes, "Ghi chú"),
      status: "unpaid",
      // A delivery order may keep $0 prices until it is converted (manual prices may already be 0; this only tags it).
      ...(body.delivery === true ? { delivery: { status: "open" as const } } : {}),
      createdBy: "user",
      actor: "user",
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json({ invoice, ...(stockWarnings ? { stockWarnings } : {}) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
