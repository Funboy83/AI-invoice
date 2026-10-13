import { NextRequest, NextResponse } from "next/server";
import { inAuthedStore } from "@/lib/server/storeAuth";
import { errorResponse } from "@/lib/server/http";
import { createProduct } from "@/lib/server/businessStore";
import { requireName, requireMoney, optionalMoney, optionalQuantity, optionalString, optionalStringArray, optionalOperationId } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

/** Manual product creation (the "Add product" form, and the invoice pages' inline "create product" quick-add). */
export async function POST(req: NextRequest) {
  try {
    return await inAuthedStore(req, async () => {
      const body = await req.json().catch(() => ({}));
      const product = await createProduct({
        name: requireName(body.name, "Tên sản phẩm"),
        aliases: optionalStringArray(body.aliases, "Aliases"),
        defaultUnit: optionalString(body.defaultUnit, "Đơn vị", 50),
        defaultPrice: requireMoney(body.defaultPrice, "Giá"),
        cost: optionalMoney(body.cost, "Giá vốn"),
        quantity: optionalQuantity(body.quantity, "Tồn kho"),
        category: optionalString(body.category, "Danh mục", 100),
        barcode: optionalString(body.barcode, "Barcode", 100),
        notes: optionalString(body.notes, "Ghi chú"),
        operationId: optionalOperationId(body.operationId),
      });
      return NextResponse.json({ product }, { status: 201 });
    });
  } catch (err) {
    return errorResponse(err);
  }
}
