import type { Invoice, InvoicePrintInfo } from "@/lib/types";

export interface PrintProps {
  invoice: Invoice;
  info: Omit<InvoicePrintInfo, "updatedAt">;
}

export const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "2026-10-07" → "10/07/2026" (US order). `sep` lets a template use " / ". Empty in → empty out. */
export function formatDateKey(key: string, sep = "/"): string {
  if (!key) return "";
  const [y, m, d] = key.split("-");
  return [m, d, y].join(sep);
}

export const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

export const totalQuantity = (invoice: Invoice) => Math.round(invoice.items.reduce((s, li) => s + li.quantity, 0) * 1000) / 1000;
