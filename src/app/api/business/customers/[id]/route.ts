import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { updateCustomer } from "@/lib/server/businessStore";
import { optionalMoney, optionalString, requireName } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/** Manual customer edit (the customers page's "Edit customer" form). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    if (!id) throw new ValidationError("Thiếu id khách hàng.");
    const body = await req.json().catch(() => ({}));
    const changes: Parameters<typeof updateCustomer>[1] = {};
    if (body.name !== undefined) changes.name = requireName(body.name, "Tên khách hàng");
    if (body.contactName !== undefined) changes.contactName = optionalString(body.contactName, "Người liên hệ", 200);
    if (body.phone !== undefined) changes.phone = optionalString(body.phone, "Điện thoại", 50);
    if (body.email !== undefined) changes.email = optionalString(body.email, "Email", 200);
    if (body.address !== undefined) changes.address = optionalString(body.address, "Địa chỉ");
    if (body.shippingAddress !== undefined) changes.shippingAddress = optionalString(body.shippingAddress, "Địa chỉ giao hàng");
    if (body.notes !== undefined) changes.notes = optionalString(body.notes, "Ghi chú");
    if (body.defaultShipping !== undefined) changes.defaultShipping = optionalMoney(body.defaultShipping, "Phí giao hàng mặc định");
    if (body.active !== undefined) changes.active = Boolean(body.active);
    await updateCustomer(id, changes);
    return NextResponse.json({ status: "updated" });
  } catch (err) {
    return errorResponse(err);
  }
}
