import { NextRequest, NextResponse } from "next/server";
import { inAuthedStore } from "@/lib/server/storeAuth";
import { errorResponse } from "@/lib/server/http";
import { getCustomInvoiceDefaults, getInvoicePrintInfo, saveInvoicePrintInfo } from "@/lib/server/businessStore";
import { requirePrintInfo } from "@/lib/server/businessValidation";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ invoiceId: string }> };

/** The saved Custom Invoice information for one invoice (or null), plus the remembered company block and terms. */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    return await inAuthedStore(req, async () => {
      const { invoiceId } = await params;
      const [info, defaults] = await Promise.all([getInvoicePrintInfo(invoiceId), getCustomInvoiceDefaults()]);
      return NextResponse.json({ info, defaults });
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Saves the printout's information and notes. Only those fields are read from the body: customer, items, prices
 * and totals are not accepted here at all — they always come from the invoice itself.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    return await inAuthedStore(req, async () => {
      const { invoiceId } = await params;
      const body = await req.json().catch(() => ({}));
      const info = await saveInvoicePrintInfo({ invoiceId, ...requirePrintInfo(body) });
      return NextResponse.json({ info });
    });
  } catch (err) {
    return errorResponse(err);
  }
}
