import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { getPurchasesForVendor, getVendor, updateVendor } from "@/lib/server/purchaseStore";
import { optionalOperationId, optionalString, requireName } from "@/lib/server/businessValidation";
import { NotFoundError } from "@/lib/domainErrors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** One vendor and all of their purchases (newest first). */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    await authenticate(req);
    const { id } = await params;
    const [vendor, purchases] = await Promise.all([getVendor(id), getPurchasesForVendor(id)]);
    if (!vendor) throw new NotFoundError("Vendor not found.");
    return NextResponse.json({ vendor, purchases });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    await authenticate(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const changes: Parameters<typeof updateVendor>[1] = {};
    if (body.name !== undefined) changes.name = requireName(body.name, "Vendor name");
    if (body.contactName !== undefined) changes.contactName = optionalString(body.contactName, "Contact name", 200);
    if (body.phone !== undefined) changes.phone = optionalString(body.phone, "Phone", 50);
    if (body.email !== undefined) changes.email = optionalString(body.email, "Email", 200);
    if (body.address !== undefined) changes.address = optionalString(body.address, "Address");
    if (body.notes !== undefined) changes.notes = optionalString(body.notes, "Notes");
    await updateVendor(id, changes, optionalOperationId(body.operationId));
    return NextResponse.json({ status: "updated" });
  } catch (err) {
    return errorResponse(err);
  }
}
