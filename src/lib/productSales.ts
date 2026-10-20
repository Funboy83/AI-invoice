import { normalizeVN } from "./similarity";
import type { Invoice, InvoiceLineItem, InvoiceStatus } from "./types";

/** One invoice a product appears on (all its lines for that product added together). */
export interface ProductSaleRow {
  invoiceId: string;
  invoiceNumber: string;
  date: number;
  customerId?: string;
  customerName: string;
  status: InvoiceStatus;
  /** Present on delivery orders: "open" while prices are still to be set. */
  delivery?: "open" | "converted";
  quantity: number;
  /** The line unit; several different units on one invoice are joined ("thùng, lốc"). */
  unit: string;
  /** Price per unit when every line for this product on the invoice has the same price, else undefined. */
  price?: number;
  lineTotal: number;
}

export interface ProductSales {
  rows: ProductSaleRow[];
  /** Finished invoices only (draft and void are listed but not counted), like every other money total in the app. */
  totals: { invoiceCount: number; quantity: number; amount: number; mixedUnits: boolean };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Is this invoice line the product? By id; an old line saved without an id counts when its saved name is the same
 * name (ignoring accents and case), so invoices typed before products had ids still show up.
 */
function isLineFor(line: InvoiceLineItem, product: { id: string; name: string }): boolean {
  if (line.productId) return line.productId === product.id;
  return normalizeVN(line.productName) === normalizeVN(product.name);
}

/**
 * Every invoice a product was sold on, newest first — the product page's "Invoice sold" list and the MCP tool
 * getProductInvoices. Pure, so the browser (with invoices it already has) and the server give the same answer.
 */
export function productSales(invoices: Invoice[], product: { id: string; name: string; defaultUnit?: string }): ProductSales {
  const rows: ProductSaleRow[] = [];
  for (const inv of invoices) {
    const lines = inv.items.filter((l) => isLineFor(l, product));
    if (lines.length === 0) continue;
    const units = [...new Set(lines.map((l) => l.unit).filter(Boolean))];
    const prices = new Set(lines.map((l) => l.price));
    rows.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      date: inv.date,
      customerId: inv.customerId,
      customerName: inv.customerName,
      status: inv.paymentStatus,
      ...(inv.delivery ? { delivery: inv.delivery.status } : {}),
      quantity: r2(lines.reduce((s, l) => s + l.quantity, 0)),
      unit: units.join(", "),
      ...(prices.size === 1 ? { price: lines[0].price } : {}),
      lineTotal: r2(lines.reduce((s, l) => s + l.lineTotal, 0)),
    });
  }
  rows.sort((a, b) => b.date - a.date || b.invoiceNumber.localeCompare(a.invoiceNumber, undefined, { numeric: true }));

  const counted = rows.filter((r) => r.status !== "draft" && r.status !== "void");
  const countedUnits = new Set(counted.flatMap((r) => r.unit.split(", ")).filter(Boolean));
  return {
    rows,
    totals: {
      invoiceCount: counted.length,
      quantity: r2(counted.reduce((s, r) => s + r.quantity, 0)),
      amount: r2(counted.reduce((s, r) => s + r.lineTotal, 0)),
      mixedUnits: countedUnits.size > 1,
    },
  };
}
