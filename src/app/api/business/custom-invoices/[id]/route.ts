import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { getCustomInvoice, updateCustomInvoiceDate } from "@/lib/server/businessStore";
import { requireDateKey, optionalOperationId } from "@/lib/server/businessValidation";
import { NotFoundError } from "@/lib/domainErrors";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    const customInvoice = await getCustomInvoice(id);
    if (!customInvoice) throw new NotFoundError("Không tìm thấy Custom Invoice.");
    return NextResponse.json({ customInvoice });
  } catch (err) {
    return errorResponse(err);
  }
}

/** The date is the only field a Custom Invoice lets you change — anything else in the body is ignored. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authenticate(req);
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const customInvoice = await updateCustomInvoiceDate({
      id,
      date: requireDateKey(body.date, "Ngày"),
      actor: "user",
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json({ customInvoice });
  } catch (err) {
    return errorResponse(err);
  }
}
