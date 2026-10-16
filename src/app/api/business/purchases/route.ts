import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { createPurchase, getAllPurchases } from "@/lib/server/purchaseStore";
import { optionalMoney, optionalOperationId, optionalString, requireDateKey, requireMoney, requirePositive, requireString } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/** Every purchase, newest first. The history page filters and searches them in the browser. */
export async function GET(req: NextRequest) {
  try {
    await authenticate(req);
    const purchases = await getAllPurchases();
    return NextResponse.json({ purchases });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Saves a new purchase: adds the stock, optionally updates costs, and records a payment made right away. */
export async function POST(req: NextRequest) {
  try {
    await authenticate(req);
    const body = await req.json().catch(() => ({}));
    if (!Array.isArray(body.items) || body.items.length === 0) throw new ValidationError("Add at least one product.");
    const items = (body.items as unknown[]).map((raw, i) => {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      return {
        productId: requireString(r.productId, `Product (line ${i + 1})`, 200),
        quantity: requirePositive(r.quantity, `Quantity (line ${i + 1})`),
        cost: requireMoney(r.cost, `Cost (line ${i + 1})`),
        unit: optionalString(r.unit, `Unit (line ${i + 1})`, 50),
      };
    });
    const { purchase, stockNotes } = await createPurchase({
      vendorId: requireString(body.vendorId, "Vendor", 200),
      vendorInvoiceNumber: optionalString(body.vendorInvoiceNumber, "Vendor invoice #", 100),
      dateKey: requireDateKey(body.dateKey, "Date"),
      items,
      shipping: optionalMoney(body.shipping, "Shipping / fees"),
      discount: optionalMoney(body.discount, "Discount"),
      notes: optionalString(body.notes, "Notes"),
      updateCost: body.updateCost === true,
      paidNow: optionalMoney(body.paidNow, "Amount paid"),
      payMethod: optionalString(body.payMethod, "Payment method", 100),
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json({ purchase, stockNotes }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
