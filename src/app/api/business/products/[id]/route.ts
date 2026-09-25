import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { updateProduct } from "@/lib/server/businessStore";
import { optionalMoney, optionalQuantity, optionalString, requireName } from "@/lib/server/businessValidation";
import { ValidationError } from "@/lib/domainErrors";

export const runtime = "nodejs";

/** Manual product edit (the products page's "Edit product" form). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    if (!id) throw new ValidationError("Thiếu id sản phẩm.");
    const body = await req.json().catch(() => ({}));
    const changes: Parameters<typeof updateProduct>[1] = {};
    if (body.name !== undefined) changes.name = requireName(body.name, "Tên sản phẩm");
    if (body.defaultUnit !== undefined) changes.defaultUnit = optionalString(body.defaultUnit, "Đơn vị", 50);
    if (body.defaultPrice !== undefined) changes.defaultPrice = optionalMoney(body.defaultPrice, "Giá");
    if (body.cost !== undefined) changes.cost = optionalMoney(body.cost, "Giá vốn");
    if (body.quantity !== undefined) changes.quantity = optionalQuantity(body.quantity, "Tồn kho");
    if (body.category !== undefined) changes.category = optionalString(body.category, "Danh mục", 100);
    if (body.notes !== undefined) changes.notes = optionalString(body.notes, "Ghi chú");
    if (body.active !== undefined) changes.active = Boolean(body.active);
    await updateProduct(id, changes);
    return NextResponse.json({ status: "updated" });
  } catch (err) {
    return errorResponse(err);
  }
}
