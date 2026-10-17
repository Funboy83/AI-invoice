import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { createVendor, getAllPurchases, getAllVendors } from "@/lib/server/purchaseStore";
import { optionalOperationId, optionalString, requireName } from "@/lib/server/businessValidation";
import { purchaseOwed } from "@/lib/types";

export const runtime = "nodejs";

/** Vendor list, with what is still owed to each vendor (sum of unpaid/partial purchases). */
export async function GET(req: NextRequest) {
  try {
    await authenticate(req);
    const [vendors, purchases] = await Promise.all([getAllVendors(), getAllPurchases()]);
    const owed: Record<string, number> = {};
    for (const p of purchases) owed[p.vendorId] = Math.round(((owed[p.vendorId] ?? 0) + purchaseOwed(p)) * 100) / 100;
    return NextResponse.json({ vendors, owed });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await authenticate(req);
    const body = await req.json().catch(() => ({}));
    const vendor = await createVendor({
      name: requireName(body.name, "Vendor name"),
      contactName: optionalString(body.contactName, "Contact name", 200),
      phone: optionalString(body.phone, "Phone", 50),
      email: optionalString(body.email, "Email", 200),
      address: optionalString(body.address, "Address"),
      notes: optionalString(body.notes, "Notes"),
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json({ vendor }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
