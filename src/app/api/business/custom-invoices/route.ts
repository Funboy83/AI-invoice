import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";
import { createCustomInvoice, getAllCustomInvoices } from "@/lib/server/businessStore";
import { requireDateKey, requireString, optionalOperationId } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

/** Custom invoices are read through the server (not the browser SDK), so no Firestore rules change is needed. */
export async function GET(req: NextRequest) {
  try {
    await authenticate(req);
    return NextResponse.json({ customInvoices: await getAllCustomInvoices() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** New Custom Invoice from an existing invoice. Only the source and the date come from the request. */
export async function POST(req: NextRequest) {
  try {
    await authenticate(req);
    const body = await req.json().catch(() => ({}));
    const customInvoice = await createCustomInvoice({
      sourceInvoiceId: requireString(body.sourceInvoiceId, "Hóa đơn gốc", 200),
      date: requireDateKey(body.date, "Ngày"),
      actor: "user",
      operationId: optionalOperationId(body.operationId),
    });
    return NextResponse.json({ customInvoice }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
