import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { getPaymentsForPurchase, getPurchase, updatePurchaseInfo } from "@/lib/server/purchaseStore";
import { optionalOperationId, optionalString, requireDateKey } from "@/lib/server/businessValidation";
import { NotFoundError } from "@/lib/domainErrors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    await authenticate(req);
    const { id } = await params;
    const [purchase, payments] = await Promise.all([getPurchase(id), getPaymentsForPurchase(id)]);
    if (!purchase) throw new NotFoundError("Purchase not found.");
    return NextResponse.json({ purchase, payments });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Edits only the look-up details: vendor invoice #, date and notes. Items, money and stock can't change here. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    await authenticate(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const purchase = await updatePurchaseInfo(
      id,
      {
        vendorInvoiceNumber: optionalString(body.vendorInvoiceNumber, "Vendor invoice #", 100),
        dateKey: body.dateKey === undefined ? undefined : requireDateKey(body.dateKey, "Date"),
        notes: optionalString(body.notes, "Notes"),
      },
      optionalOperationId(body.operationId)
    );
    return NextResponse.json({ purchase });
  } catch (err) {
    return errorResponse(err);
  }
}
