import { describe, expect, it } from "vitest";
import { productSales } from "./productSales";
import type { Invoice, InvoiceLineItem, InvoiceStatus } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const line = (productId: string | undefined, productName: string, quantity: number, price: number, unit = "thùng"): InvoiceLineItem => ({
  productId,
  productName,
  quantity,
  unit,
  price,
  lineTotal: Math.round(quantity * price * 100) / 100,
});

function inv(id: string, status: InvoiceStatus, date: number, items: InvoiceLineItem[], customerName = "Chị Hoa"): Invoice {
  const total = items.reduce((s, l) => s + l.lineTotal, 0);
  return {
    id,
    invoiceNumber: id,
    date,
    customerId: "c1",
    customerName,
    items,
    shipping: 0,
    discount: 0,
    subtotal: total,
    total,
    amountPaid: 0,
    balance: total,
    paymentStatus: status,
    createdAt: date,
    updatedAt: date,
    createdBy: "user",
  };
}

const milo = { id: "p1", name: "Milô" };

describe("productSales", () => {
  it("lists every invoice with the product, newest first, adding up its lines on one invoice", () => {
    const { rows } = productSales(
      [
        inv("1001", "paid", 1 * DAY, [line("p1", "Milo", 2, 29), line("p2", "Coca", 1, 10)]),
        inv("1002", "unpaid", 3 * DAY, [line("p1", "Milo", 1, 29), line("p1", "Milo", 3, 29)], "Anh Tâm"),
        inv("1003", "partial", 2 * DAY, [line("p2", "Coca", 5, 10)]),
      ],
      milo
    );
    expect(rows.map((r) => r.invoiceNumber)).toEqual(["1002", "1001"]);
    expect(rows[0]).toMatchObject({ customerName: "Anh Tâm", quantity: 4, unit: "thùng", price: 29, lineTotal: 116, status: "unpaid" });
  });

  it("finds old lines saved without a product id by the same name, but never another product's line", () => {
    const { rows } = productSales(
      [inv("1", "paid", DAY, [line(undefined, "milo", 1, 29)]), inv("2", "paid", DAY, [line("p9", "Milô", 1, 29)])],
      milo
    );
    expect(rows.map((r) => r.invoiceId)).toEqual(["1"]);
  });

  it("lists drafts and voids but counts only finished invoices in the totals", () => {
    const { rows, totals } = productSales(
      [
        inv("1", "paid", DAY, [line("p1", "Milo", 2, 29)]),
        inv("2", "draft", DAY, [line("p1", "Milo", 5, 29)]),
        inv("3", "void", DAY, [line("p1", "Milo", 7, 29)]),
        inv("4", "unpaid", DAY, [line("p1", "Milo", 1, 28.5)]),
      ],
      milo
    );
    expect(rows).toHaveLength(4);
    expect(totals).toEqual({ invoiceCount: 2, quantity: 3, amount: 86.5, mixedUnits: false });
  });

  it("shows mixed units and prices on one invoice instead of hiding them", () => {
    const { rows, totals } = productSales([inv("1", "paid", DAY, [line("p1", "Milo", 1, 29), line("p1", "Milo", 6, 3, "lốc")])], milo);
    expect(rows[0]).toMatchObject({ quantity: 7, unit: "thùng, lốc", lineTotal: 47 });
    expect(rows[0].price).toBeUndefined();
    expect(totals.mixedUnits).toBe(true);
  });
});
