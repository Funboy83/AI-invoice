import { NextRequest, NextResponse } from "next/server";
import { inAuthedStore } from "@/lib/server/storeAuth";
import { errorResponse } from "@/lib/server/http";
import { createCustomer } from "@/lib/server/businessStore";
import { requireName, optionalMoney, optionalString, optionalStringArray, optionalOperationId } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

/** Manual customer creation (the "Add customer" form, and the invoices page's inline "create customer" quick-add). */
export async function POST(req: NextRequest) {
  try {
    return await inAuthedStore(req, async () => {
      const body = await req.json().catch(() => ({}));
      const customer = await createCustomer({
        name: requireName(body.name, "Tên khách hàng"),
        aliases: optionalStringArray(body.aliases, "Aliases"),
        contactName: optionalString(body.contactName, "Người liên hệ", 200),
        phone: optionalString(body.phone, "Điện thoại", 50),
        email: optionalString(body.email, "Email", 200),
        address: optionalString(body.address, "Địa chỉ"),
        shippingAddress: optionalString(body.shippingAddress, "Địa chỉ giao hàng"),
        notes: optionalString(body.notes, "Ghi chú"),
        defaultShipping: optionalMoney(body.defaultShipping, "Phí giao hàng mặc định"),
        operationId: optionalOperationId(body.operationId),
      });
      return NextResponse.json({ customer }, { status: 201 });
    });
  } catch (err) {
    return errorResponse(err);
  }
}
