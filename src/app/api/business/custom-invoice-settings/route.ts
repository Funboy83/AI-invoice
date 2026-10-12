import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/server/auth";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";

const DEFAULT_HEADER = "NNE ENTERPRISE INC\n14902 MORAN ST, SUITE A\nWESTMINSTER CA 92683";

/**
 * Company header and "Terms & Conditions" text printed on Custom Invoices. They come from server env vars
 * (CUSTOM_INVOICE_HEADER, CUSTOM_INVOICE_TERMS) rather than the code, because this repo is public and the terms
 * carry bank details — those stay out of git and out of the public JS bundle, and only signed-in members get them.
 */
export async function GET(req: NextRequest) {
  try {
    await authenticate(req);
    const unescape = (v: string | undefined) => v?.replace(/\\n/g, "\n").trim();
    return NextResponse.json({
      header: unescape(process.env.CUSTOM_INVOICE_HEADER) || DEFAULT_HEADER,
      terms: unescape(process.env.CUSTOM_INVOICE_TERMS) || "",
    });
  } catch (err) {
    return errorResponse(err);
  }
}
